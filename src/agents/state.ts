import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withRegistryLock } from "../accounts/lock.js";
import { renameWithRetry } from "../accounts/registry.js";
import { dataFolder, isAbsoluteLocation } from "../paths.js";

export type AgentId = "claude" | "codex" | "opencode" | "antigravity";

// One thing the installer wrote. Uninstall removes what each kind lists, with three limits. A marketplace is never removed: the
// Claude adapter only reports it, and drops it from the record with its scope. A folder is removed only when it is empty. A
// backup is a file item too, and the opencode adapter keeps each backup that is on disk and names it. Each kind names exactly
// what the item covers. A server item names the command line program that the install pointed the entry at, so doctor can
// check that the program still exists. Uninstall forgets the whole scope, so a server item goes with the scope's other
// items. A scope holds at most one server item.
export type Item =
  | { kind: "mcp-entry"; name: string }
  | { kind: "marketplace"; name: string }
  | { kind: "toml-table"; path: string; table: string }
  | { kind: "json-entry"; path: string; pointer: string }
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; createdByUs: true }
  | { kind: "server"; cliPath: string };

// The only version this code reads and writes. A file with another version is refused.
const VERSION = 1;

const PROJECT_PREFIX = "project:";
const LOCAL_PREFIX = "local:";

// The folder part of a scope key. The path is resolved, so a trailing separator, a dot-dot segment or a relative path gives
// the key of the folder it names. On Windows the letters are lower case, because a Windows folder name is not case-sensitive
// by default, so one folder has one key.
const keyFolder = (folder: string): string => {
  const resolved = path.resolve(folder);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

// The key of a scope in the state file: "global", "project:" followed by the folder, or "local:" followed by the folder.
// A project scope and a local scope in the same folder have different keys.
export const scopeKey = (scope: "global" | "project" | "local", projectDir: string): string => {
  if (scope === "global") {
    return "global";
  }
  const prefix = scope === "project" ? PROJECT_PREFIX : LOCAL_PREFIX;
  return `${prefix}${keyFolder(projectDir)}`;
};

// A key is "global", or the key that scopeKey writes for the folder after its prefix. Any other form, such as a trailing
// separator, a dot-dot segment, or on Windows another letter case, is a second key for one folder, which uninstall would
// not find.
const isScopeKey = (key: string): boolean => {
  if (key === "global") {
    return true;
  }
  if (key.startsWith(PROJECT_PREFIX)) {
    return scopeKey("project", key.slice(PROJECT_PREFIX.length)) === key;
  }
  if (key.startsWith(LOCAL_PREFIX)) {
    return scopeKey("local", key.slice(LOCAL_PREFIX.length)) === key;
  }
  return false;
};

// The key that a key in a state file stands for, or undefined when the key is not one of ours. An earlier version of this code
// kept the letters of the folder as given. On Windows such a key names the same folder as the key scopeKey writes now, so it
// is read as that key, and the next write stores the items under the current key. Any other form is refused.
const storedKeyMeaning = (key: string): string | undefined => {
  if (isScopeKey(key)) {
    return key;
  }
  for (const [prefix, scope] of [
    [PROJECT_PREFIX, "project"],
    [LOCAL_PREFIX, "local"],
  ] as const) {
    if (key.startsWith(prefix)) {
      const folder = key.slice(prefix.length);
      return prefix + path.resolve(folder) === key ? scopeKey(scope, folder) : undefined;
    }
  }
  return undefined;
};

const SCOPE_KEY_MESSAGE =
  'A scope key must be "global", or "project:" or "local:" followed by a folder in the form scopeKey writes.';

// Every call that takes a key checks it first, so a key in another form is an error, not a silent empty result.
const assertScopeKey = (key: string): void => {
  if (!isScopeKey(key)) {
    throw new Error(SCOPE_KEY_MESSAGE);
  }
};

// The state file of an agent, in the state folder of the data folder. A folder given by the caller is used instead. The data folder
// comes from the environment the caller passes, or from the process environment when none is passed. An empty folder name counts
// as not given, as it does for the data folder variable.
export const statePath = (agent: AgentId, dataDir?: string, env: NodeJS.ProcessEnv = process.env): string =>
  path.join(dataDir || dataFolder(env, process.platform, os.homedir()), "state", `${agent}.json`);

// The one message for a state file that cannot be used. The reason is a fixed phrase or a system error code. The file's text
// never reaches the message, and no cause is kept, because a parser error can quote the text.
const refused = (file: string, reason: string): Error =>
  new Error(`The agent state file cannot be read, so nothing was changed: ${file} (${reason})`);

// The text of a file, or undefined when there is no such file. Any other read error is refused with the file's name and the
// error code, as the accounts file refuses its own. The system's message is not passed on.
export const readIfExists = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      return undefined;
    }
    throw refused(file, typeof code === "string" ? code : "read failed");
  }
};

