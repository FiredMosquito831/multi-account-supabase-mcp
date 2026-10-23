import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import type { Runner } from "../agents/command.js";
import type { Scope } from "../agents/scopes.js";
import type { AgentId } from "../agents/state.js";
import type { AgentAdapter, Context, Step } from "../agents/types.js";
import { releaseHooks } from "../accounts/lock.js";
import { type AccountRecord, Registry } from "../accounts/registry.js";
import {
  type CliIo,
  type FlowEnvironment,
  INTERRUPT_NOTICE,
  isChangeCommand,
  runCli,
  terminalAsk,
  watchInterrupt,
} from "../run.js";
import type { TokenStore } from "../secrets/token-store.js";
import type { Profile } from "../supabase/api.js";
import { usageText } from "../usage.js";
import { inTemporaryRoot } from "./isolation.js";

// Fake values only. TYPED is what the owner types at the prompt. It must never reach any output.
const TYPED = "tok-SECRET-123";
const TOKEN_SHAPED = "sbp_fake-not-a-token";
const TOKEN_NOTE = "That input looks like a token, so it is not repeated.";
// The line that remove prints after the removed line, in both of its cases.
const TOKEN_STILL_WORKS = "The Supabase token still works until you revoke it in your Supabase account settings.";
const ADDED_AT = "2026-10-20T09:00:00.000Z";
const WORK_PROFILE: Profile = { gotrueId: "gotrue-work", email: "a@example.com", username: "fake-user" };

// Each test gets its own folder in a temporary root, and every home, configuration and data name points into that root.
// The root is removed afterwards. No test reads the owner's data folder, reaches the network or the credential store, or
// imports the keyring module.
const inTempFolder = (run: (folder: string) => Promise<void>): Promise<void> => inTemporaryRoot(run);

// An in-memory token store. It implements the interface only, so the test never loads token-store.ts at run time.
class FakeTokens implements TokenStore {
  private readonly held = new Map<string, string>();
  // Counts the reads and the deletes, so a test can show that a refused command touched neither.
  readonly calls = { get: 0, delete: 0 };

  async get(account: string): Promise<string | undefined> {
    this.calls.get += 1;
    return this.held.get(account);
  }

  async set(account: string, token: string): Promise<void> {
    this.held.set(account, token);
  }

  async delete(account: string): Promise<void> {
    this.calls.delete += 1;
    this.held.delete(account);
  }

  size(): number {
    return this.held.size;
  }
}

type Options = {
  terminal?: boolean;
  typed?: string;
  profile?: (token: string) => Promise<Profile>;
  serve?: () => Promise<void>;
  adapters?: readonly AgentAdapter[];
  stdoutTerminal?: boolean;
  asked?: string[];
  answers?: string[];
  askFails?: boolean;
};

type Result = {
  code: number;
  out: string[];
  err: string[];
  prompts: number;
  profileCalls: number;
  serveCalls: number;
};

// The command runner of the install commands. It throws, so a command that reached it would make its step an error row. A dry
// run never reaches it, and no test here runs a real pass.
const noCommands: Runner = async () => {
  throw new Error("no command runs in this test");
};

// A fake adapter. Each call is logged, and its install writes the target file, which a dry pass must not do.
const fakeAgent = (id: AgentId, target: string, calls: string[]): AgentAdapter => {
  const change =
    (action: "install" | "update" | "uninstall") =>
    async (ctx: Context, scope: Scope): Promise<Step[]> => {
      calls.push(`${action} ${id} ${scope} ${ctx.dryRun ? "dry" : "real"}`);
      await ctx.writeFile(target, "fake\n");
      return [{ agent: id, scope, status: "ok", message: ctx.dryRun ? `Would ${action} ${id}.` : `Did ${action} ${id}.` }];
    };
  return {
    id,
    scopes: ["global"],
    present: () => true,
    install: change("install"),
    update: change("update"),
    uninstall: change("uninstall"),
    doctor: async () => {
      calls.push(`doctor ${id}`);
      return [];
    },
  };
};

// The inputs of the install commands in these tests. The adapters are fakes, the runner refuses every command, and every
// question is recorded. Answers come from the given list in turn, and a blank line is given when none is left. So no test
// runs an agent CLI or reads a real configuration.
const flowEnvironment = (
  folder: string,
  adapters: readonly AgentAdapter[],
  asked: string[],
  answers: string[] = [],
  askFails = false,
): FlowEnvironment => ({
  ask: async (question) => {
    asked.push(question);
    if (askFails) {
      throw new Error("input closed");
    }
    return answers.shift() ?? "";
  },
  cliPath: path.join(folder, "package", "dist", "cli.js"),
  packageRoot: path.join(folder, "package"),
  projectDir: path.join(folder, "project"),
  homeDir: path.join(folder, "home"),
  env: process.env,
  adapters,
  run: noCommands,
  present: () => true,
});

