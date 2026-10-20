import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Registry } from "../accounts/registry.js";
import { accountListText } from "../mux/account-tools.js";
import { ChildPool, PLACEHOLDER_TOKEN, TOOL_TIMEOUT_MS } from "../mux/children.js";
import type { ChildClient, ChildSpec, OfficialTool, StartChild } from "../mux/children.js";
import { createServer, handleCall, listTools, looksNotFound } from "../mux/server.js";
import type { CallDeps } from "../mux/server.js";

const ADDED_AT = "2026-10-20T09:00:00.000Z";

// The catalog of the fake server: one tool per mode that the tests need. create_project is a change (one),
// get_project is a lookup (locate), list_projects is a list (all), and search_docs is the placeholder one (none).
const CATALOG: OfficialTool[] = [
  { name: "list_projects", description: "Lists projects.", inputSchema: { type: "object", properties: {} } },
  {
    name: "get_project",
    description: "Gets one project.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "create_project",
    description: "Creates a project.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  {
    name: "search_docs",
    description: "Searches the docs.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
];

const LISTED_TOOLS = ["list_projects", "get_project", "create_project", "search_docs", "account_list"];

// The refusal for a change that names one account, or none. The example is the account the text names.
const oneAccountText = (tool: string, example: string): string =>
  `"${tool}" runs on one account only, because it can change data or is not classified yet. Name one account, for example account: "${example}".`;

// The text of the refusal when no account is registered. resolveTargets throws it, and the server gives it for a read.
const NO_ACCOUNTS_TEXT =
  "No Supabase accounts are set up yet. Run in a terminal: multi-account-supabase-mcp add <name> --pat";

const oneAccountNoAccountsText = (tool: string): string =>
  `"${tool}" runs on one account only, because it can change data or is not classified yet. No Supabase accounts are set up yet. Run in a terminal: multi-account-supabase-mcp add <name> --pat`;

// Loads a registry from a file that this helper writes in a new temporary folder, then removes the folder. The
// registry is only read, never saved, so no test touches the owner's data folder.
async function withRegistry<T>(
  names: string[],
  defaultName: string | null,
  run: (registry: Registry) => Promise<T>,
): Promise<T> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "server-test-"));
  try {
    const accounts = names.map((name) => ({
      name,
      email: `${name}@example.com`,
      gotrueId: `fake-gotrue-${name}`,
      added: "pat",
      addedAt: ADDED_AT,
    }));
    const file = path.join(folder, "accounts.json");
    await writeFile(file, JSON.stringify({ default: defaultName, accounts }));
    return await run(await Registry.load(file));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

type Respond = (spec: ChildSpec, name: string) => CallToolResult | Promise<CallToolResult>;

type Call = { spec: ChildSpec; name: string; args: Record<string, unknown>; timeoutMs: number };

// A real ChildPool over fake children. Each fake child records its calls and answers with respond. Only the start is
// fake, so the pool's own paths (tokens, reuse, timeouts) are the ones the server uses.
function fakePool(respond: Respond) {
  const specs: ChildSpec[] = [];
  const calls: Call[] = [];
  const start: StartChild = async (spec) => {
    specs.push(spec);
    const child: ChildClient = {
      listTools: async () => [],
      callTool: async (name, args, timeoutMs) => {
        calls.push({ spec, name, args, timeoutMs });
        return respond(spec, name);
      },
      isAlive: () => true,
      close: async () => undefined,
    };
    return child;
  };
  const pool = new ChildPool(start, { tokenFor: async (account) => `fake-value-${account}` });
  return { pool, specs, calls };
}

// The deps of one test. reads.count is how many times the catalog was read.
function depsFor(registry: Registry, respond: Respond) {
  const fake = fakePool(respond);
  const reads = { count: 0 };
  const deps: CallDeps = {
    registry: async () => registry,
    pool: fake.pool,
    catalog: async () => {
      reads.count += 1;
      return CATALOG;
    },
  };
  return { deps, specs: fake.specs, calls: fake.calls, reads };
}

const ok = (text: string): CallToolResult => ({ content: [{ type: "text", text }] });
const failed = (text: string): CallToolResult => ({ content: [{ type: "text", text }], isError: true });

// Deps whose pool counts every child start, the catalog's included. The catalog is read through the pool, so reading it
// starts a child and is counted.
function countingDeps(registry: Registry) {
  const counter = { starts: 0 };
  const start: StartChild = async () => {
    counter.starts += 1;
    return {
      listTools: async () => CATALOG,
      callTool: async () => ok("unused"),
      isAlive: () => true,
      close: async () => undefined,
    };
  };
  const pool = new ChildPool(start, { tokenFor: async () => "unused" });
  const deps: CallDeps = { registry: async () => registry, pool, catalog: () => pool.catalog() };
  return { deps, counter };
}

// A pool whose children never answer a call. Its call limit is 20 milliseconds, so the pool's timeout is reached
// at once.
function silentPool(): ChildPool {
  const start: StartChild = async () => ({
    listTools: async () => CATALOG,
    callTool: () => new Promise<CallToolResult>(() => undefined),
    isAlive: () => true,
    close: async () => undefined,
  });
  return new ChildPool(start, { toolTimeoutMs: 20, tokenFor: async (account) => `fake-value-${account}` });
}

// The text of the first content block. A result whose first block is not text fails the test.
function textOf(result: CallToolResult): string {
  const [block] = result.content;
  assert.ok(block !== undefined && block.type === "text", "the first content block must be text");
  return block.text;
}

type Outcome = { ok: true; result: CallToolResult } | { ok: false; error: string };
type Doc = { accounts: Record<string, Outcome>; notFoundIn: string[] };
const docOf = (result: CallToolResult): Doc => JSON.parse(textOf(result)) as Doc;

// Connects a client to createServer over the SDK's in-memory transport, so no process is started.
async function connectedClient(deps: CallDeps): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "server-test-client", version: "0.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

test("a name that is not in the catalog is an unknown tool when a named account is given, and no child is started", () =>
  withRegistry(["work"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "nope", { account: "work" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Unknown tool "nope".');
    assert.deepEqual(specs, []);
  }));

test("a name that is not in the catalog with no account is refused as a change, because its mode is one, and no child is started", () =>
  withRegistry(["work"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "nope", {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), oneAccountText("nope", "work"));
    assert.deepEqual(specs, []);
  }));

test("account_list with no accounts starts with No accounts yet.", () =>
  withRegistry([], null, async (registry) => {
    const { deps } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "account_list", {});
    assert.ok(textOf(result).startsWith("No accounts yet."));
  }));

