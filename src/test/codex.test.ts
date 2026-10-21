import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { codexAdapter } from "../agents/codex.js";
import type { CommandResult, Runner } from "../agents/command.js";
import { runPlan } from "../agents/plan.js";
import { recordedItems, scopeKey, statePath } from "../agents/state.js";
import { type Context, type FileOps, type Step, UnsupportedScope, makeContext } from "../agents/types.js";

const DATA_ENV = "MULTI_ACCOUNT_SUPABASE_HOME";
const NAME = "multi-account-supabase";
const HEADER = `[mcp_servers.${NAME}]`;
const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

// Each test gets a temporary root. The data folder variable points into the root too, so the state file of the agent
// never reaches the owner's data folder. Both are restored and the root is removed afterwards.
const inTemporaryRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-test-"));
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

// The paths inside a root. The program file need not exist, because the adapter only writes its path into text.
const projectIn = (root: string): string => path.join(root, "project");
const programIn = (root: string): string => path.join(root, "package", "dist", "cli.js");
const configIn = (root: string): string => path.join(root, "project", ".codex", "config.toml");

// The server table as this installer writes it, with the values as TOML literal strings.
const serverTable = (root: string): string =>
  `${HEADER}\ncommand = '${process.execPath}'\nargs = ['${programIn(root)}', 'serve']\n`;

// A fake command runner. It logs each command line and answers as the test says, so no agent CLI runs.
const fakeRunner =
  (
    effects: string[],
    answer: (args: readonly string[]) => CommandResult = () => OK,
  ): Runner =>
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

// A context for a real run in the temporary folders. Only the command runner is replaced.
const contextIn = (
  root: string,
  options: { present?: boolean; run?: Runner; cliPath?: string } = {},
): Context =>
  makeContext({
    projectDir: projectIn(root),
    cliPath: options.cliPath ?? programIn(root),
    packageRoot: path.join(root, "package"),
    dryRun: false,
    present: () => options.present ?? true,
    run: options.run ?? fakeRunner([]),
  });

// How the command line of a dry run shows an argument: quoted when it has a space or a double quote.
const quoteLike = (part: string): string => (/[\s"]/.test(part) ? `"${part}"` : part);

test("the adapter accepts the global and project scopes, and refuses the local scope", () =>
  inTemporaryRoot(async (root) => {
    assert.deepEqual([...codexAdapter.scopes], ["global", "project"]);
    await assert.rejects(codexAdapter.install(contextIn(root), "local"), UnsupportedScope);
    await assert.rejects(codexAdapter.update(contextIn(root), "local"), UnsupportedScope);
    await assert.rejects(codexAdapter.uninstall(contextIn(root), "local"), UnsupportedScope);
  }));

test("global install runs codex mcp remove, then codex mcp add with the entry, and records an mcp-entry", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await codexAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, [
      `run codex mcp remove ${NAME}`,
      `run codex mcp add ${NAME} -- ${process.execPath} ${programIn(root)} serve`,
    ]);
    assert.equal(steps[0].status, "ok");
    assert.equal(steps[0].scope, "global");
    assert.deepEqual(await recordedItems("codex", "global"), [{ kind: "mcp-entry", name: NAME }]);
  }));

test("a failed codex mcp add gives an error step with its first output, or its exit code, and records nothing", () =>
  inTemporaryRoot(async (root) => {
    const withStderr = fakeRunner([], (args) =>
      args[1] === "add" ? { code: 2, stdout: "", stderr: "  unknown option\n" } : OK,
    );
    const silent = fakeRunner([], (args) => (args[1] === "add" ? { code: 3, stdout: " ", stderr: "" } : OK));
    const first = await codexAdapter.install(contextIn(root, { run: withStderr }), "global");
    const second = await codexAdapter.install(contextIn(root, { run: silent }), "global");
    assert.deepEqual(
      first.map((step) => [step.status, step.message]),
      [["error", "unknown option"]],
    );
    assert.deepEqual(
      second.map((step) => [step.status, step.message]),
      [["error", "exit 3"]],
    );
    assert.deepEqual(await recordedItems("codex", "global"), []);
  }));

