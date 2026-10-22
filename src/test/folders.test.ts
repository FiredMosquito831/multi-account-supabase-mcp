import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensureFolders, folderChain, isFolder, recordThenUndo, removeRecordedFolders } from "../agents/folders.js";
import type { Item } from "../agents/state.js";
import { type Context, type FileOps, makeContext } from "../agents/types.js";
import { assertIsolated, inTemporaryRoot } from "./isolation.js";

// A context for a real run or a dry run in the root. No command runs in these tests, so no runner is needed.
const contextIn = (root: string, dryRun = false): Context =>
  makeContext({ projectDir: root, cliPath: path.join(root, "cli.js"), packageRoot: root, dryRun });

test("folderChain lists the folders from the base down to the target, base first, and the base alone for the base", () =>
  inTemporaryRoot(async (root) => {
    assertIsolated(root);
    const base = path.resolve("fake-base");
    assert.deepEqual(folderChain(base, path.join(base, "one", "two")), [
      base,
      path.join(base, "one"),
      path.join(base, "one", "two"),
    ]);
    assert.deepEqual(folderChain(base, base), [base]);
  }));

test("folderChain refuses a target outside the base, but accepts a name that starts with two dots", () =>
  inTemporaryRoot(async (root) => {
    assertIsolated(root);
    const base = path.resolve("fake-base");
    assert.throws(() => folderChain(base, path.resolve("fake-other")));
    assert.throws(() => folderChain(base, path.join(base, "..", "elsewhere")));
    assert.deepEqual(folderChain(base, path.join(base, "..folder")), [base, path.join(base, "..folder")]);
  }));

test("ensureFolders makes each missing folder on the way to the target, in order, and returns them", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "base");
    const target = path.join(base, "one", "two");
    const made = await ensureFolders(contextIn(root), base, target);
    assert.deepEqual(made, [base, path.join(base, "one"), target]);
    assert.equal(existsSync(target), true);
  }));

test("ensureFolders leaves the folders that exist, and returns only the ones it made", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "base");
    await mkdir(path.join(base, "one"), { recursive: true });
    const target = path.join(base, "one", "two", "three");
    const made = await ensureFolders(contextIn(root), base, target);
    assert.deepEqual(made, [path.join(base, "one", "two"), target]);
  }));

test("ensureFolders makes the base when the target is the base, and returns nothing once it exists", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "base");
    assert.deepEqual(await ensureFolders(contextIn(root), base, base), [base]);
    assert.deepEqual(await ensureFolders(contextIn(root), base, base), []);
  }));

test("a dry run lists a mkdir for each missing folder and returns them, and makes none", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "base");
    const target = path.join(base, "one", "two");
    const ctx = contextIn(root, true);
    const made = await ensureFolders(ctx, base, target);
    assert.deepEqual(made, [base, path.join(base, "one"), target]);
    assert.deepEqual(ctx.shown, [`mkdir ${base}`, `mkdir ${path.join(base, "one")}`, `mkdir ${target}`]);
    assert.equal(existsSync(base), false);
  }));

test("a target outside the base is refused before any folder is made", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "base");
    await assert.rejects(ensureFolders(contextIn(root), base, path.join(root, "elsewhere")));
    assert.equal(existsSync(base), false);
  }));

test("a file in the way is reported, and is kept as it is", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "base");
    await mkdir(base, { recursive: true });
    await writeFile(path.join(base, "one"), "kept\n");
    await assert.rejects(ensureFolders(contextIn(root), base, path.join(base, "one", "two")));
    assert.equal(await readFile(path.join(base, "one"), "utf8"), "kept\n");
  }));

test("removeRecordedFolders removes only the recorded folders, deepest first, and keeps a folder that is not recorded or still holds a file", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "base");
    const one = path.join(base, "one");
    const two = path.join(one, "two");
    await ensureFolders(contextIn(root), base, two);
    await writeFile(path.join(base, "kept.txt"), "kept\n");
    // One is on the chain but not in the record, as if it existed before, so it is kept even though it is empty.
    const items: Item[] = [
      { kind: "directory", path: base },
      { kind: "directory", path: two },
    ];
    await removeRecordedFolders(contextIn(root), items, [base, one, two]);
    assert.equal(existsSync(two), false);
    assert.equal(existsSync(one), true);
    assert.equal(await readFile(path.join(base, "kept.txt"), "utf8"), "kept\n");
    assert.equal(existsSync(base), true);
  }));

test("a dry run of removeRecordedFolders lists each removal and removes nothing", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "base");
    const two = path.join(base, "one", "two");
    await ensureFolders(contextIn(root), base, two);
    const items: Item[] = [
      { kind: "directory", path: base },
      { kind: "directory", path: path.join(base, "one") },
      { kind: "directory", path: two },
    ];
    const ctx = contextIn(root, true);
    await removeRecordedFolders(ctx, items, [base, path.join(base, "one"), two]);
    assert.deepEqual(ctx.shown, [`remove empty folder ${two}`, `remove empty folder ${path.join(base, "one")}`, `remove empty folder ${base}`]);
    assert.equal(existsSync(two), true);
  }));