const nonEmptyText = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("A recorded field must be a non-empty string.");
  }
  return value;
};

// A path is kept only when it names a place without depending on the working folder. On Windows a rooted path with no drive
// depends on the current drive, so it is refused. One place has one spelling, so a path is kept only in the form path.resolve
// writes it.
const absolutePath = (value: unknown): string => {
  const file = nonEmptyText(value);
  if (!isAbsoluteLocation(file)) {
    throw new Error("A recorded path must be absolute.");
  }
  if (path.resolve(file) !== file) {
    throw new Error("A recorded path must be written as path.resolve writes it: no dot segments, no trailing separator.");
  }
  return file;
};

// The pointer of an entry names a part of a JSON document. An empty pointer names the whole document, so the pointer
// must start with a slash.
const entryPointer = (value: unknown): string => {
  const pointer = nonEmptyText(value);
  if (!pointer.startsWith("/")) {
    throw new Error("A recorded JSON pointer must start with a slash.");
  }
  return pointer;
};

// The fields of an item must be exactly the ones its kind lists: none may be missing, and none may be added.
const expectKeys = (fields: Record<string, unknown>, keys: readonly string[]): void => {
  if (Object.keys(fields).length !== keys.length || !keys.every((key) => Object.hasOwn(fields, key))) {
    throw new Error("A recorded item has a field that its kind does not allow, or lacks one.");
  }
};

// Checks one item and returns a copy with exactly the fields of its kind, in a fixed order. So two items with the same
// fields have the same JSON, and that is how a repeated item is recognised.
const toItem = (value: unknown): Item => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("A recorded item must be an object.");
  }
  const fields = value as Record<string, unknown>;
  switch (fields.kind) {
    case "mcp-entry":
      expectKeys(fields, ["kind", "name"]);
      return { kind: "mcp-entry", name: nonEmptyText(fields.name) };
    case "marketplace":
      expectKeys(fields, ["kind", "name"]);
      return { kind: "marketplace", name: nonEmptyText(fields.name) };
    case "toml-table":
      expectKeys(fields, ["kind", "path", "table"]);
      return { kind: "toml-table", path: absolutePath(fields.path), table: nonEmptyText(fields.table) };
    case "json-entry":
      expectKeys(fields, ["kind", "path", "pointer"]);
      return { kind: "json-entry", path: absolutePath(fields.path), pointer: entryPointer(fields.pointer) };
    case "directory":
      expectKeys(fields, ["kind", "path"]);
      return { kind: "directory", path: absolutePath(fields.path) };
    case "file":
      expectKeys(fields, ["kind", "path", "createdByUs"]);
      if (fields.createdByUs !== true) {
        throw new Error("A recorded file must be marked as created by this tool.");
      }
      return { kind: "file", path: absolutePath(fields.path), createdByUs: true };
    case "server":
      expectKeys(fields, ["kind", "cliPath"]);
      return { kind: "server", cliPath: absolutePath(fields.cliPath) };
    default:
      throw new Error("A recorded item has an unknown kind.");
  }
};

// Two items are the same when their fields are the same. Items keep one fixed field order, so their JSON compares them.
const sameItem = (a: Item, b: Item): boolean => JSON.stringify(a) === JSON.stringify(b);

// Checks the whole parsed file. The top level holds exactly the version and the scopes. Each key must be a key that scopeKey
// writes, or one that an earlier version wrote, and each scope must hold a list of valid items.
const checkState = (data: unknown): Map<string, Item[]> => {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("The file does not hold a JSON object.");
  }
  const fields = data as Record<string, unknown>;
  expectKeys(fields, ["version", "scopes"]);
  if (fields.version !== VERSION) {
    throw new Error("The file has a version this code does not read.");
  }
  const scopes = fields.scopes;
  if (typeof scopes !== "object" || scopes === null || Array.isArray(scopes)) {
    throw new Error('The "scopes" value must be an object.');
  }
  const result = new Map<string, Item[]>();
  for (const [stored, items] of Object.entries(scopes)) {
    const key = storedKeyMeaning(stored);
    if (key === undefined) {
      throw new Error("A scope key is not one that scopeKey writes.");
    }
    if (!Array.isArray(items)) {
      throw new Error("A scope must hold a list of items.");
    }
    // Two stored keys can name one scope, and the items of both are read together. An item that is listed twice is kept once.
    const listed = result.get(key) ?? [];
    for (const item of items.map((value) => toItem(value))) {
      if (!listed.some((existing) => sameItem(existing, item))) {
        listed.push(item);
      }
    }
    result.set(key, listed);
  }
  // Two server items in one scope would leave doctor no single path to check, so such a file is refused.
  for (const items of result.values()) {
    if (items.filter((item) => item.kind === "server").length > 1) {
      throw new Error("A scope holds at most one server item.");
    }
  }
  return result;
};

