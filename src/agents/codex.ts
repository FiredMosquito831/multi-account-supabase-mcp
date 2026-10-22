import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import type { CommandResult } from "./command.js";
import { ensureFolders, foldersToMake, isFolder, recordThenUndo, removeRecordedFolders } from "./folders.js";
import { DIRECT_KEY, directEntry, type Scope, supportedScopes } from "./scopes.js";
import { SKILL_FILE, SKILL_NAME, installSkill, readSkillText, removeSkill } from "./skill.js";
import { type Item, forget, record, recordedItems, scopeKey } from "./state.js";
import { type AgentAdapter, type Context, type Step, UnsupportedScope } from "./types.js";

// The Codex adapter. The global scope uses the codex mcp commands, which write the user's configuration. Codex has no
// scope flag, so the project scope is a table in the project's own file, .codex/config.toml. Codex is assumed to read
// that file only when the project folder is trusted. This is not verified yet.
//
// The project file is edited as text, so the other tables keep their bytes. The new text must parse, and everything
// except this tool's table must be as it was. When either check fails, nothing is written.
//
// Each scope also gets the skill: a folder with a SKILL.md file. The global folder is in CODEX_HOME, or in .codex in
// the home folder. The project folder is .agents/skills in the project. Both places are assumed, not verified yet.
//
// This tool writes the skill files itself, rather than through a Codex command, because the Codex commands it uses are codex mcp
// commands, and they do not install skills. ASSUMED: Codex has no command for skills. The help text that was checked covers
// codex mcp only.
//
// Only what the record lists is changed. An entry or table that this tool did not write is never taken over: an install
// refuses when one exists, and an update or an uninstall leaves it alone. A folder is recorded before it is made, and a folder
// that cannot be made is dropped from the record again. Each file is recorded before it is written, so uninstall can remove what
// this tool made. When a record cannot be written, the folders made by that call are removed again. The project folder is the
// owner's: an install refuses when it does not exist, so nothing is created above it, and the folder is never recorded and never
// removed. A backup is recorded before it is written, by install, update and uninstall. Uninstall ends the record of a scope and
// then records again the backups and the folders that are still on disk, so a later uninstall names the backups and still
// removes the folders that become empty.
//
// An entry or table that differs from the one this tool writes is never removed or replaced, by install, update or uninstall. It is
// left in place with its record, and the step is an error. An unedited recorded entry or table is replaced by install, and the project
// file keeps a backup. The project table is text that this adapter writes, so its content is checked against what it writes. The
// global entry is in the Codex configuration file, so its content is checked there too. ASSUMED: codex mcp add writes the global entry
// to that file.

const SCOPES = supportedScopes("codex");

// The table that holds this tool's server in the project file.
const SERVER_TABLE = `mcp_servers.${DIRECT_KEY}`;

const NOT_INSTALLED = "not installed in this scope";
const NOT_INSTALLED_GLOBALLY = "not installed globally";
const REFUSED_VALUE =
  "The server entry has a single quote or a line break, which the project file cannot hold, so nothing was changed.";

type Doc = Record<string, unknown>;

// What is on disk for the project file. A file that is not UTF-8, or does not parse, is invalid. A file that cannot be read
// at all is unreadable, and the reason is the error's own message. The text keeps a byte order mark, so a rewrite gives back
// the same bytes.
type Loaded =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "unreadable"; reason: string }
  | { kind: "ok"; text: string; doc: Doc };

const step = (scope: Scope, status: Step["status"], message: string): Step => ({
  agent: "codex",
  scope,
  status,
  message,
});

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

// Whether a path exists, as a file, a folder or a link, even a link whose target is missing. A path under a file does not
// exist. Other errors are thrown.
const pathExists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
};

const configFile = (projectDir: string): string => path.resolve(projectDir, ".codex", "config.toml");

// Where a scope's skill goes. The base is the top of the chain of folders that the skill needs, and the folder is the skill
// folder, which holds the SKILL.md file.
type SkillSite = { base: string; folder: string };

// The home folder, from the environment that the context carries. Windows keeps it in USERPROFILE, and other systems in HOME.
const homeFolder = (env: NodeJS.ProcessEnv): string | undefined => {
  const value = process.platform === "win32" ? env.USERPROFILE : env.HOME;
  return value === undefined || value === "" ? undefined : value;
};

// The global skill site. The base is CODEX_HOME from the environment, or the .codex folder of the home folder when CODEX_HOME
// is not set. An empty CODEX_HOME counts as not set. The site is undefined when neither is known. ASSUMED: Codex reads user
// skills from the skills folder under the base, not verified yet.
const globalSite = (env: NodeJS.ProcessEnv): SkillSite | undefined => {
  const codexHome = env.CODEX_HOME;
  let base: string | undefined;
  if (codexHome !== undefined && codexHome !== "") {
    base = codexHome;
  } else {
    const home = homeFolder(env);
    base = home === undefined ? undefined : path.join(home, ".codex");
  }
  if (base === undefined) {
    return undefined;
  }
  const resolved = path.resolve(base);
  return { base: resolved, folder: path.join(resolved, "skills", SKILL_NAME) };
};

// The project skill. The base is the project folder, which is kept as it is when it exists. ASSUMED: Codex reads project
// skills from .agents/skills in the project, not verified yet.
const projectSite = (projectDir: string): SkillSite => {
  const base = path.resolve(projectDir);
  return { base, folder: path.join(base, ".agents", "skills", SKILL_NAME) };
};

const notValid = (file: string): string => `${file} is not valid TOML, so nothing was changed.`;

const unchanged = (file: string): string => `${file} could not be changed safely, so nothing was changed.`;

const unreadableText = (file: string, reason: string): string => `${file} could not be read (${reason}), so nothing was changed.`;

// The first word of a step: what a real run did, or what a dry run would do.
const verb = (ctx: Context, done: string, would: string): string => (ctx.dryRun ? would : done);

// Joins sentences with a space. A part that does not end in a full stop gets one, and an empty part is left out.
const sentences = (...parts: string[]): string =>
  parts.filter((part) => part !== "").map((part) => (part.endsWith(".") ? part : `${part}.`)).join(" ");

// The step text for the skill. The location is assumed, so the text says so.
const skillWritten = (ctx: Context, folder: string): string =>
  `${verb(ctx, "Wrote", "Would write")} the skill to ${folder}. ` +
  "Codex reads skills from this folder (ASSUMED, not verified yet).";

// The sentence that says which skill files a step removed. Empty when a step removed none.
const skillFilesText = (ctx: Context, files: readonly string[]): string =>
  files.length === 0 ? "" : `${verb(ctx, "Removed", "Would remove")} the skill file ${files.join(", ")}.`;

