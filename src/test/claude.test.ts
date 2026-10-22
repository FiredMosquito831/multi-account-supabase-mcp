import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { claudeAdapter } from "../agents/claude.js";
import type { CommandOptions, CommandResult, Runner } from "../agents/command.js";
import { runPlan } from "../agents/plan.js";
import type { Scope } from "../agents/scopes.js";
import { type Item, recordedItems, scopeKey, statePath } from "../agents/state.js";
import { type Context, type FileOps, type Step, makeContext } from "../agents/types.js";
import { saveHooks } from "../accounts/registry.js";

const DATA_ENV = "MULTI_ACCOUNT_SUPABASE_HOME";
const SOURCE = "FiredMosquito831/multi-account-supabase-mcp";
const MARKETPLACE = "multi-account-supabase-mcp";
const PLUGIN_ID = "multi-account-supabase@multi-account-supabase-mcp";
const OK: CommandResult = { code: 0, stdout: "", stderr: "" };
const NOT_INSTALLED = "not installed in this scope";
const NOT_ON_PATH = "claude is not on PATH, so nothing was removed in this scope.";
const MARKETPLACE_NOTE =
  "The marketplace is still registered. To remove it, run: claude plugin marketplace remove multi-account-supabase-mcp --scope user";
// The marketplace add, as the command runner receives it, in one scope. The scope is always passed.
const addCommand = (cliScope: string): string => `claude plugin marketplace add ${SOURCE} --scope ${cliScope}`;
// What the record of a scope holds after a full install: the marketplace, then the plugin.
const INSTALLED_RECORD: Item[] = [
  { kind: "marketplace", name: MARKETPLACE },
  { kind: "mcp-entry", name: PLUGIN_ID },
];

// Every name that points a test at a home, configuration or data folder. Each test points all of them into its own folder.
const FOLDER_NAMES = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "XDG_CONFIG_HOME", DATA_ENV];

// Each scope of this tool, with the scope name that Claude Code uses for it.
const CLI_SCOPES: [Scope, string][] = [
  ["global", "user"],
  ["project", "project"],
  ["local", "local"],
];

// Each test gets a temporary root. Every name in FOLDER_NAMES points into it, so no test reaches the owner's homes, configuration
// or data. The names are restored, and the root is removed, afterwards.
const inTemporaryRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-test-"));
  const previous = FOLDER_NAMES.map((name): [string, string | undefined] => [name, process.env[name]]);
  for (const name of FOLDER_NAMES) {
    process.env[name] = path.join(root, name.toLowerCase());
  }
  try {
    await run(root);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await rm(root, { recursive: true, force: true });
  }
};

// Whether a folder name points into the system temporary folder. Both sides are resolved first, so a temporary folder that has
// no drive letter still matches.
const inTempFolder = (value: string | undefined): boolean =>
  value !== undefined && path.resolve(value).startsWith(path.resolve(os.tmpdir()));

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

// A context for a dry run in the temporary folders. Commands and file changes are listed, and the fakes log anything that
// reaches them.
const dryContextIn = (root: string, effects: string[], present = true): Context =>
  makeContext({
    projectDir: projectIn(root),
    cliPath: path.join(root, "package", "dist", "cli.js"),
    packageRoot: path.join(root, "package"),
    dryRun: true,
    present: () => present,
    run: fakeRunner(effects),
    fs: fakeFiles(effects),
  });

// Makes every save of the state file fail, as a broken rename does, and returns the function that puts the real save back.
// Reads still work, so only the record write fails.
const failingSaves = (): (() => void) => {
  const real = { ...saveHooks };
  Object.assign(saveHooks, {
    rename: async (): Promise<void> => {
      throw Object.assign(new Error("EIO: test error"), { code: "EIO" });
    },
  });
  return () => Object.assign(saveHooks, real);
};

// Lets the first `successes` saves of the state file through, and makes every later save fail, as a broken rename does. Reads
// still work, so only the record writes fail. Returns the function that puts the real save back.
const failingSavesAfter = (successes: number): (() => void) => {
  const real = { ...saveHooks };
  let saves = 0;
  Object.assign(saveHooks, {
    rename: async (from: string, to: string): Promise<void> => {
      saves += 1;
      if (saves > successes) {
        throw Object.assign(new Error("EIO: test error"), { code: "EIO" });
      }
      await real.rename(from, to);
    },
  });
  return () => Object.assign(saveHooks, real);
};

