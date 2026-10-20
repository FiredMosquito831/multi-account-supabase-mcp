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
import { MemoryTokenStore } from "../secrets/token-store.js";
import { buildCallDeps } from "../serve.js";

const ADDED_AT = "2026-10-20T09:00:00.000Z";

// The source folder, reached from the compiled test in dist/test.
const SOURCE = fileURLToPath(new URL("../../src/", import.meta.url));

// Text that writes to stdout. Stdout carries the protocol in serve mode, so none of these may appear in a protocol file.
const FORBIDDEN = ["console.log(", "console.info(", "console.debug(", "process.stdout"];

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

test("no protocol file contains a text that writes to stdout", async () => {
  const files = await protocolFiles();
  // A scan that reached too few files would pass for the wrong reason, so the two files that matter most are checked.
  assert.ok(files.includes(path.join(SOURCE, "serve.ts")), "serve.ts must be scanned");
  assert.ok(files.includes(path.join(SOURCE, "mux", "server.ts")), "mux/server.ts must be scanned");
  const hits: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    for (const forbidden of FORBIDDEN) {
      if (text.includes(forbidden)) {
        hits.push(`${path.relative(SOURCE, file)} contains ${forbidden}`);
      }
    }
  }
  assert.deepEqual(hits, []);
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
    await assert.rejects(deps.pool.read("work"), /No token is stored for the account "work"/);
    assert.deepEqual(specs, []);

    await tokens.set("work", "stored-value");
    const child = await deps.pool.read("work");
    assert.deepEqual(specs, [{ account: "work", readOnly: true, token: "stored-value" }]);
    // The pool's limit is TOOL_TIMEOUT_MS, so a longer timeout from the caller is cut to it.
    await child.callTool("list_projects", {}, 2 * TOOL_TIMEOUT_MS);
    assert.deepEqual(timeouts, [TOOL_TIMEOUT_MS]);
    await deps.pool.closeAll();
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