// File functions for a real run in which one folder cannot be made. The other folders are made and removed on the disk.
// The blocked folder fails with EEXIST, as it would if a regular file were in its place. A regular file cannot sit in that
// place on the disk without also sitting inside the folder above it, so this failure is produced here instead.
const filesBlocking = (blocked: string): FileOps => ({
  writeFile: async () => {
    throw new Error("writeFile is not used by ensureFolders");
  },
  removeFile: async () => {
    throw new Error("removeFile is not used by ensureFolders");
  },
  ensureDir: async (dir) => {
    if (dir === blocked) {
      throw Object.assign(new Error(`EEXIST: file already exists, mkdir '${dir}'`), { code: "EEXIST" });
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

test("a folder that cannot be made stops the call with its error, removes the folders this call made, and keeps the ones that existed", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "base");
    const one = path.join(base, "one");
    const two = path.join(one, "two");
    await mkdir(base);
    const ctx = makeContext({
      projectDir: root,
      cliPath: path.join(root, "cli.js"),
      packageRoot: root,
      dryRun: false,
      fs: filesBlocking(two),
    });
    await assert.rejects(ensureFolders(ctx, base, two), /EEXIST/);
    assert.equal(existsSync(one), false);
    assert.equal(existsSync(base), true);
  }));

test("ensureFolders makes and returns a missing parent of the base, parents first, so the parent is recorded too", () =>
  inTemporaryRoot(async (root) => {
    const tools = path.join(root, "tools");
    const base = path.join(tools, "codex");
    const skills = path.join(base, "skills");
    assert.deepEqual(await ensureFolders(contextIn(root), base, skills), [tools, base, skills]);
    assert.equal(existsSync(skills), true);
  }));

test("a dry run lists the missing parent of the base as well, and makes none", () =>
  inTemporaryRoot(async (root) => {
    const tools = path.join(root, "tools");
    const base = path.join(tools, "codex");
    const skills = path.join(base, "skills");
    const ctx = contextIn(root, true);
    await ensureFolders(ctx, base, skills);
    assert.deepEqual(ctx.shown, [`mkdir ${tools}`, `mkdir ${base}`, `mkdir ${skills}`]);
    assert.equal(existsSync(tools), false);
  }));

test("a failed creation removes the missing parent of the base that the call made, too", () =>
  inTemporaryRoot(async (root) => {
    const tools = path.join(root, "tools");
    const base = path.join(tools, "codex");
    const skills = path.join(base, "skills");
    const ctx = makeContext({
      projectDir: root,
      cliPath: path.join(root, "cli.js"),
      packageRoot: root,
      dryRun: false,
      fs: filesBlocking(skills),
    });
    await assert.rejects(ensureFolders(ctx, base, skills), /EEXIST/);
    assert.equal(existsSync(tools), false);
  }));

test("every folder variable of a test points into its temporary root", () =>
  inTemporaryRoot(async (root) => {
    assertIsolated(root);
  }));

// File functions for a real run in which one folder cannot be made, and another cannot be removed. Every other folder is made
// and removed on the disk.
const filesRefusingAndKeeping = (refused: string, unremovable: string): FileOps => ({
  writeFile: async () => {
    throw new Error("writeFile is not used by ensureFolders");
  },
  removeFile: async () => {
    throw new Error("removeFile is not used by ensureFolders");
  },
  ensureDir: async (dir) => {
    if (dir === refused) {
      throw Object.assign(new Error(`EPERM: operation not permitted, mkdir '${dir}'`), { code: "EPERM" });
    }
    await mkdir(dir);
  },
  removeDirIfEmpty: async (dir) => {
    if (dir === unremovable) {
      throw Object.assign(new Error(`EPERM: operation not permitted, rmdir '${dir}'`), { code: "EPERM" });
    }
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

test("a folder whose removal fails stays, with the folders above it that hold it, and the error reports both failures", () =>
  inTemporaryRoot(async (root) => {
    const tools = path.join(root, "tools");
    const base = path.join(tools, "codex");
    const skills = path.join(base, "skills");
    const ctx = makeContext({
      projectDir: root,
      cliPath: path.join(root, "cli.js"),
      packageRoot: root,
      dryRun: false,
      fs: filesRefusingAndKeeping(skills, base),
    });
    await assert.rejects(ensureFolders(ctx, tools, skills), (error: unknown) => {
      const text = error instanceof Error ? error.message : "";
      return text.includes("mkdir") && text.includes("could not be removed");
    });
    assert.equal(existsSync(base), true);
    assert.equal(existsSync(tools), true);
  }));

test("recordThenUndo removes the folders this call made, deepest first, when a record cannot be written, and rethrows", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "tools", "codex");
    const made = await ensureFolders(contextIn(root), root, base);
    await assert.rejects(
      recordThenUndo(contextIn(root), made, async () => {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }),
      /ENOSPC/,
    );
    assert.equal(existsSync(path.join(root, "tools")), false);
  }));

test("recordThenUndo keeps the folders when the records are written", () =>
  inTemporaryRoot(async (root) => {
    const base = path.join(root, "tools", "codex");
    const made = await ensureFolders(contextIn(root), root, base);
    await recordThenUndo(contextIn(root), made, async () => {});
    assert.equal(existsSync(base), true);
  }));

test("isFolder is false for a path under a regular file, so the checks that use it do not throw there", () =>
  inTemporaryRoot(async (root) => {
    const file = path.join(root, "file.txt");
    await writeFile(file, "x\n");
    assert.equal(await isFolder(path.join(file, "child")), false);
  }));
