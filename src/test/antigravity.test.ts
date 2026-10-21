import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { antigravityAdapter } from "../agents/antigravity.js";
import type { CommandResult, Runner } from "../agents/command.js";
import { runPlan } from "../agents/plan.js";
import { recordedItems, statePath } from "../agents/state.js";
import { type Context, type FileOps, UnsupportedScope, makeContext } from "../agents/types.js";

const DATA_ENV = "MULTI_ACCOUNT_SUPABASE_HOME";
const NAME = "multi-account-supabase";
const OK: CommandResult = { code: 0, stdout: "", stderr: "" };
const SCOPE_MESSAGE = "antigravity has no local scope, and no project scope. Use global.";

// Each test gets a temporary root. The data folder variable points into the root, so the state file of the agent never
// reaches the owner's data folder. The variable is restored and the root is removed afterwards.
const inTemporaryRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
  const previous = process.env[DATA_ENV];
  process.env[DATA_ENV] = path.join(root, "data");
  try {
    await run(root);
  } finally {
    if (previous === undefined) {
      delete process.env[DATA_ENV];
    } else {
      process.env[DATA_ENV] = previous;
    }
    await rm(root, { recursive: true, force: true });
  }
};

// The paths inside a root. The program file need not exist, because the adapter only passes its path on.
const projectIn = (root: string): string => path.join(root, "project");
const programIn = (root: string): string => path.join(root, "package", "dist", "cli.js");

// Paths for the tests that never touch the disk. The fake file functions log each call and write nothing.
const PROJECT = path.resolve("fake-project");
const PACKAGE = path.resolve("fake-package");
const PROGRAM = path.join(PACKAGE, "dist", "cli.js");

// A fake command runner. It logs each command line and answers as the test says, so no agy command runs.
const fakeRunner =
  (effects: string[], answer: (args: readonly string[]) => CommandResult = () => OK): Runner =>
  async (command, args): Promise<CommandResult> => {
    effects.push(`run ${[command, ...args].join(" ")}`);
    return answer(args);
  };

// Fake file functions for the dry run. Each call is logged, so a call that reached the disk would show up.
const fakeFiles = (effects: string[]): FileOps => ({
  writeFile: async (file) => {
    effects.push(`write ${file}`);
  },
  removeFile: async (file) => {
    effects.push(`remove ${file}`);
  },
  ensureDir: async (dir) => {
    effects.push(`mkdir ${dir}`);
  },
  removeDirIfEmpty: async (dir) => {
    effects.push(`rmdir ${dir}`);
  },
});

// A context for a real run in the temporary folders. Only the command runner and the presence check are replaced.
const contextIn = (root: string, options: { present?: boolean; run?: Runner } = {}): Context =>
  makeContext({
    projectDir: projectIn(root),
    cliPath: programIn(root),
    packageRoot: path.join(root, "package"),
    dryRun: false,
    present: () => options.present ?? true,
    run: options.run ?? fakeRunner([]),
  });

// How a dry run shows an argument: quoted when it has a space or a double quote, as the context does.
const quoteLike = (part: string): string => (/[\s"]/.test(part) ? `"${part}"` : part);

test("the adapter is antigravity, has the global scope only, and asks the system for the agy command", () => {
  assert.equal(antigravityAdapter.id, "antigravity");
  assert.deepEqual([...antigravityAdapter.scopes], ["global"]);
  const asked: string[] = [];
  const ctx = makeContext({
    projectDir: PROJECT,
    cliPath: PROGRAM,
    packageRoot: PACKAGE,
    dryRun: true,
    present: (name) => {
      asked.push(name);
      return name === "agy";
    },
    run: fakeRunner([]),
  });
  assert.equal(antigravityAdapter.present(ctx), true);
  assert.deepEqual(asked, ["agy"]);
});

test("global install runs agy mcp remove, then agy mcp add with the entry, and records an mcp-entry", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await antigravityAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, [
      `run agy mcp remove ${NAME}`,
      `run agy mcp add ${NAME} ${process.execPath} ${programIn(root)} serve`,
    ]);
    assert.deepEqual(
      steps.map((step) => [step.agent, step.scope, step.status]),
      [["antigravity", "global", "ok"]],
    );
    assert.match(steps[0].message, /agy mcp add/);
    assert.deepEqual(await recordedItems("antigravity", "global"), [{ kind: "mcp-entry", name: NAME }]);
  }));

