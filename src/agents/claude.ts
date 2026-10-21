import type { CommandOptions, CommandResult } from "./command.js";
import { type Scope, supportedScopes } from "./scopes.js";
import { forget, record, recordedItems, scopeKey } from "./state.js";
import { type AgentAdapter, type Context, type Step } from "./types.js";

// The Claude Code adapter. Claude Code gets this server as a plugin, and the plugin comes from a marketplace. The claude
// command adds, updates, removes and lists the plugin, so this adapter runs those commands and edits no file. Claude Code
// names its scopes user, project and local. Its user scope is this tool's global scope.

const SCOPES = supportedScopes("claude");

const PROGRAM = "claude";
const MARKETPLACE = "multi-account-supabase-mcp";
const PLUGIN = "multi-account-supabase";
const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;
// The repository that holds the marketplace. This source is not verified, because the repository does not exist yet. The
// publish step, which needs the owner's go-ahead, creates it.
const MARKETPLACE_SOURCE = "FiredMosquito831/multi-account-supabase-mcp";

const CLI_SCOPE: Record<Scope, "user" | "project" | "local"> = {
  global: "user",
  project: "project",
  local: "local",
};

const NOT_INSTALLED = "not installed in this scope";
const NOT_ON_PATH = "claude is not on PATH, so nothing was removed in this scope.";

// The folder a command runs in. The project and local scopes act on the folder that the command runs in, so their commands
// run in the project folder. The user scope has no folder, so its commands run without one.
const folderOf = (scope: Scope, projectDir: string): CommandOptions | undefined =>
  scope === "global" ? undefined : { cwd: projectDir };

