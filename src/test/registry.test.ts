import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AccountRecord, Registry } from "../accounts/registry.js";

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

const corruptMessage = (file: string): string =>
  `accounts.json cannot be read, so it was not changed: ${file}`;

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

test("save leaves no accounts.json.tmp behind", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(record("work"));
    await registry.save();
    // Only the saved file is in the folder.
    assert.deepEqual(await readdir(folder), ["accounts.json"]);
  }));

test("a save that cannot write its temporary file leaves accounts.json as it was", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const registry = await Registry.load(file);
    registry.add(record("work"));
    await registry.save();
    const before = await readFile(file);
    registry.add(record("play"));
    // A folder at the temporary file's path makes the write fail.
    await mkdir(`${file}.tmp`);
    await assert.rejects(registry.save());
    assert.deepEqual(await readFile(file), before);
  }));

const corruptFiles: [string, string][] = [
  ["text that is not JSON", "{ not json"],
  ["an empty file", ""],
  ["JSON without an accounts array", '{"default": null}'],
  ["an accounts value that is not an array", '{"default": null, "accounts": {}}'],
  ["a top-level array", "[]"],
  ["a top-level null", "null"],
  ["no default key", JSON.stringify({ accounts: [record("work")] })],
  [
    "a record without gotrueId",
    JSON.stringify({
      default: null,
      accounts: [{ name: "work", email: "work@example.com", added: "pat", addedAt: ADDED_AT }],
    }),
  ],
  [
    'a record whose added is not "pat"',
    JSON.stringify({ default: null, accounts: [{ ...record("work"), added: "oauth" }] }),
  ],
  [
    "a record with an empty email",
    JSON.stringify({ default: null, accounts: [{ ...record("work"), email: "" }] }),
  ],
  ["a record named all", JSON.stringify({ default: null, accounts: [record("all")] })],
  [
    "two accounts with one name",
    JSON.stringify({
      default: null,
      accounts: [record("work", "gotrue-1"), record("work", "gotrue-2")],
    }),
  ],
  [
    "two accounts for one Supabase user",
    JSON.stringify({
      default: null,
      accounts: [record("work", "gotrue-1"), record("play", "gotrue-1")],
    }),
  ],
  [
    "a default that names no account",
    JSON.stringify({ default: "ghost", accounts: [record("work")] }),
  ],
];

for (const [label, text] of corruptFiles) {
  test(`load refuses ${label}, and leaves the file bytes unchanged`, () =>
    inTempFolder(async (folder) => {
      const file = path.join(folder, "accounts.json");
      await writeFile(file, text);
      const before = await readFile(file);
      await assert.rejects(Registry.load(file), { message: corruptMessage(file) });
      assert.deepEqual(await readFile(file), before);
      assert.deepEqual(await readdir(folder), ["accounts.json"]);
    }));
}

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
    const withExtra = { ...record("work"), token: "fixture-extra-value" };
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
