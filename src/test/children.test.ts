import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/client/stdio";
import { ChildPool, PLACEHOLDER_TOKEN, TOOL_TIMEOUT_MS, childEnv } from "../mux/children.js";
import type { ChildClient, ChildSpec, OfficialTool, StartChild } from "../mux/children.js";

// The options of a fake child. Its close can fail (closeError) or never finish (closeHangs).
type FakeOptions = {
  tools?: OfficialTool[];
  reply?: CallToolResult;
  listError?: Error;
  closeError?: Error;
  closeHangs?: boolean;
};

// A fake child. It records what the pool does to it. Its callTool never answers, unless the test gives it a reply.
class FakeChild implements ChildClient {
  alive = true;
  closes = 0;
  lists = 0;
  timeouts: number[] = [];

  constructor(private readonly options: FakeOptions = {}) {}

  isAlive(): boolean {
    return this.alive;
  }

  async listTools(): Promise<OfficialTool[]> {
    this.lists += 1;
    if (this.options.listError !== undefined) {
      throw this.options.listError;
    }
    return this.options.tools ?? [];
  }

  callTool(_name: string, _args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult> {
    this.timeouts.push(timeoutMs);
    if (this.options.reply !== undefined) {
      return Promise.resolve(this.options.reply);
    }
    return new Promise<CallToolResult>(() => undefined);
  }

  async close(): Promise<void> {
    this.closes += 1;
    this.alive = false;
    if (this.options.closeError !== undefined) {
      throw this.options.closeError;
    }
    if (this.options.closeHangs === true) {
      return new Promise<void>(() => undefined);
    }
  }
}

// A fake StartChild. It records each spec, and returns a new FakeChild for each start. The children are kept in order.
function fakeStart(options: FakeOptions = {}) {
  const specs: ChildSpec[] = [];
  const children: FakeChild[] = [];
  const start: StartChild = async (spec) => {
    specs.push(spec);
    const child = new FakeChild(options);
    children.push(child);
    return child;
  };
  return { start, specs, children };
}

const tokenFor = async (account: string): Promise<string> => `${account}-token`;

// The entries of an env that have a value. childEnv also lists the SDK default names it blanks, with undefined.
function definedEntries(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined));
}

// Resolves with the error that a promise rejects with, or with undefined when it resolves. It never rejects, so a
// call that fails is not left unhandled while the test waits on something else.
const errorOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

test("read gives a read-only child with the account's token, and a second read reuses it", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { tokenFor });
  const first = await pool.read("work");
  const second = await pool.read("work");
  assert.deepEqual(fake.specs, [{ account: "work", readOnly: true, token: "work-token" }]);
  assert.strictEqual(second, first);
});

test("two reads that arrive together share one start", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { tokenFor });
  const [first, second] = await Promise.all([pool.read("work"), pool.read("work")]);
  assert.equal(fake.specs.length, 1);
  assert.strictEqual(second, first);
});

test("write gives a child that is not read-only", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { tokenFor });
  await pool.write("work");
  assert.deepEqual(fake.specs, [{ account: "work", readOnly: false, token: "work-token" }]);
});

test("catalog starts a placeholder child, lists the tools, closes the child once and returns the list", async () => {
  const tools: OfficialTool[] = [{ name: "list_projects", inputSchema: { type: "object" } }];
  const fake = fakeStart({ tools });
  const pool = new ChildPool(fake.start, { tokenFor });
  const result = await pool.catalog();
  assert.deepEqual(fake.specs, [{ account: null, readOnly: false, token: PLACEHOLDER_TOKEN }]);
  assert.deepEqual(result, tools);
  assert.equal(fake.children[0].lists, 1);
  assert.equal(fake.children[0].closes, 1);
});

test("catalog closes its child even when listing fails", async () => {
  const fake = fakeStart({ listError: new Error("list failed") });
  const pool = new ChildPool(fake.start, { tokenFor });
  await assert.rejects(pool.catalog(), { message: "list failed" });
  assert.equal(fake.children[0].closes, 1);
});

test("a child that reports isAlive false is replaced by a new start on the next read", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { tokenFor });
  const first = await pool.read("work");
  fake.children[0].alive = false;
  const second = await pool.read("work");
  assert.equal(fake.specs.length, 2);
  assert.notStrictEqual(second, first);
});

test("a call that never answers rejects with the timeout message within one second", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { toolTimeoutMs: 20, tokenFor });
  const child = await pool.read("work");
  const began = Date.now();
  await assert.rejects(child.callTool("execute_sql", {}, TOOL_TIMEOUT_MS), /did not answer in time/);
  assert.ok(Date.now() - began < 1000, "the rejection must come within one second");
  // The child gets the pool's limit as its own timeout, so the SDK call and the pool's timer end together.
  assert.deepEqual(fake.children[0].timeouts, [20]);
});