// A file with two other tables and an old copy of this tool's table, with a sub-table, in the middle.
const BEFORE_INSTALL = [
  'model = "gpt-5"',
  "",
  "[mcp_servers.first]",
  "command = 'first-command'",
  "",
  `[mcp_servers.${NAME}]`,
  "command = 'old-node'",
  "args = ['old-cli', 'serve']",
  "",
  `[mcp_servers.${NAME}.env]`,
  "TEST = 'x'",
  "",
  "[mcp_servers.second]",
  "command = 'second-command'",
  "# A comment that belongs to the second table.",
  "args = ['a']",
  "",
].join("\n");

test("project install replaces the server table, keeps the other tables byte for byte, and backs up the old file", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, BEFORE_INSTALL);
    const steps = await codexAdapter.install(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.equal(steps[0].scope, "project");
    const expected = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.first]",
      "command = 'first-command'",
      "",
      "[mcp_servers.second]",
      "command = 'second-command'",
      "# A comment that belongs to the second table.",
      "args = ['a']",
      "",
      HEADER,
      `command = '${process.execPath}'`,
      `args = ['${programIn(root)}', 'serve']`,
      "",
    ].join("\n");
    assert.equal(await readFile(file, "utf8"), expected);
    assert.equal(await readFile(`${file}.bak`, "utf8"), BEFORE_INSTALL);
    assert.deepEqual(await recordedItems("codex", scopeKey("project", projectIn(root))), [
      { kind: "toml-table", path: file, table: `mcp_servers.${NAME}` },
    ]);
  }));

test("project install refuses a file that is not valid TOML, with an error that names the file, and changes nothing", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    const texts = [Buffer.from("[mcp_servers.broken\nsecret = 'x' = 1\n"), Buffer.from([0x5b, 0x61, 0x5d, 0xff, 0x0a])];
    for (const text of texts) {
      await writeFile(file, text);
      const steps = await codexAdapter.install(contextIn(root), "project");
      assert.equal(steps[0].status, "error");
      assert.equal(steps[0].message.includes(file), true);
      assert.equal(steps[0].message.includes("not valid TOML"), true);
      assert.equal(steps[0].message.includes("secret"), false);
      assert.deepEqual(await readFile(file), text);
      assert.equal(existsSync(`${file}.bak`), false);
    }
    assert.equal(existsSync(statePath("codex")), false);
  }));

test("project uninstall removes the server table and its sub-table, keeps the other table, and backs up the file", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const before = [
      "[mcp_servers.other]",
      "command = 'other'",
      "",
      HEADER,
      "command = 'node'",
      "args = ['cli', 'serve']",
      "",
      `[mcp_servers.${NAME}.env]`,
      "TEST = 'x'",
      "",
    ].join("\n");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, before);
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.equal(await readFile(file, "utf8"), "[mcp_servers.other]\ncommand = 'other'\n");
    assert.equal(await readFile(`${file}.bak`, "utf8"), before);
  }));

test("install then uninstall in a project with no Codex file removes the file it created, its empty folder and the state", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const key = scopeKey("project", projectIn(root));
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    assert.equal(await readFile(file, "utf8"), serverTable(root));
    assert.equal(existsSync(`${file}.bak`), false);
    assert.deepEqual(await recordedItems("codex", key), [
      { kind: "directory", path: path.dirname(file) },
      { kind: "file", path: file, createdByUs: true },
      { kind: "toml-table", path: file, table: `mcp_servers.${NAME}` },
    ]);
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(path.dirname(file)), false);
    assert.deepEqual(await recordedItems("codex", key), []);
  }));

test("project uninstall keeps a file that this tool did not create, even when it is empty afterwards", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const before = serverTable(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, before);
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
    assert.equal(await readFile(file, "utf8"), "");
    assert.equal(await readFile(`${file}.bak`, "utf8"), before);
  }));

