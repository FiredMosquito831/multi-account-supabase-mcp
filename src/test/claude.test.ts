import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeAdapter } from "../agents/claude.js";
import type { CommandOptions, CommandResult, Runner } from "../agents/command.js";
import { runPlan } from "../agents/plan.js";
import type { Scope } from "../agents/scopes.js";
import { recordedItems, scopeKey, statePath } from "../agents/state.js";
import { type Context, type FileOps, type Step, makeContext } from "../agents/types.js";

const DATA_ENV = "MULTI_ACCOUNT_SUPABASE_HOME";
const SOURCE = "FiredMosquito831/multi-account-supabase-mcp";
const PLUGIN_ID = "multi-account-supabase@multi-account-supabase-mcp";
const OK: CommandResult = { code: 0, stdout: "", stderr: "" };
const NOT_INSTALLED = "not installed in this scope";
const NOT_ON_PATH = "claude is not on PATH, so nothing was removed in this scope.";

// Each scope of this tool, with the scope name that Claude Code uses for it.
const CLI_SCOPES: [Scope, string][] = [
  ["global", "user"],
  ["project", "project"],
  ["local", "local"],
];

// Each test gets a temporary root. The data folder variable points into it, so the state file never reaches the owner's
// data folder. The variable is restored and the root is removed afterwards.
const inTemporaryRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-test-"));
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

const projectIn = (root: string): string => path.join(root, "project");

// A fake command runner. It logs each command line and answers as the test says, so no claude command runs.
const fakeRunner =
  (effects: string[], answer: (args: readonly string[]) => CommandResult = () => OK): Runner =>
  async (command, args): Promise<CommandResult> => {
    effects.push(`run ${[command, ...args].join(" ")}`);
    return answer(args);
  };

// A fake command runner that records the options of each call, so a test can see the folder each command runs in.
const folderRecorder =
  (seen: (CommandOptions | undefined)[]): Runner =>
  async (_command, _args, options): Promise<CommandResult> => {
    seen.push(options);
    return OK;
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
    cliPath: path.join(root, "package", "dist", "cli.js"),
    packageRoot: path.join(root, "package"),
    dryRun: false,
    present: () => options.present ?? true,
    run: options.run ?? fakeRunner([]),
  });

test("the adapter is claude, has the three scopes, and asks the system for the claude command", () => {
  assert.equal(claudeAdapter.id, "claude");
  assert.deepEqual([...claudeAdapter.scopes], ["global", "project", "local"]);
  const asked: string[] = [];
  const ctx = makeContext({
    projectDir: path.resolve("fake-project"),
    cliPath: path.resolve("fake-package", "dist", "cli.js"),
    packageRoot: path.resolve("fake-package"),
    dryRun: true,
    present: (name) => {
      asked.push(name);
      return name === "claude";
    },
    run: fakeRunner([]),
  });
  assert.equal(claudeAdapter.present(ctx), true);
  assert.deepEqual(asked, ["claude"]);
});

test("install in each scope runs the marketplace add, then the plugin install with the mapped scope and -y, and records an mcp-entry in that scope", () =>
  inTemporaryRoot(async (root) => {
    for (const [scope, cliScope] of CLI_SCOPES) {
      const effects: string[] = [];
      const steps = await claudeAdapter.install(contextIn(root, { run: fakeRunner(effects) }), scope);
      assert.deepEqual(effects, [
        `run claude plugin marketplace add ${SOURCE}`,
        `run claude plugin install ${PLUGIN_ID} --scope ${cliScope} -y`,
      ]);
      assert.deepEqual(
        steps.map((step) => [step.agent, step.scope, step.status]),
        [["claude", scope, "ok"]],
      );
      assert.match(steps[0].message, /claude plugin install/);
      assert.deepEqual(await recordedItems("claude", scopeKey(scope, projectIn(root))), [
        { kind: "mcp-entry", name: PLUGIN_ID },
      ]);
    }
  }));