// One session is one registry file and one token store. Every command run through it shares both.
const sessionIn = (folder: string) => {
  const tokens = new FakeTokens();
  const file = path.join(folder, "accounts.json");
  const run = async (argv: string[], options: Options = {}): Promise<Result> => {
    const out: string[] = [];
    const err: string[] = [];
    const counts = { prompts: 0, profileCalls: 0, serveCalls: 0 };
    const io: CliIo = {
      stdout: (text) => {
        out.push(text);
      },
      stderr: (text) => {
        err.push(text);
      },
      stdinIsTerminal: options.terminal ?? true,
      stdoutIsTerminal: options.stdoutTerminal ?? false,
      readSecret: async () => {
        counts.prompts += 1;
        return options.typed ?? TYPED;
      },
      registryFile: file,
      tokens,
      fetchProfile: async (token) => {
        counts.profileCalls += 1;
        return options.profile ? options.profile(token) : WORK_PROFILE;
      },
      addedAt: () => ADDED_AT,
      flow: flowEnvironment(
        folder,
        options.adapters ?? [],
        options.asked ?? [],
        [...(options.answers ?? [])],
        options.askFails === true,
      ),
      serve: async () => {
        counts.serveCalls += 1;
        if (options.serve) {
          await options.serve();
        }
      },
    };
    const code = await runCli(argv, io);
    return { code, out, err, ...counts };
  };
  return { run, tokens, file };
};

// Everything one command printed, on either stream.
const printed = (result: Result): string => [...result.out, ...result.err].join("\n");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const recordOf = (name: string): AccountRecord => ({
  name,
  email: `${name}@example.com`,
  gotrueId: `gotrue-${name}`,
  added: "pat",
  addedAt: ADDED_AT,
});

// Writes a registry file with these accounts. The first one is the default.
const seed = async (file: string, names: string[]): Promise<void> => {
  const registry = await Registry.load(file);
  for (const name of names) {
    registry.add(recordOf(name));
  }
  await registry.save();
};

test("(a) add from a pipe is refused with the exact message, exit 2, and the token store stays empty", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const result = await session.run(["add", "work", "--pat"], { terminal: false });
    assert.equal(result.code, 2);
    assert.deepEqual(result.err, [
      "The token is typed in a terminal, not piped. Run this command in a terminal window.",
    ]);
    assert.deepEqual(result.out, []);
    assert.equal(result.prompts, 0);
    assert.equal(session.tokens.size(), 0);
  }));

test("(b) add in a terminal stores the typed token, prints the summary, and keeps the token out of the registry file", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const result = await session.run(["add", "work", "--pat"], { terminal: true, typed: TYPED });
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ['Added "work" (a@example.com). It is the default account.']);
    assert.deepEqual(result.err, []);
    assert.equal(await session.tokens.get("work"), TYPED);
    const text = await readFile(session.file, "utf8");
    assert.equal(text.includes(TYPED), false);
    assert.equal(JSON.parse(text).default, "work");
  }));

test("(c) the output of the commands (a), (b), (d), (e), (f) and (g) never holds the typed token", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const results = [
      await session.run(["add", "work", "--pat"], { terminal: false }),
      await session.run(["add", "work", "--pat"], { terminal: true, typed: TYPED }),
      await session.run(["list"]),
      await session.run(["default", "nobody"]),
      await session.run(["add", "work"]),
      await session.run(["remove", "work", "--yes"]),
    ];
    assert.deepEqual(
      results.map((result) => result.code),
      [2, 0, 0, 1, 2, 0],
    );
    for (const result of results) {
      assert.equal(printed(result).includes(TYPED), false);
    }
  }));

test("(d) list marks the default with an asterisk, and ends each line with the token kind", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work", "play"]);
    const result = await session.run(["list"]);
    assert.equal(result.code, 0);
    // accountListText writes the asterisk directly before the name, then a tab before each later column.
    assert.deepEqual(result.out, ["*work\twork@example.com\tpat\n play\tplay@example.com\tpat"]);
    assert.deepEqual(result.err, []);
  }));

test("(e) default with an unknown name exits 1 with the no-account message", () =>
  inTempFolder(async (folder) => {
    const result = await sessionIn(folder).run(["default", "nobody"]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, ['Error: No account named "nobody".']);
    assert.deepEqual(result.out, []);
  }));

test("(f) remove deletes the record and the token, and prints the removed line", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const added = await session.run(["add", "work", "--pat"], { terminal: true, typed: TYPED });
    assert.equal(added.code, 0);
    const result = await session.run(["remove", "work", "--yes"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ['Removed "work".', TOKEN_STILL_WORKS]);
    assert.equal(await session.tokens.get("work"), undefined);
    assert.deepEqual((await Registry.load(session.file)).names(), []);
  }));

test("(g) add without --pat exits 2 with the exact message, and reads no token", () =>
  inTempFolder(async (folder) => {
    const result = await sessionIn(folder).run(["add", "work"], { terminal: true });
    assert.equal(result.code, 2);
    assert.deepEqual(result.err, [
      "Adding an account needs --pat. Run in a terminal: multi-account-supabase-mcp add <name> --pat",
    ]);
    assert.equal(result.prompts, 0);
  }));

test("(h) no command from a pipe calls serve, and no command in a terminal prints the usage without calling serve", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const piped = await session.run([], { terminal: false });
    assert.equal(piped.code, 0);
    assert.equal(piped.serveCalls, 1);
    assert.deepEqual(piped.out, []);
    const terminal = await session.run([], { terminal: true });
    assert.equal(terminal.code, 0);
    assert.equal(terminal.serveCalls, 0);
    assert.deepEqual(terminal.out, [usageText]);
  }));

test("(i) an unknown command exits 2 with its message and the usage text", () =>
  inTempFolder(async (folder) => {
    const result = await sessionIn(folder).run(["bogus"]);
    assert.equal(result.code, 2);
    assert.deepEqual(result.err, ['Unknown command "bogus".', usageText]);
    assert.deepEqual(result.out, []);
  }));

