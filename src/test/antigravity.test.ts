import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { antigravityAdapter } from "../agents/antigravity.js";
import type { CommandResult, Runner } from "../agents/command.js";
import { runPlan } from "../agents/plan.js";
import { record, recordedItems, statePath } from "../agents/state.js";
import { type Context, type FileOps, type Step, UnsupportedScope, makeContext } from "../agents/types.js";

const NAME = "multi-account-supabase";
const OK: CommandResult = { code: 0, stdout: "", stderr: "" };
const SCOPE_MESSAGE = "antigravity has no local scope, and no project scope. Use global.";

// The variables that point the code at folders on the owner's machine. Each test points every one of them into its own
// temporary root, and restores the previous values afterwards.
const ENVIRONMENT = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "MULTI_ACCOUNT_SUPABASE_HOME",
] as const;

const inTemporaryRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "antigravity-test-"));
  const folders: Record<(typeof ENVIRONMENT)[number], string> = {
    HOME: path.join(root, "home"),
    USERPROFILE: path.join(root, "home"),
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "localappdata"),
    CODEX_HOME: path.join(root, "codex"),
    XDG_CONFIG_HOME: path.join(root, "xdg"),
    MULTI_ACCOUNT_SUPABASE_HOME: path.join(root, "data"),
  };
  const previous = ENVIRONMENT.map((name) => [name, process.env[name]] as const);
  Object.assign(process.env, folders);
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

// The paths inside a root. The program file need not exist, because the adapter only passes its path on.
const projectIn = (root: string): string => path.join(root, "project");
const programIn = (root: string): string => path.join(root, "package", "dist", "cli.js");

// Paths for the presence test below, which never touches the disk.
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

type Verb = "list" | "add" | "remove";

// A runner that answers each agy command by its verb, the word after "mcp". A verb with no answer succeeds with no output.
const answering = (effects: string[], answers: Partial<Record<Verb, CommandResult>>): Runner =>
  fakeRunner(effects, (args) => answers[args[1] as Verb] ?? OK);

// Writes text that is not a state file over the state file, so that reading it is refused.
const damageState = async (): Promise<void> => {
  await mkdir(path.dirname(statePath("antigravity")), { recursive: true });
  await writeFile(statePath("antigravity"), "not json", "utf8");
};

// A runner whose add also damages the state file, as if the file changed while agy was adding the entry.
const damagingAdd =
  (effects: string[]): Runner =>
  async (command, args): Promise<CommandResult> => {
    effects.push(`run ${[command, ...args].join(" ")}`);
    if (args[1] === "add") {
      await damageState();
    }
    return OK;
  };

// Fake file functions for the dry run. They log each call, but a dry run never calls them.
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

// A context for a dry run in the temporary folders. A dry run records each command and file change in shown, and it calls
// neither the runner nor the file functions. So the tests check shown, and the effects stay empty.
const dryContext = (root: string, effects: string[]): Context =>
  makeContext({
    projectDir: projectIn(root),
    cliPath: programIn(root),
    packageRoot: path.join(root, "package"),
    dryRun: true,
    present: () => true,
    run: fakeRunner(effects),
    fs: fakeFiles(effects),
  });

// How a dry run shows an argument: quoted when it is empty, or has a space or a double quote, as the context does.
const quoteLike = (part: string): string => (part === "" || /[\s"]/.test(part) ? `"${part}"` : part);

// An uninstall with no record: a skipped step, and no command runs, even when agy lists the name. Each uninstall test checks
// this case first. A dry-run uninstall checks it with the dry context.
const assertNothingRecordedRunsNothing = async (root: string): Promise<void> => {
  const effects: string[] = [];
  const listing = answering(effects, { list: { code: 0, stdout: `${NAME}  node\n`, stderr: "" } });
  const steps = await antigravityAdapter.uninstall(contextIn(root, { run: listing }), "global");
  assert.deepEqual(effects, []);
  assert.deepEqual(
    steps.map((step) => [step.status, step.message]),
    [["skipped", "not installed in this scope"]],
  );
};

test("the adapter is antigravity, has the global scope only, and asks the system for the agy command", () =>
  inTemporaryRoot(async () => {
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
  }));

test("every test environment points each of the seven variables into its temporary root", () =>
  inTemporaryRoot(async (root) => {
    // The names are written out here, not read from ENVIRONMENT, so a name that the helper drops fails this test.
    const names = [
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
      "CODEX_HOME",
      "XDG_CONFIG_HOME",
      "MULTI_ACCOUNT_SUPABASE_HOME",
    ];
    for (const name of names) {
      assert.equal(process.env[name]?.startsWith(root), true, name);
    }
  }));

test("a fresh install checks the listing first, then adds the server without removing anything, and records an mcp-entry", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await antigravityAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, [
      "run agy mcp list",
      `run agy mcp add ${NAME} ${process.execPath} ${programIn(root)} serve`,
    ]);
    assert.deepEqual(
      steps.map((step) => [step.agent, step.scope, step.status]),
      [["antigravity", "global", "ok"]],
    );
    assert.match(steps[0].message, /agy mcp add/);
    assert.deepEqual(await recordedItems("antigravity", "global"), [{ kind: "mcp-entry", name: NAME }]);
  }));

