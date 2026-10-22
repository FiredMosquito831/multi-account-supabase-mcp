import { EventEmitter } from "node:events";
import { createInterface } from "node:readline/promises";
import { addAccount } from "./accounts/add-account.js";
import { withRegistryLock } from "./accounts/lock.js";
import { assertValidName } from "./accounts/names.js";
import { Registry } from "./accounts/registry.js";
import type { FlowIo } from "./install/flow.js";
import { accountListText } from "./mux/account-tools.js";
import type { TokenStore } from "./secrets/token-store.js";
import type { Profile } from "./supabase/api.js";
import { usageText } from "./usage.js";

// The inputs of the install, update, uninstall and doctor commands that the CLI builds from the process: the question, the
// folders, the environment and the program path. The terminal test, the output and the token store come from CliIo itself.
export type FlowEnvironment = Omit<FlowIo, "isTerminal" | "out" | "tokens">;

// The questions of a terminal install. Each question opens an interface on the input, and closes it after its answer. A line
// that ends in the same chunk, after an answer, is kept for the next question. A line with no line end at the close of the
// chunk is not kept, because readline does not report it, so the question after it starts without it. Ctrl+C at a question
// closes the interface, and the question then fails.
export const terminalAsk = (input: NodeJS.ReadableStream, output: NodeJS.WritableStream) => {
  const kept: string[] = [];
  return (question: string): Promise<string> => {
    const earlier = kept.shift();
    if (earlier !== undefined) {
      output.write(`${question}${shown(earlier)}\n`);
      return Promise.resolve(earlier);
    }
    return new Promise((resolve, reject) => {
      const rl = createInterface({ input, output });
      let answered = false;
      let closed = false;
      rl.once("close", () => {
        closed = true;
        reject(new Error("The input closed before an answer was given."));
      });
      rl.on("line", (line) => {
        if (answered) {
          kept.push(line);
          return;
        }
        answered = true;
        resolve(line);
        // The interface closes after the chunk that holds this line has been read, so the lines after it are kept.
        queueMicrotask(() => {
          if (!closed) {
            rl.close();
          }
        });
      });
      rl.on("SIGINT", () => {
        rl.close();
      });
      rl.setPrompt(question);
      rl.prompt();
    });
  };
};

// Everything a command reads or writes. cli.ts builds the real one, and the tests build fakes.
export type CliIo = {
  stdout(text: string): void;
  stderr(text: string): void;
  stdinIsTerminal: boolean;
  stdoutIsTerminal: boolean;
  readSecret(): Promise<string>;
  registryFile: string;
  tokens: TokenStore;
  fetchProfile: (token: string) => Promise<Profile>;
  addedAt: () => string;
  serve: () => Promise<void>;
  flow: FlowEnvironment;
};

// Text that contains sbp_ (in any case) has the shape of a token, and the CLI never prints it. A command or a name with
// this shape gets the note alone, and exit code 2. No valid account name has an underscore, so no valid name is refused.
const TOKEN_NOTE = "That input looks like a token, so it is not repeated.";
const looksLikeToken = (text: string): boolean => /sbp_/i.test(text);
const shown = (text: string): string => (looksLikeToken(text) ? TOKEN_NOTE : text);

const NEEDS_PAT = "Adding an account needs --pat. Run in a terminal: multi-account-supabase-mcp add <name> --pat";
const NOT_A_TERMINAL = "The token is typed in a terminal, not piped. Run this command in a terminal window.";
const REDACTED = "[redacted]";
// The line that remove prints after the removed line. Removing the record does not revoke the token at Supabase.
const TOKEN_STILL_WORKS = "The Supabase token still works until you revoke it in your Supabase account settings.";

// Removes each secret from a text. An empty secret is skipped, so it cannot split the text.
const redact = (text: string, secrets: readonly string[]): string =>
  secrets.reduce((result, secret) => (secret === "" ? result : result.split(secret).join(REDACTED)), text);

// The one handler for a failed command. It writes "Error: <message>", then the cause's message on the
// next line, indented by two spaces. Both pass through redact. It returns exit code 1.
const reportError = (io: CliIo, error: unknown, secrets: readonly string[]): number => {
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(`Error: ${redact(message, secrets)}`);
  if (error instanceof Error && error.cause instanceof Error) {
    io.stderr(`  ${redact(error.cause.message, secrets)}`);
  }
  return 1;
};

