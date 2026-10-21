import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Runner } from "../agents/command.js";
import { opencodeAdapter, opencodeGlobalDir } from "../agents/opencode.js";
import { runPlan } from "../agents/plan.js";
import { recordedItems, scopeKey, statePath } from "../agents/state.js";
import { type Context, type FileOps, UnsupportedScope, makeContext } from "../agents/types.js";

const DATA_ENV = "MULTI_ACCOUNT_SUPABASE_HOME";
const CONFIG_ENV = "XDG_CONFIG_HOME";
const NAME = "multi-account-supabase";
const POINTER = `/mcp/${NAME}`;

const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

// Each test gets a temporary root. The data folder and the configuration folder both point into the root, so neither the
// state file nor the owner's opencode configuration is read or written. Both variables are restored afterwards.
const inTemporaryRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-test-"));
  const previousData = process.env[DATA_ENV];
  const previousConfig = process.env[CONFIG_ENV];
  process.env[DATA_ENV] = path.join(root, "data");
  process.env[CONFIG_ENV] = path.join(root, "config");
  try {
    await run(root);
  } finally {
    restore(DATA_ENV, previousData);
    restore(CONFIG_ENV, previousConfig);
    await rm(root, { recursive: true, force: true });
  }
};

const projectIn = (root: string): string => path.join(root, "project");
const projectFileIn = (root: string): string => path.join(projectIn(root), "opencode.json");
const globalFolderIn = (root: string): string => path.join(root, "config", "opencode");
const globalFileIn = (root: string): string => path.join(globalFolderIn(root), "opencode.json");
const programIn = (root: string): string => path.join(root, "package", "dist", "cli.js");

// The entry this installer writes: the Node binary, the program and the serve argument, as a local server.
const entryIn = (root: string) => ({
  type: "local",
  command: [process.execPath, programIn(root), "serve"],
  enabled: true,
});

// The command runner of these tests throws. The opencode adapter runs no command, so a call to one would be a bug.
const noCommands: Runner = async (command, args) => {
  throw new Error(`no command may run: ${[command, ...args].join(" ")}`);
};

// Fake file functions for a dry run. Each call is logged, so a call that reached the disk would show up.
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

// A context for a run in the temporary folders. The file functions can be replaced, and no command can run.
const contextIn = (root: string, options: { dryRun?: boolean; present?: boolean; fs?: FileOps } = {}): Context =>
  makeContext({
    projectDir: projectIn(root),
    cliPath: programIn(root),
    packageRoot: path.join(root, "package"),
    dryRun: options.dryRun ?? false,
    present: () => options.present ?? true,
    run: noCommands,
    fs: options.fs,
  });

test("the adapter has the global and project scopes, reports its presence from the context, and refuses the local scope", () =>
  inTemporaryRoot(async (root) => {
    assert.deepEqual([...opencodeAdapter.scopes], ["global", "project"]);
    assert.equal(opencodeAdapter.present(contextIn(root, { present: false })), false);
    assert.equal(opencodeAdapter.present(contextIn(root)), true);
    for (const action of [opencodeAdapter.install, opencodeAdapter.update, opencodeAdapter.uninstall]) {
      await assert.rejects(action(contextIn(root), "local"), UnsupportedScope);
    }
    assert.equal(existsSync(globalFolderIn(root)), false);
  }));

test("a global install into an empty configuration folder creates opencode.json with the entry, and records the folder, the file and the entry", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const steps = await opencodeAdapter.install(contextIn(root), "global");
    assert.deepEqual(
      steps.map((step) => [step.scope, step.status]),
      [["global", "ok"]],
    );
    const expected = { mcp: { [NAME]: entryIn(root) } };
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), expected);
    assert.equal(await readFile(file, "utf8"), `${JSON.stringify(expected, null, 2)}\n`);
    assert.equal(existsSync(`${file}.bak`), false);
    assert.deepEqual(await recordedItems("opencode", "global"), [
      { kind: "directory", path: globalFolderIn(root) },
      { kind: "file", path: file, createdByUs: true },
      { kind: "json-entry", path: file, pointer: POINTER },
    ]);
  }));