test("a failed agy mcp add gives an error step with its first output, or its exit code, and records nothing", () =>
  inTemporaryRoot(async (root) => {
    const failingAdd = (result: CommandResult): Runner => fakeRunner([], (args) => (args[1] === "add" ? result : OK));
    const withStderr = await antigravityAdapter.install(
      contextIn(root, { run: failingAdd({ code: 2, stdout: "", stderr: "  unknown flag\n" }) }),
      "global",
    );
    const withStdout = await antigravityAdapter.install(
      contextIn(root, { run: failingAdd({ code: 2, stdout: "  wrote nothing\n", stderr: " \n" }) }),
      "global",
    );
    const silent = await antigravityAdapter.install(
      contextIn(root, { run: failingAdd({ code: 3, stdout: " ", stderr: "" }) }),
      "global",
    );
    assert.deepEqual(
      [withStderr, withStdout, silent].map((steps) => [steps[0].status, steps[0].message]),
      [
        ["error", "unknown flag"],
        ["error", "wrote nothing"],
        ["error", "exit 3"],
      ],
    );
    assert.deepEqual(await recordedItems("antigravity", "global"), []);
  }));

test("uninstall with agy present runs agy mcp remove and forgets the global scope", () =>
  inTemporaryRoot(async (root) => {
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const steps = await antigravityAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, [`run agy mcp remove ${NAME}`]);
    assert.deepEqual(
      steps.map((step) => [step.agent, step.scope, step.status]),
      [["antigravity", "global", "ok"]],
    );
    assert.deepEqual(await recordedItems("antigravity", "global"), []);
    assert.equal(existsSync(statePath("antigravity")), false);
  }));

test("uninstall whose agy mcp remove reports that the server is not installed is skipped as not installed globally, and forgets the scope", () =>
  inTemporaryRoot(async (root) => {
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const notInstalled = fakeRunner([], (args) =>
      args[1] === "remove" ? { code: 1, stdout: "", stderr: `MCP server "${NAME}" not found\n` } : OK,
    );
    const steps = await antigravityAdapter.uninstall(contextIn(root, { run: notInstalled }), "global");
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["skipped", "not installed globally"]],
    );
    assert.deepEqual(await recordedItems("antigravity", "global"), []);
  }));

test("uninstall whose agy mcp remove fails for another reason keeps the record, and returns an error step with the first line of its output", () =>
  inTemporaryRoot(async (root) => {
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const failures: [CommandResult, string][] = [
      [
        { code: 1, stdout: "", stderr: "agy: cannot write its settings file\n  more detail\n" },
        "agy: cannot write its settings file",
      ],
      // A "not found" that does not name this server is about something else, such as a settings file.
      [{ code: 1, stdout: "", stderr: "agy: settings file not found\n" }, "agy: settings file not found"],
      // The server is named, but nothing says that it is absent.
      [
        { code: 1, stdout: "agy could not update multi-account-supabase\n", stderr: "" },
        "agy could not update multi-account-supabase",
      ],
      // With no output at all, the exit code is the message.
      [{ code: 4, stdout: "", stderr: " \n" }, "exit 4"],
    ];
    for (const [result, message] of failures) {
      const effects: string[] = [];
      const steps = await antigravityAdapter.uninstall(
        contextIn(root, { run: fakeRunner(effects, () => result) }),
        "global",
      );
      assert.deepEqual(effects, [`run agy mcp remove ${NAME}`]);
      assert.deepEqual(
        steps.map((step) => [step.agent, step.scope, step.status, step.message]),
        [["antigravity", "global", "error", message]],
      );
      assert.deepEqual(await recordedItems("antigravity", "global"), [{ kind: "mcp-entry", name: NAME }]);
    }
    // The record is still there, so a later uninstall can remove the entry.
    const later = await antigravityAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global");
    assert.equal(later[0].status, "ok");
    assert.deepEqual(await recordedItems("antigravity", "global"), []);
  }));