// The first error of a check, as text. It is the error's own message, which names a path and never the contents of a file.
const checkFailure = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "The check failed";

// The error text for a skill file that could not be removed. The record is kept, so a later uninstall can try again.
const skillRemovalFailed = (error: unknown): string =>
  `The skill file could not be removed: ${checkFailure(error)}. The record is kept, so uninstall can try again.`;

// A scope this adapter does not have is refused. The planner decides the skipped cases for agents that were not named.
const requireScope = (scope: Scope): void => {
  if (!SCOPES.includes(scope)) {
    throw new UnsupportedScope("codex", scope);
  }
};

const parseOrUndefined = (text: string): Doc | undefined => {
  try {
    return parse(text) as Doc;
  } catch {
    return undefined;
  }
};

// Reads the project file. A missing file gives "missing". A file that cannot be read gives "unreadable", with the reason, so the
// caller can say that nothing was changed. Nothing is thrown.
const loadConfig = async (file: string): Promise<Loaded> => {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { kind: "missing" };
    }
    return { kind: "unreadable", reason: checkFailure(error) };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { kind: "invalid" };
  }
  const doc = parseOrUndefined(text);
  return doc === undefined ? { kind: "invalid" } : { kind: "ok", text, doc };
};

const serversOf = (doc: Doc): Doc | undefined => {
  const servers = doc.mcp_servers;
  return typeof servers === "object" && servers !== null && !Array.isArray(servers) ? (servers as Doc) : undefined;
};

const hasServer = (doc: Doc): boolean => {
  const servers = serversOf(doc);
  return servers !== undefined && Object.hasOwn(servers, DIRECT_KEY);
};

// The document without this tool's server. Two documents that are equal once this is applied differ in nothing else.
const withoutServer = (doc: Doc): Doc => {
  const servers: Doc = { ...serversOf(doc) };
  delete servers[DIRECT_KEY];
  return { ...doc, mcp_servers: servers };
};

// Whether the server table holds exactly the command and the arguments this tool writes.
const holdsEntry = (doc: Doc, command: string, args: readonly string[]): boolean => {
  const entry = serversOf(doc)?.[DIRECT_KEY];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    return false;
  }
  const fields = entry as Doc;
  const list = fields.args;
  return (
    Object.keys(fields).length === 2 &&
    fields.command === command &&
    Array.isArray(list) &&
    list.length === args.length &&
    list.every((value, index) => value === args[index])
  );
};

// The lines of a text, each with its line ending. Joining them gives back the text exactly.
const linesOf = (text: string): string[] => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

// One part of a dotted key: a bare key, or a basic or literal quoted key, with spaces around it.
const KEY_PART = /[ \t]*(?:([A-Za-z0-9_-]+)|"([^"\\\r\n]*)"|'([^'\r\n]*)')[ \t]*/y;

// The parts of a dotted key, or undefined when the text is not one.
const keyPath = (text: string): string[] | undefined => {
  const parts: string[] = [];
  let index = 0;
  for (;;) {
    KEY_PART.lastIndex = index;
    const match = KEY_PART.exec(text);
    if (match === null) {
      return undefined;
    }
    parts.push(match[1] ?? match[2] ?? match[3] ?? "");
    index = KEY_PART.lastIndex;
    if (index === text.length) {
      return parts;
    }
    if (text[index] !== ".") {
      return undefined;
    }
    index += 1;
  }
};

