import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Runner } from "../agents/command.js";
import { opencodeAdapter, opencodeGlobalDir } from "../agents/opencode.js";
import { runPlan } from "../agents/plan.js";
import { forget, record, recordedItems, scopeKey, statePath } from "../agents/state.js";
import { type Context, type FileOps, UnsupportedScope, makeContext } from "../agents/types.js";

const DATA_ENV = "MULTI_ACCOUNT_SUPABASE_HOME";
const CONFIG_ENV = "XDG_CONFIG_HOME";
const NAME = "multi-account-supabase";
const POINTER = `/mcp/${NAME}`;
const SCOPES = ["global", "project"] as const;

// Every variable that can point a path at the owner's folders. Each one is pointed into the temporary root for a test,
// and each is restored afterwards. The configuration folder is root/config, which the paths below rely on.
const ISOLATED_ENV = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", CONFIG_ENV, DATA_ENV] as const;

const isolatedValues = (root: string): Record<(typeof ISOLATED_ENV)[number], string> => ({
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  APPDATA: path.join(root, "appdata"),
  LOCALAPPDATA: path.join(root, "localappdata"),
  CODEX_HOME: path.join(root, "codex"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  MULTI_ACCOUNT_SUPABASE_HOME: path.join(root, "data"),
});

const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
};

// Each test gets a temporary root, and every variable in ISOLATED_ENV points into it. So neither the state file nor the
// owner's folders are read or written. The variables are restored afterwards.
const inTemporaryRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-test-"));
  const previous = new Map(ISOLATED_ENV.map((name) => [name, process.env[name]] as const));
  const values = isolatedValues(root);
  for (const name of ISOLATED_ENV) {
    process.env[name] = values[name];
  }
  try {
    await run(root);
  } finally {
    for (const name of ISOLATED_ENV) {
      restore(name, previous.get(name));
    }
    await rm(root, { recursive: true, force: true });
  }
};

const projectIn = (root: string): string => path.join(root, "project");
const projectFileIn = (root: string): string => path.join(projectIn(root), "opencode.json");
const globalFolderIn = (root: string): string => path.join(root, "config", "opencode");
const globalFileIn = (root: string): string => path.join(globalFolderIn(root), "opencode.json");
const programIn = (root: string): string => path.join(root, "package", "dist", "cli.js");

// The file that install writes in a scope.
const fileIn = (root: string, scope: (typeof SCOPES)[number]): string =>
  scope === "global" ? globalFileIn(root) : projectFileIn(root);

// The file that install writes in a configuration folder.
const fileUnder = (configFolder: string): string => path.join(configFolder, "opencode", "opencode.json");

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

// Removes an empty folder, as the context does. A folder that holds something, or that is gone, is left alone.
const removeIfEmpty = async (dir: string): Promise<void> => {
  try {
    await rmdir(dir);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
      throw error;
    }
  }
};

// File functions that do the real work and log each call. A test that counts the writes uses them.
const recordingFiles = (effects: string[]): FileOps => ({
  writeFile: async (file, text) => {
    effects.push(`write ${file}`);
    await writeFile(file, text, "utf8");
  },
  removeFile: async (file) => {
    effects.push(`remove ${file}`);
    await rm(file, { force: true });
  },
  ensureDir: async (dir) => {
    effects.push(`mkdir ${dir}`);
    await mkdir(dir, { recursive: true });
  },
  removeDirIfEmpty: async (dir) => {
    effects.push(`rmdir ${dir}`);
    await removeIfEmpty(dir);
  },
});

// The same file functions, except that every write fails.
const failingWrites = (): FileOps => ({
  ...recordingFiles([]),
  writeFile: async () => {
    throw new Error("simulated write failure");
  },
});

// The same file functions, except that a write to the target fails with a permission error.
const failingWriteTo = (target: string): FileOps => ({
  ...recordingFiles([]),
  writeFile: async (file, text) => {
    if (file === target) {
      throw Object.assign(new Error("simulated permission failure"), { code: "EPERM" });
    }
    await writeFile(file, text, "utf8");
  },
});

// The same file functions, except that removing the target fails with a busy error.
const failingRemovalOf = (target: string): FileOps => ({
  ...recordingFiles([]),
  removeFile: async (file) => {
    if (file === target) {
      throw Object.assign(new Error("simulated busy file"), { code: "EBUSY" });
    }
    await rm(file, { force: true });
  },
});

// The same file functions, except that removing a folder fails with a permission error.
const failingFolderRemoval = (): FileOps => ({
  ...recordingFiles([]),
  removeDirIfEmpty: async () => {
    throw Object.assign(new Error("simulated permission failure"), { code: "EPERM" });
  },
});

// The same file functions. Each write is logged, with "recorded" when the file is on the record at the time of the write.
const orderedFiles = (log: string[], key: string): FileOps => ({
  ...recordingFiles([]),
  writeFile: async (file, text) => {
    const onRecord = (await recordedItems("opencode", key)).some((item) => item.kind === "file" && item.path === file);
    log.push(`write ${file}${onRecord ? " recorded" : ""}`);
    await writeFile(file, text, "utf8");
  },
});

// Whether a message names a backup by its whole name. A name followed by a digit is another backup, so it does not count.
const namesBackup = (message: string, backup: string): boolean =>
  message.split(backup).slice(1).some((rest) => !/^\d/.test(rest));

// A context for a run in the temporary folders. The file functions can be replaced, and no command can run.
const contextIn = (
  root: string,
  options: { dryRun?: boolean; present?: boolean; fs?: FileOps; env?: NodeJS.ProcessEnv } = {},
): Context =>
  makeContext({
    projectDir: projectIn(root),
    cliPath: programIn(root),
    packageRoot: path.join(root, "package"),
    dryRun: options.dryRun ?? false,
    present: () => options.present ?? true,
    run: noCommands,
    fs: options.fs,
    env: options.env,
  });

