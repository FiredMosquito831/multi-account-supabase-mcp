import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { codexAdapter } from "../agents/codex.js";
import type { CommandResult, Runner } from "../agents/command.js";
import { runPlan } from "../agents/plan.js";
import { SKILL_NAME } from "../agents/skill.js";
import { record, recordedItems, scopeKey, statePath } from "../agents/state.js";
import { type Context, type FileOps, type Step, UnsupportedScope, makeContext } from "../agents/types.js";
import { assertIsolated, inTemporaryRoot as inIsolatedRoot } from "./isolation.js";

const NAME = "multi-account-supabase";
const HEADER = `[mcp_servers.${NAME}]`;
const OK: CommandResult = { code: 0, stdout: "", stderr: "" };

// The skill text that the package holds in these tests. The skill tests read the real file, so these tests use a fixture.
const SKILL_TEXT = "---\nname: supabase-accounts\ndescription: Fixture for the Codex tests.\n---\n\nFixture body.\n";

// Each test runs in the shared temporary root, which points every isolated variable into the root. This file also writes the
// packaged skill text into the root, as the package does, so its helper adds that step to the shared one.
const inTemporaryRoot = (run: (root: string) => Promise<void>): Promise<void> =>
  inIsolatedRoot(async (root) => {
    const skillFolder = path.join(root, "package", "skills", SKILL_NAME);
    await mkdir(skillFolder, { recursive: true });
    await writeFile(path.join(skillFolder, "SKILL.md"), SKILL_TEXT);
    await run(root);
  });

// The paths inside a root. The program file need not exist, because the adapter only writes its path into text.
const projectIn = (root: string): string => path.join(root, "project");
const programIn = (root: string): string => path.join(root, "package", "dist", "cli.js");
const configIn = (root: string): string => path.join(root, "project", ".codex", "config.toml");
// The skill folders: the Codex home folder for the global scope, and .agents/skills in the project for the project.
const globalSkillIn = (root: string): string => path.join(root, "codex-home", "skills", SKILL_NAME);
const projectSkillIn = (root: string): string => path.join(projectIn(root), ".agents", "skills", SKILL_NAME);
const globalSkillFileIn = (root: string): string => path.join(globalSkillIn(root), "SKILL.md");
const projectSkillFileIn = (root: string): string => path.join(projectSkillIn(root), "SKILL.md");
const globalBaseIn = (root: string): string => path.join(root, "codex-home");
const globalSkillsDirIn = (root: string): string => path.join(globalBaseIn(root), "skills");
const projectAgentsIn = (root: string): string => path.join(projectIn(root), ".agents");
const projectSkillsDirIn = (root: string): string => path.join(projectAgentsIn(root), "skills");

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
    assert.deepEqual(await recordedItems("codex", "global"), [
      { kind: "mcp-entry", name: NAME },
      { kind: "directory", path: globalBaseIn(root) },
      { kind: "directory", path: globalSkillsDirIn(root) },
      { kind: "directory", path: globalSkillIn(root) },
      { kind: "file", path: globalSkillFileIn(root), createdByUs: true },
    ]);
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
      { kind: "directory", path: projectAgentsIn(root) },
      { kind: "directory", path: projectSkillsDirIn(root) },
      { kind: "directory", path: projectSkillIn(root) },
      { kind: "file", path: projectSkillFileIn(root), createdByUs: true },
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
      { kind: "directory", path: projectIn(root) },
      { kind: "directory", path: path.dirname(file) },
      { kind: "file", path: file, createdByUs: true },
      { kind: "toml-table", path: file, table: `mcp_servers.${NAME}` },
      { kind: "directory", path: projectAgentsIn(root) },
      { kind: "directory", path: projectSkillsDirIn(root) },
      { kind: "directory", path: projectSkillIn(root) },
      { kind: "file", path: projectSkillFileIn(root), createdByUs: true },
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
    assert.deepEqual(project.shown, [
      `write ${file}.bak`,
      `write ${file}`,
      `mkdir ${projectAgentsIn(root)}`,
      `mkdir ${projectSkillsDirIn(root)}`,
      `mkdir ${projectSkillIn(root)}`,
      `write ${path.join(projectSkillIn(root), "SKILL.md")}`,
    ]);
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
    assert.deepEqual(global.shown.slice(2), [
      `mkdir ${globalBaseIn(root)}`,
      `mkdir ${globalSkillsDirIn(root)}`,
      `mkdir ${globalSkillIn(root)}`,
      `write ${path.join(globalSkillIn(root), "SKILL.md")}`,
    ]);
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
    assert.deepEqual(await recordedItems("codex", "global"), [
      { kind: "mcp-entry", name: NAME },
      { kind: "directory", path: globalBaseIn(root) },
      { kind: "directory", path: globalSkillsDirIn(root) },
      { kind: "directory", path: globalSkillIn(root) },
      { kind: "file", path: globalSkillFileIn(root), createdByUs: true },
    ]);
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
      { kind: "directory", path: projectAgentsIn(root) },
      { kind: "directory", path: projectSkillsDirIn(root) },
      { kind: "directory", path: projectSkillIn(root) },
      { kind: "file", path: projectSkillFileIn(root), createdByUs: true },
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
      { kind: "directory", path: projectIn(root) },
      { kind: "directory", path: folder },
      { kind: "file", path: file, createdByUs: true },
      { kind: "toml-table", path: file, table: `mcp_servers.${NAME}` },
      { kind: "directory", path: projectAgentsIn(root) },
      { kind: "directory", path: projectSkillsDirIn(root) },
      { kind: "directory", path: projectSkillIn(root) },
      { kind: "file", path: projectSkillFileIn(root), createdByUs: true },
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