test("list_projects with no account and a default work reads only work, and returns the child's result unchanged", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const reply = ok("projects of work");
    const { deps, specs, calls } = depsFor(registry, () => reply);
    const result = await handleCall(deps, "list_projects", {});
    assert.strictEqual(result, reply);
    assert.deepEqual(specs, [{ account: "work", readOnly: true, token: "fake-value-work" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "list_projects");
    // Every call passes the pool's full limit, so the shared child is never closed by a shorter timeout.
    assert.equal(calls[0].timeoutMs, TOOL_TIMEOUT_MS);
  }));

test('list_projects with account "all" reads each account once, and the text lists both with notFoundIn empty', () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps, specs, calls } = depsFor(registry, () => ok("projects"));
    const result = await handleCall(deps, "list_projects", { account: "all" });
    assert.notEqual(result.isError, true);
    const doc = docOf(result);
    assert.deepEqual(Object.keys(doc.accounts), ["work", "personal"]);
    assert.deepEqual(doc.notFoundIn, []);
    assert.deepEqual(calls.map((call) => call.spec.account).sort(), ["personal", "work"]);
    assert.ok(specs.every((spec) => spec.readOnly));
    assert.ok(calls.every((call) => call.timeoutMs === TOOL_TIMEOUT_MS), "every fan-out call uses the full limit");
  }));

test('create_project with account "work,personal" is refused with the several-accounts message, and no child is started', () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "create_project", { account: "work,personal" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), oneAccountText("create_project", "work"));
    assert.deepEqual(specs, []);
  }));

test("create_project with no account and a default is refused with the one-account message, and no write is made", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "create_project", {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), oneAccountText("create_project", "work"));
    assert.deepEqual(specs, []);
  }));

