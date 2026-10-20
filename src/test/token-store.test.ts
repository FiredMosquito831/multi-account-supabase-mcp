import { test } from "node:test";
import assert from "node:assert/strict";
import { type KeyringEntryLike, KeyringTokenStore, MemoryTokenStore, SERVICE } from "../secrets/token-store.js";

// A placeholder, not a token. Every test stores this value.
const FAKE = "fake-value-1";

// A fake entry factory. It records each (service, account) pair it is given, and each call made on the
// entry it returns. The entry's getPassword returns `stored`, and its deletePassword returns `deleted`.
// Every test passes this factory, so the default factory (the real credential store) is never called.
const fakeEntries = (stored: string | null, deleted = true) => {
  const created: [string, string][] = [];
  const written: string[] = [];
  const calls: string[] = [];
  const makeEntry = (service: string, account: string): KeyringEntryLike => {
    created.push([service, account]);
    return {
      getPassword: () => {
        calls.push("getPassword");
        return stored;
      },
      setPassword: (password) => {
        calls.push("setPassword");
        written.push(password);
      },
      deletePassword: () => {
        calls.push("deletePassword");
        return deleted;
      },
    };
  };
  return { makeEntry, created, written, calls };
};

test("the memory store returns the token it was given", async () => {
  const store = new MemoryTokenStore();
  await store.set("work", FAKE);
  assert.equal(await store.get("work"), FAKE);
});

test("the memory store returns undefined for a name it does not hold", async () => {
  const store = new MemoryTokenStore();
  assert.equal(await store.get("nobody"), undefined);
});

test("after delete, the memory store returns undefined", async () => {
  const store = new MemoryTokenStore();
  await store.set("work", FAKE);
  await store.delete("work");
  assert.equal(await store.get("work"), undefined);
});

test("set creates the entry for the account and sets the token on it", async () => {
  const fake = fakeEntries(null);
  const store = new KeyringTokenStore(fake.makeEntry);
  await store.set("work", FAKE);
  assert.deepEqual(fake.created, [[SERVICE, "work"]]);
  assert.deepEqual(fake.written, [FAKE]);
  assert.deepEqual(fake.calls, ["setPassword"]);
});

test("get returns undefined when the entry has no password", async () => {
  const fake = fakeEntries(null);
  const store = new KeyringTokenStore(fake.makeEntry);
  assert.equal(await store.get("work"), undefined);
  assert.deepEqual(fake.created, [[SERVICE, "work"]]);
  assert.deepEqual(fake.calls, ["getPassword"]);
});

test("get returns the password the entry holds", async () => {
  const fake = fakeEntries(FAKE);
  const store = new KeyringTokenStore(fake.makeEntry);
  assert.equal(await store.get("work"), FAKE);
});

test("delete calls deletePassword on the entry for the account", async () => {
  const fake = fakeEntries(FAKE);
  const store = new KeyringTokenStore(fake.makeEntry);
  await store.delete("work");
  assert.deepEqual(fake.created, [[SERVICE, "work"]]);
  assert.deepEqual(fake.calls, ["deletePassword"]);
});

test("delete of an account with no credential is not an error", async () => {
  const fake = fakeEntries(null, false);
  const store = new KeyringTokenStore(fake.makeEntry);
  await store.delete("work");
  assert.deepEqual(fake.calls, ["deletePassword"]);
});

test("an error from the credential store reaches the caller", async () => {
  const makeEntry = (): KeyringEntryLike => ({
    getPassword: () => {
      throw new Error("store locked");
    },
    setPassword: () => {
      throw new Error("store locked");
    },
    deletePassword: () => {
      throw new Error("store locked");
    },
  });
  const store = new KeyringTokenStore(makeEntry);
  await assert.rejects(store.get("work"), { message: "store locked" });
  await assert.rejects(store.set("work", FAKE), { message: "store locked" });
  await assert.rejects(store.delete("work"), { message: "store locked" });
});

test("the credential store service name is fixed, so a rename cannot orphan stored tokens", () => {
  assert.equal(SERVICE, "multi-account-supabase-mcp");
});