// The no-record case that every uninstall test also runs. An entry under our key that the record does not list is left as
// it is, and the step is skipped. The file is the one the scope would use when nothing is recorded.
const unrecordedEntryStays = async (root: string, scope: (typeof SCOPES)[number]): Promise<void> => {
  const file =
    scope === "global" ? path.join(opencodeGlobalDir(process.env), "opencode.json") : projectFileIn(root);
  const text = `${JSON.stringify({ mcp: { [NAME]: entryIn(root) } }, null, 2)}\n`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  const steps = await opencodeAdapter.uninstall(contextIn(root), scope);
  assert.equal(steps[0].status, "skipped");
  assert.equal(await readFile(file, "utf8"), text);
};

// Ends the record of a scope that has one. The file holds no entry, so uninstall forgets the entry, and keeps any backup.
const endRecord = async (root: string, scope: (typeof SCOPES)[number]): Promise<void> => {
  await writeFile(fileIn(root, scope), '{ "theme": "dark" }\n');
  const steps = await opencodeAdapter.uninstall(contextIn(root), scope);
  assert.equal(steps[0].status, "skipped");
};

test("the adapter has the global and project scopes, reports its presence from the context, and refuses the local scope", () =>
  inTemporaryRoot(async (root) => {
    assert.deepEqual([...opencodeAdapter.scopes], ["global", "project"]);
    assert.equal(opencodeAdapter.present(contextIn(root, { present: false })), false);
    assert.equal(opencodeAdapter.present(contextIn(root)), true);
    for (const action of [opencodeAdapter.install, opencodeAdapter.update, opencodeAdapter.uninstall]) {
      await assert.rejects(action(contextIn(root), "local"), UnsupportedScope);
    }
    assert.equal(existsSync(globalFolderIn(root)), false);
    await unrecordedEntryStays(root, "global");
  }));

test("a global install into an empty configuration folder creates opencode.json with the entry, and records the folders, the file and the entry", () =>
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
      { kind: "directory", path: path.join(root, "config") },
      { kind: "directory", path: globalFolderIn(root) },
      { kind: "file", path: file, createdByUs: true },
      { kind: "json-entry", path: file, pointer: POINTER },
    ]);
  }));

test("install keeps another server and another top-level key unchanged, and replaces the entry this tool recorded", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    const other = { type: "remote", url: "https://example.com/mcp" };
    await mkdir(projectIn(root), { recursive: true });
    assert.equal((await opencodeAdapter.install(contextIn(root), "project"))[0].status, "ok");
    const before = `${JSON.stringify({ theme: "dark", mcp: { other, [NAME]: entryIn(root) } }, null, 4)}\n`;
    await writeFile(file, before);
    const steps = await opencodeAdapter.install(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      theme: "dark",
      mcp: { other, [NAME]: entryIn(root) },
    });
    assert.equal(await readFile(`${file}.bak`, "utf8"), before);
    assert.deepEqual(await recordedItems("opencode", scopeKey("project", projectIn(root))), [
      { kind: "file", path: file, createdByUs: true },
      { kind: "json-entry", path: file, pointer: POINTER },
      { kind: "file", path: `${file}.bak`, createdByUs: true },
    ]);
  }));

test("install refuses a file that is not valid JSON, in each scope: the error names the file, the bytes stay, and nothing is backed up or recorded", () =>
  inTemporaryRoot(async (root) => {
    const texts = [
      Buffer.from('{ "mcp": { "token-like-value": "x" ,, }\n'),
      Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]),
    ];
    for (const scope of SCOPES) {
      const file = fileIn(root, scope);
      await mkdir(path.dirname(file), { recursive: true });
      for (const text of texts) {
        await writeFile(file, text);
        const steps = await opencodeAdapter.install(contextIn(root), scope);
        assert.equal(steps[0].status, "error");
        assert.equal(steps[0].message.includes(file), true);
        assert.equal(steps[0].message.includes("not valid JSON"), true);
        assert.equal(steps[0].message.includes("token-like-value"), false);
        assert.deepEqual(await readFile(file), text);
        assert.equal(existsSync(`${file}.bak`), false);
      }
    }
    assert.equal(existsSync(statePath("opencode")), false);
  }));

test("uninstall removes only this tool's entry, keeps the other keys, and keeps a backup of the old bytes", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    const other = { type: "remote", url: "https://example.com/mcp" };
    await mkdir(projectIn(root), { recursive: true });
    assert.equal((await opencodeAdapter.install(contextIn(root), "project"))[0].status, "ok");
    const before = `${JSON.stringify({ theme: "dark", mcp: { other, [NAME]: entryIn(root) } }, null, 2)}\n`;
    await writeFile(file, before);
    const steps = await opencodeAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { theme: "dark", mcp: { other } });
    assert.equal(await readFile(`${file}.bak`, "utf8"), before);
    await unrecordedEntryStays(root, "project");
  }));

test("uninstall without a recorded entry changes nothing: an entry under our key that the record does not list stays", () =>
  inTemporaryRoot(async (root) => {
    for (const scope of SCOPES) {
      const file = fileIn(root, scope);
      const text = `${JSON.stringify(
        { theme: "dark", mcp: { other: { type: "remote", url: "https://example.com/mcp" }, [NAME]: entryIn(root) } },
        null,
        2,
      )}\n`;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, text);
      const steps = await opencodeAdapter.uninstall(contextIn(root), scope);
      assert.deepEqual(steps.map((step) => [step.status, step.message]), [
        ["skipped", "not installed in this scope"],
      ]);
      assert.equal(await readFile(file, "utf8"), text);
      assert.equal(existsSync(`${file}.bak`), false);
    }
    assert.equal(existsSync(statePath("opencode")), false);
  }));

test("install refuses an entry under our key that the record does not list, in each scope, and nothing is written", () =>
  inTemporaryRoot(async (root) => {
    for (const scope of SCOPES) {
      const file = fileIn(root, scope);
      const hand = `${JSON.stringify({ mcp: { [NAME]: { type: "remote", url: "https://hand.example/mcp" } } }, null, 2)}\n`;
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, hand);
      const steps = await opencodeAdapter.install(contextIn(root), scope);
      assert.equal(steps[0].status, "error");
      assert.equal(steps[0].message.includes(file), true);
      assert.equal(steps[0].message.includes(NAME), true);
      assert.equal(steps[0].message.includes("nothing was changed"), true);
      assert.equal(await readFile(file, "utf8"), hand);
      assert.equal(existsSync(`${file}.bak`), false);
    }
    assert.equal(existsSync(statePath("opencode")), false);
  }));