// The text of the claude state file, or undefined when there is no file, so a test can show that a call left the file as it was.
const stateFileText = async (): Promise<string | undefined> =>
  existsSync(statePath("claude")) ? await readFile(statePath("claude"), "utf8") : undefined;

// A scope with nothing recorded in it. Uninstall gives one skipped step, runs no command, lists no command, and leaves the state
// file as it was, whether the file exists or not. The options say whether claude is present, whether this is a dry run, and the
// reason the step gives. In a dry run the effects list is always empty, because makeContext returns before it calls the runner or
// the file functions. The guard for a dry run is the shown list, which the helper checks too.
const expectSkipNoCommandAndUnchangedState = async (
  root: string,
  scope: Scope,
  options: { present?: boolean; dry?: boolean; message?: string } = {},
): Promise<void> => {
  const { present = true, dry = false, message = NOT_INSTALLED } = options;
  const before = await stateFileText();
  const effects: string[] = [];
  const ctx = dry ? dryContextIn(root, effects, present) : contextIn(root, { present, run: fakeRunner(effects) });
  const steps = await claudeAdapter.uninstall(ctx, scope);
  assert.deepEqual(
    steps.map((step) => [step.scope, step.status, step.message]),
    [[scope, "skipped", message]],
  );
  assert.deepEqual(effects, [], scope);
  assert.deepEqual(ctx.shown, [], scope);
  assert.equal(await stateFileText(), before, scope);
};

test("the adapter is claude, has the three scopes, and asks the system for the claude command", () =>
  inTemporaryRoot(async () => {
    // Every name must point into a temporary folder, so this test is isolated like the others.
    for (const name of FOLDER_NAMES) {
      assert.equal(inTempFolder(process.env[name]), true, name);
    }
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
  }));

test("install in each scope runs the marketplace add, then the plugin install with the mapped scope and -y, and records the marketplace and the plugin in that scope", () =>
  inTemporaryRoot(async (root) => {
    for (const [scope, cliScope] of CLI_SCOPES) {
      const effects: string[] = [];
      const steps = await claudeAdapter.install(contextIn(root, { run: fakeRunner(effects) }), scope);
      assert.deepEqual(effects, [
        `run ${addCommand(cliScope)}`,
        `run claude plugin install ${PLUGIN_ID} --scope ${cliScope} -y`,
      ]);
      assert.deepEqual(
        steps.map((step) => [step.agent, step.scope, step.status]),
        [["claude", scope, "ok"]],
      );
      assert.match(steps[0].message, /claude plugin install/);
      assert.deepEqual(await recordedItems("claude", scopeKey(scope, projectIn(root))), INSTALLED_RECORD);
    }
  }));

test("a failed marketplace add does not stop the install: when the install then succeeds, install gives an ok step and records the plugin", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const failingAdd = fakeRunner(effects, (args) =>
      args[1] === "marketplace" ? { code: 1, stdout: "", stderr: "marketplace already added\n" } : OK,
    );
    const steps = await claudeAdapter.install(contextIn(root, { run: failingAdd }), "global");
    assert.deepEqual(effects, [
      `run ${addCommand("user")}`,
      `run claude plugin install ${PLUGIN_ID} --scope user -y`,
    ]);
    assert.deepEqual(
      steps.map((step) => [step.agent, step.scope, step.status]),
      [["claude", "global", "ok"]],
    );
    // The add failed, so this scope gets no marketplace record. The plugin is recorded.
    assert.deepEqual(await recordedItems("claude", "global"), [{ kind: "mcp-entry", name: PLUGIN_ID }]);
  }));

