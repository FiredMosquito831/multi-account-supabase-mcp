import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandOptions, CommandResult, Runner } from "../agents/command.js";
import { runPlan } from "../agents/plan.js";
import type { Scope } from "../agents/scopes.js";
import type { AgentId } from "../agents/state.js";
import {
  type AgentAdapter,
  type Context,
  type FileOps,
  type Step,
  PlanRefused,
  makeContext,
} from "../agents/types.js";

// These paths are only text. The fake file functions never touch the disk, so the paths need not exist.
const PROJECT = path.resolve("fake-project");
const PACKAGE = path.resolve("fake-package");
const CLI = path.join(PACKAGE, "dist", "cli.js");
const CONFIG = path.join(PROJECT, ".mcp.json");
const OLD = path.join(PROJECT, "old.json");

// Each name here points at the owner's files, agent configurations or data folder when no test changes it. While this
// file's tests run, each one is set to a folder under a temporary folder, and the values are put back afterwards.
const SANDBOX_NAMES = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "MULTI_ACCOUNT_SUPABASE_HOME",
] as const;
const saved = new Map<string, string | undefined>();
let sandbox = "";

before(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "plan-test-home-"));
  const values: Record<(typeof SANDBOX_NAMES)[number], string> = {
    HOME: sandbox,
    USERPROFILE: sandbox,
    APPDATA: path.join(sandbox, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(sandbox, "AppData", "Local"),
    CODEX_HOME: path.join(sandbox, "codex"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    MULTI_ACCOUNT_SUPABASE_HOME: path.join(sandbox, "data"),
  };
  for (const name of SANDBOX_NAMES) {
    saved.set(name, process.env[name]);
    process.env[name] = values[name];
  }
});

