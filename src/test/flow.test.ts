import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Runner } from "../agents/command.js";
import type { Scope } from "../agents/scopes.js";
import { type AgentId, type Item, record, recordedItems, scopeKey, statePath } from "../agents/state.js";
import { type AgentAdapter, type Context, type Step } from "../agents/types.js";
import { type FlowIo, doctor, install, uninstall, update } from "../install/flow.js";
import { MemoryTokenStore, type TokenStore } from "../secrets/token-store.js";
import { assertIsolated, inTemporaryRoot } from "./isolation.js";

// A placeholder for a token in the fake store. It is not a token. No output may hold it.
const PLACEHOLDER = "TEST-ONLY-VALUE";
const APPLY_QUESTION = "Apply these changes? [y/N] ";

// Runs one test in a temporary root, with every home, configuration and data name pointing into it.
const inRoot = (run: (root: string) => Promise<void>): Promise<void> =>
  inTemporaryRoot(async (root) => {
    assertIsolated(root);
    await run(root);
  });

// A fake agent. Each call is logged. Its steps are ok, or skipped when skips is set, and it runs no command. Its only file change
// is the file it is given, so a dry run is seen to write nothing. With throws set, every action throws.
interface FakeOptions {
  throws?: boolean;
  writes?: string;
  skips?: boolean;
  failsInDryRun?: boolean;
}

const fakeAgent = (id: AgentId, scopes: readonly Scope[], calls: string[], options: FakeOptions = {}): AgentAdapter => {
  const change =
    (action: "install" | "update" | "uninstall") =>
    async (ctx: Context, scope: Scope): Promise<Step[]> => {
      // The pass is part of the call, so a test can tell a dry pass from a real one.
      calls.push(`${action} ${id} ${scope} ${ctx.dryRun ? "dry" : "real"}`);
      if (options.failsInDryRun === true && ctx.dryRun) {
        throw new Error("dry pass fails");
      }
      if (options.throws === true) {
        throw new Error("boom");
      }
      if (options.writes !== undefined) {
        await ctx.writeFile(options.writes, "fake\n");
      }
      const status: Step["status"] = options.skips === true ? "skipped" : "ok";
      return [{ agent: id, scope, status, message: ctx.dryRun ? `Would ${action} ${id}.` : `Did ${action} ${id}.` }];
    };
  return {
    id,
    scopes,
    present: () => true,
    install: change("install"),
    update: change("update"),
    uninstall: change("uninstall"),
    doctor: async () => {
      calls.push(`doctor ${id}`);
      if (options.throws === true) {
        throw new Error("boom");
      }
      return [{ agent: id, scope: "global", status: "ok", message: "Doctor found it." }];
    },
  };
};

// The fake command runner. No test may run a command, so a call to it fails the test.
const noCommands: Runner = async () => {
  throw new Error("no command runs in this test");
};

interface Harness {
  io: FlowIo;
  lines: string[];
  asked: string[];
}

// The io object for a test. Terminal answers are taken in order, and each question is recorded. With askFails set, every
// question is rejected, as when the input closes.
const harness = (
  root: string,
  adapters: readonly AgentAdapter[],
  terminal: { isTerminal?: boolean; answers?: string[]; askFails?: boolean; badAnswer?: boolean } = {},
): Harness => {
  const lines: string[] = [];
  const asked: string[] = [];
  const answers = [...(terminal.answers ?? [])];
  const io: FlowIo = {
    isTerminal: terminal.isTerminal ?? false,
    ask: async (question) => {
      asked.push(question);
      if (terminal.askFails === true) {
        throw new Error("input closed");
      }
      if (terminal.badAnswer === true) {
        // An answer that is not text, as a caller could pass when the type is not checked.
        return null as unknown as string;
      }
      return answers.shift() ?? "";
    },
    out: (line) => {
      lines.push(line);
    },
    cliPath: path.join(root, "package", "dist", "cli.js"),
    packageRoot: path.join(root, "package"),
    projectDir: path.join(root, "project"),
    homeDir: path.join(root, "home"),
    env: process.env,
    tokens: new MemoryTokenStore(),
    adapters,
    run: noCommands,
    present: () => true,
  };
  return { io, lines, asked };
};