test("update rewrites the entry this tool wrote, and keeps the other keys", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const other = { type: "remote", url: "https://example.com/mcp" };
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    const withOther = `${JSON.stringify({ theme: "dark", mcp: { other, [NAME]: entryIn(root) } }, null, 2)}\n`;
    await writeFile(file, withOther);
    const steps = await opencodeAdapter.update(contextIn(root), "global");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      theme: "dark",
      mcp: { other, [NAME]: entryIn(root) },
    });
    assert.equal(await readFile(`${file}.bak`, "utf8"), withOther);
  }));

test("a write that fails after the records are made leaves records that uninstall reads as absent, and uninstall forgets them without an error", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const failed = await opencodeAdapter.install(contextIn(root, { fs: failingWrites() }), "global");
    assert.equal(failed[0].status, "error");
    assert.equal(failed[0].message.includes(file), true);
    assert.equal(existsSync(file), false);
    assert.equal((await recordedItems("opencode", "global")).length > 0, true);
    const steps = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.deepEqual(
      steps.map((step) => step.status),
      ["skipped"],
    );
    assert.deepEqual(await recordedItems("opencode", "global"), []);
    assert.equal(existsSync(globalFolderIn(root)), false);
    assert.equal(existsSync(path.join(root, "config")), false);
    await unrecordedEntryStays(root, "global");
  }));

test("an install stops before any change when the state file cannot be read", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(path.dirname(statePath("opencode")), { recursive: true });
    await writeFile(statePath("opencode"), "{ not json");
    await assert.rejects(opencodeAdapter.install(contextIn(root), "global"), /cannot be read/);
    assert.equal(existsSync(globalFolderIn(root)), false);
    assert.equal(existsSync(globalFileIn(root)), false);
  }));

test("uninstall after the entry was deleted by hand removes the file this tool created, and the folders it recorded", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    await opencodeAdapter.install(contextIn(root), "global");
    await writeFile(file, `${JSON.stringify({ mcp: {} }, null, 2)}\n`);
    const steps = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(steps[0].status, "ok");
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(globalFolderIn(root)), false);
    assert.deepEqual(await recordedItems("opencode", "global"), []);
    await unrecordedEntryStays(root, "global");
  }));

test("a backup never replaces an earlier one: the new backup takes the next free name, and the step names it", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    await mkdir(projectIn(root), { recursive: true });
    const old = Buffer.from('{"old":1}\n');
    const older = Buffer.from('{"older":2}\n');
    const current = Buffer.from('{"theme":"dark"}\n');
    await writeFile(`${file}.bak`, old);
    await writeFile(`${file}.bak2`, older);
    await writeFile(file, current);
    const steps = await opencodeAdapter.install(contextIn(root), "project");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(await readFile(`${file}.bak`), old);
    assert.deepEqual(await readFile(`${file}.bak2`), older);
    assert.deepEqual(await readFile(`${file}.bak3`), current);
    assert.equal(steps[0].message.includes(`${file}.bak3`), true);
  }));

test("install into a folder that already exists, then uninstall, keeps that folder", () =>
  inTemporaryRoot(async (root) => {
    for (const scope of SCOPES) {
      const file = fileIn(root, scope);
      await mkdir(path.dirname(file), { recursive: true });
      assert.equal((await opencodeAdapter.install(contextIn(root), scope))[0].status, "ok");
      assert.equal((await opencodeAdapter.uninstall(contextIn(root), scope))[0].status, "ok");
      assert.equal(existsSync(file), false);
      assert.equal(existsSync(path.dirname(file)), true);
    }
    await unrecordedEntryStays(root, "global");
    await unrecordedEntryStays(root, "project");
  }));

test("an install that creates the configuration folder removes it on uninstall, and an existing configuration folder is kept", () =>
  inTemporaryRoot(async (root) => {
    const configHome = path.join(root, "config");
    const folder = globalFolderIn(root);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    assert.equal(existsSync(configHome), true);
    assert.equal((await opencodeAdapter.uninstall(contextIn(root), "global"))[0].status, "ok");
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(configHome), false);

    await mkdir(configHome, { recursive: true });
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    assert.equal((await opencodeAdapter.uninstall(contextIn(root), "global"))[0].status, "ok");
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(configHome), true);
    await unrecordedEntryStays(root, "global");
  }));

test("install then update each record the backup they take, and uninstall keeps both backups and names them", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const firstBackup = `${file}.bak`;
    const secondBackup = `${file}.bak2`;
    const thirdBackup = `${file}.bak3`;
    const original = `${JSON.stringify({ theme: "dark" }, null, 2)}\n`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, original);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    const afterInstall = await readFile(file, "utf8");
    assert.equal((await opencodeAdapter.update(contextIn(root), "global"))[0].status, "ok");
    assert.deepEqual(await recordedItems("opencode", "global"), [
      { kind: "json-entry", path: file, pointer: POINTER },
      { kind: "file", path: firstBackup, createdByUs: true },
      { kind: "file", path: secondBackup, createdByUs: true },
    ]);
    assert.equal(await readFile(firstBackup, "utf8"), original);
    assert.equal(await readFile(secondBackup, "utf8"), afterInstall);

    const steps = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(steps[0].status, "ok");
    assert.equal(await readFile(firstBackup, "utf8"), original);
    assert.equal(await readFile(secondBackup, "utf8"), afterInstall);
    assert.equal(steps[0].message.includes(firstBackup), true);
    assert.equal(steps[0].message.includes(secondBackup), true);
    assert.deepEqual(await recordedItems("opencode", "global"), [
      { kind: "file", path: firstBackup, createdByUs: true },
      { kind: "file", path: secondBackup, createdByUs: true },
      { kind: "file", path: thirdBackup, createdByUs: true },
    ]);
    await unrecordedEntryStays(root, "global");
  }));

