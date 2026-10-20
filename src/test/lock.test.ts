import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withRegistryLock } from "../accounts/lock.js";

const BUSY = "Another multi-account-supabase-mcp command is changing the accounts. Try again in a moment.";

// Each test gets its own folder under the system temp folder, and removes it afterwards.
// No test reads or writes the owner's data folder.
const inTempFolder = async (run: (folder: string) => Promise<void>): Promise<void> => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "lock-test-"));
  try {
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A gate that a test opens by hand. Its wait promise resolves when open is called.
const gate = (): { wait: Promise<void>; open: () => void } => {
  let openGate: () => void = () => undefined;
  const wait = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  return { wait, open: () => openGate() };
};

test("(a) the work runs, its value is returned, and the lock file is gone afterwards", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    let lockExistedDuringWork = false;
    const value = await withRegistryLock(file, async () => {
      lockExistedDuringWork = existsSync(`${file}.lock`);
      return 42;
    });
    assert.equal(value, 42);
    assert.equal(lockExistedDuringWork, true);
    assert.equal(existsSync(`${file}.lock`), false);
  }));

test("(b) a second call waits while the first holds the lock, then runs after the first releases", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const events: string[] = [];
    const firstStarted = gate();
    const firstMayEnd = gate();
    const first = withRegistryLock(
      file,
      async () => {
        events.push("first starts");
        firstStarted.open();
        await firstMayEnd.wait;
        events.push("first ends");
        return "first";
      },
      { pollMs: 5 },
    );
    await firstStarted.wait;
    const second = withRegistryLock(
      file,
      async () => {
        events.push("second starts");
        return "second";
      },
      { pollMs: 5, waitMs: 10_000 },
    );
    await delay(60);
    // Read before the first call is released, so a second call that ran early shows here.
    const whileFirstHolds = [...events];
    firstMayEnd.open();
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.deepEqual(whileFirstHolds, ["first starts"]);
    assert.deepEqual(events, ["first starts", "first ends", "second starts"]);
  }));

test("(c) a second call that waits longer than waitMs rejects with the busy message, and the first call still completes", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const firstStarted = gate();
    const firstMayEnd = gate();
    const first = withRegistryLock(
      file,
      async () => {
        firstStarted.open();
        await firstMayEnd.wait;
        return "first";
      },
      { pollMs: 10 },
    );
    await firstStarted.wait;
    let secondRan = false;
    const second = withRegistryLock(
      file,
      async () => {
        secondRan = true;
        return "second";
      },
      { waitMs: 300, pollMs: 10 },
    );
    const outcome = await second.then(
      () => "resolved",
      (error: Error) => error.message,
    );
    firstMayEnd.open();
    assert.equal(outcome, BUSY);
    assert.equal(secondRan, false);
    assert.equal(await first, "first");
    assert.equal(existsSync(`${file}.lock`), false);
  }));

test("(d) a lock whose modification time is older than staleMs is taken over at once", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const lock = `${file}.lock`;
    await writeFile(lock, '{"id":"abandoned-call","acquiredAt":"2026-10-19T09:00:00.000Z"}\n');
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    await utimes(lock, tenMinutesAgo, tenMinutesAgo);
    const sleeps: number[] = [];
    const value = await withRegistryLock(file, async () => "taken", {
      waitMs: 300,
      staleMs: 120_000,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    assert.equal(value, "taken");
    // A takeover needs no wait, so the poll never sleeps.
    assert.deepEqual(sleeps, []);
    assert.equal(existsSync(lock), false);
  }));

test("(e) the lock is released when the work throws, and a later call gets the lock at once", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    await assert.rejects(
      withRegistryLock(file, async () => {
        throw new Error("The work failed.");
      }),
      { message: "The work failed." },
    );
    assert.equal(existsSync(`${file}.lock`), false);
    assert.equal(await withRegistryLock(file, async () => "again", { waitMs: 300 }), "again");
  }));

test("(f) a release that finds another call's id in the lock file leaves that file alone", () =>
  inTempFolder(async (folder) => {
    const file = path.join(folder, "accounts.json");
    const lock = `${file}.lock`;
    const takenOver = '{"id":"other-call","acquiredAt":"2026-10-20T09:00:00.000Z"}\n';
    await withRegistryLock(file, async () => {
      // Another call took the lock over as stale while this work ran, so the file now holds that call's id.
      await writeFile(lock, takenOver);
    });
    assert.equal(await readFile(lock, "utf8"), takenOver);
  }));