test("a failed marketplace add does not stop the install: when the install then succeeds, install gives an ok step and records the item", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const failingAdd = fakeRunner(effects, (args) =>
      args[1] === "marketplace" ? { code: 1, stdout: "", stderr: "marketplace already added\n" } : OK,
    );
    const steps = await claudeAdapter.install(contextIn(root, { run: failingAdd }), "global");
    assert.deepEqual(effects, [
      `run claude plugin marketplace add ${SOURCE}`,
      `run claude plugin install ${PLUGIN_ID} --scope user -y`,
    ]);
    assert.deepEqual(
      steps.map((step) => [step.agent, step.scope, step.status]),
      [["claude", "global", "ok"]],
    );
    assert.deepEqual(await recordedItems("claude", "global"), [{ kind: "mcp-entry", name: PLUGIN_ID }]);
  }));

test("when the marketplace add and the install both fail, install gives an error step with both messages, the marketplace add first, and records nothing", () =>
  inTemporaryRoot(async (root) => {
    const cases: [CommandResult, string][] = [
      [{ code: 1, stdout: "", stderr: "  marketplace unreachable\n" }, "marketplace unreachable"],
      [{ code: 2, stdout: "  refused\n", stderr: " \n" }, "refused"],
      [{ code: 3, stdout: " ", stderr: "" }, "exit 3"],
    ];
    for (const [added, addedMessage] of cases) {
      const effects: string[] = [];
      const failing = fakeRunner(effects, (args) => {
        if (args[1] === "marketplace") {
          return added;
        }
        return args[1] === "install" ? { code: 1, stdout: "", stderr: "plugin not found in marketplace\n" } : OK;
      });
      const steps = await claudeAdapter.install(contextIn(root, { run: failing }), "global");
      assert.deepEqual(effects, [
        `run claude plugin marketplace add ${SOURCE}`,
        `run claude plugin install ${PLUGIN_ID} --scope user -y`,
      ]);
      assert.deepEqual(
        steps.map((step) => [step.agent, step.scope, step.status, step.message]),
        [["claude", "global", "error", `${addedMessage}\nplugin not found in marketplace`]],
      );
      assert.deepEqual(await recordedItems("claude", "global"), []);
    }
  }));

test("when the plugin install fails, install gives an error step with its output, and records nothing", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const failingInstall = fakeRunner(effects, (args) =>
      args[1] === "install" ? { code: 1, stdout: "", stderr: "plugin not found in marketplace\n" } : OK,
    );
    const steps = await claudeAdapter.install(contextIn(root, { run: failingInstall }), "project");
    assert.deepEqual(effects, [
      `run claude plugin marketplace add ${SOURCE}`,
      `run claude plugin install ${PLUGIN_ID} --scope project -y`,
    ]);
    assert.deepEqual(
      steps.map((step) => [step.scope, step.status, step.message]),
      [["project", "error", "plugin not found in marketplace"]],
    );
    assert.deepEqual(await recordedItems("claude", scopeKey("project", projectIn(root))), []);
  }));

test("uninstall with claude present runs claude plugin uninstall with the mapped scope, and forgets only that scope", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "local");
    const effects: string[] = [];
    const steps = await claudeAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, [`run claude plugin uninstall ${PLUGIN_ID} --scope user`]);
    assert.deepEqual(
      steps.map((step) => [step.agent, step.scope, step.status]),
      [["claude", "global", "ok"]],
    );
    assert.deepEqual(await recordedItems("claude", scopeKey("global", projectIn(root))), []);
    assert.deepEqual(await recordedItems("claude", scopeKey("local", projectIn(root))), [
      { kind: "mcp-entry", name: PLUGIN_ID },
    ]);
  }));