test("uninstall of a file this tool created removes the file but keeps the backup an update took, and the folder that holds it", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const backup = `${file}.bak`;
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    assert.equal((await opencodeAdapter.update(contextIn(root), "global"))[0].status, "ok");
    const kept = await readFile(backup, "utf8");
    const steps = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(steps[0].status, "ok");
    assert.equal(existsSync(file), false);
    assert.equal(await readFile(backup, "utf8"), kept);
    assert.equal(existsSync(globalFolderIn(root)), true);
    assert.equal(steps[0].message.includes(backup), true);
    await unrecordedEntryStays(root, "global");
  }));

test("update of a scope with nothing recorded changes nothing; update of a recorded scope writes the file once, with a backup", () =>
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
    const writes: string[] = [];
    const updated = await opencodeAdapter.update(contextIn(root, { fs: recordingFiles(writes) }), "global");
    assert.equal(updated[0].status, "ok");
    assert.deepEqual(writes, [`write ${file}.bak`, `write ${file}`]);
    assert.equal(await readFile(file, "utf8"), installed);
    assert.equal(await readFile(`${file}.bak`, "utf8"), installed);
  }));

test("a dry run through the planner changes no file and writes no state, and lists each change in order, saying what would happen", () =>
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
    assert.equal(project.steps[0].message.startsWith("Would write"), true);
    assert.deepEqual(project.shown, [`write ${file}.bak`, `write ${file}`]);

    const global = await runPlan({
      adapters: [opencodeAdapter],
      action: "install",
      agents: ["opencode"],
      scope: "global",
      ctx: contextIn(root, { dryRun: true, fs: fakeFiles(effects) }),
    });
    assert.equal(global.steps[0].status, "ok");
    assert.equal(global.steps[0].message.startsWith("Would write"), true);
    assert.deepEqual(global.shown, [
      `mkdir ${path.join(root, "config")}`,
      `mkdir ${globalFolderIn(root)}`,
      `write ${globalFileIn(root)}`,
    ]);

    assert.deepEqual(effects, []);
    assert.deepEqual(await readFile(file), before);
    assert.equal(existsSync(globalFolderIn(root)), false);
    assert.equal(existsSync(statePath("opencode")), false);
  }));

test("a file whose mcp value or top level is not an object is refused with unexpected contents, and nothing changes", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    // A recorded install gives uninstall a record to act on, so the refusal of uninstall is tested as well.
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
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
    // A file with no entry ends the record, so the no-record case can run.
    await writeFile(file, '{ "theme": "dark" }\n');
    assert.equal((await opencodeAdapter.uninstall(contextIn(root), "global"))[0].status, "skipped");
    await unrecordedEntryStays(root, "global");
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

test("the global folder is the XDG configuration folder when that is an absolute path, otherwise .config in the home folder", () =>
  inTemporaryRoot(async () => {
    const home = path.resolve("home-for-test");
    const xdg = path.resolve("xdg-for-test");
    const homeEnv = { HOME: home, USERPROFILE: home };
    assert.equal(opencodeGlobalDir({ XDG_CONFIG_HOME: xdg }), path.join(xdg, "opencode"));
    assert.equal(opencodeGlobalDir({ ...homeEnv, XDG_CONFIG_HOME: "" }), path.join(home, ".config", "opencode"));
    assert.equal(opencodeGlobalDir(homeEnv), path.join(home, ".config", "opencode"));
    assert.equal(opencodeGlobalDir({ ...homeEnv, XDG_CONFIG_HOME: "relative" }), path.join(home, ".config", "opencode"));
    assert.throws(() => opencodeGlobalDir({}), /home folder is not known/);
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
    await unrecordedEntryStays(root, "global");
  }));

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
    assert.deepEqual(await recordedItems("opencode", "global"), [
      { kind: "directory", path: path.join(root, "config-a") },
      { kind: "directory", path: path.dirname(fileA) },
      { kind: "file", path: `${fileA}.bak`, createdByUs: true },
    ]);
    await unrecordedEntryStays(root, "global");
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
      { kind: "directory", path: path.join(root, "config-a") },
      { kind: "directory", path: path.dirname(fileA) },
      { kind: "file", path: fileA, createdByUs: true },
      { kind: "json-entry", path: fileA, pointer: POINTER },
      { kind: "file", path: `${fileA}.bak`, createdByUs: true },
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

test("a backup that an earlier uninstall kept is named by each later uninstall, and stays on the record", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const firstBackup = `${file}.bak`;
    const secondBackup = `${file}.bak2`;
    // Install into a folder that does not exist yet, update, uninstall: the first backup is named.
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    assert.equal((await opencodeAdapter.update(contextIn(root), "global"))[0].status, "ok");
    const first = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(first[0].status, "ok");
    assert.equal(first[0].message.includes(firstBackup), true);
    // The second round: install, update, uninstall. Both backups stay, and both are named.
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    assert.equal((await opencodeAdapter.update(contextIn(root), "global"))[0].status, "ok");
    const second = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(second[0].status, "ok");
    assert.equal(existsSync(firstBackup), true);
    assert.equal(existsSync(secondBackup), true);
    assert.equal(second[0].message.includes(firstBackup), true);
    assert.equal(second[0].message.includes(secondBackup), true);
    // With no entry recorded, a later uninstall keeps both and names both.
    const third = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(third[0].message.includes(firstBackup), true);
    assert.equal(third[0].message.includes(secondBackup), true);
    await unrecordedEntryStays(root, "global");
  }));

test("a record whose pointer is not this tool's entry does not count as recorded, so install refuses the key and uninstall leaves it", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const hand = `${JSON.stringify({ mcp: { [NAME]: { type: "remote", url: "https://hand.example/mcp" } } }, null, 2)}\n`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, hand);
    await record("opencode", "global", { kind: "json-entry", path: file, pointer: "/mcp/other" });
    const installed = await opencodeAdapter.install(contextIn(root), "global");
    assert.equal(installed[0].status, "error");
    assert.equal(installed[0].message.includes(NAME), true);
    assert.equal(await readFile(file, "utf8"), hand);
    const removed = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(removed[0].status, "skipped");
    assert.equal(await readFile(file, "utf8"), hand);
    await unrecordedEntryStays(root, "global");
  }));

