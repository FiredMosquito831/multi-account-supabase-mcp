import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AccountRecord, Registry, saveHooks } from "../accounts/registry.js";

const ADDED_AT = "2026-10-20T09:00:00.000Z";

// Each test gets its own folder under the system temp folder, and removes it afterwards.
// No test reads or writes the owner's data folder.
const inTempFolder = async (run: (folder: string) => Promise<void>): Promise<void> => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  try {
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

const record = (name: string, gotrueId = `gotrue-${name}`): AccountRecord => ({
  name,
  email: `${name}@example.com`,
  gotrueId,
  added: "pat",
  addedAt: ADDED_AT,
});

// The one message for a file that cannot be read or has the wrong shape. The reason is in parentheses.
const corruptMessage = (file: string, reason: string): string =>
  `accounts.json cannot be read, so it was not changed: ${file} (${reason})`;

test("the first add makes that account the default, and a second add keeps it", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work"));
    assert.equal(registry.defaultName(), "work");
    registry.add(record("play"));
    assert.equal(registry.defaultName(), "work");
  }));

test("removing the default leaves no default", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work"));
    registry.add(record("play"));
    assert.deepEqual(registry.remove("work"), record("work"));
    assert.equal(registry.defaultName(), null);
  }));

test("removing another account keeps the default, and an unknown name removes nothing", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work"));
    registry.add(record("play"));
    assert.deepEqual(registry.remove("play"), record("play"));
    assert.equal(registry.defaultName(), "work");
    assert.equal(registry.remove("nobody"), undefined);
    assert.deepEqual(registry.names(), ["work"]);
  }));

test("with no default, a later add does not set one, and the no-default state is saved", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const registry = await Registry.load(file);
    registry.add(record("work"));
    registry.add(record("play"));
    registry.remove("work");
    registry.add(record("office"));
    assert.equal(registry.defaultName(), null);
    await registry.save();
    const loaded = await Registry.load(file);
    assert.equal(loaded.defaultName(), null);
    assert.deepEqual(loaded.names(), ["play", "office"]);
    loaded.setDefault("office");
    assert.equal(loaded.defaultName(), "office");
  }));

test("an empty registry makes its next add the default", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work"));
    registry.remove("work");
    registry.add(record("play"));
    assert.equal(registry.defaultName(), "play");
  }));

test("a removed account frees its name and its Supabase user", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work", "gotrue-1"));
    registry.remove("work");
    registry.add(record("play", "gotrue-1"));
    assert.deepEqual(registry.names(), ["play"]);
  }));

test('add refuses a taken name with the "already exists" message', () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work", "gotrue-1"));
    assert.throws(() => registry.add(record("work", "gotrue-2")), {
      message: 'An account named "work" already exists. Remove it first to replace it.',
    });
    assert.deepEqual(registry.list(), [record("work", "gotrue-1")]);
  }));

test("add refuses a Supabase user that is already added under another name", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work", "gotrue-1"));
    assert.throws(() => registry.add(record("play", "gotrue-1")), {
      message: 'This Supabase user is already added as "work".',
    });
    assert.deepEqual(registry.names(), ["work"]);
  }));

test('setDefault refuses an unknown name with the "No account named" message', () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work"));
    assert.throws(() => registry.setDefault("nobody"), { message: 'No account named "nobody".' });
    assert.equal(registry.defaultName(), "work");
  }));

test("add checks the name with the name rules, and refuses all", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    assert.throws(() => registry.add(record("all")), {
      message: '"all" is reserved. Pick another account name.',
    });
    assert.throws(() => registry.add(record("Work")), {
      message:
        'Invalid account name "Work". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.',
    });
    assert.deepEqual(registry.list(), []);
  }));

test("save, then load, gives the same records and the same default", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const registry = await Registry.load(file);
    registry.add(record("work"));
    registry.add(record("play"));
    registry.setDefault("play");
    await registry.save();
    const loaded = await Registry.load(file);
    assert.deepEqual(loaded.list(), registry.list());
    assert.equal(loaded.defaultName(), "play");
  }));

test("save leaves no temporary file behind", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work"));
    await registry.save();
    // Only the saved file is in the folder.
    assert.deepEqual(await readdir(folder), ["accounts.json"]);
  }));

