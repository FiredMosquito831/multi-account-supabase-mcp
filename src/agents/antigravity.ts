import type { CommandResult } from "./command.js";
import { DIRECT_KEY, directEntry, type Scope, supportedScopes } from "./scopes.js";
import { forget, record, recordedItems, scopeKey, statePath } from "./state.js";
import { type AgentAdapter, type Context, type Step, UnsupportedScope } from "./types.js";

// The Antigravity adapter. Antigravity's own program, agy, adds, removes and lists the servers, so this adapter runs those
// commands and edits no file. Antigravity has no scope flag, and its servers are global only, so the project and local
// scopes are refused.
//
// The state file is this tool's record of what it added. Only the recorded entry is removed, by its recorded name. An entry
// that the record does not list is not removed by name. The one exception is the entry that a fresh install has just added:
// when its record cannot be written, the entry is removed again, because the listing showed it absent a moment before. A
// fresh install checks the listing first and refuses when agy already lists the name. That check reads the listing as plain
// words, which is exact only if agy writes each name as a whole word. The listing's format is not verified yet.

const SCOPES = supportedScopes("antigravity");

// The program that manages the servers. Its help names the Windows file agy.exe. The command runner also finds a .cmd shim,
// which it runs through cmd.exe.
const PROGRAM = "agy";
const REMOVE_COMMAND = `${PROGRAM} mcp remove ${DIRECT_KEY}`;

const NOT_INSTALLED = "not installed in this scope";
const NOT_INSTALLED_GLOBALLY = "not installed globally";
const SCOPE_MESSAGE = "antigravity has no local scope, and no project scope. Use global.";

// The messages of a real run and of a dry run. A dry run says what would happen, and never that a change was made.
const ADDED = "Added the server to the global Antigravity configuration with agy mcp add.";
const DRY_ADD = "Would add the server to the global Antigravity configuration with agy mcp add.";
const DRY_ADD_FRESH =
  `${DRY_ADD} A dry run does not run agy mcp list, so an entry with this name that agy already lists is not checked.`;
const REMOVED = "Removed the server from the global Antigravity configuration.";
const DRY_REMOVE = "Would remove the server from the global Antigravity configuration.";
const NOT_ON_PATH_ADD = "agy is not on PATH, so nothing was changed.";
const NOT_ON_PATH_ADD_DRY = "agy is not on PATH, so nothing would be changed.";
const NOT_ON_PATH_REMOVE = "agy is not on PATH, so nothing was removed globally.";
const NOT_ON_PATH_REMOVE_DRY = "agy is not on PATH, so nothing would be changed globally.";
const NOT_ON_PATH_CHECK = "agy is not on PATH.";
const NOT_ON_PATH_CHECK_DRY = "agy is not on PATH, so the server would not be checked.";