test('create_project with account "work" writes to work once, and returns the child\'s result unchanged', () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const reply = ok("created");
    const { deps, specs, calls } = depsFor(registry, () => reply);
    const result = await handleCall(deps, "create_project", { account: "work", name: "demo" });
    assert.strictEqual(result, reply);
    assert.deepEqual(specs, [{ account: "work", readOnly: false, token: "fake-value-work" }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "create_project");
    // The account argument is the server's, so the child gets only the official arguments.
    assert.deepEqual(calls[0].args, { name: "demo" });
    assert.equal(calls[0].timeoutMs, TOOL_TIMEOUT_MS);
  }));

test('get_project with "all": the account without the id is under notFoundIn, the other under accounts, and isError is false', () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const reply = ok("project");
    const { deps } = depsFor(registry, (spec) => (spec.account === "personal" ? failed("Project not found") : reply));
    const result = await handleCall(deps, "get_project", { account: "all", id: "p1" });
    assert.equal(result.isError, false);
    const doc = docOf(result);
    assert.deepEqual(doc.notFoundIn, ["personal"]);
    assert.deepEqual(Object.keys(doc.accounts), ["work"]);
    assert.deepEqual(doc.accounts.work, { ok: true, result: reply });
  }));

test("a single account that does not have the id gets the child's own error, unchanged", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const reply = failed("Project not found");
    const { deps } = depsFor(registry, () => reply);
    const result = await handleCall(deps, "get_project", { account: "work", id: "p1" });
    assert.strictEqual(result, reply);
  }));

test('a successful result whose text holds 404 is not a miss, so the account stays under accounts with ok true', () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps } = depsFor(registry, (spec) => (spec.account === "personal" ? ok('{"status": 404}') : ok("found")));
    const result = await handleCall(deps, "get_project", { account: "all", id: "p1" });
    const doc = docOf(result);
    assert.deepEqual(doc.notFoundIn, []);
    assert.equal(doc.accounts.personal.ok, true);
    assert.equal(doc.accounts.work.ok, true);
  }));

test("an account whose call throws is listed as not ok, the other is ok, and the result is not an error", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const reply = ok("projects");
    const { deps } = depsFor(registry, (spec) => {
      if (spec.account === "personal") {
        throw new Error("boom");
      }
      return reply;
    });
    const result = await handleCall(deps, "list_projects", { account: "all" });
    assert.equal(result.isError, false);
    const doc = docOf(result);
    assert.deepEqual(doc.accounts.personal, { ok: false, error: "boom" });
    assert.deepEqual(doc.accounts.work, { ok: true, result: reply });
    assert.deepEqual(doc.notFoundIn, []);
  }));

test("when every account's call throws, the result is an error whose text is the JSON document", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps } = depsFor(registry, () => {
      throw new Error("boom");
    });
    const result = await handleCall(deps, "list_projects", { account: "all" });
    assert.equal(result.isError, true);
    const doc = docOf(result);
    assert.deepEqual(doc.accounts, {
      work: { ok: false, error: "boom" },
      personal: { ok: false, error: "boom" },
    });
    assert.deepEqual(doc.notFoundIn, []);
  }));

test('"constructor" is an unknown tool, not an inherited property, and no child is started', () =>
  withRegistry(["work"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "constructor", { account: "work" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Unknown tool "constructor".');
    assert.deepEqual(specs, []);
  }));

test("execute_sql_readonly is an unknown tool while READONLY_QUERY_EXPOSED is false", () =>
  withRegistry(["work"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "execute_sql_readonly", { project_id: "p1", query: "select 1" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), 'Unknown tool "execute_sql_readonly".');
    assert.deepEqual(specs, []);
  }));

test("search_docs runs on the placeholder child, the account argument is not sent to it, and the result is unchanged", () =>
  withRegistry(["work"], "work", async (registry) => {
    const reply = ok("docs");
    const { deps, specs, calls } = depsFor(registry, () => reply);
    const result = await handleCall(deps, "search_docs", { account: "work", query: "rls" });
    assert.strictEqual(result, reply);
    assert.deepEqual(specs, [{ account: null, readOnly: true, token: PLACEHOLDER_TOKEN }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, "search_docs");
    assert.deepEqual(calls[0].args, { query: "rls" });
    assert.equal(calls[0].timeoutMs, TOOL_TIMEOUT_MS);
  }));

test("a name that is not an account is refused with the known names, and no child is started", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "list_projects", { account: "nobody" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Unknown account: nobody. Known accounts: work, personal.");
    assert.deepEqual(specs, []);
  }));