test("add with a token-shaped name is refused with the note before the prompt, the name is printed nowhere, and nothing is stored", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const result = await session.run(["add", TOKEN_SHAPED, "--pat"], { terminal: true, typed: TYPED });
    assert.equal(result.code, 2);
    assert.deepEqual(result.err, [TOKEN_NOTE]);
    assert.deepEqual(result.out, []);
    assert.equal(result.prompts, 0);
    assert.equal(printed(result).includes(TOKEN_SHAPED), false);
    assert.equal(session.tokens.size(), 0);
  }));

test("an unknown command that starts with sbp_ prints the note alone, in place of the command and the usage text", () =>
  inTempFolder(async (folder) => {
    const result = await sessionIn(folder).run([TOKEN_SHAPED]);
    assert.equal(result.code, 2);
    assert.deepEqual(result.err, [TOKEN_NOTE]);
    assert.equal(printed(result).includes(TOKEN_SHAPED), false);
    assert.deepEqual(result.out, []);
  }));

test("add with an empty typed token prints the no-token error, exits 1, and calls no profile function", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const result = await session.run(["add", "work", "--pat"], { terminal: true, typed: "" });
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, ["Error: no token was typed."]);
    assert.equal(result.profileCalls, 0);
    assert.equal(session.tokens.size(), 0);
  }));

test("remove of a name with no record but a stored token deletes the token, prints the removed line, and exits 0", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await session.tokens.set("ghost", TYPED);
    const result = await session.run(["remove", "ghost", "--yes"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ['Removed "ghost".', TOKEN_STILL_WORKS]);
    assert.deepEqual(result.err, []);
    assert.equal(await session.tokens.get("ghost"), undefined);
  }));

test("remove of a name with neither a record nor a token exits 1", () =>
  inTempFolder(async (folder) => {
    const result = await sessionIn(folder).run(["remove", "nobody", "--yes"]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, ['Error: No account named "nobody".']);
    assert.deepEqual(result.out, []);
  }));

test("remove prints the token line after the removed line, for a removed record and for a token alone", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work"]);
    const withRecord = await session.run(["remove", "work", "--yes"]);
    assert.equal(withRecord.code, 0);
    assert.deepEqual(withRecord.out, ['Removed "work".', TOKEN_STILL_WORKS]);
    assert.deepEqual(withRecord.err, []);
    await session.tokens.set("ghost", TYPED);
    const tokenOnly = await session.run(["remove", "ghost", "--yes"]);
    assert.equal(tokenOnly.code, 0);
    assert.deepEqual(tokenOnly.out, ['Removed "ghost".', TOKEN_STILL_WORKS]);
    assert.deepEqual(tokenOnly.err, []);
  }));

test("a serve that throws writes Error and the message to stderr, and returns 1", () =>
  inTempFolder(async (folder) => {
    const result = await sessionIn(folder).run(["serve"], {
      serve: async () => {
        throw new Error("The server could not start.");
      },
    });
    assert.equal(result.code, 1);
    assert.equal(result.serveCalls, 1);
    assert.deepEqual(result.err, ["Error: The server could not start."]);
    assert.deepEqual(result.out, []);
  }));

test("an add whose identity check fails with the token in its message and its cause shows neither in the output", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const result = await session.run(["add", "work", "--pat"], {
      terminal: true,
      typed: TYPED,
      profile: async (token) => {
        throw new Error(`The check failed for ${token}.`, { cause: new Error(`The cause holds ${token}.`) });
      },
    });
    assert.equal(result.code, 1);
    assert.equal(printed(result).includes(TYPED), false);
    assert.deepEqual(result.err, ["Error: The check failed for [redacted].", "  The cause holds [redacted]."]);
    assert.deepEqual(result.out, []);
    assert.equal(session.tokens.size(), 0);
  }));

test("an extra argument and an unknown option each exit 2 with the usage error, and echo nothing", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    for (const argv of [
      ["list", "extra-argument"],
      ["list", "--unknown-option"],
    ]) {
      const result = await session.run(argv);
      assert.equal(result.code, 2);
      assert.deepEqual(result.err, ["Usage error.", usageText]);
      assert.deepEqual(result.out, []);
    }
  }));

test("default makes the named account the default, prints it, and saves the change", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work", "play"]);
    const result = await session.run(["default", "play"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ["Default account: play"]);
    assert.equal((await Registry.load(session.file)).defaultName(), "play");
  }));

test("help, --help and -h print the usage text to stdout and exit 0", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    for (const argv of [["help"], ["--help"], ["-h"]]) {
      const result = await session.run(argv);
      assert.equal(result.code, 0);
      assert.deepEqual(result.out, [usageText]);
      assert.deepEqual(result.err, []);
    }
  }));

test("add with an invalid name is refused before the token prompt", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const result = await session.run(["add", "Work!", "--pat"], { terminal: true, typed: TYPED });
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, [
      'Error: Invalid account name "Work!". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.',
    ]);
    assert.equal(result.prompts, 0);
    assert.equal(session.tokens.size(), 0);
  }));

test("add with a token-shaped name that has a leading space is refused with the note, and the name is printed nowhere", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const result = await session.run(["add", ` ${TOKEN_SHAPED}`, "--pat"], { terminal: true, typed: TYPED });
    assert.equal(result.code, 2);
    assert.deepEqual(result.err, [TOKEN_NOTE]);
    assert.deepEqual(result.out, []);
    assert.equal(printed(result).includes(TOKEN_SHAPED), false);
    assert.equal(result.prompts, 0);
    assert.equal(session.tokens.size(), 0);
  }));

