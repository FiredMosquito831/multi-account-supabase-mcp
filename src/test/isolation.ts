import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The variables that point a test at folders. Each one is set to a folder inside the temporary root, so no test reads or
// writes the owner's files, Codex or opencode configuration, or data folder.
export const ISOLATED_VARIABLES = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "MULTI_ACCOUNT_SUPABASE_HOME",
] as const;

// The folder that each variable points to, inside the root.
const folderFor = (root: string): Record<(typeof ISOLATED_VARIABLES)[number], string> => ({
  HOME: path.join(root, "home"),
  USERPROFILE: path.join(root, "home"),
  APPDATA: path.join(root, "appdata"),
  LOCALAPPDATA: path.join(root, "localappdata"),
  CODEX_HOME: path.join(root, "codex-home"),
  XDG_CONFIG_HOME: path.join(root, "config"),
  MULTI_ACCOUNT_SUPABASE_HOME: path.join(root, "data"),
});

// Points every variable into the root. The function it returns puts the earlier values back.
export const isolateIn = (root: string): (() => void) => {
  const previous = ISOLATED_VARIABLES.map((name) => [name, process.env[name]] as const);
  const folders = folderFor(root);
  for (const name of ISOLATED_VARIABLES) {
    process.env[name] = folders[name];
  }
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  };
};

// Asserts that every variable points into the root. A test that runs in a root calls this to check the isolation.
export const assertIsolated = (root: string): void => {
  for (const name of ISOLATED_VARIABLES) {
    const value = process.env[name];
    assert.equal(value !== undefined && value.startsWith(root), true, `${name} points into the temporary root`);
  }
};

// Runs a test in a new temporary root, with every isolated variable pointing into it. The root is removed afterwards.
export const inTemporaryRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "isolated-test-"));
  const restore = isolateIn(root);
  try {
    await run(root);
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
};