// The characters that end one word of the output. A table bar, a colon or a bracket next to the name still leaves it as
// one word. A longer name that merely contains the name, such as the same name with a hyphen and more text, is a
// different word.
const WORD_BREAK = /[\s|│:,;()[\]"'=]+/;

// Whether the text names the server as one whole word.
const namesServer = (text: string): boolean => text.split(WORD_BREAK).includes(DIRECT_KEY);

// The report that the server is absent. The words must come straight after the name, and the line must end with them, so a
// line such as "multi-account-supabase: settings file not found" or "multi-account-supabase not found in settings" is not
// taken for an absent server. The wording of agy is not verified, so even this shape is a guess.
const NOT_INSTALLED_REPORT = new RegExp(
  `(?<![\\w-])${DIRECT_KEY}["'\`:]?\\s+(?:is\\s+|was\\s+)?(?:not (?:installed|found|configured)|does not exist)["'\`]?\\s*[.!]?\\s*$`,
  "i",
);

// Whether a failed removal reports that this server is absent, on one of its lines.
const reportsNotInstalled = (result: CommandResult): boolean =>
  `${result.stderr}\n${result.stdout}`.split(/\r?\n/).some((line) => NOT_INSTALLED_REPORT.test(line));

// The first line of the text that is not empty, with its spaces trimmed, or undefined when there is none.
const firstLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");

// The message of a failed command, the same for every action: the first non-empty line of its error output, then the first
// non-empty line of its standard output, and otherwise the exit code.
const failureLine = (result: CommandResult): string =>
  firstLine(result.stderr) ?? firstLine(result.stdout) ?? `exit ${result.code}`;

// The text of a thrown error. It names a file and a reason, and never the contents of a file.
const errorText = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "The record could not be read or written.";

const step = (status: Step["status"], message: string): Step => ({
  agent: "antigravity",
  scope: "global",
  status,
  message,
});

// Only the global scope exists. Any other scope is refused with a message that says so.
const requireScope = (scope: Scope): void => {
  if (!SCOPES.includes(scope)) {
    throw new UnsupportedScope("antigravity", scope, SCOPE_MESSAGE);
  }
};

// What the state file says about this scope. It is read before any command runs, so a file that cannot be read stops the
// step before anything changes.
type RecordRead = { ok: true; recorded: boolean } | { ok: false; message: string };

const readRecord = async (ctx: Context): Promise<RecordRead> => {
  try {
    const items = await recordedItems("antigravity", scopeKey("global", ctx.projectDir), undefined, ctx.env);
    return { ok: true, recorded: items.some((item) => item.kind === "mcp-entry" && item.name === DIRECT_KEY) };
  } catch (error) {
    return { ok: false, message: errorText(error) };
  }
};

// The reason that a record write failed, as a short phrase. A system error gives its code. A refusal of the state file ends
// with its reason in brackets, and that reason is used. Anything else gives a fixed phrase. The rest of the message is not
// used, because a refusal says that nothing was changed, which is not true once the entry has been added.
const recordReason = (error: unknown): string => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string" && code !== "") {
    return code;
  }
  const bracketed = error instanceof Error ? /\(([^()]+)\)\s*$/.exec(error.message) : null;
  return bracketed?.[1] ?? "the write failed";
};

// Records the entry once agy has accepted it. The write runs under the lock, so it can still fail: the state file may have
// changed since it was read. The entry is already added, so a failed write says so, names the record file, and gives the
// reason alone. When the listing showed the entry absent before the add, the entry is removed again. Otherwise the step
// gives the removal command for the owner to run.
const recordAdded = async (ctx: Context, absentBefore: boolean): Promise<Step> => {
  try {
    await record("antigravity", scopeKey("global", ctx.projectDir), { kind: "mcp-entry", name: DIRECT_KEY }, undefined, ctx.env);
    return step("ok", ADDED);
  } catch (error) {
    const failed =
      `The server was added, but its record file ${statePath("antigravity", undefined, ctx.env)} could not be written: ${recordReason(error)}.`;
    if (!absentBefore) {
      return step("error", `${failed} To remove it, run ${REMOVE_COMMAND}.`);
    }
    const removed = await ctx.run(PROGRAM, ["mcp", "remove", DIRECT_KEY]);
    return removed.code === 0
      ? step("error", `${failed} The server was removed again, so agy no longer lists it.`)
      : step("error", `${failed} Removing it again failed: ${failureLine(removed)}. To remove it, run ${REMOVE_COMMAND}.`);
  }
};

// Adds the entry with agy. A recorded entry is this tool's own, so it is removed by its recorded name and then added again.
// A fresh install checks the listing first. A name that agy already lists, and that the record does not list, is refused,
// so an entry the record does not list is not taken over.
const addEntry = async (ctx: Context, recorded: boolean): Promise<Step> => {
  // Whether agy is on PATH is only a read, so it is checked in a dry run too.
  if (!ctx.present(PROGRAM)) {
    return step("error", ctx.dryRun ? NOT_ON_PATH_ADD_DRY : NOT_ON_PATH_ADD);
  }
  const { command, args } = directEntry(ctx.cliPath);
  let removed: CommandResult | undefined;
  if (recorded) {
    // The removal comes first. Its result is read only when the add fails, so the message can say what agy now lists.
    removed = await ctx.run(PROGRAM, ["mcp", "remove", DIRECT_KEY]);
  } else if (!ctx.dryRun) {
    const listed = await ctx.run(PROGRAM, ["mcp", "list"]);
    // A listing that fails cannot show whether the name is taken, so the install stops before anything changes.
    if (listed.code !== 0) {
      return step("error", `agy mcp list failed, so nothing was changed: ${failureLine(listed)}`);
    }
    if (namesServer(listed.stdout)) {
      return step(
        "error",
        `agy already lists ${DIRECT_KEY}, but the record does not list it, so nothing was changed. Remove that entry with agy, then install again.`,
      );
    }
  }
  const added = await ctx.run(PROGRAM, ["mcp", "add", DIRECT_KEY, command, ...args]);
  // A dry run says what would happen. Its command results are fake, so none of them is read.
  if (ctx.dryRun) {
    return step("ok", recorded ? DRY_ADD : DRY_ADD_FRESH);
  }
  if (added.code !== 0) {
    // When the removal before the add worked, agy no longer lists the entry, and the step says so.
    if (removed?.code === 0) {
      return step(
        "error",
        `The server was removed from agy, but adding it again failed, so agy no longer lists it. The record still lists it. ${failureLine(added)}`,
      );
    }
    return step("error", failureLine(added));
  }
  return recordAdded(ctx, !recorded);
};