test("global install writes the skill into the CODEX_HOME folder and records the folder it created; uninstall removes both", () =>
  inTemporaryRoot(async (root) => {
    const folder = globalSkillIn(root);
    const steps = await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    assert.equal(steps[0].status, "ok");
    assert.equal(await readFile(path.join(folder, "SKILL.md"), "utf8"), SKILL_TEXT);
    assert.deepEqual(await recordedItems("codex", "global"), [
      { kind: "mcp-entry", name: NAME },
      { kind: "directory", path: globalBaseIn(root) },
      { kind: "directory", path: globalSkillsDirIn(root) },
      { kind: "directory", path: folder },
      { kind: "file", path: globalSkillFileIn(root), createdByUs: true },
    ]);
    assert.equal((await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global"))[0].status, "ok");
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(globalBaseIn(root)), false);
    assert.deepEqual(await recordedItems("codex", "global"), []);
  }));

test("global install keeps a skill folder that existed before, does not record it, and uninstall keeps the folder", () =>
  inTemporaryRoot(async (root) => {
    const folder = globalSkillIn(root);
    await mkdir(folder, { recursive: true });
    assert.equal((await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global"))[0].status, "ok");
    assert.deepEqual(await recordedItems("codex", "global"), [
      { kind: "mcp-entry", name: NAME },
      { kind: "file", path: globalSkillFileIn(root), createdByUs: true },
    ]);
    assert.equal((await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global"))[0].status, "ok");
    assert.equal(existsSync(folder), true);
  }));

test("project uninstall removes the skill folder the install created, and keeps an .agents folder that holds other files", () =>
  inTemporaryRoot(async (root) => {
    const folder = projectSkillIn(root);
    const agents = path.join(projectIn(root), ".agents");
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    assert.equal(await readFile(path.join(folder, "SKILL.md"), "utf8"), SKILL_TEXT);
    await writeFile(path.join(agents, "notes.txt"), "kept\n");
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
    assert.equal(existsSync(folder), false);
    assert.equal(await readFile(path.join(agents, "notes.txt"), "utf8"), "kept\n");
  }));

test("a dry run of a Codex install lists the skill write in each scope, and writes no skill file", () =>
  inTemporaryRoot(async (root) => {
    const dryContext = (): Context =>
      makeContext({
        projectDir: projectIn(root),
        cliPath: programIn(root),
        packageRoot: path.join(root, "package"),
        dryRun: true,
        present: () => true,
        run: fakeRunner([]),
      });
    const globalCtx = dryContext();
    await codexAdapter.install(globalCtx, "global");
    assert.ok(globalCtx.shown.includes(`write ${path.join(globalSkillIn(root), "SKILL.md")}`));
    const projectCtx = dryContext();
    await codexAdapter.install(projectCtx, "project");
    assert.ok(projectCtx.shown.includes(`write ${path.join(projectSkillIn(root), "SKILL.md")}`));
    assert.equal(existsSync(path.join(globalSkillIn(root), "SKILL.md")), false);
    assert.equal(existsSync(path.join(projectSkillIn(root), "SKILL.md")), false);
  }));

test("an empty CODEX_HOME counts as not set, so the global skill folder is in the .codex folder of the home folder", () =>
  inTemporaryRoot(async (root) => {
    process.env.CODEX_HOME = "";
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: true,
      present: () => true,
      run: fakeRunner([]),
    });
    await codexAdapter.install(ctx, "global");
    assert.ok(ctx.shown.includes(`mkdir ${path.join(root, "home", ".codex", "skills", SKILL_NAME)}`));
  }));

test("project install refuses a SKILL.md that this tool did not create: the error names it, and nothing is written", () =>
  inTemporaryRoot(async (root) => {
    const file = projectSkillFileIn(root);
    await mkdir(projectSkillIn(root), { recursive: true });
    await writeFile(file, "The owner's own skill.\n");
    const steps = await codexAdapter.install(contextIn(root), "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(file), true);
    assert.equal(steps[0].message.includes("not created by this tool"), true);
    assert.equal(await readFile(file, "utf8"), "The owner's own skill.\n");
    assert.equal(existsSync(configIn(root)), false);
    assert.deepEqual(await recordedItems("codex", scopeKey("project", projectIn(root))), []);
  }));

test("global install refuses a SKILL.md that this tool did not create, before any codex command runs", () =>
  inTemporaryRoot(async (root) => {
    const file = globalSkillFileIn(root);
    await mkdir(globalSkillIn(root), { recursive: true });
    await writeFile(file, "The owner's own skill.\n");
    const effects: string[] = [];
    const steps = await codexAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(file), true);
    assert.equal(steps[0].message.includes("not created by this tool"), true);
    assert.deepEqual(effects, []);
    assert.equal(await readFile(file, "utf8"), "The owner's own skill.\n");
    assert.deepEqual(await recordedItems("codex", "global"), []);
  }));

test("a repeat install over the SKILL.md this tool wrote succeeds, and rewrites the file", () =>
  inTemporaryRoot(async (root) => {
    const file = projectSkillFileIn(root);
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    await writeFile(file, "Changed by hand.\n");
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    assert.equal(await readFile(file, "utf8"), SKILL_TEXT);
    const items = await recordedItems("codex", scopeKey("project", projectIn(root)));
    assert.equal(items.some((item) => item.kind === "file" && item.path === file && item.createdByUs), true);
  }));

test("uninstall removes the SKILL.md this tool wrote into a folder that existed before, and keeps the folder", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectSkillIn(root), { recursive: true });
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
    assert.equal(existsSync(projectSkillFileIn(root)), false);
    assert.equal(existsSync(projectSkillIn(root)), true);
  }));

