import { stat } from "node:fs/promises";
import path from "node:path";
import type { Item } from "./state.js";
import type { Context } from "./types.js";

// Whether a path is an existing folder. A missing path is not one, and neither is a path under a regular file, which the system
// reports as ENOTDIR. Any other error is thrown.
export const isFolder = async (folder: string): Promise<boolean> => {
  try {
    return (await stat(folder)).isDirectory();
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
};

// The folders from a base folder down to a target, base first and target last. The target must be the base or a folder
// inside it. Only a path that climbs out of the base is refused, so a name such as "..folder" is accepted.
export const folderChain = (base: string, target: string): string[] => {
  const top = path.resolve(base);
  const bottom = path.resolve(target);
  const relative = path.relative(top, bottom);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`The folder ${bottom} is not inside ${top}.`);
  }
  const folders = [top];
  let current = top;
  for (const part of relative.split(path.sep)) {
    if (part !== "") {
      current = path.join(current, part);
      folders.push(current);
    }
  }
  return folders;
};

// The folders that ensureFolders would make for a target, in order. Nothing is made. The missing folders above the base come
// first, from the top one down to the base. They are found by walking up from the base until a folder exists. Then come the
// folders from the base down to the target, with the base listed once.
export const foldersToMake = async (base: string, target: string): Promise<string[]> => {
  const chain = folderChain(base, target);
  const above: string[] = [];
  let current = path.resolve(base);
  while (!(await isFolder(current))) {
    above.unshift(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return [...above, ...chain.filter((folder) => !above.includes(folder))];
};

// The text of an error, for a message.
const textOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : String(error);

// Removes the folders that a call made, deepest first. Each one goes only when it is empty. A removal that fails does not stop the
// others. The errors of the failed removals are returned, so the caller can report them.
const undoFolders = async (ctx: Context, made: readonly string[]): Promise<unknown[]> => {
  const failures: unknown[] = [];
  for (const folder of [...made].reverse()) {
    try {
      await ctx.removeDirIfEmpty(folder);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
};

// The error that a failed call throws. It is the error that stopped the call, with a failed removal added to its message.
const withFailedUndo = (error: unknown, failures: readonly unknown[]): unknown =>
  failures.length === 0
    ? error
    : new Error(`${textOf(error)}. A folder this call made could not be removed: ${textOf(failures[0])}`, { cause: error });

// Makes each folder of foldersToMake(base, target) that does not exist, one at a time, parents first, each with ctx.ensureDir.
// It returns the folders it made, in the order it made them. A folder that exists is left alone. A dry run lists the same
// folders and makes none. The caller records each folder it is given. When a folder cannot be made, the folders this call made
// are removed, deepest first, each only when it is empty. A removal that fails does not stop the others: the error that stopped
// the call is thrown, with the failed removal added to its message. So a failed call leaves no folder behind, except a folder whose
// removal failed, and the folders above it, which hold it and cannot be emptied.
export const ensureFolders = async (ctx: Context, base: string, target: string): Promise<string[]> => {
  const made: string[] = [];
  try {
    for (const folder of await foldersToMake(base, target)) {
      if (!(await isFolder(folder))) {
        await ctx.ensureDir(folder);
        made.push(folder);
      }
    }
  } catch (error) {
    // A dry run made nothing, so there is nothing to remove. A folder that was there before is never in the list.
    const failures = ctx.dryRun ? [] : await undoFolders(ctx, made);
    throw withFailedUndo(error, failures);
  }
  return made;
};

// Writes the records of the folders that a call made, with writeRecords. When a record cannot be written, the folders are removed
// again, as ensureFolders does, and the error is thrown. So no folder is left on disk without its record, unless a removal also
// fails. Then the thrown error says so, and the folder stays with no record. The caller does not call this in a dry run, which
// records nothing.
export const recordThenUndo = async (
  ctx: Context,
  madeFolders: readonly string[],
  writeRecords: () => Promise<void>,
): Promise<void> => {
  try {
    await writeRecords();
  } catch (error) {
    const failures = await undoFolders(ctx, madeFolders);
    throw withFailedUndo(error, failures);
  }
};

// Removes each folder of the list that the record lists, deepest first, when it is empty. The list runs from the top down.
// A folder that the record does not list is kept, because this tool did not record that it made that folder. A folder that
// still holds a file is kept too.
export const removeRecordedFolders = async (
  ctx: Context,
  items: readonly Item[],
  folders: readonly string[],
): Promise<void> => {
  for (const folder of [...folders].reverse()) {
    if (items.some((item) => item.kind === "directory" && item.path === folder)) {
      await ctx.removeDirIfEmpty(folder);
    }
  }
};
