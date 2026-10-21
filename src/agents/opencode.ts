import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { DIRECT_KEY, directEntry, type Scope, supportedScopes } from "./scopes.js";
import { forget, type Item, record, recordedItems, scopeKey } from "./state.js";
import { type AgentAdapter, type Context, type Step, UnsupportedScope } from "./types.js";

// The opencode adapter. opencode has no command here that adds or removes a server, so this adapter edits the JSON
// file itself. The layout is ASSUMED, not verified against opencode: the file is named opencode.json, in the global
// folder and in the project folder; the servers sit under the key "mcp"; a local server has type "local", its command
// as a list, and enabled set to true.
//
// The file is parsed before any change. A file that does not parse, or whose top level or mcp value is not an object,
// is refused, and nothing is written. Every other key keeps its value. The old file is kept as <file>.bak before it
// changes.

type ActiveScope = "global" | "project";

const FILE_NAME = "opencode.json";

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

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

const isObject = (value: unknown): value is Doc => typeof value === "object" && value !== null && !Array.isArray(value);

const isJsonEntry = (item: Item): item is Extract<Item, { kind: "json-entry" }> => item.kind === "json-entry";

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

// The folder of opencode's global configuration: the XDG configuration folder, or .config in the home folder, then
// opencode. An empty value counts as not set. A value that is not an absolute path is ignored, as the XDG base
// directory rule says, so the folder never depends on the working folder.
export const opencodeGlobalDir = (env: NodeJS.ProcessEnv, homeDir: string): string => {
  const configured = env.XDG_CONFIG_HOME;
  const configHome = configured && path.isAbsolute(configured) ? configured : path.join(homeDir, ".config");
  return path.join(configHome, "opencode");
};

// The file and the folder of a scope, and the record key. When an entry is recorded for the scope, the file is the one
// recorded at install time, and the folder is its folder. So a later change of the environment cannot move the entry:
// install, update, uninstall and doctor all act on the file that install wrote. Only a scope with nothing recorded gets
// its path from the environment (global) or from the project folder (project).
const targetOf = async (ctx: Context, scope: ActiveScope): Promise<Target> => {
  const key = scopeKey(scope, ctx.projectDir);
  const entry = (await recordedItems("opencode", key)).find(isJsonEntry);
  if (entry !== undefined) {
    return { folder: path.dirname(entry.path), file: entry.path, key, recorded: true };
  }
  const folder = path.resolve(scope === "global" ? opencodeGlobalDir(process.env, os.homedir()) : ctx.projectDir);
  return { folder, file: path.join(folder, FILE_NAME), key, recorded: false };
};

const notValid = (file: string): string => `${file} is not valid JSON, so nothing was changed.`;

const unexpected = (file: string): string => `${file} has unexpected contents, so nothing was changed.`;

const unchanged = (file: string): string => `${file} could not be changed safely, so nothing was changed.`;

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

// Whether the mcp value, when the document has one, is an object.
const tableFits = (doc: Doc): boolean => !Object.hasOwn(doc, TABLE) || isObject(doc[TABLE]);

// Reads the file. A missing file gives "missing". Other read errors are thrown as they are. Their messages hold the
// path and a system code, never the text.
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

// The text written for a document: two-space indentation, the layout of the old file, and a final line ending.
const render = (doc: Doc, layout: Layout): string =>
  `${layout.bom}${JSON.stringify(doc, null, 2).split("\n").join(layout.eol)}${layout.eol}`;

// The servers table of a document, or undefined when the document has none.
const tableOf = (doc: Doc): Doc | undefined => {
  const table = doc[TABLE];
  return isObject(table) ? table : undefined;
};

// This tool's entry in a document, or undefined when there is none.
const entryOf = (doc: Doc): unknown => tableOf(doc)?.[DIRECT_KEY];