test("project install and uninstall leave no .agents folder when the install made it", () =>
  inTemporaryRoot(async (root) => {
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    assert.equal(existsSync(projectSkillIn(root)), true);
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
    assert.equal(existsSync(projectSkillIn(root)), false);
    assert.equal(existsSync(projectSkillsDirIn(root)), false);
    assert.equal(existsSync(projectAgentsIn(root)), false);
  }));

test("project uninstall keeps an .agents folder that already held another file, and removes the folders this tool made", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectAgentsIn(root), { recursive: true });
    await writeFile(path.join(projectAgentsIn(root), "other.txt"), "kept\n");
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
    assert.equal(await readFile(path.join(projectAgentsIn(root), "other.txt"), "utf8"), "kept\n");
    assert.equal(existsSync(projectSkillsDirIn(root)), false);
    assert.equal(existsSync(projectSkillIn(root)), false);
  }));

test("a dry run of a project install lists each folder it would create, and creates none", () =>
  inTemporaryRoot(async (root) => {
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: true,
      present: () => true,
      run: fakeRunner([]),
    });
    assert.equal((await codexAdapter.install(ctx, "project"))[0].status, "ok");
    for (const folder of [projectAgentsIn(root), projectSkillsDirIn(root), projectSkillIn(root)]) {
      assert.ok(ctx.shown.includes(`mkdir ${folder}`), `the dry run lists ${folder}`);
    }
    assert.equal(existsSync(projectAgentsIn(root)), false);
    assert.deepEqual(await recordedItems("codex", scopeKey("project", projectIn(root))), []);
  }));

// File functions for a real run in which the write of one file fails, as it would on a full disk. Every other change is made
// on the disk.
const filesFailingWriteOf = (failing: string): FileOps => ({
  writeFile: async (file, text) => {
    if (file === failing) {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    }
    await writeFile(file, text, "utf8");
  },
  removeFile: async (file) => {
    await rm(file, { force: true });
  },
  ensureDir: async (dir) => {
    await mkdir(dir);
  },
  removeDirIfEmpty: async (dir) => {
    try {
      await rmdir(dir);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
        throw error;
      }
    }
  },
});