// Writes an accounts file in the data folder of the test. The records hold no token.
const writeAccounts = async (root: string, names: string[]): Promise<void> => {
  const dataDir = path.join(root, "data");
  await mkdir(dataDir, { recursive: true });
  const accounts = names.map((name, index) => ({
    name,
    email: `${name}@example.test`,
    gotrueId: `user-${index}`,
    added: "pat",
    addedAt: "2026-10-20T00:00:00.000Z",
  }));
  await writeFile(path.join(dataDir, "accounts.json"), `${JSON.stringify({ default: names[0] ?? null, accounts }, null, 2)}\n`);
};

// The server item that a successful step records for the io's command line path.
const serverOf = (io: FlowIo): Item => ({ kind: "server", cliPath: io.cliPath });

test("install with --dry-run prints the command and file lines, writes no file, and returns 0", () =>
  inRoot(async (root) => {
    const target = path.join(root, "would-write.txt");
    const calls: string[] = [];
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], calls, { writes: target })]);
    assert.equal(await install({ agents: ["claude"], dryRun: true }, io), 0);
    assert.equal(existsSync(target), false);
    assert.equal(
      lines.some((line) => line.includes(`write ${target}`)),
      true,
    );
    assert.equal(
      lines.some((line) => line.includes("Would install claude.")),
      true,
    );
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
  }));

test("a dry run whose plan has an error row exits 1, so a script sees that the real run would fail", () =>
  inRoot(async (root) => {
    const { io, lines } = harness(root, [fakeAgent("codex", ["global"], [], { throws: true })]);
    assert.equal(await install({ agents: ["codex"], dryRun: true }, io), 1);
    assert.equal(
      lines.some((line) => line.startsWith("[error] codex global: boom")),
      true,
    );
    assert.deepEqual(await recordedItems("codex", scopeKey("global", io.projectDir)), []);
  }));

test("a dry run whose plan has no error row exits 0", () =>
  inRoot(async (root) => {
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [])]);
    assert.equal(await install({ agents: ["claude"], dryRun: true }, io), 0);
    assert.equal(
      lines.some((line) => line.startsWith("[error]")),
      false,
    );
  }));

test("install without a terminal and without --yes returns 2 and writes nothing", () =>
  inRoot(async (root) => {
    const target = path.join(root, "would-write.txt");
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [], { writes: target })]);
    assert.equal(await install({ agents: ["claude"] }, io), 2);
    assert.equal(existsSync(target), false);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
    assert.equal(
      lines.some((line) => line.includes("--yes")),
      true,
    );
  }));

test("install with --yes records the command line path for each agent that succeeded, in the scope named", () =>
  inRoot(async (root) => {
    const { io } = harness(root, [
      fakeAgent("claude", ["global", "project", "local"], []),
      fakeAgent("codex", ["global", "project"], []),
    ]);
    assert.equal(await install({ scope: "project", yes: true }, io), 0);
    const key = scopeKey("project", io.projectDir);
    assert.deepEqual(await recordedItems("claude", key), [serverOf(io)]);
    assert.deepEqual(await recordedItems("codex", key), [serverOf(io)]);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
  }));

test("update and uninstall with --yes return 2, and no agent is called", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], calls)]);
    assert.equal(await update({ yes: true }, io), 2);
    assert.equal(await uninstall({ yes: true }, io), 2);
    assert.deepEqual(calls, []);
    assert.equal(
      lines.filter((line) => line.includes("--yes")).length,
      2,
    );
  }));

test("uninstall without --yes asks no question and runs the agent's uninstall, which returns 0", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io, asked, lines } = harness(root, [fakeAgent("claude", ["global"], calls)], { isTerminal: true });
    await record("claude", scopeKey("global", io.projectDir), { kind: "mcp-entry", name: "recorded" });
    assert.equal(await uninstall({}, io), 0);
    assert.deepEqual(asked, []);
    assert.equal(calls.includes("uninstall claude global real"), true);
    assert.equal(lines.includes("[ok] claude global: Did uninstall claude."), true);
  }));