test("default and remove with a token-shaped name, plain or with a leading space, print the note alone and never the name", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    for (const name of [TOKEN_SHAPED, ` ${TOKEN_SHAPED}`]) {
      for (const command of ["default", "remove"]) {
        const result = await session.run([command, name]);
        assert.equal(result.code, 2);
        assert.deepEqual(result.err, [TOKEN_NOTE]);
        assert.deepEqual(result.out, []);
        assert.equal(printed(result).includes(TOKEN_SHAPED), false);
      }
    }
  }));

test("default and remove with a token-shaped name refuse before the registry is read, so a damaged file gets no error line", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await writeFile(session.file, "{ not json");
    for (const command of ["default", "remove"]) {
      const result = await session.run([command, TOKEN_SHAPED]);
      assert.equal(result.code, 2);
      assert.deepEqual(result.err, [TOKEN_NOTE]);
      assert.deepEqual(result.out, []);
    }
    // The damaged file is still there and unchanged, and the token store was not touched.
    assert.equal(await readFile(session.file, "utf8"), "{ not json");
    assert.equal(session.tokens.calls.get + session.tokens.calls.delete, 0);
  }));

test("an unknown command with a leading space, or with text before sbp_, prints the note alone and never the command", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    for (const command of [` ${TOKEN_SHAPED}`, `x${TOKEN_SHAPED}`]) {
      const result = await session.run([command]);
      assert.equal(result.code, 2);
      assert.deepEqual(result.err, [TOKEN_NOTE]);
      assert.deepEqual(result.out, []);
      assert.equal(printed(result).includes(TOKEN_SHAPED), false);
    }
  }));

test("a removal whose token delete fails after the record is removed prints the remedy line, exits 1, and shows no keyring text", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work"]);
    session.tokens.delete = async () => {
      throw new Error("keyring-internal-detail");
    };
    const result = await session.run(["remove", "work", "--yes"]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, [
      'Error: The account "work" was removed, but its stored token could not be deleted. Run: multi-account-supabase-mcp remove work',
    ]);
    assert.deepEqual(result.out, []);
    assert.equal(printed(result).includes("keyring-internal-detail"), false);
    assert.deepEqual((await Registry.load(session.file)).names(), []);
  }));

test("a removal of a token with no record whose delete fails prints the second remedy line, exits 1, and shows no keyring text", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await session.tokens.set("ghost", TYPED);
    session.tokens.delete = async () => {
      throw new Error("keyring-internal-detail");
    };
    const result = await session.run(["remove", "ghost", "--yes"]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, [
      'Error: The stored token for "ghost" could not be deleted. Run: multi-account-supabase-mcp remove ghost',
    ]);
    assert.deepEqual(result.out, []);
    assert.equal(printed(result).includes("keyring-internal-detail"), false);
  }));

test("a typed token with spaces around it is trimmed before the identity check and before it is stored", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const checked: string[] = [];
    const result = await session.run(["add", "work", "--pat"], {
      terminal: true,
      typed: "  tok-SECRET-123  ",
      profile: async (token) => {
        checked.push(token);
        return WORK_PROFILE;
      },
    });
    assert.equal(result.code, 0);
    assert.deepEqual(checked, ["tok-SECRET-123"]);
    assert.equal(await session.tokens.get("work"), "tok-SECRET-123");
    assert.deepEqual(result.out, ['Added "work" (a@example.com). It is the default account.']);
    assert.deepEqual(result.err, []);
    assert.equal(printed(result).includes("  tok-SECRET-123  "), false);
  }));

test("add and default with an extra argument, and add with an unknown option, are usage errors that echo nothing", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const cases = [
      { argv: ["add", "work", "extra-argument", "--pat"], echoed: "extra-argument" },
      { argv: ["default", "work", "extra-argument"], echoed: "extra-argument" },
      { argv: ["add", "work", "--unknown-option", "--pat"], echoed: "--unknown-option" },
    ];
    for (const { argv, echoed } of cases) {
      const result = await session.run(argv, { terminal: true });
      assert.equal(result.code, 2);
      assert.deepEqual(result.err, ["Usage error.", usageText]);
      assert.deepEqual(result.out, []);
      assert.equal(result.prompts, 0);
      assert.equal(printed(result).includes(echoed), false);
    }
  }));

test("remove of a token-shaped name, plain or with a leading space, exits 2 with the note alone, and leaves a token stored under it alone", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await session.tokens.set(TOKEN_SHAPED, TYPED);
    for (const name of [` ${TOKEN_SHAPED}`, TOKEN_SHAPED]) {
      const result = await session.run(["remove", name]);
      assert.equal(result.code, 2);
      assert.deepEqual(result.err, [TOKEN_NOTE]);
      assert.deepEqual(result.out, []);
      assert.equal(printed(result).includes(TOKEN_SHAPED), false);
    }
    // The refusals read and delete nothing in the token store, and they write no registry file.
    assert.equal(session.tokens.calls.get, 0);
    assert.equal(session.tokens.calls.delete, 0);
    assert.equal(existsSync(session.file), false);
    assert.equal(await session.tokens.get(TOKEN_SHAPED), TYPED);
  }));

test("add with three spaces as the typed token prints the no-token error, exits 1, and calls no profile function", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const result = await session.run(["add", "work", "--pat"], { terminal: true, typed: "   " });
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, ["Error: no token was typed."]);
    assert.deepEqual(result.out, []);
    assert.equal(result.profileCalls, 0);
    assert.equal(session.tokens.size(), 0);
  }));

