import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withRegistryLock } from "../accounts/lock.js";
import { renameWithRetry } from "../accounts/registry.js";
import { dataFolder } from "../paths.js";

export type AgentId = "claude" | "codex" | "opencode" | "antigravity";

// One thing the installer wrote, which uninstall may remove. Each kind names exactly what to remove.
export type Item =
  | { kind: "mcp-entry"; name: string }
  | { kind: "toml-table"; path: string; table: string }
  | { kind: "json-entry"; path: string; pointer: string }
  | { kind: "directory"; path: string }
  | { kind: "file"; path: string; createdByUs: true };

// The only version this code reads and writes. A file with another version is refused.
const VERSION = 1;

const PROJECT_PREFIX = "project:";
const LOCAL_PREFIX = "local:";

// The key of a scope in the state file: "global", "project:" followed by the absolute folder, or "local:" followed by the
// absolute folder. A project scope and a local scope in the same folder have different keys.
export const scopeKey = (scope: "global" | "project" | "local", projectDir: string): string => {
  if (scope === "global") {
    return "global";
  }
  const prefix = scope === "project" ? PROJECT_PREFIX : LOCAL_PREFIX;
  return `${prefix}${path.resolve(projectDir)}`;
};

// A key is "global", or one of the two prefixes followed by an absolute folder.
const isScopeKey = (key: string): boolean =>
  key === "global" ||
  [PROJECT_PREFIX, LOCAL_PREFIX].some((prefix) => key.startsWith(prefix) && path.isAbsolute(key.slice(prefix.length)));

// The state file of an agent, in the state folder of the data folder. A folder given by the caller is used instead.
// An empty folder name counts as not given, as it does for the data folder variable.
export const statePath = (agent: AgentId, dataDir?: string): string =>
  path.join(dataDir || dataFolder(process.env, process.platform, os.homedir()), "state", `${agent}.json`);

// The text of a file, or undefined when there is no such file. Any other read error is thrown as it is. Its message
// holds the file's path and a system code, never the text.
export const readIfExists = async (file: string): Promise<string | undefined> => {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
    if (code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
};

const nonEmptyText = (value: unknown): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("A recorded field must be a non-empty string.");
  }
  return value;
};

// A path is kept only as an absolute path, so uninstall cannot act on a file that depends on the working folder.
const absolutePath = (value: unknown): string => {
  const file = nonEmptyText(value);
  if (!path.isAbsolute(file)) {
    throw new Error("A recorded path must be absolute.");
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
    default:
      throw new Error("A recorded item has an unknown kind.");
  }
};

// Checks the whole parsed file. Each key must be a valid scope key, and each scope must hold a list of valid items.
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
  for (const [key, items] of Object.entries(scopes)) {
    if (!isScopeKey(key)) {
      throw new Error("A scope key is neither global nor a project or local folder.");
    }
    if (!Array.isArray(items)) {
      throw new Error("A scope must hold a list of items.");
    }
    result.set(key, items.map((item) => toItem(item)));
  }
  return result;
};

// The one message for a state file that cannot be used. The reason is a fixed phrase. The file's text never reaches the
// message, and no cause is kept, because a parser error can quote the text.
const refused = (file: string, reason: string): Error =>
  new Error(`The agent state file cannot be read, so nothing was changed: ${file} (${reason})`);

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

// Writes every scope to a temporary file with a unique name in the same folder, syncs it, then renames it over the
// state file. A rename that is refused for a moment is tried again by the helper that the accounts file uses. A failed
// write removes its temporary file, and the state file keeps its earlier bytes.
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

// Keeps an item in a scope. The change runs under the lock that the accounts file uses, and the state is read again
// inside it, so two calls at the same time both survive. An item that is already listed is not listed again, and then
// nothing is written.
export const record = async (agent: AgentId, key: string, item: Item, dataDir?: string): Promise<void> => {
  const entry = toItem(item);
  if (!isScopeKey(key)) {
    throw new Error('A scope key must be "global", or "project:" or "local:" followed by an absolute folder path.');
  }
  const file = statePath(agent, dataDir);
  await withRegistryLock(
    file,
    async () => {
      const scopes = (await loadState(file)) ?? new Map<string, Item[]>();
      const items = scopes.get(key) ?? [];
      const wanted = JSON.stringify(entry);
      if (items.some((existing) => JSON.stringify(existing) === wanted)) {
        return;
      }
      items.push(entry);
      scopes.set(key, items);
      await writeState(file, scopes);
    },
    { onReleaseFailure: reportLockProblem },
  );
};

// The items recorded in a scope, in the order they were recorded. A scope with nothing recorded gives an empty list. A
// read takes no lock: the file is replaced by a rename, so a read sees the old file or the new one.
export const recordedItems = async (agent: AgentId, key: string, dataDir?: string): Promise<Item[]> => {
  const scopes = await loadState(statePath(agent, dataDir));
  return [...(scopes?.get(key) ?? [])];
};

// Removes one scope and leaves the other scopes as they are. A scope that is not recorded changes nothing. When no
// scope is left, the state file is removed. The change runs under the same lock as record.
export const forget = async (agent: AgentId, key: string, dataDir?: string): Promise<void> => {
  const file = statePath(agent, dataDir);
  // Without a state file there is nothing to forget, so the call returns before the lock. The lock creates the state
  // folder, and forget must not create it.
  if ((await readIfExists(file)) === undefined) {
    return;
  }
  await withRegistryLock(
    file,
    async () => {
      const scopes = await loadState(file);
      if (scopes === undefined || !scopes.delete(key)) {
        return;
      }
      if (scopes.size === 0) {
        await rm(file, { force: true });
        return;
      }
      await writeState(file, scopes);
    },
    { onReleaseFailure: reportLockProblem },
  );
};