test("project uninstall removes the file it created, and keeps a folder that holds another file", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const folder = path.dirname(file);
    await codexAdapter.install(contextIn(root), "project");
    await writeFile(path.join(folder, "auth.json"), "{}\n");
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(folder), true);
    assert.equal(await readFile(path.join(folder, "auth.json"), "utf8"), "{}\n");
  }));

test("update of a scope with nothing recorded does nothing: a skipped step, and no command or file change", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const project = await codexAdapter.update(contextIn(root, { run: fakeRunner(effects) }), "project");
    const global = await codexAdapter.update(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(
      [...project, ...global].map((step) => step.status),
      ["skipped", "skipped"],
    );
    assert.deepEqual(effects, []);
    assert.equal(existsSync(path.dirname(configIn(root))), false);
  }));

test("update of an installed project writes its table again, once, with a backup; update of a recorded global scope runs the install again", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await codexAdapter.install(contextIn(root), "project");
    const steps = await codexAdapter.update(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.equal((await readFile(file, "utf8")).split(HEADER).length - 1, 1);
    assert.equal(await readFile(`${file}.bak`, "utf8"), serverTable(root));
    const effects: string[] = [];
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const globalSteps = await codexAdapter.update(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.equal(globalSteps[0].status, "ok");
    assert.equal(effects.length, 2);
  }));

test("a dry run through the planner changes no file, runs no command and writes no state, and lists each change in order", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    const before = Buffer.from('model = "gpt-5"\n');
    await writeFile(file, before);
    const effects: string[] = [];
    const projectCtx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: true,
      present: () => true,
      run: fakeRunner(effects),
      fs: fakeFiles(effects),
    });
    const project = await runPlan({ adapters: [codexAdapter], action: "install", agents: ["codex"], scope: "project", ctx: projectCtx });
    assert.equal(project.steps[0].status, "ok");
    assert.deepEqual(project.shown, [`mkdir ${path.dirname(file)}`, `write ${file}.bak`, `write ${file}`]);
    const globalCtx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: true,
      present: () => true,
      run: fakeRunner(effects),
      fs: fakeFiles(effects),
    });
    const global = await runPlan({ adapters: [codexAdapter], action: "install", agents: ["codex"], ctx: globalCtx });
    assert.equal(global.steps[0].status, "ok");
    assert.equal(global.shown[0], `codex mcp remove ${NAME}`);
    assert.equal(
      global.shown[1],
      [`codex mcp add ${NAME} --`, quoteLike(process.execPath), quoteLike(programIn(root)), "serve"].join(" "),
    );
    assert.deepEqual(effects, []);
    assert.deepEqual(await readFile(file), before);
    assert.equal(existsSync(`${file}.bak`), false);
    assert.equal(existsSync(statePath("codex")), false);
  }));

test("a value with a single quote or a line break is refused before anything is written, in the project scope", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const paths = [path.join(root, "O'Brien", "cli.js"), path.join(root, "line\nbreak", "cli.js")];
    for (const cliPath of paths) {
      const steps = await codexAdapter.install(contextIn(root, { cliPath, run: fakeRunner(effects) }), "project");
      assert.equal(steps[0].status, "error");
    }
    assert.deepEqual(effects, []);
    assert.equal(existsSync(path.dirname(configIn(root))), false);
    assert.equal(existsSync(statePath("codex")), false);
  }));

test("doctor reports the project table as ok, a missing file as skipped, and a file that is not valid TOML as an error", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const projectStep = (steps: Step[]): Step | undefined => steps.find((step) => step.scope === "project");
    // The global check is switched off here, so no command runs.
    await codexAdapter.install(contextIn(root), "project");
    assert.equal(projectStep(await codexAdapter.doctor(contextIn(root, { present: false })))?.status, "ok");
    await rm(file);
    assert.equal(projectStep(await codexAdapter.doctor(contextIn(root, { present: false })))?.status, "skipped");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "[broken\n");
    const broken = projectStep(await codexAdapter.doctor(contextIn(root, { present: false })));
    assert.equal(broken?.status, "error");
    assert.equal(broken?.message.includes("not valid TOML"), true);
  }));