test("add of a name that already exists is refused before the token prompt, with no token typed and no identity check", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work"]);
    const result = await session.run(["add", "work", "--pat"], { terminal: true, typed: TYPED });
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, ['Error: An account named "work" already exists. Remove it first to replace it.']);
    assert.deepEqual(result.out, []);
    assert.equal(result.prompts, 0);
    assert.equal(result.profileCalls, 0);
    assert.equal(session.tokens.size(), 0);
  }));

test("two adds of one name at the same time: one is added, the other is refused as taken, and the file lists one record", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    // The identity check answers after 50 ms, so the second add is still waiting for the lock when the first one saves.
    const slowProfile = async (): Promise<Profile> => {
      await delay(50);
      return WORK_PROFILE;
    };
    const results = await Promise.all([
      session.run(["add", "work", "--pat"], { terminal: true, typed: TYPED, profile: slowProfile }),
      session.run(["add", "work", "--pat"], { terminal: true, typed: TYPED, profile: slowProfile }),
    ]);
    const addedLine = 'Added "work" (a@example.com). It is the default account.';
    const takenLine = 'Error: An account named "work" already exists. Remove it first to replace it.';
    assert.equal(results.filter((result) => result.out.join("\n") === addedLine).length, 1);
    assert.equal(results.filter((result) => result.err.join("\n") === takenLine).length, 1);
    // The taken name is refused before the identity check, so only one check ran.
    assert.equal(results.reduce((total, result) => total + result.profileCalls, 0), 1);
    assert.equal(session.tokens.size(), 1);
    assert.deepEqual((await Registry.load(session.file)).names(), ["work"]);
  }));

test("remove of a name with no record, when the token store cannot read it, prints one line with no keyring text, and exits 1", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    session.tokens.get = async () => {
      throw new Error("keyring-internal-detail");
    };
    const result = await session.run(["remove", "ghost", "--yes"]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, [
      'Error: The stored token for "ghost" could not be read. Run: multi-account-supabase-mcp remove ghost',
    ]);
    assert.deepEqual(result.out, []);
    assert.equal(printed(result).includes("keyring-internal-detail"), false);
  }));

// The text that a command prints on stderr when the lock file could not be removed. It is the text that lock.ts sends.
const LOCK_NOT_REMOVED =
  "The lock file could not be removed. It expires two minutes after it was written, and a change waits for it until then.";

test("default, remove and add each print a lock file that could not be removed on stderr, and keep their exit code", () =>
  inTempFolder(async (folder) => {
    // Each command has a folder of its own. A lock file that stays behind would block the next command in the same folder.
    const realUnlink = releaseHooks.unlink;
    releaseHooks.unlink = async () => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    };
    try {
      const setting = sessionIn(path.join(folder, "default"));
      await seed(setting.file, ["work", "play"]);
      const withDefault = await setting.run(["default", "play"]);
      assert.equal(withDefault.code, 0);
      assert.deepEqual(withDefault.out, ["Default account: play"]);
      assert.deepEqual(withDefault.err, [LOCK_NOT_REMOVED]);

      const removing = sessionIn(path.join(folder, "remove"));
      await seed(removing.file, ["work", "play"]);
      const removed = await removing.run(["remove", "play", "--yes"]);
      assert.equal(removed.code, 0);
      assert.deepEqual(removed.out, ['Removed "play".', TOKEN_STILL_WORKS]);
      assert.deepEqual(removed.err, [LOCK_NOT_REMOVED]);

      const adding = sessionIn(path.join(folder, "add"));
      await seed(adding.file, ["work"]);
      const added = await adding.run(["add", "office", "--pat"], {
        profile: async () => ({ gotrueId: "gotrue-office", email: "office@example.com", username: "office" }),
      });
      assert.equal(added.code, 0);
      assert.deepEqual(added.out, ['Added "office" (office@example.com).']);
      assert.deepEqual(added.err, [LOCK_NOT_REMOVED]);
    } finally {
      releaseHooks.unlink = realUnlink;
    }
  }));

test("install, update and uninstall refuse an unknown flag, a missing value, a repeated option and --yes where it is not used, with exit 2, and call no agent", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const calls: string[] = [];
    const target = path.join(folder, "never-written.txt");
    const adapters = [fakeAgent("claude", target, calls)];
    const cases = [
      ["install", "--bogus"],
      ["install", "--scope"],
      ["install", "--scope", "--dry-run"],
      ["install", "--scope", "project", "--scope", "local"],
      ["update", "--scope"],
      ["update", "--yes"],
      ["update", "--bogus"],
      ["uninstall", "--yes"],
      ["uninstall", "--scope", "--yes"],
    ];
    for (const argv of cases) {
      const result = await session.run(argv, { adapters });
      assert.equal(result.code, 2, argv.join(" "));
      assert.deepEqual(result.err, ["Usage error.", usageText], argv.join(" "));
      assert.deepEqual(result.out, [], argv.join(" "));
    }
    assert.deepEqual(calls, []);
    assert.equal(existsSync(target), false);
  }));

test("doctor takes no argument and no flag: each one exits 2 with the usage error, and calls no agent", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const calls: string[] = [];
    const adapters = [fakeAgent("claude", path.join(folder, "never-written.txt"), calls)];
    for (const argv of [["doctor", "claude"], ["doctor", "--dry-run"], ["doctor", "--yes"]]) {
      const result = await session.run(argv, { adapters });
      assert.equal(result.code, 2, argv.join(" "));
      assert.deepEqual(result.err, ["Usage error.", usageText], argv.join(" "));
      assert.deepEqual(result.out, [], argv.join(" "));
    }
    assert.deepEqual(calls, []);
  }));

