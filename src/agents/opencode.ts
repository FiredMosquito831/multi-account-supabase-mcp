import type { Stats } from "node:fs";
import { lstat, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ensureFolders, foldersToMake, isFolder, removeRecordedFolders } from "./folders.js";
import { DIRECT_KEY, directEntry, type Scope, supportedScopes } from "./scopes.js";
import { forget, type Item, record, recordedItems, scopeKey } from "./state.js";
import { type AgentAdapter, type Context, type Step, UnsupportedScope } from "./types.js";

// The opencode adapter. opencode's help lists `opencode mcp add`, and this tool has no remove command that it can verify.
// So the adapter edits the JSON file itself, and records the pointer of its entry, so that uninstall removes that entry and
// nothing else. The configuration folder comes from `opencode debug paths`, a read-only command. Run on 2026-10-21 on the
// development machine, it printed the config folder as <home>\.config\opencode. So the global folder is the .config folder
// in the home folder, then opencode. Only that default was observed. That an XDG_CONFIG_HOME value replaces it, and that a
// relative value is ignored, is ASSUMED.
//
// The file name opencode.json and the layout of the entry are ASSUMED, not verified against opencode: the file is in the
// global folder and in the project folder; the servers sit under the key "mcp"; a local server has type "local", its
// command as a list, and enabled set to true.
//
// The file is parsed before any change. A file that does not parse, or whose top level or mcp value is not an object, is
// refused, and nothing is written. An entry under our key that the record does not list was not written by this tool, so
// install refuses it. A rewrite keeps every number's text and every key, so a file with a repeated key, or with a number that
// a rewrite would write differently, is refused. Every other key keeps its value. A rewrite writes the whole file again: the
// indentation, the escapes, the line endings and the order of integer-like keys can change, and the backup keeps the old
// bytes. A backup takes the first free name, so an earlier backup is never replaced. Each backup is on the record, and
// uninstall keeps every backup that is still on disk and names it, unless it stops before it reads the backups. The folders
// this tool makes are recorded too, and uninstall removes them, deepest first, only when they are empty.

type ActiveScope = "global" | "project";

const FILE_NAME = "opencode.json";

// A backup of the file is named opencode.json.bak, then opencode.json.bak2, and so on.
const BACKUP_NAME = new RegExp(`^${FILE_NAME.replace(/\./g, "\\.")}\\.bak\\d*$`);

// The key that holds the servers, and the JSON pointer of this tool's entry in it.
const TABLE = "mcp";
const ENTRY_POINTER = `/${TABLE}/${DIRECT_KEY}`;

const NOT_INSTALLED = "not installed in this scope";

// The byte order mark that some editors write at the start of a UTF-8 file.
const BOM = String.fromCharCode(0xfeff);

type Doc = Record<string, unknown>;

// The byte order mark and line ending of a file, which a rewrite keeps. A new file has no mark and uses LF.
type Layout = { bom: string; eol: string };

// What is on disk. A file that is not UTF-8, or does not parse, is invalid. A file that parses but has another shape is
// unexpected. The text is kept, so a rewrite can match the old file.
type Loaded =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "unexpected" }
  | { kind: "ok"; text: string; doc: Doc };

// Where a scope's entry is kept, and whether an entry is recorded for the scope.
type Target = { folder: string; file: string; key: string; recorded: boolean };

const step = (scope: Scope, status: Step["status"], message: string): Step => ({
  agent: "opencode",
  scope,
  status,
  message,
});

// The message of a step that would do something in a dry run, and of the same step in a real run.
const pick = (dryRun: boolean, wouldSay: string, saidThen: string): string => (dryRun ? wouldSay : saidThen);

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

const isObject = (value: unknown): value is Doc =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A record of the entry this tool wrote: a json-entry with the pointer of its entry. A json-entry with another pointer is
// not this tool's entry, so it does not count as recorded.
const isOurEntry = (item: Item): item is Extract<Item, { kind: "json-entry" }> =>
  item.kind === "json-entry" && item.pointer === ENTRY_POINTER;

