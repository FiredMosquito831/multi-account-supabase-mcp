import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { addAccount } from "../accounts/add-account.js";
import { type AccountRecord, Registry } from "../accounts/registry.js";
import { MemoryTokenStore, type TokenStore } from "../secrets/token-store.js";
import type { Profile } from "../supabase/api.js";

// A placeholder, not a token. Every test adds this value.
const FAKE_TOKEN = "fake-value-1";
const ADDED_AT = "2026-10-20T09:00:00.000Z";

// Each test gets its own folder under the system temp folder, and removes it afterwards.
// No test reads or writes the owner's data folder, and no test reaches the network or the credential store.
const inTempFolder = async (run: (folder: string) => Promise<void>): Promise<void> => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "add-account-test-"));
  try {
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

// An account that a registry already holds, for the tests that need one before the add.
const accountOf = (name: string, gotrueId: string): AccountRecord => ({
  name,
  email: `${name}@example.com`,
  gotrueId,
  added: "pat",
  addedAt: ADDED_AT,
});

// The profile that a fake identity check returns. The values are placeholders.
const profileOf = (gotrueId: string, email: string): Profile => ({
  gotrueId,
  email,
  username: "fake-user",
});

// The dependencies of addAccount. The identity check is passed in as a fake, and the clock always returns ADDED_AT.
const depsFor = (
  registry: Registry,
  tokens: TokenStore,
  fetchProfile: (token: string) => Promise<Profile>,
) => ({ registry, tokens, fetchProfile, addedAt: () => ADDED_AT });

test("a new account is stored: its token is in the store, and accounts.json has the name and the email but not the token", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const registry = await Registry.load(file);
    const tokens = new MemoryTokenStore();
    const added = await addAccount(
      depsFor(registry, tokens, async () => profileOf("gotrue-work", "work@example.com")),
      "work",
      FAKE_TOKEN,
    );
    const expected = accountOf("work", "gotrue-work");
    assert.equal(await tokens.get("work"), FAKE_TOKEN);
    assert.deepEqual(added, expected);
    const text = await readFile(file, "utf8");
    assert.deepEqual(JSON.parse(text), { default: "work", accounts: [expected] });
    assert.equal(text.includes(FAKE_TOKEN), false);
  }));

test("a check that throws stores no token, and leaves the registry and the folder unchanged", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(accountOf("play", "gotrue-play"));
    const before = registry.list();
    const tokens = new MemoryTokenStore();
    const failingCheck = async (): Promise<Profile> => {
      throw new Error("Unexpected response from Supabase /v1/profile.");
    };
    await assert.rejects(addAccount(depsFor(registry, tokens, failingCheck), "work", FAKE_TOKEN), {
      message: "Unexpected response from Supabase /v1/profile.",
    });
    assert.equal(await tokens.get("work"), undefined);
    assert.deepEqual(registry.list(), before);
    // Nothing was saved, so the folder holds no file.
    assert.deepEqual(await readdir(folder), []);
  }));

test("a name that is already taken is refused, and the identity check is not called", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(accountOf("work", "gotrue-work"));
    const tokens = new MemoryTokenStore();
    let checks = 0;
    const countingCheck = async (): Promise<Profile> => {
      checks += 1;
      return profileOf("gotrue-other", "other@example.com");
    };
    await assert.rejects(addAccount(depsFor(registry, tokens, countingCheck), "work", FAKE_TOKEN), {
      message: 'An account named "work" already exists. Remove it first to replace it.',
    });
    assert.equal(checks, 0);
    assert.equal(await tokens.get("work"), undefined);
    assert.deepEqual(registry.names(), ["work"]);
  }));

test("a Supabase user already added under another name is refused, and the token is not stored", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    registry.add(accountOf("work", "gotrue-1"));
    const tokens = new MemoryTokenStore();
    await assert.rejects(
      addAccount(depsFor(registry, tokens, async () => profileOf("gotrue-1", "play@example.com")), "play", FAKE_TOKEN),
      { message: 'This Supabase user is already added as "work".' },
    );
    assert.equal(await tokens.get("play"), undefined);
    assert.deepEqual(registry.names(), ["work"]);
  }));

test("a save that fails removes the record and the token, and rethrows the save error", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    const saveError = new Error("The save failed.");
    // The record and the token are in place before save runs, so the rollback has both to remove.
    registry.save = async () => {
      throw saveError;
    };
    const tokens = new MemoryTokenStore();
    await assert.rejects(
      addAccount(depsFor(registry, tokens, async () => profileOf("gotrue-work", "work@example.com")), "work", FAKE_TOKEN),
      (error: unknown) => error === saveError,
    );
    assert.equal(registry.get("work"), undefined);
    assert.deepEqual(registry.list(), []);
    assert.equal(registry.defaultName(), null);
    assert.equal(await tokens.get("work"), undefined);
  }));