test("a change with a blank account is refused as one that names no account", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "create_project", { account: "   " });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), oneAccountText("create_project", "work"));
    assert.deepEqual(specs, []);
  }));

test("a change with no account and no accounts is refused, and the message says how to add one", () =>
  withRegistry([], null, async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "create_project", {});
    assert.equal(result.isError, true);
    assert.equal(textOf(result), oneAccountNoAccountsText("create_project"));
    assert.deepEqual(specs, []);
  }));

test("with no accounts, a read, a search and an unknown tool name are refused, and no child starts", () =>
  withRegistry([], null, async (registry) => {
    const { deps, counter } = countingDeps(registry);
    // A read is refused before the catalog is read, so the catalog child is not started.
    const read = await handleCall(deps, "list_projects", {});
    assert.equal(read.isError, true);
    assert.equal(textOf(read), NO_ACCOUNTS_TEXT);
    assert.equal(counter.starts, 0, "a read starts no child, so the catalog is not read");
    // A search is refused the same way, so the placeholder child is not started either.
    const search = await handleCall(deps, "search_docs", { query: "rls" });
    assert.equal(textOf(search), NO_ACCOUNTS_TEXT);
    assert.equal(counter.starts, 0, "a search starts no child");
    // An unknown name with an account gets the account check's text, and starts no child.
    const unknown = await handleCall(deps, "nope", { account: "work" });
    assert.equal(textOf(unknown), NO_ACCOUNTS_TEXT);
    assert.equal(counter.starts, 0, "an unknown name with an account starts no child");
    // An unknown name with no account is a change by policy, so it keeps the change refusal, which ends with the same text.
    const unknownNoAccount = await handleCall(deps, "nope", {});
    assert.equal(textOf(unknownNoAccount), oneAccountNoAccountsText("nope"));
    assert.equal(counter.starts, 0, "the change refusal starts no child");
  }));

test("a change that names one account writes to it even when there is no default", () =>
  withRegistry(["work", "personal"], null, async (registry) => {
    const reply = ok("created");
    const { deps, specs } = depsFor(registry, () => reply);
    const result = await handleCall(deps, "create_project", { account: "personal", name: "demo" });
    assert.strictEqual(result, reply);
    assert.deepEqual(specs, [{ account: "personal", readOnly: false, token: "fake-value-personal" }]);
  }));

test('a change with account "all" is refused, and the message names the first account of the registry', () =>
  withRegistry(["work", "personal"], "personal", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "create_project", { account: "all" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), oneAccountText("create_project", "work"));
    assert.deepEqual(specs, []);
  }));

test("a lookup that no account can answer says so once, and lists every account", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps } = depsFor(registry, () => failed("Project not found"));
    const result = await handleCall(deps, "get_project", { account: "all", id: "p1" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), "Not found in any account: work, personal.");
  }));

test("a refused change starts no child, and the catalog child is not started either", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps, counter } = countingDeps(registry);
    for (const args of [{}, { account: "   " }, { account: "all" }, { account: "work,personal" }]) {
      const result = await handleCall(deps, "create_project", args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.equal(textOf(result), oneAccountText("create_project", "work"), JSON.stringify(args));
      assert.equal(counter.starts, 0, `no child is started for ${JSON.stringify(args)}`);
    }
  }));

test("a change that passes the pool's limit tells the agent that the change may still have happened", () =>
  withRegistry(["work"], "work", async (registry) => {
    const pool = silentPool();
    const deps: CallDeps = { registry: async () => registry, pool, catalog: async () => CATALOG };
    try {
      const result = await handleCall(deps, "create_project", { account: "work", name: "demo" });
      assert.equal(result.isError, true);
      assert.equal(
        textOf(result),
        "Supabase did not answer in time (limit: 15 minutes). The change may still have happened. Check before you retry.",
      );
    } finally {
      await pool.closeAll();
    }
  }));

test("a read that passes the pool's limit gets the timeout text alone", () =>
  withRegistry(["work"], "work", async (registry) => {
    const pool = silentPool();
    const deps: CallDeps = { registry: async () => registry, pool, catalog: async () => CATALOG };
    try {
      const result = await handleCall(deps, "list_projects", { account: "work" });
      assert.equal(result.isError, true);
      assert.equal(textOf(result), "Supabase did not answer in time (limit: 15 minutes).");
    } finally {
      await pool.closeAll();
    }
  }));