// A missing or extra argument, or an unknown option. It is a usage error, and it echoes nothing from the input.
const usageError = (io: CliIo): number => {
  io.stderr("Usage error.");
  io.stderr(usageText);
  return 2;
};

type Parsed = { positional: string[]; flags: Set<string>; values: Map<string, string> };

// Splits the arguments of a command. A switch stands alone. A valued flag takes the next argument as its value, and the
// value must not be empty or start with "-". A valued flag may be given once. Any other argument that starts with "-" is an
// unknown option. Each of these gives undefined, which is a usage error.
const parseArgs = (args: string[], switches: readonly string[], valued: readonly string[] = []): Parsed | undefined => {
  const positional: string[] = [];
  const flags = new Set<string>();
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-")) {
      positional.push(arg);
    } else if (switches.includes(arg)) {
      flags.add(arg);
    } else if (valued.includes(arg)) {
      const value = args[index + 1];
      if (value === undefined || value === "" || value.startsWith("-") || values.has(arg)) {
        return undefined;
      }
      values.set(arg, value);
      index += 1;
    } else {
      return undefined;
    }
  }
  return { positional, flags, values };
};

// add <name> --pat. The token comes from the prompt, with hidden input, and never from a pipe or the chat.
const addCommand = async (args: string[], io: CliIo): Promise<number> => {
  const parsed = parseArgs(args, ["--pat"]);
  if (parsed === undefined || parsed.positional.length !== 1) {
    return usageError(io);
  }
  const [name] = parsed.positional;
  if (!parsed.flags.has("--pat")) {
    io.stderr(NEEDS_PAT);
    return 2;
  }
  if (!io.stdinIsTerminal) {
    io.stderr(NOT_A_TERMINAL);
    return 2;
  }
  // The name is checked before the prompt, so a bad name never asks for a token. A token-shaped name gets the note
  // alone, so the name is not printed.
  if (looksLikeToken(name)) {
    io.stderr(TOKEN_NOTE);
    return 2;
  }
  assertValidName(name);
  // The registry is read before the prompt, so a file that cannot be read is reported before a token is typed.
  const registry = await Registry.load(io.registryFile);
  // A taken name is refused before the prompt, with the same words the account code uses, so no token is typed for it.
  if (registry.get(name) !== undefined) {
    throw new Error(`An account named "${name}" already exists. Remove it first to replace it.`);
  }
  // Spaces around the typed value are not part of a token, so they are removed before any use.
  const token = (await io.readSecret()).trim();
  if (token === "") {
    throw new Error("no token was typed.");
  }
  let summary: string;
  try {
    // The lock is taken after the prompt, so no other command waits while the owner types. Inside it, the registry is
    // read again, so the name check and the save use the file as it is at that time.
    summary = await withRegistryLock(io.registryFile, async () => {
      const fresh = await Registry.load(io.registryFile);
      const record = await addAccount(
        {
          registry: fresh,
          tokens: io.tokens,
          fetchProfile: io.fetchProfile,
          addedAt: io.addedAt,
          warn: (text) => io.stderr(text),
        },
        name,
        token,
      );
      const isDefault = fresh.defaultName() === name ? " It is the default account." : "";
      return `Added "${shown(record.name)}" (${record.email}).${isDefault}`;
    }, { onReleaseFailure: (text) => io.stderr(text) });
  } catch (error) {
    // The typed token is removed from the message and the cause before anything is printed.
    return reportError(io, error, [token]);
  }
  // The summary is printed after the try block, once the account is saved.
  io.stdout(summary);
  return 0;
};

// list. The text never holds a token.
const listCommand = async (args: string[], io: CliIo): Promise<number> => {
  if (args.length > 0) {
    return usageError(io);
  }
  io.stdout(accountListText(await Registry.load(io.registryFile)));
  return 0;
};