test("when the marketplace add and the install both fail, install gives an error step with both messages, the marketplace add first, and records nothing", () =>
  inTemporaryRoot(async (root) => {
    const cases: [CommandResult, string][] = [
      [{ code: 1, stdout: "", stderr: "  marketplace unreachable\n" }, "marketplace unreachable"],
      [{ code: 2, stdout: "  refused\n", stderr: " \n" }, "refused"],
      [{ code: 3, stdout: " ", stderr: "" }, "exit 3"],
      // With both streams non-empty, the message is the first line of the error output.
      [{ code: 4, stdout: "standard text\n", stderr: "error text\nmore detail\n" }, "error text"],
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
        `run ${addCommand("user")}`,
        `run claude plugin install ${PLUGIN_ID} --scope user -y`,
      ]);
      assert.deepEqual(
        steps.map((step) => [step.agent, step.scope, step.status, step.message]),
        [["claude", "global", "error", `${addedMessage}\nplugin not found in marketplace`]],
      );
      assert.deepEqual(await recordedItems("claude", "global"), []);
    }
  }));

test("when the plugin install fails after the marketplace add succeeded, install gives an error step with its output and a note that the marketplace is still registered, and records only the marketplace", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const failingInstall = fakeRunner(effects, (args) =>
      args[1] === "install" ? { code: 1, stdout: "", stderr: "plugin not found in marketplace\n" } : OK,
    );
    const steps = await claudeAdapter.install(contextIn(root, { run: failingInstall }), "project");
    assert.deepEqual(effects, [
      `run ${addCommand("project")}`,
      `run claude plugin install ${PLUGIN_ID} --scope project -y`,
    ]);
    assert.deepEqual(
      steps.map((step) => [step.scope, step.status, step.message]),
      [
        [
          "project",
          "error",
          `plugin not found in marketplace\nThe marketplace was added and is still registered. To remove it, run this in the folder ${projectIn(root)}: claude plugin marketplace remove multi-account-supabase-mcp --scope project`,
        ],
      ],
    );
    assert.deepEqual(await recordedItems("claude", scopeKey("project", projectIn(root))), [
      { kind: "marketplace", name: MARKETPLACE },
    ]);
  }));

test("when the plugin is installed in the project scope but its record cannot be written, the error step gives the uninstall command to run in the project folder", () =>
  inTemporaryRoot(async (root) => {
    // The first save, the marketplace record, works. The second save, the plugin record, fails.
    const restore = failingSavesAfter(1);
    try {
      const steps = await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "project");
      assert.equal(
        steps[0].message,
        `EIO: test error The plugin was installed. To remove it, run this in the folder ${projectIn(root)}: claude plugin uninstall ${PLUGIN_ID} --scope project\nThe marketplace was added and is still registered. To remove it, run this in the folder ${projectIn(root)}: claude plugin marketplace remove multi-account-supabase-mcp --scope project`,
      );
    } finally {
      restore();
    }
  }));

test("install with claude absent runs no command, and gives one error step that says so", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await claudeAdapter.install(
      contextIn(root, { present: false, run: fakeRunner(effects) }),
      "global",
    );
    assert.deepEqual(effects, []);
    assert.deepEqual(
      steps.map((step) => [step.agent, step.scope, step.status, step.message]),
      [["claude", "global", "error", "claude is not on PATH, so the plugin cannot be installed in this scope."]],
    );
    assert.equal(existsSync(statePath("claude")), false);
  }));

test("install stops before any change when the state file cannot be read, and runs no command", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(path.dirname(statePath("claude")), { recursive: true });
    await writeFile(statePath("claude"), "not json");
    const effects: string[] = [];
    const steps = await claudeAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, []);
    assert.equal(steps[0].status, "error");
    assert.match(steps[0].message, /cannot be read, so nothing was changed/);
  }));

test("when the marketplace add succeeds but its record cannot be written, install stops with an error step that gives the removal command", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const restore = failingSaves();
    try {
      const steps = await claudeAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
      assert.deepEqual(effects, [`run ${addCommand("user")}`]);
      assert.equal(steps[0].status, "error");
      assert.equal(
        steps[0].message,
        "EIO: test error The marketplace was added. To remove it, run: claude plugin marketplace remove multi-account-supabase-mcp --scope user",
      );
    } finally {
      restore();
    }
  }));