// Each case has the reason that load gives for it: the text is not JSON, or the JSON has the wrong shape.
const corruptFiles: [string, string, string][] = [
  ["text that is not JSON", "{ not json", "not valid JSON"],
  ["an empty file", "", "not valid JSON"],
  ["JSON without an accounts array", '{"default": null}', "unexpected contents"],
  ["an accounts value that is not an array", '{"default": null, "accounts": {}}', "unexpected contents"],
  ["a top-level array", "[]", "unexpected contents"],
  ["a top-level null", "null", "unexpected contents"],
  ["no default key", JSON.stringify({ accounts: [record("work")] }), "unexpected contents"],
  [
    "a record without gotrueId",
    JSON.stringify({
      default: null,
      accounts: [{ name: "work", email: "work@example.com", added: "pat", addedAt: ADDED_AT }],
    }),
    "unexpected contents",
  ],
  [
    'a record whose added is not "pat"',
    JSON.stringify({ default: null, accounts: [{ ...record("work"), added: "oauth" }] }),
    "unexpected contents",
  ],
  [
    "a record with an empty email",
    JSON.stringify({ default: null, accounts: [{ ...record("work"), email: "" }] }),
    "unexpected contents",
  ],
  [
    "a record named all",
    JSON.stringify({ default: null, accounts: [record("all")] }),
    "unexpected contents",
  ],
  [
    "two accounts with one name",
    JSON.stringify({
      default: null,
      accounts: [record("work", "gotrue-1"), record("work", "gotrue-2")],
    }),
    "unexpected contents",
  ],
  [
    "two accounts for one Supabase user",
    JSON.stringify({
      default: null,
      accounts: [record("work", "gotrue-1"), record("play", "gotrue-1")],
    }),
    "unexpected contents",
  ],
  [
    "a default that names no account",
    JSON.stringify({ default: "ghost", accounts: [record("work")] }),
    "unexpected contents",
  ],
];

for (const [label, text, reason] of corruptFiles) {
  test(`load refuses ${label}, and leaves the file bytes unchanged`, () =>
    inTempFolder(async (folder) => {
      const file = path.join(folder, "accounts.json");
      await writeFile(file, text);
      const before = await readFile(file);
      await assert.rejects(Registry.load(file), { message: corruptMessage(file, reason) });
      assert.deepEqual(await readFile(file), before);
      assert.deepEqual(await readdir(folder), ["accounts.json"]);
    }));
}

test("a file that holds sbp_TESTVALUE and is not valid JSON is refused, and its message names the path and the reason, not the text", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    await writeFile(file, "sbp_TESTVALUE");
    await assert.rejects(Registry.load(file), (error: unknown) => {
      const message = (error as Error).message;
      assert.equal(message.includes(file), true);
      assert.equal(message.includes("not valid JSON"), true);
      assert.equal(message.includes("sbp_"), false);
      // The parser's own error can quote the text, so the error keeps no cause.
      assert.equal((error as Error).cause, undefined);
      return true;
    });
  }));

test("load of a missing file returns an empty registry and creates no file", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    assert.deepEqual(registry.list(), []);
    assert.deepEqual(registry.names(), []);
    assert.equal(registry.defaultName(), null);
    assert.deepEqual(await readdir(folder), []);
  }));

test("save writes only the metadata fields, even when a record carries more", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const registry = await Registry.load(file);
    const withExtra = { ...record("work"), extra: "fixture-extra-value" };
    registry.add(withExtra);
    await registry.save();
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), {
      default: "work",
      accounts: [record("work")],
    });
  }));

test("get, findByGotrueId, names and list read the accounts, and hand out copies", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work", "gotrue-1"));
    registry.add(record("play", "gotrue-2"));
    assert.deepEqual(registry.get("play"), record("play", "gotrue-2"));
    assert.equal(registry.get("nobody"), undefined);
    assert.deepEqual(registry.findByGotrueId("gotrue-1"), record("work", "gotrue-1"));
    assert.equal(registry.findByGotrueId("gotrue-9"), undefined);
    assert.deepEqual(registry.names(), ["work", "play"]);
    // A caller that changes a returned record does not change the registry.
    const [first] = registry.list();
    first.name = "changed";
    assert.deepEqual(registry.names(), ["work", "play"]);
  }));