test("every folder variable of a test points into its temporary root", () =>
  inTemporaryRoot(async (root) => {
    assertIsolated(root);
  }));

test("global install reads the packaged skill before it changes anything: a missing skill text stops it, with no codex command and no folder", () =>
  inTemporaryRoot(async (root) => {
    await rm(path.join(root, "package", "skills", SKILL_NAME, "SKILL.md"));
    const effects: string[] = [];
    const steps = await codexAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.equal(steps[0].status, "error");
    assert.deepEqual(effects, []);
    assert.equal(existsSync(globalBaseIn(root)), false);
    assert.deepEqual(await recordedItems("codex", "global"), []);
  }));

test("project install reads the packaged skill before it writes the project file", () =>
  inTemporaryRoot(async (root) => {
    await rm(path.join(root, "package", "skills", SKILL_NAME, "SKILL.md"));
    const steps = await codexAdapter.install(contextIn(root), "project");
    assert.equal(steps[0].status, "error");
    assert.equal(existsSync(configIn(root)), false);
    assert.equal(existsSync(projectAgentsIn(root)), false);
    assert.deepEqual(await recordedItems("codex", scopeKey("project", projectIn(root))), []);
  }));

test("project install refuses a regular file on the way to the skill folder before it writes the project file", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectIn(root), { recursive: true });
    await writeFile(projectAgentsIn(root), "not a folder\n");
    const steps = await codexAdapter.install(contextIn(root), "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(projectAgentsIn(root)), true);
    assert.equal(existsSync(configIn(root)), false);
    assert.equal(await readFile(projectAgentsIn(root), "utf8"), "not a folder\n");
    assert.deepEqual(await recordedItems("codex", scopeKey("project", projectIn(root))), []);
  }));

test("uninstall removes the skill in the folder the record lists, even when CODEX_HOME now points elsewhere", () =>
  inTemporaryRoot(async (root) => {
    const folder = globalSkillIn(root);
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    process.env.CODEX_HOME = path.join(root, "elsewhere");
    assert.equal((await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global"))[0].status, "ok");
    assert.equal(existsSync(path.join(folder, "SKILL.md")), false);
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(globalBaseIn(root)), false);
    assert.deepEqual(await recordedItems("codex", "global"), []);
  }));

test("uninstall keeps a SKILL.md that the record does not list, even inside a folder the record lists", () =>
  inTemporaryRoot(async (root) => {
    await record("codex", scopeKey("project", projectIn(root)), { kind: "directory", path: projectSkillIn(root) });
    await mkdir(projectSkillIn(root), { recursive: true });
    await writeFile(projectSkillFileIn(root), "The owner's own skill.\n");
    await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(await readFile(projectSkillFileIn(root), "utf8"), "The owner's own skill.\n");
  }));

test("a dry run says what would happen in each step, and never what happened", () =>
  inTemporaryRoot(async (root) => {
    const dryContext = (): Context =>
      makeContext({
        projectDir: projectIn(root),
        cliPath: programIn(root),
        packageRoot: path.join(root, "package"),
        dryRun: true,
        present: () => true,
        run: fakeRunner([]),
      });
    const globalStep = await codexAdapter.install(dryContext(), "global");
    assert.match(globalStep[0].message, /^Would add the server to the global Codex configuration\. Would write the skill to /);
    const projectStep = await codexAdapter.install(dryContext(), "project");
    assert.equal(projectStep[0].message.startsWith("Would write the server table to "), true);
    assert.equal(projectStep[0].message.includes("Would write the skill to "), true);
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const removed = await codexAdapter.uninstall(dryContext(), "global");
    assert.match(removed[0].message, /^Would remove the server from the global Codex configuration\./);
  }));

test("a failed write of the skill still leaves its folder and file in the record, so uninstall removes the folder", () =>
  inTemporaryRoot(async (root) => {
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingWriteOf(projectSkillFileIn(root)),
    });
    const steps = await codexAdapter.install(ctx, "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("no space left"), true);
    const items = await recordedItems("codex", scopeKey("project", projectIn(root)));
    assert.equal(items.some((item) => item.kind === "directory" && item.path === projectSkillIn(root)), true);
    assert.equal(items.some((item) => item.kind === "file" && item.path === projectSkillFileIn(root) && item.createdByUs), true);
    await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(existsSync(projectSkillIn(root)), false);
  }));

