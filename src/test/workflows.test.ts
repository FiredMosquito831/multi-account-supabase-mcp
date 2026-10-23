import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The compiled test sits in dist/test, so the repository root is two folders up.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflowDir = join(root, ".github", "workflows");

// A `uses:` line, with or without a list dash, and its value (the action and the comment).
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.*?)\s*$/;
// An action pinned to a full 40-character commit SHA, with the tag in a comment on the same line.
const PINNED_USES = /^[\w.-]+\/[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}\s+#\s*v\d+(?:\.\d+){0,2}$/;

function readWorkflow(name: string): string {
  const file = join(workflowDir, name);
  assert.ok(existsSync(file), `${name} must exist under .github/workflows`);
  return readFileSync(file, "utf8");
}

function usesValues(text: string): string[] {
  const values: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = USES_LINE.exec(line);
    if (match) values.push(match[1] ?? "");
  }
  return values;
}

function hasRunStep(text: string, command: string): boolean {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*(?:-\\s+)?run:\\s*${escaped}\\s*$`, "m").test(text);
}

test("ci.yml runs on pull requests and on pushes to main", () => {
  const text = readWorkflow("ci.yml");
  assert.match(text, /^on:/m);
  assert.match(text, /^\s+pull_request:/m);
  assert.match(text, /^\s+push:/m);
  assert.match(text, /branches:\s*\[\s*main\s*\]/);
});

test("ci.yml tests on windows-latest and ubuntu-latest with Node 22", () => {
  const text = readWorkflow("ci.yml");
  assert.match(text, /^\s+matrix:/m);
  assert.match(text, /os:\s*\[[^\]]*\bwindows-latest\b[^\]]*\]/);
  assert.match(text, /os:\s*\[[^\]]*\bubuntu-latest\b[^\]]*\]/);
  const versions = text
    .split(/\r?\n/)
    .map((line) => /^\s*node-version:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]);
  assert.ok(versions.length > 0, "ci.yml must set node-version");
  for (const version of versions) assert.equal(version, "22");
});

test("ci.yml runs the install, typecheck, tests and pack dry run", () => {
  const text = readWorkflow("ci.yml");
  assert.ok(usesValues(text).some((value) => value.startsWith("actions/checkout@")));
  assert.ok(usesValues(text).some((value) => value.startsWith("actions/setup-node@")));
  assert.ok(hasRunStep(text, "npm ci"), "ci.yml must run npm ci");
  assert.ok(hasRunStep(text, "npm run typecheck"), "ci.yml must run npm run typecheck");
  assert.ok(hasRunStep(text, "npm test"), "ci.yml must run npm test");
  assert.ok(hasRunStep(text, "npm pack --dry-run"), "ci.yml must run npm pack --dry-run");
});

test("ci.yml has no secret, no token and no id-token permission", () => {
  const text = readWorkflow("ci.yml");
  assert.doesNotMatch(text, /id-token/);
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /NPM_TOKEN/);
  assert.doesNotMatch(text, /^\s*token:/m);
});

test("every uses line in every workflow pins a full commit SHA with the tag in a comment", () => {
  assert.ok(existsSync(workflowDir), "the .github/workflows folder must exist");
  const files = readdirSync(workflowDir).filter((name) => name.endsWith(".yml"));
  assert.ok(files.length > 0, "the .github/workflows folder must hold a workflow");
  for (const file of files) {
    for (const value of usesValues(readWorkflow(file))) {
      assert.match(value, PINNED_USES, `${file}: "${value}" is not pinned to a SHA with a tag comment`);
    }
  }
});