// The document with this tool's entry set to the given value. The other keys keep their order and their values.
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
  const { folder, file, key } = await targetOf(ctx, scope);
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step(scope, "error", notValid(file));
  }
  if (loaded.kind === "unexpected") {
    return step(scope, "error", unexpected(file));
  }
  const { command, args } = directEntry(ctx.cliPath);
  const entry = { type: "local", command: [command, ...args], enabled: true };
  const before: Doc = loaded.kind === "ok" ? loaded.doc : {};
  const text = render(withEntry(before, entry), layoutOf(loaded.kind === "ok" ? loaded.text : ""));
  // The new text is read back before anything is written. It must hold the entry, and nothing else may differ.
  const after = parseDocument(text);
  if (after === undefined || !sameApartFromEntry(before, after) || !isDeepStrictEqual(entryOf(after), entry)) {
    return step(scope, "error", unchanged(file));
  }
  // A folder is recorded only when this tool made it, so a folder that was already there is never removed later.
  const folderWasThere = await isFolder(folder);
  if (loaded.kind === "missing") {
    await ctx.ensureDir(folder);
  }
  if (loaded.kind === "ok") {
    await ctx.writeFile(`${file}.bak`, loaded.text);
  }
  await ctx.writeFile(file, text);
  if (!ctx.dryRun) {
    if (!folderWasThere) {
      await record("opencode", key, { kind: "directory", path: folder });
    }
    if (loaded.kind === "missing") {
      // The file did not exist before, so this tool created it, and uninstall may remove it.
      await record("opencode", key, { kind: "file", path: file, createdByUs: true });
    }
    await record("opencode", key, { kind: "json-entry", path: file, pointer: ENTRY_POINTER });
  }
  return step(
    scope,
    "ok",
    `Wrote the server entry to ${file}. The file name and the layout are ASSUMED, not verified with opencode.`,
  );
};

// Install again, but only where this tool has an entry recorded. An update never adds an install to a scope.
const updateIn = async (ctx: Context, scope: ActiveScope): Promise<Step> =>
  (await targetOf(ctx, scope)).recorded ? installIn(ctx, scope) : step(scope, "skipped", NOT_INSTALLED);

const uninstallIn = async (ctx: Context, scope: ActiveScope): Promise<Step> => {
  const { folder, file, key } = await targetOf(ctx, scope);
  const loaded = await loadConfig(file);
  if (loaded.kind === "invalid") {
    return step(scope, "error", notValid(file));
  }
  if (loaded.kind === "unexpected") {
    return step(scope, "error", unexpected(file));
  }
  // Only what the record lists is removed. A file or a folder is in the record only when this tool made it.
  const items = await recordedItems("opencode", key);
  const ownFile = items.some((item) => item.kind === "file" && item.path === file);
  const ownFolder = items.some((item) => item.kind === "directory" && item.path === folder);
  if (loaded.kind === "missing" || entryOf(loaded.doc) === undefined) {
    // A folder goes only once its file is gone, for example when the file was removed by hand. Only a folder that
    // this tool made goes.
    if (loaded.kind === "missing" && ownFolder) {
      await ctx.removeDirIfEmpty(folder);
    }
    if (!ctx.dryRun) {
      await forget("opencode", key);
    }
    return step(scope, "skipped", NOT_INSTALLED);
  }
  const text = render(withoutEntry(loaded.doc), layoutOf(loaded.text));
  const after = parseDocument(text);
  if (after === undefined || !sameApartFromEntry(loaded.doc, after) || entryOf(after) !== undefined) {
    return step(scope, "error", unchanged(file));
  }
  // A file that this tool created, and that holds nothing but this entry, is removed, and so is its folder when this
  // tool made it and it is empty. No backup is kept for such a file, because a backup would keep the folder.
  const createdOnly = ownFile && Object.keys(comparable(loaded.doc)).length === 0;
  if (createdOnly) {
    await ctx.removeFile(file);
    if (ownFolder) {
      await ctx.removeDirIfEmpty(folder);
    }
  } else {
    await ctx.writeFile(`${file}.bak`, loaded.text);
    await ctx.writeFile(file, text);
  }
  if (!ctx.dryRun) {
    await forget("opencode", key);
  }
  const message = createdOnly
    ? `Removed ${file}, which this tool had created. The file name is ASSUMED, not verified with opencode.`
    : `Removed the server entry from ${file}. The layout is ASSUMED, not verified with opencode.`;
  return step(scope, "ok", message);
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
  uninstall: async (ctx, scope) => [await uninstallIn(ctx, activeScope(scope))],
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
