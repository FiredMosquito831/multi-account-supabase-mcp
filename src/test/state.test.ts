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
  recordedScopeKeys,
  scopeKey,
  statePath,
} from "../agents/state.js";

const DATA_ENV = "MULTI_ACCOUNT_SUPABASE_HOME";
// Every name that points a test at a home, configuration or data folder. Each test points all of them into its own folder.
const FOLDER_NAMES = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEX_HOME", "XDG_CONFIG_HOME", DATA_ENV];

const entry: Item = { kind: "mcp-entry", name: "supabase" };

// An absolute path, for a valid record that needs a path but never reads the file it names.
const ABSOLUTE = path.resolve(os.tmpdir(), "state-test-item");
// A second absolute path, for a server item that replaces the first one.
const OTHER_ABSOLUTE = path.resolve(os.tmpdir(), "state-test-other-item");

// The message for a scope key that is not the form scopeKey writes for its folder.
const SCOPE_KEY_MESSAGE =
  'A scope key must be "global", or "project:" or "local:" followed by a folder in the form scopeKey writes.';

// A folder with its letters as given, and the key that scopeKey writes for it. The expected key is written out for each
// system, so the tests state the form instead of calling the code under test. On Windows the letters of the key are lower case.
const SAMPLE_FOLDER = process.platform === "win32" ? "C:\\Some\\Project" : "/some/project";
const SAMPLE_KEY_FOLDER = process.platform === "win32" ? "c:\\some\\project" : "/some/project";

// A rooted path with no drive depends on the current drive, and only Windows reads a path that way. On other systems the
// same path is not absolute anyway, so a test of that rule means nothing there. Those tests run on Windows only.
const WINDOWS_ONLY: string | false =
  process.platform === "win32" ? false : "a rooted path with no drive is refused only on Windows";