test("a config write that fails after the backup is made gives an error step that names the backup, and the file is not changed", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    const backup = `${file}.bak`;
    const before = `${JSON.stringify({ theme: "dark" }, null, 2)}\n`;
    await mkdir(projectIn(root), { recursive: true });
    await writeFile(file, before);
    const steps = await opencodeAdapter.install(contextIn(root, { fs: failingWriteTo(file) }), "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(file), true);
    assert.equal(steps[0].message.includes(backup), true);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(await readFile(backup, "utf8"), before);
  }));

test("a backup that cannot be written gives an error step that names it, and the file is not changed", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    const backup = `${file}.bak`;
    const before = `${JSON.stringify({ theme: "dark" }, null, 2)}\n`;
    await mkdir(projectIn(root), { recursive: true });
    await writeFile(file, before);
    const steps = await opencodeAdapter.install(contextIn(root, { fs: failingWriteTo(backup) }), "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(backup), true);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(existsSync(backup), false);
  }));

test("an uninstall whose config write fails after the backup gives an error step that names the backup", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    const backup = `${file}.bak`;
    await mkdir(projectIn(root), { recursive: true });
    assert.equal((await opencodeAdapter.install(contextIn(root), "project"))[0].status, "ok");
    const before = `${JSON.stringify({ theme: "dark", mcp: { [NAME]: entryIn(root) } }, null, 2)}\n`;
    await writeFile(file, before);
    const steps = await opencodeAdapter.uninstall(contextIn(root, { fs: failingWriteTo(file) }), "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(file), true);
    assert.equal(steps[0].message.includes(backup), true);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(await readFile(backup, "utf8"), before);
    await endRecord(root, "project");
    await unrecordedEntryStays(root, "project");
  }));

test("an uninstall whose backup cannot be written leaves the file as it was", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    const backup = `${file}.bak`;
    await mkdir(projectIn(root), { recursive: true });
    assert.equal((await opencodeAdapter.install(contextIn(root), "project"))[0].status, "ok");
    const before = `${JSON.stringify({ theme: "dark", mcp: { [NAME]: entryIn(root) } }, null, 2)}\n`;
    await writeFile(file, before);
    const steps = await opencodeAdapter.uninstall(contextIn(root, { fs: failingWriteTo(backup) }), "project");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(backup), true);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(existsSync(backup), false);
    await endRecord(root, "project");
    await unrecordedEntryStays(root, "project");
  }));

test("a rewrite is refused when a number would be written with other text or a key is repeated, and nothing changes", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    await mkdir(path.dirname(file), { recursive: true });
    for (const text of ['{ "limit": 12345678901234567890 }\n', '{ "a": 1, "a": 2 }\n', '{ "limit": 1e2 }\n']) {
      await writeFile(file, text);
      const steps = await opencodeAdapter.install(contextIn(root), "global");
      assert.equal(steps[0].status, "error");
      assert.equal(steps[0].message.includes(file), true);
      assert.equal(await readFile(file, "utf8"), text);
      assert.equal(existsSync(`${file}.bak`), false);
    }
    assert.equal(existsSync(statePath("opencode")), false);
    // The same refusal holds for uninstall, when the entry is recorded and the file holds a large number.
    await rm(file);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    const withBigNumber = `{"limit": 12345678901234567890, "mcp": {"${NAME}": ${JSON.stringify(entryIn(root))}}}\n`;
    await writeFile(file, withBigNumber);
    const removed = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(removed[0].status, "error");
    assert.equal(await readFile(file, "utf8"), withBigNumber);
    assert.equal(existsSync(`${file}.bak`), false);
    await endRecord(root, "global");
    await unrecordedEntryStays(root, "global");
  }));

test("uninstall names the folders it removed, and says that no server entry was removed, or would be in a dry run", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const folder = globalFolderIn(root);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    await rm(file);
    // A dry run names the folders it would remove, removes none, and does not say that nothing was removed.
    const dry = await opencodeAdapter.uninstall(contextIn(root, { dryRun: true }), "global");
    assert.equal(dry[0].message.includes(folder), true);
    assert.equal(dry[0].message.includes("nothing was removed"), false);
    assert.equal(dry[0].message.includes("so no server entry would be removed"), true);
    assert.equal(existsSync(folder), true);
    const real = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(real[0].message.includes(folder), true);
    assert.equal(real[0].message.includes("nothing was removed"), false);
    assert.equal(real[0].message.includes("so no server entry was removed"), true);
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(path.join(root, "config")), false);
    await unrecordedEntryStays(root, "global");
  }));

test("uninstall writes the backup after it is recorded, and writes the file after the backup", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    const backup = `${file}.bak`;
    const key = scopeKey("project", projectIn(root));
    await mkdir(projectIn(root), { recursive: true });
    assert.equal((await opencodeAdapter.install(contextIn(root), "project"))[0].status, "ok");
    const before = `${JSON.stringify({ theme: "dark", mcp: { [NAME]: entryIn(root) } }, null, 2)}\n`;
    await writeFile(file, before);
    const log: string[] = [];
    const steps = await opencodeAdapter.uninstall(contextIn(root, { fs: orderedFiles(log, key) }), "project");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(log, [`write ${backup} recorded`, `write ${file} recorded`]);
    await unrecordedEntryStays(root, "project");
  }));

test("an install whose configuration folder has missing parents records those parents, and uninstall removes them too", () =>
  inTemporaryRoot(async (root) => {
    const configHome = path.join(root, "deep", "parent", "cfg");
    const file = path.join(configHome, "opencode", "opencode.json");
    process.env[CONFIG_ENV] = configHome;
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    assert.equal(existsSync(file), true);
    assert.equal((await opencodeAdapter.uninstall(contextIn(root), "global"))[0].status, "ok");
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(path.join(root, "deep")), false);
    assert.deepEqual(await recordedItems("opencode", "global"), []);
    await unrecordedEntryStays(root, "global");
  }));

test("uninstall of a file that repeats a key is refused, so no copy of the key is lost", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    // The first copy holds another server, and the last copy holds only this tool's entry.
    const repeated = `{"mcp": {"other": {"type": "remote", "url": "https://example.com/mcp"}}, "mcp": {"${NAME}": ${JSON.stringify(entryIn(root))}}}\n`;
    await writeFile(file, repeated);
    const steps = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(file), true);
    assert.equal(await readFile(file, "utf8"), repeated);
    assert.equal(existsSync(`${file}.bak`), false);
    await endRecord(root, "global");
    await unrecordedEntryStays(root, "global");
  }));