test("a failed save and a failed token removal reject with the save error, and warn once without the token or the removal error", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    const saveError = new Error("The save failed.");
    registry.save = async () => {
      throw saveError;
    };
    // The removal error holds the token on purpose, so the test shows that the warning repeats neither.
    const deleteError = new Error(`The credential store refused to remove ${FAKE_TOKEN}.`);
    const tokens = new MemoryTokenStore();
    tokens.delete = async () => {
      throw deleteError;
    };
    const warnings: string[] = [];
    await assert.rejects(
      addAccount(
        {
          ...depsFor(registry, tokens, async () => profileOf("gotrue-work", "work@example.com")),
          warn: (message) => {
            warnings.push(message);
          },
        },
        "work",
        FAKE_TOKEN,
      ),
      (error: unknown) => error === saveError,
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].includes(FAKE_TOKEN), false);
    assert.equal(warnings[0].includes(deleteError.message), false);
  }));

test("a clock error after the token is stored removes the token, leaves no record, and rejects with the clock error", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    const tokens = new MemoryTokenStore();
    const clockError = new Error("The clock failed.");
    // addedAt runs after the token is stored, so a failure here must still remove the token.
    const failingClock = (): string => {
      throw clockError;
    };
    await assert.rejects(
      addAccount(
        {
          ...depsFor(registry, tokens, async () => profileOf("gotrue-work", "work@example.com")),
          addedAt: failingClock,
        },
        "work",
        FAKE_TOKEN,
      ),
      (error: unknown) => error === clockError,
    );
    assert.equal(await tokens.get("work"), undefined);
    assert.equal(registry.get("work"), undefined);
    assert.deepEqual(registry.list(), []);
  }));

test("a warning that throws does not replace the save error, and the failed removal is written to stderr", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    const saveError = new Error("The save failed.");
    registry.save = async () => {
      throw saveError;
    };
    const tokens = new MemoryTokenStore();
    tokens.delete = async () => {
      throw new Error("The credential store refused the removal.");
    };
    const warnError = new Error("The warning failed.");
    // The stderr mock keeps the test output clean, and shows that the failed removal was still reported.
    const stderr = mock.method(process.stderr, "write", () => true);
    try {
      await assert.rejects(
        addAccount(
          {
            ...depsFor(registry, tokens, async () => profileOf("gotrue-work", "work@example.com")),
            warn: () => {
              throw warnError;
            },
          },
          "work",
          FAKE_TOKEN,
        ),
        (error: unknown) => error === saveError,
      );
      assert.equal(stderr.mock.callCount(), 1);
    } finally {
      stderr.mock.restore();
    }
  }));

test("a warning and a stderr write that both throw still reject with the save error", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    const saveError = new Error("The save failed.");
    registry.save = async () => {
      throw saveError;
    };
    const tokens = new MemoryTokenStore();
    tokens.delete = async () => {
      throw new Error("The credential store refused the removal.");
    };
    // Both writers fail, so the failed removal is reported nowhere. The thrown error must still be the save error.
    const stderr = mock.method(process.stderr, "write", () => {
      throw new Error("The stderr write failed.");
    });
    try {
      await assert.rejects(
        addAccount(
          {
            ...depsFor(registry, tokens, async () => profileOf("gotrue-work", "work@example.com")),
            warn: () => {
              throw new Error("The warning failed.");
            },
          },
          "work",
          FAKE_TOKEN,
        ),
        (error: unknown) => error === saveError,
      );
      assert.equal(stderr.mock.callCount(), 1, "the stderr writer was tried once");
    } finally {
      stderr.mock.restore();
    }
  }));

test("a name that breaks the name rules is refused before the identity check, and stores no token", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    const tokens = new MemoryTokenStore();
    let checks = 0;
    const countingCheck = async (): Promise<Profile> => {
      checks += 1;
      return profileOf("gotrue-work", "work@example.com");
    };
    await assert.rejects(addAccount(depsFor(registry, tokens, countingCheck), "Bad_name", FAKE_TOKEN), {
      message:
        'Invalid account name "Bad_name". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.',
    });
    assert.equal(checks, 0);
    assert.equal(await tokens.get("Bad_name"), undefined);
    assert.deepEqual(registry.list(), []);
  }));

test('the reserved name "all" is refused before the identity check, and stores no token', () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    const tokens = new MemoryTokenStore();
    let checks = 0;
    const countingCheck = async (): Promise<Profile> => {
      checks += 1;
      return profileOf("gotrue-work", "work@example.com");
    };
    await assert.rejects(addAccount(depsFor(registry, tokens, countingCheck), "all", FAKE_TOKEN), {
      message: '"all" is reserved. Pick another account name.',
    });
    assert.equal(checks, 0);
    assert.equal(await tokens.get("all"), undefined);
    assert.deepEqual(registry.list(), []);
  }));

test("an empty token is refused before the identity check, and stores no token", () =>
  inTempFolder(async (folder) => {
    const registry = await Registry.load(path.join(folder, "accounts.json"));
    const tokens = new MemoryTokenStore();
    let checks = 0;
    const countingCheck = async (): Promise<Profile> => {
      checks += 1;
      return profileOf("gotrue-work", "work@example.com");
    };
    await assert.rejects(addAccount(depsFor(registry, tokens, countingCheck), "work", ""), {
      message: "No token was given.",
    });
    assert.equal(checks, 0);
    assert.equal(await tokens.get("work"), undefined);
    assert.deepEqual(registry.list(), []);
  }));