// Whether anything is at a path: a file, a folder or a link. A path that cannot be checked is thrown.
const somethingAt = async (file: string): Promise<boolean> => {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
};

// The first free backup name of a file: <file>.bak, then <file>.bak2, <file>.bak3, and so on. A backup never takes the place
// of something that is already there, so an earlier backup keeps its bytes. Only names are read, so a dry run gets the same
// name.
const freeBackupName = async (file: string): Promise<string> => {
  let name = `${file}.bak`;
  for (let index = 2; await somethingAt(name); index += 1) {
    name = `${file}.bak${index}`;
  }
  return name;
};

// The note on the backup that an install or an update took.
const keptNote = (dryRun: boolean, backup: string): string =>
  ` The old file ${pick(dryRun, "would be", "is")} kept as ${backup}.`;

// The note on the backups that uninstall keeps and names. Uninstall never removes a backup.
const backupsKept = (dryRun: boolean, names: readonly string[]): string =>
  names.length === 0 ? "" : ` ${pick(dryRun, "Backups that would be kept", "Backups kept")}: ${names.join(", ")}.`;

// The backups this tool recorded for the scope that are still on disk. A backup is a file item named like one.
const keptBackups = async (items: readonly Item[]): Promise<string[]> => {
  const names: string[] = [];
  for (const item of items) {
    if (item.kind === "file" && BACKUP_NAME.test(path.basename(item.path)) && (await somethingAt(item.path))) {
      names.push(item.path);
    }
  }
  return names;
};

// Ends the record of a scope. The record keeps the folders that still exist, so a later uninstall can remove them once they
// are empty, and it keeps each backup that is still on disk, so that a later uninstall still names it. Every other item is
// dropped. The record is written in two steps, so a crash between them loses the record, but no backup and no folder is
// ever removed by that loss.
const keepRecord = async (key: string, items: readonly Item[], backups: readonly string[], dryRun: boolean): Promise<void> => {
  if (dryRun) {
    return;
  }
  const folders: string[] = [];
  for (const item of items) {
    if (item.kind === "directory" && (await isFolder(item.path))) {
      folders.push(item.path);
    }
  }
  await forget("opencode", key);
  for (const folder of folders) {
    await record("opencode", key, { kind: "directory", path: folder });
  }
  for (const backup of backups) {
    await record("opencode", key, { kind: "file", path: backup, createdByUs: true });
  }
};

// Ends the record of a scope, and returns the error code when the record cannot be written. The caller's step then says that
// the change was made and the record was not finished, and it names the backups kept.
const finishRecord = async (
  key: string,
  items: readonly Item[],
  backups: readonly string[],
  dryRun: boolean,
): Promise<string | undefined> => {
  try {
    await keepRecord(key, items, backups, dryRun);
    return undefined;
  } catch (error) {
    return codeOf(error);
  }
};

// The folder that the folders of a scope are made under. For the global scope, that is the configuration folder, so that
// it is made and removed along with the opencode folder. The project folder is the base of the project scope.
const baseOf = (scope: ActiveScope, folder: string): string => (scope === "global" ? path.dirname(folder) : folder);

// The folders the record lists, from the top down. A parent is always shorter than its child, so sorting by length puts each
// parent before its children.
const directoriesTopDown = (items: readonly Item[]): string[] =>
  items.flatMap((item) => (item.kind === "directory" ? [item.path] : [])).sort((left, right) => left.length - right.length);

// The folders the record lists on the way to a folder, the folder itself included, from the top down. A folder that the
// record does not list is not here, so it is never removed.
const recordedPath = (items: readonly Item[], folder: string): string[] =>
  directoriesTopDown(items).filter((candidate) => {
    const relative = path.relative(candidate, folder);
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  });