// The parts of a table header line, or undefined when the line is not a header. A header is one or two square brackets
// around a dotted key, with an optional comment. A byte order mark before the header is skipped.
const headerPath = (line: string): string[] | undefined => {
  const body = line.replace(/^﻿/, "").replace(/\r?\n$/, "");
  const match = /^[ \t]*\[\[?(.*?)\]\]?[ \t]*(?:#.*)?$/.exec(body);
  return match === null ? undefined : keyPath(match[1]);
};

// Whether a header names this tool's server table, or a table inside it.
const isServerPath = (keys: readonly string[]): boolean =>
  keys.length >= 2 && keys[0] === "mcp_servers" && keys[1] === DIRECT_KEY;

// The text without this tool's table and each table inside it. A table runs from its header line to the line before the
// next header. The other tables keep their lines and their order. Installing puts one blank line before the table, so
// when the table is at the end of the file, that blank line is removed as well.
const withoutServerLines = (text: string): string => {
  const lines = linesOf(text);
  const removed = lines.map(() => false);
  let inServer = false;
  lines.forEach((line, index) => {
    const keys = headerPath(line);
    if (keys !== undefined) {
      inServer = isServerPath(keys);
    }
    removed[index] = inServer;
  });
  const last = lines.length - 1;
  if (last >= 0 && removed[last]) {
    let first = last;
    while (first > 0 && removed[first - 1]) {
      first -= 1;
    }
    if (first > 0 && lines[first - 1].trim() === "") {
      removed[first - 1] = true;
    }
  }
  return lines.filter((_, index) => !removed[index]).join("");
};

// The text with the server table at its end. A blank line separates the table from the text before it.
const withServerTable = (text: string, table: string, eol: string): string => {
  if (text === "") {
    return table;
  }
  const base = text.endsWith("\n") ? text : `${text}${eol}`;
  return `${base}${eol}${table}`;
};

// The server table, with each value as a TOML literal string. A literal string keeps a Windows path's backslashes as they
// are. A value with a single quote or a line break is refused before this is called.
const serverTable = (command: string, args: readonly string[], eol: string): string =>
  [`[${SERVER_TABLE}]`, `command = '${command}'`, `args = [${args.map((arg) => `'${arg}'`).join(", ")}]`]
    .map((line) => `${line}${eol}`)
    .join("");

// A TOML literal string cannot hold a single quote or a line break.
const fitsLiteral = (value: string): boolean => !/['\r\n]/.test(value);

// The first line of a text that is not empty, trimmed, or undefined when no line is.
const firstLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");

// The failure text of a command, under one rule for every command: the first line of its error output, then the first line of
// its standard output, and otherwise the exit code.
const failureText = (result: CommandResult): string =>
  firstLine(result.stderr) ?? firstLine(result.stdout) ?? `exit ${result.code}`;

// The characters that end a word in a listing. They are the ones the Antigravity adapter uses, so both read a listing the same way.
const WORD_BREAK = /[\s|│:,;()[\]"'=]+/;

// Whether a listing names the entry as a whole word, on any line and in any position. ASSUMED: the layout of codex mcp list, which
// is not verified. This is the check before an install, so a listing that shows the name in any position stops the install.
const listsEntryWord = (listing: string): boolean => listing.split(WORD_BREAK).includes(DIRECT_KEY);

// Whether a failed removal says that the entry is not installed. The line must name the entry and use a phrase that says it is
// missing. ASSUMED: the wording of codex, which is not verified. A failure without these phrases keeps the record.
const MISSING_PHRASE = /not found|not installed|does not exist|no such|no mcp server/i;
const saysNotInstalled = (result: CommandResult): boolean =>
  `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .some((line) => line.includes(DIRECT_KEY) && MISSING_PHRASE.test(line));

// The refusal for a record that cannot be read. It names the file and the reason, and it says that nothing was changed.
const stateRefusal = (error: unknown): string => {
  const text = checkFailure(error);
  return text.includes("nothing was changed") ? text : `${text}, so nothing was changed.`;
};

const isEntryRecord = (item: Item): boolean => item.kind === "mcp-entry" && item.name === DIRECT_KEY;

const tableRecorded = (items: readonly Item[], file: string): boolean =>
  items.some((item) => item.kind === "toml-table" && item.path === file && item.table === SERVER_TABLE);

// The name for a backup of the file: the file's own name with .bak, then .bak2, .bak3 and so on. The first name that is free is
// taken, so an existing backup is never overwritten.
const freeBackup = async (file: string): Promise<string> => {
  for (let number = 1; ; number += 1) {
    const candidate = number === 1 ? `${file}.bak` : `${file}.bak${number}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
};

// The backups of the file that the record lists and that are still on disk, in the order they were made. A backup is recorded
// before it is written, so a write that did not finish leaves a record with no file, and that backup is left out here.
const keptBackups = async (items: readonly Item[], file: string): Promise<string[]> => {
  const pattern = new RegExp(`^${path.basename(file).replace(/\./g, "\\.")}\\.bak\\d*$`);
  const names: string[] = [];
  for (const item of items) {
    if (
      item.kind === "file" &&
      path.dirname(item.path) === path.dirname(file) &&
      pattern.test(path.basename(item.path)) &&
      (await pathExists(item.path))
    ) {
      names.push(item.path);
    }
  }
  return names;
};

// The sentence that says which backups are kept. Uninstall never removes a backup.
const backupsKeptText = (dryRun: boolean, names: readonly string[]): string =>
  names.length === 0 ? "" : `${dryRun ? "The backups that would be kept" : "The backups kept"} are: ${names.join(", ")}.`;

// The sentence on the backup that a change made.
const keptPreviousText = (dryRun: boolean, backup: string): string =>
  `${dryRun ? "Would keep" : "Kept"} the previous file as ${backup}.`;

// The folders a call made that the record may list. The project folder is the owner's, so it is never listed.
const recordableFolders = (ctx: Context, scope: Scope, made: readonly string[]): string[] =>
  scope === "project" ? made.filter((folder) => path.resolve(folder) !== path.resolve(ctx.projectDir)) : [...made];

// The folders that ensureFolders would make for a target, in order. Nothing is made, and a folder that exists is not listed.
const missingFolders = async (base: string, target: string): Promise<string[]> => {
  const missing: string[] = [];
  for (const folder of await foldersToMake(base, target)) {
    if (!(await isFolder(folder))) {
      missing.push(folder);
    }
  }
  return missing;
};

// Drops from the record the folders of the list that are not on disk, and keeps every other record. A folder that stays on disk
// keeps its record, because this tool made it. Used when a folder could not be made, so the record does not list a folder that is
// not there.
const dropMissingFolders = async (key: string, folders: readonly string[]): Promise<void> => {
  const absent: string[] = [];
  for (const folder of folders) {
    if (!(await isFolder(folder))) {
      absent.push(folder);
    }
  }
  if (absent.length === 0) {
    return;
  }
  const current = await recordedItems("codex", key);
  await forget("codex", key);
  for (const item of current) {
    if (!(item.kind === "directory" && absent.includes(item.path))) {
      await record("codex", key, item);
    }
  }
};

// The error for a change that failed after its folders were recorded. The record is set back first. When that fails too, the
// error says so, so the record is not left without a word.
const failedWithRecord = async (error: unknown, key: string, folders: readonly string[]): Promise<unknown> => {
  try {
    await dropMissingFolders(key, folders);
    return error;
  } catch (restoreError) {
    return new Error(`${checkFailure(error)}. The record could not be set back: ${checkFailure(restoreError)}`, { cause: error });
  }
};

// Writes the skill for a site. Each folder the skill needs is recorded before it is made. The SKILL.md item is recorded after the
// folders exist and before the file is written, so the record never names a file that was not written. When a folder cannot be made,
// its record is dropped. In a dry run nothing is recorded.
const writeSkill = async (ctx: Context, scope: "global" | "project", site: SkillSite): Promise<void> => {
  const key = scopeKey(scope, ctx.projectDir);
  if (ctx.dryRun) {
    await installSkill(ctx, ctx.packageRoot, site.folder);
    return;
  }
  let pending: string[] = [];
  try {
    pending = recordableFolders(ctx, scope, await missingFolders(site.base, site.folder));
    for (const toMake of pending) {
      await record("codex", key, { kind: "directory", path: toMake });
    }
    await installSkill(ctx, ctx.packageRoot, site.folder, async () => {
      await record("codex", key, { kind: "file", path: path.join(site.folder, SKILL_FILE), createdByUs: true });
    });
  } catch (error) {
    throw await failedWithRecord(error, key, pending);
  }
};

// The checks that follow the record read. Each returns the reason that a change must not be made, or undefined.
const skillProblem = async (ctx: Context, site: SkillSite, items: readonly Item[]): Promise<string | undefined> => {
  try {
    await readSkillText(ctx.packageRoot);
  } catch {
    const expected = path.join(ctx.packageRoot, "skills", SKILL_NAME, SKILL_FILE);
    return `The skill text cannot be read from ${expected}, so nothing was changed.`;
  }
  for (const folder of await foldersToMake(site.base, site.folder)) {
    if ((await pathExists(folder)) && !(await isFolder(folder))) {
      return `${folder} is not a folder, so nothing was changed.`;
    }
  }
  const file = path.join(site.folder, SKILL_FILE);
  if (!(await pathExists(file))) {
    return undefined;
  }
  if (items.some((item) => item.kind === "file" && item.path === file && item.createdByUs)) {
    return undefined;
  }
  return `${file} was not created by this tool, so it was not overwritten and nothing was changed.`;
};

// The reason an install must stop before it changes anything, or undefined when the skill can be written. The record was read
// first by the caller, so a state file that cannot be read stops the install before the first change. Then the packaged skill
// text must be readable, every folder on the way to the skill folder must be a folder or be missing, and a SKILL.md in the skill
// folder must be one this tool created or be absent. A refused install writes nothing.
const skillBlocked = async (ctx: Context, site: SkillSite, items: readonly Item[]): Promise<string | undefined> => {
  try {
    return await skillProblem(ctx, site, items);
  } catch (error) {
    return `${checkFailure(error)}, so nothing was changed.`;
  }
};

// The skill folders that the record lists. A folder is listed as a directory item named for the skill, or as the folder of a
// SKILL.md file that this tool created. Only the record is read, so a changed environment cannot move what is removed.
const recordedSkillFolders = (items: readonly Item[]): string[] => {
  const folders = new Set<string>();
  for (const item of items) {
    if (item.kind === "directory" && path.basename(item.path) === SKILL_NAME) {
      folders.add(item.path);
    }
    if (
      item.kind === "file" &&
      item.createdByUs &&
      path.basename(item.path) === SKILL_FILE &&
      path.basename(path.dirname(item.path)) === SKILL_NAME
    ) {
      folders.add(path.dirname(item.path));
    }
  }
  return [...folders];
};

// Whether a folder exists and holds nothing. A folder that is not there is not empty, since there is nothing to remove.
const isEmptyFolder = async (dir: string): Promise<boolean> => {
  try {
    return (await readdir(dir)).length === 0;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
};

// Removes the folder when it is empty, and returns whether it was removed. The removal is called in a dry run too, where it does
// nothing, so the call is the same in both. A dry run then returns whether the folder would be removed: whether it is empty now.
const removeEmptyFolder = async (ctx: Context, folder: string): Promise<boolean> => {
  const emptyNow = ctx.dryRun ? await isEmptyFolder(folder) : false;
  const existed = await pathExists(folder);
  await ctx.removeDirIfEmpty(folder);
  if (ctx.dryRun) {
    return emptyNow;
  }
  return existed && !(await pathExists(folder));
};

// Removes what the record lists for each skill folder: the skill file when this tool created it, the folder when this tool
// created it and it is empty, and each recorded folder above it, deepest first, under the same rule. The protected folder, when
// one is given, is never removed. Returns the skill files that were removed, so the step can say so.
const removeRecordedSkill = async (ctx: Context, items: readonly Item[], protectedFolder?: string): Promise<string[]> => {
  const removedFiles: string[] = [];
  for (const folder of recordedSkillFolders(items)) {
    const file = path.join(folder, SKILL_FILE);
    const fileListed = items.some((item) => item.kind === "file" && item.path === file && item.createdByUs);
    const folderListed = items.some((item) => item.kind === "directory" && item.path === folder);
    // A file is reported as removed only when it was there. A file that the owner already deleted is not reported.
    const fileWasThere = fileListed && (await pathExists(file));
    if (fileListed && folderListed) {
      await removeSkill(ctx, folder);
    } else if (fileListed) {
      await ctx.removeFile(file);
    } else if (folderListed) {
      await ctx.removeDirIfEmpty(folder);
    }
    if (fileWasThere) {
      removedFiles.push(file);
    }
    const above = items.flatMap((item) =>
      item.kind === "directory" && item.path !== protectedFolder && folder.startsWith(`${item.path}${path.sep}`)
        ? [item.path]
        : [],
    );
    await removeRecordedFolders(ctx, items, above.sort((a, b) => a.length - b.length));
  }
  return removedFiles;
};

// Ends the record of a scope, then records again what stays on disk: each folder that the record lists and that still exists,
// and each backup in the list. Uninstall never removes a backup, so a backup stays on the record for a later uninstall to name,
// and a folder that still holds a backup or an owner's file keeps its record. The kept items are records that uninstall leaves in
// place, such as the table record of a table it kept. Returns the reason when the record cannot be finished. A dry run changes
// nothing.
const endRecord = async (
  ctx: Context,
  key: string,
  items: readonly Item[],
  backups: readonly string[],
  kept: readonly Item[] = [],
): Promise<string | undefined> => {
  if (ctx.dryRun) {
    return undefined;
  }
  try {
    const folders: string[] = [];
    for (const item of items) {
      if (item.kind === "directory" && (await isFolder(item.path))) {
        folders.push(item.path);
      }
    }
    await forget("codex", key);
    for (const folder of folders) {
      await record("codex", key, { kind: "directory", path: folder });
    }
    for (const backup of backups) {
      await record("codex", key, { kind: "file", path: backup, createdByUs: true });
    }
    for (const item of kept) {
      await record("codex", key, item);
    }
    return undefined;
  } catch (error) {
    return checkFailure(error);
  }
};

const takenEntryText = `Codex already lists a server named ${DIRECT_KEY} that this tool did not write, so nothing was changed.`;

// The text for an entry that was added, but whose record could not be written. The check before the add showed that the entry was
// absent, so the entry is removed again. When that removal fails too, the step gives the command for the owner to run.
const unrecordedEntryText = async (ctx: Context, error: unknown): Promise<string> => {
  const reason = checkFailure(error);
  const removal = await ctx.run("codex", ["mcp", "remove", DIRECT_KEY]);
  if (removal.code === 0) {
    return `The server entry was added, but it could not be recorded: ${reason}. The entry was removed again, so nothing was changed.`;
  }
  return `The server entry was added, but it could not be recorded: ${reason}. It could not be removed either (${failureText(removal)}). To remove it, run: codex mcp remove ${DIRECT_KEY}`;
};

const installGlobal = async (ctx: Context): Promise<Step> => {
  const site = globalSite(ctx.env);
  if (site === undefined) {
    return step("global", "error", "The home folder is not known from the environment, and CODEX_HOME is not set, so nothing was changed.");
  }
  const key = scopeKey("global", ctx.projectDir);
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", key);
  } catch (error) {
    return step("global", "error", stateRefusal(error));
  }
  // Everything that can refuse the install is checked before the first command runs.
  const blocked = await skillBlocked(ctx, site, items);
  if (blocked !== undefined) {
    return step("global", "error", blocked);
  }
  if (!ctx.present("codex")) {
    return step("global", "error", "codex is not on PATH, so nothing was changed.");
  }
  const { command, args } = directEntry(ctx.cliPath);
  const recorded = items.some(isEntryRecord);
  let listingNote = "";
  let removal: CommandResult | undefined;
  if (recorded) {
    // This tool wrote the entry, so it is replaced: the recorded entry is removed, then added. An entry that was edited is not replaced,
    // and that check runs before any command. The result of the removal is read only when the add fails, so the step can say what codex
    // now lists. The entry may be gone already, so a failed removal is not an error here.
    const edited = await globalEdited(ctx);
    if (edited !== undefined) {
      return step("global", "error", edited);
    }
    removal = await ctx.run("codex", ["mcp", "remove", DIRECT_KEY]);
  } else if (ctx.dryRun) {
    listingNote = "The listing of codex mcp list is not run in a dry run, so an entry this tool did not write is not checked for.";
  } else {
    // Nothing is recorded for the entry. A listing that names an entry with this name is taken to mean that someone else wrote it.
    // That is an inference, because the listing does not say who wrote an entry. ASSUMED: the layout of codex mcp list. A listing that
    // cannot be read leaves that open, so the install stops.
    const listing = await ctx.run("codex", ["mcp", "list"]);
    if (listing.code !== 0) {
      return step("global", "error", `The listing of codex mcp list failed (${failureText(listing)}), so nothing was changed.`);
    }
    if (listsEntryWord(listing.stdout)) {
      return step("global", "error", takenEntryText);
    }
  }
  const added = await ctx.run("codex", ["mcp", "add", DIRECT_KEY, "--", command, ...args]);
  // A dry run does not read the result of a command, because the result is a fake success. Its step says what would happen.
  if (!ctx.dryRun) {
    if (added.code !== 0) {
      // When the removal before the add worked, codex no longer lists the entry, and the step says so, in the words the Antigravity
      // adapter uses. The record still lists the entry, so a later run adds it again.
      if (removal?.code === 0) {
        return step(
          "global",
          "error",
          `The server was removed from codex, but adding it again failed, so codex no longer lists it. The record still lists it. ${failureText(added)}`,
        );
      }
      return step("global", "error", failureText(added));
    }
    if (!recorded) {
      try {
        await record("codex", key, { kind: "mcp-entry", name: DIRECT_KEY });
      } catch (error) {
        return step("global", "error", await unrecordedEntryText(ctx, error));
      }
    }
  }
  try {
    await writeSkill(ctx, "global", site);
  } catch (error) {
    return step("global", "error", `The server entry was added and recorded. The skill was not written: ${checkFailure(error)}`);
  }
  const addedText = `${verb(ctx, "Added", "Would add")} the server to the global Codex configuration.`;
  return step("global", "ok", sentences(addedText, skillWritten(ctx, site.folder), listingNote));
};

// The text for an edited global entry, in install, update and uninstall alike. Each of them leaves the entry in place, and the text
// says how to remove it by hand, because uninstall refuses the same entry. The record stays until the owner removes the entry.
const editedGlobalText = (): string =>
  `The entry ${DIRECT_KEY} was edited, so it was left in place. To remove it, delete the entry by hand: the entry named ${DIRECT_KEY} in the Codex configuration, or run codex mcp remove ${DIRECT_KEY}. Then run this command again. The record stays until then.`;

// The text for an edited project table, in install, update and uninstall alike. The table is left in place, and the text says how to
// remove it by hand, for the same reason as the global entry.
const editedProjectText = (file: string): string =>
  `The table [${SERVER_TABLE}] in ${file} was edited, so it was left in place. To remove it, delete the table [${SERVER_TABLE}] from the project's .codex/config.toml. Then run this command again. The record stays until then.`;

// The text that refuses an update, an uninstall or an install of a global entry that differs from the one this tool writes, or
// undefined when the entry matches or is absent. The entry is in the Codex configuration file in CODEX_HOME, or in .codex in the home
// folder. ASSUMED: codex mcp add writes the entry to that file, which is not verified. When the file holds no entry under this name, the
// check passes, and codex mcp decides as before. Nothing is changed by this check.
const globalEdited = async (ctx: Context): Promise<string | undefined> => {
  const site = globalSite(ctx.env);
  if (site === undefined) {
    return "The home folder is not known from the environment, and CODEX_HOME is not set, so nothing was changed.";
  }
  const file = path.join(site.base, "config.toml");
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return notValid(file);
  }
  if (loaded.kind === "unreadable") {
    return unreadableText(file, loaded.reason);
  }
  if (loaded.kind !== "ok" || !hasServer(loaded.doc)) {
    return undefined;
  }
  let expected: { command: string; args: string[] };
  try {
    expected = directEntry(ctx.cliPath);
  } catch (error) {
    return `The entry ${DIRECT_KEY} in ${file} cannot be checked: ${checkFailure(error)}`;
  }
  return holdsEntry(loaded.doc, expected.command, expected.args) ? undefined : editedGlobalText();
};

// An update changes only an entry that this tool wrote and that matches what it writes. An entry that differs is left in place.
const updateGlobal = async (ctx: Context): Promise<Step> => {
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", scopeKey("global", ctx.projectDir));
  } catch (error) {
    return step("global", "error", stateRefusal(error));
  }
  if (!items.some(isEntryRecord)) {
    return step("global", "skipped", NOT_INSTALLED);
  }
  const edited = await globalEdited(ctx);
  if (edited !== undefined) {
    return step("global", "error", edited);
  }
  return installGlobal(ctx);
};

