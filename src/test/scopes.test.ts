import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIRECT_KEY, PLUGIN_KEY, directEntry, supportedScopes } from "../agents/scopes.js";
import type { AgentId } from "../agents/state.js";
import { isAbsoluteLocation } from "../paths.js";

// Each name here points at the owner's files, agent configurations or data folder when no test changes it. While this
// file's tests run, each one is set to a folder under a temporary folder, and the values are put back afterwards.
const SANDBOX_NAMES = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "MULTI_ACCOUNT_SUPABASE_HOME",
] as const;
const saved = new Map<string, string | undefined>();
let sandbox = "";

before(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "scopes-test-home-"));
  const values: Record<(typeof SANDBOX_NAMES)[number], string> = {
    HOME: sandbox,
    USERPROFILE: sandbox,
    APPDATA: path.join(sandbox, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(sandbox, "AppData", "Local"),
    CODEX_HOME: path.join(sandbox, "codex"),
    XDG_CONFIG_HOME: path.join(sandbox, "config"),
    MULTI_ACCOUNT_SUPABASE_HOME: path.join(sandbox, "data"),
  };
  for (const name of SANDBOX_NAMES) {
    saved.set(name, process.env[name]);
    process.env[name] = values[name];
  }
});

after(() => {
  for (const name of SANDBOX_NAMES) {
    const value = saved.get(name);
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  rmSync(sandbox, { recursive: true, force: true });
});

test("the tests run with the home, configuration and data folders in a temporary folder", () => {
  for (const name of SANDBOX_NAMES) {
    assert.ok(process.env[name]?.startsWith(os.tmpdir()), `${name} is not in a temporary folder`);
  }
});

test("claude supports the global, project and local scopes", () => {
  assert.deepEqual(supportedScopes("claude"), ["global", "project", "local"]);
});

test("codex supports the global and project scopes", () => {
  assert.deepEqual(supportedScopes("codex"), ["global", "project"]);
});

test("opencode supports the global and project scopes", () => {
  assert.deepEqual(supportedScopes("opencode"), ["global", "project"]);
});

test("antigravity supports the global scope only", () => {
  assert.deepEqual(supportedScopes("antigravity"), ["global"]);
});

test("a name that is not an agent supports no scope, even a name that is an object property", () => {
  for (const name of ["constructor", "__proto__", "toString"]) {
    assert.deepEqual(supportedScopes(name as AgentId), []);
  }
});

test("directEntry gives the Node binary, then the command line program and serve", () => {
  const cli = path.resolve("install-folder", "dist", "cli.js");
  assert.deepEqual(directEntry(cli), { key: DIRECT_KEY, command: process.execPath, args: [cli, "serve"] });
});

test("directEntry returns the direct key, which is not the plugin key", () => {
  const entry = directEntry(path.resolve("install-folder", "dist", "cli.js"));
  assert.equal(entry.key, DIRECT_KEY);
  assert.notEqual(entry.key, PLUGIN_KEY);
});

test("directEntry refuses a command line program path that is not absolute on the platform given", () => {
  assert.throws(() => directEntry(path.join("dist", "cli.js")), /must be absolute/);
  assert.throws(() => directEntry("\\dist\\cli.js", "win32"), /must be absolute/);
  assert.throws(() => directEntry("D:\\x\\cli.js", "linux"), /must be absolute/);
});

test("directEntry accepts a drive path on Windows, whatever system the test runs on", () => {
  assert.equal(directEntry("D:\\x\\cli.js", "win32").args[0], "D:\\x\\cli.js");
});

test("the direct key and the plugin key have their fixed values and differ", () => {
  assert.equal(DIRECT_KEY, "multi-account-supabase");
  assert.equal(PLUGIN_KEY, "supabase");
  assert.notEqual(DIRECT_KEY, PLUGIN_KEY);
});

test("on Windows a path is absolute only with a drive letter or a network share", () => {
  assert.equal(isAbsoluteLocation("\\dist\\cli.js", "win32"), false);
  assert.equal(isAbsoluteLocation("/dist/cli.js", "win32"), false);
  assert.equal(isAbsoluteLocation("D:\\x\\cli.js", "win32"), true);
  assert.equal(isAbsoluteLocation("D:/x/cli.js", "win32"), true);
  assert.equal(isAbsoluteLocation("\\\\server\\share\\cli.js", "win32"), true);
  assert.equal(isAbsoluteLocation("//server/share/cli.js", "win32"), true);
  assert.equal(isAbsoluteLocation("D:x\\cli.js", "win32"), false);
});

test("on other systems a path is absolute when it starts with a slash", () => {
  assert.equal(isAbsoluteLocation("/x/cli.js", "linux"), true);
  assert.equal(isAbsoluteLocation("x/cli.js", "linux"), false);
});