// The scopes of an agent, or undefined when there is no state file. A file that is not JSON, or has the wrong shape, is
// refused. The refusal comes before any write, so a refused file is never changed.
const loadState = async (file: string): Promise<Map<string, Item[]> | undefined> => {
  const contents = await readIfExists(file);
  if (contents === undefined) {
    return undefined;
  }
  let data: unknown;
  try {
    data = JSON.parse(contents);
  } catch {
    throw refused(file, "not valid JSON");
  }
  try {
    return checkState(data);
  } catch {
    throw refused(file, "unexpected contents");
  }
};

// Writes every scope to a temporary file with a unique name in the same folder, syncs it, then renames it over the state
// file. A rename that is refused for a moment is tried again by the helper that the accounts file uses. A failed write
// removes its temporary file, and the state file keeps its earlier bytes.
const writeState = async (file: string, scopes: Map<string, Item[]>): Promise<void> => {
  const text = `${JSON.stringify({ version: VERSION, scopes: Object.fromEntries(scopes) }, null, 2)}\n`;
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(text, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
};

// A lock file that cannot be removed is reported on stderr, one line, as the command runner reports it. Stdout is not
// used, because it carries the protocol in serve mode.
const reportLockProblem = (text: string): void => {
  process.stderr.write(`${text}\n`);
};

// Keeps an item in a scope. The change runs under the state file's own lock, `<state file>.lock`, which withRegistryLock
// takes. The accounts file has its own lock, and the two share no data. Inside the lock the state is read again, so two calls
// at the same time both survive. An item that is already listed is not listed again, and then nothing is written. A server
// item replaces the server item that the scope holds, if there is one, so the scope keeps one path.
export const record = async (
  agent: AgentId,
  key: string,
  item: Item,
  dataDir?: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> => {
  const entry = toItem(item);
  assertScopeKey(key);
  const file = statePath(agent, dataDir, env);
  await withRegistryLock(
    file,
    async () => {
      const scopes = (await loadState(file)) ?? new Map<string, Item[]>();
      const current = scopes.get(key) ?? [];
      if (current.some((existing) => sameItem(existing, entry))) {
        return;
      }
      const items = entry.kind === "server" ? current.filter((existing) => existing.kind !== "server") : [...current];
      items.push(entry);
      scopes.set(key, items);
      await writeState(file, scopes);
    },
    { onReleaseFailure: reportLockProblem },
  );
};

// The items recorded in a scope, in the order they were recorded. A scope with nothing recorded gives an empty list. A
// read takes no lock: the file is replaced by a rename, so a read sees the old file or the new one.
export const recordedItems = async (
  agent: AgentId,
  key: string,
  dataDir?: string,
  env?: NodeJS.ProcessEnv,
): Promise<Item[]> => {
  assertScopeKey(key);
  const scopes = await loadState(statePath(agent, dataDir, env));
  return [...(scopes?.get(key) ?? [])];
};

// The keys of the scopes that hold at least one item, in the order the state file lists them. The keys are the ones that
// scopeKey writes. A read takes no lock, as recordedItems does.
export const recordedScopeKeys = async (
  agent: AgentId,
  dataDir?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string[]> => {
  const scopes = await loadState(statePath(agent, dataDir, env));
  return [...(scopes ?? new Map<string, Item[]>()).entries()]
    .filter(([, items]) => items.length > 0)
    .map(([key]) => key);
};

// Removes one scope and leaves the other scopes as they are. A scope that is not recorded changes nothing. The state file
// is removed when this call removes the last scope. The change runs under the same state lock as record.
export const forget = async (
  agent: AgentId,
  key: string,
  dataDir?: string,
  env?: NodeJS.ProcessEnv,
): Promise<void> => {
  assertScopeKey(key);
  const file = statePath(agent, dataDir, env);
  // Without a state file there is nothing to forget, so the call returns before the lock. The lock creates the state
  // folder, and forget must not create it.
  if ((await readIfExists(file)) === undefined) {
    return;
  }
  await withRegistryLock(
    file,
    async () => {
      const scopes = await loadState(file);
      // A scope that is not recorded is not removed, so the file is not rewritten. A file that holds no scope at all falls
      // under this rule too.
      if (scopes === undefined || !scopes.delete(key)) {
        return;
      }
      // The scope removed was the last one, so the state file goes.
      if (scopes.size === 0) {
        await rm(file, { force: true });
        return;
      }
      await writeState(file, scopes);
    },
    { onReleaseFailure: reportLockProblem },
  );
};