const uninstallGlobal = async (ctx: Context): Promise<Step> => {
  const key = scopeKey("global", ctx.projectDir);
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", key);
  } catch (error) {
    return step("global", "error", stateRefusal(error));
  }
  if (items.length === 0) {
    return step("global", "skipped", sentences(NOT_INSTALLED_GLOBALLY));
  }
  const entryRecorded = items.some(isEntryRecord);
  if (entryRecorded && !ctx.present("codex")) {
    // Without the program the entry cannot be removed, so the record stays for a later attempt.
    return step("global", "skipped", "codex is not on PATH, so nothing was removed globally.");
  }
  if (entryRecorded) {
    // An entry that differs from the one this tool writes is left in place with its record, and the step is an error.
    const edited = await globalEdited(ctx);
    if (edited !== undefined) {
      return step("global", "error", edited);
    }
  }
  let removedNow = false;
  if (entryRecorded) {
    const removal = await ctx.run("codex", ["mcp", "remove", DIRECT_KEY]);
    if (ctx.dryRun) {
      // A dry run does not read the result, so the step says what would happen to the entry.
      removedNow = true;
    } else if (removal.code === 0) {
      removedNow = true;
    } else if (!saysNotInstalled(removal)) {
      // A failure that does not say the entry is missing keeps the record, so uninstall can try again.
      return step("global", "error", sentences(failureText(removal), "The record is kept, so uninstall can try again"));
    }
  }
  // The entry text is a result only in a real run, so a dry run says what would happen.
  const entryText = removedNow ? verb(ctx, "The server entry was removed.", "The server entry would be removed.") : "";
  let skillFiles: string[];
  try {
    skillFiles = await removeRecordedSkill(ctx, items);
  } catch (error) {
    return step("global", "error", sentences(entryText, skillRemovalFailed(error)));
  }
  // The record of the scope ends as in the project scope: the folders that still exist are recorded again, so a later uninstall
  // removes them once they are empty. Global backups do not exist, so none is listed.
  const endError = await endRecord(ctx, key, items, []);
  if (endError !== undefined) {
    return step(
      "global",
      "error",
      sentences(entryText, `The record could not be updated: ${endError}`, "Run uninstall again"),
    );
  }
  const skill = skillFilesText(ctx, skillFiles);
  if (removedNow) {
    const removedText = `${verb(ctx, "Removed", "Would remove")} the server from the global Codex configuration.`;
    return step("global", "ok", sentences(removedText, skill));
  }
  if (skillFiles.length > 0) {
    // The entry was already gone, but the skill this tool wrote was removed, so something changed and the status is ok.
    return step("global", "ok", sentences(skill, "The server entry was not installed globally"));
  }
  return step("global", "skipped", sentences(NOT_INSTALLED_GLOBALLY));
};