test("when the plugin is installed but its record cannot be written, install gives an error step that gives the uninstall command", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    // The first save, the marketplace record, works. The second save, the plugin record, fails.
    const restore = failingSavesAfter(1);
    try {
      const steps = await claudeAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
      assert.deepEqual(effects, [
        `run ${addCommand("user")}`,
        `run claude plugin install ${PLUGIN_ID} --scope user -y`,
      ]);
      assert.equal(steps[0].status, "error");
      assert.equal(
        steps[0].message,
        `EIO: test error The plugin was installed. To remove it, run: claude plugin uninstall ${PLUGIN_ID} --scope user\nThe marketplace was added and is still registered. To remove it, run: claude plugin marketplace remove multi-account-supabase-mcp --scope user`,
      );
    } finally {
      restore();
    }
    assert.deepEqual(await recordedItems("claude", "global"), [{ kind: "marketplace", name: MARKETPLACE }]);
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
    assert.deepEqual(await recordedItems("claude", scopeKey("local", projectIn(root))), INSTALLED_RECORD);
    // The project scope has nothing recorded, so it gets the same skip, runs no command and changes no file.
    await expectSkipNoCommandAndUnchangedState(root, "project");
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
      [["skipped", `${NOT_INSTALLED}. ${MARKETPLACE_NOTE}`]],
    );
    assert.deepEqual(await recordedItems("claude", "global"), []);
    // The project scope has nothing recorded, so it gets the same skip, runs no command and changes no file.
    await expectSkipNoCommandAndUnchangedState(root, "project");
  }));

test("uninstall that fails for another reason keeps the record, and returns an error step with the first non-empty line of its error output", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const failures: [CommandResult, string][] = [
      [{ code: 1, stdout: "", stderr: "  permission denied\n  more detail\n" }, "permission denied"],
      // A "not found" that does not name the plugin is about something else, so the record stays.
      [{ code: 1, stdout: "", stderr: "settings file not found\n" }, "settings file not found"],
      // A "not installed" line that does not name the plugin is about something else, so the record stays.
      [{ code: 1, stdout: "", stderr: "marketplace is not installed\n" }, "marketplace is not installed"],
      // A "not found" that names the plugin does not say the plugin is not installed, so the record stays too.
      [{ code: 1, stdout: "", stderr: `Plugin "${PLUGIN_ID}" not found\n` }, `Plugin "${PLUGIN_ID}" not found`],
      // With no error output, the first line of the standard output is the message.
      [{ code: 1, stdout: "\n  network down\n", stderr: " \n" }, "network down"],
      // With both streams non-empty, the message is the first line of the error output.
      [{ code: 1, stdout: "standard text\n", stderr: "error text\nmore detail\n" }, "error text"],
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
      assert.deepEqual(await recordedItems("claude", "global"), INSTALLED_RECORD);
    }
    // The project scope has nothing recorded, so it gets the same skip, runs no command and changes no file.
    await expectSkipNoCommandAndUnchangedState(root, "project");
  }));

test("uninstall with nothing recorded runs no command, changes no file, and gives a skipped step in each scope", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    for (const [scope] of CLI_SCOPES) {
      const steps = await claudeAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), scope);
      assert.deepEqual(
        steps.map((step) => [step.scope, step.status, step.message]),
        [[scope, "skipped", NOT_INSTALLED]],
      );
    }
    assert.deepEqual(effects, []);
    assert.equal(existsSync(statePath("claude")), false);
  }));

test("when the plugin is removed but the record of its scope cannot be cleared, uninstall gives an error step that says the plugin was removed", () =>
  inTemporaryRoot(async (root) => {
    // The local scope stays recorded, so clearing the global scope writes the state file, and that write is made to fail.
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "local");
    const effects: string[] = [];
    const restore = failingSaves();
    try {
      const steps = await claudeAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "global");
      assert.deepEqual(effects, [`run claude plugin uninstall ${PLUGIN_ID} --scope user`]);
      assert.deepEqual(
        steps.map((step) => [step.scope, step.status, step.message]),
        [
          [
            "global",
            "error",
            `EIO: test error The plugin was removed. The record of this scope could not be cleared, so run uninstall again for it. ${MARKETPLACE_NOTE}`,
          ],
        ],
      );
    } finally {
      restore();
    }
    assert.deepEqual(await recordedItems("claude", scopeKey("global", projectIn(root))), INSTALLED_RECORD);
    // The project scope has nothing recorded, so it gets the same skip, runs no command and changes no file.
    await expectSkipNoCommandAndUnchangedState(root, "project");
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
    assert.deepEqual(await recordedItems("claude", "global"), INSTALLED_RECORD);
    // The project scope has nothing recorded. claude is still absent, so the same skip is given, and nothing changes.
    await expectSkipNoCommandAndUnchangedState(root, "project", { present: false, message: NOT_ON_PATH });
  }));

