import type { CommandOptions, CommandResult } from "./command.js";
import { type Scope, supportedScopes } from "./scopes.js";
import { forget, record, recordedItems, scopeKey } from "./state.js";
import { type AgentAdapter, type Context, type Step } from "./types.js";

// The Claude Code adapter. Claude Code gets this server as a plugin, and the plugin comes from a marketplace. The claude
// command adds, updates, removes and lists the plugin, so this adapter runs those commands and edits no file. Claude Code
// names its scopes user, project and local. Its user scope is this tool's global scope.
//
// What the claude commands take, from their help output, read on 2026-10-21:
// - install: -y is required when stdin or stdout is not a TTY. The commands here never have a terminal, so install passes -y.
//   The caveat under update applies to install too.
// - update: -y accepts a command that a marketplace declares, without a prompt. This marketplace must declare no command, so
//   -y accepts none. The adapter does not check that, so a marketplace that declares a command would run it without a prompt.
// - uninstall: -y only skips the confirmation for --prune, and this adapter never passes --prune. So uninstall passes no -y.
// - list: --json prints the listing. The help gives no scope option and does not describe the fields, so the listing has no
//   verified scope field. A listing that names the plugin does not confirm a scope.
//
// Install does not look for an entry it did not write before it changes anything. The listing cannot confirm a scope, so such
// a check would not be exact, and this adapter does not make it.

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

// The words that say where a command runs, for a step that tells the owner to run one. The user scope has no folder. The project
// and local commands run in the project folder, so the words name it.
const whereToRun = (scope: Scope, projectDir: string): string =>
  scope === "global" ? "" : ` this in the folder ${projectDir}`;

// The command that removes the marketplace from one scope. The scope is always passed, because without it claude removes the
// marketplace from every scope. Uninstall never runs this command, because other plugins may use the marketplace. The owner
// runs it when no other plugin needs it.
const marketplaceRemoval = (scope: Scope): string =>
  `claude plugin marketplace remove ${MARKETPLACE} --scope ${CLI_SCOPE[scope]}`;

// The note that the marketplace is still registered in a scope, with the command that removes it there.
const marketplaceNote = (scope: Scope, projectDir: string): string =>
  `The marketplace is still registered. To remove it, run${whereToRun(scope, projectDir)}: ${marketplaceRemoval(scope)}`;

// The note of an install whose plugin install failed after the marketplace add worked. The marketplace stays registered.
const marketplaceAddedNote = (scope: Scope, projectDir: string): string =>
  `The marketplace was added and is still registered. To remove it, run${whereToRun(scope, projectDir)}: ${marketplaceRemoval(scope)}`;

const step = (scope: Scope, status: Step["status"], message: string): Step => ({
  agent: "claude",
  scope,
  status,
  message,
});

// The first line of the text that is not empty, with its spaces trimmed, or undefined when there is none.
const firstLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");

// The message of a failed command, by one rule for install, update and uninstall: the first non-empty line of its error
// output, then the first non-empty line of its standard output, and otherwise the exit code.
const failureMessage = (result: CommandResult): string =>
  firstLine(result.stderr) ?? firstLine(result.stdout) ?? `exit ${result.code}`;

// The text of an error that a read or a write threw. An error with no message gives a fixed text, so nothing unknown is printed.
const errorText = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "The record could not be read or written.";