const step = (scope: Scope, status: Step["status"], message: string): Step => ({
  agent: "claude",
  scope,
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

// The message of a failed removal: the first line of its error output, then of its standard output, and otherwise the exit
// code.
const removalFailure = (result: CommandResult): string =>
  firstLine(result.stderr) ?? firstLine(result.stdout) ?? `exit ${result.code}`;

// The words of a report that the plugin is not installed. The wording is ASSUMED, not verified.
const NOT_INSTALLED_REPORT = /\b(?:not (?:installed|found)|does not exist)\b/i;
// The characters that a plugin name or id is made of. Any other character ends a word.
const NAME_BREAK = /[^A-Za-z0-9@_-]+/;

// Whether a line names the plugin, as its id or as its bare name, as one whole word.
const namesPlugin = (line: string): boolean =>
  line.split(NAME_BREAK).some((word) => word === PLUGIN || word === PLUGIN_ID);

// Whether a failed removal reports that the plugin is not installed. The report must name the plugin on the same line as the
// words, so an unrelated "not found", such as one about a settings file, never counts.
const reportsNotInstalled = (result: CommandResult): boolean =>
  `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .some((line) => NOT_INSTALLED_REPORT.test(line) && namesPlugin(line));

// Installs the plugin in one scope. A failed marketplace add does not stop the install, because the marketplace may already be
// there, so the install decides the outcome. When the install fails, the message gives the failure of the marketplace add
// first, when there was one, and then the failure of the install. Nothing is recorded after a failed install.
const installScope = async (ctx: Context, scope: Scope): Promise<Step> => {
  const folder = folderOf(scope, ctx.projectDir);
  const added = await ctx.run(PROGRAM, ["plugin", "marketplace", "add", MARKETPLACE_SOURCE], folder);
  // The -y flag is required when the command runs without a terminal, which is the case here.
  const installed = await ctx.run(
    PROGRAM,
    ["plugin", "install", PLUGIN_ID, "--scope", CLI_SCOPE[scope], "-y"],
    folder,
  );
  if (installed.code !== 0) {
    const failures = added.code === 0 ? [installed] : [added, installed];
    return step(scope, "error", failures.map(failureText).join("\n"));
  }
  if (!ctx.dryRun) {
    await record("claude", scopeKey(scope, ctx.projectDir), { kind: "mcp-entry", name: PLUGIN_ID });
  }
  return step(scope, "ok", `Installed the plugin with claude plugin install, in the ${scope} scope.`);
};

// Updates the plugin in a scope that has it recorded. A scope with no record is left alone, so no command runs for it.
const updateScope = async (ctx: Context, scope: Scope): Promise<Step> => {
  const items = await recordedItems("claude", scopeKey(scope, ctx.projectDir));
  if (!items.some((item) => item.kind === "mcp-entry" && item.name === PLUGIN_ID)) {
    return step(scope, "skipped", NOT_INSTALLED);
  }
  const updated = await ctx.run(
    PROGRAM,
    ["plugin", "update", PLUGIN_ID, "--scope", CLI_SCOPE[scope], "-y"],
    folderOf(scope, ctx.projectDir),
  );
  return updated.code === 0
    ? step(scope, "ok", `Updated the plugin with claude plugin update, in the ${scope} scope.`)
    : step(scope, "error", failureText(updated));
};

// Removes the plugin from a scope. The record is forgotten when the removal worked, or when its output reports that the
// plugin is not installed, because then nothing is left to remove. Any other failure keeps the record, so a later uninstall
// can still remove the plugin, and the step gives the first line of the error output. Without claude nothing can be removed,
// so the record stays too. The marketplace is never removed, because other plugins may use it.
const uninstallScope = async (ctx: Context, scope: Scope): Promise<Step> => {
  if (!ctx.present(PROGRAM)) {
    return step(scope, "skipped", NOT_ON_PATH);
  }
  const removed = await ctx.run(
    PROGRAM,
    ["plugin", "uninstall", PLUGIN_ID, "--scope", CLI_SCOPE[scope]],
    folderOf(scope, ctx.projectDir),
  );
  if (removed.code !== 0 && !reportsNotInstalled(removed)) {
    return step(scope, "error", removalFailure(removed));
  }
  if (!ctx.dryRun) {
    await forget("claude", scopeKey(scope, ctx.projectDir));
  }
  return removed.code === 0
    ? step(scope, "ok", `Removed the plugin with claude plugin uninstall, from the ${scope} scope.`)
    : step(scope, "skipped", NOT_INSTALLED);
};

// Checks one scope by asking claude which plugins it lists in that scope's folder. The shape of the listing is not verified,
// so the plugin id is matched as text and the output is not parsed. A listing that fails does not count as found.
const doctorScope = async (ctx: Context, scope: Scope): Promise<Step> => {
  const listed = await ctx.run(PROGRAM, ["plugin", "list", "--json"], folderOf(scope, ctx.projectDir));
  if (listed.code !== 0) {
    return step(scope, "skipped", `claude plugin list failed in the ${scope} scope, so the plugin was not checked.`);
  }
  return listed.stdout.includes(PLUGIN_ID)
    ? step(scope, "ok", `The plugin is in claude plugin list for the ${scope} scope.`)
    : step(scope, "skipped", `The plugin is not in claude plugin list for the ${scope} scope.`);
};

// Checks each scope that has the plugin recorded, and gives no step to a scope with no record, as the other doctors do.
// Without claude, one skipped step for the global scope says so.
const doctor = async (ctx: Context): Promise<Step[]> => {
  if (!ctx.present(PROGRAM)) {
    return [step("global", "skipped", "claude is not on PATH.")];
  }
  const steps: Step[] = [];
  for (const scope of SCOPES) {
    const items = await recordedItems("claude", scopeKey(scope, ctx.projectDir));
    if (items.some((item) => item.kind === "mcp-entry" && item.name === PLUGIN_ID)) {
      steps.push(await doctorScope(ctx, scope));
    }
  }
  return steps;
};

export const claudeAdapter: AgentAdapter = {
  id: "claude",
  scopes: SCOPES,
  present: (ctx) => ctx.present(PROGRAM),
  install: async (ctx, scope) => [await installScope(ctx, scope)],
  update: async (ctx, scope) => [await updateScope(ctx, scope)],
  uninstall: async (ctx, scope) => [await uninstallScope(ctx, scope)],
  doctor,
};
