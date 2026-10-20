import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/server";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import type { Registry } from "../accounts/registry.js";
import { readPackageVersion } from "../version.js";
import { ACCOUNT_LIST_NAME, ACCOUNT_LIST_TOOL, accountListText } from "./account-tools.js";
import { withAccountParam } from "./catalog.js";
import { TOOL_TIMEOUT_MS } from "./children.js";
import type { ChildPool, OfficialTool } from "./children.js";
import { FANOUT_LIMIT, mapWithLimit } from "./fanout.js";
import { READONLY_QUERY_EXPOSED, READONLY_QUERY_TOOL, modeOf } from "./policy.js";
import type { Mode } from "./policy.js";
import { resolveTargets } from "./routing.js";

const SERVER_NAME = "multi-account-supabase-mcp";

// What the server needs from the rest of the program. catalog gives the official tools. createServer reads it once.
export type CallDeps = {
  registry: () => Promise<Registry>;
  pool: ChildPool;
  catalog: () => Promise<OfficialTool[]>;
};

// The read-only query tool. It is listed only when READONLY_QUERY_EXPOSED is true, which this plan does not set. Its
// official name is execute_sql, and its mode is locate.
const READONLY_QUERY_DEFINITION: OfficialTool = {
  name: READONLY_QUERY_TOOL,
  description: "Runs one read-only SQL query on one project.",
  inputSchema: {
    type: "object",
    properties: {
      project_id: { type: "string", description: "The id of the project." },
      query: { type: "string", description: "The SQL query. It must only read." },
    },
    required: ["project_id", "query"],
  },
  annotations: { readOnlyHint: true },
};

// A miss is a not-found answer from one account. The pattern is the T2 rule's text match. It is used only on an error
// result, so a successful result is never a miss.
const NOT_FOUND_PATTERN = /\b404\b|not found|does not exist|do not exist/i;

export function looksNotFound(text: string): boolean {
  return NOT_FOUND_PATTERN.test(text);
}

// The outcome of one account in a fan-out. A failure keeps its text, and a miss is an account without the id.
type Outcome = { kind: "ok"; result: CallToolResult } | { kind: "fail"; error: string } | { kind: "miss" };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const textResult = (text: string, isError: boolean): CallToolResult => ({
  content: [{ type: "text", text }],
  isError,
});

// The text blocks of a result, one per line. Other blocks have no text, so they add nothing.
const textOf = (result: CallToolResult): string =>
  result.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");

// The refusal for a change that does not name one account. The example names one account, when there is one.
const oneAccountRefusal = (tool: string, example: string | undefined): string => {
  const head = `"${tool}" runs on one account only, because it can change data or is not classified yet.`;
  return example === undefined
    ? `${head} No Supabase accounts are set up yet. Run: multi-account-supabase-mcp add <name>`
    : `${head} Name one account, for example account: "${example}".`;
};

// The SDK's Tool for an official tool. The input schema is passed on as it is.
function toTool(tool: OfficialTool): Tool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as Tool["inputSchema"],
    annotations: tool.annotations,
  };
}

// The tools of tools/list: the catalog with the account argument, the read-only query tool when it is exposed, and
// account_list.
export async function listTools(deps: CallDeps): Promise<Tool[]> {
  const accounts = (await deps.registry()).names();
  const catalog = await deps.catalog();
  const tools: OfficialTool[] = catalog.map((tool) => withAccountParam(tool, modeOf(tool.name), accounts));
  if (READONLY_QUERY_EXPOSED) {
    tools.push(withAccountParam(READONLY_QUERY_DEFINITION, "locate", accounts));
  }
  return [...tools.map(toTool), ACCOUNT_LIST_TOOL];
}

// Runs one tool call. An error from any step becomes an error result that carries its message.
export async function handleCall(deps: CallDeps, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    return await route(deps, name, args);
  } catch (error) {
    return textResult(messageOf(error), true);
  }
}