test("the timeout message is fixed, whatever the limit, and a shorter per-call timeout gives it too", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { tokenFor });
  const child = await pool.read("work");
  await assert.rejects(child.callTool("execute_sql", {}, 20), {
    message: "Supabase did not answer in time (limit: 15 minutes).",
  });
});

test("a call that times out closes its child, and the next read starts a new one", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { toolTimeoutMs: 20, tokenFor });
  const first = await pool.read("work");
  await assert.rejects(first.callTool("execute_sql", {}, TOOL_TIMEOUT_MS), /did not answer in time/);
  const second = await pool.read("work");
  assert.equal(fake.specs.length, 2);
  assert.notStrictEqual(second, first);
  assert.equal(fake.children[0].closes, 1);
});

test("a close that fails after a timeout does not replace the timeout error", async () => {
  const fake = fakeStart({ closeError: new Error("close failed") });
  const pool = new ChildPool(fake.start, { toolTimeoutMs: 20, tokenFor });
  const child = await pool.read("work");
  await assert.rejects(child.callTool("execute_sql", {}, TOOL_TIMEOUT_MS), {
    message: "Supabase did not answer in time (limit: 15 minutes).",
  });
});

test("a close that never finishes does not delay the timeout error", async () => {
  const fake = fakeStart({ closeHangs: true });
  const pool = new ChildPool(fake.start, { toolTimeoutMs: 20, tokenFor });
  const child = await pool.read("work");
  const began = Date.now();
  await assert.rejects(child.callTool("execute_sql", {}, TOOL_TIMEOUT_MS), /did not answer in time/);
  assert.ok(Date.now() - began < 1000, "the rejection must not wait for the close");
});

test("a call that answers in time returns the child's answer", async () => {
  const reply: CallToolResult = { content: [{ type: "text", text: "ok" }] };
  const fake = fakeStart({ reply });
  const pool = new ChildPool(fake.start, { tokenFor });
  const child = await pool.read("work");
  assert.deepEqual(await child.callTool("list_projects", {}, TOOL_TIMEOUT_MS), reply);
});

test("no account child receives the placeholder token, and placeholder() starts one child with it", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { tokenFor });
  await pool.read("work");
  await pool.write("work");
  await pool.placeholder();
  await pool.placeholder();
  assert.deepEqual(fake.specs, [
    { account: "work", readOnly: true, token: "work-token" },
    { account: "work", readOnly: false, token: "work-token" },
    { account: null, readOnly: false, token: PLACEHOLDER_TOKEN },
  ]);
});

test("an account whose stored token is the placeholder is refused before any child starts", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { tokenFor: async () => PLACEHOLDER_TOKEN });
  await assert.rejects(pool.read("work"), /placeholder/);
  assert.equal(fake.specs.length, 0);
});

test("closeAll closes every child the pool started", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { tokenFor });
  await pool.read("work");
  await pool.write("work");
  await pool.placeholder();
  await pool.closeAll();
  assert.deepEqual(
    fake.children.map((child) => child.closes),
    [1, 1, 1],
  );
});

// The message of a call that arrives after closeAll.
const SHUTTING_DOWN = "The server is shutting down, so no child is started.";

test("after closeAll, read, write, placeholder and catalog reject, and no child is started", async () => {
  const fake = fakeStart();
  const pool = new ChildPool(fake.start, { tokenFor });
  await pool.read("work");
  await pool.closeAll();
  const starts = fake.specs.length;
  await assert.rejects(pool.read("work"), { message: SHUTTING_DOWN });
  await assert.rejects(pool.write("work"), { message: SHUTTING_DOWN });
  await assert.rejects(pool.placeholder(), { message: SHUTTING_DOWN });
  await assert.rejects(pool.catalog(), { message: SHUTTING_DOWN });
  assert.equal(fake.specs.length, starts);
});