test("install asks its questions only when stdin and stdout are both terminals", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const calls: string[] = [];
    const adapters = [fakeAgent("claude", path.join(folder, "never-written.txt"), calls)];
    // Stdin is a terminal and stdout is a pipe: no question is asked, and install refuses without --yes.
    const piped: string[] = [];
    const refused = await session.run(["install"], { adapters, asked: piped });
    assert.equal(refused.code, 2);
    assert.deepEqual(piped, []);
    assert.equal(refused.out.includes("install needs --yes when there is no terminal, so nothing was changed."), true);
    // Both streams are terminals: the agent, scope and apply questions are asked, and blank answers change nothing.
    const asked: string[] = [];
    const answered = await session.run(["install"], { adapters, stdoutTerminal: true, asked });
    assert.equal(answered.code, 0);
    assert.equal(asked.length, 3);
    assert.equal(asked[0]?.startsWith("Which agents?"), true);
    assert.equal(asked[2], "Apply these changes? [y/N] ");
    assert.equal(calls.some((call) => call.endsWith(" real")), false);
  }));

// Rejects after ms, so a question that never gets an answer fails the test instead of waiting for ever.
const within = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
};

// A writable that keeps nothing, for the prompts of the terminal questions.
const discard = (): Writable =>
  new Writable({
    write: (_chunk, _encoding, done) => {
      done();
    },
  });

test("two answers that arrive in one chunk each answer one question, in order", () =>
  inTempFolder(async () => {
    const input = new PassThrough();
    const ask = terminalAsk(input, discard());
    input.write("claude\nproject\n");
    assert.equal(await within(ask("Which agents? "), 2000), "claude");
    assert.equal(await within(ask("Which scope? "), 2000), "project");
  }));

test("a question whose input closes fails with its message, and does not wait", () =>
  inTempFolder(async () => {
    const input = new PassThrough();
    const ask = terminalAsk(input, discard());
    const pending = ask("Which agents? ");
    input.end();
    await assert.rejects(within(pending, 2000), { message: "The input closed before an answer was given." });
  }));

// A writable that keeps what is written to it, so a test can read the prompts and the echoed answers.
const capture = (): { stream: Writable; text: () => string } => {
  const chunks: string[] = [];
  const stream = new Writable({
    write: (chunk, _encoding, done) => {
      chunks.push(String(chunk));
      done();
    },
  });
  return { stream, text: () => chunks.join("") };
};

test("an answer kept from the same chunk is echoed without its text when the text has the shape of a token", () =>
  inTempFolder(async () => {
    const input = new PassThrough();
    const sink = capture();
    const ask = terminalAsk(input, sink.stream);
    input.write(`claude\n${TOKEN_SHAPED}\n`);
    assert.equal(await within(ask("Which agents? "), 2000), "claude");
    assert.equal(await within(ask("Which scope? "), 2000), TOKEN_SHAPED);
    assert.equal(sink.text().includes(TOKEN_SHAPED), false);
    assert.equal(sink.text().includes(TOKEN_NOTE), true);
  }));

test("a change that is not a dry run gets an interrupt handler, and the handler is removed when asked", () =>
  inTempFolder(async () => {
    const stream = discard();
    const cases: [string[], number][] = [
      [["install"], 1],
      [["update", "claude"], 1],
      [["uninstall", "--scope", "project"], 1],
      [["install", "--dry-run"], 0],
      [["uninstall", "--dry-run"], 0],
      [["doctor"], 0],
      [["serve"], 0],
      [[], 0],
    ];
    for (const [argv, expected] of cases) {
      const source = new EventEmitter();
      const stop = watchInterrupt(argv, source, { stdout: stream, stderr: stream }, () => {});
      assert.equal(source.listenerCount("SIGINT"), expected, argv.join(" "));
      stop();
      assert.equal(source.listenerCount("SIGINT"), 0, argv.join(" "));
    }
  }));

test("the first Ctrl+C of a change asks it to stop, and does not exit", () =>
  inTempFolder(async () => {
    const stream = discard();
    const source = new EventEmitter();
    let exits = 0;
    const stop = watchInterrupt(["install"], source, { stdout: stream, stderr: stream }, () => {
      exits += 1;
    });
    try {
      source.emit("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(exits, 0);
    } finally {
      stop();
    }
  }));

test("an interrupt of a change writes the notice to stderr after the stdout lines already written, then exits 130", () =>
  inTempFolder(async () => {
    const order: string[] = [];
    // A pipe can take its writes after a delay, so this stdout delays each write.
    const stdout = new Writable({
      write: (chunk, _encoding, done) => {
        setTimeout(() => {
          if (String(chunk) !== "") {
            order.push("stdout line written");
          }
          done();
        }, 20);
      },
    });
    const stderr = new Writable({
      write: (chunk, _encoding, done) => {
        order.push(`stderr ${String(chunk).trimEnd()}`);
        done();
      },
    });
    const source = new EventEmitter();
    const exited = new Promise<number>((resolve) => {
      watchInterrupt(["install"], source, { stdout, stderr }, resolve);
    });
    stdout.write("the last plan line\n");
    // The first Ctrl+C asks the change to stop. The second one exits at once.
    source.emit("SIGINT");
    source.emit("SIGINT");
    assert.equal(await within(exited, 2000), 130);
    assert.deepEqual(order, ["stdout line written", `stderr ${INTERRUPT_NOTICE}`]);
  }));

test("install with stdin a pipe and stdout a terminal asks nothing, and refuses without --yes", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const calls: string[] = [];
    const target = path.join(folder, "never-written.txt");
    const adapters = [fakeAgent("claude", target, calls)];
    const asked: string[] = [];
    const result = await session.run(["install"], { adapters, terminal: false, stdoutTerminal: true, asked });
    assert.equal(result.code, 2);
    assert.deepEqual(asked, []);
    assert.equal(calls.some((call) => call.endsWith(" real")), false);
    assert.equal(existsSync(target), false);
  }));