test("install keeps another server and another top-level key unchanged, replaces an earlier entry of ours, and backs up the old bytes", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    const other = { type: "remote", url: "https://example.com/mcp" };
    const before = `${JSON.stringify(
      { theme: "dark", mcp: { other, [NAME]: { type: "local", command: ["old-node", "old-cli"], enabled: true } } },
      null,
      4,
    )}\n`;
    await mkdir(projectIn(root), { recursive: true });
    await writeFile(file, before);
    const steps = await opencodeAdapter.install(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      theme: "dark",
      mcp: { other, [NAME]: entryIn(root) },
    });
    assert.equal(await readFile(`${file}.bak`, "utf8"), before);
    assert.deepEqual(await recordedItems("opencode", scopeKey("project", projectIn(root))), [
      { kind: "json-entry", path: file, pointer: POINTER },
    ]);
  }));

test("install refuses a file that is not valid JSON: the error names the file, the bytes stay, and no backup or state is written", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    const texts = [
      Buffer.from('{ "mcp": { "token-like-value": "x" ,, }\n'),
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    ];
    for (const text of texts) {
      await writeFile(file, text);
      const steps = await opencodeAdapter.install(contextIn(root), "global");
      assert.equal(steps[0].status, "error");
      assert.equal(steps[0].message.includes(file), true);
      assert.equal(steps[0].message.includes("not valid JSON"), true);
      assert.equal(steps[0].message.includes("token-like-value"), false);
      assert.deepEqual(await readFile(file), text);
      assert.equal(existsSync(`${file}.bak`), false);
    }
    assert.equal(existsSync(statePath("opencode")), false);
  }));

test("uninstall removes only this tool's entry, keeps the other keys, and backs up the file before it changes it", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    const other = { type: "remote", url: "https://example.com/mcp" };
    const before = `${JSON.stringify({ theme: "dark", mcp: { other, [NAME]: entryIn(root) } }, null, 2)}\n`;
    await mkdir(projectIn(root), { recursive: true });
    await writeFile(file, before);
    const steps = await opencodeAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { theme: "dark", mcp: { other } });
    assert.equal(await readFile(`${file}.bak`, "utf8"), before);
  }));

test("uninstall removes a file this tool created, with its folder, and keeps a file the user has since added keys to", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const folder = globalFolderIn(root);
    await opencodeAdapter.install(contextIn(root), "global");
    assert.equal((await opencodeAdapter.uninstall(contextIn(root), "global"))[0].status, "ok");
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(`${file}.bak`), false);
    assert.deepEqual(await recordedItems("opencode", "global"), []);

    await opencodeAdapter.install(contextIn(root), "global");
    const edited = `${JSON.stringify({ theme: "dark", mcp: { [NAME]: entryIn(root) } }, null, 2)}\n`;
    await writeFile(file, edited);
    assert.equal((await opencodeAdapter.uninstall(contextIn(root), "global"))[0].status, "ok");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { theme: "dark", mcp: {} });
    assert.equal(await readFile(`${file}.bak`, "utf8"), edited);
    assert.equal(existsSync(folder), true);
  }));

test("update of a scope with nothing recorded changes nothing; update of a recorded scope writes the entry again, once, with a backup", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const empty = contextIn(root, { fs: fakeFiles(effects) });
    const steps = [
      ...(await opencodeAdapter.update(empty, "global")),
      ...(await opencodeAdapter.update(empty, "project")),
    ];
    assert.deepEqual(
      steps.map((step) => [step.status, step.message]),
      [
        ["skipped", "not installed in this scope"],
        ["skipped", "not installed in this scope"],
      ],
    );
    assert.deepEqual(effects, []);
    assert.equal(existsSync(globalFolderIn(root)), false);
    assert.equal(existsSync(statePath("opencode")), false);

    const file = globalFileIn(root);
    await opencodeAdapter.install(contextIn(root), "global");
    const installed = await readFile(file, "utf8");
    assert.equal((await opencodeAdapter.update(contextIn(root), "global"))[0].status, "ok");
    assert.equal(await readFile(file, "utf8"), installed);
    assert.equal(await readFile(`${file}.bak`, "utf8"), installed);
  }));

