import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The compiled test sits in dist/test, so the repository root is two folders up.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Folders the walk never enters, whatever the package lists.
const SKIPPED_NAMES = new Set([".git", ".superpowers", "node_modules"]);
// Public documents that npm pack may not list, read in full.
const PUBLIC_DOCUMENTS = ["package.json", "README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md"];
// The research and plan folders under docs/. They are not public and are not read.
const UNSCANNED_DOCS = ["docs/research", "docs/superpowers"];
const ALLOWED_DOMAIN = "example.com";

interface Pattern {
  kind: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  { kind: "personal path", re: /[A-Za-z]:[\\/]+users[\\/]/gi },
  { kind: "personal path", re: /[\\/]Users[\\/]+[^\s\\/"'`]/g },
  { kind: "personal path", re: /\/home\/[^\s/"'`]/g },
  { kind: "token-shaped text", re: /sbp_[A-Za-z0-9]+/g },
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_RUN = /[A-Za-z0-9]{24,}/g;
const URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g;

// The entries of the files list in package.json: the shipped entries, and the "!" exclusions.
function packedEntries(): { entries: string[]; excluded: string[] } {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { files?: string[] };
  const list = pkg.files ?? [];
  return {
    entries: list.filter((entry) => !entry.startsWith("!")).map((entry) => entry.replace(/\/$/, "")),
    excluded: list
      .filter((entry) => entry.startsWith("!"))
      .map((entry) => entry.slice(1).replace(/\/$/, "")),
  };
}

// Adds a file, or every file under a folder, unless it is skipped or excluded.
function addEntry(rel: string, excluded: string[], out: Set<string>): void {
  if (SKIPPED_NAMES.has(rel.split("/").pop() ?? "")) return;
  if (excluded.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) return;
  const abs = join(root, rel);
  if (!existsSync(abs)) return;
  if (statSync(abs).isDirectory()) {
    for (const name of readdirSync(abs)) addEntry(`${rel}/${name}`, excluded, out);
  } else {
    out.add(rel);
  }
}

// What npm pack ships (the files list, with dist without dist/test), the public documents,
// and docs/ without the two research folders.
function scannedFiles(): string[] {
  const { entries, excluded } = packedEntries();
  const out = new Set<string>();
  for (const entry of entries) addEntry(entry, excluded, out);
  for (const doc of PUBLIC_DOCUMENTS) addEntry(doc, [], out);
  addEntry("docs", UNSCANNED_DOCS, out);
  return [...out].sort();
}

// The text of a file, or undefined for a binary file (a NUL byte in its first 8000 bytes).
function readText(file: string): string | undefined {
  const bytes = readFileSync(join(root, file));
  if (bytes.subarray(0, 8000).includes(0)) return undefined;
  return bytes.toString("utf8");
}

// A long run is a secret-like string only when it has both a digit and a letter.
function isMixed(run: string): boolean {
  return /[0-9]/.test(run) && /[A-Za-z]/.test(run);
}

// A 40-character hex SHA in a workflow, and an integrity line in package-lock.json, are not secrets.
function allowedRun(file: string, run: string, line: string): boolean {
  if (/^\.github\/workflows\/[^/]+\.ya?ml$/.test(file) && /^[0-9a-f]{40}$/.test(run)) return true;
  return file === "package-lock.json" && line.includes('"integrity"');
}

// Each problem names the file, the line and the first 20 characters of the match, and nothing more.
function problemsIn(file: string, text: string): string[] {
  const out: string[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    const report = (kind: string, match: string): void => {
      out.push(`${where}: ${kind}: "${match.slice(0, 20)}"`);
    };
    for (const { kind, re } of PATTERNS) {
      for (const match of line.matchAll(re)) report(kind, match[0]);
    }
    for (const match of line.matchAll(EMAIL)) {
      const domain = match[0].slice(match[0].indexOf("@") + 1).toLowerCase();
      if (domain !== ALLOWED_DOMAIN) report("email address", match[0]);
    }
    // A URL may hold a long run (a commit hash, a package name), so it is removed first.
    // A long run counts only when it has a digit and a letter: a long name such as an identifier has no digit.
    for (const match of line.replace(URL, " ").matchAll(LONG_RUN)) {
      if (!isMixed(match[0])) continue;
      if (!allowedRun(file, match[0], line)) report("long run of letters and digits", match[0]);
    }
  });
  return out;
}

test("no shipped or public file holds a personal path, an email address or token-shaped text", () => {
  const files = scannedFiles();
  assert.ok(files.includes("README.md"), "the scan must include README.md");
  assert.ok(files.includes("dist/cli.js"), "the scan must include the built command");
  const problems: string[] = [];
  for (const file of files) {
    const text = readText(file);
    if (text !== undefined) problems.push(...problemsIn(file, text));
  }
  assert.equal(problems.length, 0, `${problems.length} match(es):\n${problems.join("\n")}`);
});

test("the check flags a personal path, an address at another domain, a token and a long run", () => {
  const flagged = (text: string): number => problemsIn("sample.md", text).length;
  const token = "sbp_" + "0".repeat(40);
  assert.ok(flagged(`path C:\\Users\\sample\\app`) > 0);
  assert.ok(flagged(`see /home/sample/app`) > 0);
  assert.ok(flagged(`mail sample.user@fake-domain.invalid now`) > 0);
  assert.ok(flagged(`token ${token}`) > 0);
  assert.ok(flagged(`run ${"b1".repeat(15)}`) > 0);
});

test("the check passes example.com, a GitHub URL and a short word", () => {
  const flagged = (text: string): number => problemsIn("sample.md", text).length;
  assert.equal(flagged(`mail sample.user@example.com now`), 0);
  assert.equal(flagged(`see https://github.com/FiredMosquito831/${"a".repeat(40)}`), 0);
  assert.equal(flagged(`run ${"b".repeat(20)}`), 0);
});

test("the long-run rule ignores a long name with no digit and catches a long mixed run with a digit", () => {
  const flagged = (text: string): number => problemsIn("sample.md", text).length;
  assert.equal(flagged(`call NoDefaultCurrentDirectoryInExePath here`), 0);
  assert.equal(flagged(`option windowsVerbatimArguments here`), 0);
  assert.ok(flagged(`value a1${"b".repeat(30)} here`) > 0);
});