test("uninstall whose output reports that the plugin is not installed is skipped as not installed in this scope, and forgets the scope", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const reported = fakeRunner([], (args) =>
      args[1] === "uninstall"
        ? { code: 1, stdout: "", stderr: `Plugin "${PLUGIN_ID}" is not installed in user scope\n` }
        : OK,
    );
    const steps = await claudeAdapter.uninstall(contextIn(root, { run: reported }), "global");
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["skipped", NOT_INSTALLED]],
    );
    assert.deepEqual(await recordedItems("claude", "global"), []);
  }));

test("uninstall that fails for another reason keeps the record, and returns an error step with the first non-empty line of its output", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const failures: [CommandResult, string][] = [
      [{ code: 1, stdout: "", stderr: "  permission denied\n  more detail\n" }, "permission denied"],
      // A "not found" that does not name the plugin is about something else, so the record stays.
      [{ code: 1, stdout: "", stderr: "settings file not found\n" }, "settings file not found"],
      // With no error output, the first line of the standard output is the message.
      [{ code: 1, stdout: "\n  network down\n", stderr: " \n" }, "network down"],
      // With no output at all, the exit code is the message.
      [{ code: 4, stdout: " ", stderr: "" }, "exit 4"],
    ];
    for (const [result, message] of failures) {
      const effects: string[] = [];
      const steps = await claudeAdapter.uninstall(
        contextIn(root, { run: fakeRunner(effects, () => result) }),
        "global",
      );
      assert.deepEqual(effects, [`run claude plugin uninstall ${PLUGIN_ID} --scope user`]);
      assert.deepEqual(
        steps.map((step) => [step.agent, step.scope, step.status, step.message]),
        [["claude", "global", "error", message]],
      );
      assert.deepEqual(await recordedItems("claude", "global"), [{ kind: "mcp-entry", name: PLUGIN_ID }]);
    }
  }));

test("uninstall with claude absent runs nothing, keeps the record, and says claude is not on PATH", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const steps = await claudeAdapter.uninstall(
      contextIn(root, { present: false, run: fakeRunner(effects) }),
      "global",
    );
    assert.deepEqual(effects, []);
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["skipped", NOT_ON_PATH]],
    );
    assert.deepEqual(await recordedItems("claude", "global"), [{ kind: "mcp-entry", name: PLUGIN_ID }]);
  }));

test("update of a scope with nothing recorded does nothing: a skipped step in each scope, and no command runs", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    for (const [scope] of CLI_SCOPES) {
      const steps = await claudeAdapter.update(contextIn(root, { run: fakeRunner(effects) }), scope);
      assert.deepEqual(
        steps.map((step) => [step.scope, step.status, step.message]),
        [[scope, "skipped", NOT_INSTALLED]],
      );
    }
    assert.deepEqual(effects, []);
    assert.equal(existsSync(statePath("claude")), false);
  }));

test("update of a recorded scope runs claude plugin update with the mapped scope and -y, and keeps the record", () =>
  inTemporaryRoot(async (root) => {
    for (const [scope, cliScope] of CLI_SCOPES) {
      await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), scope);
      const effects: string[] = [];
      const steps = await claudeAdapter.update(contextIn(root, { run: fakeRunner(effects) }), scope);
      assert.deepEqual(effects, [`run claude plugin update ${PLUGIN_ID} --scope ${cliScope} -y`]);
      assert.deepEqual(
        steps.map((step) => [step.scope, step.status]),
        [[scope, "ok"]],
      );
      assert.deepEqual(await recordedItems("claude", scopeKey(scope, projectIn(root))), [
        { kind: "mcp-entry", name: PLUGIN_ID },
      ]);
    }
  }));

test("update whose claude plugin update fails gives an error step with its output, and keeps the record", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const failing = fakeRunner([], (args) =>
      args[1] === "update" ? { code: 4, stdout: "", stderr: "network error\n" } : OK,
    );
    const steps = await claudeAdapter.update(contextIn(root, { run: failing }), "global");
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["error", "network error"]],
    );
    assert.deepEqual(await recordedItems("claude", "global"), [{ kind: "mcp-entry", name: PLUGIN_ID }]);
  }));