// The global check. It gives a step only when the record lists the entry. codex mcp list is run only in a real run, because a dry
// run's result is a fake. ASSUMED: the layout of codex mcp list, as in listsEntryWord.
const doctorGlobal = async (ctx: Context): Promise<Step | undefined> => {
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", scopeKey("global", ctx.projectDir));
  } catch (error) {
    return step("global", "error", stateRefusal(error));
  }
  if (!items.some(isEntryRecord)) {
    return undefined;
  }
  if (!ctx.present("codex")) {
    return step("global", "skipped", "codex is not on PATH.");
  }
  if (ctx.dryRun) {
    return step("global", "skipped", "The listing of codex mcp list was not run, because this is a dry run.");
  }
  const listing = await ctx.run("codex", ["mcp", "list"]);
  if (listing.code === 0 && listsEntryWord(listing.stdout)) {
    return step("global", "ok", "The server is in codex mcp list.");
  }
  const exit = listing.code === 0 ? "" : ` (the listing exited with code ${listing.code})`;
  return step("global", "skipped", `The server is not in codex mcp list${exit}.`);
};

// Writes the server table into the project file. The record is read first, and the new text is checked before anything is written.
// The folders and the records come before the writes. The backup takes a free name first, and it is recorded before the backup is
// written. A write that does not finish can leave a backup on the record that is not on disk. Uninstall names only the backups that
// are on disk, so such a backup is not named, and the next uninstall that ends the record drops it.
const writeProjectTable = async (ctx: Context, loaded: Extract<Loaded, { kind: "ok" | "missing" }>): Promise<Step> => {
  const file = configFile(ctx.projectDir);
  const { command, args } = directEntry(ctx.cliPath);
  if (![command, ...args].every(fitsLiteral)) {
    return step("project", "error", REFUSED_VALUE);
  }
  const key = scopeKey("project", ctx.projectDir);
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", key);
  } catch (error) {
    return step("project", "error", stateRefusal(error));
  }
  if (loaded.kind === "ok" && hasServer(loaded.doc) && !tableRecorded(items, file)) {
    return step("project", "error", `${file} already has the table ${SERVER_TABLE}, which this tool did not write, so nothing was changed.`);
  }
  // A recorded table that was edited is not replaced. The text says how to remove it by hand.
  if (loaded.kind === "ok" && hasServer(loaded.doc) && !holdsEntry(loaded.doc, command, args)) {
    return step("project", "error", editedProjectText(file));
  }
  const before = loaded.kind === "ok" ? loaded.text : "";
  const beforeDoc: Doc = loaded.kind === "ok" ? loaded.doc : {};
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  const updated = withServerTable(withoutServerLines(before), serverTable(command, args, eol), eol);
  const after = parseOrUndefined(updated);
  if (
    after === undefined ||
    !isDeepStrictEqual(withoutServer(beforeDoc), withoutServer(after)) ||
    !holdsEntry(after, command, args)
  ) {
    return step("project", "error", unchanged(file));
  }
  const site = projectSite(ctx.projectDir);
  const blocked = await skillBlocked(ctx, site, items);
  if (blocked !== undefined) {
    return step("project", "error", blocked);
  }
  const folder = path.dirname(file);
  // The backup takes a free name before anything changes. A file that did not exist has no backup.
  let backup: string | undefined;
  if (loaded.kind === "ok") {
    try {
      backup = await freeBackup(file);
    } catch (error) {
      return step("project", "error", `The backup name for ${file} could not be checked (${checkFailure(error)}), so nothing was changed.`);
    }
  }
  // Each folder is recorded before it is made, so the record never misses a folder that is on disk. When a folder cannot be made,
  // the record of the folders that are not on disk is dropped.
  let pending: string[] = [];
  let made: string[];
  try {
    pending = ctx.dryRun ? [] : recordableFolders(ctx, "project", await missingFolders(ctx.projectDir, folder));
    for (const toMake of pending) {
      await record("codex", key, { kind: "directory", path: toMake });
    }
    made = await ensureFolders(ctx, ctx.projectDir, folder);
  } catch (error) {
    return step("project", "error", `Nothing was written to ${file}: ${checkFailure(await failedWithRecord(error, key, pending))}`);
  }
  try {
    if (!ctx.dryRun) {
      await recordThenUndo(ctx, recordableFolders(ctx, "project", made), async () => {
        if (backup !== undefined) {
          await record("codex", key, { kind: "file", path: backup, createdByUs: true });
        }
        if (loaded.kind === "missing") {
          // The file did not exist before, so this tool creates it. Uninstall may then remove the file.
          await record("codex", key, { kind: "file", path: file, createdByUs: true });
        }
        await record("codex", key, { kind: "toml-table", path: file, table: SERVER_TABLE });
      });
    }
  } catch (error) {
    return step("project", "error", `Nothing was written to ${file}: ${checkFailure(await failedWithRecord(error, key, pending))}`);
  }
  if (backup !== undefined) {
    try {
      await ctx.writeFile(backup, before);
    } catch (error) {
      return step(
        "project",
        "error",
        `The backup ${backup} could not be written: ${checkFailure(error)}. The file was not changed, and uninstall names only the backups that are on disk.`,
      );
    }
  }
  try {
    await ctx.writeFile(file, updated);
  } catch (error) {
    return step(
      "project",
      "error",
      sentences(
        `The server table was not written to ${file}: ${checkFailure(error)}`,
        "Uninstall reads the file as it is now",
        backup === undefined ? "" : `The backup ${backup} was written and is recorded, so uninstall names it`,
      ),
    );
  }
  try {
    await writeSkill(ctx, "project", site);
  } catch (error) {
    return step(
      "project",
      "error",
      `The server table was written to ${file} and recorded. The skill was not written: ${checkFailure(error)}`,
    );
  }
  const tableText = `${verb(ctx, "Wrote", "Would write")} the server table to ${file}.`;
  const kept = backup === undefined ? "" : keptPreviousText(ctx.dryRun, backup);
  const trust = "Codex reads this file only when its folder is trusted (not verified yet).";
  return step("project", "ok", sentences(tableText, kept, trust, skillWritten(ctx, site.folder)));
};