test("two saves in a row both succeed, and leave only a file that loads", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const registry = await Registry.load(file);
    registry.add(record("work"));
    await registry.save();
    registry.add(record("play"));
    await registry.save();
    assert.deepEqual(await readdir(folder), ["accounts.json"]);
    const loaded = await Registry.load(file);
    assert.deepEqual(loaded.list(), [record("work"), record("play")]);
  }));

// The error that a save rejects with. The test fails if the save resolves.
const errorOf = async (save: Promise<void>): Promise<NodeJS.ErrnoException> => {
  try {
    await save;
  } catch (error) {
    return error as NodeJS.ErrnoException;
  }
  throw new Error("The save was expected to fail, but it succeeded.");
};

// Runs one step with the rename and the wait replaced by the fakes. The real ones are put back afterwards, even when the
// step fails.
const withSaveHooks = async (fakes: Partial<typeof saveHooks>, run: () => Promise<void>): Promise<void> => {
  const real = { ...saveHooks };
  Object.assign(saveHooks, fakes);
  try {
    await run();
  } finally {
    Object.assign(saveHooks, real);
  }
};

// A wait that returns at once, so a test does not sleep through the retries.
const noWait = async (): Promise<void> => undefined;

// An error with a file-system error code, as Node gives for a refused rename.
const codedError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(`${code}: test error`), { code });

test("two saves that run at the same time use different temporary files", () =>
  inTempFolder(async (folder) => {
    await withSaveHooks({ wait: noWait }, async () => {
      const file = path.join(folder, "accounts.json");
      const registry = await Registry.load(file);
      registry.add(record("work"));
      // A folder at the target path makes each rename fail. The rename error names the temporary file it used.
      await mkdir(file);
      const [first, second] = await Promise.all([errorOf(registry.save()), errorOf(registry.save())]);
      assert.equal(typeof first.path, "string");
      assert.equal(typeof second.path, "string");
      assert.notEqual(first.path, second.path);
      assert.deepEqual(await readdir(folder), ["accounts.json"]);
    });
  }));

test("a save that fails at the rename removes its temporary file, and leaves the target alone", () =>
  inTempFolder(async (folder) => {
    await withSaveHooks({ wait: noWait }, async () => {
      const file = path.join(folder, "accounts.json");
      const registry = await Registry.load(file);
      registry.add(record("work"));
      // A folder at the target path makes the rename fail after the temporary file is written.
      await mkdir(file);
      await assert.rejects(registry.save());
      assert.deepEqual(await readdir(folder), ["accounts.json"]);
      assert.equal((await stat(file)).isDirectory(), true);
    });
  }));

test("a rename refused twice with EPERM and then accepted saves the new content and leaves no temporary file", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const registry = await Registry.load(file);
    registry.add(record("work"));
    await registry.save();
    registry.add(record("play"));
    const realRename = saveHooks.rename;
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
      () => registry.save(),
    );
    assert.equal(renames, 3);
    assert.deepEqual(waits, [100, 100]);
    assert.deepEqual((await Registry.load(file)).list(), [record("work"), record("play")]);
    assert.deepEqual(await readdir(folder), ["accounts.json"]);
  }));

test("a rename refused with EBUSY every time is tried ten times, then save rejects with that error and the file is unchanged", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const registry = await Registry.load(file);
    registry.add(record("work"));
    await registry.save();
    const before = await readFile(file);
    registry.add(record("play"));
    const busy = codedError("EBUSY");
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
        assert.equal(await errorOf(registry.save()), busy);
      },
    );
    assert.equal(renames, 10);
    assert.deepEqual(waits, Array.from({ length: 9 }, () => 100));
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(folder), ["accounts.json"]);
  }));

test("a rename refused with ENOENT is not retried: save rejects at once, after one call, and leaves no temporary file", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const registry = await Registry.load(file);
    registry.add(record("work"));
    const missing = codedError("ENOENT");
    let renames = 0;
    const waits: number[] = [];
    await withSaveHooks(
      {
        rename: async () => {
          renames += 1;
          throw missing;
        },
        wait: async (ms) => {
          waits.push(ms);
        },
      },
      async () => {
        assert.equal(await errorOf(registry.save()), missing);
      },
    );
    assert.equal(renames, 1);
    assert.deepEqual(waits, []);
    assert.deepEqual(await readdir(folder), []);
  }));