test("a fresh install with the name already listed refuses, runs no add, and records nothing", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const listing = answering(effects, {
      list: { code: 0, stdout: `Name  Command\n${NAME}  node\n`, stderr: "" },
    });
    const steps = await antigravityAdapter.install(contextIn(root, { run: listing }), "global");
    assert.deepEqual(effects, ["run agy mcp list"]);
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [
        [
          "error",
          "agy already lists multi-account-supabase, but the record does not list it, so nothing was changed. Remove that entry with agy, then install again.",
        ],
      ],
    );
    assert.deepEqual(await recordedItems("antigravity", "global"), []);
  }));

test("a fresh install whose listing fails refuses, even when the output names the server, and runs no add", () =>
  inTemporaryRoot(async (root) => {
    const failures: [CommandResult, string][] = [
      [
        { code: 1, stdout: "", stderr: "agy: cannot read its settings\n" },
        "agy mcp list failed, so nothing was changed: agy: cannot read its settings",
      ],
      [
        { code: 1, stdout: `${NAME}  node\n`, stderr: "" },
        "agy mcp list failed, so nothing was changed: multi-account-supabase  node",
      ],
    ];
    for (const [list, message] of failures) {
      const effects: string[] = [];
      const steps = await antigravityAdapter.install(contextIn(root, { run: answering(effects, { list }) }), "global");
      assert.deepEqual(effects, ["run agy mcp list"]);
      assert.deepEqual(
        steps.map((step) => [step.status, step.message]),
        [["error", message]],
      );
    }
    assert.deepEqual(await recordedItems("antigravity", "global"), []);
  }));

test("a failed agy mcp add gives an error step with the first line of its stderr, then of its stdout, or its exit code, and records nothing", () =>
  inTemporaryRoot(async (root) => {
    const failures: [CommandResult, string][] = [
      [{ code: 2, stdout: "stdout line\n", stderr: "stderr line\nsecond line\n" }, "stderr line"],
      [{ code: 2, stdout: "  wrote nothing\n", stderr: " \n" }, "wrote nothing"],
      [{ code: 3, stdout: " ", stderr: "" }, "exit 3"],
    ];
    for (const [add, message] of failures) {
      const steps = await antigravityAdapter.install(contextIn(root, { run: answering([], { add }) }), "global");
      assert.deepEqual(
        steps.map((step) => [step.status, step.message]),
        [["error", message]],
      );
    }
    assert.deepEqual(await recordedItems("antigravity", "global"), []);
  }));

test("a state file that cannot be read stops install, update, uninstall and doctor before any command runs, with an error step", () =>
  inTemporaryRoot(async (root) => {
    await assertNothingRecordedRunsNothing(root);
    await damageState();
    const effects: string[] = [];
    const ctx = contextIn(root, { run: fakeRunner(effects) });
    const results = [
      await antigravityAdapter.install(ctx, "global"),
      await antigravityAdapter.update(ctx, "global"),
      await antigravityAdapter.uninstall(ctx, "global"),
      await antigravityAdapter.doctor(ctx),
    ];
    for (const steps of results) {
      assert.equal(steps[0].status, "error");
      assert.match(steps[0].message, /cannot be read, so nothing was changed/);
    }
    assert.deepEqual(effects, []);
  }));