test("a change that names an account nobody has, or a value that is not text, is refused, and no child starts", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const unknown = await handleCall(deps, "create_project", { account: "nobody" });
    assert.equal(unknown.isError, true);
    assert.equal(textOf(unknown), "Unknown account: nobody. Known accounts: work, personal.");
    const notText = await handleCall(deps, "create_project", { account: 5 });
    assert.equal(notText.isError, true);
    assert.equal(textOf(notText), 'account must be a string: one name, comma-separated names, or "all".');
    assert.deepEqual(specs, []);
  }));

test('a change with account "all" is refused when only one account is registered, and no child starts', () =>
  withRegistry(["work"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const result = await handleCall(deps, "create_project", { account: "all" });
    assert.equal(result.isError, true);
    assert.equal(textOf(result), oneAccountText("create_project", "work"));
    assert.deepEqual(specs, []);
  }));

test("a not-found answer under a tool of mode all is a failure, not a miss, so the account stays under accounts", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const reply = ok("projects");
    const { deps } = depsFor(registry, (spec) => (spec.account === "personal" ? failed("Project not found") : reply));
    const result = await handleCall(deps, "list_projects", { account: "all" });
    assert.equal(result.isError, false);
    const doc = docOf(result);
    assert.deepEqual(doc.notFoundIn, []);
    assert.deepEqual(doc.accounts.personal, { ok: false, error: "Project not found" });
    assert.deepEqual(doc.accounts.work, { ok: true, result: reply });
  }));

test("account_list starts no child, and does not read the catalog", () =>
  withRegistry(["work"], "work", async (registry) => {
    const { deps, counter } = countingDeps(registry);
    const result = await handleCall(deps, "account_list", {});
    assert.notEqual(result.isError, true);
    assert.equal(textOf(result), "*work\twork@example.com\tpat");
    assert.equal(counter.starts, 0, "no child is started");
  }));

test("looksNotFound matches the not-found words and the whole number 404, and nothing else", () => {
  for (const text of ["Project not found", "HTTP 404", "The project does not exist", "They do not exist"]) {
    assert.equal(looksNotFound(text), true, text);
  }
  for (const text of ["Invalid token", "1404 rows", "", "found"]) {
    assert.equal(looksNotFound(text), false, text);
  }
});

test("accountListText marks the default with an asterisk, and the other lines with a space", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    assert.equal(
      accountListText(registry),
      "*work\twork@example.com\tpat\n personal\tpersonal@example.com\tpat",
    );
  }));

test("accountListText with no default ends with the line that says so", () =>
  withRegistry(["work", "personal"], null, async (registry) => {
    assert.equal(
      accountListText(registry),
      ' work\twork@example.com\tpat\n personal\tpersonal@example.com\tpat\nNo default account. Calls must name one, or use "all".',
    );
  }));

test("accountListText with no accounts gives the add line only", () =>
  withRegistry([], null, async (registry) => {
    assert.equal(
      accountListText(registry),
      "No accounts yet. Add one in a terminal with: multi-account-supabase-mcp add <name> --pat",
    );
  }));

test("listTools gives the catalog with the account argument, then account_list, and no read-only query tool", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps } = depsFor(registry, () => ok("unused"));
    const tools = await listTools(deps);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      LISTED_TOOLS,
    );
    const propertiesOf = (name: string): Record<string, unknown> =>
      tools.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, unknown>;
    assert.ok(Object.hasOwn(propertiesOf("list_projects"), "account"));
    assert.ok(Object.hasOwn(propertiesOf("create_project"), "account"));
    // search_docs has no account argument, so its schema is the official one.
    assert.equal(Object.hasOwn(propertiesOf("search_docs"), "account"), false);
    assert.deepEqual(propertiesOf("account_list"), {});
  }));

test("with no accounts, listTools gives only account_list, and no child is started", () =>
  withRegistry([], null, async (registry) => {
    const { deps, counter } = countingDeps(registry);
    const tools = await listTools(deps);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["account_list"],
    );
    assert.equal(counter.starts, 0, "no child is started, so the catalog is not read");
  }));

