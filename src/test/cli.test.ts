import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { type AccountRecord, Registry } from "../accounts/registry.js";
import { type CliIo, runCli } from "../run.js";
import type { TokenStore } from "../secrets/token-store.js";
import type { Profile } from "../supabase/api.js";
import { usageText } from "../usage.js";

// Fake values only. TYPED is what the owner types at the prompt. It must never reach any output.
const TYPED = "tok-SECRET-123";
const TOKEN_SHAPED = "sbp_fake-not-a-token";
const TOKEN_NOTE = "That input looks like a token, so it is not repeated.";
const ADDED_AT = "2026-10-20T09:00:00.000Z";
const WORK_PROFILE: Profile = { gotrueId: "gotrue-work", email: "a@example.com", username: "fake-user" };

// Each test gets its own folder under the system temp folder, and removes it afterwards. No test reads the
// owner's data folder, reaches the network or the credential store, or imports the keyring module.
const inTempFolder = async (run: (folder: string) => Promise<void>): Promise<void> => {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cli-test-"));
  try {
    await run(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
};

// An in-memory token store. It implements the interface only, so the test never loads token-store.ts at run time.
class FakeTokens implements TokenStore {
  private readonly held = new Map<string, string>();

  async get(account: string): Promise<string | undefined> {
    return this.held.get(account);
  }

  async set(account: string, token: string): Promise<void> {
    this.held.set(account, token);
  }

  async delete(account: string): Promise<void> {
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
};

type Result = {
  code: number;
  out: string[];
  err: string[];
  prompts: number;
  profileCalls: number;
  serveCalls: number;
};

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
      stdoutIsTerminal: false,
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
      await session.run(["remove", "work"]),
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
    const result = await session.run(["remove", "work"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ['Removed "work".']);
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
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, [`Error: ${TOKEN_NOTE}`]);
    assert.deepEqual(result.out, []);
    assert.equal(result.prompts, 0);
    assert.equal(printed(result).includes(TOKEN_SHAPED), false);
    assert.equal(session.tokens.size(), 0);
  }));

test("an unknown command that starts with sbp_ prints the note in place of the command", () =>
  inTempFolder(async (folder) => {
    const result = await sessionIn(folder).run([TOKEN_SHAPED]);
    assert.equal(result.code, 2);
    assert.deepEqual(result.err, [`Unknown command "${TOKEN_NOTE}".`, usageText]);
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
    const result = await session.run(["remove", "ghost"]);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ['Removed "ghost".']);
    assert.deepEqual(result.err, []);
    assert.equal(await session.tokens.get("ghost"), undefined);
  }));

test("remove of a name with neither a record nor a token exits 1", () =>
  inTempFolder(async (folder) => {
    const result = await sessionIn(folder).run(["remove", "nobody"]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.err, ['Error: No account named "nobody".']);
    assert.deepEqual(result.out, []);
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