test("doctor is ok when the plugin id is in the claude plugin list output, skipped when it is not, and runs nothing when claude is absent", () =>
  inTemporaryRoot(async (root) => {
    // The doctor checks a scope only when the plugin is recorded there, so the global scope is recorded first.
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const listing = (result: CommandResult, effects: string[], present = true): Promise<Step[]> =>
      claudeAdapter.doctor(
        contextIn(root, { present, run: fakeRunner(effects, (args) => (args[1] === "list" ? result : OK)) }),
      );
    const listed: [CommandResult, string][] = [
      [{ code: 0, stdout: `[{"id":"${PLUGIN_ID}","version":"0.1.0"}]`, stderr: "" }, "ok"],
      [{ code: 0, stdout: '[{"id":"other-plugin@somewhere"}]', stderr: "" }, "skipped"],
      // The same plugin name from another marketplace is a different plugin id.
      [{ code: 0, stdout: "multi-account-supabase@other-marketplace", stderr: "" }, "skipped"],
      // A listing that fails does not count as found, even when its output names the plugin.
      [{ code: 1, stdout: PLUGIN_ID, stderr: "" }, "skipped"],
    ];
    for (const [result, status] of listed) {
      const effects: string[] = [];
      const steps = await listing(result, effects);
      assert.deepEqual(effects, ["run claude plugin list --json"]);
      assert.equal(steps[0].status, status);
    }
    const absent: string[] = [];
    const steps = await listing({ code: 0, stdout: PLUGIN_ID, stderr: "" }, absent, false);
    assert.deepEqual(absent, []);
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["skipped", "claude is not on PATH."]],
    );
  }));

test("the doctor lists in the project folder when the plugin is recorded in the project scope, and reports that scope", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "project");
    const seen: (CommandOptions | undefined)[] = [];
    const listing: Runner = async (_command, _args, options): Promise<CommandResult> => {
      seen.push(options);
      return { code: 0, stdout: `[{"id":"${PLUGIN_ID}"}]`, stderr: "" };
    };
    const steps = await claudeAdapter.doctor(contextIn(root, { run: listing }));
    assert.deepEqual(seen, [{ cwd: projectIn(root) }]);
    assert.deepEqual(
      steps.map((step) => [step.scope, step.status]),
      [["project", "ok"]],
    );
  }));

test("the doctor gives each recorded scope its own step, named by scope, and no step to a scope with no record", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "local");
    const seen: (CommandOptions | undefined)[] = [];
    // The global scope's listing names the plugin, and the local scope's listing does not.
    const listing: Runner = async (_command, _args, options): Promise<CommandResult> => {
      seen.push(options);
      return { code: 0, stdout: options === undefined ? `[{"id":"${PLUGIN_ID}"}]` : "[]", stderr: "" };
    };
    const steps = await claudeAdapter.doctor(contextIn(root, { run: listing }));
    // The project scope has no record, so it is not listed and gets no step.
    assert.deepEqual(seen, [undefined, { cwd: projectIn(root) }]);
    assert.deepEqual(steps.map((step) => [step.scope, step.status]), [
      ["global", "ok"],
      ["local", "skipped"],
    ]);
    assert.match(steps[0].message, /global scope/);
    assert.match(steps[1].message, /local scope/);
  }));

test("a listing that fails gives the recorded scope a skipped step that names the scope", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "project");
    const failing = fakeRunner([], () => ({ code: 1, stdout: PLUGIN_ID, stderr: "" }));
    const steps = await claudeAdapter.doctor(contextIn(root, { run: failing }));
    assert.deepEqual(
      steps.map((step) => [step.scope, step.status, step.message]),
      [["project", "skipped", "claude plugin list failed in the project scope, so the plugin was not checked."]],
    );
  }));

test("the doctor gives no step, and runs no listing, when the plugin is recorded in no scope", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await claudeAdapter.doctor(contextIn(root, { run: fakeRunner(effects) }));
    assert.deepEqual(steps, []);
    assert.deepEqual(effects, []);
  }));

