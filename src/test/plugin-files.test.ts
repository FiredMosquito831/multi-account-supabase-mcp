import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_FILE, SKILL_NAME } from "../agents/skill.js";

// This file runs from dist/test, so two levels up is the repository root.
const root = fileURLToPath(new URL("../../", import.meta.url));
const PLUGIN_DIR = "plugins/multi-account-supabase";
const MCP_FILE = `${PLUGIN_DIR}/.mcp.json`;
const PLUGIN_SKILL = `${PLUGIN_DIR}/skills/${SKILL_NAME}/${SKILL_FILE}`;
const ROOT_SKILL = `skills/${SKILL_NAME}/${SKILL_FILE}`;

test("the plugin .mcp.json has exactly one server, keyed supabase, started by node on the launcher, with no env", () => {
  const config = JSON.parse(readFileSync(join(root, MCP_FILE), "utf8"));
  assert.deepEqual(Object.keys(config.mcpServers), ["supabase"]);
  const server = config.mcpServers.supabase;
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs"]);
  assert.equal("env" in server, false);
});

test("the plugin skill is a byte copy of the root skill", () => {
  assert.deepEqual(readFileSync(join(root, PLUGIN_SKILL)), readFileSync(join(root, ROOT_SKILL)));
});

test("the plugin skill frontmatter name is SKILL_NAME", () => {
  const text = readFileSync(join(root, PLUGIN_SKILL), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  assert.ok(frontmatter, "SKILL.md has a frontmatter block");
  const name = /^name:\s*(.+?)\s*$/m.exec(frontmatter[1]);
  assert.equal(name?.[1], SKILL_NAME);
});