after(() => {
  for (const name of SANDBOX_NAMES) {
    const value = saved.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  rmSync(sandbox, { recursive: true, force: true });
});

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

// A fake adapter. Each method except doctor logs the agent, the method and the scope, and doctor logs the agent alone.
// Each method runs the action with the context, and returns one ok step. Doctor's step names the global scope.
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

test("a named agent without the scope is refused as PlanRefused, of kind unsupported-scope", async () => {
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
    (error: unknown) =>
      error instanceof PlanRefused &&
      error.kind === "unsupported-scope" &&
      error.message === "antigravity has no project scope",
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

test("an agent that is not named and lacks the scope gets one skipped line with its reason, and a named agent is still run", async () => {
  const calls: string[] = [];
  const result = await runPlan({
    adapters: [fakeAdapter("claude", ["global", "project", "local"], calls), fakeAdapter("codex", ["global", "project"], calls)],
    action: "install",
    agents: ["claude"],
    scope: "local",
    ctx: contextFor(true, []),
  });
  assert.deepEqual(result.steps, [
    { agent: "claude", scope: "local", status: "ok", message: "install done" },
    { agent: "codex", scope: "local", status: "skipped", message: "codex has no local scope" },
  ]);
  assert.deepEqual(calls, ["claude install local"]);
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
    (error: unknown) => error instanceof PlanRefused && error.kind === "unsupported-scope",
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
    dryRun: true,
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

test("a real run creates one folder whose parent exists, in a temporary folder", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-test-"));
  try {
    const folder = path.join(root, "folder");
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

test("removeDirIfEmpty removes an empty folder, keeps one with a file, and ignores a missing one", async () => {
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

test("a real run fails for a folder whose parent is missing, and creates nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-test-"));
  try {
    const folder = path.join(root, "missing", "folder");
    const ctx = makeContext({
      projectDir: PROJECT,
      cliPath: CLI,
      packageRoot: PACKAGE,
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
    });
    await assert.rejects(ctx.ensureDir(folder), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT");
    assert.equal(existsSync(path.join(root, "missing")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a folder that exists already is left as it is, and a file at the path is refused", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "plan-test-"));
  try {
    const folder = path.join(root, "folder");
    const file = path.join(root, "file");
    mkdirSync(folder);
    writeFileSync(file, "kept");
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
    await assert.rejects(ctx.ensureDir(file), (error: unknown) => error instanceof Error);
    assert.equal(await readFile(file, "utf8"), "kept");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a folder given to run() reaches the runner, and is listed before the command line", async () => {
  const seen: (CommandOptions | undefined)[] = [];
  const runner: Runner = async (_command, _args, options) => {
    seen.push(options);
    return { code: 0, stdout: "", stderr: "" };
  };
  const ctx = makeContext({
    projectDir: PROJECT,
    cliPath: CLI,
    packageRoot: PACKAGE,
    dryRun: false,
    present: () => true,
    run: runner,
    fs: fakeFiles([], new Map()),
  });
  await ctx.run("claude", ["plugin", "list"], { cwd: PROJECT });
  assert.deepEqual(seen, [{ cwd: PROJECT }]);
  assert.deepEqual(ctx.shown, [`cwd ${PROJECT}`, "claude plugin list"]);
});

test("the context gives back the environment it was given", () => {
  const env: NodeJS.ProcessEnv = { HOME: PROJECT };
  const ctx = makeContext({
    projectDir: PROJECT,
    cliPath: CLI,
    packageRoot: PACKAGE,
    dryRun: true,
    env,
    present: () => true,
    run: fakeRunner([]),
    fs: fakeFiles([], new Map()),
  });
  assert.equal(ctx.env, env);
});

test("the context reads the process environment when no environment is given", () => {
  assert.equal(contextFor(true, []).env, process.env);
});

test("an agent name that matches no agent gives an error step, and the known agents still run", async () => {
  const calls: string[] = [];
  const result = await runPlan({
    adapters: [fakeAdapter("claude", ["global"], calls), fakeAdapter("codex", ["global"], calls)],
    action: "install",
    agents: ["claude", "codx"],
    ctx: contextFor(true, []),
  });
  assert.deepEqual(result.steps, [
    { agent: "claude", scope: "global", status: "ok", message: "install done" },
    { agent: "codx", scope: "global", status: "error", message: "unknown agent; the agents are claude, codex" },
  ]);
  assert.deepEqual(calls, ["claude install global"]);
});

test("an empty list of agents gives one error step that says what to do", async () => {
  const calls: string[] = [];
  const result = await runPlan({
    adapters: [fakeAdapter("claude", ["global"], calls)],
    action: "install",
    agents: [],
    ctx: contextFor(true, []),
  });
  assert.deepEqual(result.steps, [
    { agent: "", scope: "global", status: "error", message: "name at least one agent, or leave the list out for all" },
  ]);
  assert.deepEqual(calls, []);
});

test("an unknown scope refuses the whole plan, with an error that names it", async () => {
  const calls: string[] = [];
  await assert.rejects(
    runPlan({
      adapters: [fakeAdapter("claude", ["global"], calls)],
      action: "install",
      scope: "workspace",
      ctx: contextFor(true, []),
    }),
    (error: unknown) =>
      error instanceof PlanRefused &&
      error.kind === "unknown-scope" &&
      error.message === "unknown scope workspace; the scopes are global, project and local",
  );
  assert.deepEqual(calls, []);
});

test("a name that does not look like a plain word is not repeated in an error", async () => {
  const notAWord = "1234_not_a_word";
  const calls: string[] = [];
  await assert.rejects(
    runPlan({
      adapters: [fakeAdapter("claude", ["global"], calls)],
      action: "install",
      scope: notAWord,
      ctx: contextFor(true, []),
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "unknown scope <not shown>; the scopes are global, project and local",
  );
  const result = await runPlan({
    adapters: [fakeAdapter("claude", ["global"], calls)],
    action: "install",
    agents: [notAWord],
    ctx: contextFor(true, []),
  });
  assert.deepEqual(result.steps, [
    { agent: "<not shown>", scope: "global", status: "error", message: "unknown agent; the agents are claude" },
  ]);
  assert.deepEqual(calls, []);
});

test("install is refused before any agent is called when the command line program path is not absolute", async () => {
  const calls: string[] = [];
  const ctx = makeContext({
    projectDir: PROJECT,
    cliPath: path.join("relative", "cli.js"),
    packageRoot: PACKAGE,
    dryRun: true,
    present: () => true,
    run: fakeRunner([]),
    fs: fakeFiles([], new Map()),
  });
  await assert.rejects(
    runPlan({ adapters: [fakeAdapter("claude", ["global"], calls)], action: "install", ctx }),
    (error: unknown) =>
      error instanceof PlanRefused &&
      error.kind === "relative-path" &&
      error.message === "The command line program path must be absolute, so nothing was changed.",
  );
  assert.deepEqual(calls, []);
});

test("a second run with the same context does not change the result of the first", async () => {
  const ctx = contextFor(true, []);
  const first = await runPlan({
    adapters: [
      fakeAdapter("claude", ["global"], [], async (agentCtx) => {
        await agentCtx.run("claude", ["plugin", "list"]);
      }),
    ],
    action: "install",
    agents: ["claude"],
    ctx,
  });
  await runPlan({
    adapters: [
      fakeAdapter("claude", ["global"], [], async (agentCtx) => {
        await agentCtx.run("claude", ["plugin", "update"]);
      }),
    ],
    action: "update",
    agents: ["claude"],
    ctx,
  });
  assert.deepEqual(first.shown, ["claude plugin list"]);
});

test("a command result from a dry run is marked dryRun, and a real result is not", async () => {
  const dry = await contextFor(true, []).run("codex", ["mcp", "list"]);
  assert.equal(dry.dryRun, true);
  const real = await contextFor(false, []).run("codex", ["mcp", "list"]);
  assert.equal(real.dryRun, undefined);
});

test("the tests run with the home, configuration and data folders in a temporary folder", () => {
  for (const name of SANDBOX_NAMES) {
    assert.ok(process.env[name]?.startsWith(os.tmpdir()), `${name} is not in a temporary folder`);
  }
});