test("uninstall with no record changes no file, runs no agent, and says that nothing was removed", () =>
  inRoot(async (root) => {
    const target = path.join(root, "would-remove.txt");
    const calls: string[] = [];
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], calls, { writes: target })]);
    assert.equal(await uninstall({ agents: ["claude"] }, io), 0);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(target), false);
    assert.equal(
      lines.some((line) => line.startsWith("Nothing to uninstall")),
      true,
    );
  }));

test("update of a recorded scope replaces the recorded command line path with the current one", () =>
  inRoot(async (root) => {
    const { io } = harness(root, [fakeAgent("claude", ["global"], [])]);
    const key = scopeKey("global", io.projectDir);
    await record("claude", key, { kind: "server", cliPath: path.join(root, "old", "dist", "cli.js") });
    assert.equal(await update({}, io), 0);
    assert.deepEqual(await recordedItems("claude", key), [serverOf(io)]);
  }));

test("doctor reports a recorded command line path that no longer exists as an error, and returns 1", () =>
  inRoot(async (root) => {
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [])]);
    const missing = path.join(root, "gone", "dist", "cli.js");
    await record("claude", scopeKey("global", io.projectDir), { kind: "server", cliPath: missing });
    assert.equal(await doctor(io), 1);
    assert.equal(
      lines.some((line) => line.includes(`cliPath does not exist: ${missing}. Run update to refresh it.`)),
      true,
    );
  }));

test("doctor reports an account with no token as an error that names the account, returns 1, and prints no token", () =>
  inRoot(async (root) => {
    await writeAccounts(root, ["work", "spare"]);
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [])]);
    await io.tokens.set("work", PLACEHOLDER);
    assert.equal(await doctor(io), 1);
    assert.equal(
      lines.some((line) => line.includes("account spare") && line.includes("no token in the store")),
      true,
    );
    assert.equal(
      lines.some((line) => line.includes("account work") && line.includes("no token in the store")),
      false,
    );
    assert.equal(lines.join("\n").includes(PLACEHOLDER), false);
  }));

test("doctor reports an accounts file it cannot read by its path and reason only, as an error, and returns 1", () =>
  inRoot(async (root) => {
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const file = path.join(dataDir, "accounts.json");
    await writeFile(file, "NOT-JSON-TEST-ONLY");
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [])]);
    assert.equal(await doctor(io), 1);
    assert.equal(
      lines.some((line) => line.startsWith("[error] accounts:") && line.includes(file) && line.includes("(not valid JSON)")),
      true,
    );
    assert.equal(lines.join("\n").includes("NOT-JSON-TEST-ONLY"), false);
  }));

test("doctor reports a token store that fails as 'the token could not be checked' with the account name, and never prints its message", () =>
  inRoot(async (root) => {
    await writeAccounts(root, ["work"]);
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [])]);
    const failing: TokenStore = {
      get: async () => {
        throw new Error("STORE-ERROR-TEST-ONLY");
      },
      set: async () => {},
      delete: async () => {},
    };
    io.tokens = failing;
    assert.equal(await doctor(io), 1);
    assert.equal(
      lines.some((line) => line === "[error] account work: the token could not be checked."),
      true,
    );
    assert.equal(lines.join("\n").includes("STORE-ERROR-TEST-ONLY"), false);
  }));

test("doctor labels a project scope with its folder, so two folders give two labels", () =>
  inRoot(async (root) => {
    const { io, lines } = harness(root, [fakeAgent("claude", ["global", "project"], [])]);
    await mkdir(path.dirname(io.cliPath), { recursive: true });
    await writeFile(io.cliPath, "// a file for the test\n");
    await record("claude", scopeKey("project", path.join(root, "folder-alpha")), serverOf(io));
    await record("claude", scopeKey("project", path.join(root, "folder-beta")), serverOf(io));
    assert.equal(await doctor(io), 0);
    assert.equal(
      lines.some((line) => line.startsWith("[ok] claude project ") && line.includes("folder-alpha")),
      true,
    );
    assert.equal(
      lines.some((line) => line.startsWith("[ok] claude project ") && line.includes("folder-beta")),
      true,
    );
  }));

