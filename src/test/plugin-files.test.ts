import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
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

test("every multi-account-supabase-mcp@ version in the skill is the plugin version, and the skill gives the npx add line", () => {
  const pluginVersion = (JSON.parse(readFileSync(join(root, PLUGIN_DIR, ".claude-plugin", "plugin.json"), "utf8")) as {
    version: string;
  }).version;
  for (const file of [ROOT_SKILL, PLUGIN_SKILL]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.ok(
      text.includes(`npx -y multi-account-supabase-mcp@${pluginVersion} add <name> --pat`),
      `${file} gives the npx add line with the plugin version`,
    );
    assert.doesNotMatch(text, /multi-account-supabase-mcp add /, `${file} has no bare add line`);
    for (const match of text.matchAll(/multi-account-supabase-mcp@([^\s`'"]*)/g)) {
      assert.equal(match[1], pluginVersion, `${file} names the plugin version`);
    }
  }
});

// Every file under a folder, as paths from the repository root. Nothing is excluded.
const walk = (dir: string): string[] =>
  readdirSync(join(root, dir)).flatMap((entry) => {
    const child = `${dir}/${entry}`;
    return statSync(join(root, child)).isDirectory() ? walk(child) : [child];
  });

// The two token shapes: sbp_ with a letter or digit after it, and 24 or more letters and digits in a row with no
// space. A match is never printed, only the name of the file it is in.
const TOKEN_SHAPES = [/sbp_[A-Za-z0-9]/, /[A-Za-z0-9]{24,}/];
const hasTokenShape = (text: string): boolean => TOKEN_SHAPES.some((shape) => shape.test(text));

test("the token shapes match the samples they should, and no others", () => {
  assert.equal(hasTokenShape("sbp_abc123"), true);
  assert.equal(hasTokenShape("x".repeat(24)), true);
  assert.equal(hasTokenShape("x".repeat(23)), false);
  assert.equal(hasTokenShape("sbp_ and words-with_under_scores 0.1.0"), false);
});

test("no file under the plugin folder has a token-shaped string, and the walk reaches the plugin files", () => {
  const files = walk(PLUGIN_DIR);
  assert.ok(files.includes(`${PLUGIN_DIR}/.claude-plugin/plugin.json`), "the walk reaches the manifest");
  assert.ok(files.includes(`${PLUGIN_DIR}/bin/launch.mjs`), "the walk reaches the launcher");
  const offenders = files.filter((file) => hasTokenShape(readFileSync(join(root, file), "utf8")));
  assert.deepEqual(offenders, [], "files with a token-shaped string (names only)");
});