test("a dry run whose state file cannot be read gives an error step, and lists no command", () =>
  inTemporaryRoot(async (root) => {
    await damageState();
    const ctx = dryContext(root, []);
    const steps = await antigravityAdapter.install(ctx, "global");
    assert.equal(steps[0].status, "error");
    assert.match(steps[0].message, /cannot be read, so nothing was changed/);
    assert.deepEqual(ctx.shown, []);
  }));

test("a state file that becomes unreadable during a fresh add makes the record fail, so the entry is removed again and the step is an error", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await antigravityAdapter.install(contextIn(root, { run: damagingAdd(effects) }), "global");
    assert.deepEqual(effects, [
      "run agy mcp list",
      `run agy mcp add ${NAME} ${process.execPath} ${programIn(root)} serve`,
      `run agy mcp remove ${NAME}`,
    ]);
    assert.equal(steps[0].status, "error");
    assert.equal(
      steps[0].message,
      `The server was added, but its record file ${statePath("antigravity")} could not be written: not valid JSON. The server was removed again, so agy no longer lists it.`,
    );
    assert.doesNotMatch(steps[0].message, /nothing was changed/);
  }));

test("a fresh add whose record fails and whose undo also fails gives the removal command, and says that the undo failed", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const runner: Runner = async (command, args): Promise<CommandResult> => {
      effects.push(`run ${[command, ...args].join(" ")}`);
      if (args[1] === "add") {
        await damageState();
      }
      if (args[1] === "remove") {
        return { code: 1, stdout: "", stderr: "agy: remove refused\n" };
      }
      return OK;
    };
    const steps = await antigravityAdapter.install(contextIn(root, { run: runner }), "global");
    assert.deepEqual(effects, [
      "run agy mcp list",
      `run agy mcp add ${NAME} ${process.execPath} ${programIn(root)} serve`,
      `run agy mcp remove ${NAME}`,
    ]);
    assert.equal(steps[0].status, "error");
    assert.equal(
      steps[0].message,
      `The server was added, but its record file ${statePath("antigravity")} could not be written: not valid JSON. Removing it again failed: agy: remove refused. To remove it, run agy mcp remove multi-account-supabase.`,
    );
    assert.doesNotMatch(steps[0].message, /nothing was changed/);
  }));

test("a state file that becomes unreadable during a re-add makes the record fail, and the step gives the removal command", () =>
  inTemporaryRoot(async (root) => {
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const steps = await antigravityAdapter.update(contextIn(root, { run: damagingAdd(effects) }), "global");
    assert.deepEqual(effects, [
      `run agy mcp remove ${NAME}`,
      `run agy mcp add ${NAME} ${process.execPath} ${programIn(root)} serve`,
    ]);
    assert.equal(steps[0].status, "error");
    assert.equal(
      steps[0].message,
      `The server was added, but its record file ${statePath("antigravity")} could not be written: not valid JSON. To remove it, run agy mcp remove multi-account-supabase.`,
    );
    assert.doesNotMatch(steps[0].message, /nothing was changed/);
  }));

test("a record file that cannot be written for a system reason names the record and the code, and does not say that nothing was changed", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    // The state path becomes a folder while agy adds the entry, so reading the record fails with a system error.
    const folderAdd: Runner = async (command, args): Promise<CommandResult> => {
      effects.push(`run ${[command, ...args].join(" ")}`);
      if (args[1] === "add") {
        await mkdir(statePath("antigravity"), { recursive: true });
      }
      return OK;
    };
    const steps = await antigravityAdapter.install(contextIn(root, { run: folderAdd }), "global");
    assert.deepEqual(effects, [
      "run agy mcp list",
      `run agy mcp add ${NAME} ${process.execPath} ${programIn(root)} serve`,
      `run agy mcp remove ${NAME}`,
    ]);
    assert.equal(steps[0].status, "error");
    assert.equal(
      steps[0].message,
      `The server was added, but its record file ${statePath("antigravity")} could not be written: EISDIR. The server was removed again, so agy no longer lists it.`,
    );
    assert.doesNotMatch(steps[0].message, /nothing was changed/);
  }));

