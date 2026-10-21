import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DIRECT_KEY, PLUGIN_KEY, directEntry, supportedScopes } from "../agents/scopes.js";
import type { AgentId } from "../agents/state.js";

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
  assert.deepEqual(directEntry(cli), { command: process.execPath, args: [cli, "serve"] });
});

test("directEntry refuses a command line program path that is not absolute", () => {
  assert.throws(() => directEntry(path.join("dist", "cli.js")), /must be absolute/);
});

test("the direct key and the plugin key have their fixed values and differ", () => {
  assert.equal(DIRECT_KEY, "multi-account-supabase");
  assert.equal(PLUGIN_KEY, "supabase");
  assert.notEqual(DIRECT_KEY, PLUGIN_KEY);
});