test("uninstall with agy absent runs nothing, keeps the record, and says agy is not on PATH", () =>
  inTemporaryRoot(async (root) => {
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const steps = await antigravityAdapter.uninstall(
      contextIn(root, { present: false, run: fakeRunner(effects) }),
      "global",
    );
    assert.deepEqual(effects, []);
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["skipped", "agy is not on PATH, so nothing was removed globally."]],
    );
    assert.deepEqual(await recordedItems("antigravity", "global"), [{ kind: "mcp-entry", name: NAME }]);
  }));

test("update of a global scope with nothing recorded does nothing: a skipped step, and no command runs", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await antigravityAdapter.update(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, []);
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["skipped", "not installed in this scope"]],
    );
    assert.equal(existsSync(statePath("antigravity")), false);
  }));

test("update of a recorded global scope runs the install again and keeps the record", () =>
  inTemporaryRoot(async (root) => {
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const steps = await antigravityAdapter.update(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, [
      `run agy mcp remove ${NAME}`,
      `run agy mcp add ${NAME} ${process.execPath} ${programIn(root)} serve`,
    ]);
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(await recordedItems("antigravity", "global"), [{ kind: "mcp-entry", name: NAME }]);
  }));

test("doctor is ok when agy mcp list names the server as one word, skipped when it does not, and runs nothing when agy is absent", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const doctor = async (stdout: string, present = true): Promise<string> => {
      const listing = fakeRunner(effects, (args) => (args[1] === "list" ? { code: 0, stdout, stderr: "" } : OK));
      const steps = await antigravityAdapter.doctor(contextIn(root, { present, run: listing }));
      return steps[0].status;
    };
    assert.equal(await doctor(`Name  Command\n${NAME}  node\n`), "ok");
    assert.equal(await doctor(`│ ${NAME} │ node │\n`), "ok");
    assert.equal(await doctor("other-server  node\n"), "skipped");
    assert.equal(await doctor(`${NAME}-mcp  node\n`), "skipped");
    assert.equal(await doctor(NAME, false), "skipped");
    assert.deepEqual(effects, ["run agy mcp list", "run agy mcp list", "run agy mcp list", "run agy mcp list"]);
  }));

test("the project and local scopes are refused with the adapter's message by install, update and uninstall, and no command runs", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const ctx = contextIn(root, { run: fakeRunner(effects) });
    const actions = [antigravityAdapter.install, antigravityAdapter.update, antigravityAdapter.uninstall];
    for (const scope of ["project", "local"] as const) {
      for (const action of actions) {
        await assert.rejects(
          action(ctx, scope),
          (error: unknown) => error instanceof UnsupportedScope && error.message === SCOPE_MESSAGE,
        );
      }
    }
    assert.deepEqual(effects, []);
  }));

test("a dry run through the planner changes no file, runs no command and writes no state, and lists each command in order", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const dryContext = (): Context =>
      makeContext({
        projectDir: projectIn(root),
        cliPath: programIn(root),
        packageRoot: path.join(root, "package"),
        dryRun: true,
        present: () => true,
        run: fakeRunner(effects),
        fs: fakeFiles(effects),
      });
    const installed = await runPlan({
      adapters: [antigravityAdapter],
      action: "install",
      agents: ["antigravity"],
      ctx: dryContext(),
    });
    assert.deepEqual(
      installed.steps.map((step) => step.status),
      ["ok"],
    );
    assert.deepEqual(installed.shown, [
      `agy mcp remove ${NAME}`,
      `agy mcp add ${NAME} ${quoteLike(process.execPath)} ${quoteLike(programIn(root))} serve`,
    ]);
    assert.equal(existsSync(statePath("antigravity")), false);

    // A real install records the entry. A dry-run uninstall then lists its command and keeps the record.
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const removed = await runPlan({
      adapters: [antigravityAdapter],
      action: "uninstall",
      agents: ["antigravity"],
      ctx: dryContext(),
    });
    assert.deepEqual(
      removed.steps.map((step) => step.status),
      ["ok"],
    );
    assert.deepEqual(removed.shown, [`agy mcp remove ${NAME}`]);
    assert.deepEqual(effects, []);
    assert.deepEqual(await recordedItems("antigravity", "global"), [{ kind: "mcp-entry", name: NAME }]);
  }));
