import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallToolResult } from "@modelcontextprotocol/client";
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

test("childEnv keeps PATH and the token, and drops the other names of the example parent", () => {
  const parent = { PATH: "p", AWS_SECRET_ACCESS_KEY: "x", GITHUB_TOKEN: "y", HOME: "h" };
  assert.deepEqual(childEnv("tok", parent), { PATH: "p", SUPABASE_ACCESS_TOKEN: "tok" });
  const withoutToken = childEnv(undefined, parent);
  assert.deepEqual(withoutToken, { PATH: "p" });
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
  assert.deepEqual(childEnv(undefined, parent), {
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