test("listTools with one account gives the catalog with the account argument, then account_list", () =>
  withRegistry(["work"], "work", async (registry) => {
    const { deps } = depsFor(registry, () => ok("unused"));
    const tools = await listTools(deps);
    assert.deepEqual(
      tools.map((tool) => tool.name),
      LISTED_TOOLS,
    );
    const propertiesOf = (name: string): Record<string, unknown> =>
      tools.find((tool) => tool.name === name)?.inputSchema.properties as Record<string, unknown>;
    assert.ok(Object.hasOwn(propertiesOf("list_projects"), "account"));
    // search_docs has no account argument, so its schema is the official one.
    assert.equal(Object.hasOwn(propertiesOf("search_docs"), "account"), false);
  }));

test("with no accounts, the one tool is account_list, and its description says why the Supabase tools are missing and how to add one", () =>
  withRegistry([], null, async (registry) => {
    const { deps } = depsFor(registry, () => ok("unused"));
    const tools = await listTools(deps);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "account_list");
    assert.deepEqual(tools[0].inputSchema, { type: "object", properties: {} });
    assert.equal(
      tools[0].description,
      "No Supabase accounts are set up yet, so the Supabase tools are not listed. Add an account in a terminal with: multi-account-supabase-mcp add <name> --pat. Then list the tools again.",
    );
  }));

test("with one account, the account_list description is the usual one", () =>
  withRegistry(["work"], "work", async (registry) => {
    const { deps } = depsFor(registry, () => ok("unused"));
    const accountList = (await listTools(deps)).find((tool) => tool.name === "account_list");
    assert.equal(
      accountList?.description,
      "Lists the accounts this server knows, with the email of each. The default account is marked with an asterisk. Tokens are never shown.",
    );
  }));

test("through the protocol, tools/list shows the tools, and a refused change comes back as an error result", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    const { deps, specs } = depsFor(registry, () => ok("unused"));
    const { client, close } = await connectedClient(deps);
    try {
      const listed = await client.listTools();
      assert.deepEqual(
        listed.tools.map((tool) => tool.name),
        LISTED_TOOLS,
      );
      const refused = await client.callTool({ name: "create_project", arguments: { account: "all", name: "x" } });
      assert.equal(refused.isError, true);
      assert.equal(textOf(refused), oneAccountText("create_project", "work"));
      assert.deepEqual(specs, []);
    } finally {
      await close();
    }
  }));

test("the catalog is read once for two lists, and both lists are the same", () =>
  withRegistry(["work"], "work", async (registry) => {
    const { deps, reads } = depsFor(registry, () => ok("unused"));
    const { client, close } = await connectedClient(deps);
    try {
      const first = await client.listTools();
      const second = await client.listTools();
      assert.equal(reads.count, 1);
      assert.deepEqual(second.tools, first.tools);
    } finally {
      await close();
    }
  }));

// Writes accounts.json in the file, with these records and this default. Each later Registry.load reads the new
// contents, so a test can change the records between two calls.
async function writeAccounts(file: string, accounts: unknown[], defaultName: string | null): Promise<void> {
  await writeFile(file, JSON.stringify({ default: defaultName, accounts }));
}

// The record of one account in accounts.json. A test can give another gotrueId and addedAt, to make a re-added account.
const recordOf = (name: string, addedAt = ADDED_AT, gotrueId = `fake-gotrue-${name}`) => ({
  name,
  email: `${name}@example.com`,
  gotrueId,
  added: "pat",
  addedAt,
});