test("uninstall never removes the marketplace: it runs no marketplace command, and its step says the marketplace is still registered and gives the removal command", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const steps = await claudeAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, [`run claude plugin uninstall ${PLUGIN_ID} --scope user`]);
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["ok", `Removed the plugin with claude plugin uninstall, from the global scope. ${MARKETPLACE_NOTE}`]],
    );
    // The record of the scope is forgotten as a whole, the marketplace item included.
    assert.deepEqual(await recordedItems("claude", scopeKey("global", projectIn(root))), []);
    // The project scope has nothing recorded, so it gets the same skip, runs no command and changes no file.
    await expectSkipNoCommandAndUnchangedState(root, "project");
  }));

test("uninstall of a scope whose record holds only the marketplace runs no command, reports the marketplace, and forgets the record", () =>
  inTemporaryRoot(async (root) => {
    // The marketplace add succeeds and the plugin install fails, so only the marketplace is recorded.
    const failingInstall = fakeRunner([], (args) =>
      args[1] === "install" ? { code: 1, stdout: "", stderr: "install failed\n" } : OK,
    );
    await claudeAdapter.install(contextIn(root, { run: failingInstall }), "global");
    assert.deepEqual(await recordedItems("claude", "global"), [{ kind: "marketplace", name: MARKETPLACE }]);
    const effects: string[] = [];
    const steps = await claudeAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, []);
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["skipped", `${NOT_INSTALLED}. ${MARKETPLACE_NOTE}`]],
    );
    assert.deepEqual(await recordedItems("claude", "global"), []);
    // The project scope has nothing recorded, so it gets the same skip, runs no command and changes no file.
    await expectSkipNoCommandAndUnchangedState(root, "project");
  }));

test("a dry run with claude absent checks for claude first in install, update, uninstall and doctor, and lists no command", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const cases = [
      ["install", "error", "claude is not on PATH, so the plugin cannot be installed in this scope."],
      ["update", "error", "claude is not on PATH, so the plugin cannot be updated in this scope."],
      ["uninstall", "skipped", NOT_ON_PATH],
      ["doctor", "skipped", "claude is not on PATH."],
    ] as const;
    for (const [action, status, message] of cases) {
      const planned = await runPlan({
        adapters: [claudeAdapter],
        action,
        agents: ["claude"],
        ctx: dryContextIn(root, effects, false),
      });
      assert.deepEqual(planned.steps.map((step) => [step.status, step.message]), [[status, message]], action);
      assert.deepEqual(planned.shown, [], action);
    }
    assert.deepEqual(effects, []);
    // A dry run for a scope with nothing recorded, with claude absent: the PATH skip is given, and no command is listed.
    await expectSkipNoCommandAndUnchangedState(root, "project", { dry: true, present: false, message: NOT_ON_PATH });
  }));

test("a dry run of the doctor says the listing was not run, and lists the command it would run", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const planned = await runPlan({
      adapters: [claudeAdapter],
      action: "doctor",
      agents: ["claude"],
      ctx: dryContextIn(root, []),
    });
    assert.deepEqual(
      planned.steps.map((step) => step.message),
      ["Would run claude plugin list for the global scope. The listing was not run, because this is a dry run."],
    );
    assert.deepEqual(planned.shown, ["claude plugin list --json"]);
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
      assert.deepEqual(await recordedItems("claude", scopeKey(scope, projectIn(root))), INSTALLED_RECORD);
    }
  }));