test("a dry run through the planner changes no file and writes no state, and lists each change in order", () =>
  inTemporaryRoot(async (root) => {
    const effects: string[] = [];
    const file = projectFileIn(root);
    await mkdir(projectIn(root), { recursive: true });
    const before = Buffer.from('{"theme":"dark"}\n');
    await writeFile(file, before);
    const project = await runPlan({
      adapters: [opencodeAdapter],
      action: "install",
      agents: ["opencode"],
      scope: "project",
      ctx: contextIn(root, { dryRun: true, fs: fakeFiles(effects) }),
    });
    assert.equal(project.steps[0].status, "ok");
    assert.deepEqual(project.shown, [`write ${file}.bak`, `write ${file}`]);

    const global = await runPlan({
      adapters: [opencodeAdapter],
      action: "install",
      agents: ["opencode"],
      scope: "global",
      ctx: contextIn(root, { dryRun: true, fs: fakeFiles(effects) }),
    });
    assert.equal(global.steps[0].status, "ok");
    assert.deepEqual(global.shown, [`mkdir ${globalFolderIn(root)}`, `write ${globalFileIn(root)}`]);

    assert.deepEqual(effects, []);
    assert.deepEqual(await readFile(file), before);
    assert.equal(existsSync(globalFolderIn(root)), false);
    assert.equal(existsSync(statePath("opencode")), false);
  }));

test("a file whose mcp value or top level is not an object is refused with unexpected contents, and nothing changes", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    for (const text of ['{ "mcp": [] }\n', '{ "mcp": null }\n', "[1, 2]\n"]) {
      await writeFile(file, text);
      const installed = await opencodeAdapter.install(contextIn(root), "global");
      const removed = await opencodeAdapter.uninstall(contextIn(root), "global");
      for (const step of [installed[0], removed[0]]) {
        assert.equal(step.status, "error");
        assert.equal(step.message.includes("unexpected contents"), true);
        assert.equal(step.message.includes(file), true);
      }
      assert.equal(await readFile(file, "utf8"), text);
      assert.equal(existsSync(`${file}.bak`), false);
    }
  }));

test("doctor reports ok when the entry is there, skipped when it is not, and an error when the file is not valid JSON; a scope with no record gets no step", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    assert.deepEqual(await opencodeAdapter.doctor(contextIn(root)), []);
    await opencodeAdapter.install(contextIn(root), "global");
    const [found] = await opencodeAdapter.doctor(contextIn(root));
    assert.deepEqual([found.scope, found.status], ["global", "ok"]);
    await rm(file);
    assert.equal((await opencodeAdapter.doctor(contextIn(root)))[0].status, "skipped");
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ broken");
    const broken = (await opencodeAdapter.doctor(contextIn(root)))[0];
    assert.equal(broken.status, "error");
    assert.equal(broken.message.includes("not valid JSON"), true);
  }));

test("install keeps a byte order mark and CRLF line endings of the old file, and the backup has the old bytes", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    await mkdir(projectIn(root), { recursive: true });
    const before = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('{\r\n  "theme": "dark"\r\n}\r\n'),
    ]);
    await writeFile(file, before);
    assert.equal((await opencodeAdapter.install(contextIn(root), "project"))[0].status, "ok");
    const written = await readFile(file);
    assert.deepEqual([...written.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const text = written.subarray(3).toString("utf8");
    assert.equal(text.replace(/\r\n/g, "").includes("\n"), false);
    assert.equal(JSON.parse(text).theme, "dark");
    assert.deepEqual(await readFile(`${file}.bak`), before);
  }));

test("the global folder is the XDG configuration folder when that is an absolute path, otherwise .config in the home folder", () => {
  const home = path.resolve("home-for-test");
  const xdg = path.resolve("xdg-for-test");
  assert.equal(opencodeGlobalDir({ XDG_CONFIG_HOME: xdg }, home), path.join(xdg, "opencode"));
  assert.equal(opencodeGlobalDir({ XDG_CONFIG_HOME: "" }, home), path.join(home, ".config", "opencode"));
  assert.equal(opencodeGlobalDir({}, home), path.join(home, ".config", "opencode"));
  assert.equal(opencodeGlobalDir({ XDG_CONFIG_HOME: "relative" }, home), path.join(home, ".config", "opencode"));
});