test("a second install over our own SKILL.md writes no backup file, so the skill folder holds only SKILL.md", () =>
  inTemporaryRoot(async (root) => {
    assert.equal((await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global"))[0].status, "ok");
    assert.equal((await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global"))[0].status, "ok");
    assert.deepEqual(await readdir(globalSkillIn(root)), ["SKILL.md"]);
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    assert.deepEqual(await readdir(projectSkillIn(root)), ["SKILL.md"]);
  }));

// File functions for a real run in which one folder cannot be made, as the system may refuse it. Every other folder is made, and
// removed again on the disk.
const filesRefusing = (refused: string): FileOps => ({
  writeFile: async (file, text) => {
    await writeFile(file, text, "utf8");
  },
  removeFile: async (file) => {
    await rm(file, { force: true });
  },
  ensureDir: async (dir) => {
    if (dir === refused) {
      throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${dir}'`), { code: "EPERM" });
    }
    await mkdir(dir);
  },
  removeDirIfEmpty: async (dir) => {
    try {
      await rmdir(dir);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
        throw error;
      }
    }
  },
});

test("a folder that the skill install cannot make records nothing: the call throws, the folders it made are gone, and no skill item is recorded", () =>
  inTemporaryRoot(async (root) => {
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesRefusing(projectSkillIn(root)),
    });
    const steps = await codexAdapter.install(ctx, "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("EPERM"), true);
    const items = await recordedItems("codex", scopeKey("project", projectIn(root)));
    assert.equal(items.some((item) => item.kind === "file" && item.path === projectSkillFileIn(root)), false);
    assert.equal(items.some((item) => item.kind === "directory" && item.path === projectSkillIn(root)), false);
    assert.equal(existsSync(projectAgentsIn(root)), false);
  }));

test("a state file that cannot be read stops a first install before any codex command or folder is made, in both scopes", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(path.dirname(statePath("codex")), { recursive: true });
    await writeFile(statePath("codex"), "not json\n");
    const effects: string[] = [];
    const global = await codexAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.equal(global[0].status, "error");
    assert.deepEqual(effects, []);
    assert.equal(existsSync(globalBaseIn(root)), false);
    const project = await codexAdapter.install(contextIn(root), "project");
    assert.equal(project[0].status, "error");
    assert.equal(existsSync(configIn(root)), false);
    assert.equal(existsSync(path.dirname(configIn(root))), false);
  }));

test("uninstall says in its step which skill file it removed, in a dry run and in a real run, and also when the config is gone", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const dry = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: true,
      present: () => true,
      run: fakeRunner([]),
    });
    const dryStep = await codexAdapter.uninstall(dry, "global");
    assert.equal(dryStep[0].message.includes(`Would remove the skill file ${globalSkillFileIn(root)}`), true);
    const realStep = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global");
    assert.equal(realStep[0].message.includes(`Removed the skill file ${globalSkillFileIn(root)}`), true);
    await codexAdapter.install(contextIn(root), "project");
    await rm(configIn(root));
    const projectStep = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(projectStep[0].message.includes(`Removed the skill file ${projectSkillFileIn(root)}`), true);
  }));

test("uninstall with no record keeps an owner's SKILL.md that sits where the skill would be", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectSkillIn(root), { recursive: true });
    await writeFile(projectSkillFileIn(root), "The owner's own skill.\n");
    await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(await readFile(projectSkillFileIn(root), "utf8"), "The owner's own skill.\n");
  }));

test("a CODEX_HOME that lies under a regular file stops the install with an error step that says nothing was changed", () =>
  inTemporaryRoot(async (root) => {
    const blocker = path.join(root, "blocker");
    await writeFile(blocker, "a file\n");
    process.env.CODEX_HOME = path.join(blocker, "codex");
    const effects: string[] = [];
    const steps = await codexAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("is not a folder"), true);
    assert.equal(steps[0].message.includes("nothing was changed"), true);
    assert.deepEqual(effects, []);
  }));

// File functions for a real run in which the removal of one file fails. Every other change is made on the disk.
const filesFailingRemoveOf = (failing: string): FileOps => ({
  writeFile: async (file, text) => {
    await writeFile(file, text, "utf8");
  },
  removeFile: async (file) => {
    if (file === failing) {
      throw Object.assign(new Error("EPERM: operation not permitted, unlink"), { code: "EPERM" });
    }
    await rm(file, { force: true });
  },
  ensureDir: async (dir) => {
    await mkdir(dir, { recursive: true });
  },
  removeDirIfEmpty: async (dir) => {
    try {
      await rmdir(dir);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
        throw error;
      }
    }
  },
});