const installProject = async (ctx: Context): Promise<Step> => {
  const file = configFile(ctx.projectDir);
  const projectFolder = path.resolve(ctx.projectDir);
  let exists: boolean;
  let isDirectory: boolean;
  try {
    exists = await pathExists(projectFolder);
    isDirectory = exists && (await isFolder(projectFolder));
  } catch (error) {
    return step("project", "error", `The project folder ${projectFolder} could not be checked (${checkFailure(error)}), so nothing was changed.`);
  }
  // The owner's project must exist already. An install never creates it, so nothing is created above the project.
  if (!exists) {
    return step("project", "error", `The project folder ${projectFolder} does not exist, so nothing was created or changed.`);
  }
  if (!isDirectory) {
    return step("project", "error", `The project folder ${projectFolder} is not a folder, so nothing was created or changed.`);
  }
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step("project", "error", notValid(file));
  }
  if (loaded.kind === "unreadable") {
    return step("project", "error", unreadableText(file, loaded.reason));
  }
  return writeProjectTable(ctx, loaded);
};

// The step for a project config file that cannot be read or parsed, in update and uninstall. With no record in the scope, this tool
// wrote nothing there, so the step is skipped and no command runs. With a record, the file is refused and nothing is changed.
const unusableConfig = async (
  ctx: Context,
  file: string,
  loaded: Extract<Loaded, { kind: "invalid" | "unreadable" }>,
): Promise<Step> => {
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", scopeKey("project", ctx.projectDir));
  } catch (error) {
    return step("project", "error", stateRefusal(error));
  }
  if (items.length === 0) {
    return step("project", "skipped", NOT_INSTALLED);
  }
  return step("project", "error", loaded.kind === "invalid" ? notValid(file) : unreadableText(file, loaded.reason));
};