// The file that install writes in a configuration folder.
const fileUnder = (configFolder: string): string => path.join(configFolder, "opencode", "opencode.json");

test("uninstall removes the entry from the file recorded at install time, after the configuration folder has changed, and writes nothing in the new folder", () =>
  inTemporaryRoot(async (root) => {
    const fileA = fileUnder(path.join(root, "config-a"));
    const fileB = fileUnder(path.join(root, "config-b"));
    process.env[CONFIG_ENV] = path.join(root, "config-a");
    await opencodeAdapter.install(contextIn(root), "global");
    // Another key stays in the file, so the file is kept when the entry goes.
    await writeFile(fileA, `${JSON.stringify({ theme: "dark", mcp: { [NAME]: entryIn(root) } }, null, 2)}\n`);
    await mkdir(path.dirname(fileB), { recursive: true });
    const otherText = `${JSON.stringify({ theme: "light" }, null, 2)}\n`;
    await writeFile(fileB, otherText);
    process.env[CONFIG_ENV] = path.join(root, "config-b");
    const steps = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(JSON.parse(await readFile(fileA, "utf8")), { theme: "dark", mcp: {} });
    assert.equal(await readFile(fileB, "utf8"), otherText);
    assert.equal(existsSync(`${fileB}.bak`), false);
    assert.deepEqual(await recordedItems("opencode", "global"), []);
    assert.equal(existsSync(statePath("opencode")), false);
  }));

test("update writes the entry to the file recorded at install time, and creates nothing in a changed configuration folder", () =>
  inTemporaryRoot(async (root) => {
    const fileA = fileUnder(path.join(root, "config-a"));
    const folderB = path.join(root, "config-b");
    process.env[CONFIG_ENV] = path.join(root, "config-a");
    await opencodeAdapter.install(contextIn(root), "global");
    const installed = await readFile(fileA, "utf8");
    process.env[CONFIG_ENV] = folderB;
    const steps = await opencodeAdapter.update(contextIn(root), "global");
    assert.equal(steps[0].status, "ok");
    assert.equal(existsSync(folderB), false);
    assert.equal(await readFile(fileA, "utf8"), installed);
    assert.equal(await readFile(`${fileA}.bak`, "utf8"), installed);
  }));

test("doctor checks the file recorded at install time, not the file the environment names after a change", () =>
  inTemporaryRoot(async (root) => {
    process.env[CONFIG_ENV] = path.join(root, "config-a");
    await opencodeAdapter.install(contextIn(root), "global");
    process.env[CONFIG_ENV] = path.join(root, "config-b");
    const steps = await opencodeAdapter.doctor(contextIn(root));
    assert.deepEqual(
      steps.map((step) => [step.scope, step.status]),
      [["global", "ok"]],
    );
  }));

test("install into a scope with an entry recorded writes that file again, so one scope never holds two recorded files", () =>
  inTemporaryRoot(async (root) => {
    const fileA = fileUnder(path.join(root, "config-a"));
    const folderB = path.join(root, "config-b");
    process.env[CONFIG_ENV] = path.join(root, "config-a");
    await opencodeAdapter.install(contextIn(root), "global");
    process.env[CONFIG_ENV] = folderB;
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    assert.equal(existsSync(folderB), false);
    assert.deepEqual(await recordedItems("opencode", "global"), [
      { kind: "directory", path: path.dirname(fileA) },
      { kind: "file", path: fileA, createdByUs: true },
      { kind: "json-entry", path: fileA, pointer: POINTER },
    ]);
  }));

test("refusing the local scope gives the full message, which says what to use instead", () =>
  inTemporaryRoot(async (root) => {
    let caught: unknown;
    try {
      await opencodeAdapter.install(contextIn(root), "local");
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof UnsupportedScope);
    assert.equal(caught.message, "opencode has no local scope. Use global or project.");
    assert.equal(caught.message.includes("Use global or project."), true);
    assert.equal(caught.agent, "opencode");
  }));