test("uninstall names the kept backups in each of nine steps: invalid JSON, unexpected contents, an unchanged rewrite, a refused rewrite, a repeated key, a failed backup write, a failed config write, a removal that throws, and an absent entry", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const backup = `${file}.bak`;
    const entry = JSON.stringify(entryIn(root));
    // An earlier uninstall keeps a backup, and install records the entry again, so the record holds the backup.
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    assert.equal((await opencodeAdapter.update(contextIn(root), "global"))[0].status, "ok");
    assert.equal((await opencodeAdapter.uninstall(contextIn(root), "global"))[0].status, "ok");
    assert.equal(existsSync(backup), true);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    // The four steps that report a record that could not be finished are not run here. A record cannot be made to fail
    // without a seam in the state file, so those steps have no test.
    const scenarios: { name: string; text: string; fs?: FileOps; status: string }[] = [
      { name: "invalid JSON", text: "{ broken", status: "error" },
      { name: "a mcp value that is not an object", text: '{ "mcp": [] }', status: "error" },
      { name: "a number that does not survive a rewrite", text: `{"limit": 1e400, "mcp": {"${NAME}": ${entry}}}`, status: "error" },
      { name: "a number the rewrite would write differently", text: `{"limit": 12345678901234567890, "mcp": {"${NAME}": ${entry}}}`, status: "error" },
      { name: "a key the file repeats", text: `{"mcp": {"other": {}}, "mcp": {"${NAME}": ${entry}}}`, status: "error" },
      { name: "a backup that cannot be written", text: `{"theme": "dark", "mcp": {"${NAME}": ${entry}}}`, fs: failingWriteTo(`${file}.bak2`), status: "error" },
      { name: "a config write that fails after the backup", text: `{"theme": "dark", "mcp": {"${NAME}": ${entry}}}`, fs: failingWriteTo(file), status: "error" },
      { name: "a removal that throws", text: `{"mcp": {"${NAME}": ${entry}}}`, fs: failingRemovalOf(file), status: "error" },
      { name: "an entry that is absent", text: '{ "theme": "dark" }', status: "skipped" },
    ];
    for (const scenario of scenarios) {
      await writeFile(file, scenario.text);
      const steps = await opencodeAdapter.uninstall(contextIn(root, { fs: scenario.fs }), "global");
      assert.equal(steps[0].status, scenario.status, scenario.name);
      assert.equal(namesBackup(steps[0].message, backup), true, scenario.name);
    }
    await unrecordedEntryStays(root, "global");
  }));

test("a dry run of uninstall says what would happen, and changes no file", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    await mkdir(projectIn(root), { recursive: true });
    assert.equal((await opencodeAdapter.install(contextIn(root), "project"))[0].status, "ok");
    const before = `${JSON.stringify({ theme: "dark", mcp: { other: { type: "remote", url: "https://example.com/mcp" }, [NAME]: entryIn(root) } }, null, 2)}\n`;
    await writeFile(file, before);
    // A backup that an earlier uninstall kept is on the record, so the dry run names it as one that would be kept.
    const earlier = `${file}.bak`;
    await writeFile(earlier, "kept\n");
    await record("opencode", scopeKey("project", projectIn(root)), { kind: "file", path: earlier, createdByUs: true });
    const partial = await opencodeAdapter.uninstall(contextIn(root, { dryRun: true }), "project");
    assert.equal(partial[0].message.startsWith("Would remove the server entry from"), true);
    assert.equal(partial[0].message.includes("Backups that would be kept"), true);
    assert.equal(await readFile(file, "utf8"), before);
    assert.equal(await readFile(earlier, "utf8"), "kept\n");
    assert.equal(existsSync(`${file}.bak2`), false);

    const globalFile = globalFileIn(root);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    const created = await opencodeAdapter.uninstall(contextIn(root, { dryRun: true }), "global");
    assert.equal(created[0].message.startsWith(`Would remove ${globalFile}, which this tool created.`), true);
    assert.equal(created[0].message.includes("Would remove the folders this tool made, if they are empty"), true);
    assert.equal(existsSync(globalFile), true);
    await endRecord(root, "project");
    await unrecordedEntryStays(root, "project");
    await endRecord(root, "global");
    await unrecordedEntryStays(root, "global");
  }));

test("install refuses when a folder on the way to its file is not a folder, and records nothing", () =>
  inTemporaryRoot(async (root) => {
    // A file where the opencode folder should be.
    await mkdir(path.join(root, "config"), { recursive: true });
    const folderAsFile = globalFolderIn(root);
    await writeFile(folderAsFile, "kept\n");
    const steps = await opencodeAdapter.install(contextIn(root), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(folderAsFile), true);
    assert.equal(steps[0].message.includes("is not a folder"), true);
    assert.equal(await readFile(folderAsFile, "utf8"), "kept\n");
    assert.deepEqual(await recordedItems("opencode", "global"), []);
    // A file where the configuration folder should be, when XDG_CONFIG_HOME names it.
    const configAsFile = path.join(root, "xdg-file");
    await writeFile(configAsFile, "kept\n");
    process.env[CONFIG_ENV] = configAsFile;
    const named = await opencodeAdapter.install(contextIn(root), "global");
    assert.equal(named[0].status, "error");
    assert.equal(named[0].message.includes(configAsFile), true);
    assert.equal(await readFile(configAsFile, "utf8"), "kept\n");
    assert.deepEqual(await recordedItems("opencode", "global"), []);
    assert.equal(existsSync(statePath("opencode")), false);
  }));

test("a folder this tool made that a kept backup holds is removed by a later uninstall once the backup is deleted", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const backup = `${file}.bak`;
    const folder = globalFolderIn(root);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    assert.equal((await opencodeAdapter.update(contextIn(root), "global"))[0].status, "ok");
    assert.equal((await opencodeAdapter.uninstall(contextIn(root), "global"))[0].status, "ok");
    assert.equal(existsSync(backup), true);
    assert.equal(existsSync(folder), true);
    await rm(backup);
    const steps = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(steps[0].status, "skipped");
    assert.equal(existsSync(folder), false);
    assert.equal(existsSync(path.join(root, "config")), false);
    assert.deepEqual(await recordedItems("opencode", "global"), []);
    await unrecordedEntryStays(root, "global");
  }));

