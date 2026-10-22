import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { antigravityAdapter } from "../agents/antigravity.js";
import { claudeAdapter } from "../agents/claude.js";
import { codexAdapter } from "../agents/codex.js";
import type { CommandResult, Runner } from "../agents/command.js";
import { opencodeAdapter } from "../agents/opencode.js";
import { type Action, runPlan } from "../agents/plan.js";
import type { Scope } from "../agents/scopes.js";
import { SKILL_NAME } from "../agents/skill.js";
import { type AgentId, statePath } from "../agents/state.js";
import { type Context, makeContext } from "../agents/types.js";
import { ISOLATED_VARIABLES, assertIsolated, inTemporaryRoot } from "./isolation.js";

const ADAPTERS = [codexAdapter, opencodeAdapter, antigravityAdapter, claudeAdapter];
const AGENTS: readonly AgentId[] = ["codex", "opencode", "antigravity", "claude"];
const SCOPES: readonly Scope[] = ["global", "project", "local"];

// Uninstall and update run first with no record, then install runs, then the same actions run again with a record.
const ORDER: readonly Action[] = ["uninstall", "update", "install", "doctor", "update", "uninstall", "doctor"];

// The variables that locate the agents' folders and the data folder. Each one must point inside the temporary root during the run,
// so an adapter that reads them cannot reach a real folder. All seven isolated names are listed, and each is checked before each plan.
const LOCATING_VARIABLES = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "MULTI_ACCOUNT_SUPABASE_HOME",
] as const;

// The packaged skill text. The skill steps read it from the package folder of the temporary root.
const SKILL_TEXT = "---\nname: supabase-accounts\ndescription: Fixture for the no-real-config test.\n---\n\nFixture body.\n";

// Answers every command with success and no output, so no agent CLI runs.
const fakeCommand: Runner = async (): Promise<CommandResult> => ({ code: 0, stdout: "", stderr: "" });

// Whether a path is strictly inside a root. A relative path is resolved against the working folder, so it is outside the root.
const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, path.resolve(target));
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

// The prefixes of the shown lines that name a path. The context writes "remove empty folder" before "remove", so the longer
// prefix is listed first.
const PATH_PREFIXES = ["write ", "mkdir ", "remove empty folder ", "remove ", "cwd "];

// The paths that the shown lines name: each file or folder that is written, removed or made, and each folder a command runs in.
const pathsShown = (lines: readonly string[]): string[] =>
  lines.flatMap((line) => {
    const prefix = PATH_PREFIXES.find((candidate) => line.startsWith(candidate));
    return prefix === undefined ? [] : [line.slice(prefix.length)];
  });

// Wraps a context so that every path its file functions and folder commands receive is recorded.
const recording = (ctx: Context, touched: string[]): Context => ({
  ...ctx,
  run: (command, args, options) => {
    if (options?.cwd !== undefined) {
      touched.push(options.cwd);
    }
    return ctx.run(command, args, options);
  },
  writeFile: (file, text) => {
    touched.push(file);
    return ctx.writeFile(file, text);
  },
  removeFile: (file) => {
    touched.push(file);
    return ctx.removeFile(file);
  },
  ensureDir: (dir) => {
    touched.push(dir);
    return ctx.ensureDir(dir);
  },
  removeDirIfEmpty: (dir) => {
    touched.push(dir);
    return ctx.removeDirIfEmpty(dir);
  },
});

// Asserts that each locating variable points inside the root. It runs before each plan, so a variable changed during the run
// is caught.
const assertLocatingInside = (root: string): void => {
  for (const name of LOCATING_VARIABLES) {
    const value = process.env[name];
    assert.ok(value !== undefined && isInside(root, value), `${name} points inside the temporary root`);
  }
};

test("the locating names checked before each plan are the seven isolated names, so none can be dropped unnoticed", () => {
  assert.deepEqual([...LOCATING_VARIABLES].sort(), [...ISOLATED_VARIABLES].sort());
});

test("no adapter writes outside the temporary folders", async () => {
  await inTemporaryRoot(async (root) => {
    assertIsolated(root);
    const project = path.join(root, "project");
    const packageRoot = path.join(root, "package");
    const cliPath = path.join(packageRoot, "dist", "cli.js");
    await mkdir(project, { recursive: true });
    await mkdir(path.join(packageRoot, "skills", SKILL_NAME), { recursive: true });
    await writeFile(path.join(packageRoot, "skills", SKILL_NAME, "SKILL.md"), SKILL_TEXT);

    const touched: string[] = [];
    const run = async (action: Action, scope: Scope): Promise<void> => {
      assertLocatingInside(root);
      const ctx = recording(
        makeContext({ projectDir: project, cliPath, packageRoot, dryRun: false, present: () => true, run: fakeCommand }),
        touched,
      );
      const result = await runPlan({ adapters: ADAPTERS, action, scope, ctx });
      touched.push(...pathsShown(result.shown));
    };
    for (const scope of SCOPES) {
      for (const action of ORDER) {
        await run(action, scope);
      }
    }

    // A run that touched nothing would pass the checks below without testing anything.
    assert.ok(touched.length > 0, "the run wrote, removed or made at least one path");
    for (const target of touched) {
      assert.ok(isInside(root, target), `${target} is inside the temporary root`);
    }
    for (const agent of AGENTS) {
      assert.ok(isInside(root, statePath(agent)), `the record of ${agent} is inside the temporary root`);
    }
  });
});