// Removes the folders the record lists on the chain, deepest first, when they are empty. The result names the folders that
// were removed. In a dry run it names the folders that would be removed if they are empty.
const removeFolders = async (ctx: Context, items: readonly Item[], chain: readonly string[]): Promise<string[]> => {
  const listed: string[] = [];
  for (const folder of chain) {
    if (items.some((item) => item.kind === "directory" && item.path === folder) && (await isFolder(folder))) {
      listed.push(folder);
    }
  }
  await removeRecordedFolders(ctx, items, chain);
  if (ctx.dryRun) {
    return listed;
  }
  const removed: string[] = [];
  for (const folder of listed) {
    if (!(await isFolder(folder))) {
      removed.push(folder);
    }
  }
  return removed;
};

// The note on the folders that uninstall removed, or, in a dry run, would remove when they are empty.
const foldersNote = (dryRun: boolean, folders: readonly string[]): string =>
  folders.length === 0
    ? ""
    : ` ${pick(dryRun, "Would remove the folders this tool made, if they are empty", "Removed the folders this tool made, because they were empty")}: ${folders.join(", ")}.`;

// The folder of opencode's global configuration: .config in the home folder, then opencode. An XDG_CONFIG_HOME value that is
// an absolute path replaces the .config folder. Only the default folder was observed. The effect of the variable, and the rule
// that a relative value is ignored, are ASSUMED.
export const opencodeGlobalDir = (env: NodeJS.ProcessEnv, homeDir: string): string => {
  const configured = env.XDG_CONFIG_HOME;
  const configHome = configured && path.isAbsolute(configured) ? configured : path.join(homeDir, ".config");
  return path.join(configHome, "opencode");
};

// The file and the folder of a scope, and the record key. When an entry is recorded for the scope, the file is the one
// recorded at install time, and the folder is its folder. So a later change of the environment cannot move the entry:
// install, update, uninstall and doctor all act on the file that install wrote. Only a scope with no recorded entry gets
// its path from the environment (global) or from the project folder (project), even when backups are recorded for it.
const targetOf = async (ctx: Context, scope: ActiveScope): Promise<Target> => {
  const key = scopeKey(scope, ctx.projectDir);
  const entry = (await recordedItems("opencode", key)).find(isOurEntry);
  if (entry !== undefined) {
    return { folder: path.dirname(entry.path), file: entry.path, key, recorded: true };
  }
  const folder = path.resolve(scope === "global" ? opencodeGlobalDir(process.env, os.homedir()) : ctx.projectDir);
  return { folder, file: path.join(folder, FILE_NAME), key, recorded: false };
};

const notValid = (file: string): string => `${file} is not valid JSON, so nothing was changed.`;

const unexpected = (file: string): string => `${file} has unexpected contents, so nothing was changed.`;

const unchanged = (file: string): string => `${file} could not be changed safely, so nothing was changed.`;

const rewriteRefused = (file: string): string =>
  `${file} holds a number that a rewrite would write differently, or a repeated key, so nothing was changed.`;

const repeatsKey = (file: string): string => `${file} repeats a key, so nothing was changed.`;

// An entry under our key that the record does not list: this tool did not write it, so install does not take it over.
const foreignEntry = (file: string): string =>
  `${file} already has an entry named "${DIRECT_KEY}" under "${TABLE}" that this tool did not write, so nothing was changed.`;

const absent = (file: string, dryRun: boolean): string =>
  `The server entry is not in ${file}, so no server entry ${pick(dryRun, "would be removed", "was removed")}.`;

const notFolder = (target: string): string => `${target} is not a folder, so nothing was changed.`;