// default <name>.
const defaultCommand = async (args: string[], io: CliIo): Promise<number> => {
  const parsed = parseArgs(args, []);
  if (parsed === undefined || parsed.positional.length !== 1) {
    return usageError(io);
  }
  const [name] = parsed.positional;
  // A token-shaped name is refused before the registry is read or the lock is taken, so no file or store is touched.
  if (looksLikeToken(name)) {
    io.stderr(TOKEN_NOTE);
    return 2;
  }
  // The change runs under the lock, and the registry is read again inside it.
  return withRegistryLock(io.registryFile, async () => {
    const registry = await Registry.load(io.registryFile);
    // Checked here, not by setDefault, because setDefault's message would print the name as it was typed.
    if (registry.get(name) === undefined) {
      throw new Error(`No account named "${shown(name)}".`);
    }
    registry.setDefault(name);
    await registry.save();
    io.stdout(`Default account: ${shown(name)}`);
    return 0;
  }, { onReleaseFailure: (text) => io.stderr(text) });
};

// remove <name>. It removes the record and the token. A name with no record still has its token removed when one is
// stored, because the add rollback tells the owner to run this command.
const removeCommand = async (args: string[], io: CliIo): Promise<number> => {
  const parsed = parseArgs(args, []);
  if (parsed === undefined || parsed.positional.length !== 1) {
    return usageError(io);
  }
  const [name] = parsed.positional;
  // A token-shaped name names no account, so nothing stored under it is read or deleted, and the registry is not read.
  if (looksLikeToken(name)) {
    io.stderr(TOKEN_NOTE);
    return 2;
  }
  // The whole removal runs under the lock, and the registry is read again inside it.
  return withRegistryLock(io.registryFile, async () => {
    const registry = await Registry.load(io.registryFile);
    const hadRecord = registry.remove(name) !== undefined;
    if (hadRecord) {
      await registry.save();
    } else {
      // A name with no record is known only by its stored token, so the store is read. A failed read gets one fixed
      // line, and the keyring's own text is left out.
      let stored: string | undefined;
      try {
        stored = await io.tokens.get(name);
      } catch {
        io.stderr(
          `Error: The stored token for "${shown(name)}" could not be read. Run: multi-account-supabase-mcp remove ${shown(name)}`,
        );
        return 1;
      }
      if (stored === undefined) {
        throw new Error(`No account named "${shown(name)}".`);
      }
    }
    try {
      await io.tokens.delete(name);
    } catch {
      // The keyring's own text is left out. Running remove again finds the token and deletes it.
      const remedy = `multi-account-supabase-mcp remove ${shown(name)}`;
      io.stderr(
        hadRecord
          ? `Error: The account "${shown(name)}" was removed, but its stored token could not be deleted. Run: ${remedy}`
          : `Error: The stored token for "${shown(name)}" could not be deleted. Run: ${remedy}`,
      );
      return 1;
    }
    io.stdout(`Removed "${shown(name)}".`);
    io.stdout(TOKEN_STILL_WORKS);
    return 0;
  }, { onReleaseFailure: (text) => io.stderr(text) });
};

// serve. It runs io.serve, and it returns 0 when that resolves.
const serveCommand = async (args: string[], io: CliIo): Promise<number> => {
  if (args.length > 0) {
    return usageError(io);
  }
  await io.serve();
  return 0;
};

const helpCommand = (args: string[], io: CliIo): number => {
  if (args.length > 0) {
    return usageError(io);
  }
  io.stdout(usageText);
  return 0;
};

// The io of the install commands: the parts the CLI builds from the process, with the terminal test taken from both streams,
// the output going to stdout, and the token store of this run.
const flowIoOf = (io: CliIo): FlowIo => ({
  ...io.flow,
  isTerminal: io.stdinIsTerminal && io.stdoutIsTerminal,
  out: (line) => {
    io.stdout(line);
  },
  tokens: io.tokens,
});

type ChangeAction = "install" | "update" | "uninstall";

// The switches that each change command takes. Only install takes --yes, so the others refuse it as an unknown option.
const CHANGE_SWITCHES: Record<ChangeAction, readonly string[]> = {
  install: ["--dry-run", "--yes"],
  update: ["--dry-run"],
  uninstall: ["--dry-run"],
};

// The commands that change an agent's configuration, and a run of one of them that is not a dry run. cli.ts prints the notice
// when such a run is interrupted. A dry run changes nothing, so an interrupt during one gets no notice.
const CHANGE_COMMANDS: readonly string[] = ["install", "update", "uninstall"];
export const isChangeCommand = (argv: readonly string[]): boolean =>
  CHANGE_COMMANDS.includes(argv[0] ?? "") && !argv.includes("--dry-run");