test("install, update and uninstall with a token-shaped agent name exit 2 with the note alone, and run nothing", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const calls: string[] = [];
    const target = path.join(folder, "never-written.txt");
    const adapters = [fakeAgent("claude", target, calls)];
    for (const command of ["install", "update", "uninstall"]) {
      for (const name of [TOKEN_SHAPED, ` ${TOKEN_SHAPED}`]) {
        const result = await session.run([command, name], { adapters });
        assert.equal(result.code, 2, command);
        assert.deepEqual(result.err, [TOKEN_NOTE], command);
        assert.deepEqual(result.out, [], command);
        assert.equal(printed(result).includes(TOKEN_SHAPED), false, command);
      }
    }
    assert.deepEqual(calls, []);
    assert.equal(existsSync(target), false);
  }));

test("add, default and remove with a switch given twice exit 2 with the usage error, and write nothing", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const added = await session.run(["add", "play", "--pat", "--pat"], { terminal: true, typed: TYPED });
    assert.equal(added.code, 2);
    assert.deepEqual(added.err, ["Usage error.", usageText]);
    assert.equal(added.prompts, 0);
    assert.equal(session.tokens.size(), 0);
    assert.equal(existsSync(session.file), false);

    await seed(session.file, ["work"]);
    const before = await readFile(session.file, "utf8");
    for (const argv of [
      ["default", "work", "--pat", "--pat"],
      ["remove", "work", "--pat", "--pat"],
    ]) {
      const result = await session.run(argv);
      assert.equal(result.code, 2, argv[0]);
      assert.deepEqual(result.err, ["Usage error.", usageText], argv[0]);
      assert.deepEqual(result.out, [], argv[0]);
    }
    assert.equal(await readFile(session.file, "utf8"), before);
    assert.equal(session.tokens.calls.get + session.tokens.calls.delete, 0);
  }));

const REMOVE_QUESTION = "Remove the account work and its stored token? Type y to remove: ";
const REMOVE_NEEDS_YES = "remove needs --yes when there is no terminal to ask in. Nothing was removed.";

test("remove without --yes and with no terminal is refused with exit 2, names no account content, and removes nothing", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work"]);
    await session.tokens.set("work", TYPED);
    const before = await readFile(session.file, "utf8");
    const asked: string[] = [];
    const result = await session.run(["remove", "work"], { terminal: false, asked });
    assert.equal(result.code, 2);
    assert.deepEqual(result.err, [REMOVE_NEEDS_YES]);
    assert.deepEqual(result.out, []);
    assert.deepEqual(asked, []);
    assert.equal(await readFile(session.file, "utf8"), before);
    assert.equal(await session.tokens.get("work"), TYPED);
  }));

test("remove in a terminal asks first, and y removes the account and its token", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work"]);
    await session.tokens.set("work", TYPED);
    const asked: string[] = [];
    const result = await session.run(["remove", "work"], {
      terminal: true,
      stdoutTerminal: true,
      asked,
      answers: ["y"],
    });
    assert.equal(result.code, 0);
    assert.deepEqual(asked, [REMOVE_QUESTION]);
    assert.deepEqual(result.out, ['Removed "work".', TOKEN_STILL_WORKS]);
    assert.deepEqual((await Registry.load(session.file)).names(), []);
    assert.equal(await session.tokens.get("work"), undefined);
  }));

test("remove in a terminal removes nothing for any answer but y or yes, in any case and trimmed, and a decline exits 0", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work"]);
    await session.tokens.set("work", TYPED);
    for (const answer of ["", "n", "no", "yess"]) {
      const result = await session.run(["remove", "work"], {
        terminal: true,
        stdoutTerminal: true,
        answers: [answer],
      });
      assert.equal(result.code, 0, answer);
      assert.deepEqual(result.out, ["Nothing was removed."], answer);
      assert.deepEqual(result.err, [], answer);
    }
    assert.deepEqual((await Registry.load(session.file)).names(), ["work"]);
    assert.equal(await session.tokens.get("work"), TYPED);
    const accepted = await session.run(["remove", "work"], {
      terminal: true,
      stdoutTerminal: true,
      answers: ["  YES  "],
    });
    assert.equal(accepted.code, 0);
    assert.deepEqual(accepted.out, ['Removed "work".', TOKEN_STILL_WORKS]);
  }));

test("a Ctrl+C at the remove question removes nothing, prints that no answer was read, and exits 1", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work"]);
    await session.tokens.set("work", TYPED);
    const result = await session.run(["remove", "work"], { terminal: true, stdoutTerminal: true, askFails: true });
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, ["No answer could be read, so nothing was removed."]);
    assert.deepEqual((await Registry.load(session.file)).names(), ["work"]);
    assert.equal(await session.tokens.get("work"), TYPED);
  }));