test("update of a recorded entry runs agy mcp remove by its name, then agy mcp add, and keeps the record", () =>
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

test("update whose add fails after agy removed the entry says that agy no longer lists it, and that the record still does", () =>
  inTemporaryRoot(async (root) => {
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const failingAdd = answering(effects, { add: { code: 1, stdout: "", stderr: "agy: add refused\n" } });
    const steps = await antigravityAdapter.update(contextIn(root, { run: failingAdd }), "global");
    assert.deepEqual(effects, [
      `run agy mcp remove ${NAME}`,
      `run agy mcp add ${NAME} ${process.execPath} ${programIn(root)} serve`,
    ]);
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [
        [
          "error",
          "The server was removed from agy, but adding it again failed, so agy no longer lists it. The record still lists it. agy: add refused",
        ],
      ],
    );
    assert.deepEqual(await recordedItems("antigravity", "global"), [{ kind: "mcp-entry", name: NAME }]);
  }));

test("update of a scope with nothing recorded does nothing: a skipped step, and no command runs, even when agy lists the name", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const listing = answering(effects, { list: { code: 0, stdout: `${NAME}  node\n`, stderr: "" } });
    const steps = await antigravityAdapter.update(contextIn(root, { run: listing }), "global");
    assert.deepEqual(effects, []);
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["skipped", "not installed in this scope"]],
    );
    assert.equal(existsSync(statePath("antigravity")), false);
  }));

test("update and uninstall remove nothing by name when the record lists only another entry name", () =>
  inTemporaryRoot(async (root) => {
    await assertNothingRecordedRunsNothing(root);
    await record("antigravity", "global", { kind: "mcp-entry", name: "other-server" });
    const effects: string[] = [];
    const ctx = contextIn(root, { run: fakeRunner(effects) });
    const updated = await antigravityAdapter.update(ctx, "global");
    const removed = await antigravityAdapter.uninstall(ctx, "global");
    assert.deepEqual(effects, []);
    assert.deepEqual(
      [...updated, ...removed].map((step) => [step.status, step.message]),
      [
        ["skipped", "not installed in this scope"],
        ["skipped", "not installed in this scope"],
      ],
    );
    assert.deepEqual(await recordedItems("antigravity", "global"), [{ kind: "mcp-entry", name: "other-server" }]);
  }));

test("uninstall with no record runs no command, even when agy lists the name", () =>
  inTemporaryRoot((root) => assertNothingRecordedRunsNothing(root)));