test("doctor returns 0 when every recorded command line path exists and every account has a token", () =>
  inRoot(async (root) => {
    await writeAccounts(root, ["work"]);
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [])]);
    await mkdir(path.dirname(io.cliPath), { recursive: true });
    await writeFile(io.cliPath, "// a file for the test\n");
    await io.tokens.set("work", PLACEHOLDER);
    await record("claude", scopeKey("global", io.projectDir), serverOf(io));
    assert.equal(await doctor(io), 0);
    assert.equal(
      lines.some((line) => line.startsWith("[error]")),
      false,
    );
  }));

test("when one agent throws, the plan still lists the others, the error becomes an error step, and nothing is applied", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io, lines } = harness(root, [
      fakeAgent("codex", ["global"], calls, { throws: true }),
      fakeAgent("claude", ["global"], calls),
    ]);
    assert.equal(await install({ scope: "global", yes: true }, io), 1);
    assert.equal(
      lines.some((line) => line.startsWith("[error] codex global: boom")),
      true,
    );
    assert.equal(
      lines.some((line) => line === "[ok] claude global: Would install claude."),
      true,
    );
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
    assert.deepEqual(await recordedItems("codex", scopeKey("global", io.projectDir)), []);
  }));

test("a skipped step records no server item, and an ok step in the same scope still records its own", () =>
  inRoot(async (root) => {
    const { io } = harness(root, [
      fakeAgent("claude", ["global"], [], { skips: true }),
      fakeAgent("codex", ["global"], []),
    ]);
    assert.equal(await install({ scope: "global", yes: true }, io), 0);
    const key = scopeKey("global", io.projectDir);
    assert.deepEqual(await recordedItems("claude", key), []);
    assert.deepEqual(await recordedItems("codex", key), [serverOf(io)]);
  }));

test("a step that succeeds but whose record cannot be written is an error row, and the exit code is 1", () =>
  inRoot(async (root) => {
    // The agent's state file is a folder, so the record can be neither read nor written.
    await mkdir(statePath("claude"), { recursive: true });
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [])]);
    assert.equal(await install({ agents: ["claude"], yes: true }, io), 1);
    assert.equal(
      lines.some((line) => line.startsWith("[error] claude global: The command line path could not be recorded:")),
      true,
    );
  }));

test("a command line path with a trailing separator is refused with exit 1 before any change, by install and by update", () =>
  inRoot(async (root) => {
    const target = path.join(root, "would-write.txt");
    const calls: string[] = [];
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], calls, { writes: target })]);
    io.cliPath = `${io.cliPath}${path.sep}`;
    assert.equal(await install({ agents: ["claude"], yes: true }, io), 1);
    assert.equal(await update({}, io), 1);
    assert.deepEqual(calls, []);
    assert.equal(existsSync(target), false);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
    assert.equal(
      lines.some((line) => line.includes("path.resolve")),
      true,
    );
  }));

test(
  "on Windows, a command line path with forward slashes is refused with exit 1 and nothing is written",
  { skip: process.platform === "win32" ? false : "forward slashes are the native separator on this system" },
  () =>
    inRoot(async (root) => {
      const calls: string[] = [];
      const { io } = harness(root, [fakeAgent("claude", ["global"], calls)]);
      io.cliPath = io.cliPath.replace(/\\/g, "/");
      assert.equal(await install({ agents: ["claude"], yes: true }, io), 1);
      assert.deepEqual(calls, []);
      assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
    }),
);

test("a relative command line path is refused with exit 1 before any agent runs", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io } = harness(root, [fakeAgent("claude", ["global"], calls)]);
    io.cliPath = path.join("relative", "dist", "cli.js");
    assert.equal(await install({ agents: ["claude"], yes: true }, io), 1);
    assert.deepEqual(calls, []);
  }));