// Whether a link leads to a folder. A dangling link does not, and neither does a link to a file.
const linkResolvesToFolder = async (link: string): Promise<boolean> => {
  try {
    return (await stat(link)).isDirectory();
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
};

// The first path on the way to a folder that cannot be used as one, or undefined when the way is clear. A folder can be used
// when it is a directory, or a link that leads to a directory. The entry is read with lstat, so a dangling link is seen and
// refused. A missing path is skipped, and so is a path under a regular file, which the system reports as ENOTDIR: the walk
// goes on upward until it reaches the file. Any other error is thrown.
const blockingPath = async (folder: string): Promise<string | undefined> => {
  let current = path.resolve(folder);
  for (;;) {
    let entry: Stats | undefined;
    try {
      entry = await lstat(current);
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
    }
    if (entry !== undefined) {
      const usable = entry.isDirectory() || (entry.isSymbolicLink() && (await linkResolvesToFolder(current)));
      return usable ? undefined : current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
};

// The code of an error from the file system, or a fixed phrase when there is none. The message of the error is not used,
// because it can quote a path, and the step names the files itself.
const codeOf = (error: unknown): string => {
  const code = errorCode(error);
  return typeof code === "string" ? code : "an unknown error";
};

const backupNotWritten = (file: string, backup: string, error: unknown): string =>
  `${backup} could not be written (${codeOf(error)}), so ${file} was not changed.`;

const fileNotWritten = (file: string, backup: string | undefined, error: unknown): string =>
  `${file} could not be written (${codeOf(error)}).${backup === undefined ? "" : ` The old file is kept as ${backup}.`}`;

// The text of a file, decoded as UTF-8 with any byte order mark kept. Bytes that are not UTF-8 give undefined.
const decode = (bytes: Buffer): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

// The JSON text without its byte order mark. The parser would refuse the mark, so it is kept apart and written back.
const jsonPart = (text: string): string => (text.startsWith(BOM) ? text.slice(BOM.length) : text);

// What a rewrite would change, read from the text: whether an object repeats a key, and whether a number would be written with
// other text. A parsed value does not show either, so the text is scanned. The scan runs only on text that parsed.
const scanText = (text: string): { repeatedKey: boolean; numberChanges: boolean } => {
  const frames: { object: boolean; keys: Set<string> }[] = [];
  let repeatedKey = false;
  let numberChanges = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') {
        end += text[end] === "\\" ? 2 : 1;
      }
      if (end >= text.length) {
        return { repeatedKey: true, numberChanges: true };
      }
      let next = end + 1;
      while (next < text.length && /\s/.test(text[next])) {
        next += 1;
      }
      const frame = frames[frames.length - 1];
      if (frame?.object && text[next] === ":") {
        const key = JSON.parse(text.slice(index, end + 1)) as string;
        if (frame.keys.has(key)) {
          repeatedKey = true;
        }
        frame.keys.add(key);
      }
      index = end + 1;
    } else if (char === "{" || char === "[") {
      frames.push({ object: char === "{", keys: new Set() });
      index += 1;
    } else if (char === "}" || char === "]") {
      frames.pop();
      index += 1;
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      let end = index + 1;
      while (end < text.length && /[-+.eE0-9]/.test(text[end])) {
        end += 1;
      }
      const token = text.slice(index, end);
      if (JSON.stringify(Number(token)) !== token) {
        numberChanges = true;
      }
      index = end;
    } else {
      index += 1;
    }
  }
  return { repeatedKey, numberChanges };
};

// Whether a rewrite would change a number's text, or drop a key that an object repeats. Either one refuses the rewrite.
const rewriteWouldChange = (text: string): boolean => {
  const found = scanText(text);
  return found.repeatedKey || found.numberChanges;
};

// Whether the mcp value, when the document has one, is an object.
const tableFits = (doc: Doc): boolean => !Object.hasOwn(doc, TABLE) || isObject(doc[TABLE]);

// Reads the file. A missing file gives "missing". Other read errors are thrown as they are. Their messages hold the path
// and a system code, never the text.
const loadConfig = async (file: string): Promise<Loaded> => {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { kind: "missing" };
    }
    throw error;
  }
  const text = decode(bytes);
  if (text === undefined) {
    return { kind: "invalid" };
  }
  let value: unknown;
  try {
    value = JSON.parse(jsonPart(text));
  } catch {
    return { kind: "invalid" };
  }
  return isObject(value) && tableFits(value) ? { kind: "ok", text, doc: value } : { kind: "unexpected" };
};

