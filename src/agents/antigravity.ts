import type { CommandResult } from "./command.js";
import { DIRECT_KEY, directEntry, type Scope, supportedScopes } from "./scopes.js";
import { forget, record, recordedItems, scopeKey } from "./state.js";
import { type AgentAdapter, type Context, type Step, UnsupportedScope } from "./types.js";

// The Antigravity adapter. Antigravity's own program, agy, adds, removes and lists the servers, so this adapter runs those
// commands and edits no file. Antigravity has no scope flag, and its servers are global only, so the project and local
// scopes are refused. The output of agy is not verified yet, so the doctor check and the not-installed check read it as
// plain words.

const SCOPES = supportedScopes("antigravity");

// The program that manages the servers. On Windows the file is agy.exe, which the command runner finds on PATH.
const PROGRAM = "agy";

const NOT_INSTALLED = "not installed in this scope";
const NOT_INSTALLED_GLOBALLY = "not installed globally";
const SCOPE_MESSAGE = "antigravity has no local scope, and no project scope. Use global.";

// The characters that end one word of the output. A table bar, a colon or a bracket next to the name still leaves it as
// one word. A longer name that merely contains the name, such as the same name with a hyphen and more text, is a
// different word.
const WORD_BREAK = /[\s|│:,;()[\]"'=]+/;

// Whether the text names the server as one whole word.
const namesServer = (text: string): boolean => text.split(WORD_BREAK).includes(DIRECT_KEY);

// The words of a report that the server is absent. The wording of agy is not verified, so these words are a guess.
const NOT_INSTALLED_REPORT = /\b(?:not (?:installed|found|configured)|does not exist)\b/i;

// Whether a failed removal reports that this server is absent. The report must name the server on the same line as the
// words, so an unrelated "not found", such as one about a settings file, is never taken for an absent server.
const reportsNotInstalled = (result: CommandResult): boolean =>
  `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .some((line) => namesServer(line) && NOT_INSTALLED_REPORT.test(line));

const step = (status: Step["status"], message: string): Step => ({
  agent: "antigravity",
  scope: "global",
  status,
  message,
});

// The first output that is not empty: the error output, then the standard output, and otherwise the exit code.
const failureText = (result: CommandResult): string =>
  [result.stderr, result.stdout].map((text) => text.trim()).find((text) => text !== "") ?? `exit ${result.code}`;

// The first line of the text that is not empty, with its spaces trimmed, or undefined when there is none.
const firstLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");

// The message of a failed removal: the first line of its error output, then of its standard output, and otherwise the
// exit code.
const removalFailure = (result: CommandResult): string =>
  firstLine(result.stderr) ?? firstLine(result.stdout) ?? `exit ${result.code}`;

// Only the global scope exists. Any other scope is refused with a message that says so.
const requireScope = (scope: Scope): void => {
  if (!SCOPES.includes(scope)) {
    throw new UnsupportedScope("antigravity", scope, SCOPE_MESSAGE);
  }
};

const installGlobal = async (ctx: Context): Promise<Step> => {
  const { command, args } = directEntry(ctx.cliPath);
  // The removal fails when no entry exists yet, which is the usual case, so its result is not used.
  await ctx.run(PROGRAM, ["mcp", "remove", DIRECT_KEY]);
  const added = await ctx.run(PROGRAM, ["mcp", "add", DIRECT_KEY, command, ...args]);
  if (added.code !== 0) {
    return step("error", failureText(added));
  }
  if (!ctx.dryRun) {
    await record("antigravity", scopeKey("global", ctx.projectDir), { kind: "mcp-entry", name: DIRECT_KEY });
  }
  return step("ok", "Added the server to the global Antigravity configuration with agy mcp add.");
};

const updateGlobal = async (ctx: Context): Promise<Step> => {
  const items = await recordedItems("antigravity", scopeKey("global", ctx.projectDir));
  const recorded = items.some((item) => item.kind === "mcp-entry" && item.name === DIRECT_KEY);
  return recorded ? installGlobal(ctx) : step("skipped", NOT_INSTALLED);
};

const uninstallGlobal = async (ctx: Context): Promise<Step> => {
  // Without the program the entry cannot be removed, so the record stays for a later attempt.
  if (!ctx.present(PROGRAM)) {
    return step("skipped", "agy is not on PATH, so nothing was removed globally.");
  }
  const removed = await ctx.run(PROGRAM, ["mcp", "remove", DIRECT_KEY]);
  // A failed removal that does not report an absent server may have left the entry in place. Then the record stays, so a
  // later uninstall can still remove the entry.
  if (removed.code !== 0 && !reportsNotInstalled(removed)) {
    return step("error", removalFailure(removed));
  }
  if (!ctx.dryRun) {
    await forget("antigravity", scopeKey("global", ctx.projectDir));
  }
  return removed.code === 0
    ? step("ok", "Removed the server from the global Antigravity configuration.")
    : step("skipped", NOT_INSTALLED_GLOBALLY);
};

const doctorGlobal = async (ctx: Context): Promise<Step> => {
  if (!ctx.present(PROGRAM)) {
    return step("skipped", "agy is not on PATH.");
  }
  const listed = await ctx.run(PROGRAM, ["mcp", "list"]);
  return listed.code === 0 && namesServer(listed.stdout)
    ? step("ok", "The server is in agy mcp list.")
    : step("skipped", "The server is not in agy mcp list.");
};

export const antigravityAdapter: AgentAdapter = {
  id: "antigravity",
  scopes: SCOPES,
  present: (ctx) => ctx.present(PROGRAM),
  install: async (ctx, scope) => {
    requireScope(scope);
    return [await installGlobal(ctx)];
  },
  update: async (ctx, scope) => {
    requireScope(scope);
    return [await updateGlobal(ctx)];
  },
  uninstall: async (ctx, scope) => {
    requireScope(scope);
    return [await uninstallGlobal(ctx)];
  },
  doctor: async (ctx) => [await doctorGlobal(ctx)],
};