test("uninstall with agy present runs agy mcp remove by the recorded name, and forgets the global scope", () =>
  inTemporaryRoot(async (root) => {
    await assertNothingRecordedRunsNothing(root);
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

test("uninstall whose record cannot be updated after agy removed the entry says that the entry is gone, not that nothing was changed", () =>
  inTemporaryRoot(async (root) => {
    await assertNothingRecordedRunsNothing(root);
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const damagingRemove: Runner = async (command, args): Promise<CommandResult> => {
      effects.push(`run ${[command, ...args].join(" ")}`);
      if (args[1] === "remove") {
        await damageState();
      }
      return OK;
    };
    const steps = await antigravityAdapter.uninstall(contextIn(root, { run: damagingRemove }), "global");
    assert.deepEqual(effects, [`run agy mcp remove ${NAME}`]);
    assert.equal(steps[0].status, "error");
    assert.match(steps[0].message, /removed from agy, but this tool could not update its record/);
    assert.doesNotMatch(steps[0].message, /nothing was changed/);
  }));

test("uninstall whose removal reports that the server is absent, and whose record then cannot be updated, says that agy did not list it", () =>
  inTemporaryRoot(async (root) => {
    await assertNothingRecordedRunsNothing(root);
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const absentAndDamaged: Runner = async (command, args): Promise<CommandResult> => {
      effects.push(`run ${[command, ...args].join(" ")}`);
      if (args[1] === "remove") {
        await damageState();
        return { code: 1, stdout: "", stderr: `MCP server "${NAME}" not found\n` };
      }
      return OK;
    };
    const steps = await antigravityAdapter.uninstall(contextIn(root, { run: absentAndDamaged }), "global");
    assert.deepEqual(effects, [`run agy mcp remove ${NAME}`]);
    assert.equal(steps[0].status, "error");
    assert.match(steps[0].message, /^agy did not list the server, and this tool could not update its record at /);
    assert.doesNotMatch(steps[0].message, /removed from agy/);
  }));

test("uninstall whose agy mcp remove reports that the server is not installed is skipped as not installed globally, and forgets the scope", () =>
  inTemporaryRoot(async (root) => {
    await assertNothingRecordedRunsNothing(root);
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const notInstalled = answering([], {
      remove: { code: 1, stdout: "", stderr: `MCP server "${NAME}" not found\n` },
    });
    const steps = await antigravityAdapter.uninstall(contextIn(root, { run: notInstalled }), "global");
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [["skipped", "not installed globally"]],
    );
    assert.deepEqual(await recordedItems("antigravity", "global"), []);
  }));

test("uninstall whose agy mcp remove fails for another reason keeps the record, and returns an error step with the first line of its output", () =>
  inTemporaryRoot(async (root) => {
    await assertNothingRecordedRunsNothing(root);
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const failures: [CommandResult, string][] = [
      [
        { code: 1, stdout: "", stderr: "agy: cannot write its settings file\n  more detail\n" },
        "agy: cannot write its settings file",
      ],
      // A "not found" that does not name this server is about something else, such as a settings file.
      [{ code: 1, stdout: "", stderr: "agy: settings file not found\n" }, "agy: settings file not found"],
      // The server is named, and "not found" is about something else. Only words that come straight after the name count.
      [
        { code: 1, stdout: "", stderr: "multi-account-supabase: settings file not found\n" },
        "multi-account-supabase: settings file not found",
      ],
      // The server is named, but nothing says that it is absent.
      [
        { code: 1, stdout: "agy could not update multi-account-supabase\n", stderr: "" },
        "agy could not update multi-account-supabase",
      ],
      // The server is named, and "not found" is followed by more text. That is not a report that the server is absent.
      [
        { code: 1, stdout: "", stderr: "multi-account-supabase not found in settings: write failed\n" },
        "multi-account-supabase not found in settings: write failed",
      ],
      // Both streams have text, so the first line of the error output is the message.
      [{ code: 1, stdout: "stdout line\n", stderr: "stderr line\nsecond line\n" }, "stderr line"],
      // With no output at all, the exit code is the message.
      [{ code: 4, stdout: "", stderr: " \n" }, "exit 4"],
    ];
    for (const [remove, message] of failures) {
      const effects: string[] = [];
      const steps = await antigravityAdapter.uninstall(
        contextIn(root, { run: answering(effects, { remove }) }),
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
    await assertNothingRecordedRunsNothing(root);
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

test("doctor is ok when agy mcp list names the server as one word, skipped when it does not, and an error when the list exits non-zero", () =>
  inTemporaryRoot(async (root) => {
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const doctorWith = (listed: CommandResult, present = true): Promise<Step[]> =>
      antigravityAdapter.doctor(contextIn(root, { present, run: answering(effects, { list: listed }) }));
    const listing = (stdout: string, code = 0): CommandResult => ({ code, stdout, stderr: "" });
    const results = [
      await doctorWith(listing(`Name  Command\n${NAME}  node\n`)),
      await doctorWith(listing(`│ ${NAME} │ node │\n`)),
      await doctorWith(listing("other-server  node\n")),
      await doctorWith(listing(`${NAME}-mcp  node\n`)),
      await doctorWith(listing(`${NAME}  node\n`, 1)),
      await doctorWith(listing(NAME), false),
    ];
    assert.deepEqual(
      results.map((steps) => steps[0].status),
      ["ok", "ok", "skipped", "skipped", "error", "skipped"],
    );
    assert.equal(results[4][0].message, "agy mcp list failed, so the server was not checked: multi-account-supabase  node");
    assert.deepEqual(effects, [
      "run agy mcp list",
      "run agy mcp list",
      "run agy mcp list",
      "run agy mcp list",
      "run agy mcp list",
    ]);
  }));

test("doctor gives no step for a scope with no record, and runs no command", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const listing = answering(effects, { list: { code: 0, stdout: `${NAME}  node\n`, stderr: "" } });
    const steps = await antigravityAdapter.doctor(contextIn(root, { run: listing }));
    assert.deepEqual(steps, []);
    assert.deepEqual(effects, []);
  }));

test("a dry run of doctor does not run the listing, and its step says so", () =>
  inTemporaryRoot(async (root) => {
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const result = await runPlan({
      adapters: [antigravityAdapter],
      action: "doctor",
      agents: ["antigravity"],
      ctx: dryContext(root, effects),
    });
    // The dry run records each command it would run, so a listing would show up here.
    assert.deepEqual(result.shown, []);
    assert.equal(result.steps[0].status, "skipped");
    assert.match(result.steps[0].message, /does not run the listing/);
  }));

test("a dry run does not act on the result of a command, so a fake failure does not become an error step", () =>
  inTemporaryRoot(async (root) => {
    const base = dryContext(root, []);
    const failing = async (): Promise<CommandResult> => ({ code: 1, stdout: "", stderr: "boom" });
    // With no record, a dry-run uninstall is skipped and lists no command, even when the runner would fail.
    const none = await antigravityAdapter.uninstall({ ...base, run: failing }, "global");
    assert.deepEqual(
      none.map((step) => [step.status, step.message]),
      [["skipped", "not installed in this scope"]],
    );
    assert.deepEqual(base.shown, []);
    const installed = await antigravityAdapter.install({ ...base, run: failing }, "global");
    assert.deepEqual(
      installed.map((step) => [step.status, /^Would add /.test(step.message)]),
      [["ok", true]],
    );
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const removed = await antigravityAdapter.uninstall({ ...base, run: failing }, "global");
    assert.deepEqual(
      removed.map((step) => [step.status, /^Would remove /.test(step.message)]),
      [["ok", true]],
    );
  }));

test("the project and local scopes are refused with the adapter's message by install, update and uninstall, and no command runs", () =>
  inTemporaryRoot(async (root) => {
    await assertNothingRecordedRunsNothing(root);
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

test("a dry run of install with agy absent gives an error step, and runs no command", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: true,
      present: () => false,
      run: fakeRunner(effects),
      fs: fakeFiles(effects),
    });
    const result = await runPlan({ adapters: [antigravityAdapter], action: "install", agents: ["antigravity"], ctx });
    assert.deepEqual(
      result.steps.map((step) => step.status),
      ["error"],
    );
    assert.match(result.steps[0].message, /not on PATH/);
    assert.deepEqual(result.shown, []);
    assert.deepEqual(effects, []);
  }));

test("a dry run through the planner changes no file, runs no command and writes no state, and says what would happen", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const plan = (action: "install" | "update" | "uninstall") =>
      runPlan({ adapters: [antigravityAdapter], action, agents: ["antigravity"], ctx: dryContext(root, effects) });

    // With no record, a dry-run uninstall is skipped, as a real one is, and lists no command.
    const nothing = await plan("uninstall");
    assert.deepEqual(
      nothing.steps.map((step) => [step.status, step.message]),
      [["skipped", "not installed in this scope"]],
    );
    assert.deepEqual(nothing.shown, []);

    // A dry-run install lists the add only. The listing is not run in a dry run, and the step says so.
    const fresh = await plan("install");
    assert.deepEqual(fresh.shown, [
      `agy mcp add ${NAME} ${quoteLike(process.execPath)} ${quoteLike(programIn(root))} serve`,
    ]);
    assert.deepEqual(
      fresh.steps.map((step) => step.status),
      ["ok"],
    );
    assert.match(fresh.steps[0].message, /^Would add /);
    assert.match(fresh.steps[0].message, /does not run agy mcp list/);
    assert.equal(existsSync(statePath("antigravity")), false);

    // With a recorded entry, a dry-run update lists the remove and the add, and a dry-run uninstall lists the remove.
    await antigravityAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const updated = await plan("update");
    assert.deepEqual(updated.shown, [
      `agy mcp remove ${NAME}`,
      `agy mcp add ${NAME} ${quoteLike(process.execPath)} ${quoteLike(programIn(root))} serve`,
    ]);
    assert.match(updated.steps[0].message, /^Would add /);
    const removed = await plan("uninstall");
    assert.deepEqual(removed.shown, [`agy mcp remove ${NAME}`]);
    assert.match(removed.steps[0].message, /^Would remove /);

    assert.deepEqual(effects, []);
    assert.deepEqual(await recordedItems("antigravity", "global"), [{ kind: "mcp-entry", name: NAME }]);
    // No dry-run message says that a change was made.
    for (const result of [nothing, fresh, updated, removed]) {
      for (const message of result.steps.map((step) => step.message)) {
        assert.doesNotMatch(message, /added|removed/i);
      }
    }
  }));