// The steps of a call, in order. The first step that applies decides.
async function route(deps: CallDeps, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  // 1. account_list needs only the registry.
  if (name === ACCOUNT_LIST_NAME) {
    return textResult(accountListText(await deps.registry()), false);
  }

  // 2. The name must be in the catalog. The read-only query tool counts only while it is exposed.
  const catalog = await deps.catalog();
  const known = name === READONLY_QUERY_TOOL ? READONLY_QUERY_EXPOSED : catalog.some((tool) => tool.name === name);
  if (!known) {
    return textResult(`Unknown tool "${name}".`, true);
  }

  // 3. The account argument belongs to the server. Everything else goes to the child as it is.
  const { account, ...rest } = args;
  const mode: Mode = name === READONLY_QUERY_TOOL ? "locate" : modeOf(name);
  const officialName = name === READONLY_QUERY_TOOL ? "execute_sql" : name;

  // 4. A tool of mode none runs on the placeholder child, and its result is returned unchanged.
  if (mode === "none") {
    const child = await deps.pool.placeholder();
    return child.callTool(officialName, rest, TOOL_TIMEOUT_MS);
  }

  // 5. A change must name one account. A missing name, or a blank one, is refused before any account is contacted
  // (S10). The example is the default account, or the first account when there is no default.
  const blank = account === undefined || (typeof account === "string" && account.trim() === "");
  if (mode === "one" && blank) {
    const registry = await deps.registry();
    const first: string | undefined = registry.names()[0];
    return textResult(oneAccountRefusal(name, registry.defaultName() ?? first), true);
  }

  // 6. The argument names one account, several, or all of them. An unknown name is refused here.
  const targets = resolveTargets(account, await deps.registry());

  // 7. A change never goes to several accounts. The refusal names the first account of the list.
  if (targets.multi && mode === "one") {
    return textResult(oneAccountRefusal(name, targets.accounts[0]), true);
  }

  // 8. One account. A change uses the writable child, and every other mode uses the read-only one.
  if (!targets.multi) {
    const [only] = targets.accounts;
    const child = mode === "one" ? await deps.pool.write(only) : await deps.pool.read(only);
    return child.callTool(officialName, rest, TOOL_TIMEOUT_MS);
  }

  // 9. Several accounts, at most FANOUT_LIMIT at a time. Each account's error is caught here and kept as its outcome,
  // so one failure does not hide the others. The fan-out itself never rejects.
  const outcomes = await mapWithLimit(targets.accounts, FANOUT_LIMIT, async (accountName): Promise<Outcome> => {
    try {
      const child = await deps.pool.read(accountName);
      const result = await child.callTool(officialName, rest, TOOL_TIMEOUT_MS);
      if (result.isError !== true) {
        return { kind: "ok", result };
      }
      // A miss needs the error flag, the locate mode and the not-found text (T2).
      const text = textOf(result);
      return mode === "locate" && looksNotFound(text) ? { kind: "miss" } : { kind: "fail", error: text };
    } catch (error) {
      return { kind: "fail", error: messageOf(error) };
    }
  });

  // 10. The answer. Every account missing is an error with one line. Every account failing is an error with the JSON
  // document. Otherwise the answer is the JSON document, and the misses are listed in notFoundIn.
  if (outcomes.every((outcome) => outcome.kind === "miss")) {
    return textResult(`Not found in any account: ${targets.accounts.join(", ")}.`, true);
  }
  const accounts: Record<string, { ok: true; result: CallToolResult } | { ok: false; error: string }> = {};
  const notFoundIn: string[] = [];
  targets.accounts.forEach((accountName, index) => {
    const outcome = outcomes[index];
    if (outcome.kind === "miss") {
      notFoundIn.push(accountName);
    } else if (outcome.kind === "ok") {
      accounts[accountName] = { ok: true, result: outcome.result };
    } else {
      accounts[accountName] = { ok: false, error: outcome.error };
    }
  });
  const allFailed = outcomes.every((outcome) => outcome.kind === "fail");
  return textResult(JSON.stringify({ accounts, notFoundIn }, null, 2), allFailed);
}

// Returns a reader that calls read once and keeps its answer. A read that fails is not kept, so the next call reads
// again. Calls that arrive while a read is in flight share that read.
function readOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let held: Promise<T> | undefined;
  return () => {
    if (held === undefined) {
      const attempt = (async () => read())();
      attempt.catch(() => {
        if (held === attempt) {
          held = undefined;
        }
      });
      held = attempt;
    }
    return held;
  };
}

// The MCP server. It answers tools/list with listTools and tools/call with handleCall. The catalog is read once for the
// life of the server (R31), because each read of the pool's catalog starts and closes a child.
export function createServer(input: CallDeps): Server {
  const deps: CallDeps = { ...input, catalog: readOnce(input.catalog) };
  const version = readPackageVersion(fileURLToPath(new URL("../../package.json", import.meta.url)));
  const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({ tools: await listTools(deps) }));
  server.setRequestHandler("tools/call", async (request) =>
    handleCall(deps, request.params.name, request.params.arguments ?? {}),
  );
  return server;
}