test("install refuses a dangling link where the opencode folder should be, and changes nothing", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(path.join(root, "config"), { recursive: true });
    const folder = globalFolderIn(root);
    const missing = path.join(root, "nowhere");
    // A junction needs no privilege on Windows. On other systems it is an ordinary link.
    await symlink(missing, folder, "junction");
    const steps = await opencodeAdapter.install(contextIn(root), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(folder), true);
    assert.equal(steps[0].message.includes("is not a folder"), true);
    assert.equal((await lstat(folder)).isSymbolicLink(), true);
    assert.equal(existsSync(missing), false);
    assert.equal(existsSync(globalFileIn(root)), false);
    assert.deepEqual(await recordedItems("opencode", "global"), []);
    assert.equal(existsSync(statePath("opencode")), false);
  }));

test("install accepts a link to a folder where the opencode folder should be", () =>
  inTemporaryRoot(async (root) => {
    const real = path.join(root, "real-opencode");
    await mkdir(real, { recursive: true });
    await mkdir(path.join(root, "config"), { recursive: true });
    await symlink(real, globalFolderIn(root), "junction");
    const steps = await opencodeAdapter.install(contextIn(root), "global");
    assert.equal(steps[0].status, "ok");
    assert.equal(existsSync(path.join(real, "opencode.json")), true);
  }));

test("uninstall that removes the file but cannot remove a folder says the entry was removed, and a later uninstall finishes", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    const folder = globalFolderIn(root);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    const steps = await opencodeAdapter.uninstall(contextIn(root, { fs: failingFolderRemoval() }), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.startsWith(`The server entry was removed from ${file}`), true);
    assert.equal(steps[0].message.includes("could not be removed (EPERM)"), true);
    assert.equal(steps[0].message.includes("Uninstall stopped"), false);
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(folder), true);
    // The record is kept, so a later uninstall removes the folders and ends the record.
    const later = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(later[0].status, "skipped");
    assert.equal(existsSync(folder), false);
    assert.deepEqual(await recordedItems("opencode", "global"), []);
    await unrecordedEntryStays(root, "global");
  }));

test("uninstall that cannot look up a recorded backup reports the stop in one step, and does not throw", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    // A path with a NUL character cannot be looked up, so the lookup throws a code that is not ENOENT.
    const unreachable = path.join(root, "config", "bad\u0000dir", "opencode.json.bak");
    const text = `${JSON.stringify({ mcp: { [NAME]: entryIn(root) } }, null, 2)}\n`;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
    await record("opencode", "global", { kind: "file", path: unreachable, createdByUs: true });
    await record("opencode", "global", { kind: "json-entry", path: file, pointer: POINTER });
    const steps = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.startsWith("Uninstall stopped ("), true);
    assert.equal(steps[0].message.includes("ERR_INVALID_ARG_VALUE"), true);
    assert.equal(await readFile(file, "utf8"), text);
    await forget("opencode", "global");
    await unrecordedEntryStays(root, "global");
  }));

test("install and update refuse a missing project folder, in a real run and a dry run, and create nothing", () =>
  inTemporaryRoot(async (root) => {
    const project = projectIn(root);
    const key = scopeKey("project", project);
    const message = `The project folder ${project} does not exist, so nothing was created or changed.`;
    for (const dryRun of [false, true]) {
      const effects: string[] = [];
      const steps = await opencodeAdapter.install(contextIn(root, { dryRun, fs: recordingFiles(effects) }), "project");
      assert.deepEqual(
        steps.map((step) => [step.status, step.message]),
        [["error", message]],
      );
      assert.deepEqual(effects, []);
      assert.equal(existsSync(project), false);
      assert.equal(existsSync(statePath("opencode")), false);
    }
    // A recorded entry whose project folder has since gone: update refuses too, and the record does not change.
    await mkdir(project, { recursive: true });
    assert.equal((await opencodeAdapter.install(contextIn(root), "project"))[0].status, "ok");
    const recorded = await recordedItems("opencode", key);
    await rm(project, { recursive: true, force: true });
    for (const dryRun of [false, true]) {
      const effects: string[] = [];
      const steps = await opencodeAdapter.update(contextIn(root, { dryRun, fs: recordingFiles(effects) }), "project");
      assert.deepEqual(
        steps.map((step) => [step.status, step.message]),
        [["error", message]],
      );
      assert.deepEqual(effects, []);
      assert.equal(existsSync(project), false);
      assert.deepEqual(await recordedItems("opencode", key), recorded);
    }
  }));

test("uninstall never removes the project folder, even when a record lists it", () =>
  inTemporaryRoot(async (root) => {
    const project = projectIn(root);
    await mkdir(project, { recursive: true });
    await record("opencode", scopeKey("project", project), { kind: "directory", path: project });
    const steps = await opencodeAdapter.uninstall(contextIn(root), "project");
    assert.equal(steps[0].status, "skipped");
    assert.equal(existsSync(project), true);
    await unrecordedEntryStays(root, "project");
  }));

test("the global folder comes from the environment the context carries: a config home there is used, and a home there is used when no config home is given", () =>
  inTemporaryRoot(async (root) => {
    const altConfig = path.join(root, "alt-config");
    const configEnv = { ...process.env, XDG_CONFIG_HOME: altConfig };
    assert.equal((await opencodeAdapter.install(contextIn(root, { env: configEnv }), "global"))[0].status, "ok");
    assert.equal(existsSync(path.join(altConfig, "opencode", "opencode.json")), true);
    assert.equal(existsSync(globalFileIn(root)), false);
    assert.equal((await opencodeAdapter.uninstall(contextIn(root, { env: configEnv }), "global"))[0].status, "ok");
    const altHome = path.join(root, "alt-home");
    const homeEnv = { ...process.env, XDG_CONFIG_HOME: undefined, HOME: altHome, USERPROFILE: altHome };
    assert.equal((await opencodeAdapter.install(contextIn(root, { env: homeEnv }), "global"))[0].status, "ok");
    assert.equal(existsSync(path.join(altHome, ".config", "opencode", "opencode.json")), true);
    // Nothing is written under the real home, which the isolated environment names as the root's home folder.
    assert.equal(existsSync(path.join(root, "home", ".config")), false);
    assert.equal((await opencodeAdapter.uninstall(contextIn(root, { env: homeEnv }), "global"))[0].status, "ok");
    await unrecordedEntryStays(root, "global");
  }));

