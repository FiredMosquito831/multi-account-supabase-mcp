import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Registry } from "../accounts/registry.js";
import { resolveTargets } from "../mux/routing.js";

const ADDED_AT = "2026-10-20T09:00:00.000Z";
const NOT_A_STRING = 'account must be a string: one name, comma-separated names, or "all".';
const NO_ACCOUNTS = "No Supabase accounts are set up yet. Run: multi-account-supabase-mcp add <name>";

// Loads a registry from a file in a temporary folder, then removes the folder. The registry is only read,
// never saved, and no test touches the owner's data folder.
const withRegistry = async (
  names: string[],
  defaultName: string | null,
  run: (registry: Registry) => void,
): Promise<void> => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "routing-test-"));
  try {
    const accounts = names.map((name) => ({
      name,
      email: `${name}@example.com`,
      gotrueId: `gotrue-${name}`,
      added: "pat",
      addedAt: ADDED_AT,
    }));
    const file = path.join(folder, "accounts.json");
    await writeFile(file, JSON.stringify({ default: defaultName, accounts }));
    run(await Registry.load(file));
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

test("a value that is neither undefined nor a string is refused with the string message", () =>
  withRegistry(["work", "play"], "work", (registry) => {
    for (const value of [42, null, true, ["work"], { name: "work" }]) {
      assert.throws(() => resolveTargets(value, registry), { message: NOT_A_STRING });
    }
  }));

test("with no accounts set up, a string argument is refused with the setup message", () =>
  withRegistry([], null, (registry) => {
    for (const value of [undefined, "", "   ", "all", "work"]) {
      assert.throws(() => resolveTargets(value, registry), { message: NO_ACCOUNTS });
    }
    // The string check comes first, so a non-string still gets its own message.
    assert.throws(() => resolveTargets(42, registry), { message: NOT_A_STRING });
  }));

test("a missing or blank argument gives the default account, with multi false", () =>
  withRegistry(["work", "play"], "play", (registry) => {
    for (const value of [undefined, "", "   "]) {
      assert.deepEqual(resolveTargets(value, registry), { accounts: ["play"], multi: false });
    }
  }));

test("a missing or blank argument with no default is refused, and the message names the accounts", () =>
  withRegistry(["work", "play"], null, (registry) => {
    for (const value of [undefined, "", "   "]) {
      assert.throws(() => resolveTargets(value, registry), {
        message: 'No default account is set. Pass account as one of: work, play, or "all".',
      });
    }
  }));

test('"all" gives every account, with multi true, and needs no default', () =>
  withRegistry(["work", "play"], null, (registry) => {
    for (const value of ["all", " all "]) {
      assert.deepEqual(resolveTargets(value, registry), { accounts: ["work", "play"], multi: true });
    }
  }));

test("an empty item in a list is refused with the empty-name message", () =>
  withRegistry(["work", "play"], "work", (registry) => {
    for (const value of ["work,", ",play", "work,,play", " , "]) {
      assert.throws(() => resolveTargets(value, registry), {
        message: "account has an empty name in its list.",
      });
    }
  }));

test("one unknown name is refused, and the message lists the known accounts", () =>
  withRegistry(["work", "play"], "work", (registry) => {
    for (const value of ["nobody", "work,nobody"]) {
      assert.throws(() => resolveTargets(value, registry), {
        message: "Unknown account: nobody. Known accounts: work, play.",
      });
    }
  }));

test("several unknown names are refused together, in the order given", () =>
  withRegistry(["work", "play"], "work", (registry) => {
    assert.throws(() => resolveTargets("nobody, work, ghost", registry), {
      message: "Unknown accounts: nobody, ghost. Known accounts: work, play.",
    });
  }));

test("one name in a list gives multi false, with its spaces trimmed", () =>
  withRegistry(["work", "play"], "work", (registry) => {
    assert.deepEqual(resolveTargets(" play ", registry), { accounts: ["play"], multi: false });
  }));

test("two or more names give multi true, in the order given", () =>
  withRegistry(["work", "play"], "work", (registry) => {
    assert.deepEqual(resolveTargets("play, work", registry), {
      accounts: ["play", "work"],
      multi: true,
    });
  }));
