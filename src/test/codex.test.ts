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
import { saveHooks } from "../accounts/registry.js";
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
    // The owner's project folder exists, as it does in use. An install refuses a project folder that is missing.
    await mkdir(path.join(root, "project"), { recursive: true });
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

// The records as a previous install would have left them: the global entry, and the project table of this root.
const recordEntry = (): Promise<void> => record("codex", "global", { kind: "mcp-entry", name: NAME });
const recordTable = (root: string): Promise<void> =>
  record("codex", scopeKey("project", projectIn(root)), {
    kind: "toml-table",
    path: configIn(root),
    table: `mcp_servers.${NAME}`,
  });

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

// A context for a dry run in the temporary folders.
const dryContextIn = (root: string, options: { run?: Runner; env?: NodeJS.ProcessEnv } = {}): Context =>
  makeContext({
    projectDir: projectIn(root),
    cliPath: programIn(root),
    packageRoot: path.join(root, "package"),
    dryRun: true,
    present: () => true,
    run: options.run ?? fakeRunner([]),
    env: options.env,
  });

// How the command line of a dry run shows an argument: quoted when it has a space or a double quote.
const quoteLike = (part: string): string => (/[\s"]/.test(part) ? `"${part}"` : part);

// Makes every rename fail with a code that is not retried, so a save of the state file fails, as it would on a full disk. The real
// rename is put back afterwards, even when the call fails.
const withFailingRename = async <T>(run: () => Promise<T>): Promise<T> => {
  const real = saveHooks.rename;
  saveHooks.rename = async () => {
    throw Object.assign(new Error("EIO: input/output error, rename"), { code: "EIO" });
  };
  try {
    return await run();
  } finally {
    saveHooks.rename = real;
  }
};

test("the adapter accepts the global and project scopes, and refuses the local scope", () =>
  inTemporaryRoot(async (root) => {
    assert.deepEqual([...codexAdapter.scopes], ["global", "project"]);
    await assert.rejects(codexAdapter.install(contextIn(root), "local"), UnsupportedScope);
    await assert.rejects(codexAdapter.update(contextIn(root), "local"), UnsupportedScope);
    await assert.rejects(codexAdapter.uninstall(contextIn(root), "local"), UnsupportedScope);
  }));

test("global install lists codex mcp first, then adds the entry, and records an mcp-entry", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await codexAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, [
      "run codex mcp list",
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

test("a failed add gives the first line of its error output, and the first line of its standard output when the error output is empty", () =>
  inTemporaryRoot(async (root) => {
    const twoLines = fakeRunner([], (args) =>
      args[1] === "add" ? { code: 2, stdout: "", stderr: "first problem\nsecond line\n" } : OK,
    );
    const outputOnly = fakeRunner([], (args) =>
      args[1] === "add" ? { code: 2, stdout: "\nout line\nmore\n", stderr: "" } : OK,
    );
    const first = await codexAdapter.install(contextIn(root, { run: twoLines }), "global");
    const second = await codexAdapter.install(contextIn(root, { run: outputOnly }), "global");
    assert.equal(first[0].message, "first problem");
    assert.equal(second[0].message, "out line");
  }));

test("global install refuses an entry this tool did not write: the listing names it, so no add runs and nothing is recorded", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const listing = fakeRunner(effects, (args) =>
      args[1] === "list" ? { code: 0, stdout: `${NAME}  node  serve\n`, stderr: "" } : OK,
    );
    const steps = await codexAdapter.install(contextIn(root, { run: listing }), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(NAME), true);
    assert.equal(steps[0].message.includes("did not write"), true);
    assert.deepEqual(effects, ["run codex mcp list"]);
    assert.deepEqual(await recordedItems("codex", "global"), []);
    assert.equal(existsSync(globalSkillFileIn(root)), false);
  }));

test("global install stops when codex mcp list fails, and runs no add", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const failing = fakeRunner(effects, (args) =>
      args[1] === "list" ? { code: 2, stdout: "", stderr: "list broke\nmore\n" } : OK,
    );
    const steps = await codexAdapter.install(contextIn(root, { run: failing }), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("list broke"), true);
    assert.equal(steps[0].message.includes("nothing was changed"), true);
    assert.deepEqual(effects, ["run codex mcp list"]);
  }));

test("a listing that names the entry as a later word, not the first, counts as listed, so the install stops and runs no add", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const listing = fakeRunner(effects, (args) =>
      args[1] === "list" ? { code: 0, stdout: `other-server  node  ${NAME}\n`, stderr: "" } : OK,
    );
    const steps = await codexAdapter.install(contextIn(root, { run: listing }), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("Codex already lists a server named"), true);
    assert.deepEqual(effects, ["run codex mcp list"]);
  }));

test("a listing that names a longer word that only starts with the entry's name does not count, so the add runs", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const listing = fakeRunner(effects, (args) =>
      args[1] === "list" ? { code: 0, stdout: `other-server  node  ${NAME}-old\n`, stderr: "" } : OK,
    );
    const steps = await codexAdapter.install(contextIn(root, { run: listing }), "global");
    assert.equal(steps[0].status, "ok");
    assert.equal(effects.length, 2);
  }));

test("a failed add over a recorded entry says the entry was removed and the record still lists it, and says nothing of a removal that failed", () =>
  inTemporaryRoot(async (root) => {
    await recordEntry();
    const addFails = (removal: CommandResult): Runner =>
      fakeRunner([], (args) => {
        if (args[1] === "remove") {
          return removal;
        }
        return args[1] === "add" ? { code: 1, stdout: "", stderr: "add refused\n" } : OK;
      });
    const removed = await codexAdapter.install(contextIn(root, { run: addFails(OK) }), "global");
    assert.equal(removed[0].status, "error");
    assert.equal(
      removed[0].message,
      "The server was removed from codex, but adding it again failed, so codex no longer lists it. The record still lists it. add refused",
    );
    assert.deepEqual(await recordedItems("codex", "global"), [{ kind: "mcp-entry", name: NAME }]);
    const notRemoved = await codexAdapter.install(
      contextIn(root, { run: addFails({ code: 1, stdout: "", stderr: `No MCP server named ${NAME} is configured.\n` }) }),
      "global",
    );
    assert.equal(notRemoved[0].status, "error");
    assert.equal(notRemoved[0].message, "add refused");
  }));