test("a dry run through the planner changes no state, runs no command, and lists each command in order", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const dryContext = (): Context =>
      makeContext({
        projectDir: projectIn(root),
        cliPath: path.join(root, "package", "dist", "cli.js"),
        packageRoot: path.join(root, "package"),
        dryRun: true,
        present: () => true,
        run: fakeRunner(effects),
        fs: fakeFiles(effects),
      });
    const installed = await runPlan({
      adapters: [claudeAdapter],
      action: "install",
      agents: ["claude"],
      ctx: dryContext(),
    });
    assert.deepEqual(
      installed.steps.map((step) => step.status),
      ["ok"],
    );
    assert.deepEqual(installed.shown, [
      `claude plugin marketplace add ${SOURCE}`,
      `claude plugin install ${PLUGIN_ID} --scope user -y`,
    ]);
    assert.equal(existsSync(statePath("claude")), false);

    // A real install records the entry. The dry-run update and uninstall list their commands and keep the record.
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const updated = await runPlan({
      adapters: [claudeAdapter],
      action: "update",
      agents: ["claude"],
      ctx: dryContext(),
    });
    assert.deepEqual(updated.shown, [`claude plugin update ${PLUGIN_ID} --scope user -y`]);
    const removed = await runPlan({
      adapters: [claudeAdapter],
      action: "uninstall",
      agents: ["claude"],
      ctx: dryContext(),
    });
    assert.deepEqual(removed.shown, [`claude plugin uninstall ${PLUGIN_ID} --scope user`]);
    assert.deepEqual(effects, []);
    assert.deepEqual(await recordedItems("claude", "global"), [{ kind: "mcp-entry", name: PLUGIN_ID }]);
  }));

test("the project and local scopes keep separate records, so removing the local one leaves the project one", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "project");
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "local");
    assert.notEqual(scopeKey("project", projectIn(root)), scopeKey("local", projectIn(root)));
    await claudeAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "local");
    assert.deepEqual(await recordedItems("claude", scopeKey("project", projectIn(root))), [
      { kind: "mcp-entry", name: PLUGIN_ID },
    ]);
    assert.deepEqual(await recordedItems("claude", scopeKey("local", projectIn(root))), []);
  }));

test("the project and local commands run in the project folder, and the user commands run without a folder", () =>
  inTemporaryRoot(async (root) => {
    for (const [scope] of CLI_SCOPES) {
      const expected = scope === "global" ? undefined : { cwd: projectIn(root) };
      const seen: (CommandOptions | undefined)[] = [];
      // Install runs two commands, the marketplace add and the install. Update and uninstall run one command each.
      await claudeAdapter.install(contextIn(root, { run: folderRecorder(seen) }), scope);
      await claudeAdapter.update(contextIn(root, { run: folderRecorder(seen) }), scope);
      await claudeAdapter.uninstall(contextIn(root, { run: folderRecorder(seen) }), scope);
      assert.deepEqual(seen, [expected, expected, expected, expected]);
    }
  }));

test("a dry run of a project install lists the project folder before each command that runs there", () =>
  inTemporaryRoot(async (root) => {
    const dry = makeContext({
      projectDir: projectIn(root),
      cliPath: path.join(root, "package", "dist", "cli.js"),
      packageRoot: path.join(root, "package"),
      dryRun: true,
      present: () => true,
      run: fakeRunner([]),
    });
    const planned = await runPlan({
      adapters: [claudeAdapter],
      action: "install",
      scope: "project",
      agents: ["claude"],
      ctx: dry,
    });
    assert.deepEqual(planned.shown, [
      `cwd ${projectIn(root)}`,
      `claude plugin marketplace add ${SOURCE}`,
      `cwd ${projectIn(root)}`,
      `claude plugin install ${PLUGIN_ID} --scope project -y`,
    ]);
  }));