// Runs the test in a folder of its own, and removes the folder afterwards.
async function withAccountsFile(run: (file: string) => Promise<void>): Promise<void> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "server-sync-test-"));
  try {
    await run(path.join(folder, "accounts.json"));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

// The deps of a sync test. The registry is read from the file at each call, as the server reads it.
const depsReading = (file: string, pool: ChildPool): CallDeps => ({
  registry: () => Registry.load(file),
  pool,
  catalog: async () => CATALOG,
});

// A real ChildPool whose children record how many times each one is closed. Each child answers "ok". started has one
// entry per child, in the order the children start.
function recordingPool(tokenFor: (account: string) => Promise<string>) {
  const started: { spec: ChildSpec; closes: number }[] = [];
  const start: StartChild = async (spec) => {
    const record = { spec, closes: 0 };
    started.push(record);
    return {
      listTools: async () => [],
      callTool: async () => ok("ok"),
      isAlive: () => true,
      close: async () => {
        record.closes += 1;
      },
    };
  };
  return { pool: new ChildPool(start, { tokenFor }), started };
}

test("two calls with an unchanged registry start one child for one account, and the second call reuses it", () =>
  withAccountsFile(async (file) => {
    await writeAccounts(file, [recordOf("work")], "work");
    const { pool, started } = recordingPool(async (account) => `fake-value-${account}`);
    const deps = depsReading(file, pool);
    assert.notEqual((await handleCall(deps, "list_projects", { account: "work" })).isError, true);
    assert.notEqual((await handleCall(deps, "list_projects", { account: "work" })).isError, true);
    assert.equal(started.length, 1, "one child is started");
    assert.equal(started[0].closes, 0, "the child is kept, not closed");
  }));

test("a record replaced under the same name makes the next call start a new child, and the first child is closed once", () =>
  withAccountsFile(async (file) => {
    await writeAccounts(file, [recordOf("work")], "work");
    const { pool, started } = recordingPool(async (account) => `fake-value-${account}`);
    const deps = depsReading(file, pool);
    await handleCall(deps, "list_projects", { account: "work" });
    // The same name with a new addedAt is a different record, so the account's child is replaced.
    await writeAccounts(file, [recordOf("work", "2026-10-21T09:00:00.000Z")], "work");
    await handleCall(deps, "list_projects", { account: "work" });
    assert.equal(started.length, 2, "the second call starts a new child");
    assert.equal(started[0].closes, 1, "the first child is closed once");
    assert.equal(started[1].closes, 0, "the new child is kept");
  }));

test("an account removed between two calls has its child closed at the next call of any kind, and a call for it is refused with no child started", () =>
  withAccountsFile(async (file) => {
    await writeAccounts(file, [recordOf("work"), recordOf("personal")], "work");
    const { pool, started } = recordingPool(async (account) => `fake-value-${account}`);
    const deps = depsReading(file, pool);
    await handleCall(deps, "list_projects", { account: "work" });
    await writeAccounts(file, [recordOf("personal")], "personal");
    // account_list starts no child, but it is a call of another kind, so it still closes the removed account's child.
    await handleCall(deps, "account_list", {});
    assert.equal(started[0].closes, 1, "the removed account's child is closed at the next call");
    const refused = await handleCall(deps, "list_projects", { account: "work" });
    assert.equal(refused.isError, true);
    assert.equal(textOf(refused), "Unknown account: work. Known accounts: personal.");
    assert.equal(started.length, 1, "no child is started for the removed account");
  }));

test("an account removed and added again under the same name starts a new child for its new token", () =>
  withAccountsFile(async (file) => {
    await writeAccounts(file, [recordOf("work")], "work");
    let token = "token-before-re-add";
    const { pool, started } = recordingPool(async () => token);
    const deps = depsReading(file, pool);
    await handleCall(deps, "list_projects", { account: "work" });
    // The new record has a new gotrueId and addedAt, and the token store holds the new token.
    token = "token-after-re-add";
    await writeAccounts(file, [recordOf("work", "2026-10-21T09:00:00.000Z", "fake-gotrue-work-again")], "work");
    await handleCall(deps, "list_projects", { account: "work" });
    assert.deepEqual(
      started.map((record) => record.spec.token),
      ["token-before-re-add", "token-after-re-add"],
    );
    assert.equal(started[0].closes, 1, "the child with the old token is closed");
  }));

test("a failed catalog read is not kept, so the next list reads again", () =>
  withRegistry(["work"], "work", async (registry) => {
    let reads = 0;
    const { pool } = fakePool(() => ok("unused"));
    const deps: CallDeps = {
      registry: async () => registry,
      pool,
      catalog: async () => {
        reads += 1;
        if (reads === 1) {
          throw new Error("catalog down");
        }
        return CATALOG;
      },
    };
    const { client, close } = await connectedClient(deps);
    try {
      await assert.rejects(client.listTools(), /catalog down/);
      const listed = await client.listTools();
      await client.listTools();
      assert.equal(reads, 2);
      assert.equal(listed.tools.length, LISTED_TOOLS.length);
    } finally {
      await close();
    }
  }));

test("a tool list change is announced once: not at the first sync, not for an unchanged registry, and once after an account is added", () =>
  withAccountsFile(async (file) => {
    await writeAccounts(file, [recordOf("work")], "work");
    const { pool } = recordingPool(async (account) => `fake-value-${account}`);
    const deps = depsReading(file, pool);
    // The server is built through createServer, and its notification method is replaced by a recorder.
    const server = createServer(deps);
    const announced: string[] = [];
    server.sendToolListChanged = async () => {
      announced.push("notifications/tools/list_changed");
    };
    await listTools(deps);
    assert.deepEqual(announced, [], "the first sync sends nothing");
    await listTools(deps);
    assert.deepEqual(announced, [], "a sync with the same records sends nothing");
    await writeAccounts(file, [recordOf("work"), recordOf("personal")], "work");
    await listTools(deps);
    assert.deepEqual(announced, ["notifications/tools/list_changed"], "a sync after an account is added sends one notification");
    await listTools(deps);
    assert.equal(announced.length, 1, "a further sync with the same records sends nothing more");
  }));

test("a reordered accounts file is announced once, and an unchanged sync after it sends nothing", () =>
  withAccountsFile(async (file) => {
    await writeAccounts(file, [recordOf("work"), recordOf("personal")], "work");
    const { pool } = recordingPool(async (account) => `fake-value-${account}`);
    const deps = depsReading(file, pool);
    // The server is built through createServer, and its notification method is replaced by a recorder.
    const server = createServer(deps);
    const announced: string[] = [];
    server.sendToolListChanged = async () => {
      announced.push("notifications/tools/list_changed");
    };
    await listTools(deps);
    assert.deepEqual(announced, [], "the first sync sends nothing");
    // The same two records in the other order. The account argument lists the names in file order, so the list changes.
    await writeAccounts(file, [recordOf("personal"), recordOf("work")], "work");
    const reordered = await listTools(deps);
    assert.match(JSON.stringify(reordered.find((tool) => tool.name === "list_projects")?.inputSchema), /personal, work/);
    assert.deepEqual(announced, ["notifications/tools/list_changed"], "the sync after the reorder sends one notification");
    await listTools(deps);
    assert.equal(announced.length, 1, "an unchanged sync after the reorder sends nothing more");
  }));

// Waits until the messages sent so far have reached their handlers. A notification handler runs after the message is read,
// so a check made right after the send could miss it.
const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve));

