import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse } from "smol-toml";
import type { CommandResult } from "./command.js";
import { DIRECT_KEY, directEntry, type Scope, supportedScopes } from "./scopes.js";
import { forget, record, recordedItems, scopeKey } from "./state.js";
import { type AgentAdapter, type Context, type Step, UnsupportedScope } from "./types.js";

// The Codex adapter. The global scope uses the codex mcp commands, which write the user's configuration. Codex has no
// scope flag, so the project scope is a table in the project's own file, .codex/config.toml. Codex is assumed to read
// that file only when the project folder is trusted. This is not verified yet.
//
// The project file is edited as text, so the other tables keep their bytes. The new text must parse, and everything
// except this tool's table must be as it was. When either check fails, nothing is written.

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

// Whether a path is an existing folder. A missing path is not one. Any other error is thrown.
const isFolder = async (folder: string): Promise<boolean> => {
  try {
    return (await stat(folder)).isDirectory();
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
};

const configFile = (projectDir: string): string => path.resolve(projectDir, ".codex", "config.toml");

const notValid = (file: string): string => `${file} is not valid TOML, so nothing was changed.`;

const unchanged = (file: string): string => `${file} could not be changed safely, so nothing was changed.`;

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

const installGlobal = async (ctx: Context): Promise<Step> => {
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
  return step("global", "ok", "Added the server to the global Codex configuration.");
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
  const removed = await ctx.run("codex", ["mcp", "remove", DIRECT_KEY]);
  if (!ctx.dryRun) {
    await forget("codex", scopeKey("global", ctx.projectDir));
  }
  return removed.code === 0
    ? step("global", "ok", "Removed the server from the global Codex configuration.")
    : step("global", "skipped", NOT_INSTALLED_GLOBALLY);
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
  const folder = path.dirname(file);
  // Checked before the folder is made, so a folder that was already there is never recorded as this tool's.
  const folderWasThere = await isFolder(folder);
  await ctx.ensureDir(folder);
  if (loaded.kind === "ok") {
    await ctx.writeFile(`${file}.bak`, before);
  }
  await ctx.writeFile(file, updated);
  if (!ctx.dryRun) {
    const key = scopeKey("project", ctx.projectDir);
    if (!folderWasThere) {
      await record("codex", key, { kind: "directory", path: folder });
    }
    if (loaded.kind === "missing") {
      // The file did not exist before, so this tool created it. Uninstall may then remove the file.
      await record("codex", key, { kind: "file", path: file, createdByUs: true });
    }
    await record("codex", key, { kind: "toml-table", path: file, table: SERVER_TABLE });
  }
  return step(
    "project",
    "ok",
    `Wrote the server table to ${file}. Codex reads this file only when its folder is trusted (not verified yet).`,
  );
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
    if (!ctx.dryRun) {
      await forget("codex", key);
    }
    return step("project", "skipped", NOT_INSTALLED);
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
  if (!ctx.dryRun) {
    await forget("codex", key);
  }
  return step("project", "ok", `Removed the server table from ${file}.`);
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
