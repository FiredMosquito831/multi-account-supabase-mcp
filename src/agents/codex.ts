import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
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
// This tool writes the skill files itself, rather than through a Codex command, because the Codex command this tool uses
// is codex mcp, and that does not install skills. ASSUMED: Codex has no command for skills. The help text read for this
// plan covers codex mcp only.
//
// The folders that a call makes are recorded after the call has made them all, and each file is recorded before it is written,
// so uninstall can remove what this tool made. When a record cannot be written, the folders made by that call are removed again.
// A backup is the exception: it is kept and never recorded, so uninstall never removes it. A folder that was there before is
// never recorded.

const SCOPES = supportedScopes("codex");

// The table that holds this tool's server in the project file.
const SERVER_TABLE = `mcp_servers.${DIRECT_KEY}`;

const NOT_INSTALLED = "not installed in this scope";
const NOT_INSTALLED_GLOBALLY = "not installed globally";
const REFUSED_VALUE =
  "The server entry has a single quote or a line break, which the project file cannot hold, so nothing was changed.";

type Doc = Record<string, unknown>;

// What is on disk for the project file. A file that is not UTF-8, or does not parse, is invalid. The text keeps a byte
// order mark, so a rewrite gives back the same bytes.
type Loaded = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; text: string; doc: Doc };

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

// The global skill. The base is CODEX_HOME, or the .codex folder of the home folder when CODEX_HOME is not set. An empty
// CODEX_HOME counts as not set. ASSUMED: Codex reads user skills from the skills folder under the base, not verified yet.
const globalSite = (): SkillSite => {
  const codexHome = process.env.CODEX_HOME;
  const home = codexHome === undefined || codexHome === "" ? path.join(os.homedir(), ".codex") : codexHome;
  const base = path.resolve(home);
  return { base, folder: path.join(base, "skills", SKILL_NAME) };
};

// The project skill. The base is the project folder, which is kept as it is when it exists. ASSUMED: Codex reads project
// skills from .agents/skills in the project, not verified yet.
const projectSite = (projectDir: string): SkillSite => {
  const base = path.resolve(projectDir);
  return { base, folder: path.join(base, ".agents", "skills", SKILL_NAME) };
};

const notValid = (file: string): string => `${file} is not valid TOML, so nothing was changed.`;

const unchanged = (file: string): string => `${file} could not be changed safely, so nothing was changed.`;

// The first word of a step: what a real run did, or what a dry run would do.
const verb = (ctx: Context, done: string, would: string): string => (ctx.dryRun ? would : done);

// The step text for the skill. The location is assumed, so the text says so.
const skillWritten = (ctx: Context, folder: string): string =>
  `${verb(ctx, "Wrote", "Would write")} the skill to ${folder}. ` +
  "Codex reads skills from this folder (ASSUMED, not verified yet).";

// The sentence that says which skill files a step removed. Empty when a step removed none.
const skillFilesText = (ctx: Context, files: readonly string[]): string =>
  files.length === 0 ? "" : `${verb(ctx, "Removed", "Would remove")} the skill file ${files.join(", ")}.`;

// The error text for a skill file that could not be removed. The record is kept, so a later uninstall can try again.
const skillRemovalFailed = (error: unknown): string =>
  `The skill file could not be removed: ${checkFailure(error)}. The record is kept, so uninstall can try again.`;

// The text of a step with the sentence about the skill added. The sentence is left out when it is empty.
const withSkillText = (text: string, skill: string): string => (skill === "" ? text : `${text} ${skill}`);

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

// Reads the project file. A missing file gives "missing". Other read errors are thrown as they are.
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

// The first output that is not empty: the error output, then the standard output, and otherwise the exit code.
const failureText = (result: CommandResult): string =>
  [result.stderr, result.stdout].map((text) => text.trim()).find((text) => text !== "") ?? `exit ${result.code}`;

