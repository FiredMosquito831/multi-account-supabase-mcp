import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveHooks } from "../accounts/registry.js";
import {
  type Item,
  forget,
  readIfExists,
  record,
  recordedItems,
  scopeKey,
  statePath,
} from "../agents/state.js";

const DATA_ENV = "MULTI_ACCOUNT_SUPABASE_HOME";

const entry: Item = { kind: "mcp-entry", name: "supabase" };

// An absolute path, for a valid record that needs a path but never reads the file it names.
const ABSOLUTE = path.resolve(os.tmpdir(), "state-test-item");

// Each test gets its own data folder under the system temp folder. The data folder variable points at it too, so a call
// that leaves out the folder still cannot reach the owner's real data folder. Both are restored and removed afterwards.
const inDataFolder = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "state-test-"));
  const previous = process.env[DATA_ENV];
  process.env[DATA_ENV] = dataDir;
  try {
    await run(dataDir);
  } finally {
    if (previous === undefined) {
      delete process.env[DATA_ENV];
    } else {
      process.env[DATA_ENV] = previous;
    }
    await rm(dataDir, { recursive: true, force: true });
  }
};

// Writes the claude state file, with its folder, holding the given text. The text stands for a file that was damaged or
// edited by hand.
const writeRawState = async (dataDir: string, text: string): Promise<string> => {
  const file = statePath("claude", dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
};

// The message for a state file that cannot be used. The reason is in parentheses.
const refusedMessage = (file: string, reason: string): string =>
  `The agent state file cannot be read, so nothing was changed: ${file} (${reason})`;

// The error that a promise rejects with. The test fails if the promise resolves.
const errorOf = async (promise: Promise<unknown>): Promise<NodeJS.ErrnoException> => {
  try {
    await promise;
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  throw new Error("The call was expected to fail, but it succeeded.");
};

// An error with a file-system code, as Node gives for a rename that is refused.
const codedError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: test error`), { code });

// Runs one step with the rename and the wait of the registry's save replaced by the fakes. The state file's write uses the
// same retry helper and the same seam. The real ones are put back afterwards, even when the step fails.
const withSaveHooks = async (fakes: Partial<typeof saveHooks>, run: () => Promise<void>): Promise<void> => {
  const real = { ...saveHooks };
  Object.assign(saveHooks, fakes);
  try {
    await run();
  } finally {
    Object.assign(saveHooks, real);
  }
};

test("statePath is the state folder of the data folder, named after the agent, with or without a folder given", () =>
  inDataFolder(async (dataDir) => {
    assert.equal(statePath("opencode", dataDir), path.join(dataDir, "state", "opencode.json"));
    // Without a folder, the data folder comes from the variable, which the helper points at the temporary folder.
    assert.equal(statePath("codex"), path.join(dataDir, "state", "codex.json"));
  }));

test("scopeKey is global for the global scope, and a project key holds the absolute folder", () => {
  const folder = path.resolve(os.tmpdir(), "some-project");
  assert.equal(scopeKey("global", folder), "global");
  assert.equal(scopeKey("project", folder), `project:${folder}`);
  // A relative folder is made absolute first, as path.resolve does.
  assert.equal(scopeKey("project", "relative-project"), `project:${path.resolve("relative-project")}`);
});

test("readIfExists gives undefined for a missing file, the text of a file, and a read error for a folder", () =>
  inDataFolder(async (dataDir) => {
    const file = path.join(dataDir, "note.txt");
    assert.equal(await readIfExists(file), undefined);
    await writeFile(file, "hello");
    assert.equal(await readIfExists(file), "hello");
    // A folder is not a missing file, so its read error is thrown and is not taken for "no file".
    assert.notEqual((await errorOf(readIfExists(dataDir))).code, "ENOENT");
  }));

test("record, then recordedItems, returns the item", () =>
  inDataFolder(async (dataDir) => {
    const key = scopeKey("project", path.join(dataDir, "project"));
    await record("claude", key, entry, dataDir);
    assert.deepEqual(await recordedItems("claude", key, dataDir), [entry]);
  }));

test("recording the same item twice lists it once, even when its keys are written in another order", () =>
  inDataFolder(async (dataDir) => {
    await record("claude", "global", entry, dataDir);
    await record("claude", "global", { name: "supabase", kind: "mcp-entry" }, dataDir);
    assert.deepEqual(await recordedItems("claude", "global", dataDir), [entry]);
  }));

test("forget removes only its scope, and another scope of the same agent stays exactly as it was", () =>
  inDataFolder(async (dataDir) => {
    const projectDir = path.join(dataDir, "project");
    const projectKey = scopeKey("project", projectDir);
    const projectItem: Item = { kind: "directory", path: path.join(projectDir, ".codex") };
    await record("claude", "global", entry, dataDir);
    await record("claude", projectKey, projectItem, dataDir);
    await forget("claude", projectKey, dataDir);
    assert.deepEqual(await recordedItems("claude", projectKey, dataDir), []);
    assert.deepEqual(await recordedItems("claude", "global", dataDir), [entry]);
    assert.deepEqual(JSON.parse(await readFile(statePath("claude", dataDir), "utf8")), {
      version: 1,
      scopes: { global: [entry] },
    });
  }));

test('a state file that holds "sbp_TESTVALUE" and is not JSON is refused, names the file and the reason, and is not changed', () =>
  inDataFolder(async (dataDir) => {
    const file = await writeRawState(dataDir, "sbp_TESTVALUE");
    const before = await readFile(file);
    // Reading, recording and forgetting all refuse the file. Each attempt is a function, so none starts before its check.
    const attempts = [
      () => recordedItems("claude", "global", dataDir),
      () => record("claude", "global", entry, dataDir),
      () => forget("claude", "global", dataDir),
    ];
    for (const attempt of attempts) {
      await assert.rejects(attempt(), (error: unknown) => {
        const message = (error as Error).message;
        assert.equal(message.includes(file), true);
        assert.equal(message.includes("not valid JSON"), true);
        assert.equal(message.includes("sbp_"), false);
        // The parser's own error can quote the text, so the refusal keeps no cause.
        assert.equal((error as Error).cause, undefined);
        return true;
      });
    }
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(path.dirname(file)), ["claude.json"]);
  }));

// Each case is valid JSON whose shape the state file does not allow.
const wrongShapes: [string, unknown][] = [
  ["a version other than 1", { version: 2, scopes: {} }],
  ["no scopes", { version: 1 }],
  ["scopes that is an array", { version: 1, scopes: [] }],
  ["an item of an unknown kind", { version: 1, scopes: { global: [{ kind: "registry", name: "supabase" }] } }],
  [
    "an item with an extra field",
    { version: 1, scopes: { global: [{ kind: "mcp-entry", name: "supabase", extra: 1 }] } },
  ],
  [
    "a file item that is not marked as created by the tool",
    { version: 1, scopes: { global: [{ kind: "file", path: ABSOLUTE, createdByUs: false }] } },
  ],
  [
    "a directory with a relative path",
    { version: 1, scopes: { global: [{ kind: "directory", path: "relative/dir" }] } },
  ],
  [
    "a JSON pointer without a leading slash",
    { version: 1, scopes: { global: [{ kind: "json-entry", path: ABSOLUTE, pointer: "mcpServers/supabase" }] } },
  ],
  ["a scope key that is neither global nor a project folder", { version: 1, scopes: { "project:relative": [] } }],
];

for (const [label, value] of wrongShapes) {
  test(`a state file with ${label} is refused as unexpected contents, and its bytes do not change`, () =>
    inDataFolder(async (dataDir) => {
      const file = await writeRawState(dataDir, JSON.stringify(value));
      const before = await readFile(file);
      const message = refusedMessage(file, "unexpected contents");
      await assert.rejects(recordedItems("claude", "global", dataDir), { message });
      await assert.rejects(record("claude", "global", entry, dataDir), { message });
      assert.deepEqual(await readFile(file), before);
    }));
}

test("a write leaves no temporary file in the state folder", () =>
  inDataFolder(async (dataDir) => {
    await record("claude", "global", entry, dataDir);
    await record("claude", "global", { kind: "mcp-entry", name: "other" }, dataDir);
    assert.deepEqual(await readdir(path.dirname(statePath("claude", dataDir))), ["claude.json"]);
  }));

test("forget of the last scope removes the state file", () =>
  inDataFolder(async (dataDir) => {
    await record("claude", "global", entry, dataDir);
    await forget("claude", "global", dataDir);
    await assert.rejects(stat(statePath("claude", dataDir)), { code: "ENOENT" });
    assert.deepEqual(await recordedItems("claude", "global", dataDir), []);
  }));

test("record refuses an item with a relative path, or a scope key that is not valid, and writes nothing", () =>
  inDataFolder(async (dataDir) => {
    await assert.rejects(record("claude", "global", { kind: "directory", path: "relative/dir" }, dataDir), {
      message: "A recorded path must be absolute.",
    });
    await assert.rejects(record("claude", "project:relative", entry, dataDir), {
      message: 'A scope key must be "global", or "project:" followed by an absolute folder path.',
    });
    await assert.rejects(stat(statePath("claude", dataDir)), { code: "ENOENT" });
  }));

test("a write whose rename fails removes its temporary file, and the state file keeps its earlier bytes", () =>
  inDataFolder(async (dataDir) => {
    await record("claude", "global", entry, dataDir);
    const file = statePath("claude", dataDir);
    const before = await readFile(file);
    // EIO is not a refused rename, so the retry helper throws it at once.
    const failure = codedError("EIO");
    const other: Item = { kind: "mcp-entry", name: "other" };
    await withSaveHooks(
      {
        rename: async () => {
          throw failure;
        },
      },
      async () => {
        assert.equal(await errorOf(record("claude", "global", other, dataDir)), failure);
      },
    );
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(path.dirname(file)), ["claude.json"]);
  }));

test("two record calls at the same time both survive, so no update is lost", () =>
  inDataFolder(async (dataDir) => {
    const first: Item = { kind: "mcp-entry", name: "one" };
    const second: Item = { kind: "mcp-entry", name: "two" };
    await Promise.all([record("claude", "global", first, dataDir), record("claude", "global", second, dataDir)]);
    const recorded = (await recordedItems("claude", "global", dataDir)).map((item) => JSON.stringify(item));
    assert.deepEqual(recorded.sort(), [JSON.stringify(first), JSON.stringify(second)].sort());
  }));

test("a rename refused twice with EPERM and then accepted saves the state and leaves no temporary file", () =>
  inDataFolder(async (dataDir) => {
    await record("claude", "global", entry, dataDir);
    const file = statePath("claude", dataDir);
    const realRename = saveHooks.rename;
    const other: Item = { kind: "mcp-entry", name: "other" };
    let renames = 0;
    const waits: number[] = [];
    await withSaveHooks(
      {
        rename: async (from, to) => {
          renames += 1;
          if (renames <= 2) {
            throw codedError("EPERM");
          }
          await realRename(from, to);
        },
        wait: async (ms) => {
          waits.push(ms);
        },
      },
      () => record("claude", "global", other, dataDir),
    );
    assert.equal(renames, 3);
    assert.deepEqual(waits, [100, 100]);
    assert.deepEqual(await recordedItems("claude", "global", dataDir), [entry, other]);
    assert.deepEqual(await readdir(path.dirname(file)), ["claude.json"]);
  }));

test("a rename refused every time is tried ten times, then the write raises that error, keeps the old bytes, and leaves no temporary file", () =>
  inDataFolder(async (dataDir) => {
    await record("claude", "global", entry, dataDir);
    const file = statePath("claude", dataDir);
    const before = await readFile(file);
    const busy = codedError("EBUSY");
    const other: Item = { kind: "mcp-entry", name: "other" };
    let renames = 0;
    const waits: number[] = [];
    await withSaveHooks(
      {
        rename: async () => {
          renames += 1;
          throw busy;
        },
        wait: async (ms) => {
          waits.push(ms);
        },
      },
      async () => {
        assert.equal(await errorOf(record("claude", "global", other, dataDir)), busy);
      },
    );
    assert.equal(renames, 10);
    assert.deepEqual(waits, Array.from({ length: 9 }, () => 100));
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(path.dirname(file)), ["claude.json"]);
  }));
