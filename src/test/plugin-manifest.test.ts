import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKETPLACE, MARKETPLACE_SOURCE, PLUGIN, PLUGIN_ID } from "../agents/claude.js";

// This file runs from dist/test, so two levels up is the repository root.
const root = fileURLToPath(new URL("../../", import.meta.url));
const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const PLUGIN_DIR = "plugins/multi-account-supabase";
const PLUGIN_FILE = `${PLUGIN_DIR}/.claude-plugin/plugin.json`;

// Each test reads its own files, so a missing file fails only the tests that need it.
const readJson = (path: string): any => JSON.parse(readFileSync(join(root, path), "utf8"));

test("the marketplace name is the shared MARKETPLACE name", () => {
  assert.equal(readJson(MARKETPLACE_FILE).name, MARKETPLACE);
});

test("the marketplace has exactly one plugin entry, with the expected name, source and strict flag", () => {
  const plugins = readJson(MARKETPLACE_FILE).plugins;
  assert.ok(Array.isArray(plugins));
  assert.equal(plugins.length, 1);
  assert.equal(plugins[0].name, PLUGIN);
  assert.equal(plugins[0].source, "./plugins/multi-account-supabase");
  assert.equal(plugins[0].strict, false);
});

test("the marketplace declares no commands, hooks or servers", () => {
  const marketplace = readJson(MARKETPLACE_FILE);
  const allowedTopKeys = ["name", "owner", "metadata", "plugins"];
  for (const key of Object.keys(marketplace)) {
    assert.ok(allowedTopKeys.includes(key), `unexpected top-level key: ${key}`);
  }
  for (const entry of marketplace.plugins) {
    for (const key of ["commands", "hooks", "mcpServers"]) {
      assert.equal(key in entry, false, `plugin entry must not have ${key}`);
    }
  }
});

test("the plugin manifest name is the shared PLUGIN name", () => {
  assert.equal(readJson(PLUGIN_FILE).name, PLUGIN);
});

test("the plugin, the marketplace metadata and package.json have the same version", () => {
  const pkgVersion = readJson("package.json").version;
  assert.equal(readJson(PLUGIN_FILE).version, pkgVersion);
  assert.equal(readJson(MARKETPLACE_FILE).metadata.version, pkgVersion);
});

test("PLUGIN_ID and MARKETPLACE_SOURCE have the expected values", () => {
  assert.equal(PLUGIN_ID, `${PLUGIN}@${MARKETPLACE}`);
  assert.equal(MARKETPLACE_SOURCE, "FiredMosquito831/multi-account-supabase-mcp");
});

test("the plugin source is a folder that holds .claude-plugin/plugin.json", () => {
  const source = readJson(MARKETPLACE_FILE).plugins[0].source;
  assert.equal(source, "./plugins/multi-account-supabase");
  assert.ok(statSync(join(root, source)).isDirectory());
  assert.ok(existsSync(join(root, source, ".claude-plugin", "plugin.json")));
});

test("package.json publishes .claude-plugin/, plugins/ and skills/", () => {
  const files: string[] = readJson("package.json").files;
  for (const entry of [".claude-plugin/", "plugins/", "skills/"]) {
    assert.ok(files.includes(entry), `package.json files must include ${entry}`);
  }
});