const updateProject = async (ctx: Context): Promise<Step> => {
  const file = configFile(ctx.projectDir);
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid" || loaded.kind === "unreadable") {
    return unusableConfig(ctx, file, loaded);
  }
  if (loaded.kind === "missing" || !hasServer(loaded.doc)) {
    return step("project", "skipped", NOT_INSTALLED);
  }
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", scopeKey("project", ctx.projectDir));
  } catch (error) {
    return step("project", "error", stateRefusal(error));
  }
  if (!tableRecorded(items, file)) {
    return step("project", "skipped", `The table in ${file} was not written by this tool, so nothing was changed.`);
  }
  let expected: { command: string; args: string[] };
  try {
    expected = directEntry(ctx.cliPath);
  } catch (error) {
    return step("project", "error", `The table in ${file} cannot be checked: ${checkFailure(error)}`);
  }
  // An update does not replace a table that differs from the one this tool writes. The table is left in place with its record.
  if (!holdsEntry(loaded.doc, expected.command, expected.args)) {
    return step("project", "error", editedProjectText(file));
  }
  return writeProjectTable(ctx, loaded);
};

// The outcome of removing the table: an error text, or the backup made for the file when the file was kept.
type TableRemoval = { error: string } | { backup?: string };

// Removes the table of a file that the record lists. The caller checks first that the table holds the entry this tool writes. The
// file is removed when this tool created it and it is empty afterwards. Otherwise the file is written back without the table. Its
// backup takes a free name and is recorded before the backup is written. A write that does not finish leaves the backup on the
// record while it is not on disk. Uninstall names only the backups on disk, so that backup is not named, and the next uninstall that
// ends the record drops it. The folder is removed here only once the file is gone, and only when the record lists it.
const removeTable = async (
  ctx: Context,
  key: string,
  file: string,
  loaded: Extract<Loaded, { kind: "ok" }>,
  ownFile: boolean,
  ownFolder: boolean,
): Promise<TableRemoval> => {
  const folder = path.dirname(file);
  const remaining = withoutServerLines(loaded.text);
  const after = parseOrUndefined(remaining);
  if (after === undefined || hasServer(after) || !isDeepStrictEqual(withoutServer(loaded.doc), withoutServer(after))) {
    return { error: unchanged(file) };
  }
  if (remaining.trim() === "" && ownFile) {
    try {
      await ctx.removeFile(file);
    } catch (error) {
      return {
        error: `The server table could not be removed from ${file}: ${checkFailure(error)}. The record is kept, so uninstall can try again.`,
      };
    }
    if (ownFolder) {
      try {
        await ctx.removeDirIfEmpty(folder);
      } catch (error) {
        return {
          error: `The server table was removed from ${file}, but the folder ${folder} could not be removed: ${checkFailure(error)}. The record is kept, so uninstall can try again.`,
        };
      }
    }
    return {};
  }
  let backup: string;
  try {
    backup = await freeBackup(file);
  } catch (error) {
    return { error: `The backup name for ${file} could not be checked (${checkFailure(error)}), so nothing was changed.` };
  }
  try {
    if (!ctx.dryRun) {
      await record("codex", key, { kind: "file", path: backup, createdByUs: true });
    }
  } catch (error) {
    return { error: `The backup ${backup} could not be recorded (${checkFailure(error)}), so ${file} was not changed.` };
  }
  try {
    await ctx.writeFile(backup, loaded.text);
  } catch (error) {
    return {
      error: `The backup ${backup} could not be written (${checkFailure(error)}). The file was not changed, and the record is kept, so uninstall can try again.`,
    };
  }
  try {
    await ctx.writeFile(file, remaining);
  } catch (error) {
    return {
      error: `The server table could not be removed from ${file}: ${checkFailure(error)}. The previous file is kept as ${backup}. The record is kept, so uninstall can try again.`,
    };
  }
  return { backup };
};