test("an unknown scope is refused with exit 2 before any agent runs, by install and by update", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], calls)]);
    assert.equal(await install({ scope: "banana", yes: true }, io), 2);
    assert.equal(await update({ scope: "banana" }, io), 2);
    assert.deepEqual(calls, []);
    assert.equal(
      lines.filter((line) => line.startsWith("unknown scope")).length,
      2,
    );
  }));

test("an unknown agent name is refused with exit 1 before any agent runs, by install and by update", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], calls)]);
    assert.equal(await install({ agents: ["nobody"], yes: true }, io), 1);
    assert.equal(await update({ agents: ["nobody"] }, io), 1);
    assert.deepEqual(calls, []);
    assert.equal(
      lines.filter((line) => line.includes("unknown agent")).length,
      2,
    );
  }));

test("a named agent that lacks the scope is refused with exit 1 before any agent runs", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io, lines } = harness(root, [fakeAgent("opencode", ["global", "project"], calls)]);
    assert.equal(await install({ agents: ["opencode"], scope: "local", yes: true }, io), 1);
    assert.deepEqual(calls, []);
    assert.equal(
      lines.some((line) => line.includes("opencode has no local scope")),
      true,
    );
  }));

test("uninstall where no agent has a record prints why each unsupported agent was left out, and runs nothing", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io, lines } = harness(root, [
      fakeAgent("claude", ["global", "project", "local"], calls),
      fakeAgent("codex", ["global", "project"], calls),
    ]);
    assert.equal(await uninstall({ scope: "local" }, io), 0);
    assert.deepEqual(calls, []);
    assert.equal(
      lines.some((line) => line === "[skipped] codex local: codex has no local scope"),
      true,
    );
    assert.equal(
      lines.some((line) => line.startsWith("Nothing to uninstall")),
      true,
    );
  }));

test("install in a terminal with no agent named asks which agents and which scope, then asks to apply", () =>
  inRoot(async (root) => {
    const { io, asked } = harness(
      root,
      [fakeAgent("claude", ["global", "project"], []), fakeAgent("codex", ["global"], [])],
      { isTerminal: true, answers: ["claude", "project", "y"] },
    );
    assert.equal(await install({}, io), 0);
    assert.equal(asked.length, 3);
    assert.equal(asked[0]?.startsWith("Which agents?"), true);
    assert.equal(asked[1]?.startsWith("Which scope?"), true);
    assert.equal(asked[2], APPLY_QUESTION);
    assert.deepEqual(await recordedItems("claude", scopeKey("project", io.projectDir)), [serverOf(io)]);
    assert.deepEqual(await recordedItems("codex", scopeKey("global", io.projectDir)), []);
  }));

test("install in a terminal asks to apply: a no changes nothing, and a yes applies the change", () =>
  inRoot(async (root) => {
    const target = path.join(root, "applied.txt");
    const { io, asked } = harness(root, [fakeAgent("claude", ["global"], [], { writes: target })], {
      isTerminal: true,
      answers: ["n", "y"],
    });
    assert.equal(await install({ agents: ["claude"] }, io), 0);
    assert.equal(existsSync(target), false);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
    assert.equal(await install({ agents: ["claude"] }, io), 0);
    assert.equal(existsSync(target), true);
    assert.deepEqual(asked, [APPLY_QUESTION, APPLY_QUESTION]);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), [serverOf(io)]);
  }));

test("a blank answer to the apply question means no: nothing is written and the exit code is 0", () =>
  inRoot(async (root) => {
    const target = path.join(root, "blank.txt");
    const { io, asked } = harness(root, [fakeAgent("claude", ["global"], [], { writes: target })], {
      isTerminal: true,
      answers: [""],
    });
    assert.equal(await install({ agents: ["claude"] }, io), 0);
    assert.deepEqual(asked, [APPLY_QUESTION]);
    assert.equal(existsSync(target), false);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
  }));

test("an answer that cannot be read is exit 1, and nothing is written", () =>
  inRoot(async (root) => {
    const target = path.join(root, "rejected.txt");
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [], { writes: target })], {
      isTerminal: true,
      askFails: true,
    });
    assert.equal(await install({ agents: ["claude"] }, io), 1);
    assert.equal(existsSync(target), false);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
    assert.equal(
      lines.some((line) => line.toLowerCase().includes("nothing was changed")),
      true,
    );
  }));

