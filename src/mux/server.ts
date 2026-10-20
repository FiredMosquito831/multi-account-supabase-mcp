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
import type { Targets } from "./routing.js";

const SERVER_NAME = "multi-account-supabase-mcp";

// The description of account_list while no account is registered. The client shows it in place of the usual one, so it
// says why the Supabase tools are missing and how to add an account.
const NO_ACCOUNTS_LIST_DESCRIPTION =
  "No Supabase accounts are set up yet, so the Supabase tools are not listed. Add an account in a terminal with: multi-account-supabase-mcp add <name> --pat. Then list the tools again.";

// What the server needs from the rest of the program. registry gives the accounts, and each call reads them again, so a
// change takes effect at the next call. catalog gives the official tools. createServer reads it once.
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

// A miss is a not-found answer from one account. The pattern is the text match for that answer. It is used only on an
// error result, so a successful result is never a miss.
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

// The mode of a tool name. The read-only query tool is a lookup. Any other name takes its mode from the table, and
// a name the table does not name is a change.
const modeFor = (name: string): Mode => (name === READONLY_QUERY_TOOL ? "locate" : modeOf(name));

// The text the pool gives when a call passes its limit. children.ts does not export it, so it is copied here. The
// timeout test checks this copy against the pool's own message.
const POOL_TIMEOUT_TEXT = "Supabase did not answer in time (limit: 15 minutes).";

// Added to the text of a change that timed out, because the change may have run on the official server anyway.
const CHANGE_MAY_HAVE_HAPPENED = "The change may still have happened. Check before you retry.";