test("update whose claude plugin update fails gives an error step with the first non-empty line of its error output, and keeps the record", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const failing = fakeRunner([], (args) =>
      args[1] === "update" ? { code: 4, stdout: "standard text\n", stderr: "network error\nretry\n" } : OK,
    );
    const steps = await claudeAdapter.update(contextIn(root, { run: failing }), "global");
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["error", "network error"]],
    );
    assert.deepEqual(await recordedItems("claude", "global"), INSTALLED_RECORD);
  }));

test("update with claude absent runs no command and gives an error step, in a real run and in a dry run", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const real = await claudeAdapter.update(contextIn(root, { present: false, run: fakeRunner(effects) }), "global");
    const planned = await runPlan({
      adapters: [claudeAdapter],
      action: "update",
      agents: ["claude"],
      ctx: dryContextIn(root, effects, false),
    });
    const message = "claude is not on PATH, so the plugin cannot be updated in this scope.";
    assert.deepEqual(effects, []);
    assert.deepEqual(planned.shown, []);
    assert.deepEqual(real.map((step) => [step.status, step.message]), [["error", message]]);
    assert.deepEqual(planned.steps.map((step) => [step.status, step.message]), [["error", message]]);
  }));

test("update with claude absent gives a skipped step to each scope with no plugin record, in a real run and in a dry run, and runs no command", () =>
  inTemporaryRoot(async (root) => {
    // Nothing is recorded, so no scope has a plugin to update, and none gets an error about claude.
    const effects: string[] = [];
    for (const [scope] of CLI_SCOPES) {
      const real = await claudeAdapter.update(contextIn(root, { present: false, run: fakeRunner(effects) }), scope);
      assert.deepEqual(
        real.map((step) => [step.scope, step.status, step.message]),
        [[scope, "skipped", NOT_INSTALLED]],
      );
      const planned = await runPlan({
        adapters: [claudeAdapter],
        action: "update",
        scope,
        agents: ["claude"],
        ctx: dryContextIn(root, effects, false),
      });
      assert.deepEqual(
        planned.steps.map((step) => [step.scope, step.status, step.message]),
        [[scope, "skipped", NOT_INSTALLED]],
      );
      assert.deepEqual(planned.shown, [], scope);
    }
    assert.deepEqual(effects, []);
    assert.equal(existsSync(statePath("claude")), false);
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
      // A longer id that contains the plugin id is a different plugin, so the plugin is not found.
      [{ code: 0, stdout: `[{"id":"${PLUGIN_ID}-2"}]`, stderr: "" }, "skipped"],
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

test("the doctor lists in the project folder when the plugin is recorded in the project scope, and says the scope is not confirmed", () =>
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
    assert.match(steps[0].message, /has no verified scope field, so the project scope is not confirmed/);
  }));

test("the doctor without claude gives a skipped step only to a scope with a record, and no step when nothing is recorded", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const withoutClaude = (): Context => contextIn(root, { present: false, run: fakeRunner(effects) });
    assert.deepEqual(await claudeAdapter.doctor(withoutClaude()), []);
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "local");
    const steps = await claudeAdapter.doctor(withoutClaude());
    assert.deepEqual(effects, []);
    assert.deepEqual(
      steps.map((step) => [step.scope, step.status, step.message]),
      [["local", "skipped", "claude is not on PATH."]],
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
    assert.match(steps[1].message, /not confirmed/);
  }));

test("a listing that fails gives the recorded scope a skipped step that names the scope", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "project");
    const failing = fakeRunner([], () => ({ code: 1, stdout: PLUGIN_ID, stderr: "" }));
    const steps = await claudeAdapter.doctor(contextIn(root, { run: failing }));
    assert.deepEqual(
      steps.map((step) => [step.scope, step.status, step.message]),
      [["project", "skipped", "claude plugin list failed for the project scope, so the plugin was not checked."]],
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
      `claude plugin marketplace add ${SOURCE} --scope user`,
      `claude plugin install ${PLUGIN_ID} --scope user -y`,
    ]);
    assert.equal(existsSync(statePath("claude")), false);

    // A real install records the entries. The dry-run update and uninstall list their commands and keep the records.
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
    assert.deepEqual(await recordedItems("claude", "global"), INSTALLED_RECORD);
  }));