test("a --yes install whose plan has an error row exits 1 and writes nothing, with no real pass", () =>
  inRoot(async (root) => {
    const target = path.join(root, "not-written.txt");
    const { io, lines } = harness(root, [
      fakeAgent("claude", ["global"], [], { writes: target }),
      fakeAgent("codex", ["global"], [], { throws: true }),
    ]);
    assert.equal(await install({ agents: ["claude", "codex"], yes: true }, io), 1);
    assert.equal(existsSync(target), false);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
    assert.equal(
      lines.some((line) => line === "[error] codex global: boom"),
      true,
    );
    assert.equal(lines.includes("Results:"), false);
  }));

test("a --yes install whose plan has no error row applies the change and exits 0", () =>
  inRoot(async (root) => {
    const target = path.join(root, "applied.txt");
    const { io } = harness(root, [fakeAgent("claude", ["global"], [], { writes: target })]);
    assert.equal(await install({ agents: ["claude"], yes: true }, io), 0);
    assert.equal(existsSync(target), true);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), [serverOf(io)]);
  }));

test("a real pass that throws for one agent records no server item for the other agent in the same scope, and exits 1", () =>
  inRoot(async (root) => {
    // The write target is a folder. A dry pass writes nothing, so it succeeds for both agents, and only the real pass fails.
    const folder = path.join(root, "existing-folder");
    await mkdir(folder, { recursive: true });
    const { io, lines } = harness(root, [
      fakeAgent("claude", ["global"], [], { writes: folder }),
      fakeAgent("codex", ["global"], []),
    ]);
    assert.equal(await install({ agents: ["claude", "codex"], scope: "global", yes: true }, io), 1);
    assert.equal(
      lines.includes("[ok] claude global: Would install claude."),
      true,
    );
    assert.equal(
      lines.some((line) => line.startsWith("[error] claude global:")),
      true,
    );
    assert.equal(lines.includes("[ok] codex global: Did install codex."), true);
    assert.deepEqual(await recordedItems("codex", scopeKey("global", io.projectDir)), []);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
  }));

test("update stops before any change when its dry pass has an error row: it prints the plan, exits 1, and writes nothing", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], calls, { failsInDryRun: true })]);
    const key = scopeKey("global", io.projectDir);
    await record("claude", key, { kind: "mcp-entry", name: "recorded" });
    assert.equal(await update({}, io), 1);
    assert.equal(calls.includes("update claude global dry"), true);
    assert.equal(calls.includes("update claude global real"), false);
    assert.equal(lines.includes("[error] claude global: dry pass fails"), true);
    assert.equal(lines.includes("Results:"), false);
    assert.deepEqual(await recordedItems("claude", key), [{ kind: "mcp-entry", name: "recorded" }]);
  }));

test("uninstall stops before any change when its dry pass has an error row: it prints the plan, exits 1, and removes nothing", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], calls, { failsInDryRun: true })]);
    const key = scopeKey("global", io.projectDir);
    await record("claude", key, { kind: "mcp-entry", name: "recorded" });
    assert.equal(await uninstall({}, io), 1);
    assert.equal(calls.includes("uninstall claude global dry"), true);
    assert.equal(calls.includes("uninstall claude global real"), false);
    assert.equal(lines.includes("[error] claude global: dry pass fails"), true);
    assert.equal(lines.includes("Results:"), false);
    assert.deepEqual(await recordedItems("claude", key), [{ kind: "mcp-entry", name: "recorded" }]);
  }));

test("a named agent with no record in the scope gets a skipped line, with --scope, and no agent runs", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const { io, lines } = harness(root, [fakeAgent("claude", ["global", "project"], calls)]);
    assert.equal(await uninstall({ agents: ["claude"], scope: "project" }, io), 0);
    assert.deepEqual(calls, []);
    assert.equal(
      lines.includes("[skipped] claude project: no record in this scope, so nothing was changed."),
      true,
    );
  }));