const uninstallProject = async (ctx: Context): Promise<Step> => {
  const file = configFile(ctx.projectDir);
  const folder = path.dirname(file);
  const key = scopeKey("project", ctx.projectDir);
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid" || loaded.kind === "unreadable") {
    return unusableConfig(ctx, file, loaded);
  }
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", key);
  } catch (error) {
    return step("project", "error", stateRefusal(error));
  }
  // Only what the record lists is removed. A folder is in the record only when this tool made it.
  const ownFile = items.some((item) => item.kind === "file" && item.path === file);
  const ownFolder = items.some((item) => item.kind === "directory" && item.path === folder);
  const tableInFile = loaded.kind === "ok" && hasServer(loaded.doc);
  let removedText = "";
  let note = "";
  let madeBackup: string | undefined;
  let folderRemoved = false;
  if (loaded.kind === "ok" && tableInFile && tableRecorded(items, file)) {
    let expected: { command: string; args: string[] };
    try {
      expected = directEntry(ctx.cliPath);
    } catch (error) {
      return step("project", "error", `The table in ${file} cannot be checked: ${checkFailure(error)}`);
    }
    if (!holdsEntry(loaded.doc, expected.command, expected.args)) {
      // The record lists a table, but the table in the file is not the one this tool writes, for example after the Node binary
      // changed. Nothing is removed and the record stays as it is, so the step is an error. The step says how to remove the table by
      // hand.
      return step("project", "error", editedProjectText(file));
    }
    const removal = await removeTable(ctx, key, file, loaded, ownFile, ownFolder);
    if ("error" in removal) {
      return step("project", "error", removal.error);
    }
    removedText = `${verb(ctx, "Removed", "Would remove")} the server table from ${file}.`;
    madeBackup = removal.backup;
  } else if (tableInFile) {
    note = `The table in ${file} was not written by this tool, so it was kept.`;
  } else if (loaded.kind === "missing" && ownFolder) {
    // The file is gone already, for example when it was removed by hand, so the folder this tool made may go. The step names the
    // folder when it is removed.
    try {
      folderRemoved = await removeEmptyFolder(ctx, folder);
    } catch (error) {
      return step("project", "error", `The folder ${folder} could not be removed: ${checkFailure(error)}. The record is kept, so uninstall can try again.`);
    }
  }
  // The sentence for an error text. It is built with verb, so a dry run says what would happen and never what happened.
  const removedSentence =
    removedText === "" ? "" : `${verb(ctx, "The server table was removed from", "The server table would be removed from")} ${file}.`;
  let skillFiles: string[];
  try {
    skillFiles = await removeRecordedSkill(ctx, items, ctx.projectDir);
  } catch (error) {
    return step(
      "project",
      "error",
      sentences(removedSentence, madeBackup === undefined ? "" : keptPreviousText(ctx.dryRun, madeBackup), skillRemovalFailed(error)),
    );
  }
  let kept: string[];
  try {
    kept = await keptBackups(items, file);
  } catch (error) {
    return step(
      "project",
      "error",
      sentences(removedSentence, `The backups on the record could not be checked (${checkFailure(error)})`, "The record is kept, so uninstall can try again"),
    );
  }
  const backups = madeBackup === undefined ? kept : [...kept, madeBackup];
  // A table that stays keeps its file's record, so a later install can replace the table and a later uninstall can still remove
  // the file once it is empty.
  const keptRecords = note === "" ? [] : items.filter((item) => (item.kind === "toml-table" || item.kind === "file") && item.path === file);
  const endError = await endRecord(ctx, key, items, backups, keptRecords);
  if (endError !== undefined) {
    return step(
      "project",
      "error",
      sentences(removedSentence, `The record could not be updated (${endError})`, "Run uninstall again", backupsKeptText(ctx.dryRun, backups)),
    );
  }
  const skill = skillFilesText(ctx, skillFiles);
  const keptText = backupsKeptText(ctx.dryRun, backups);
  const folderText = folderRemoved ? `${verb(ctx, "Removed", "Would remove")} the empty folder ${folder}.` : "";
  const text = sentences(
    note,
    removedText,
    madeBackup === undefined ? "" : keptPreviousText(ctx.dryRun, madeBackup),
    keptText,
    skill,
    folderText,
  );
  // A kept table gives skipped, even when something else was removed in the same step, so the status agrees with the note. Otherwise
  // the status is ok when something was removed: the table, a skill file or the folder. The text names each of them.
  if (note !== "") {
    return step("project", "skipped", text);
  }
  if (removedText !== "" || skillFiles.length > 0 || folderRemoved) {
    return step("project", "ok", text);
  }
  return step("project", "skipped", sentences(NOT_INSTALLED, keptText));
};

// The project check. It gives a step only when the record lists the table. A file that does not parse is an error. The table
// counts only when its own fields are the ones this tool writes, so a foreign value under the key is not found.
const doctorProject = async (ctx: Context): Promise<Step | undefined> => {
  const file = configFile(ctx.projectDir);
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", scopeKey("project", ctx.projectDir));
  } catch (error) {
    return step("project", "error", stateRefusal(error));
  }
  if (!tableRecorded(items, file)) {
    return undefined;
  }
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step("project", "error", notValid(file));
  }
  if (loaded.kind === "unreadable") {
    return step("project", "error", unreadableText(file, loaded.reason));
  }
  if (loaded.kind === "missing" || !hasServer(loaded.doc)) {
    return step("project", "skipped", `The recorded table is not in ${file}.`);
  }
  let expected: { command: string; args: string[] };
  try {
    expected = directEntry(ctx.cliPath);
  } catch (error) {
    return step("project", "error", `The table in ${file} cannot be checked: ${checkFailure(error)}`);
  }
  if (!holdsEntry(loaded.doc, expected.command, expected.args)) {
    return step("project", "skipped", `The recorded table in ${file} does not hold the server entry this tool writes.`);
  }
  return step("project", "ok", `The server table is in ${file}.`);
};

const doctorAll = async (ctx: Context): Promise<Step[]> => {
  const steps: Step[] = [];
  const global = await doctorGlobal(ctx);
  if (global !== undefined) {
    steps.push(global);
  }
  const project = await doctorProject(ctx);
  if (project !== undefined) {
    steps.push(project);
  }
  return steps;
};

export const codexAdapter: AgentAdapter = {
  id: "codex",
  scopes: SCOPES,
  present: (ctx) => ctx.present("codex"),
  install: async (ctx, scope) => {
    requireScope(scope);
    return [scope === "global" ? await installGlobal(ctx) : await installProject(ctx)];
  },
  update: async (ctx, scope) => {
    requireScope(scope);
    return [scope === "global" ? await updateGlobal(ctx) : await updateProject(ctx)];
  },
  uninstall: async (ctx, scope) => {
    requireScope(scope);
    return [scope === "global" ? await uninstallGlobal(ctx) : await uninstallProject(ctx)];
  },
  doctor: doctorAll,
};