// Whether a removal that failed says that the plugin is not installed. The wording is ASSUMED, not verified. The line must say
// "not installed" and must name the plugin id as one whole word. Any other failure, including "not found", keeps the record.
const NOT_INSTALLED_WORDS = /\bnot installed\b/i;
// The characters that a plugin id is made of. Any other character ends a word.
const NAME_BREAK = /[^A-Za-z0-9@_-]+/;
// Whether a text names the plugin id as one whole word. A longer id that contains the plugin id is a different plugin.
const namesPluginId = (text: string): boolean => text.split(NAME_BREAK).includes(PLUGIN_ID);
const reportsNotInstalled = (result: CommandResult): boolean =>
  `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .some((line) => NOT_INSTALLED_WORDS.test(line) && namesPluginId(line));

// What the record of a scope lists for this plugin: the plugin entry, and the marketplace.
const recordOf = async (ctx: Context, scope: Scope): Promise<{ plugin: boolean; marketplace: boolean }> => {
  const items = await recordedItems("claude", scopeKey(scope, ctx.projectDir));
  return {
    plugin: items.some((item) => item.kind === "mcp-entry" && item.name === PLUGIN_ID),
    marketplace: items.some((item) => item.kind === "marketplace" && item.name === MARKETPLACE),
  };
};

// Installs the plugin in one scope. The claude command must be on PATH, which is checked first, before any change. The record
// is read first too, so a state file that cannot be read stops the install before anything changes. A failed marketplace add
// stops the install unless this scope's record lists the marketplace, because a marketplace of that name may be registered from
// another source, and -y would accept what it declares. Checking the listing for its source is OPEN: no listing command is
// verified. The marketplace
// is recorded as soon as its add succeeds, because the add changed Claude's own configuration. The plugin is recorded when the
// install succeeds. If a record cannot be written, the step is an error that gives the command which removes what was changed.
// Nothing is removed automatically, because the change cannot be checked first.
const installScope = async (ctx: Context, scope: Scope): Promise<Step> => {
  if (!ctx.present(PROGRAM)) {
    return step(scope, "error", "claude is not on PATH, so the plugin cannot be installed in this scope.");
  }
  const key = scopeKey(scope, ctx.projectDir);
  let before: { plugin: boolean; marketplace: boolean };
  try {
    before = await recordOf(ctx, scope);
  } catch (error) {
    return step(scope, "error", errorText(error));
  }
  // The marketplace is added to the same scope as the plugin. Without --scope, claude adds it to the user scope.
  const folder = folderOf(scope, ctx.projectDir);
  const added = await ctx.run(
    PROGRAM,
    ["plugin", "marketplace", "add", MARKETPLACE_SOURCE, "--scope", CLI_SCOPE[scope]],
    folder,
  );
  // A failed add is accepted only when this scope's record lists the marketplace, which this tool added. Otherwise the install is
  // refused here, before the plugin install runs, and nothing is changed.
  if (added.code !== 0 && !before.marketplace) {
    return step(
      scope,
      "error",
      `The marketplace ${MARKETPLACE} is already registered, and this tool did not add it, so nothing was changed. The add failed: ${failureMessage(added)}`,
    );
  }
  if (added.code === 0 && !ctx.dryRun) {
    try {
      await record("claude", key, { kind: "marketplace", name: MARKETPLACE });
    } catch (error) {
      return step(
        scope,
        "error",
        `${errorText(error)} The marketplace was added. To remove it, run${whereToRun(scope, ctx.projectDir)}: ${marketplaceRemoval(scope)}`,
      );
    }
  }
  // -y is passed for the reason given in the header of this file. The caveat there applies here too.
  const installed = await ctx.run(
    PROGRAM,
    ["plugin", "install", PLUGIN_ID, "--scope", CLI_SCOPE[scope], "-y"],
    folder,
  );
  if (installed.code !== 0) {
    // When the marketplace add worked, the marketplace is recorded and still registered, so the step says so.
    if (added.code === 0) {
      return step(scope, "error", `${failureMessage(installed)}\n${marketplaceAddedNote(scope, ctx.projectDir)}`);
    }
    return step(scope, "error", [added, installed].map(failureMessage).join("\n"));
  }
  if (ctx.dryRun) {
    return step(scope, "ok", `Would install the plugin with claude plugin install, in the ${scope} scope.`);
  }
  try {
    await record("claude", key, { kind: "mcp-entry", name: PLUGIN_ID });
  } catch (error) {
    const removal = `claude plugin uninstall ${PLUGIN_ID} --scope ${CLI_SCOPE[scope]}`;
    // When the marketplace add worked, its record was written before this one, so the marketplace is still registered, and the
    // step names it too.
    const marketplace = added.code === 0 ? `\n${marketplaceAddedNote(scope, ctx.projectDir)}` : "";
    return step(
      scope,
      "error",
      `${errorText(error)} The plugin was installed. To remove it, run${whereToRun(scope, ctx.projectDir)}: ${removal}${marketplace}`,
    );
  }
  return step(scope, "ok", `Installed the plugin with claude plugin install, in the ${scope} scope.`);
};

// Updates the plugin in a scope whose record lists it. The record is read first, so a scope with no record gets a skipped step, and
// no command runs for it, even when claude is absent. A scope whose record lists the plugin needs the claude command on PATH, which
// is checked in a dry run too.
const updateScope = async (ctx: Context, scope: Scope): Promise<Step> => {
  if (!(await recordOf(ctx, scope)).plugin) {
    return step(scope, "skipped", NOT_INSTALLED);
  }
  if (!ctx.present(PROGRAM)) {
    return step(scope, "error", "claude is not on PATH, so the plugin cannot be updated in this scope.");
  }
  // -y is passed because the adapter has no terminal to answer a prompt. The caveat in the header applies here too.
  const updated = await ctx.run(
    PROGRAM,
    ["plugin", "update", PLUGIN_ID, "--scope", CLI_SCOPE[scope], "-y"],
    folderOf(scope, ctx.projectDir),
  );
  if (updated.code !== 0) {
    return step(scope, "error", failureMessage(updated));
  }
  return ctx.dryRun
    ? step(scope, "ok", `Would update the plugin with claude plugin update, in the ${scope} scope.`)
    : step(scope, "ok", `Updated the plugin with claude plugin update, in the ${scope} scope.`);
};

// Removes the plugin from a scope, and only when the record lists it. A scope with no record gets a skipped step, and no command
// runs for it. The record is forgotten when the removal works, when its output says the plugin is not installed, or when the record
// holds only the marketplace, which has no command to run here. Any other failure keeps the record, so a later uninstall can still
// remove the plugin. The marketplace is never removed, because other plugins may use it. When the record lists it, the step says
// it is still registered and gives the command that removes it.
// The record of the scope is forgotten as a whole, the marketplace item included. A later run then no longer mentions the
// marketplace, so the step at this time is the only reminder. That is intended: once a scope is forgotten, the tool no longer
// manages what it had recorded there. A marketplace that stays registered is reported at uninstall, not by doctor, which checks
// the plugin only. Uninstall reports it when the removal works, when the plugin is not installed (also for a scope whose record
// holds only the marketplace), and when the record cannot be cleared. It is not reported when claude is absent or the removal
// fails for another reason, because the record is kept then.
const uninstallScope = async (ctx: Context, scope: Scope): Promise<Step> => {
  if (!ctx.present(PROGRAM)) {
    return step(scope, "skipped", NOT_ON_PATH);
  }
  const recorded = await recordOf(ctx, scope);
  if (!recorded.plugin && !recorded.marketplace) {
    return step(scope, "skipped", NOT_INSTALLED);
  }
  // A record with no plugin in it has nothing to remove, so no command runs for it.
  let removed = false;
  if (recorded.plugin) {
    const result = await ctx.run(
      PROGRAM,
      ["plugin", "uninstall", PLUGIN_ID, "--scope", CLI_SCOPE[scope]],
      folderOf(scope, ctx.projectDir),
    );
    if (result.code !== 0 && !reportsNotInstalled(result)) {
      return step(scope, "error", failureMessage(result));
    }
    removed = result.code === 0;
  }
  if (!ctx.dryRun) {
    try {
      await forget("claude", scopeKey(scope, ctx.projectDir));
    } catch (error) {
      // The plugin is removed, or was never installed, but the record could not be cleared. A later uninstall clears it when
      // claude reports the plugin as not installed. That wording is not verified.
      const removedText = removed ? "The plugin was removed. " : "";
      const marketplaceText = recorded.marketplace ? ` ${marketplaceNote(scope, ctx.projectDir)}` : "";
      return step(
        scope,
        "error",
        `${errorText(error)} ${removedText}The record of this scope could not be cleared, so run uninstall again for it.${marketplaceText}`,
      );
    }
  }
  if (!removed) {
    return step(
      scope,
      "skipped",
      recorded.marketplace ? `${NOT_INSTALLED}. ${marketplaceNote(scope, ctx.projectDir)}` : NOT_INSTALLED,
    );
  }
  const done = ctx.dryRun
    ? `Would remove the plugin with claude plugin uninstall, from the ${scope} scope.`
    : `Removed the plugin with claude plugin uninstall, from the ${scope} scope.`;
  return step(scope, "ok", recorded.marketplace ? `${done} ${marketplaceNote(scope, ctx.projectDir)}` : done);
};

// Checks one scope by asking claude which plugins it lists. The global scope has no folder of its own, so its listing runs in
// the process folder. The project and local listings run in the project folder. The listing's shape is not verified, so the
// plugin id is matched as one whole word in the text, and the output is not parsed. The listing has no verified scope field,
// so a step cannot confirm the scope. In a dry run the listing is only listed, and the step says it was not run.
const doctorScope = async (ctx: Context, scope: Scope): Promise<Step> => {
  const listed = await ctx.run(PROGRAM, ["plugin", "list", "--json"], folderOf(scope, ctx.projectDir));
  if (ctx.dryRun) {
    return step(
      scope,
      "skipped",
      `Would run claude plugin list for the ${scope} scope. The listing was not run, because this is a dry run.`,
    );
  }
  if (listed.code !== 0) {
    return step(scope, "skipped", `claude plugin list failed for the ${scope} scope, so the plugin was not checked.`);
  }
  const unconfirmed = `The listing has no verified scope field, so the ${scope} scope is not confirmed.`;
  return namesPluginId(listed.stdout)
    ? step(scope, "ok", `The plugin is in claude plugin list, run for the ${scope} scope. ${unconfirmed}`)
    : step(scope, "skipped", `The plugin is not in claude plugin list, run for the ${scope} scope. ${unconfirmed}`);
};

// Checks each scope whose record lists the plugin, in the order of the scopes. A scope with no record gets no step, and no
// listing runs for it. Without claude, each recorded scope gets a skipped step that says so, and no listing runs.
const doctor = async (ctx: Context): Promise<Step[]> => {
  const steps: Step[] = [];
  for (const scope of SCOPES) {
    if (!(await recordOf(ctx, scope)).plugin) {
      continue;
    }
    steps.push(ctx.present(PROGRAM) ? await doctorScope(ctx, scope) : step(scope, "skipped", "claude is not on PATH."));
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