test("a dry run says what would happen in each step, never what happened, and runs no command", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const messages: string[] = [];
    for (const action of ["install", "update", "uninstall", "doctor"] as const) {
      const planned = await runPlan({
        adapters: [claudeAdapter],
        action,
        agents: ["claude"],
        ctx: dryContextIn(root, effects),
      });
      messages.push(...planned.steps.map((step) => step.message));
    }
    assert.equal(messages.length, 4);
    for (const message of messages) {
      assert.match(message, /^Would /);
      assert.doesNotMatch(message, /Installed|Updated|Removed/);
    }
    assert.deepEqual(effects, []);
    assert.deepEqual(await recordedItems("claude", "global"), INSTALLED_RECORD);
  }));

test("the project and local scopes keep separate records, so removing the local one leaves the project one", () =>
  inTemporaryRoot(async (root) => {
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "project");
    await claudeAdapter.install(contextIn(root, { run: fakeRunner([]) }), "local");
    assert.notEqual(scopeKey("project", projectIn(root)), scopeKey("local", projectIn(root)));
    await claudeAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "local");
    assert.deepEqual(await recordedItems("claude", scopeKey("project", projectIn(root))), INSTALLED_RECORD);
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
      `claude plugin marketplace add ${SOURCE} --scope project`,
      `cwd ${projectIn(root)}`,
      `claude plugin install ${PLUGIN_ID} --scope project -y`,
    ]);
  }));

test("the marketplace notes name the scope the marketplace is in, and for project and local say to run its command in the project folder", () =>
  inTemporaryRoot(async (root) => {
    for (const [scope, cliScope] of CLI_SCOPES) {
      const where = scope === "global" ? "" : ` this in the folder ${projectIn(root)}`;
      const command = `claude plugin marketplace remove ${MARKETPLACE} --scope ${cliScope}`;
      // The marketplace add works and the plugin install fails, so the install step names the marketplace that stays registered.
      const failingInstall = fakeRunner([], (args) =>
        args[1] === "install" ? { code: 1, stdout: "", stderr: "install failed\n" } : OK,
      );
      const installed = await claudeAdapter.install(contextIn(root, { run: failingInstall }), scope);
      assert.equal(
        installed[0].message,
        `install failed\nThe marketplace was added and is still registered. To remove it, run${where}: ${command}`,
        scope,
      );
      // Only the marketplace is recorded now, so uninstall names the same command and forgets the scope.
      const removed = await claudeAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), scope);
      assert.equal(
        removed[0].message,
        `${NOT_INSTALLED}. The marketplace is still registered. To remove it, run${where}: ${command}`,
        scope,
      );
      assert.deepEqual(await recordedItems("claude", scopeKey(scope, projectIn(root))), []);
    }
  }));

test("when the marketplace add works in the project scope but its record cannot be written, the error step gives the removal command for the project folder", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const restore = failingSaves();
    try {
      const steps = await claudeAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "project");
      assert.deepEqual(effects, [`run ${addCommand("project")}`]);
      assert.equal(
        steps[0].message,
        `EIO: test error The marketplace was added. To remove it, run this in the folder ${projectIn(root)}: claude plugin marketplace remove multi-account-supabase-mcp --scope project`,
      );
    } finally {
      restore();
    }
  }));

test("the marketplace add runs in the project folder for project and local, and in no folder for global", () =>
  inTemporaryRoot(async (root) => {
    for (const [scope] of CLI_SCOPES) {
      const adds: (CommandOptions | undefined)[] = [];
      const recordAdd: Runner = async (_command, args, options): Promise<CommandResult> => {
        if (args[1] === "marketplace") {
          adds.push(options);
        }
        return OK;
      };
      await claudeAdapter.install(contextIn(root, { run: recordAdd }), scope);
      const expected = scope === "global" ? undefined : { cwd: projectIn(root) };
      assert.deepEqual(adds, [expected], scope);
    }
  }));

test("each test points the home, configuration and data names into its own temporary folder", () =>
  inTemporaryRoot(async (root) => {
    for (const name of FOLDER_NAMES) {
      assert.equal(process.env[name]?.startsWith(root), true, name);
    }
  }));