// Writes the skill for a site. installSkill calls back once the folders it made exist, and before it writes the file. The folders
// are recorded first, then the SKILL.md item, so the record never names a folder or a file that a failed folder creation did not
// leave. In a dry run nothing is recorded.
const writeSkill = async (ctx: Context, scope: "global" | "project", site: SkillSite): Promise<void> => {
  const key = scopeKey(scope, ctx.projectDir);
  await installSkill(ctx, ctx.packageRoot, site.folder, async (madeFolders) => {
    if (ctx.dryRun) {
      return;
    }
    await recordThenUndo(ctx, madeFolders, async () => {
      for (const folder of madeFolders) {
        await record("codex", key, { kind: "directory", path: folder });
      }
      await record("codex", key, { kind: "file", path: path.join(site.folder, SKILL_FILE), createdByUs: true });
    });
  });
};

// The first error of a check, as text. It is the error's own message, which names a path and never the contents of a file.
const checkFailure = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "The check failed";

// The refusal for a record that cannot be read. It names the file and the reason, and it says that nothing was changed.
const stateRefusal = (error: unknown): string => {
  const text = checkFailure(error);
  return text.includes("nothing was changed") ? text : `${text}, so nothing was changed.`;
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

// The reason an install must stop before it changes anything, or undefined when the skill can be written. The record is read
// first, so a state file that cannot be read stops the install before the first change. Then the packaged skill text must be
// readable, every folder on the way to the skill folder must be a folder or be missing, and a SKILL.md in the skill folder must
// be one this tool created or be absent. A refused install writes nothing.
const skillBlocked = async (ctx: Context, scope: "global" | "project", site: SkillSite): Promise<string | undefined> => {
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", scopeKey(scope, ctx.projectDir));
  } catch (error) {
    return stateRefusal(error);
  }
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

// Removes what the record lists for each skill folder: the skill file when this tool created it, the folder when this tool
// created it and it is empty, and each recorded folder above it, deepest first, under the same rule. Returns the skill files
// that were removed, so the step can say so.
const removeRecordedSkill = async (ctx: Context, items: readonly Item[]): Promise<string[]> => {
  const removedFiles: string[] = [];
  for (const folder of recordedSkillFolders(items)) {
    const file = path.join(folder, SKILL_FILE);
    const fileListed = items.some((item) => item.kind === "file" && item.path === file && item.createdByUs);
    const folderListed = items.some((item) => item.kind === "directory" && item.path === folder);
    if (fileListed && folderListed) {
      await removeSkill(ctx, folder);
    } else if (fileListed) {
      await ctx.removeFile(file);
    } else if (folderListed) {
      await ctx.removeDirIfEmpty(folder);
    }
    if (fileListed) {
      removedFiles.push(file);
    }
    const above = items.flatMap((item) =>
      item.kind === "directory" && folder.startsWith(`${item.path}${path.sep}`) ? [item.path] : [],
    );
    await removeRecordedFolders(ctx, items, above.sort((a, b) => a.length - b.length));
  }
  return removedFiles;
};

const installGlobal = async (ctx: Context): Promise<Step> => {
  // Checked first, so a refused install runs no codex command and writes nothing.
  const site = globalSite();
  const blocked = await skillBlocked(ctx, "global", site);
  if (blocked !== undefined) {
    return step("global", "error", blocked);
  }
  const { command, args } = directEntry(ctx.cliPath);
  // The removal fails when no entry exists yet, which is the usual case, so its result is not used.
  await ctx.run("codex", ["mcp", "remove", DIRECT_KEY]);
  const added = await ctx.run("codex", ["mcp", "add", DIRECT_KEY, "--", command, ...args]);
  if (added.code !== 0) {
    return step("global", "error", failureText(added));
  }
  if (!ctx.dryRun) {
    await record("codex", scopeKey("global", ctx.projectDir), { kind: "mcp-entry", name: DIRECT_KEY });
  }
  try {
    await writeSkill(ctx, "global", site);
  } catch (error) {
    return step("global", "error", `The server entry was added and recorded. The skill was not written: ${checkFailure(error)}`);
  }
  const addedText = `${verb(ctx, "Added", "Would add")} the server to the global Codex configuration.`;
  return step("global", "ok", `${addedText} ${skillWritten(ctx, site.folder)}`);
};

const updateGlobal = async (ctx: Context): Promise<Step> => {
  const items = await recordedItems("codex", scopeKey("global", ctx.projectDir));
  const recorded = items.some((item) => item.kind === "mcp-entry" && item.name === DIRECT_KEY);
  return recorded ? installGlobal(ctx) : step("global", "skipped", NOT_INSTALLED);
};

const uninstallGlobal = async (ctx: Context): Promise<Step> => {
  // Without the program the entry cannot be removed, so the record stays for a later attempt.
  if (!ctx.present("codex")) {
    return step("global", "skipped", "codex is not on PATH, so nothing was removed globally.");
  }
  const key = scopeKey("global", ctx.projectDir);
  // The record is read before the codex command. A record that cannot be read stops here, and no command runs.
  let items: readonly Item[];
  try {
    items = await recordedItems("codex", key);
  } catch (error) {
    return step("global", "error", stateRefusal(error));
  }
  const removed = await ctx.run("codex", ["mcp", "remove", DIRECT_KEY]);
  // The skill goes even when the removal reported a failure. The record is forgotten below either way, so a skill that
  // was kept would have no record left to remove it later.
  let skillFiles: string[];
  try {
    skillFiles = await removeRecordedSkill(ctx, items);
  } catch (error) {
    const entry = removed.code === 0 ? "The server entry was removed. " : "";
    return step("global", "error", `${entry}${skillRemovalFailed(error)}`);
  }
  if (!ctx.dryRun) {
    await forget("codex", key);
  }
  const skill = skillFilesText(ctx, skillFiles);
  const removedText = `${verb(ctx, "Removed", "Would remove")} the server from the global Codex configuration.`;
  return removed.code === 0
    ? step("global", "ok", withSkillText(removedText, skill))
    : step("global", "skipped", skill === "" ? NOT_INSTALLED_GLOBALLY : `${NOT_INSTALLED_GLOBALLY}. ${skill}`);
};

const doctorGlobal = async (ctx: Context): Promise<Step> => {
  if (!ctx.present("codex")) {
    return step("global", "skipped", "codex is not on PATH.");
  }
  const listed = await ctx.run("codex", ["mcp", "list"]);
  // The server counts as listed when its name is one whole word of the output. The output format is not verified.
  const words = listed.stdout.split(/[\s|│]+/);
  return listed.code === 0 && words.includes(DIRECT_KEY)
    ? step("global", "ok", "The server is in codex mcp list.")
    : step("global", "skipped", "The server is not in codex mcp list.");
};

// Writes the server table into the project file. The file is backed up before it changes. The new text is checked before
// anything is written: it must parse, and the rest of the file must be as it was.
const writeProjectTable = async (ctx: Context, loaded: Exclude<Loaded, { kind: "invalid" }>): Promise<Step> => {
  const file = configFile(ctx.projectDir);
  const { command, args } = directEntry(ctx.cliPath);
  if (![command, ...args].every(fitsLiteral)) {
    return step("project", "error", REFUSED_VALUE);
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
  // Checked before anything is written, so a refused install leaves the project file as it was.
  const site = projectSite(ctx.projectDir);
  const blocked = await skillBlocked(ctx, "project", site);
  if (blocked !== undefined) {
    return step("project", "error", blocked);
  }
  const folder = path.dirname(file);
  // The folders for the config file, and the file and its table, are recorded before anything is written. When a record cannot be
  // written, the folders made here are removed again, and nothing is written. A backup of the file is kept, and it is never recorded.
  try {
    const madeFolders = await ensureFolders(ctx, ctx.projectDir, folder);
    if (!ctx.dryRun) {
      await recordThenUndo(ctx, madeFolders, async () => {
        const key = scopeKey("project", ctx.projectDir);
        for (const made of madeFolders) {
          await record("codex", key, { kind: "directory", path: made });
        }
        if (loaded.kind === "missing") {
          // The file did not exist before, so this tool creates it. Uninstall may then remove the file.
          await record("codex", key, { kind: "file", path: file, createdByUs: true });
        }
        await record("codex", key, { kind: "toml-table", path: file, table: SERVER_TABLE });
      });
    }
  } catch (error) {
    return step("project", "error", `Nothing was written to ${file}: ${checkFailure(error)}`);
  }
  if (loaded.kind === "ok") {
    await ctx.writeFile(`${file}.bak`, before);
  }
  await ctx.writeFile(file, updated);
  try {
    await writeSkill(ctx, "project", site);
  } catch (error) {
    return step(
      "project",
      "error",
      `The server table was written to ${file} and recorded. The skill was not written: ${checkFailure(error)}`,
    );
  }
  const tableWritten = `${verb(ctx, "Wrote", "Would write")} the server table to ${file}.`;
  const trust = "Codex reads this file only when its folder is trusted (not verified yet).";
  return step("project", "ok", `${tableWritten} ${trust} ${skillWritten(ctx, site.folder)}`);
};

const installProject = async (ctx: Context): Promise<Step> => {
  const file = configFile(ctx.projectDir);
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step("project", "error", notValid(file));
  }
  return writeProjectTable(ctx, loaded);
};

const updateProject = async (ctx: Context): Promise<Step> => {
  const file = configFile(ctx.projectDir);
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step("project", "error", notValid(file));
  }
  if (loaded.kind === "missing" || !hasServer(loaded.doc)) {
    return step("project", "skipped", NOT_INSTALLED);
  }
  return writeProjectTable(ctx, loaded);
};