test("over the protocol, the server declares tools.listChanged, and a client gets one tools/list_changed notification after an account is added, and none before", () =>
  withAccountsFile(async (file) => {
    await writeAccounts(file, [recordOf("work")], "work");
    const { pool } = recordingPool(async (account) => `fake-value-${account}`);
    const deps = depsReading(file, pool);
    const { client, close } = await connectedClient(deps);
    let notifications = 0;
    client.setNotificationHandler("notifications/tools/list_changed", () => {
      notifications += 1;
    });
    try {
      assert.deepEqual(client.getServerCapabilities()?.tools, { listChanged: true });
      await client.listTools();
      await client.listTools();
      await settle();
      assert.equal(notifications, 0, "no notification before an account is added");
      await writeAccounts(file, [recordOf("work"), recordOf("personal")], "work");
      const listed = await client.listTools();
      await settle();
      assert.equal(notifications, 1, "one notification after an account is added");
      // The list that the client reads after the notification names both accounts.
      const project = listed.tools.find((tool) => tool.name === "list_projects");
      assert.match(JSON.stringify(project?.inputSchema), /work, personal/);
    } finally {
      await close();
    }
  }));

test("a change whose notification cannot be sent, because the transport is closed, still lists the new account", () =>
  withAccountsFile(async (file) => {
    await writeAccounts(file, [recordOf("work")], "work");
    const { pool } = recordingPool(async (account) => `fake-value-${account}`);
    const deps = depsReading(file, pool);
    const { close } = await connectedClient(deps);
    await listTools(deps);
    await close();
    await writeAccounts(file, [recordOf("work"), recordOf("personal")], "work");
    const tools = await listTools(deps);
    const listed = tools.find((tool) => tool.name === "list_projects");
    assert.match(JSON.stringify(listed?.inputSchema), /work, personal/);
  }));