// The document in a JSON text, or undefined when the text is not JSON or its top level is not an object.
const parseDocument = (text: string): Doc | undefined => {
  try {
    const value: unknown = JSON.parse(jsonPart(text));
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

const layoutOf = (text: string): Layout => ({
  bom: text.startsWith(BOM) ? BOM : "",
  eol: text.includes("\r\n") ? "\r\n" : "\n",
});

// The text written for a document: two-space indentation, the layout of the old file, and a final line ending. The rewrite
// writes the whole file, so the layout can change, as the header says. The values do not change.
const render = (doc: Doc, layout: Layout): string =>
  `${layout.bom}${JSON.stringify(doc, null, 2).split("\n").join(layout.eol)}${layout.eol}`;

// The servers table of a document, or undefined when the document has none.
const tableOf = (doc: Doc): Doc | undefined => {
  const table = doc[TABLE];
  return isObject(table) ? table : undefined;
};

// This tool's entry in a document, or undefined when there is none.
const entryOf = (doc: Doc): unknown => tableOf(doc)?.[DIRECT_KEY];

// The document with this tool's entry set to the given value. The other keys keep their values. Integer-like keys are written
// first, so the order of the keys can change.
const withEntry = (doc: Doc, entry: Doc): Doc => ({ ...doc, [TABLE]: { ...tableOf(doc), [DIRECT_KEY]: entry } });

// The document with this tool's entry removed. The servers table stays, even when it is empty afterwards.
const withoutEntry = (doc: Doc): Doc => {
  const table = tableOf(doc);
  if (table === undefined || !Object.hasOwn(table, DIRECT_KEY)) {
    return doc;
  }
  const rest: Doc = { ...table };
  delete rest[DIRECT_KEY];
  return { ...doc, [TABLE]: rest };
};

// The document with this tool's entry removed, and with a servers table that is left empty dropped. Two documents that
// agree after this step differ in nothing that this tool may touch.
const comparable = (doc: Doc): Doc => {
  const copy: Doc = { ...withoutEntry(doc) };
  const table = tableOf(copy);
  if (table !== undefined && Object.keys(table).length === 0) {
    delete copy[TABLE];
  }
  return copy;
};

const sameApartFromEntry = (before: Doc, after: Doc): boolean =>
  isDeepStrictEqual(comparable(before), comparable(after));

const installIn = async (ctx: Context, scope: ActiveScope): Promise<Step> => {
  const target = await targetOf(ctx, scope);
  const { folder, file, key } = target;
  // A file on the way to the folder would fail when the folder is made, after the records are written. So it is refused
  // here, before any change.
  const blocked = await blockingPath(folder);
  if (blocked !== undefined) {
    return step(scope, "error", notFolder(blocked));
  }
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step(scope, "error", notValid(file));
  }
  if (loaded.kind === "unexpected") {
    return step(scope, "error", unexpected(file));
  }
  const before: Doc = loaded.kind === "ok" ? loaded.doc : {};
  // An entry under our key is ours only when the record lists it. Any other entry is refused, and never taken over. The
  // check is exact, because the file was parsed and the entry is read from it.
  if (!target.recorded && entryOf(before) !== undefined) {
    return step(scope, "error", foreignEntry(file));
  }
  // A rewrite keeps every number's text and every key. A file that a rewrite would change is refused before any change.
  if (loaded.kind === "ok" && rewriteWouldChange(jsonPart(loaded.text))) {
    return step(scope, "error", rewriteRefused(file));
  }
  const { command, args } = directEntry(ctx.cliPath);
  const entry = { type: "local", command: [command, ...args], enabled: true };
  const text = render(withEntry(before, entry), layoutOf(loaded.kind === "ok" ? loaded.text : ""));
  // The new text is read back before anything is written. It must hold the entry, and nothing else may differ in value.
  const after = parseDocument(text);
  if (after === undefined || !sameApartFromEntry(before, after) || !isDeepStrictEqual(entryOf(after), entry)) {
    return step(scope, "error", unchanged(file));
  }
  // A backup takes the first free name. The name is chosen before the first change, so the step can name it.
  const backup = loaded.kind === "ok" ? await freeBackupName(file) : undefined;
  const base = baseOf(scope, folder);
  // The folders ensureFolders would make, parents first, that do not exist yet. Each one is recorded before any is made.
  const made: string[] = [];
  for (const planned of await foldersToMake(base, folder)) {
    if (!(await isFolder(planned))) {
      made.push(planned);
    }
  }
  // Each record is written before the change it describes, so a change that fails leaves records that describe nothing
  // that exists. A dry run records nothing.
  if (!ctx.dryRun) {
    for (const folderToMake of made) {
      await record("opencode", key, { kind: "directory", path: folderToMake });
    }
    if (loaded.kind === "missing") {
      // The file did not exist before, so this tool creates it, and uninstall may remove it.
      await record("opencode", key, { kind: "file", path: file, createdByUs: true });
    }
    await record("opencode", key, { kind: "json-entry", path: file, pointer: ENTRY_POINTER });
    if (backup !== undefined) {
      await record("opencode", key, { kind: "file", path: backup, createdByUs: true });
    }
  }
  await ensureFolders(ctx, base, folder);
  if (loaded.kind === "ok" && backup !== undefined) {
    try {
      await ctx.writeFile(backup, loaded.text);
    } catch (error) {
      return step(scope, "error", backupNotWritten(file, backup, error));
    }
  }
  try {
    await ctx.writeFile(file, text);
  } catch (error) {
    return step(scope, "error", fileNotWritten(file, backup, error));
  }
  const kept = backup === undefined ? "" : keptNote(ctx.dryRun, backup);
  return step(
    scope,
    "ok",
    `${pick(ctx.dryRun, "Would write", "Wrote")} the server entry to ${file}.${kept} The file name and the layout are ASSUMED, not verified with opencode.`,
  );
};

// Install again, but only where this tool has an entry recorded. An update never adds an install to a scope.
const updateIn = async (ctx: Context, scope: ActiveScope): Promise<Step> =>
  (await targetOf(ctx, scope)).recorded ? installIn(ctx, scope) : step(scope, "skipped", NOT_INSTALLED);

// What an uninstall has found so far. The catch in uninstallSafely reads it and calls nothing else, so the catch cannot throw.
type Progress = { file?: string; kept?: readonly string[] };

const uninstallIn = async (ctx: Context, scope: ActiveScope, progress: Progress): Promise<Step> => {
  const target = await targetOf(ctx, scope);
  progress.file = target.file;
  const items = await recordedItems("opencode", target.key);
  // The backups this tool recorded that are still on disk. Uninstall never removes a backup, and names each one it keeps.
  const kept = await keptBackups(items);
  progress.kept = kept;
  // No entry is recorded, so there is no entry to remove, and no file is touched. The folders this tool recorded are still
  // removed when they are empty, because a backup that is deleted later would otherwise leave them behind for good.
  if (!target.recorded) {
    const folders = await removeFolders(ctx, items, directoriesTopDown(items));
    const message = `${NOT_INSTALLED}${foldersNote(ctx.dryRun, folders)}${backupsKept(ctx.dryRun, kept)}`;
    if (folders.length === 0) {
      return step(scope, "skipped", message);
    }
    const unfinished = await finishRecord(target.key, items, kept, ctx.dryRun);
    if (unfinished !== undefined) {
      return step(scope, "error", `${message} Its record could not be finished (${unfinished}).`);
    }
    return step(scope, "skipped", message);
  }
  const { folder, file, key } = target;
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step(scope, "error", `${notValid(file)}${backupsKept(ctx.dryRun, kept)}`);
  }
  if (loaded.kind === "unexpected") {
    return step(scope, "error", `${unexpected(file)}${backupsKept(ctx.dryRun, kept)}`);
  }
  // The config file goes only when this tool created it. The folders the record lists on the way to the folder go with it,
  // but only the empty ones.
  const ownFile = items.some((item) => item.kind === "file" && item.path === file);
  const chain = recordedPath(items, folder);
  // A file that this tool created and that holds nothing but this entry, or nothing but an empty servers table, is removed.
  // No backup is made for such a file, because a backup would keep the folder.
  if (loaded.kind === "ok" && ownFile && Object.keys(comparable(loaded.doc)).length === 0) {
    // Removing the file would lose the first copy of a key that the file repeats, so such a file is kept.
    if (scanText(jsonPart(loaded.text)).repeatedKey) {
      return step(scope, "error", `${repeatsKey(file)}${backupsKept(ctx.dryRun, kept)}`);
    }
    await ctx.removeFile(file);
    let folders: string[];
    try {
      folders = await removeFolders(ctx, items, chain);
    } catch (error) {
      // The file is already gone, so the step says that the entry was removed, and that the folders were not. The record
      // is kept, so that a later uninstall removes the folders and finishes the record.
      return step(
        scope,
        "error",
        pick(
          ctx.dryRun,
          `Would remove the server entry from ${file}, which this tool created. The folders this tool made could not be checked (${codeOf(error)}).${backupsKept(true, kept)}`,
          `The server entry was removed from ${file}, which this tool had created, so the file was removed. The folders this tool made could not be removed (${codeOf(error)}). The record is kept, so a later uninstall finishes it.${backupsKept(false, kept)}`,
        ),
      );
    }
    const unfinished = await finishRecord(key, items, kept, ctx.dryRun);
    if (unfinished !== undefined) {
      return step(
        scope,
        "error",
        `Removed ${file}, which this tool had created, but its record could not be finished (${unfinished}).${backupsKept(false, kept)}`,
      );
    }
    return step(
      scope,
      "ok",
      pick(
        ctx.dryRun,
        `Would remove ${file}, which this tool created.${foldersNote(true, folders)}${backupsKept(true, kept)} The file name is ASSUMED, not verified with opencode.`,
        `Removed ${file}, which this tool had created.${foldersNote(false, folders)}${backupsKept(false, kept)} The file name is ASSUMED, not verified with opencode.`,
      ),
    );
  }
  if (loaded.kind === "missing" || entryOf(loaded.doc) === undefined) {
    // Nothing of ours is in the file. When the file is gone, the folders the record lists go too, if they are empty.
    const folders = loaded.kind === "missing" ? await removeFolders(ctx, items, chain) : [];
    const unfinished = await finishRecord(key, items, kept, ctx.dryRun);
    const message = `${absent(file, ctx.dryRun)}${foldersNote(ctx.dryRun, folders)}${backupsKept(ctx.dryRun, kept)}`;
    if (unfinished !== undefined) {
      return step(scope, "error", `${message} Its record could not be finished (${unfinished}).`);
    }
    return step(scope, "skipped", message);
  }
  const text = render(withoutEntry(loaded.doc), layoutOf(loaded.text));
  const after = parseDocument(text);
  if (after === undefined || !sameApartFromEntry(loaded.doc, after) || entryOf(after) !== undefined) {
    return step(scope, "error", `${unchanged(file)}${backupsKept(ctx.dryRun, kept)}`);
  }
  if (rewriteWouldChange(jsonPart(loaded.text))) {
    return step(scope, "error", `${rewriteRefused(file)}${backupsKept(ctx.dryRun, kept)}`);
  }
  // The backup takes the first free name, and it is recorded before it is written. The entry's own records are ended after
  // the change, and the backups that remain stay on the record.
  const backup = await freeBackupName(file);
  if (!ctx.dryRun) {
    await record("opencode", key, { kind: "file", path: backup, createdByUs: true });
  }
  try {
    await ctx.writeFile(backup, loaded.text);
  } catch (error) {
    return step(scope, "error", `${backupNotWritten(file, backup, error)}${backupsKept(ctx.dryRun, kept)}`);
  }
  try {
    await ctx.writeFile(file, text);
  } catch (error) {
    return step(scope, "error", `${fileNotWritten(file, backup, error)}${backupsKept(ctx.dryRun, kept)}`);
  }
  const names = [...kept, backup];
  const unfinished = await finishRecord(key, items, names, ctx.dryRun);
  if (unfinished !== undefined) {
    return step(
      scope,
      "error",
      `Removed the server entry from ${file}, but its record could not be finished (${unfinished}).${backupsKept(false, names)}`,
    );
  }
  return step(
    scope,
    "ok",
    `${pick(ctx.dryRun, "Would remove", "Removed")} the server entry from ${file}.${backupsKept(ctx.dryRun, names)} The layout is ASSUMED, not verified with opencode.`,
  );
};

