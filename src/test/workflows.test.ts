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

// Task 4: the publish workflow. It is written and not run.
const PUBLISH_REPO = "FiredMosquito831/multi-account-supabase-mcp";

// The lines of one job under `jobs:`, from its key to the next job key.
function jobBlock(text: string, job: string): string {
  const lines = text.split(/\r?\n/);
  const start = lines.indexOf(`  ${job}:`);
  assert.ok(start >= 0, `the workflow must define the job ${job}`);
  const next = lines.slice(start + 1).findIndex((line) => /^  [\w-]+:\s*$/.test(line));
  const stop = next < 0 ? lines.length : start + 1 + next;
  return lines.slice(start, stop).join("\n");
}

// The value of each node-version line.
function nodeVersions(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*node-version:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1] ?? "");
}

// The `if:` line of a job block, or an empty string.
function jobIf(block: string): string {
  return block.split(/\r?\n/).find((line) => /^\s+if:/.test(line)) ?? "";
}

test("npm.yml runs on a published release and on a push to main that changes package.json", () => {
  const text = readWorkflow("npm.yml");
  assert.match(text, /^on:/m);
  assert.match(text, /^\s+release:/m);
  assert.match(text, /types:\s*\[\s*published\s*\]/);
  assert.match(text, /^\s+push:/m);
  assert.match(text, /branches:\s*\[\s*main\s*\]/);
  assert.match(text, /paths:\s*\[[^\]]*\bpackage\.json\b[^\]]*\]/);
  assert.doesNotMatch(text, /^\s+pull_request/m);
});

test("npm.yml tests on Windows and Ubuntu with Node 22, and the publish job needs the tests", () => {
  const text = readWorkflow("npm.yml");
  const tests = jobBlock(text, "test");
  assert.match(tests, /os:\s*\[[^\]]*\bwindows-latest\b[^\]]*\]/);
  assert.match(tests, /os:\s*\[[^\]]*\bubuntu-latest\b[^\]]*\]/);
  assert.ok(hasRunStep(tests, "npm ci"), "the test job must run npm ci");
  assert.ok(hasRunStep(tests, "npm run typecheck"), "the test job must run npm run typecheck");
  assert.ok(hasRunStep(tests, "npm test"), "the test job must run npm test");
  const versions = nodeVersions(text);
  assert.ok(versions.length > 0, "npm.yml must set node-version");
  for (const version of versions) assert.equal(version, "22");
  assert.match(jobBlock(text, "publish"), /^\s+needs:.*\btest\b/m);
});

test("npm.yml decides from git, not from the registry, whether a push carries a new version", () => {
  const text = readWorkflow("npm.yml");
  const check = jobBlock(text, "check-version");
  assert.match(check, /fetch-depth:\s*0\b/, "check-version must fetch the history to read the previous version");
  assert.match(check, /github\.event\.before/, "check-version must compare with the commit before the push");
  assert.match(text, /git show\b/, "npm.yml must read the previous package.json with git show");
  assert.doesNotMatch(text, /\bnpm\s+(view|info|search|access|owner|whoami)\b/, "npm.yml must not call the npm registry");
});

test("npm.yml grants id-token write and no other write permission", () => {
  const text = readWorkflow("npm.yml");
  const writes = text.split(/\r?\n/).filter((line) => /:\s*write\s*$/.test(line));
  assert.ok(writes.length > 0, "the publish job must have a write permission");
  for (const line of writes) {
    assert.match(line, /^\s*id-token:\s*write\s*$/, `"${line.trim()}" is a write permission other than id-token`);
  }
  assert.match(jobBlock(text, "publish"), /^\s+id-token:\s*write\s*$/m);
  assert.doesNotMatch(text, /write-all/);
});

test("npm.yml pins npm 11.5.1 or newer, installs dependencies, and publishes with provenance", () => {
  const publish = jobBlock(readWorkflow("npm.yml"), "publish");
  const pin = /npm install -g npm@(\d+)\.(\d+)\.(\d+)\s*$/m.exec(publish);
  assert.ok(pin, "the publish job must install npm with npm install -g npm@<version>");
  const [major = 0, minor = 0, patch = 0] = [pin[1], pin[2], pin[3]].map((part) => Number(part));
  const atLeast = major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1)));
  assert.ok(atLeast, `npm must be 11.5.1 or newer, found ${major}.${minor}.${patch}`);
  assert.doesNotMatch(publish, /npm@latest/);
  assert.ok(hasRunStep(publish, "npm ci"), "the publish job must run npm ci, because the prepack step builds the package");
  assert.ok(hasRunStep(publish, "npm publish --provenance"), "the publish job must run npm publish --provenance");
});

test("npm.yml holds no npm token and reads no secret", () => {
  const text = readWorkflow("npm.yml");
  assert.doesNotMatch(text, /NPM_TOKEN/);
  assert.doesNotMatch(text, /NODE_AUTH_TOKEN/);
  assert.doesNotMatch(text, /secrets\./);
});

test("npm.yml publishes only in the owner's repository, and only when the version is new", () => {
  const text = readWorkflow("npm.yml");
  const guard = `github.repository == '${PUBLISH_REPO}'`;
  assert.ok(jobIf(jobBlock(text, "check-version")).includes(guard), "check-version must name the owner's repository in its if:");
  const publishIf = jobIf(jobBlock(text, "publish"));
  assert.ok(publishIf.includes(guard), "publish must name the owner's repository in its if:");
  assert.ok(
    publishIf.includes("needs.check-version.outputs.publish == 'true'"),
    "publish must run only when check-version finds a new version",
  );
});

test("npm.yml says at its top that it is written and not run, and that the first publish is the owner's", () => {
  const header = readWorkflow("npm.yml").split(/\r?\n/).slice(0, 20).join("\n");
  assert.match(header, /not run/i);
  assert.match(header, /trusted publisher/i);
  assert.match(header, /terminal/i);
});

test("npm.yml uses only the action pins that ci.yml uses", () => {
  const pinned = new Set(usesValues(readWorkflow("ci.yml")));
  for (const value of usesValues(readWorkflow("npm.yml"))) {
    assert.ok(pinned.has(value), `"${value}" must be one of the pins ci.yml uses`);
  }
});