test("a global install whose skill cannot be written says the server entry was added and recorded, in an error step", () =>
  inTemporaryRoot(async (root) => {
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingWriteOf(globalSkillFileIn(root)),
    });
    const steps = await codexAdapter.install(ctx, "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("was added and recorded"), true);
    assert.equal(steps[0].message.includes("no space left"), true);
  }));

test("a project install whose skill cannot be written says the server table was written and recorded, in an error step", () =>
  inTemporaryRoot(async (root) => {
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingWriteOf(projectSkillFileIn(root)),
    });
    const steps = await codexAdapter.install(ctx, "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("server table was written"), true);
    assert.equal(steps[0].message.includes("no space left"), true);
  }));

test("an uninstall whose skill file cannot be removed gives an error step, and keeps the record for a later attempt", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingRemoveOf(globalSkillFileIn(root)),
    });
    const steps = await codexAdapter.uninstall(ctx, "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("could not be removed"), true);
    assert.equal((await recordedItems("codex", "global")).some((item) => item.kind === "mcp-entry"), true);
  }));

test("a state file that is a folder stops the install, and the error says nothing was changed", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(statePath("codex"), { recursive: true });
    const effects: string[] = [];
    const steps = await codexAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("nothing was changed"), true);
    assert.deepEqual(effects, []);
  }));

test("uninstall with no record keeps a skill folder and file that the owner placed under CODEX_HOME", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(globalSkillIn(root), { recursive: true });
    await writeFile(globalSkillFileIn(root), "The owner's own skill.\n");
    await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global");
    assert.equal(await readFile(globalSkillFileIn(root), "utf8"), "The owner's own skill.\n");
    assert.equal(existsSync(globalSkillIn(root)), true);
  }));

test("uninstall with no record keeps an empty skill folder and an empty .agents folder that the owner made", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(globalSkillIn(root), { recursive: true });
    await mkdir(projectAgentsIn(root), { recursive: true });
    await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global");
    assert.equal(existsSync(globalSkillIn(root)), true);
    assert.equal(existsSync(projectAgentsIn(root)), true);
  }));

test("uninstall with no record keeps an .agents folder that holds the owner's skill folder and other files", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectSkillIn(root), { recursive: true });
    await writeFile(projectSkillFileIn(root), "The owner's own skill.\n");
    await writeFile(path.join(projectAgentsIn(root), "other.txt"), "kept\n");
    await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(await readFile(projectSkillFileIn(root), "utf8"), "The owner's own skill.\n");
    assert.equal(await readFile(path.join(projectAgentsIn(root), "other.txt"), "utf8"), "kept\n");
  }));

test("uninstall with no record keeps an empty skill folder, and the .agents folder that holds it, that the owner made", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectSkillIn(root), { recursive: true });
    await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(existsSync(projectSkillIn(root)), true);
    assert.equal(existsSync(projectAgentsIn(root)), true);
  }));

test("uninstall with no record leaves a skill under a CODEX_HOME that points at it, since nothing records it", () =>
  inTemporaryRoot(async (root) => {
    const elsewhere = path.join(root, "elsewhere", "skills", SKILL_NAME);
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(elsewhere, "SKILL.md"), "The owner's own skill.\n");
    process.env.CODEX_HOME = path.join(root, "elsewhere");
    await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global");
    assert.equal(await readFile(path.join(elsewhere, "SKILL.md"), "utf8"), "The owner's own skill.\n");
  }));

test("uninstall with no record names no skill file in its step, since it removes none", () =>
  inTemporaryRoot(async (root) => {
    const steps = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global");
    assert.equal(steps[0].message.includes("skill file"), false);
  }));

test("an uninstall whose project skill file cannot be removed gives an error step after the table is removed, and keeps the record", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root), "project");
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingRemoveOf(projectSkillFileIn(root)),
    });
    const steps = await codexAdapter.uninstall(ctx, "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("The server table was removed"), true);
    assert.equal(steps[0].message.includes("could not be removed"), true);
    const items = await recordedItems("codex", scopeKey("project", projectIn(root)));
    assert.equal(items.some((item) => item.kind === "toml-table"), true);
  }));

test("uninstall global with a state file that cannot be read gives the refusal, and runs no codex command", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(path.dirname(statePath("codex")), { recursive: true });
    await writeFile(statePath("codex"), "not json\n");
    const effects: string[] = [];
    const steps = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("The agent state file cannot be read, so nothing was changed"), true);
    assert.deepEqual(effects, []);
  }));