const uninstallProject = async (ctx: Context): Promise<Step> => {
  const file = configFile(ctx.projectDir);
  const folder = path.dirname(file);
  const key = scopeKey("project", ctx.projectDir);
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step("project", "error", notValid(file));
  }
  // Only what the record lists is removed. A folder is in the record only when this tool made it.
  const items = await recordedItems("codex", key);
  const ownFile = items.some((item) => item.kind === "file" && item.path === file);
  const ownFolder = items.some((item) => item.kind === "directory" && item.path === folder);
  if (loaded.kind === "missing" || !hasServer(loaded.doc)) {
    // A folder goes only once its file is gone. A missing file is gone already, for example when it was removed by hand.
    if (loaded.kind === "missing" && ownFolder) {
      await ctx.removeDirIfEmpty(folder);
    }
    let skillFiles: string[];
    try {
      skillFiles = await removeRecordedSkill(ctx, items);
    } catch (error) {
      return step("project", "error", skillRemovalFailed(error));
    }
    if (!ctx.dryRun) {
      await forget("codex", key);
    }
    const skill = skillFilesText(ctx, skillFiles);
    return step("project", "skipped", skill === "" ? NOT_INSTALLED : `${NOT_INSTALLED}. ${skill}`);
  }
  const remaining = withoutServerLines(loaded.text);
  const after = parseOrUndefined(remaining);
  if (
    after === undefined ||
    hasServer(after) ||
    !isDeepStrictEqual(withoutServer(loaded.doc), withoutServer(after))
  ) {
    return step("project", "error", unchanged(file));
  }
  if (remaining.trim() === "" && ownFile) {
    await ctx.removeFile(file);
    // The file is gone now, so the folder may go too, but only when this tool made it and it is empty.
    if (ownFolder) {
      await ctx.removeDirIfEmpty(folder);
    }
  } else {
    await ctx.writeFile(`${file}.bak`, loaded.text);
    await ctx.writeFile(file, remaining);
  }
  let skillFiles: string[];
  try {
    skillFiles = await removeRecordedSkill(ctx, items);
  } catch (error) {
    return step("project", "error", `The server table was removed from ${file}. ${skillRemovalFailed(error)}`);
  }
  if (!ctx.dryRun) {
    await forget("codex", key);
  }
  const removedText = `${verb(ctx, "Removed", "Would remove")} the server table from ${file}.`;
  return step("project", "ok", withSkillText(removedText, skillFilesText(ctx, skillFiles)));
};

const doctorProject = async (ctx: Context): Promise<Step> => {
  const file = configFile(ctx.projectDir);
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step("project", "error", notValid(file));
  }
  if (loaded.kind === "ok" && hasServer(loaded.doc)) {
    return step("project", "ok", `The server table is in ${file}.`);
  }
  return step("project", "skipped", NOT_INSTALLED);
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
  doctor: async (ctx) => [await doctorGlobal(ctx), await doctorProject(ctx)],
};
