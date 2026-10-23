import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The compiled test sits in dist/test, so the repository root is two folders up.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const ROOT_DOCS = ["README.md", "CHANGELOG.md", "CONTRIBUTING.md", "SECURITY.md"];
const REPO_BLOB = "https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main";
const LINK = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL = /^[a-z][a-z0-9+.-]*:/i;
const FILE_TEXT = /^(?:\.{0,2}\/)?(?:[\w.-]+\/)*[\w.-]+\.(?:md|json|ts|js|mjs|cjs|yml|yaml|toml|txt)$/;

interface Line {
  no: number;
  text: string;
}

interface Link {
  file: string;
  line: number;
  text: string;
  target: string;
}

// The files the check covers: the four root documents and every .md file directly under docs/.
// docs/research and docs/superpowers are not read.
function scopeFiles(): string[] {
  const docsDir = join(root, "docs");
  const docs = readdirSync(docsDir)
    .filter((name) => name.endsWith(".md") && statSync(join(docsDir, name)).isFile())
    .map((name) => `docs/${name}`);
  return [...ROOT_DOCS, ...docs];
}

// The lines of a file outside fenced code blocks.
function proseLines(file: string): Line[] {
  const lines = readFileSync(join(root, file), "utf8").split(/\r?\n/);
  const out: Line[] = [];
  let inFence = false;
  lines.forEach((text, index) => {
    if (/^\s*(```|~~~)/.test(text)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) out.push({ no: index + 1, text });
  });
  return out;
}

// GitHub's anchor rule: a link keeps its text, the text goes to lower case,
// characters other than letters, digits, spaces, hyphens and underscores are removed,
// and each space becomes a hyphen.
function githubSlug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, "")
    .replace(/ /g, "-");
}

// The anchors of a Markdown file. A repeated heading gets -1, -2 and so on, as on GitHub.
function anchorsOf(file: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of proseLines(file)) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line.text);
    if (!match) continue;
    const base = githubSlug(match[1] ?? "");
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function linksOf(file: string): Link[] {
  const links: Link[] = [];
  for (const line of proseLines(file)) {
    for (const match of line.text.matchAll(LINK)) {
      links.push({ file, line: line.no, text: match[2] ?? "", target: match[3] ?? "" });
    }
  }
  return links;
}

// The text of a "## <heading>" section, from its heading to the next "## " heading.
// Undefined when the file has no such heading.
function sectionText(file: string, heading: string): string | undefined {
  const lines = proseLines(file);
  const start = lines.findIndex((line) => line.text.trim() === `## ${heading}`);
  if (start === -1) return undefined;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.text.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).map((line) => line.text).join("\n");
}

function repoPath(abs: string): string {
  return relative(root, abs).split(sep).join("/");
}

// Returns a problem for a relative link, or undefined when it resolves.
function relativeLinkProblem(link: Link): string | undefined {
  const hash = link.target.indexOf("#");
  const pathPart = hash === -1 ? link.target : link.target.slice(0, hash);
  const fragment = hash === -1 ? "" : link.target.slice(hash + 1);
  const from = join(root, link.file);
  const abs = pathPart === "" ? from : resolve(dirname(from), pathPart);
  if (!existsSync(abs)) return "the target file does not exist";
  if (fragment !== "" && abs.endsWith(".md")) {
    if (!anchorsOf(repoPath(abs)).has(fragment)) return `no heading gives the anchor #${fragment}`;
  }
  return undefined;
}

// A link text that names a file must name one that exists, next to the document or at the root.
function linkTextProblem(link: Link): string | undefined {
  const name = link.text.replace(/`/g, "").trim();
  if (!FILE_TEXT.test(name)) return undefined;
  const here = dirname(join(root, link.file));
  const found = existsSync(resolve(here, name)) || existsSync(join(root, name));
  return found ? undefined : `the link text names "${name}", which does not exist`;
}

function describe(link: Link, problem: string): string {
  return `${link.file}:${link.line}: ${problem} (${link.target})`;
}

test("every relative link in the scope files resolves, and each anchor names a heading", (t) => {
  const problems: string[] = [];
  let relativeCount = 0;
  let inPageCount = 0;
  for (const file of scopeFiles()) {
    for (const link of linksOf(file)) {
      if (EXTERNAL.test(link.target)) continue;
      if (link.target.startsWith("#")) {
        inPageCount += 1;
        if (!anchorsOf(file).has(link.target.slice(1))) {
          problems.push(describe(link, "no heading in this file gives that anchor"));
        }
        continue;
      }
      relativeCount += 1;
      const problem = relativeLinkProblem(link);
      if (problem) problems.push(describe(link, problem));
    }
  }
  t.diagnostic(
    `scope files: ${scopeFiles().length}; relative links: ${relativeCount}; in-page anchors: ${inPageCount}`,
  );
  assert.deepEqual(problems, []);
});

test("every link text that names a file resolves", () => {
  const problems: string[] = [];
  for (const file of scopeFiles()) {
    for (const link of linksOf(file)) {
      const problem = linkTextProblem(link);
      if (problem) problems.push(describe(link, problem));
    }
  }
  assert.deepEqual(problems, []);
});

test("README links are absolute https URLs, or in-page anchors", () => {
  // npm shows the README without the repository's files, so a relative link breaks there.
  const problems: string[] = [];
  for (const link of linksOf("README.md")) {
    if (link.target.startsWith("#")) continue;
    if (!/^https:\/\//.test(link.target)) {
      problems.push(describe(link, "the README link is not an absolute https URL"));
    }
  }
  assert.deepEqual(problems, []);
});

test("README.md links to docs/USAGE.md", () => {
  const usage = `${REPO_BLOB}/docs/USAGE.md`;
  assert.ok(
    linksOf("README.md").some((link) => link.target === usage),
    `README.md has no link to ${usage}`,
  );
});

test("every non-anchor link in README.md starts with the repository's blob URL", () => {
  const problems = linksOf("README.md")
    .filter((link) => !link.target.startsWith("#") && !link.target.startsWith(`${REPO_BLOB}/`))
    .map((link) => describe(link, `the README link does not start with ${REPO_BLOB}/`));
  assert.deepEqual(problems, []);
});

test("README.md has a Documentation section", () => {
  assert.ok(
    sectionText("README.md", "Documentation") !== undefined,
    'README.md has no "Documentation" section, so the links to the docs pages are missing',
  );
});

test("the Documentation section marks the links as not verified", () => {
  const section = sectionText("README.md", "Documentation") ?? "";
  assert.ok(
    section.includes("Not verified: the repository does not exist yet"),
    'the "Documentation" section has no "Not verified: the repository does not exist yet" mark',
  );
});

test("a link text that names a .md file matches the end of its target", () => {
  const problems: string[] = [];
  for (const file of scopeFiles()) {
    for (const link of linksOf(file)) {
      const text = link.text.replace(/`/g, "").trim();
      if (!text.endsWith(".md")) continue;
      const parts = (link.target.split("#")[0] ?? "").split("/");
      const tail = parts.slice(Math.max(0, parts.length - text.split("/").length)).join("/");
      if (tail !== text) {
        problems.push(describe(link, `the link text is "${text}", but the target ends in "${tail}"`));
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("githubSlug follows GitHub's anchor rule", () => {
  assert.equal(githubSlug("Exit codes"), "exit-codes");
  assert.equal(githubSlug("add <name> --pat"), "add-name---pat");
  assert.equal(githubSlug("`install [agent...]`"), "install-agent");
  assert.equal(githubSlug("[Interrupts](#interrupts)"), "interrupts");
});
