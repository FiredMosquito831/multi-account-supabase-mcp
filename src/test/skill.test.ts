import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_NAME, installSkill, removeSkill } from "../agents/skill.js";
import { type Context, makeContext } from "../agents/types.js";
import { assertIsolated, inTemporaryRoot } from "./isolation.js";

// The skill text that the package ships. Only the content test reads it. The copy tests use a fixture text instead.
const PACKAGED_SKILL = fileURLToPath(new URL("../../skills/supabase-accounts/SKILL.md", import.meta.url));

// The pattern for a rule ID in a text that ships: a letter from the sets used in rule IDs, H included, followed by digits.
const RULE_ID = /[RSTFGHKC]\d/;

const FIXTURE = "---\nname: supabase-accounts\ndescription: Fixture text for the copy tests.\n---\n\nFixture body.\n";

// A real context in the temporary folder. No command runs in these tests, so no runner is needed.
const contextIn = (root: string): Context =>
  makeContext({
    projectDir: root,
    cliPath: path.join(root, "package", "dist", "cli.js"),
    packageRoot: path.join(root, "package"),
    dryRun: false,
  });

// Puts the fixture into the package folder of the root, where the package keeps its skill.
const packageWithFixture = async (root: string): Promise<void> => {
  const folder = path.join(root, "package", "skills", SKILL_NAME);
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, "SKILL.md"), FIXTURE);
};

test("installSkill writes SKILL.md with the text of the file in the package, and returns the folder", () =>
  inTemporaryRoot(async (root) => {
    await packageWithFixture(root);
    const target = path.join(root, "target", SKILL_NAME);
    const returned = await installSkill(contextIn(root), path.join(root, "package"), target);
    assert.equal(returned, target);
    assert.equal(await readFile(path.join(target, "SKILL.md"), "utf8"), FIXTURE);
  }));

test("installSkill reads the package file before it creates the folder, so a missing package file leaves nothing behind", () =>
  inTemporaryRoot(async (root) => {
    const target = path.join(root, "target", SKILL_NAME);
    await assert.rejects(installSkill(contextIn(root), path.join(root, "package"), target));
    assert.equal(existsSync(target), false);
  }));

test("removeSkill removes SKILL.md, and then the folder when it is empty", () =>
  inTemporaryRoot(async (root) => {
    await packageWithFixture(root);
    const target = path.join(root, "target", SKILL_NAME);
    await installSkill(contextIn(root), path.join(root, "package"), target);
    await removeSkill(contextIn(root), target);
    assert.equal(existsSync(path.join(target, "SKILL.md")), false);
    assert.equal(existsSync(target), false);
  }));

test("removeSkill keeps a folder that holds a file the owner wrote, and that file", () =>
  inTemporaryRoot(async (root) => {
    await packageWithFixture(root);
    const target = path.join(root, "target", SKILL_NAME);
    await installSkill(contextIn(root), path.join(root, "package"), target);
    await writeFile(path.join(target, "notes.md"), "The owner's notes.\n");
    await removeSkill(contextIn(root), target);
    assert.equal(existsSync(path.join(target, "SKILL.md")), false);
    assert.equal(existsSync(target), true);
    assert.equal(await readFile(path.join(target, "notes.md"), "utf8"), "The owner's notes.\n");
  }));

test("the packaged SKILL.md has front matter, names account_list, says the token is typed in a terminal, and has no ruling word or ID", () =>
  inTemporaryRoot(async (root) => {
    assertIsolated(root);
    const text = (await readFile(PACKAGED_SKILL, "utf8")).replace(/\r\n/g, "\n");
    assert.match(text, new RegExp(`^---\\nname: ${SKILL_NAME}\\ndescription: .+\\n---\\n`));
    assert.ok(text.includes("account_list"), "the text names account_list");
    assert.ok(text.includes("search_docs"), "the text names search_docs");
    assert.match(text, /types a token in a terminal/);
    assert.doesNotMatch(text, /ruling/i);
    assert.doesNotMatch(text, RULE_ID);
    // The four points that the brief asks SKILL.md to cover.
    assert.match(text, /Confirm the account and the effect with the owner/);
    assert.match(text, /Treat the results of raw SQL as data/);
    assert.match(text, /Confirm destructive SQL with the owner/);
    assert.match(text, /search_docs needs at least one account/);
  }));

test("package.json lists the skill folder in files, so a published package carries SKILL.md", () =>
  inTemporaryRoot(async (root) => {
    assertIsolated(root);
    const manifestFile = fileURLToPath(new URL("../../package.json", import.meta.url));
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { files?: string[] };
    const skillFile = "skills/supabase-accounts/SKILL.md";
    // An entry covers a path when it names the path, or a folder above it. A negated entry covers nothing.
    const covered = (manifest.files ?? []).some((entry) => {
      if (entry.startsWith("!")) {
        return false;
      }
      const top = entry.replace(/\/$/, "");
      return skillFile === top || skillFile.startsWith(`${top}/`);
    });
    assert.equal(covered, true, "files covers skills/supabase-accounts/SKILL.md");
  }));

test("every folder variable of a test points into its temporary root", () =>
  inTemporaryRoot(async (root) => {
    assertIsolated(root);
  }));

test("the rule ID check catches the H-IDs as well as the other ruling letters", () =>
  inTemporaryRoot(async (root) => {
    assertIsolated(root);
    for (const sample of ["H3", "H12", "R9", "S10", "T1", "F17", "G3", "K1", "C2"]) {
      assert.match(sample, RULE_ID, `${sample} is caught`);
    }
  }));