test("a named agent with no record gets a skipped line in each scope it supports, without --scope", () =>
  inRoot(async (root) => {
    const { io, lines } = harness(root, [fakeAgent("claude", ["global", "project"], [])]);
    assert.equal(await uninstall({ agents: ["claude"] }, io), 0);
    assert.equal(
      lines.includes("[skipped] claude global: no record in this scope, so nothing was changed."),
      true,
    );
    assert.equal(
      lines.includes("[skipped] claude project: no record in this scope, so nothing was changed."),
      true,
    );
  }));

test("a step line that holds a token shape prints it as [redacted], and a line without one is unchanged", () =>
  inRoot(async (root) => {
    const broken: AgentAdapter = {
      ...fakeAgent("claude", ["global"], []),
      install: async () => {
        throw new Error("failed with sbp_TEST-ONLY-VALUE");
      },
    };
    const { io, lines } = harness(root, [broken, fakeAgent("codex", ["global"], [], { throws: true })]);
    assert.equal(await install({ agents: ["claude", "codex"], yes: true }, io), 1);
    assert.equal(lines.includes("[error] claude global: failed with [redacted]"), true);
    assert.equal(lines.includes("[error] codex global: boom"), true);
    assert.equal(
      lines.some((line) => line.includes("sbp_")),
      false,
    );
  }));

test("uninstall in a scope with a record gives an unnamed agent that lacks the scope its skipped line", () =>
  inRoot(async (root) => {
    const { io, lines } = harness(root, [
      fakeAgent("claude", ["global", "project", "local"], []),
      fakeAgent("codex", ["global", "project"], []),
    ]);
    await record("claude", scopeKey("local", io.projectDir), { kind: "mcp-entry", name: "recorded" });
    assert.equal(await uninstall({ agents: ["claude"], scope: "local" }, io), 0);
    assert.equal(
      lines.includes("[skipped] codex local: codex has no local scope"),
      true,
    );
  }));

test("a named agent that lacks a scope gets its skipped line when no scope is given", () =>
  inRoot(async (root) => {
    const { io, lines } = harness(root, [fakeAgent("codex", ["global", "project"], [])]);
    assert.equal(await uninstall({ agents: ["codex"] }, io), 0);
    assert.equal(
      lines.includes("[skipped] codex local: codex has no local scope"),
      true,
    );
  }));

test("an agent with no record that is not named is not listed, so no-record output stays quiet", () =>
  inRoot(async (root) => {
    const { io, lines } = harness(root, [
      fakeAgent("claude", ["global", "project", "local"], []),
      fakeAgent("codex", ["global"], []),
    ]);
    assert.equal(await uninstall({ agents: ["codex"] }, io), 0);
    assert.equal(
      lines.some((line) => line.includes("claude")),
      false,
    );
  }));

test("an interrupt after the first real step stops the change: the next step does not run, the notice is printed, and the exit is 130", () =>
  inRoot(async (root) => {
    const calls: string[] = [];
    const first = fakeAgent("claude", ["global"], calls);
    const { io, lines } = harness(root, [first, fakeAgent("codex", ["global"], calls)]);
    let interrupted = false;
    io.interrupted = () => interrupted;
    const finishing = first.install;
    first.install = async (ctx, scope) => {
      const steps = await finishing(ctx, scope);
      // Ctrl+C arrives while the first step runs. The step finishes, and the step after it does not start.
      if (!ctx.dryRun) {
        interrupted = true;
      }
      return steps;
    };
    assert.equal(await install({ agents: ["claude", "codex"], yes: true }, io), 130);
    assert.equal(calls.includes("install claude global real"), true);
    assert.equal(calls.includes("install codex global real"), false);
    assert.equal(
      lines.some((line) => line.startsWith("Stopped by Ctrl+C")),
      true,
    );
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), [serverOf(io)]);
  }));