test("a start that is pending when closeAll runs is closed, and its call gets the shutdown message", async () => {
  const children: FakeChild[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start: StartChild = async () => {
    await gate;
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const pool = new ChildPool(start, { tokenFor });
  const pending = errorOf(pool.read("work"));
  const closing = pool.closeAll();
  release();
  await closing;
  const error = await pending;
  assert.equal(
    error instanceof Error ? error.message : undefined,
    SHUTTING_DOWN,
    "the call must get the shutdown message",
  );
  assert.equal(children.length, 1);
  assert.equal(children[0].closes, 1);
});

test("a catalog start that is pending when closeAll runs is closed by closeAll, and catalog rejects", async () => {
  const children: FakeChild[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start: StartChild = async () => {
    await gate;
    const child = new FakeChild({ tools: [{ name: "list_projects", inputSchema: { type: "object" } }] });
    children.push(child);
    return child;
  };
  const pool = new ChildPool(start, { tokenFor });
  const cataloging = errorOf(pool.catalog());
  const closing = pool.closeAll();
  release();
  await closing;
  const error = await cataloging;
  assert.equal(
    error instanceof Error ? error.message : undefined,
    SHUTTING_DOWN,
    "catalog must reject with the shutdown message",
  );
  assert.equal(children.length, 1);
  assert.equal(children[0].closes, 1, "closeAll must close the catalog child, once");
  assert.equal(children[0].alive, false, "the catalog child must not be left open");
  assert.equal(children[0].lists, 0, "no listing may start after closeAll");
});

test("a read that waits on a held start gets the shutdown message, and no child starts after closeAll", async () => {
  const specs: ChildSpec[] = [];
  const children: FakeChild[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const start: StartChild = async (spec) => {
    specs.push(spec);
    await gate;
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  const pool = new ChildPool(start, { tokenFor });
  const holder = errorOf(pool.read("work"));
  const waiter = errorOf(pool.read("work"));
  const closing = pool.closeAll();
  release();
  await closing;
  const holderError = await holder;
  const waiterError = await waiter;
  assert.equal(
    holderError instanceof Error ? holderError.message : undefined,
    SHUTTING_DOWN,
    "the call that held the start finished after closeAll began, so it gets the shutdown message",
  );
  assert.equal(
    waiterError instanceof Error ? waiterError.message : undefined,
    SHUTTING_DOWN,
    "the read that waited on the start must reject with the shutdown message",
  );
  assert.equal(specs.length, 1, "no child starts after closeAll");
  assert.equal(children.length, 1);
  assert.equal(children[0].closes, 1, "closeAll closes the child that the held start produced");
});

test("closeAll closes a catalog child that is still listing, and does not wait for the listing", async () => {
  const children: FakeChild[] = [];
  let finishListing!: () => void;
  const listing = new Promise<void>((resolve) => {
    finishListing = resolve;
  });
  const start: StartChild = async () => {
    const child = new FakeChild();
    child.listTools = async () => {
      child.lists += 1;
      await listing;
      return [];
    };
    children.push(child);
    return child;
  };
  const pool = new ChildPool(start, { tokenFor });
  const cataloging = errorOf(pool.catalog());
  // Let the listing begin before closeAll runs.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(children[0].lists, 1, "the listing must have begun");
  try {
    await pool.closeAll();
    assert.equal(children[0].closes, 1, "closeAll must close the listing child, while the listing is still open");
  } finally {
    finishListing();
  }
  await cataloging;
  assert.equal(children[0].closes, 1, "catalog must not close the child a second time");
});

test("childEnv keeps PATH and the token, and drops the other names of the example parent", () => {
  const parent = { PATH: "p", AWS_SECRET_ACCESS_KEY: "x", GITHUB_TOKEN: "y", HOME: "h" };
  assert.deepEqual(definedEntries(childEnv("tok", parent)), { PATH: "p", SUPABASE_ACCESS_TOKEN: "tok" });
  const withoutToken = childEnv(undefined, parent);
  assert.deepEqual(definedEntries(withoutToken), { PATH: "p" });
  assert.equal(Object.hasOwn(withoutToken, "SUPABASE_ACCESS_TOKEN"), false);
});

test("childEnv copies each allowed name and nothing else, and never the parent's own token", () => {
  const parent = {
    PATH: "1",
    Path: "2",
    PATHEXT: "3",
    SYSTEMROOT: "4",
    SystemRoot: "5",
    TEMP: "6",
    TMP: "7",
    HOME: "8",
    SUPABASE_ACCESS_TOKEN: "from-parent",
  };
  assert.deepEqual(definedEntries(childEnv(undefined, parent)), {
    PATH: "1",
    Path: "2",
    PATHEXT: "3",
    SYSTEMROOT: "4",
    SystemRoot: "5",
    TEMP: "6",
    TMP: "7",
  });
  assert.equal(childEnv("given", parent).SUPABASE_ACCESS_TOKEN, "given");
});

test("childEnv marks every SDK default name outside the allowlist as undefined, and keeps the allowed names", () => {
  const allowlist = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP"];
  const parent: NodeJS.ProcessEnv = {
    PATH: "p",
    Path: "p2",
    PATHEXT: ".EXE",
    SYSTEMROOT: "r",
    SystemRoot: "r2",
    TEMP: "t",
    TMP: "t2",
    AWS_SECRET_ACCESS_KEY: "x",
  };
  const env = childEnv("tok", parent);
  // The names come from the SDK's own list, so the test holds on Windows and on Linux.
  for (const name of DEFAULT_INHERITED_ENV_VARS) {
    if (allowlist.includes(name)) {
      if (parent[name] !== undefined) {
        assert.equal(env[name], parent[name], `${name} keeps the parent's value`);
      }
    } else {
      assert.ok(Object.hasOwn(env, name), `${name} is listed, so the SDK's default for it is overridden`);
      assert.equal(env[name], undefined, `${name} is undefined`);
    }
  }
  assert.equal(Object.hasOwn(env, "AWS_SECRET_ACCESS_KEY"), false);
  assert.equal(env.SUPABASE_ACCESS_TOKEN, "tok");
  assert.equal(Object.hasOwn(childEnv(undefined, parent), "SUPABASE_ACCESS_TOKEN"), false);
});
