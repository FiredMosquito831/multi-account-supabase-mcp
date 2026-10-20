import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Registry } from "../accounts/registry.js";
import { ChildPool, TOOL_TIMEOUT_MS } from "../mux/children.js";
import type { ChildClient, ChildSpec, OfficialTool, StartChild } from "../mux/children.js";
import { createServer } from "../mux/server.js";
import type { CallDeps } from "../mux/server.js";
import { MemoryTokenStore, type TokenStore } from "../secrets/token-store.js";
import { buildCallDeps, serveStdio } from "../serve.js";

const ADDED_AT = "2026-10-20T09:00:00.000Z";

// The refusal for an account with no usable stored token. The tests that use it name the account "work".
const NO_TOKEN_WORK =
  'No token is stored for the account "work". Run multi-account-supabase-mcp remove work, then add the account again with --pat in a terminal.';

// The source folder, reached from the compiled test in dist/test.
const SOURCE = fileURLToPath(new URL("../../src/", import.meta.url));

// Text that writes to stdout, in any spacing form. Stdout carries the protocol in serve mode, so none of these may
// appear in a protocol file. The console members listed write to stdout. console.error, console.warn and console.trace
// write to stderr, so they are not listed. A reference to process.stdout matches without a call after it.
const FORBIDDEN: RegExp[] = [
  /\bconsole\s*\??\.\s*(?:log|info|debug|dir|dirxml|table|group|groupCollapsed|count|timeEnd|timeLog)\s*\(/,
  /\bconsole\s*\??\.?\s*\[\s*(["'`])(?:log|info|debug|dir|dirxml|table|group|groupCollapsed|count|timeEnd|timeLog)\1\s*\]/,
  /\bprocess\s*\??\.\s*stdout\b/,
  /\bprocess\s*\??\.?\s*\[\s*(["'`])stdout\1\s*\]/,
];

// The .ts files that run in serve mode: the folders mux, accounts, secrets and supabase, and serve.ts. src/test is not
// scanned.
async function protocolFiles(): Promise<string[]> {
  const files = [path.join(SOURCE, "serve.ts")];
  for (const folder of ["mux", "accounts", "secrets", "supabase"]) {
    for (const name of await readdir(path.join(SOURCE, folder), { recursive: true })) {
      if (name.endsWith(".ts")) {
        files.push(path.join(SOURCE, folder, name));
      }
    }
  }
  return files;
}

test("no protocol file contains a text that writes to stdout, in any spacing form", async () => {
  const files = await protocolFiles();
  // A scan that reached too few files would pass for the wrong reason, so the two files that matter most are checked.
  assert.ok(files.includes(path.join(SOURCE, "serve.ts")), "serve.ts must be scanned");
  assert.ok(files.includes(path.join(SOURCE, "mux", "server.ts")), "mux/server.ts must be scanned");
  const hits: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const forbidden of FORBIDDEN) {
      if (forbidden.test(text)) {
        hits.push(`${path.relative(SOURCE, file)} matches ${forbidden.source}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("the stdout patterns catch the spacing forms of the stdout writers, and leave the stderr writers alone", () => {
  const writesToStdout = [
    'console.log("x")',
    'console .log ("x")',
    "console\n  .groupCollapsed('x')",
    'console["timeLog"]("x")',
    "console['count']()",
    "console.dirxml(x)",
    'globalThis?.console?.log("x")',
    'process.stdout.write("x")',
    'process ["stdout"].write("x")',
  ];
  const writesToStderr = ['console.error("x")', 'console.warn("x")', 'console.trace("x")', "process.stderr.write('x')"];
  for (const text of writesToStdout) {
    assert.ok(FORBIDDEN.some((pattern) => pattern.test(text)), `must be caught: ${text}`);
  }
  for (const text of writesToStderr) {
    assert.equal(FORBIDDEN.some((pattern) => pattern.test(text)), false, `must not be caught: ${text}`);
  }
});

// Loads a real registry from a file that this helper writes in a new temporary folder, then removes the folder. The
// accounts are fake. The registry is only read, never saved, so the owner's data folder is not touched.
async function withRegistry<T>(
  names: string[],
  defaultName: string | null,
  run: (registry: Registry) => Promise<T>,
): Promise<T> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "serve-test-"));
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

// One tool per mode that the test needs (all, locate, one, none), and one tool that the policy table does not name.
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
  { name: "future_tool", description: "A tool the policy table does not name.", inputSchema: { type: "object", properties: {} } },
];

test("tools/list over the in-memory transport lists account_list and the catalog, and gives account to each catalog tool but search_docs", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    let starts = 0;
    const start: StartChild = async () => {
      starts += 1;
      throw new Error("no child may start in this test");
    };
    const deps: CallDeps = {
      registry: async () => registry,
      pool: new ChildPool(start, { tokenFor: async () => "unused" }),
      catalog: async () => CATALOG,
    };
    const server = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "serve-test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      assert.ok(names.includes("account_list"), "account_list is listed");
      for (const tool of CATALOG) {
        assert.ok(names.includes(tool.name), `${tool.name} is listed`);
      }
      const propertiesOf = (name: string): Record<string, unknown> => {
        const found = tools.find((candidate) => candidate.name === name);
        assert.ok(found !== undefined, `${name} is listed`);
        return found.inputSchema.properties as Record<string, unknown>;
      };
      for (const tool of CATALOG) {
        // search_docs has mode none, so it has no account argument. Every other catalog tool has one.
        const hasAccount = Object.hasOwn(propertiesOf(tool.name), "account");
        assert.equal(hasAccount, tool.name !== "search_docs", tool.name);
      }
      assert.equal(Object.hasOwn(propertiesOf("account_list"), "account"), false);
      assert.equal(starts, 0, "listing the tools starts no child");
    } finally {
      await client.close();
      await server.close();
    }
  }));

test("a tool the policy does not name counts as a change: all and a list are refused over the protocol, and no child starts", () =>
  withRegistry(["work", "personal"], "work", async (registry) => {
    let starts = 0;
    const start: StartChild = async () => {
      starts += 1;
      throw new Error("no child may start in this test");
    };
    const deps: CallDeps = {
      registry: async () => registry,
      pool: new ChildPool(start, { tokenFor: async () => "unused" }),
      catalog: async () => CATALOG,
    };
    const server = createServer(deps);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "serve-test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      for (const account of ["all", "work,personal"]) {
        const result = await client.callTool({ name: "future_tool", arguments: { account } });
        assert.equal(result.isError, true, account);
        const [block] = result.content;
        assert.ok(
          block !== undefined && block.type === "text" && block.text.includes("runs on one account only"),
          account,
        );
      }
      assert.equal(starts, 0, "no child starts");
    } finally {
      await client.close();
      await server.close();
    }
  }));

test("buildCallDeps starts no child", () =>
  withRegistry(["work"], "work", async (registry) => {
    let starts = 0;
    const start: StartChild = async () => {
      starts += 1;
      throw new Error("no child may start in this test");
    };
    const deps = buildCallDeps({ registry, tokens: new MemoryTokenStore(), start });
    assert.strictEqual(await deps.registry(), registry);
    assert.equal(starts, 0);
  }));

test("a read takes its token from the store and uses the full tool timeout, and an account with no stored token starts no child", () =>
  withRegistry(["work"], "work", async (registry) => {
    const tokens = new MemoryTokenStore();
    const specs: ChildSpec[] = [];
    const timeouts: number[] = [];
    const start: StartChild = async (spec) => {
      specs.push(spec);
      return silentChild(timeouts);
    };
    const deps = buildCallDeps({ registry, tokens, start });
    await assert.rejects(deps.pool.read("work"), { message: NO_TOKEN_WORK });
    assert.deepEqual(specs, []);

    await tokens.set("work", "stored-value");
    const child = await deps.pool.read("work");
    assert.deepEqual(specs, [{ account: "work", readOnly: true, token: "stored-value" }]);
    // The pool's limit is TOOL_TIMEOUT_MS, so a longer timeout from the caller is cut to it.
    await child.callTool("list_projects", {}, 2 * TOOL_TIMEOUT_MS);
    assert.deepEqual(timeouts, [TOOL_TIMEOUT_MS]);
    await deps.pool.closeAll();
  }));

test("an empty stored token counts as missing: the call is refused with the same message, and no child starts", () =>
  withRegistry(["work"], "work", async (registry) => {
    let starts = 0;
    const start: StartChild = async () => {
      starts += 1;
      throw new Error("no child may start in this test");
    };
    const tokens: TokenStore = {
      get: async () => "",
      set: async () => undefined,
      delete: async () => undefined,
    };
    const deps = buildCallDeps({ registry, tokens, start });
    await assert.rejects(deps.pool.read("work"), { message: NO_TOKEN_WORK });
    assert.equal(starts, 0);
  }));

// A client calls a tool that reaches the account "work", then closes. serveStdio must close every child that was started,
// and the child for "work" must close before serveStdio resolves. A hang fails the test after ten seconds.
test("the child for work closes before serveStdio resolves, and every child that was started is closed", { timeout: 10_000 }, () =>
  withRegistry(["work"], "work", async (registry) => {
    const tokens = new MemoryTokenStore();
    await tokens.set("work", "fake-token-for-work");
    // The events of the test, in the order they happen: each close, then the resolution of serveStdio.
    const events: string[] = [];
    const started: { spec: ChildSpec; closes: number }[] = [];
    const start: StartChild = async (spec) => {
      const record = { spec, closes: 0 };
      started.push(record);
      const name = spec.account ?? "catalog";
      return {
        listTools: async () => CATALOG,
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
        isAlive: () => true,
        close: async () => {
          record.closes += 1;
          events.push(`closed ${name}`);
        },
      };
    };
    const deps = buildCallDeps({ registry, tokens, start });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const served = serveStdio(deps, { transport: serverTransport }).then(() => {
      events.push("serveStdio resolved");
    });
    const client = new Client({ name: "serve-test-client", version: "0.0.0" });
    await client.connect(clientTransport);
    const result = await client.callTool({ name: "list_projects", arguments: { account: "work" } });
    await client.close();
    await served;

    assert.deepEqual(result.content, [{ type: "text", text: "ok" }], "the fake child for work answers the call");
    assert.ok(events.includes("serveStdio resolved"), "serveStdio has resolved");
    const workChildren = started.filter((record) => record.spec.account === "work");
    assert.equal(workChildren.length, 1, "one child for work was started");
    assert.equal(workChildren[0].closes, 1, "the child for work is closed once");
    for (const record of started) {
      assert.equal(record.closes, 1, `the child for ${record.spec.account ?? "the catalog"} is closed`);
    }
    const closedAt = events.indexOf("closed work");
    const resolvedAt = events.indexOf("serveStdio resolved");
    assert.ok(closedAt !== -1 && closedAt < resolvedAt, `the child for work closes first (events: ${events.join(", ")})`);
  }));

// A child that answers every call with "ok" and records the timeout of each call.
function silentChild(timeouts: number[]): ChildClient {
  return {
    listTools: async () => [],
    callTool: async (_name, _args, timeoutMs) => {
      timeouts.push(timeoutMs);
      return { content: [{ type: "text", text: "ok" }] };
    },
    isAlive: () => true,
    close: async () => undefined,
  };
}