test("global install with codex not on PATH stops before any command, in a real run and in a dry run", () =>
  inTemporaryRoot(async (root) => {
    for (const dryRun of [false, true]) {
      const effects: string[] = [];
      const ctx = makeContext({
        projectDir: projectIn(root),
        cliPath: programIn(root),
        packageRoot: path.join(root, "package"),
        dryRun,
        present: () => false,
        run: fakeRunner(effects),
      });
      const steps = await codexAdapter.install(ctx, "global");
      assert.equal(steps[0].status, "error");
      assert.deepEqual(effects, []);
      assert.deepEqual(ctx.shown, []);
    }
    assert.deepEqual(await recordedItems("codex", "global"), []);
  }));

test("a dry run of a fresh global install says the listing is not run, and runs no listing", () =>
  inTemporaryRoot(async (root) => {
    const ctx = dryContextIn(root);
    const steps = await codexAdapter.install(ctx, "global");
    assert.equal(steps[0].status, "ok");
    assert.equal(steps[0].message.includes("The listing of codex mcp list is not run in a dry run"), true);
    assert.equal(ctx.shown.some((line) => line.startsWith("codex mcp list")), false);
    assert.equal(ctx.shown.some((line) => line.startsWith("codex mcp add")), true);
  }));

test("install global over a recorded entry removes that entry, then adds it, and runs no listing", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const steps = await codexAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(effects, [
      `run codex mcp remove ${NAME}`,
      `run codex mcp add ${NAME} -- ${process.execPath} ${programIn(root)} serve`,
    ]);
  }));

test("install global, when the record cannot be written after a fresh add, removes the entry again and reports an error", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await withFailingRename(() =>
      codexAdapter.install(contextIn(root, { run: fakeRunner(effects) }), "global"),
    );
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("could not be recorded"), true);
    assert.equal(steps[0].message.includes("removed again"), true);
    assert.deepEqual(effects, [
      "run codex mcp list",
      `run codex mcp add ${NAME} -- ${process.execPath} ${programIn(root)} serve`,
      `run codex mcp remove ${NAME}`,
    ]);
    assert.deepEqual(await recordedItems("codex", "global"), []);
  }));

test("when that removal fails too, the step gives the exact command for the owner to run", () =>
  inTemporaryRoot(async (root) => {
    const run = fakeRunner([], (args) =>
      args[1] === "remove" ? { code: 1, stdout: "", stderr: "remove refused\n" } : OK,
    );
    const steps = await withFailingRename(() => codexAdapter.install(contextIn(root, { run }), "global"));
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(`codex mcp remove ${NAME}`), true);
    assert.equal(steps[0].message.includes("remove refused"), true);
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

test("project install over a table this tool wrote replaces it, keeps the other tables byte for byte, and keeps the old file as a backup", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, BEFORE_INSTALL);
    await recordTable(root);
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
      { kind: "file", path: `${file}.bak`, createdByUs: true },
      { kind: "directory", path: projectAgentsIn(root) },
      { kind: "directory", path: projectSkillsDirIn(root) },
      { kind: "directory", path: projectSkillIn(root) },
      { kind: "file", path: projectSkillFileIn(root), createdByUs: true },
    ]);
  }));

test("project install refuses a table this tool did not write: the error names it, and the file keeps its bytes", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    const before = serverTable(root);
    await writeFile(file, before);
    const steps = await codexAdapter.install(contextIn(root), "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(`mcp_servers.${NAME}`), true);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(existsSync(`${file}.bak`), false);
    assert.deepEqual(await recordedItems("codex", scopeKey("project", projectIn(root))), []);
    assert.equal(existsSync(projectSkillIn(root)), false);
  }));

test("project update over a table this tool did not write is skipped, and changes nothing", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    const before = serverTable(root);
    await writeFile(file, before);
    const steps = await codexAdapter.update(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(existsSync(`${file}.bak`), false);
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

test("project uninstall removes the recorded server table, keeps the other table, and keeps the file as a backup", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const before = ["[mcp_servers.other]", "command = 'other'", "", serverTable(root)].join("\n");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, before);
    await recordTable(root);
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.equal(await readFile(file, "utf8"), "[mcp_servers.other]\ncommand = 'other'\n");
    assert.equal(await readFile(`${file}.bak`, "utf8"), before);
  }));

test("project uninstall with no table record keeps a table written by hand, and changes no file", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, serverTable(root));
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(steps[0].message.includes("was not written by this tool"), true);
    assert.equal(await readFile(file, "utf8"), serverTable(root));
    assert.equal(existsSync(`${file}.bak`), false);
  }));

test("project uninstall with nothing recorded and no file is skipped, runs nothing, and creates nothing", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(steps[0].message.includes("not installed in this scope"), true);
    assert.deepEqual(effects, []);
    assert.equal(existsSync(path.dirname(configIn(root))), false);
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
      { kind: "directory", path: projectAgentsIn(root) },
      { kind: "directory", path: projectSkillsDirIn(root) },
      { kind: "directory", path: projectSkillIn(root) },
      { kind: "file", path: projectSkillFileIn(root), createdByUs: true },
    ]);
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(path.dirname(file)), false);
    // The project folder is the owner's. The install did not record it, so uninstall leaves it in place.
    assert.equal(existsSync(projectIn(root)), true);
    assert.deepEqual(await recordedItems("codex", key), []);
  }));

