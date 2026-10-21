import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandResult, Runner } from "../agents/command.js";
import { runPlan } from "../agents/plan.js";
import type { Scope } from "../agents/scopes.js";
import type { AgentId } from "../agents/state.js";
import {
  type AgentAdapter,
  type Context,
  type FileOps,
  type Step,
  UnsupportedScope,
  makeContext,
} from "../agents/types.js";

// These paths are only text. The fake file functions never touch the disk, so the paths need not exist.
const PROJECT = path.resolve("fake-project");
const PACKAGE = path.resolve("fake-package");
const CLI = path.join(PACKAGE, "dist", "cli.js");
const CONFIG = path.join(PROJECT, ".mcp.json");
const OLD = path.join(PROJECT, "old.json");

// A fake runner. It logs each command line it is given, and succeeds with no output.
const fakeRunner =
  (effects: string[]): Runner =>
  async (command, args): Promise<CommandResult> => {
    effects.push(`run ${[command, ...args].join(" ")}`);
    return { code: 0, stdout: "", stderr: "" };
  };

// Fake file functions. They log each call and keep the text in a map, so nothing reaches the disk.
const fakeFiles = (effects: string[], contents: Map<string, string>): FileOps => ({
  writeFile: async (file, text) => {
    effects.push(`write ${file}`);
    contents.set(file, text);
  },
  removeFile: async (file) => {
    effects.push(`remove ${file}`);
    contents.delete(file);
  },
  ensureDir: async (dir) => {
    effects.push(`mkdir ${dir}`);
  },
  removeDirIfEmpty: async (dir) => {
    effects.push(`rmdir ${dir}`);
  },
});

// A context whose runner and file functions are fakes. The dry run flag is given for each context.
const contextFor = (dryRun: boolean, effects: string[], contents = new Map<string, string>()): Context =>
  makeContext({
    projectDir: PROJECT,
    cliPath: CLI,
    packageRoot: PACKAGE,
    dryRun,
    present: () => true,
    run: fakeRunner(effects),
    fs: fakeFiles(effects, contents),
  });

// A fake adapter. Each method logs the agent, the method and the scope. It then runs the action with the context, and
// returns one ok step. Doctor has no scope of its own, so its step names the global scope.
const fakeAdapter = (
  id: AgentId,
  scopes: readonly Scope[],
  calls: string[],
  action: (ctx: Context) => Promise<void> = async () => undefined,
): AgentAdapter => {
  const change =
    (name: "install" | "update" | "uninstall") =>
    async (ctx: Context, scope: Scope): Promise<Step[]> => {
      calls.push(`${id} ${name} ${scope}`);
      await action(ctx);
      return [{ agent: id, scope, status: "ok", message: `${name} done` }];
    };
  return {
    id,
    scopes,
    present: () => true,
    install: change("install"),
    update: change("update"),
    uninstall: change("uninstall"),
    doctor: async (ctx) => {
      calls.push(`${id} doctor`);
      await action(ctx);
      return [{ agent: id, scope: "global", status: "ok", message: "doctor done" }];
    },
  };
};

test("a named agent without the scope throws UnsupportedScope", async () => {
  const calls: string[] = [];
  const antigravity = fakeAdapter("antigravity", ["global"], calls);
  await assert.rejects(
    runPlan({
      adapters: [antigravity],
      action: "install",
      agents: ["antigravity"],
      scope: "project",
      ctx: contextFor(true, []),
    }),
    (error: unknown) => error instanceof UnsupportedScope && error.message === "antigravity has no project scope",
  );
  assert.deepEqual(calls, []);
});

test("an agent without the scope is skipped with its reason when no agent was named", async () => {
  const calls: string[] = [];
  const result = await runPlan({
    adapters: [
      fakeAdapter("claude", ["global", "project", "local"], calls),
      fakeAdapter("antigravity", ["global"], calls),
    ],
    action: "install",
    scope: "project",
    ctx: contextFor(true, []),
  });
  assert.deepEqual(result.steps, [
    { agent: "claude", scope: "project", status: "ok", message: "install done" },
    { agent: "antigravity", scope: "project", status: "skipped", message: "antigravity has no project scope" },
  ]);
  assert.deepEqual(calls, ["claude install project"]);
});