// Uninstall removes files, and a file-system call can throw. A thrown error becomes an error step. The step names the backups
// that uninstall keeps when it has read them. When it has not, the step says so in a fixed phrase. The catch calls nothing
// that can throw, because a second throw would replace the step with a raw error.
const uninstallSafely = async (ctx: Context, scope: ActiveScope): Promise<Step> => {
  const progress: Progress = {};
  try {
    return await uninstallIn(ctx, scope, progress);
  } catch (error) {
    const code = codeOf(error);
    if (progress.file === undefined || progress.kept === undefined) {
      return step(
        scope,
        "error",
        `Uninstall stopped (${code}) before it read the backups. Uninstall never removes a backup, so any backup on disk is still there.`,
      );
    }
    return step(scope, "error", `Uninstall stopped at ${progress.file} (${code}).${backupsKept(ctx.dryRun, progress.kept)}`);
  }
};

// One scope's doctor step. A scope with no recorded entry is not this tool's, so it gets no step.
const doctorIn = async (ctx: Context, scope: ActiveScope): Promise<Step | undefined> => {
  const target = await targetOf(ctx, scope);
  if (!target.recorded) {
    return undefined;
  }
  const { file } = target;
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step(scope, "error", `${file} is not valid JSON.`);
  }
  if (loaded.kind === "unexpected") {
    return step(scope, "error", `${file} has unexpected contents.`);
  }
  if (loaded.kind === "ok" && entryOf(loaded.doc) !== undefined) {
    return step(scope, "ok", `The server entry is in ${file}. The layout is ASSUMED, not verified with opencode.`);
  }
  return step(scope, "skipped", `The server entry is not in ${file}.`);
};

// A scope this adapter does not have is refused before anything is read or written. The message names the scopes that
// can be used.
const activeScope = (scope: Scope): ActiveScope => {
  if (scope === "global" || scope === "project") {
    return scope;
  }
  throw new UnsupportedScope("opencode", scope, `opencode has no ${scope} scope. Use global or project.`);
};

export const opencodeAdapter: AgentAdapter = {
  id: "opencode",
  scopes: supportedScopes("opencode"),
  present: (ctx) => ctx.present("opencode"),
  install: async (ctx, scope) => [await installIn(ctx, activeScope(scope))],
  update: async (ctx, scope) => [await updateIn(ctx, activeScope(scope))],
  uninstall: async (ctx, scope) => [await uninstallSafely(ctx, activeScope(scope))],
  doctor: async (ctx) => {
    const steps: Step[] = [];
    for (const scope of ["global", "project"] as const) {
      const found = await doctorIn(ctx, scope);
      if (found !== undefined) {
        steps.push(found);
      }
    }
    return steps;
  },
};