test("a global install with no home folder and no config home in the context's environment is refused, and nothing is written under the real home", () =>
  inTemporaryRoot(async (root) => {
    const env = { MULTI_ACCOUNT_SUPABASE_HOME: path.join(root, "data") };
    await assert.rejects(opencodeAdapter.install(contextIn(root, { env }), "global"), /home folder is not known/);
    assert.equal(existsSync(path.join(root, "home", ".config")), false);
    assert.equal(existsSync(path.join(root, "config")), false);
  }));

test("doctor checks each scope on its own: an unreadable project file gives an error step there, and the global step is still ok", () =>
  inTemporaryRoot(async (root) => {
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    await mkdir(projectIn(root), { recursive: true });
    assert.equal((await opencodeAdapter.install(contextIn(root), "project"))[0].status, "ok");
    // A folder where the project file should be: reading it fails, and the other scope is still checked.
    await rm(projectFileIn(root));
    await mkdir(projectFileIn(root));
    const steps = await opencodeAdapter.doctor(contextIn(root));
    assert.deepEqual(
      steps.map((step) => [step.scope, step.status]),
      [
        ["global", "ok"],
        ["project", "error"],
      ],
    );
  }));

test("doctor gives each scope its own error step when the record cannot be read", () =>
  inTemporaryRoot(async (root) => {
    await mkdir(path.dirname(statePath("opencode")), { recursive: true });
    await writeFile(statePath("opencode"), "{ not json");
    const steps = await opencodeAdapter.doctor(contextIn(root));
    assert.deepEqual(
      steps.map((step) => [step.scope, step.status]),
      [
        ["global", "error"],
        ["project", "error"],
      ],
    );
  }));

test("uninstall leaves an entry whose command was edited in place, keeps its record, and says why", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    const edited = `${JSON.stringify({ mcp: { [NAME]: { type: "local", command: ["other-node", "other-cli", "serve"], enabled: true } } }, null, 2)}\n`;
    await writeFile(file, edited);
    const recorded = await recordedItems("opencode", "global");
    const steps = await opencodeAdapter.uninstall(contextIn(root), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(file), true);
    assert.equal(steps[0].message.includes("was edited, so it was left in place"), true);
    assert.equal(steps[0].message.includes("The record stays until then."), true);
    assert.equal(await readFile(file, "utf8"), edited);
    assert.equal(existsSync(`${file}.bak`), false);
    assert.deepEqual(await recordedItems("opencode", "global"), recorded);
    await forget("opencode", "global");
    await unrecordedEntryStays(root, "global");
  }));

test("update leaves an entry whose command was edited in place, and keeps its record", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    const edited = `${JSON.stringify({ mcp: { [NAME]: { type: "local", command: ["other-node", "other-cli", "serve"], enabled: true } } }, null, 2)}\n`;
    await writeFile(file, edited);
    const recorded = await recordedItems("opencode", "global");
    const steps = await opencodeAdapter.update(contextIn(root), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes("was edited, so it was left in place"), true);
    assert.equal(steps[0].message.includes("The record stays until then."), true);
    assert.equal(await readFile(file, "utf8"), edited);
    assert.equal(existsSync(`${file}.bak`), false);
    assert.deepEqual(await recordedItems("opencode", "global"), recorded);
    await forget("opencode", "global");
    await unrecordedEntryStays(root, "global");
  }));

test("install leaves a recorded entry that was edited in place, keeps its record, and the step is an error", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    const edited = `${JSON.stringify({ mcp: { [NAME]: { type: "local", command: ["other-node", "other-cli", "serve"], enabled: true } } }, null, 2)}\n`;
    await writeFile(file, edited);
    const recorded = await recordedItems("opencode", "global");
    const steps = await opencodeAdapter.install(contextIn(root), "global");
    assert.equal(steps[0].status, "error");
    assert.equal(steps[0].message.includes(file), true);
    assert.equal(steps[0].message.includes("was edited, so it was left in place"), true);
    assert.equal(steps[0].message.includes("The record stays until then."), true);
    assert.equal(await readFile(file, "utf8"), edited);
    assert.equal(existsSync(`${file}.bak`), false);
    assert.deepEqual(await recordedItems("opencode", "global"), recorded);
    await forget("opencode", "global");
    await unrecordedEntryStays(root, "global");
  }));

test("install replaces a recorded entry this tool wrote, keeps the other keys, and keeps a backup of the old bytes", () =>
  inTemporaryRoot(async (root) => {
    const file = globalFileIn(root);
    assert.equal((await opencodeAdapter.install(contextIn(root), "global"))[0].status, "ok");
    const before = `${JSON.stringify({ theme: "dark", mcp: { [NAME]: entryIn(root) } }, null, 2)}\n`;
    await writeFile(file, before);
    const steps = await opencodeAdapter.install(contextIn(root), "global");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { theme: "dark", mcp: { [NAME]: entryIn(root) } });
    assert.equal(await readFile(`${file}.bak`, "utf8"), before);
  }));

test("install writes a backup after it is recorded, and writes the file after the backup", () =>
  inTemporaryRoot(async (root) => {
    const file = projectFileIn(root);
    const backup = `${file}.bak`;
    const key = scopeKey("project", projectIn(root));
    await mkdir(projectIn(root), { recursive: true });
    await writeFile(file, `${JSON.stringify({ theme: "dark" }, null, 2)}\n`);
    const log: string[] = [];
    const steps = await opencodeAdapter.install(contextIn(root, { fs: orderedFiles(log, key) }), "project");
    assert.equal(steps[0].status, "ok");
    assert.deepEqual(log, [`write ${backup} recorded`, `write ${file}`]);
  }));