// The line written after an interrupt of a change. It says a change may be partly made only when one had started.
export const INTERRUPT_NOTICE =
  "Stopped by Ctrl+C. If a change had started, it may be partly made. Check the agent's own configuration, and run multi-account-supabase-mcp uninstall --dry-run to see what is recorded.";

// Watches for an interrupt during a change that is not a dry run. Other commands get no handler. Returns a function that removes it.
export const watchInterrupt = (
  argv: readonly string[],
  source: EventEmitter,
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
  exit: (code: number) => void,
): (() => void) => {
  if (!isChangeCommand(argv)) {
    return () => {};
  }
  // Writes to a pipe or a console can finish after the call returns. An empty write to stdout waits for the lines already
  // queued there, so the last line is written before the notice and the exit.
  const handler = (): void => {
    streams.stdout.write("", () => {
      streams.stderr.write(`${INTERRUPT_NOTICE}\n`, () => exit(130));
    });
  };
  source.once("SIGINT", handler);
  return () => {
    source.removeListener("SIGINT", handler);
  };
};

// Install, update and uninstall. The named arguments are agent names, and --scope names one scope. The flow checks the names
// and the scope, and it asks its own questions in a terminal, so this function only reads the command line.
const changeCommand = async (action: ChangeAction, args: string[], io: CliIo): Promise<number> => {
  // A switch given twice is refused, as a repeated valued flag is. The check sits here, not in parseArgs, so that add,
  // default and remove keep their behaviour.
  const repeated = CHANGE_SWITCHES[action].some((name) => args.filter((arg) => arg === name).length > 1);
  const parsed = repeated ? undefined : parseArgs(args, CHANGE_SWITCHES[action], ["--scope"]);
  if (parsed === undefined) {
    return usageError(io);
  }
  // An agent name with the shape of a token is refused with the note alone, as add, default and remove refuse one, so the
  // name is printed nowhere.
  if (parsed.positional.some((name) => looksLikeToken(name))) {
    io.stderr(TOKEN_NOTE);
    return 2;
  }
  const installFlow = await import("./install/flow.js");
  return installFlow[action](
    {
      agents: parsed.positional,
      scope: parsed.values.get("--scope"),
      dryRun: parsed.flags.has("--dry-run"),
      yes: parsed.flags.has("--yes"),
    },
    flowIoOf(io),
  );
};

// doctor takes no argument and no flag.
const doctorCommand = async (args: string[], io: CliIo): Promise<number> => {
  if (args.length > 0) {
    return usageError(io);
  }
  const installFlow = await import("./install/flow.js");
  return installFlow.doctor(flowIoOf(io));
};

const dispatch = async (argv: string[], io: CliIo): Promise<number> => {
  if (argv.length === 0) {
    // No command: a terminal gets the usage text, and a pipe (an agent's stdio) starts the server.
    if (io.stdinIsTerminal) {
      io.stdout(usageText);
      return 0;
    }
    return serveCommand([], io);
  }
  const [command, ...args] = argv;
  switch (command) {
    case "add":
      return addCommand(args, io);
    case "list":
      return listCommand(args, io);
    case "default":
      return defaultCommand(args, io);
    case "remove":
      return removeCommand(args, io);
    case "serve":
      return serveCommand(args, io);
    case "install":
      return changeCommand("install", args, io);
    case "update":
      return changeCommand("update", args, io);
    case "uninstall":
      return changeCommand("uninstall", args, io);
    case "doctor":
      return doctorCommand(args, io);
    case "help":
    case "--help":
    case "-h":
      return helpCommand(args, io);
    default:
      // A token-shaped command gets the note alone, so the text is not printed.
      if (looksLikeToken(command)) {
        io.stderr(TOKEN_NOTE);
        return 2;
      }
      io.stderr(`Unknown command "${command}".`);
      io.stderr(usageText);
      return 2;
  }
};

// Runs one command and returns its exit code. Importing this module has no effect. Every failure ends in reportError.
export const runCli = async (argv: string[], io: CliIo): Promise<number> => {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    return reportError(io, error, []);
  }
};