test("an interrupt does not change a dry run: it prints the plan, changes nothing, and exits 0", () =>
  inRoot(async (root) => {
    const target = path.join(root, "not-written.txt");
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [], { writes: target })]);
    io.interrupted = () => true;
    assert.equal(await install({ agents: ["claude"], dryRun: true }, io), 0);
    assert.equal(existsSync(target), false);
    assert.equal(
      lines.includes("[ok] claude global: Would install claude."),
      true,
    );
    assert.equal(
      lines.some((line) => line.startsWith("Stopped by Ctrl+C")),
      false,
    );
  }));

test("the install flow writes its records to the data folder in the environment it is given", () =>
  inRoot(async (root) => {
    const given = path.join(root, "given-data");
    const { io } = harness(root, [fakeAgent("claude", ["global"], [])]);
    io.env = { ...process.env, MULTI_ACCOUNT_SUPABASE_HOME: given };
    assert.equal(await install({ agents: ["claude"], yes: true }, io), 0);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir), undefined, io.env), [serverOf(io)]);
    assert.equal(existsSync(path.join(given, "state", "claude.json")), true);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
  }));

test("doctor with an adapter that throws still prints the other steps, and exits 1", () =>
  inRoot(async (root) => {
    const { io, lines } = harness(root, [
      fakeAgent("codex", ["global"], [], { throws: true }),
      fakeAgent("claude", ["global"], []),
    ]);
    assert.equal(await doctor(io), 1);
    assert.equal(
      lines.some((line) => line === "[error] codex global: boom"),
      true,
    );
    assert.equal(
      lines.some((line) => line === "[ok] claude global: Doctor found it."),
      true,
    );
  }));

test("in a terminal, a plan with an error row is printed, asks nothing, writes nothing, and exits 1", () =>
  inRoot(async (root) => {
    const target = path.join(root, "not-written.txt");
    const { io, asked, lines } = harness(
      root,
      [fakeAgent("claude", ["global"], [], { writes: target }), fakeAgent("codex", ["global"], [], { throws: true })],
      { isTerminal: true, answers: ["y"] },
    );
    assert.equal(await install({ agents: ["claude", "codex"] }, io), 1);
    assert.deepEqual(asked, []);
    assert.equal(existsSync(target), false);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
    assert.equal(
      lines.some((line) => line === "[error] codex global: boom"),
      true,
    );
  }));

test("an answer that is not text is refused with exit 1, and nothing is written", () =>
  inRoot(async (root) => {
    const target = path.join(root, "not-written.txt");
    const { io, lines } = harness(root, [fakeAgent("claude", ["global"], [], { writes: target })], {
      isTerminal: true,
      badAnswer: true,
    });
    assert.equal(await install({ agents: ["claude"] }, io), 1);
    assert.equal(existsSync(target), false);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), []);
    assert.equal(
      lines.some((line) => line.toLowerCase().includes("nothing was changed")),
      true,
    );
  }));

test("an error that is not a refusal stops the command with exit 1 and its reason, and nothing rejects", () =>
  inRoot(async (root) => {
    const target = path.join(root, "not-written.txt");
    const broken = fakeAgent("claude", ["global"], [], { writes: target });
    Object.defineProperty(broken, "scopes", {
      get: () => {
        throw new Error("scopes unreadable");
      },
    });
    const { io, lines } = harness(root, [broken]);
    assert.equal(await install({ agents: ["claude"], yes: true }, io), 1);
    assert.equal(existsSync(target), false);
    assert.equal(
      lines.some((line) => line === "The command stopped before it finished: scopes unreadable"),
      true,
    );
  }));

test("with --yes in a terminal, no question is asked: every agent acts, in the global scope", () =>
  inRoot(async (root) => {
    const { io, asked } = harness(
      root,
      [fakeAgent("claude", ["global", "project"], []), fakeAgent("codex", ["global"], [])],
      { isTerminal: true },
    );
    assert.equal(await install({ yes: true }, io), 0);
    assert.deepEqual(asked, []);
    assert.deepEqual(await recordedItems("claude", scopeKey("global", io.projectDir)), [serverOf(io)]);
    assert.deepEqual(await recordedItems("codex", scopeKey("global", io.projectDir)), [serverOf(io)]);
  }));