// The refusal for a change that does not name one account. The example names one account, when there is one.
const oneAccountRefusal = (tool: string, example: string | undefined): string => {
  const head = `"${tool}" runs on one account only, because it can change data or is not classified yet.`;
  return example === undefined
    ? `${head} No Supabase accounts are set up yet. Run in a terminal: multi-account-supabase-mcp add <name> --pat`
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

// The last signature each pool was synced to. The key is the pool, so a new pool starts with no entry, and CallDeps
// gets no new field.
const syncedSignatures = new WeakMap<ChildPool, string>();

// The server that createServer built for each pool. syncAccounts uses it to send the tool list change. A pool with no
// server gets no notification, as in the tests that call the handlers with plain dependencies.
const serverOf = new WeakMap<ChildPool, Server>();

// What a call compares with the last sync: the name, addedAt and gotrueId of each record, in the order the registry lists
// them. The token and the default are not in it, and a change of default needs no child to close. The order is part of
// it, because the account argument lists the names in that order. Each record is written as a JSON array, so two
// different lists of records never give the same text.
function registrySignature(registry: Registry): string {
  return registry
    .list()
    .map((account): [string, string, string] => [account.name, account.addedAt, account.gotrueId])
    .map((fields) => JSON.stringify(fields))
    .join("\n");
}

// Closes the account children when the records have changed since the last sync. A removed account stops at the next
// call, and a re-added one (a new gotrueId or addedAt) gets a new child with its own token. The reset empties the
// account entries before it returns, so no later call gets an old child. The sync does not wait for the closes, so a
// child that does not stop cannot hold up a call. closeAll still waits for them. A changed set of records also tells the
// client that the tool list changed. The tell comes after the reset, so the list the client reads next is the new one.
async function syncAccounts(deps: CallDeps, registry: Registry): Promise<void> {
  const signature = registrySignature(registry);
  const earlier = syncedSignatures.get(deps.pool);
  if (earlier === signature) {
    return;
  }
  syncedSignatures.set(deps.pool, signature);
  void deps.pool.resetAccounts();
  // The first sync sends nothing, because the client has no earlier list to refresh.
  if (earlier !== undefined) {
    await announceToolListChanged(deps.pool);
  }
}

// Sends the client the notification that the tool list changed. The transport may be closed, and a failed send must not
// fail the call that made the sync, so the error is dropped.
async function announceToolListChanged(pool: ChildPool): Promise<void> {
  const server = serverOf.get(pool);
  if (server === undefined) {
    return;
  }
  try {
    await server.sendToolListChanged();
  } catch {
    // The client keeps its old list until it asks for the list again.
  }
}

// The tools of tools/list. With no accounts, the list is account_list alone, with the description that says why the
// Supabase tools are missing, and the catalog is not read, because a catalog read starts a child. With accounts, the
// list is the catalog with the account argument, the read-only query tool when it is exposed, and account_list. The
// registry is read first, and the account children are synced to it before the catalog is read.
export async function listTools(deps: CallDeps): Promise<Tool[]> {
  const registry = await deps.registry();
  await syncAccounts(deps, registry);
  const accounts = registry.names();
  if (accounts.length === 0) {
    return [{ ...ACCOUNT_LIST_TOOL, description: NO_ACCOUNTS_LIST_DESCRIPTION }];
  }
  const catalog = await deps.catalog();
  const tools: OfficialTool[] = catalog.map((tool) => withAccountParam(tool, modeOf(tool.name), accounts));
  if (READONLY_QUERY_EXPOSED) {
    tools.push(withAccountParam(READONLY_QUERY_DEFINITION, "locate", accounts));
  }
  return [...tools.map(toTool), ACCOUNT_LIST_TOOL];
}

// Runs one tool call. An error from any step becomes an error result that carries its message. A change that timed out
// gets one more sentence, because the change may still have happened.
export async function handleCall(deps: CallDeps, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  try {
    return await route(deps, name, args);
  } catch (error) {
    const text = messageOf(error);
    const timedOutChange = modeFor(name) === "one" && text === POOL_TIMEOUT_TEXT;
    return textResult(timedOutChange ? `${text} ${CHANGE_MAY_HAVE_HAPPENED}` : text, true);
  }
}

// The steps of a call, in order. The first step that applies decides. A change is checked before the catalog is
// read, so a refused change starts no child.
async function route(deps: CallDeps, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  // 0. The registry is read once for this call, and every step below uses that same registry. The account children are
  // synced to it first, so this call is not handed a child of a removed account or an old token.
  const registry = await deps.registry();
  await syncAccounts(deps, registry);

  // 1. account_list needs only the registry.
  if (name === ACCOUNT_LIST_NAME) {
    return textResult(accountListText(registry), false);
  }

  // 2. The account argument belongs to the server. Everything else goes to the child as it is. The mode comes from the
  // static table, so it is known before any child starts.
  const { account, ...rest } = args;
  const mode = modeFor(name);
  const officialName = name === READONLY_QUERY_TOOL ? "execute_sql" : name;

  // 3. A change must name one account. A missing name, or a blank one, is refused before any account is contacted,
  // because a change never runs without a named account. The example is the default account, or the first account when
  // there is no default. A name for several accounts, or for all of them, is refused as well. An unknown tool name is a
  // change too, because the table does not name it, so this step runs before the catalog is read.
  let targets: Targets | undefined;
  if (mode === "one") {
    const blank = account === undefined || (typeof account === "string" && account.trim() === "");
    if (blank) {
      const first: string | undefined = registry.names()[0];
      return textResult(oneAccountRefusal(name, registry.defaultName() ?? first), true);
    }
    targets = resolveTargets(account, registry);
    // A change never goes to several accounts. The refusal names the first account of the list.
    if (targets.multi) {
      return textResult(oneAccountRefusal(name, targets.accounts[0]), true);
    }
  }

  // 4. The name must be in the catalog. The read-only query tool counts only while it is exposed.
  const catalog = await deps.catalog();
  const known = name === READONLY_QUERY_TOOL ? READONLY_QUERY_EXPOSED : catalog.some((tool) => tool.name === name);
  if (!known) {
    return textResult(`Unknown tool "${name}".`, true);
  }

  // 5. A tool of mode none runs on the placeholder child, and its result is returned unchanged.
  if (mode === "none") {
    const child = await deps.pool.placeholder();
    return child.callTool(officialName, rest, TOOL_TIMEOUT_MS);
  }

  // 6. A read names one account, several, or all of them. An unknown name is refused here.
  if (targets === undefined) {
    targets = resolveTargets(account, registry);
  }

  // 7. One account. A change uses the writable child, and every other mode uses the read-only one.
  if (!targets.multi) {
    const [only] = targets.accounts;
    const child = mode === "one" ? await deps.pool.write(only) : await deps.pool.read(only);
    return child.callTool(officialName, rest, TOOL_TIMEOUT_MS);
  }

  // 8. Several accounts, at most FANOUT_LIMIT at a time. Each account's error is caught here and kept as its outcome,
  // so one failure does not hide the others. The fan-out itself never rejects.
  const outcomes = await mapWithLimit(targets.accounts, FANOUT_LIMIT, async (accountName): Promise<Outcome> => {
    try {
      const child = await deps.pool.read(accountName);
      const result = await child.callTool(officialName, rest, TOOL_TIMEOUT_MS);
      if (result.isError !== true) {
        return { kind: "ok", result };
      }
      // A miss needs the error flag, the locate mode and the not-found text.
      const text = textOf(result);
      return mode === "locate" && looksNotFound(text) ? { kind: "miss" } : { kind: "fail", error: text };
    } catch (error) {
      return { kind: "fail", error: messageOf(error) };
    }
  });

  // 9. The answer. Every account missing is an error with one line. Every account failing is an error with the JSON
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
// life of the server, because each read of the pool's catalog starts and closes a child.
export function createServer(input: CallDeps): Server {
  const deps: CallDeps = { ...input, catalog: readOnce(input.catalog) };
  const version = readPackageVersion(fileURLToPath(new URL("../../package.json", import.meta.url)));
  // listChanged says that the tool list can change while the server runs, so a client can list it again when it is told.
  const server = new Server({ name: SERVER_NAME, version }, { capabilities: { tools: { listChanged: true } } });
  serverOf.set(input.pool, server);
  server.setRequestHandler("tools/list", async () => ({ tools: await listTools(deps) }));
  server.setRequestHandler("tools/call", async (request) =>
    handleCall(deps, request.params.name, request.params.arguments ?? {}),
  );
  return server;
}