test("a dry run changes no file and runs no command, and lists each one in order", async () => {
  const effects: string[] = [];
  const contents = new Map<string, string>();
  const calls: string[] = [];
  const codex = fakeAdapter("codex", ["global", "project"], calls, async (ctx) => {
    await ctx.writeFile(CONFIG, "{}\n");
    await ctx.run("codex", ["mcp", "add", "multi-account-supabase"]);
  });
  const result = await runPlan({
    adapters: [codex],
    action: "install",
    agents: ["codex"],
    ctx: contextFor(true, effects, contents),
  });
  assert.deepEqual(effects, []);
  assert.equal(contents.size, 0);
  assert.deepEqual(result.shown, [`write ${CONFIG}`, "codex mcp add multi-account-supabase"]);
  assert.deepEqual(calls, ["codex install global"]);
});

test("the scope is global when none is given", async () => {
  const calls: string[] = [];
  const result = await runPlan({
    adapters: [fakeAdapter("claude", ["global", "project", "local"], calls)],
    action: "update",
    ctx: contextFor(true, []),
  });
  assert.deepEqual(calls, ["claude update global"]);
  assert.deepEqual(result.steps, [{ agent: "claude", scope: "global", status: "ok", message: "update done" }]);
});

test("a named agent without the scope stops the command before any agent is called", async () => {
  const calls: string[] = [];
  const effects: string[] = [];
  const claude = fakeAdapter("claude", ["global", "project", "local"], calls);
  const antigravity = fakeAdapter("antigravity", ["global"], calls);
  await assert.rejects(
    runPlan({
      adapters: [claude, antigravity],
      action: "install",
      agents: ["claude", "antigravity"],
      scope: "project",
      ctx: contextFor(false, effects),
    }),
    (error: unknown) => error instanceof UnsupportedScope,
  );
  assert.deepEqual(calls, []);
  assert.deepEqual(effects, []);
});

test("a real run makes each change it lists, in order", async () => {
  const effects: string[] = [];
  const contents = new Map<string, string>([[OLD, "old"]]);
  const adapter = fakeAdapter("claude", ["global"], [], async (ctx) => {
    await ctx.writeFile(CONFIG, "{}\n");
    await ctx.removeFile(OLD);
    await ctx.run("claude", ["mcp", "list"]);
  });
  const result = await runPlan({ adapters: [adapter], action: "install", ctx: contextFor(false, effects, contents) });
  assert.deepEqual(effects, [`write ${CONFIG}`, `remove ${OLD}`, "run claude mcp list"]);
  assert.equal(contents.get(CONFIG), "{}\n");
  assert.equal(contents.has(OLD), false);
  assert.deepEqual(result.shown, [`write ${CONFIG}`, `remove ${OLD}`, "claude mcp list"]);
});

test("doctor ignores the scope, so an agent without that scope is still checked", async () => {
  const calls: string[] = [];
  const result = await runPlan({
    adapters: [fakeAdapter("antigravity", ["global"], calls)],
    action: "doctor",
    agents: ["antigravity"],
    scope: "project",
    ctx: contextFor(true, []),
  });
  assert.deepEqual(calls, ["antigravity doctor"]);
  assert.deepEqual(
    result.steps.map((step) => step.status),
    ["ok"],
  );
});

test("an adapter that throws gives one error step, and the agents before and after it still run", async () => {
  const calls: string[] = [];
  const claude = fakeAdapter("claude", ["global", "project", "local"], calls);
  const codex: AgentAdapter = {
    ...fakeAdapter("codex", ["global", "project"], calls),
    install: async (_ctx, scope) => {
      calls.push(`codex install ${scope}`);
      throw new Error("the codex configuration is busy");
    },
  };
  const antigravity = fakeAdapter("antigravity", ["global"], calls);
  const result = await runPlan({
    adapters: [claude, codex, antigravity],
    action: "install",
    ctx: contextFor(true, []),
  });
  assert.deepEqual(result.steps, [
    { agent: "claude", scope: "global", status: "ok", message: "install done" },
    { agent: "codex", scope: "global", status: "error", message: "the codex configuration is busy" },
    { agent: "antigravity", scope: "global", status: "ok", message: "install done" },
  ]);
  assert.deepEqual(calls, ["claude install global", "codex install global", "antigravity install global"]);
});