test("project uninstall keeps a file that this tool did not create, even when it is empty afterwards", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const before = serverTable(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, before);
    await recordTable(root);
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

test("a backup takes the next free name, so an existing backup is never overwritten", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const original = 'model = "gpt-5"\n';
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.bak`, "the owner's backup\n");
    await writeFile(file, original);
    const steps = await codexAdapter.install(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.equal(await readFile(`${file}.bak`, "utf8"), "the owner's backup\n");
    assert.equal(await readFile(`${file}.bak2`, "utf8"), original);
    assert.equal(steps[0].message.includes(`as ${file}.bak2.`), true);
    assert.equal(
      (await recordedItems("codex", scopeKey("project", projectIn(root)))).some(
        (item) => item.kind === "file" && item.path === `${file}.bak2` && item.createdByUs,
      ),
      true,
    );
  }));

test("install, update and uninstall keep every backup, and each step names the backup it made or kept", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const original = 'model = "gpt-5"\n\n[other]\nk = 1\n';
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, original);
    const installed = await codexAdapter.install(contextIn(root), "project");
    assert.equal(installed[0].status, "ok");
    assert.equal(installed[0].message.includes(`as ${file}.bak.`), true);
    const afterInstall = await readFile(file, "utf8");
    const updated = await codexAdapter.update(contextIn(root), "project");
    assert.equal(updated[0].status, "ok");
    assert.equal(await readFile(`${file}.bak2`, "utf8"), afterInstall);
    const afterUpdate = await readFile(file, "utf8");
    const removed = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(removed[0].status, "ok");
    assert.equal(await readFile(`${file}.bak`, "utf8"), original);
    assert.equal(await readFile(`${file}.bak3`, "utf8"), afterUpdate);
    assert.equal(removed[0].message.includes(`Kept the previous file as ${file}.bak3.`), true);
    assert.equal(removed[0].message.includes(`The backups kept are: ${file}.bak, ${file}.bak2, ${file}.bak3.`), true);
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
    assert.equal(
      global.shown[0],
      [`codex mcp add ${NAME} --`, quoteLike(process.execPath), quoteLike(programIn(root)), "serve"].join(" "),
    );
    assert.deepEqual(global.shown.slice(1), [
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

// The refusal of a value with a single quote or a line break, as the step says it.
const REFUSED_TEXT =
  "The server entry has a single quote or a line break, which the project file cannot hold, so nothing was changed.";

test("a value with a single quote or a line break is refused before anything is written, in the project scope", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const paths = [path.join(root, "O'Brien", "cli.js"), path.join(root, "line\nbreak", "cli.js")];
    for (const cliPath of paths) {
      const steps = await codexAdapter.install(contextIn(root, { cliPath, run: fakeRunner(effects) }), "project");
      assert.equal(steps[0].message, REFUSED_TEXT);
    }
    assert.deepEqual(effects, []);
    assert.equal(existsSync(path.dirname(configIn(root))), false);
    assert.equal(existsSync(statePath("codex")), false);
  }));

test("doctor reports the recorded project table as ok, a missing file as skipped, and a file that is not valid TOML as an error", () =>
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

test("doctor does not count a foreign value under the server's key as the recorded table", () =>
  inTemporaryRoot(async (root) => {
    await recordTable(root);
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `[mcp_servers]\n${NAME} = "other"\n`);
    const steps = await codexAdapter.doctor(contextIn(root, { present: false }));
    assert.equal(steps.find((step) => step.scope === "project")?.status, "skipped");
  }));

test("doctor gives no step for a scope with no record, in either scope", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const listing = fakeRunner(effects, (args) => (args[1] === "list" ? { code: 0, stdout: `${NAME}  node\n`, stderr: "" } : OK));
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, serverTable(root));
    const steps = await codexAdapter.doctor(contextIn(root, { run: listing }));
    assert.deepEqual(steps, []);
    assert.deepEqual(effects, []);
  }));

test("doctor reports the recorded global entry as ok only when codex mcp list names it as the first word of a line, and skipped otherwise", () =>
  inTemporaryRoot(async (root) => {
    await recordEntry();
    const effects: string[] = [];
    const listing = (stdout: string, code = 0): Runner =>
      fakeRunner(effects, (args) => (args[1] === "list" ? { code, stdout, stderr: "" } : OK));
    const globalStep = (steps: Step[]): Step | undefined => steps.find((step) => step.scope === "global");
    const check = async (run: Runner, present = true): Promise<Step | undefined> =>
      globalStep(await codexAdapter.doctor(contextIn(root, { present, run })));
    assert.equal((await check(listing(`Name  Command\n${NAME}  node\n`)))?.status, "ok");
    assert.equal((await check(listing("other-server  node\n")))?.status, "skipped");
    assert.equal((await check(listing(`other-server  node  ${NAME}\n`)))?.status, "skipped");
    assert.equal((await check(listing(`${NAME}  node\n`, 1)))?.status, "skipped");
    assert.equal((await check(listing(NAME), false))?.status, "skipped");
    assert.deepEqual(effects, [
      "run codex mcp list",
      "run codex mcp list",
      "run codex mcp list",
      "run codex mcp list",
    ]);
  }));

test("doctor in a dry run runs no listing, and its global step says the listing was not run", () =>
  inTemporaryRoot(async (root) => {
    await recordEntry();
    const effects: string[] = [];
    const ctx = dryContextIn(root, { run: fakeRunner(effects) });
    const steps = await codexAdapter.doctor(ctx);
    assert.deepEqual(effects, []);
    assert.deepEqual(ctx.shown, []);
    const global = steps.find((step) => step.scope === "global");
    assert.equal(global?.status, "skipped");
    assert.equal(global?.message.includes("was not run"), true);
  }));

test("uninstall global runs codex mcp remove and forgets the scope; a removal that says the entry is not installed is reported as not installed globally", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const effects: string[] = [];
    const removed = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.deepEqual(effects, [`run codex mcp remove ${NAME}`]);
    assert.equal(removed[0].status, "ok");
    assert.deepEqual(await recordedItems("codex", "global"), []);
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const missing = fakeRunner([], () => ({ code: 1, stdout: "", stderr: `No MCP server named ${NAME} is configured.\n` }));
    // The entry was already gone, but the skill this tool wrote is removed, so the status is ok and the text names both.
    const absent = await codexAdapter.uninstall(contextIn(root, { run: missing }), "global");
    assert.equal(absent[0].status, "ok");
    assert.equal(absent[0].message.includes("not installed globally"), true);
    assert.deepEqual(await recordedItems("codex", "global"), []);
  }));

test("uninstall global keeps the record, and gives an error with the first line, when the removal fails for another reason", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const failing = fakeRunner([], () => ({ code: 1, stdout: "", stderr: "permission denied\nmore detail\n" }));
    const steps = await codexAdapter.uninstall(contextIn(root, { run: failing }), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("permission denied"), true);
    assert.equal(steps[0].message.includes("record is kept"), true);
    assert.equal((await recordedItems("codex", "global")).some((item) => item.kind === "mcp-entry"), true);
    assert.equal(existsSync(globalSkillFileIn(root)), true);
  }));

test("uninstall global with no record runs no codex command, even when codex would list the entry", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.equal(steps[0].status, "skipped");
    assert.equal(steps[0].message.includes("not installed globally"), true);
    assert.deepEqual(effects, []);
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

test("an edit that leaves the server defined in a way the header scan cannot remove is refused by install and kept by uninstall, and nothing changes", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    // The server is defined with a dotted key at the top of the file, which no table header names.
    const before = `mcp_servers.${NAME}.command = 'node'\n`;
    await writeFile(file, before);
    await recordTable(root);
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "error");
    // The table does not hold the entry this tool writes, so uninstall keeps it and says so.
    const uninstalled = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(uninstalled[0].status, "skipped");
    assert.equal(uninstalled[0].message.includes("does not hold the server entry this tool writes"), true);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(existsSync(`${file}.bak`), false);
  }));

test("a recorded table that the owner extended with a sub-table is kept by uninstall, and the step says so", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const extended = `${serverTable(root)}\n[mcp_servers.${NAME}.env]\nTEST = 'x'\n`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, extended);
    await recordTable(root);
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(steps[0].message.includes("does not hold the server entry this tool writes, so it was kept"), true);
    assert.equal(await readFile(file, "utf8"), extended);
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
    // The skill file that the install wrote is removed too, so the status is ok.
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "ok");
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
    const globalCtx = dryContextIn(root);
    await codexAdapter.install(globalCtx, "global");
    assert.ok(globalCtx.shown.includes(`write ${path.join(globalSkillIn(root), "SKILL.md")}`));
    const projectCtx = dryContextIn(root);
    await codexAdapter.install(projectCtx, "project");
    assert.ok(projectCtx.shown.includes(`write ${path.join(projectSkillIn(root), "SKILL.md")}`));
    assert.equal(existsSync(path.join(globalSkillIn(root), "SKILL.md")), false);
    assert.equal(existsSync(path.join(projectSkillIn(root), "SKILL.md")), false);
  }));

test("an empty CODEX_HOME counts as not set, so the global skill folder is in the .codex folder of the home folder", () =>
  inTemporaryRoot(async (root) => {
    process.env.CODEX_HOME = "";
    const ctx = dryContextIn(root);
    await codexAdapter.install(ctx, "global");
    assert.ok(ctx.shown.includes(`mkdir ${path.join(root, "home", ".codex", "skills", SKILL_NAME)}`));
  }));

test("the global skill folder comes from CODEX_HOME in the environment the context carries, not from the process environment", () =>
  inTemporaryRoot(async (root) => {
    const contextHome = path.join(root, "context-codex");
    process.env.CODEX_HOME = path.join(root, "process-codex");
    const ctx = dryContextIn(root, { env: { ...process.env, CODEX_HOME: contextHome } });
    await codexAdapter.install(ctx, "global");
    assert.ok(ctx.shown.includes(`mkdir ${path.join(contextHome, "skills", SKILL_NAME)}`));
    assert.equal(ctx.shown.some((line) => line.includes(path.join(root, "process-codex"))), false);
  }));

test("with no CODEX_HOME in the context, the global skill folder is in the .codex folder of the home folder the context carries", () =>
  inTemporaryRoot(async (root) => {
    const home = path.join(root, "context-home-folder");
    const ctx = dryContextIn(root, { env: { ...process.env, CODEX_HOME: undefined, HOME: home, USERPROFILE: home } });
    await codexAdapter.install(ctx, "global");
    assert.ok(ctx.shown.includes(`mkdir ${path.join(home, ".codex", "skills", SKILL_NAME)}`));
  }));

test("a global install with no CODEX_HOME and no home folder in the context stops with an error, and runs no command", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner(effects),
      env: { PATH: process.env.PATH },
    });
    const steps = await codexAdapter.install(ctx, "global");
    assert.equal(steps[0].status, "error");
    assert.deepEqual(effects, []);
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
    const ctx = dryContextIn(root);
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
    const globalStep = await codexAdapter.install(dryContextIn(root), "global");
    assert.match(globalStep[0].message, /^Would add the server to the global Codex configuration\. Would write the skill to /);
    const projectStep = await codexAdapter.install(dryContextIn(root), "project");
    assert.equal(projectStep[0].message.startsWith("Would write the server table to "), true);
    assert.equal(projectStep[0].message.includes("Would write the skill to "), true);
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const removed = await codexAdapter.uninstall(dryContextIn(root), "global");
    assert.match(removed[0].message, /^Would remove the server from the global Codex configuration\./);
  }));

test("no dry-run step says Added, Removed or Wrote, and each one says what would happen", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    await codexAdapter.install(contextIn(root), "project");
    const messages: string[] = [];
    messages.push(...(await codexAdapter.install(dryContextIn(root), "global")).map((step) => step.message));
    messages.push(...(await codexAdapter.install(dryContextIn(root), "project")).map((step) => step.message));
    messages.push(...(await codexAdapter.update(dryContextIn(root), "project")).map((step) => step.message));
    messages.push(...(await codexAdapter.update(dryContextIn(root), "global")).map((step) => step.message));
    messages.push(...(await codexAdapter.uninstall(dryContextIn(root), "project")).map((step) => step.message));
    messages.push(...(await codexAdapter.uninstall(dryContextIn(root), "global")).map((step) => step.message));
    messages.push(...(await codexAdapter.doctor(dryContextIn(root))).map((step) => step.message));
    for (const message of messages) {
      assert.equal(/\b(Added|Removed|Wrote)\b/.test(message), false, message);
    }
    assert.equal(messages.some((message) => message.startsWith("Would")), true);
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
    const dry = dryContextIn(root);
    const dryStep = await codexAdapter.uninstall(dry, "global");
    assert.equal(dryStep[0].status, "ok");
    assert.equal(dryStep[0].message.includes(`Would remove the skill file ${globalSkillFileIn(root)}`), true);
    const realStep = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global");
    assert.equal(realStep[0].status, "ok");
    assert.equal(realStep[0].message.includes(`Removed the skill file ${globalSkillFileIn(root)}`), true);
    await codexAdapter.install(contextIn(root), "project");
    await rm(configIn(root));
    const projectStep = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(projectStep[0].status, "ok");
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

test("an uninstall whose project file cannot be removed gives an error step, and keeps the record", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root), "project");
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingRemoveOf(configIn(root)),
    });
    const steps = await codexAdapter.uninstall(ctx, "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("could not be removed"), true);
    assert.equal((await recordedItems("codex", scopeKey("project", projectIn(root)))).some((item) => item.kind === "toml-table"), true);
  }));

test("a failed write of the project file keeps the records of the change, and uninstall reads the table as absent: no error, and no file written", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const key = scopeKey("project", projectIn(root));
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingWriteOf(file),
    });
    const steps = await codexAdapter.install(ctx, "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("no space left"), true);
    assert.equal(steps[0].message.includes("Uninstall reads the file as it is now."), true);
    assert.equal(existsSync(projectSkillIn(root)), false);
    // The records were written before the write, so they describe the table, and the file does not hold it.
    assert.equal((await recordedItems("codex", key)).some((item) => item.kind === "toml-table" && item.path === file), true);
    const removed = await codexAdapter.uninstall(contextIn(root), "project");
    // The empty folder that the failed install made is removed and named, so the step is a change and its status is ok.
    assert.equal(removed[0].status, "ok");
    assert.equal(removed[0].message.includes(`Removed the empty folder ${path.dirname(file)}.`), true);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(`${file}.bak`), false);
    assert.deepEqual(await recordedItems("codex", key), []);
  }));

test("a backup that cannot be written leaves the file as it was, and the error says so", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const original = 'model = "gpt-5"\n';
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, original);
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingWriteOf(`${file}.bak`),
    });
    const steps = await codexAdapter.install(ctx, "project");
    assert.equal(steps[0].status, "error");
    assert.equal(
      steps[0].message,
      `The backup ${file}.bak could not be written: ENOSPC: no space left on device. The file was not changed, and uninstall names only the backups that are on disk.`,
    );
    assert.equal(await readFile(file, "utf8"), original);
  }));

test("an uninstall whose record cannot be updated says so, and a second uninstall finishes the job", () =>
  inTemporaryRoot(async (root) => {
    // A second scope keeps the state file, so forgetting the project scope has to rewrite it.
    await recordEntry();
    await codexAdapter.install(contextIn(root), "project");
    const failed = await withFailingRename(() => codexAdapter.uninstall(contextIn(root), "project"));
    assert.equal(failed[0].status, "error");
    assert.equal(failed[0].message.includes("record could not be updated"), true);
    // The failed uninstall had already removed the skill file before its record could not be updated. The second one finds nothing
    // left to remove, so it reports skipped, and it ends the record.
    const again = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(again[0].status, "skipped");
    assert.equal(existsSync(projectSkillFileIn(root)), false);
    assert.deepEqual(await recordedItems("codex", scopeKey("project", projectIn(root))), []);
    assert.deepEqual(await recordedItems("codex", "global"), [{ kind: "mcp-entry", name: NAME }]);
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

// A project file that holds the server table, written by hand, with no record of it.
const writeTableByHand = async (root: string): Promise<void> => {
  await mkdir(path.dirname(configIn(root)), { recursive: true });
  await writeFile(configIn(root), serverTable(root));
};

// A command result whose fields cannot be read. A dry run must never read code, stdout or stderr of a result. Other properties,
// such as then, answer as missing, so that the result can be returned from an async function.
const unreadableResult = (): CommandResult =>
  new Proxy(
    {},
    {
      get: (_target, field) => {
        if (field === "code" || field === "stdout" || field === "stderr") {
          throw new Error(`a dry run read a command result: ${String(field)}`);
        }
        return undefined;
      },
    },
  ) as CommandResult;

test("a dry run never reads the result of a command: the global install and uninstall say what would happen", () =>
  inTemporaryRoot(async (root) => {
    await recordEntry();
    const base = dryContextIn(root);
    const ctx: Context = {
      ...base,
      run: async (command, args, options) => {
        await base.run(command, args, options);
        return unreadableResult();
      },
    };
    const installed = await codexAdapter.install(ctx, "global");
    assert.equal(installed[0].status, "ok");
    assert.equal(installed[0].message.startsWith("Would add the server"), true);
    const uninstalled = await codexAdapter.uninstall(ctx, "global");
    assert.equal(uninstalled[0].status, "ok");
    assert.equal(uninstalled[0].message.startsWith("Would remove the server"), true);
  }));

test("the backup that uninstall makes is on the record after a failed removal, and the step names it", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const key = scopeKey("project", projectIn(root));
    const original = `[other]\nk = 1\n\n${serverTable(root)}`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, original);
    await recordTable(root);
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingWriteOf(file),
    });
    const steps = await codexAdapter.uninstall(ctx, "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(`The previous file is kept as ${file}.bak.`), true);
    assert.equal(await readFile(`${file}.bak`, "utf8"), original);
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(
      (await recordedItems("codex", key)).some((item) => item.kind === "file" && item.path === `${file}.bak` && item.createdByUs),
      true,
    );
  }));

test("after a successful uninstall, the backup it made stays on the record, so a later uninstall still names it", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const key = scopeKey("project", projectIn(root));
    const original = `[other]\nk = 1\n\n${serverTable(root)}`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, original);
    await recordTable(root);
    const removed = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(removed[0].status, "ok");
    assert.equal(removed[0].message.includes(`Kept the previous file as ${file}.bak.`), true);
    assert.equal(removed[0].message.includes(`The backups kept are: ${file}.bak.`), true);
    assert.equal((await recordedItems("codex", key)).some((item) => item.kind === "file" && item.path === `${file}.bak`), true);
    const again = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(again[0].message.includes(`The backups kept are: ${file}.bak.`), true);
  }));

test("a project install refuses a project folder that does not exist: nothing is created or written, in a real run and in a dry run", () =>
  inTemporaryRoot(async (root) => {
    await rm(projectIn(root), { recursive: true, force: true });
    for (const dryRun of [false, true]) {
      const ctx = makeContext({
        projectDir: projectIn(root),
        cliPath: programIn(root),
        packageRoot: path.join(root, "package"),
        dryRun,
        present: () => true,
        run: fakeRunner([]),
      });
      const steps = await codexAdapter.install(ctx, "project");
      assert.equal(steps[0].status, "error");
      assert.equal(steps[0].message.includes("does not exist"), true);
      assert.deepEqual(ctx.shown, []);
      assert.equal(existsSync(projectIn(root)), false);
    }
    assert.deepEqual(await recordedItems("codex", scopeKey("project", projectIn(root))), []);
  }));

test("a config file that cannot be read gives an error step in each project action, and changes nothing", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(file, { recursive: true });
    await recordTable(root);
    const installed = await codexAdapter.install(contextIn(root), "project");
    const updated = await codexAdapter.update(contextIn(root), "project");
    const uninstalled = await codexAdapter.uninstall(contextIn(root), "project");
    for (const steps of [installed, updated, uninstalled]) {
      assert.equal(steps[0].status, "error");
      assert.equal(steps[0].message.includes("could not be read"), true);
      assert.equal(steps[0].message.includes("nothing was changed"), true);
    }
    const doctored = await codexAdapter.doctor(contextIn(root, { present: false }));
    assert.equal(doctored.find((step) => step.scope === "project")?.status, "error");
    assert.deepEqual(await readdir(file), []);
  }));

test("project update and uninstall with no record and an invalid config file are skipped, run no command, and change no file", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    const text = Buffer.from("[mcp_servers.broken\nsecret = 'x' = 1\n");
    await writeFile(file, text);
    const effects: string[] = [];
    const updated = await codexAdapter.update(contextIn(root, { run: fakeRunner(effects) }), "project");
    const uninstalled = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "project");
    for (const steps of [updated, uninstalled]) {
      assert.equal(steps[0].status, "skipped");
      assert.equal(steps[0].message.includes("not installed in this scope"), true);
    }
    assert.deepEqual(effects, []);
    assert.deepEqual(await readFile(file), text);
  }));

test("project update and uninstall with no record and an unreadable config file are skipped, run no command, and change nothing", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(file, { recursive: true });
    const effects: string[] = [];
    const updated = await codexAdapter.update(contextIn(root, { run: fakeRunner(effects) }), "project");
    const uninstalled = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "project");
    for (const steps of [updated, uninstalled]) {
      assert.equal(steps[0].status, "skipped");
    }
    assert.deepEqual(effects, []);
    assert.deepEqual(await readdir(file), []);
  }));

test("project update and uninstall with a record and an invalid config file still give an error, and change nothing", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await recordTable(root);
    await mkdir(path.dirname(file), { recursive: true });
    const text = Buffer.from("[mcp_servers.broken\nsecret = 'x' = 1\n");
    await writeFile(file, text);
    const updated = await codexAdapter.update(contextIn(root), "project");
    const uninstalled = await codexAdapter.uninstall(contextIn(root), "project");
    for (const steps of [updated, uninstalled]) {
      assert.equal(steps[0].status, "error");
      assert.equal(steps[0].message.includes("not valid TOML"), true);
    }
    assert.deepEqual(await readFile(file), text);
  }));

test("doctor with a relative program path gives an error step for the project scope, and does not throw", () =>
  inTemporaryRoot(async (root) => {
    await recordEntry();
    await recordTable(root);
    await writeTableByHand(root);
    const steps = await codexAdapter.doctor(contextIn(root, { cliPath: "relative/cli.js", present: false }));
    const project = steps.find((step) => step.scope === "project");
    assert.equal(project?.status, "error");
    assert.equal(project?.message.includes("absolute"), true);
    assert.equal(steps.some((step) => step.scope === "global"), true);
  }));

// The no-record cases. Most uninstall tests above have a twin here, which shows that a scope with no record changes nothing. Eight
// uninstall tests have no twin, and a twin cannot show what each one is about:
// - "a failed write of the skill still leaves its folder and file in the record, so uninstall removes the folder": the folder and
//   the file are on the record only because that write recorded them, so with no record there is nothing for uninstall to remove;
// - "a global uninstall whose entry is already gone removes the recorded skill, and reports ok with the skill text": a skill is
//   removed only when the record lists it, so with no record the case has no skill to remove;
// - "an uninstall whose record cannot be updated": the update of a record fails, which needs a record to exist;
// - "uninstall global with a state file that cannot be read": an unreadable state file is refused before any record is used;
// - "the backup that uninstall makes is on the record after a failed removal" and "after a successful uninstall, the backup it made
//   stays on the record": a backup is listed by the record, so with no record there is no backup to keep;
// - "an uninstall whose backup cannot be written": a backup is recorded before its write, so with no record there is no backup for
//   a failed write to leave;
// - "a config file that cannot be read": the file is refused before the record is read, so the record makes no difference.

test("with no record, project uninstall keeps a file that this tool did not create, and writes nothing", () =>
  inTemporaryRoot(async (root) => {
    await writeTableByHand(root);
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(await readFile(configIn(root), "utf8"), serverTable(root));
    assert.equal(existsSync(`${configIn(root)}.bak`), false);
  }));

test("with no record, project uninstall keeps the file, the folder and the owner's file in it", () =>
  inTemporaryRoot(async (root) => {
    await writeTableByHand(root);
    const other = path.join(path.dirname(configIn(root)), "auth.json");
    await writeFile(other, "{}\n");
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(existsSync(configIn(root)), true);
    assert.equal(await readFile(other, "utf8"), "{}\n");
  }));

test("with no record, uninstall keeps a .codex folder that was there and holds the file", () =>
  inTemporaryRoot(async (root) => {
    await writeTableByHand(root);
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(existsSync(path.dirname(configIn(root))), true);
    assert.equal(await readFile(configIn(root), "utf8"), serverTable(root));
  }));

test("with no record, uninstall keeps an empty .codex folder, since nothing records that this tool made it", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(path.dirname(configIn(root)), { recursive: true });
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(existsSync(path.dirname(configIn(root))), true);
  }));

test("with no record, uninstall keeps the .codex folder when its file is gone", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(path.dirname(configIn(root)), { recursive: true });
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(existsSync(path.dirname(configIn(root))), true);
  }));

test("with no record, global uninstall keeps a skill folder that the owner made, and runs no codex command", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(globalSkillIn(root), { recursive: true });
    await writeFile(globalSkillFileIn(root), "The owner's own skill.\n");
    const effects: string[] = [];
    const steps = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "global");
    assert.equal(steps[0].status, "skipped");
    assert.deepEqual(effects, []);
    assert.equal(await readFile(globalSkillFileIn(root), "utf8"), "The owner's own skill.\n");
  }));

test("with no record, project uninstall keeps a SKILL.md that the owner wrote into the skill folder", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectSkillIn(root), { recursive: true });
    await writeFile(projectSkillFileIn(root), "The owner's own skill.\n");
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(await readFile(projectSkillFileIn(root), "utf8"), "The owner's own skill.\n");
  }));

test("with no record, project uninstall leaves a server defined a second way as it was", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    const before = `mcp_servers.${NAME}.command = 'node'\n`;
    await writeFile(file, before);
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(await readFile(file, "utf8"), before);
  }));

test("with no record, project uninstall keeps an .agents skill folder that the owner made", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectSkillIn(root), { recursive: true });
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(existsSync(projectSkillIn(root)), true);
    assert.equal(existsSync(projectAgentsIn(root)), true);
  }));

test("with no record, project uninstall keeps an empty .agents folder", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectAgentsIn(root), { recursive: true });
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(existsSync(projectAgentsIn(root)), true);
  }));

test("with no record, project uninstall keeps an .agents folder that holds the owner's other file", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectAgentsIn(root), { recursive: true });
    await writeFile(path.join(projectAgentsIn(root), "other.txt"), "kept\n");
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(await readFile(path.join(projectAgentsIn(root), "other.txt"), "utf8"), "kept\n");
  }));

test("with no record, uninstall keeps an empty skill folder that it finds in place", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectSkillIn(root), { recursive: true });
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(existsSync(projectSkillIn(root)), true);
  }));

test("with no record, project uninstall does not remove the file, even when its removal would fail", () =>
  inTemporaryRoot(async (root) => {
    await writeTableByHand(root);
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingRemoveOf(configIn(root)),
    });
    const steps = await codexAdapter.uninstall(ctx, "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(existsSync(configIn(root)), true);
  }));

test("with no record, uninstall keeps a skill file that the owner wrote, even when its removal would fail", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(projectSkillIn(root), { recursive: true });
    await writeFile(projectSkillFileIn(root), "The owner's own skill.\n");
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
    assert.equal(steps[0].status, "skipped");
    assert.equal(await readFile(projectSkillFileIn(root), "utf8"), "The owner's own skill.\n");
  }));

test("with no record, the uninstall step names no skill file, in the project scope as in the global one", () =>
  inTemporaryRoot(async (root) => {
    const steps = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "project");
    assert.equal(steps[0].message.includes("skill file"), false);
  }));

test("with no record, a global uninstall whose skill removal would fail runs no codex command and removes nothing", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(globalSkillIn(root), { recursive: true });
    await writeFile(globalSkillFileIn(root), "The owner's own skill.\n");
    const effects: string[] = [];
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner(effects),
      fs: filesFailingRemoveOf(globalSkillFileIn(root)),
    });
    const steps = await codexAdapter.uninstall(ctx, "global");
    assert.equal(steps[0].status, "skipped");
    assert.deepEqual(effects, []);
    assert.equal(existsSync(globalSkillFileIn(root)), true);
  }));

test("with no record and no config file, an uninstall runs no command and writes no config or backup", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner(effects) }), "project");
    assert.equal(steps[0].status, "skipped");
    assert.deepEqual(effects, []);
    assert.equal(existsSync(configIn(root)), false);
    assert.equal(existsSync(`${configIn(root)}.bak`), false);
  }));

test("with no record, an uninstall ends without changing the record", () =>
  inTemporaryRoot(async (root) => {
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.deepEqual(await recordedItems("codex", scopeKey("project", projectIn(root))), []);
  }));

test("with no record, global uninstall without codex on PATH runs nothing", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const steps = await codexAdapter.uninstall(contextIn(root, { present: false, run: fakeRunner(effects) }), "global");
    assert.equal(steps[0].status, "skipped");
    assert.deepEqual(effects, []);
  }));

test("a global folder that the owner fills after install keeps its record after uninstall, and a later uninstall removes it once empty", () =>
  inTemporaryRoot(async (root) => {
    const folder = globalSkillIn(root);
    assert.equal((await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global"))[0].status, "ok");
    await writeFile(path.join(folder, "notes.txt"), "kept\n");
    const first = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global");
    assert.equal(first[0].status, "ok");
    assert.equal(existsSync(globalSkillFileIn(root)), false);
    assert.equal(existsSync(folder), true);
    assert.equal(
      (await recordedItems("codex", "global")).some((item) => item.kind === "directory" && item.path === folder),
      true,
    );
    await rm(path.join(folder, "notes.txt"));
    const second = await codexAdapter.uninstall(contextIn(root, { run: fakeRunner([]) }), "global");
    assert.equal(second[0].status, "skipped");
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(globalBaseIn(root)), false);
    assert.deepEqual(await recordedItems("codex", "global"), []);
  }));

test("an uninstall whose backup cannot be written keeps the backup on the record, and leaves the file as it was", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const original = `[other]\nk = 1\n\n${serverTable(root)}`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, original);
    await recordTable(root);
    const ctx = makeContext({
      projectDir: projectIn(root),
      cliPath: programIn(root),
      packageRoot: path.join(root, "package"),
      dryRun: false,
      present: () => true,
      run: fakeRunner([]),
      fs: filesFailingWriteOf(`${file}.bak`),
    });
    const steps = await codexAdapter.uninstall(ctx, "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.startsWith(`The backup ${file}.bak could not be written`), true);
    assert.equal(await readFile(file, "utf8"), original);
    assert.equal(existsSync(`${file}.bak`), false);
    // The backup is recorded before its write, so the record names it even though no backup file was written.
    assert.equal(
      (await recordedItems("codex", scopeKey("project", projectIn(root)))).some(
        (item) => item.kind === "file" && item.path === `${file}.bak` && item.createdByUs,
      ),
      true,
    );
  }));

test("project uninstall keeps the record of a folder that still holds an owner's file, so a later uninstall removes it once empty", () =>
  inTemporaryRoot(async (root) => {
    const folder = path.dirname(configIn(root));
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    await writeFile(path.join(folder, "auth.json"), "{}\n");
    const first = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(first[0].status, "ok");
    assert.equal(existsSync(folder), true);
    assert.equal(
      (await recordedItems("codex", scopeKey("project", projectIn(root)))).some(
        (item) => item.kind === "directory" && item.path === folder,
      ),
      true,
    );
    await rm(path.join(folder, "auth.json"));
    const second = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(second[0].status, "ok");
    assert.equal(second[0].message.includes(`Removed the empty folder ${folder}.`), true);
    assert.equal(existsSync(folder), false);
  }));

test("project install refuses a project path that is a file: the step says it is not a folder, and nothing changes", () =>
  inTemporaryRoot(async (root) => {
    await rm(projectIn(root), { recursive: true, force: true });
    await writeFile(projectIn(root), "not a folder\n");
    const steps = await codexAdapter.install(contextIn(root), "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("is not a folder"), true);
    assert.equal(steps[0].message.includes("does not exist"), false);
    assert.equal(await readFile(projectIn(root), "utf8"), "not a folder\n");
    assert.deepEqual(await recordedItems("codex", scopeKey("project", projectIn(root))), []);
  }));

test("after a failed write, a table the owner writes under the same key is kept by uninstall, and the step says so", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    const failed = await codexAdapter.install(
      makeContext({
        projectDir: projectIn(root),
        cliPath: programIn(root),
        packageRoot: path.join(root, "package"),
        dryRun: false,
        present: () => true,
        run: fakeRunner([]),
        fs: filesFailingWriteOf(file),
      }),
      "project",
    );
    assert.equal(failed[0].status, "error");
    // The failed write left the record of the table. The owner now writes a table under the same key, with other values.
    const owner = `[mcp_servers.${NAME}]\ncommand = 'owner-node'\nargs = ['owner-cli']\n`;
    await writeFile(file, owner);
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(steps[0].message.includes("does not hold the server entry this tool writes, so it was kept"), true);
    assert.equal(await readFile(file, "utf8"), owner);
    assert.equal(existsSync(`${file}.bak`), false);
  }));

test("a global uninstall whose entry is already gone removes the recorded skill, and reports ok with the skill text", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    const missing = fakeRunner([], () => ({ code: 1, stdout: "", stderr: `No MCP server named ${NAME} is configured.\n` }));
    const steps = await codexAdapter.uninstall(contextIn(root, { run: missing }), "global");
    assert.equal(steps[0].status, "ok");
    assert.equal(steps[0].message.includes(`Removed the skill file ${globalSkillFileIn(root)}.`), true);
    assert.equal(steps[0].message.includes("The server entry was not installed globally."), true);
    assert.equal(existsSync(globalSkillFileIn(root)), false);
  }));

// The text of a table kept because it does not hold the entry this tool writes, and the record that keeps it.
const keptTableText = (root: string): string =>
  `The table in ${configIn(root)} does not hold the server entry this tool writes, so it was kept.`;

test("after a Node path change, uninstall keeps the table and its record, and the step says how to remove the table by hand", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    // The Node binary changed since the install, so the table still names the old one.
    const current = await readFile(file, "utf8");
    const changed = current.replace(`command = '${process.execPath}'`, "command = 'C:/old-node/node.exe'");
    await writeFile(file, changed);
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(steps[0].message.startsWith(keptTableText(root)), true);
    assert.equal(
      steps[0].message.includes(`To remove it by hand, delete the table [mcp_servers.${NAME}] and any table under it from ${file}.`),
      true,
    );
    assert.equal(steps[0].message.includes("was not written by this tool"), false);
    assert.equal(await readFile(file, "utf8"), changed);
    assert.equal(
      (await recordedItems("codex", scopeKey("project", projectIn(root)))).some(
        (item) => item.kind === "toml-table" && item.path === file,
      ),
      true,
    );
    // A later uninstall names the kept table again.
    const again = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(again[0].message.includes(`To remove it by hand, delete the table [mcp_servers.${NAME}]`), true);
  }));

test("after a Node path change, a later install replaces the kept table after a backup, and a later uninstall removes it", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    const current = await readFile(file, "utf8");
    const changed = current.replace(`command = '${process.execPath}'`, "command = 'C:/old-node/node.exe'");
    await writeFile(file, changed);
    assert.equal((await codexAdapter.uninstall(contextIn(root), "project"))[0].status, "skipped");
    const installed = await codexAdapter.install(contextIn(root), "project");
    assert.equal(installed[0].status, "ok");
    assert.equal(await readFile(`${file}.bak`, "utf8"), changed);
    assert.equal((await readFile(file, "utf8")).includes(`command = '${process.execPath}'`), true);
    const removed = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(removed[0].status, "ok");
    assert.equal(existsSync(file), false);
  }));

test("when a table is kept, the status is skipped, even when a skill file was removed in the same step", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    const current = await readFile(file, "utf8");
    await writeFile(file, current.replace(`command = '${process.execPath}'`, "command = 'C:/old-node/node.exe'"));
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(steps[0].message.includes(`Removed the skill file ${projectSkillFileIn(root)}.`), true);
    assert.equal(existsSync(projectSkillFileIn(root)), false);
    assert.equal(steps[0].message.includes(keptTableText(root)), true);
  }));

test("when the owner's config file is gone, the empty .codex folder that uninstall removes is named in the step", () =>
  inTemporaryRoot(async (root) => {
    const folder = path.dirname(configIn(root));
    assert.equal((await codexAdapter.install(contextIn(root), "project"))[0].status, "ok");
    await rm(configIn(root));
    const steps = await codexAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.equal(existsSync(folder), false);
    assert.equal(steps[0].message.includes(`Removed the empty folder ${folder}.`), true);
  }));

test("a skill file the owner already deleted is not reported as removed, and the status is not ok for it", () =>
  inTemporaryRoot(async (root) => {
    await codexAdapter.install(contextIn(root, { run: fakeRunner([]) }), "global");
    // The owner deleted SKILL.md and kept another file in the skill folder, so the folder stays.
    await rm(globalSkillFileIn(root));
    await writeFile(path.join(globalSkillIn(root), "notes.txt"), "kept\n");
    const missing = fakeRunner([], () => ({ code: 1, stdout: "", stderr: `No MCP server named ${NAME} is configured.\n` }));
    const steps = await codexAdapter.uninstall(contextIn(root, { run: missing }), "global");
    assert.equal(steps[0].status, "skipped");
    assert.equal(steps[0].message.includes("Removed the skill file"), false);
    assert.equal(existsSync(path.join(globalSkillIn(root), "notes.txt")), true);
  }));

test("a dry run whose skill removal fails says what would happen, and never what happened", () =>
  inTemporaryRoot(async (root) => {
    const file = configIn(root);
    await codexAdapter.install(contextIn(root), "project");
    // Another table stays in the file, so the table is written back and the file is not removed.
    const current = await readFile(file, "utf8");
    await writeFile(file, `[other]\nk = 1\n\n${current}`);
    const base = dryContextIn(root);
    const ctx: Context = {
      ...base,
      removeFile: async () => {
        throw new Error("cannot remove");
      },
    };
    const steps = await codexAdapter.uninstall(ctx, "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(`The server table would be removed from ${file}.`), true);
    assert.equal(steps[0].message.includes("Would keep the previous file as"), true);
    assert.equal(steps[0].message.includes("was removed"), false);
    assert.equal(steps[0].message.includes("is kept as"), false);
  }));