// Each test gets its own data folder under the system temp folder. Every name in FOLDER_NAMES points into it, so a call that
// leaves out the folder still cannot reach the owner's real files. The data folder variable is the folder itself, which the
// tests that leave out the folder rely on. The names are restored, and the folder is removed, afterwards.
const inDataFolder = async (run: (dataDir: string) => Promise<void>): Promise<void> => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "state-test-"));
  const previous = FOLDER_NAMES.map((name): [string, string | undefined] => [name, process.env[name]]);
  for (const name of FOLDER_NAMES) {
    process.env[name] = name === DATA_ENV ? dataDir : path.join(dataDir, name.toLowerCase());
  }
  try {
    await run(dataDir);
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
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

// Keys that are not the form scopeKey writes for their folder: a trailing separator, a dot-dot segment, and a folder that is
// not absolute. Each form is tried with each scope prefix, so the local scope is held to the same rule as the project scope.
const badKeys = (): [string, string][] => {
  const folder = SAMPLE_KEY_FOLDER;
  const parent = path.dirname(folder);
  const name = path.basename(folder);
  const forms: [string, string][] = [
    ["a trailing separator", `${folder}${path.sep}`],
    ["a dot-dot segment", `${parent}${path.sep}${name}${path.sep}..${path.sep}${name}`],
    ["a folder that is not absolute", "state-test-key"],
  ];
  return ["project:", "local:"].flatMap((prefix) =>
    forms.map(([label, folderPart]): [string, string] => [`${label} after ${prefix}`, `${prefix}${folderPart}`]),
  );
};

test("each test points the home, configuration and data names into its own temporary folder", () =>
  inDataFolder(async (dataDir) => {
    for (const name of FOLDER_NAMES) {
      assert.equal(path.resolve(process.env[name] ?? "").startsWith(path.resolve(dataDir)), true, name);
    }
  }));

test("statePath is the state folder of the data folder, named after the agent, with or without a folder given", () =>
  inDataFolder(async (dataDir) => {
    assert.equal(statePath("opencode", dataDir), path.join(dataDir, "state", "opencode.json"));
    // Without a folder, the data folder comes from the variable, which the helper points at the temporary folder.
    assert.equal(statePath("codex"), path.join(dataDir, "state", "codex.json"));
  }));

test("statePath uses the folder it is given, even when the data folder variable names another one", () =>
  inDataFolder(async (dataDir) => {
    const other = path.join(dataDir, "elsewhere");
    assert.equal(statePath("codex", other), path.join(other, "state", "codex.json"));
    assert.equal(statePath("codex"), path.join(dataDir, "state", "codex.json"));
  }));

test("scopeKey is global for the global scope, and a project key holds the folder in the form scopeKey writes", () =>
  inDataFolder(async () => {
    // Every name must point into a temporary folder, so this test is isolated like the others.
    for (const name of FOLDER_NAMES) {
      assert.equal(path.resolve(process.env[name] ?? "").startsWith(path.resolve(os.tmpdir())), true, name);
    }
    assert.equal(scopeKey("global", SAMPLE_FOLDER), "global");
    assert.equal(scopeKey("project", SAMPLE_FOLDER), `project:${SAMPLE_KEY_FOLDER}`);
    // A relative folder gives the key of the folder it names, resolved against the working folder.
    assert.equal(scopeKey("project", "relative-project"), scopeKey("project", path.resolve("relative-project")));
  }));

test("scopeKey for the local scope is local: and the folder, and its record is kept apart from the project record", () =>
  inDataFolder(async (dataDir) => {
    const localKey = scopeKey("local", SAMPLE_FOLDER);
    assert.equal(localKey, `local:${SAMPLE_KEY_FOLDER}`);
    assert.notEqual(localKey, scopeKey("project", SAMPLE_FOLDER));
    const localItem: Item = { kind: "mcp-entry", name: "local-plugin" };
    await record("claude", scopeKey("project", SAMPLE_FOLDER), entry, dataDir);
    await record("claude", localKey, localItem, dataDir);
    assert.deepEqual(await recordedItems("claude", localKey, dataDir), [localItem]);
    await forget("claude", localKey, dataDir);
    assert.deepEqual(await recordedItems("claude", localKey, dataDir), []);
    assert.deepEqual(await recordedItems("claude", scopeKey("project", SAMPLE_FOLDER), dataDir), [entry]);
  }));

test("a marketplace item is recorded and read back under its scope, and a marketplace item with an empty name is refused", () =>
  inDataFolder(async (dataDir) => {
    const marketplace: Item = { kind: "marketplace", name: "multi-account-supabase-mcp" };
    await record("claude", "global", marketplace, dataDir);
    assert.deepEqual(await recordedItems("claude", "global", dataDir), [marketplace]);
    await assert.rejects(record("claude", "global", { kind: "marketplace", name: "" }, dataDir), {
      message: "A recorded field must be a non-empty string.",
    });
  }));

test("a server item with an absolute command line path is recorded and read back under its scope", () =>
  inDataFolder(async (dataDir) => {
    const server: Item = { kind: "server", cliPath: ABSOLUTE };
    await record("claude", "global", server, dataDir);
    assert.deepEqual(await recordedItems("claude", "global", dataDir), [server]);
  }));

test("a server item with a relative command line path is refused, and writes nothing", () =>
  inDataFolder(async (dataDir) => {
    await assert.rejects(record("claude", "global", { kind: "server", cliPath: "relative/cli.js" }, dataDir), {
      message: "A recorded path must be absolute.",
    });
    await assert.rejects(stat(statePath("claude", dataDir)), { code: "ENOENT" });
  }));

test("a server item with a field besides its path is refused, and writes nothing", () =>
  inDataFolder(async (dataDir) => {
    const withExtra = { kind: "server", cliPath: ABSOLUTE, extra: 1 } as unknown as Item;
    await assert.rejects(record("claude", "global", withExtra, dataDir), {
      message: "A recorded item has a field that its kind does not allow, or lacks one.",
    });
    await assert.rejects(stat(statePath("claude", dataDir)), { code: "ENOENT" });
  }));

test("a scope holds one server item: recording another replaces it, and recording the same one again leaves one", () =>
  inDataFolder(async (dataDir) => {
    const first: Item = { kind: "server", cliPath: ABSOLUTE };
    const second: Item = { kind: "server", cliPath: OTHER_ABSOLUTE };
    await record("claude", "global", entry, dataDir);
    await record("claude", "global", first, dataDir);
    await record("claude", "global", second, dataDir);
    assert.deepEqual(await recordedItems("claude", "global", dataDir), [entry, second]);
    await record("claude", "global", second, dataDir);
    assert.deepEqual(await recordedItems("claude", "global", dataDir), [entry, second]);
  }));

test("recordedScopeKeys lists the scopes that hold an item, and none before anything is recorded", () =>
  inDataFolder(async (dataDir) => {
    const projectKey = scopeKey("project", path.join(dataDir, "project"));
    assert.deepEqual(await recordedScopeKeys("claude", dataDir), []);
    await record("claude", "global", entry, dataDir);
    await record("claude", projectKey, entry, dataDir);
    assert.deepEqual(await recordedScopeKeys("claude", dataDir), ["global", projectKey]);
  }));

test("one folder has one key: on Windows another letter case of the folder is refused, and elsewhere it is another folder", () =>
  inDataFolder(async (dataDir) => {
    const folder = path.join(dataDir, "Project");
    const otherCase = `project:${folder.toUpperCase()}`;
    if (process.platform === "win32") {
      assert.equal(scopeKey("project", folder.toUpperCase()), scopeKey("project", folder));
      await assert.rejects(record("claude", otherCase, entry, dataDir), { message: SCOPE_KEY_MESSAGE });
    } else {
      // Letter case is part of a name on these systems, so the other case is another folder with its own key.
      await record("claude", otherCase, entry, dataDir);
      assert.deepEqual(await recordedItems("claude", otherCase, dataDir), [entry]);
      assert.deepEqual(await recordedItems("claude", scopeKey("project", folder), dataDir), []);
    }
  }));

for (const [label, key] of badKeys()) {
  test(`a scope key with ${label} is refused by record, recordedItems and forget, and by a state file that holds it`, () =>
    inDataFolder(async (dataDir) => {
      await assert.rejects(record("claude", key, entry, dataDir), { message: SCOPE_KEY_MESSAGE });
      await assert.rejects(recordedItems("claude", key, dataDir), { message: SCOPE_KEY_MESSAGE });
      await assert.rejects(forget("claude", key, dataDir), { message: SCOPE_KEY_MESSAGE });
      await assert.rejects(stat(statePath("claude", dataDir)), { code: "ENOENT" });
      const file = await writeRawState(dataDir, JSON.stringify({ version: 1, scopes: { [key]: [entry] } }));
      await assert.rejects(recordedItems("claude", "global", dataDir), {
        message: refusedMessage(file, "unexpected contents"),
      });
    }));
}

test("readIfExists gives undefined for a missing file, the text of a file, and a refusal with the error code for a folder", () =>
  inDataFolder(async (dataDir) => {
    const file = path.join(dataDir, "note.txt");
    assert.equal(await readIfExists(file), undefined);
    await writeFile(file, "hello");
    assert.equal(await readIfExists(file), "hello");
    // The refusal names the file and the error code. The system's own message is not passed on.
    const raw = await errorOf(readFile(dataDir, "utf8"));
    const error = await errorOf(readIfExists(dataDir));
    assert.equal(error.message, refusedMessage(dataDir, raw.code ?? "read failed"));
    assert.equal(error.message.includes(raw.message), false);
  }));

test("a state path that is a folder is refused by name and error code, and the folder is left as it is", () =>
  inDataFolder(async (dataDir) => {
    const file = statePath("claude", dataDir);
    await mkdir(file, { recursive: true });
    const raw = await errorOf(readFile(file, "utf8"));
    const message = refusedMessage(file, raw.code ?? "read failed");
    await assert.rejects(recordedItems("claude", "global", dataDir), { message });
    await assert.rejects(record("claude", "global", entry, dataDir), { message });
    assert.equal((await stat(file)).isDirectory(), true);
    assert.equal(message.includes(raw.message), false);
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

test("forget with no state file leaves no state folder behind", () =>
  inDataFolder(async (dataDir) => {
    await forget("claude", "global", dataDir);
    await assert.rejects(stat(path.join(dataDir, "state")), { code: "ENOENT" });
  }));

test("forget of a key that is not recorded does not rewrite the state file", () =>
  inDataFolder(async (dataDir) => {
    // The file is written by hand in a form the code would not write, so a rewrite would change its bytes.
    const text = JSON.stringify({ version: 1, scopes: { global: [entry] } });
    const file = await writeRawState(dataDir, text);
    await forget("claude", scopeKey("project", path.join(dataDir, "project")), dataDir);
    assert.equal(await readFile(file, "utf8"), text);
  }));

test("forget leaves a state file that holds no scope alone, because it removes no scope", () =>
  inDataFolder(async (dataDir) => {
    const text = '{"version":1,"scopes":{}}';
    const file = await writeRawState(dataDir, text);
    await forget("claude", "global", dataDir);
    assert.equal(await readFile(file, "utf8"), text);
  }));

test('a state file that holds "sbp_TESTVALUE" and is not JSON is refused by name and reason, and is not changed', () =>
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
  ["scopes that is null", { version: 1, scopes: null }],
  ["an extra key at the top level", { version: 1, scopes: {}, extra: 1 }],
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
  [
    "a json-entry item with an empty pointer",
    { version: 1, scopes: { global: [{ kind: "json-entry", path: ABSOLUTE, pointer: "" }] } },
  ],
  [
    "a toml-table item with an empty table name",
    { version: 1, scopes: { global: [{ kind: "toml-table", path: ABSOLUTE, table: "" }] } },
  ],
  [
    "a marketplace item with a field besides its name",
    { version: 1, scopes: { global: [{ kind: "marketplace", name: "supabase", path: ABSOLUTE }] } },
  ],
  ["a marketplace item with an empty name", { version: 1, scopes: { global: [{ kind: "marketplace", name: "" }] } }],
  ["a scope key that is neither global nor a project folder", { version: 1, scopes: { "project:relative": [] } }],
  [
    "a server item with a relative path",
    { version: 1, scopes: { global: [{ kind: "server", cliPath: "relative/cli.js" }] } },
  ],
  [
    "a server item with a field besides its path",
    { version: 1, scopes: { global: [{ kind: "server", cliPath: ABSOLUTE, extra: 1 }] } },
  ],
  [
    "a scope that holds two server items",
    {
      version: 1,
      scopes: { global: [{ kind: "server", cliPath: ABSOLUTE }, { kind: "server", cliPath: OTHER_ABSOLUTE }] },
    },
  ],
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
    await assert.rejects(record("claude", "project:relative", entry, dataDir), { message: SCOPE_KEY_MESSAGE });
    await assert.rejects(stat(statePath("claude", dataDir)), { code: "ENOENT" });
  }));

test(
  "a rooted path with no drive, such as \\foo\\bar, is refused as a recorded path and writes nothing",
  { skip: WINDOWS_ONLY },
  () =>
    inDataFolder(async (dataDir) => {
      await assert.rejects(record("claude", "global", { kind: "directory", path: "\\foo\\bar" }, dataDir), {
        message: "A recorded path must be absolute.",
      });
      await assert.rejects(stat(statePath("claude", dataDir)), { code: "ENOENT" });
    }),
);

test("a recorded path is written as path.resolve writes it: a dot segment or a trailing separator is refused", () =>
  inDataFolder(async (dataDir) => {
    const message =
      "A recorded path must be written as path.resolve writes it: no dot segments, no trailing separator.";
    const withDotDot = `${dataDir}${path.sep}a${path.sep}..${path.sep}b`;
    await assert.rejects(record("claude", "global", { kind: "directory", path: withDotDot }, dataDir), { message });
    await assert.rejects(record("claude", "global", { kind: "directory", path: `${dataDir}${path.sep}` }, dataDir), {
      message,
    });
    await assert.rejects(stat(statePath("claude", dataDir)), { code: "ENOENT" });
  }));

test("a scope that lists the same item twice reads as one item", () =>
  inDataFolder(async (dataDir) => {
    await writeRawState(dataDir, JSON.stringify({ version: 1, scopes: { global: [entry, entry] } }));
    assert.deepEqual(await recordedItems("claude", "global", dataDir), [entry]);
  }));

// A key written by an earlier version of this code kept the letters of its folder as given. On Windows it names the same
// folder as the key scopeKey writes now, so it is read as that key. Each scope prefix is tested in the same way.
for (const scope of ["project", "local"] as const) {
  test(
    `on Windows, a ${scope} key written with the folder's letters as given is read as the key scopeKey writes now`,
    { skip: WINDOWS_ONLY },
    () =>
      inDataFolder(async (dataDir) => {
        const earlier = `${scope}:${SAMPLE_FOLDER}`;
        const current = scopeKey(scope, SAMPLE_FOLDER);
        const other: Item = { kind: "directory", path: path.join(SAMPLE_FOLDER, ".codex") };
        const later: Item = { kind: "mcp-entry", name: "later" };
        // Both keys name one folder, so their items are read together, and the next write keeps them under the current key.
        await writeRawState(dataDir, JSON.stringify({ version: 1, scopes: { [earlier]: [entry], [current]: [other] } }));
        assert.deepEqual(await recordedItems("claude", current, dataDir), [entry, other]);
        await record("claude", current, later, dataDir);
        assert.deepEqual(JSON.parse(await readFile(statePath("claude", dataDir), "utf8")), {
          version: 1,
          scopes: { [current]: [entry, other, later] },
        });
      }),
  );

  test(
    `on Windows, an item listed under both the earlier ${scope} key and the current key is read once`,
    { skip: WINDOWS_ONLY },
    () =>
      inDataFolder(async (dataDir) => {
        const earlier = `${scope}:${SAMPLE_FOLDER}`;
        const current = scopeKey(scope, SAMPLE_FOLDER);
        const other: Item = { kind: "directory", path: path.join(SAMPLE_FOLDER, ".codex") };
        await writeRawState(
          dataDir,
          JSON.stringify({ version: 1, scopes: { [earlier]: [entry, other], [current]: [other] } }),
        );
        assert.deepEqual(await recordedItems("claude", current, dataDir), [entry, other]);
      }),
  );
}

test("a rename that fails with EIO removes its temporary file, and the state file keeps its earlier bytes", () =>
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

test("a rename refused every time is tried ten times, then the write fails with that error and keeps the old bytes", () =>
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