const installGlobal = async (ctx: Context): Promise<Step> => {
  const read = await readRecord(ctx);
  return read.ok ? addEntry(ctx, read.recorded) : step("error", read.message);
};

// A scope with no record gets a skipped step, and no command runs.
const updateGlobal = async (ctx: Context): Promise<Step> => {
  const read = await readRecord(ctx);
  if (!read.ok) {
    return step("error", read.message);
  }
  return read.recorded ? addEntry(ctx, true) : step("skipped", NOT_INSTALLED);
};

const uninstallGlobal = async (ctx: Context): Promise<Step> => {
  const read = await readRecord(ctx);
  if (!read.ok) {
    return step("error", read.message);
  }
  // Only the recorded entry may be removed. With no record, nothing is removed and no command runs.
  if (!read.recorded) {
    return step("skipped", NOT_INSTALLED);
  }
  if (!ctx.present(PROGRAM)) {
    // Without the program the entry cannot be removed, so the record stays for a later attempt.
    return step("skipped", ctx.dryRun ? NOT_ON_PATH_REMOVE_DRY : NOT_ON_PATH_REMOVE);
  }
  const removed = await ctx.run(PROGRAM, ["mcp", "remove", DIRECT_KEY]);
  // A dry run says what would happen. Its command results are fake, so none of them is read.
  if (ctx.dryRun) {
    return step("ok", DRY_REMOVE);
  }
  // A failed removal that does not report an absent server may have left the entry in place. The record then stays, so a
  // later uninstall can still remove the entry.
  if (removed.code !== 0 && !reportsNotInstalled(removed)) {
    return step("error", failureLine(removed));
  }
  try {
    await forget("antigravity", scopeKey("global", ctx.projectDir), undefined, ctx.env);
  } catch {
    // The record is updated after agy has acted, so a failure here is reported as a fact about both, not as a refusal that
    // changed nothing.
    const where = statePath("antigravity", undefined, ctx.env);
    return step(
      "error",
      removed.code === 0
        ? `The server was removed from agy, but this tool could not update its record at ${where}. Check that file, then run uninstall again.`
        : `agy did not list the server, and this tool could not update its record at ${where}. Check that file, then run uninstall again.`,
    );
  }
  return removed.code === 0 ? step("ok", REMOVED) : step("skipped", NOT_INSTALLED_GLOBALLY);
};

// The check reads the listing only for a scope with a record. The server counts as found only when the listing exits 0 and
// names it.
const doctorGlobal = async (ctx: Context): Promise<Step[]> => {
  const read = await readRecord(ctx);
  if (!read.ok) {
    return [step("error", read.message)];
  }
  // A scope with no record gets no step, because this tool did not install anything there.
  if (!read.recorded) {
    return [];
  }
  if (!ctx.present(PROGRAM)) {
    return [step("skipped", ctx.dryRun ? NOT_ON_PATH_CHECK_DRY : NOT_ON_PATH_CHECK)];
  }
  if (ctx.dryRun) {
    return [
      step(
        "skipped",
        "Would check agy mcp list for the server. A dry run does not run the listing, so the server was not checked.",
      ),
    ];
  }
  const listed = await ctx.run(PROGRAM, ["mcp", "list"]);
  if (listed.code !== 0) {
    return [step("error", `agy mcp list failed, so the server was not checked: ${failureLine(listed)}`)];
  }
  return [
    namesServer(listed.stdout)
      ? step("ok", "The server is in agy mcp list.")
      : step("skipped", "The server is not in agy mcp list."),
  ];
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
  doctor: (ctx) => doctorGlobal(ctx),
};