test("a thrown value that is not an Error gives a fixed message, so its text is never written out", async () => {
  const codex: AgentAdapter = {
    ...fakeAdapter("codex", ["global"], []),
    install: async () => {
      throw "the text of a file";
    },
  };
  const result = await runPlan({ adapters: [codex], action: "install", ctx: contextFor(true, []) });
  assert.deepEqual(result.steps, [
    { agent: "codex", scope: "global", status: "error", message: "The step failed without a message." },
  ]);
});

test("a dry run command succeeds with no output, and quotes an argument that has a space", async () => {
  const effects: string[] = [];
  const ctx = contextFor(true, effects);
  assert.deepEqual(await ctx.run("node", ["C:\\Program Files\\nodejs\\cli.js", "serve"]), {
    code: 0,
    stdout: "",
    stderr: "",
  });
  assert.deepEqual(ctx.shown, ['node "C:\\Program Files\\nodejs\\cli.js" serve']);
  assert.deepEqual(effects, []);
});

test("a dry run records a mkdir and creates no folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-test-"));
  try {
    const folder = path.join(root, "state", "folder");
    const ctx = makeContext({
      projectDir: PROJECT,
      cliPath: CLI,
      packageRoot: PACKAGE,
      dryRun: true,
      present: () => true,
      run: fakeRunner([]),
    });
    await ctx.ensureDir(folder);
    assert.deepEqual(ctx.shown, [`mkdir ${folder}`]);
    assert.equal(existsSync(folder), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real run creates the folder and any folder above it, in a temporary folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-test-"));
  try {
    const folder = path.join(root, "state", "folder");
    const ctx = makeContext({
      projectDir: PROJECT,
      cliPath: CLI,
      packageRoot: PACKAGE,
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
    });
    await ctx.ensureDir(folder);
    assert.equal((await stat(folder)).isDirectory(), true);
    assert.deepEqual(ctx.shown, [`mkdir ${folder}`]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a dry run of removeDirIfEmpty lists the removal, and removes no folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-test-"));
  try {
    const folder = path.join(root, "empty");
    await mkdir(folder);
    const ctx = makeContext({
      projectDir: PROJECT,
      cliPath: CLI,
      packageRoot: PACKAGE,
      dryRun: true,
      present: () => true,
      run: fakeRunner([]),
    });
    await ctx.removeDirIfEmpty(folder);
    assert.deepEqual(ctx.shown, [`remove empty folder ${folder}`]);
    assert.equal((await stat(folder)).isDirectory(), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a real run of removeDirIfEmpty removes an empty folder, keeps a folder that holds a file, and ignores a folder that is not there", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-test-"));
  try {
    const empty = path.join(root, "empty");
    const full = path.join(root, "full");
    const missing = path.join(root, "missing");
    await mkdir(empty);
    await mkdir(full);
    await writeFile(path.join(full, "note.txt"), "kept");
    const ctx = makeContext({
      projectDir: PROJECT,
      cliPath: CLI,
      packageRoot: PACKAGE,
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
    });
    await ctx.removeDirIfEmpty(empty);
    await ctx.removeDirIfEmpty(full);
    await ctx.removeDirIfEmpty(missing);
    assert.equal(existsSync(empty), false);
    assert.equal(await readFile(path.join(full, "note.txt"), "utf8"), "kept");
    assert.deepEqual(ctx.shown, [
      `remove empty folder ${empty}`,
      `remove empty folder ${full}`,
      `remove empty folder ${missing}`,
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removeDirIfEmpty throws any other error, and a path with a NUL byte gives one on every system", async () => {
  const ctx = makeContext({
    projectDir: PROJECT,
    cliPath: CLI,
    packageRoot: PACKAGE,
    dryRun: false,
    present: () => true,
    run: fakeRunner([]),
  });
  // Node refuses a path with a NUL byte before it asks the system, with a code that is none of the ignored codes.
  const unusable = `${PROJECT}${String.fromCharCode(0)}folder`;
  await assert.rejects(ctx.removeDirIfEmpty(unusable), (error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT";
  });
});