test("remove --yes removes without a question, in a terminal and with no terminal", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work", "play"]);
    await session.tokens.set("work", TYPED);
    await session.tokens.set("play", TYPED);
    const asked: string[] = [];
    const inTerminal = await session.run(["remove", "work", "--yes"], { terminal: true, stdoutTerminal: true, asked });
    assert.equal(inTerminal.code, 0);
    const piped = await session.run(["remove", "play", "--yes"], { terminal: false, asked });
    assert.equal(piped.code, 0);
    assert.deepEqual(asked, []);
    assert.deepEqual((await Registry.load(session.file)).names(), []);
  }));

test("remove with stdin a terminal and stdout a pipe does not ask, and follows the no-terminal rule", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work"]);
    await session.tokens.set("work", TYPED);
    const before = await readFile(session.file, "utf8");
    const asked: string[] = [];
    const result = await session.run(["remove", "work"], { terminal: true, stdoutTerminal: false, asked });
    assert.equal(result.code, 2);
    assert.deepEqual(result.err, [REMOVE_NEEDS_YES]);
    assert.deepEqual(asked, []);
    assert.equal(await readFile(session.file, "utf8"), before);
    assert.equal(await session.tokens.get("work"), TYPED);
  }));

test("a terminal remove of an unknown name asks no question, prints No account named, exits 1, and writes nothing", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work"]);
    const before = await readFile(session.file, "utf8");
    const asked: string[] = [];
    const result = await session.run(["remove", "ghost"], { terminal: true, stdoutTerminal: true, asked });
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, ['Error: No account named "ghost".']);
    assert.deepEqual(result.out, []);
    assert.deepEqual(asked, []);
    assert.equal(await readFile(session.file, "utf8"), before);
    assert.equal(session.tokens.calls.delete, 0);
    assert.equal(session.tokens.size(), 0);
  }));

test("remove with --yes given twice, or with an unknown switch, exits 2 with the usage error, and removes nothing", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    await seed(session.file, ["work"]);
    for (const argv of [
      ["remove", "work", "--yes", "--yes"],
      ["remove", "work", "--bogus"],
    ]) {
      const result = await session.run(argv, { terminal: false });
      assert.equal(result.code, 2, argv.join(" "));
      assert.deepEqual(result.err, ["Usage error.", usageText], argv.join(" "));
      assert.deepEqual(result.out, [], argv.join(" "));
    }
    assert.deepEqual((await Registry.load(session.file)).names(), ["work"]);
  }));

test("the remove line of the usage text says it asks first in a terminal and needs --yes without one", () =>
  inTempFolder(async () => {
    const line = usageText.split("\n").find((text) => text.includes("remove <name>"));
    assert.equal(
      line,
      "  remove <name>         Remove an account and its stored token. Asks first in a terminal; needs --yes without one.",
    );
  }));

test("install --dry-run prints the plan, exits 0, and writes no file", () =>
  inTempFolder(async (folder) => {
    const target = path.join(folder, "would-write.txt");
    const calls: string[] = [];
    const session = sessionIn(folder);
    const result = await session.run(["install", "claude", "--dry-run"], {
      adapters: [fakeAgent("claude", target, calls)],
    });
    assert.equal(result.code, 0);
    assert.equal(existsSync(target), false);
    assert.deepEqual(calls, ["install claude global dry"]);
    assert.deepEqual(result.err, []);
    assert.equal(
      result.out.some((line) => line.includes(target)),
      true,
    );
    assert.equal(result.out.includes("[ok] claude global: Would install claude."), true);
    assert.equal(result.out.at(-1), "Dry run: nothing was changed.");
  }));

test("the change predicate is install, update and uninstall that are not dry runs, and the notice says a change had started", () =>
  inTempFolder(async () => {
    assert.equal(isChangeCommand(["install"]), true);
    assert.equal(isChangeCommand(["update", "claude"]), true);
    assert.equal(isChangeCommand(["uninstall", "--scope", "project"]), true);
    assert.equal(isChangeCommand(["install", "--dry-run"]), false);
    assert.equal(isChangeCommand(["uninstall", "--dry-run"]), false);
    assert.equal(isChangeCommand(["doctor"]), false);
    assert.equal(isChangeCommand(["serve"]), false);
    assert.equal(isChangeCommand([]), false);
    assert.equal(INTERRUPT_NOTICE.includes("If a change had started, it may be partly made."), true);
  }));

test("the uninstall line of the usage text says that the Claude marketplace stays", () =>
  inTempFolder(async () => {
    const line = usageText.split("\n").find((text) => text.includes("uninstall [agent...]"));
    assert.equal(line?.includes("the Claude marketplace stay."), true);
  }));

test("a switch given twice is a usage error for install, update and uninstall, with exit 2, and calls no agent", () =>
  inTempFolder(async (folder) => {
    const session = sessionIn(folder);
    const calls: string[] = [];
    const target = path.join(folder, "never-written.txt");
    const adapters = [fakeAgent("claude", target, calls)];
    const cases = [
      ["install", "--dry-run", "--dry-run"],
      ["install", "--yes", "--yes"],
      ["update", "--dry-run", "--dry-run"],
      ["uninstall", "--dry-run", "--dry-run"],
    ];
    for (const argv of cases) {
      const result = await session.run(argv, { adapters });
      assert.equal(result.code, 2, argv.join(" "));
      assert.deepEqual(result.err, ["Usage error.", usageText], argv.join(" "));
      assert.deepEqual(result.out, [], argv.join(" "));
    }
    assert.deepEqual(calls, []);
    assert.equal(existsSync(target), false);
  }));
