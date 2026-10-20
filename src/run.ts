import { addAccount } from "./accounts/add-account.js";
import { assertValidName } from "./accounts/names.js";
import { Registry } from "./accounts/registry.js";
import { accountListText } from "./mux/account-tools.js";
import type { TokenStore } from "./secrets/token-store.js";
import type { Profile } from "./supabase/api.js";
import { usageText } from "./usage.js";

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
};

// Text that contains sbp_ (in any case) has the shape of a token, and the CLI never prints it. No valid account name
// has an underscore, so no valid name is refused.
const TOKEN_NOTE = "That input looks like a token, so it is not repeated.";
const looksLikeToken = (text: string): boolean => /sbp_/i.test(text);
const shown = (text: string): string => (looksLikeToken(text) ? TOKEN_NOTE : text);

const NEEDS_PAT = "Adding an account needs --pat. Run in a terminal: multi-account-supabase-mcp add <name> --pat";
const NOT_A_TERMINAL = "The token is typed in a terminal, not piped. Run this command in a terminal window.";
const REDACTED = "[redacted]";

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

type Parsed = { positional: string[]; flags: Set<string> };

// Splits the arguments of a command that takes the given flags. An argument that starts with "-" and is not one of
// those flags is an unknown option, and the result is undefined.
const parseArgs = (args: string[], flags: readonly string[]): Parsed | undefined => {
  const positional: string[] = [];
  const given = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("-")) {
      positional.push(arg);
    } else if (flags.includes(arg)) {
      given.add(arg);
    } else {
      return undefined;
    }
  }
  return { positional, flags: given };
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
    throw new Error(TOKEN_NOTE);
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
    const record = await addAccount(
      {
        registry,
        tokens: io.tokens,
        fetchProfile: io.fetchProfile,
        addedAt: io.addedAt,
        warn: (text) => io.stderr(text),
      },
      name,
      token,
    );
    const isDefault = registry.defaultName() === name ? " It is the default account." : "";
    summary = `Added "${shown(record.name)}" (${record.email}).${isDefault}`;
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
  const registry = await Registry.load(io.registryFile);
  // Checked here, not by setDefault, because setDefault's message would print the name as it was typed.
  if (registry.get(name) === undefined) {
    throw new Error(`No account named "${shown(name)}".`);
  }
  registry.setDefault(name);
  await registry.save();
  io.stdout(`Default account: ${shown(name)}`);
  return 0;
};

// remove <name>. It removes the record and the token. A name with no record still has its token removed when one is
// stored, because the add rollback tells the owner to run this command.
const removeCommand = async (args: string[], io: CliIo): Promise<number> => {
  const parsed = parseArgs(args, []);
  if (parsed === undefined || parsed.positional.length !== 1) {
    return usageError(io);
  }
  const [name] = parsed.positional;
  // A token-shaped name names no account, so nothing stored under it is read or deleted.
  if (looksLikeToken(name)) {
    throw new Error(`No account named "${shown(name)}".`);
  }
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
  return 0;
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
    case "help":
    case "--help":
    case "-h":
      return helpCommand(args, io);
    default:
      io.stderr(`Unknown command "${shown(command)}".`);
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