test("doctor reports the global entry as ok when codex mcp list names it, and skipped when it does not or codex is absent", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const listing = (stdout: string): Runner =>
      fakeRunner(effects, (args) => (args[1] === "list" ? { code: 0, stdout, stderr: "" } : OK));
    const globalStep = (steps: Step[]): Step | undefined => steps.find((step) => step.scope === "global");
    const listed = globalStep(await codexAdapter.doctor(contextIn(root, { run: listing(`Name  Command\n${NAME}  node\n`) })));
    const unlisted = globalStep(await codexAdapter.doctor(contextIn(root, { run: listing("other-server  node\n") })));
    const absent = globalStep(await codexAdapter.doctor(contextIn(root, { present: false, run: listing(NAME) })));
    assert.equal(listed?.status, "ok");
    assert.equal(unlisted?.status, "skipped");
    assert.equal(absent?.status, "skipped");
    assert.deepEqual(effects, ["run codex mcp list", "run codex mcp list"]);
  }));

test("uninstall global runs codex mcp remove and forgets the scope; a failed removal is skipped as not installed globally", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const removed = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, [`run codex mcp remove ${NAME}`]);
    assert.equal(removed[0].status, "ok");
    assert.deepEqual(await recordedItems("codex", "global"), []);
    const failing = fakeRunner([], () => ({ code: 1, stdout: "", stderr: "not found" }));
    const absent = await codexAdapter.uninstall(contextIn(root, { run: failing }), "global");
    assert.equal(absent[0].status, "skipped");
    assert.equal(absent[0].message, "not installed globally");
  }));

test("uninstall global without codex on PATH runs nothing and keeps the record", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const steps = await codexAdapter.uninstall(contextIn(root, { present: false, run: fakeRunner(effects) }), "global");
    assert.equal(steps[0].status, "skipped");
    assert.deepEqual(effects, []);
    assert.deepEqual(await recordedItems("codex", "global"), [{ kind: "mcp-entry", name: NAME }]);
  }));

test("an edit that leaves the server defined in a way the header scan cannot remove is refused, and nothing changes", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    // The server is defined with a dotted key at the top of the file, which no table header names.
    const before = `mcp_servers.${NAME}.command = 'node'\n`;
    await writeFile(file, before);
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "error");
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "error");
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(existsSync(`${file}.bak`), false);
  }));

test("uninstall keeps a .codex folder that was there before the install, even when it is empty afterwards", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const folder = path.dirname(file);
    const key = scopeKey("project", projectIn(root));
    await mkdir(folder, { recursive: true });
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    assert.deepEqual(await recordedItems("codex", key), [
      { kind: "file", path: file, createdByUs: true },
      { kind: "toml-table", path: file, table: `mcp_servers.${NAME}` },
    ]);
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(folder), true);
    assert.deepEqual(await readdir(folder), []);
  }));

test("uninstall removes a .codex folder that the install created, when it is empty", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const folder = path.dirname(file);
    const key = scopeKey("project", projectIn(root));
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    assert.deepEqual(await recordedItems("codex", key), [
      { kind: "directory", path: folder },
      { kind: "file", path: file, createdByUs: true },
      { kind: "toml-table", path: file, table: `mcp_servers.${NAME}` },
    ]);
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
    assert.equal(existsSync(folder), false);
  }));

test("uninstall removes the folder the install created once its file is gone, even when the file was removed by hand", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const folder = path.dirname(file);
    const key = scopeKey("project", projectIn(root));
    await codexAdapter.install(contextIn(root), "project");
    await rm(file);
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "skipped");
    assert.equal(existsSync(folder), false);
    assert.deepEqual(await recordedItems("codex", key), []);
  }));
