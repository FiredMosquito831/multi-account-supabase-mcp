import { stat } from "node:fs/promises";
import path from "node:path";
import { Registry } from "../accounts/registry.js";
import { antigravityAdapter } from "../agents/antigravity.js";
import { claudeAdapter } from "../agents/claude.js";
import { codexAdapter } from "../agents/codex.js";
import type { Runner } from "../agents/command.js";
import { opencodeAdapter } from "../agents/opencode.js";
import { type Action, runPlan } from "../agents/plan.js";
import { type Scope, isScope } from "../agents/scopes.js";
import { type AgentId, type Item, record, recordedItems, recordedScopeKeys, scopeKey } from "../agents/state.js";
import {
  type AgentAdapter,
  type Context,
  type FileOps,
  PlanRefused,
  type Step,
  makeContext,
  unsupportedReason,
} from "../agents/types.js";
import { dataFolder, isAbsoluteLocation } from "../paths.js";
import type { TokenStore } from "../secrets/token-store.js";

// The install, update, uninstall and doctor commands, as functions that take parsed options and an io object. Each returns an
// exit code: 2 for a command line refused before anything runs, 1 when a step or a check failed, and 0 otherwise. A dry run returns
// 1 when its plan has an error row, so a script sees that the real run would fail. Each step is printed with its status, and the
// scope or the account that it names.
//
// An install shows its plan first, from a dry pass. The dry pass lists each command line and file change, and changes nothing.
// A real pass runs after the owner says yes in a terminal, or at once when --yes is given. With --yes there are no questions.
// Update and uninstall refuse --yes, and they never ask. Each adapter does its own changes and its own record. This module adds
// one record of its own: after a successful install or update, it stores the path of the running command line program in each
// agent's record for the scope, so doctor can check that the path still exists.

// The four agents, in the order their steps are listed. A test passes its own agents in place of these.
const ALL_ADAPTERS: readonly AgentAdapter[] = [claudeAdapter, codexAdapter, opencodeAdapter, antigravityAdapter];

const SCOPES: readonly Scope[] = ["global", "project", "local"];

const AGENT_QUESTION = "Which agents? Names separated by spaces, or blank for all: ";
const SCOPE_QUESTION = "Which scope? global, project or local, or blank for global: ";
const APPLY_QUESTION = "Apply these changes? [y/N] ";
const UNKNOWN_SCOPE = "unknown scope; the scopes are global, project and local. Nothing was changed.";
const NOTHING_CHANGED = "Nothing was changed.";
const DRY_RUN_DONE = "Dry run: nothing was changed.";
const NO_RECORD = "no record in this scope, so nothing was changed.";
const PLAN_ERROR = "The plan has an error, so nothing was changed. Fix the problem and run the command again.";

// The inputs of one command. Agents are named by id. Undefined or an empty list means every agent. The scope is as the command
// line wrote it. Install uses the global scope when none is given. Update and uninstall act in every scope when none is given.
export interface FlowOptions {
  agents?: readonly string[];
  scope?: string;
  dryRun?: boolean;
  yes?: boolean;
}

// What the commands read and write. Production builds this from the process. A test passes fakes. The run, present and fs fields
// are the command runner, the program check and the file functions. When they are left out, the real ones are used.
export interface FlowIo {
  isTerminal: boolean;
  ask: (question: string) => Promise<string>;
  out: (line: string) => void;
  cliPath: string;
  packageRoot: string;
  projectDir: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  tokens: TokenStore;
  adapters?: readonly AgentAdapter[];
  run?: Runner;
  present?: (name: string) => boolean;
  fs?: FileOps;
}

// One line of output: the outcome of a step, or of one doctor check. The label names the agent and the scope, or the account.
interface Row {
  status: Step["status"];
  label: string;
  message: string;
}

// The steps of one pass, and the command lines and file changes that the pass listed, in order.
interface Pass {
  steps: Step[];
  shown: string[];
}

// One scope of an action, with the agents that act in it. The notes say why an agent was left out of the scope.
interface Target {
  scope: Scope;
  agents: string[];
  notes: Row[];
}

const adaptersOf = (io: FlowIo): readonly AgentAdapter[] => io.adapters ?? ALL_ADAPTERS;

const rowOf = (step: Step): Row => ({
  status: step.status,
  label: `${step.agent} ${step.scope}`,
  message: step.message,
});

// The shape of a Supabase access token. A token is never printed, so any text of this shape in a step line is shown as [redacted].
const TOKEN_SHAPE = /sbp_[A-Za-z0-9_-]+/g;

// Prints each row on one line. The whole line is checked for a token shape before it is printed.
const printRows = (io: FlowIo, rows: readonly Row[]): void => {
  for (const row of rows) {
    io.out(`[${row.status}] ${row.label}: ${row.message}`.replace(TOKEN_SHAPE, "[redacted]"));
  }
};

const hasError = (rows: readonly Row[]): boolean => rows.some((row) => row.status === "error");

// The text of an error that is shown. An error with a message gives its message. Any other value gives a fixed text, so nothing
// unknown is printed.
const reasonOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "The step failed without a message.";

// The code of a system error, or a fixed word when there is none. The code is shown, and the system's own message is not.
const codeOf = (error: unknown): string => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "unknown error";
};

// The scope a text names. Missing text means the global scope. A text that is not a scope gives undefined.
const scopeOf = (text: string | undefined): Scope | undefined => {
  if (text === undefined) {
    return "global";
  }
  return isScope(text) ? text : undefined;
};

// The agents a command names, or undefined when it names none. An empty list names none.
const namedAgents = (agents: readonly string[] | undefined): readonly string[] | undefined =>
  agents === undefined || agents.length === 0 ? undefined : agents;

// The names that an answer gives, separated by spaces or commas.
const namesIn = (answer: string): string[] => answer.split(/[\s,]+/).filter((name) => name !== "");

const hasUnknownAgent = (names: readonly string[], adapters: readonly AgentAdapter[]): boolean =>
  names.some((name) => !adapters.some((adapter) => adapter.id === name));

// The refusal for a name that no agent has. The name is not repeated, because a name can be a secret that was typed in the
// wrong place.
const unknownAgentRow = (adapters: readonly AgentAdapter[]): Row => ({
  status: "error",
  label: "agents",
  message: `unknown agent; the agents are ${adapters.map((adapter) => adapter.id).join(", ")}. Nothing was changed.`,
});

// The problem with the command line path of the running package, or undefined when the path can be used. The path must be
// absolute and written as path.resolve writes it: no trailing separator, no dot segments, and on Windows no forward slashes. The
// path comes from the running package and not from the command line, so a path of another form is a failed run. It is refused
// before any question, plan or change.
const cliPathProblem = (cliPath: string): string | undefined =>
  isAbsoluteLocation(cliPath) && path.resolve(cliPath) === cliPath
    ? undefined
    : "The command line program path must be absolute and written as path.resolve writes it, so nothing was changed.";

// The context for one pass. Each pass has its own, so the command lines it lists belong to that pass alone.
const contextFor = (io: FlowIo, dryRun: boolean): Context =>
  makeContext({
    projectDir: io.projectDir,
    cliPath: io.cliPath,
    packageRoot: io.packageRoot,
    dryRun,
    env: io.env,
    present: io.present,
    run: io.run,
    fs: io.fs,
  });

// One pass of the planner over one scope. The planner refuses the whole plan before any agent is called, and it throws that.
const planPass = async (
  io: FlowIo,
  action: Action,
  scope: string,
  agents: readonly string[] | undefined,
  dryRun: boolean,
): Promise<Pass> => {
  const result = await runPlan({ adapters: adaptersOf(io), action, scope, agents, ctx: contextFor(io, dryRun) });
  return { steps: result.steps, shown: result.shown };
};

// Writes the reason for a refused plan, and returns its exit code. An unknown scope is a wrong command line, so it gives 2.
// Any other refusal gives 1.
const refusal = (io: FlowIo, error: PlanRefused): number => {
  const sentence = "nothing was changed.";
  io.out(error.message.endsWith(sentence) ? error.message : `${error.message}. ${NOTHING_CHANGED}`);
  return error.kind === "unknown-scope" ? 2 : 1;
};

// Runs one command. A refused plan gives its own exit code. Any other failure gives exit 1 with its reason, so no rejection escapes
// the command, and the command stops there, so no later step runs.
const guarded = async (io: FlowIo, command: () => Promise<number>): Promise<number> => {
  try {
    return await command();
  } catch (error) {
    if (error instanceof PlanRefused) {
      return refusal(io, error);
    }
    io.out(`The command stopped before it finished: ${reasonOf(error)}`);
    return 1;
  }
};

// Shows one plan: the command lines and file changes in order, then the step of each agent.
const showPlan = (io: FlowIo, scope: Scope, pass: Pass): void => {
  io.out(`Plan for the ${scope} scope:`);
  for (const line of pass.shown) {
    io.out(`  ${line}`);
  }
  printRows(io, pass.steps.map(rowOf));
};

// Asks one question. An answer that cannot be read gives undefined: the input closed, the question was rejected, or the answer is
// not text. The caller then stops, so no rejection escapes as an exception, and nothing is written.
const askOf = async (io: FlowIo, question: string): Promise<string | undefined> => {
  try {
    const answer: unknown = await io.ask(question);
    return typeof answer === "string" ? answer : undefined;
  } catch {
    return undefined;
  }
};

// The exit code for an answer that could not be read. No change has been made when a question is asked, so nothing is changed.
const answerFailed = (io: FlowIo): number => {
  io.out("No answer could be read, so nothing was changed.");
  return 1;
};

// Whether an agent holds any record in a scope. A state file that cannot be read counts as a record, so the adapter reads it and
// reports the failure as its own step.
const hasRecord = async (agent: AgentId, key: string): Promise<boolean> => {
  try {
    return (await recordedItems(agent, key)).length > 0;
  } catch {
    return true;
  }
};

// Records the command line path for each agent whose step succeeded. A scope in which any step failed records nothing, so a
// record never describes a scope that did not fully install. A record that cannot be written is an error row.
const recordServers = async (io: FlowIo, steps: readonly Step[]): Promise<Row[]> => {
  const failedScopes = new Set(steps.filter((step) => step.status === "error").map((step) => step.scope));
  const rows: Row[] = [];
  for (const step of steps) {
    const adapter = adaptersOf(io).find((candidate) => candidate.id === step.agent);
    if (step.status !== "ok" || adapter === undefined || failedScopes.has(step.scope)) {
      continue;
    }
    try {
      await record(adapter.id, scopeKey(step.scope, io.projectDir), { kind: "server", cliPath: io.cliPath });
    } catch (error) {
      rows.push({
        status: "error",
        label: rowOf(step).label,
        message: `The command line path could not be recorded: ${reasonOf(error)}`,
      });
    }
  }
  return rows;
};

// Asks which agents and which scope, when a terminal install names no agent. Blank answers take the defaults. Undefined means an
// answer could not be read.
const askInstallChoices = async (
  io: FlowIo,
  options: FlowOptions,
): Promise<{ agents: readonly string[] | undefined; scopeText: string | undefined } | undefined> => {
  const agentAnswer = await askOf(io, AGENT_QUESTION);
  if (agentAnswer === undefined) {
    return undefined;
  }
  const named = namesIn(agentAnswer);
  let scopeText = options.scope;
  if (scopeText === undefined) {
    const scopeAnswer = await askOf(io, SCOPE_QUESTION);
    if (scopeAnswer === undefined) {
      return undefined;
    }
    const answer = scopeAnswer.trim();
    scopeText = answer === "" ? undefined : answer;
  }
  return { agents: named.length === 0 ? undefined : named, scopeText };
};

// Install. The command line path is checked first. The dry pass shows the plan. Then the flow stops for a dry run, refuses without
// a terminal and without --yes, or asks to apply in a terminal. The real pass records the command line path for each agent whose
// step succeeded, in each scope where no step failed.
const installCommand = async (options: FlowOptions, io: FlowIo): Promise<number> => {
  const problem = cliPathProblem(io.cliPath);
  if (problem !== undefined) {
    io.out(problem);
    return 1;
  }
  const adapters = adaptersOf(io);
  let agents = namedAgents(options.agents);
  let scopeText = options.scope;
  // Questions are asked only in a terminal, when no agent is named and --yes is not given. With --yes there are no questions.
  if (io.isTerminal && options.yes !== true && agents === undefined) {
    const choices = await askInstallChoices(io, options);
    if (choices === undefined) {
      return answerFailed(io);
    }
    agents = choices.agents;
    scopeText = choices.scopeText;
  }
  const scope = scopeOf(scopeText);
  if (scope === undefined) {
    io.out(UNKNOWN_SCOPE);
    return 2;
  }
  if (agents !== undefined && hasUnknownAgent(agents, adapters)) {
    printRows(io, [unknownAgentRow(adapters)]);
    return 1;
  }
  const dry = await planPass(io, "install", scope, agents, true);
  showPlan(io, scope, dry);
  if (options.dryRun === true) {
    io.out(DRY_RUN_DONE);
    return hasError(dry.steps.map(rowOf)) ? 1 : 0;
  }
  if (options.yes !== true && !io.isTerminal) {
    io.out(`install needs --yes when there is no terminal, so ${NOTHING_CHANGED.toLowerCase()}`);
    return 2;
  }
  // A plan with an error row is not applied, with or without --yes. The owner fixes the problem and runs the command again.
  if (hasError(dry.steps.map(rowOf))) {
    io.out(PLAN_ERROR);
    return 1;
  }
  if (options.yes !== true) {
    const answer = await askOf(io, APPLY_QUESTION);
    if (answer === undefined) {
      return answerFailed(io);
    }
    // Only y or yes applies. A blank answer, or any other text, means no.
    const normalized = answer.trim().toLowerCase();
    if (normalized !== "y" && normalized !== "yes") {
      io.out(NOTHING_CHANGED);
      return 0;
    }
  }
  const real = await planPass(io, "install", scope, agents, false);
  const rows = [...real.steps.map(rowOf), ...(await recordServers(io, real.steps))];
  io.out("Results:");
  printRows(io, rows);
  return hasError(rows) ? 1 : 0;
};

export const install = (options: FlowOptions, io: FlowIo): Promise<number> =>
  guarded(io, () => installCommand(options, io));

// The agents that act in one scope. A named agent is always included when the scope is named, so the planner refuses a named
// agent that lacks the scope. Without a scope named, an agent acts only where it holds a record. An unnamed agent that lacks the
// scope is left out, and the reason is given when the scope was named.
const targetOf = async (
  adapters: readonly AgentAdapter[],
  scope: Scope,
  named: readonly string[] | undefined,
  scopeNamed: boolean,
  projectDir: string,
): Promise<Target> => {
  const key = scopeKey(scope, projectDir);
  const agents: string[] = [];
  const notes: Row[] = [];
  for (const adapter of adapters) {
    if (named !== undefined && !named.includes(adapter.id)) {
      continue;
    }
    const supported = adapter.scopes.includes(scope);
    // A named agent that lacks a named scope is passed on, so the planner refuses the whole command.
    if (!supported && named !== undefined && scopeNamed) {
      agents.push(adapter.id);
      continue;
    }
    if (!supported) {
      if (scopeNamed) {
        notes.push({ status: "skipped", label: `${adapter.id} ${scope}`, message: unsupportedReason(adapter.id, scope) });
      }
      continue;
    }
    if (await hasRecord(adapter.id, key)) {
      agents.push(adapter.id);
      continue;
    }
    // A named agent with no record gets a line of its own, so every named agent appears in the output, with or without a scope.
    if (named !== undefined) {
      notes.push({ status: "skipped", label: `${adapter.id} ${scope}`, message: NO_RECORD });
    }
  }
  return { scope, agents, notes };
};

// Update and uninstall share one shape. Each refuses --yes, shows the plan, stops there for a dry run, and otherwise runs. Only
// update records the command line path again, after each successful step.
const runChange = async (action: "update" | "uninstall", options: FlowOptions, io: FlowIo): Promise<number> => {
  if (options.yes === true) {
    io.out(`${action} does not take --yes, so nothing was changed.`);
    return 2;
  }
  if (action === "update") {
    const problem = cliPathProblem(io.cliPath);
    if (problem !== undefined) {
      io.out(problem);
      return 1;
    }
  }
  const adapters = adaptersOf(io);
  const named = namedAgents(options.agents);
  if (named !== undefined && hasUnknownAgent(named, adapters)) {
    printRows(io, [unknownAgentRow(adapters)]);
    return 1;
  }
  const chosen = options.scope === undefined ? undefined : scopeOf(options.scope);
  if (options.scope !== undefined && chosen === undefined) {
    io.out(UNKNOWN_SCOPE);
    return 2;
  }
  const scopes: readonly Scope[] = chosen === undefined ? SCOPES : [chosen];
  const targets: Target[] = [];
  const notes: Row[] = [];
  for (const scope of scopes) {
    const target = await targetOf(adapters, scope, named, chosen !== undefined, io.projectDir);
    notes.push(...target.notes);
    if (target.agents.length > 0) {
      targets.push(target);
    }
  }
  // The reasons for the agents left out are printed in every case, so an empty result still says why.
  printRows(io, notes);
  if (targets.length === 0) {
    const where = chosen === undefined ? "in any scope" : `in the ${chosen} scope`;
    io.out(`Nothing to ${action}: no agent has a record ${where}.`);
    return 0;
  }
  const plans: { target: Target; pass: Pass }[] = [];
  for (const target of targets) {
    plans.push({ target, pass: await planPass(io, action, target.scope, target.agents, true) });
  }
  for (const { target, pass } of plans) {
    showPlan(io, target.scope, pass);
  }
  if (options.dryRun === true) {
    io.out(DRY_RUN_DONE);
    return hasError(plans.flatMap(({ pass }) => pass.steps.map(rowOf))) ? 1 : 0;
  }
  // A dry pass with an error row stops the command before any change, as install does. The owner fixes the problem and runs again.
  if (hasError(plans.flatMap(({ pass }) => pass.steps.map(rowOf)))) {
    io.out(PLAN_ERROR);
    return 1;
  }
  io.out("Results:");
  const rows: Row[] = [];
  for (const { target } of plans) {
    const real = await planPass(io, action, target.scope, target.agents, false);
    const stepRows = real.steps.map(rowOf);
    const recordRows = action === "update" ? await recordServers(io, real.steps) : [];
    printRows(io, [...stepRows, ...recordRows]);
    rows.push(...stepRows, ...recordRows);
  }
  return hasError(rows) ? 1 : 0;
};

export const update = (options: FlowOptions, io: FlowIo): Promise<number> =>
  guarded(io, () => runChange("update", options, io));

export const uninstall = (options: FlowOptions, io: FlowIo): Promise<number> =>
  guarded(io, () => runChange("uninstall", options, io));

// The name of a scope in a doctor row. A project or local scope names its folder, so two folders give two labels.
const scopeLabel = (key: string): string => {
  if (key === "global") {
    return "global";
  }
  return key.replace(/^project:/, "project ").replace(/^local:/, "local ");
};

// The check of one recorded command line path. The path must still exist. A path under a file counts as missing.
const serverRow = async (label: string, cliPath: string): Promise<Row> => {
  try {
    await stat(cliPath);
    return { status: "ok", label, message: `The command line program is at ${cliPath}.` };
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { status: "error", label, message: `cliPath does not exist: ${cliPath}. Run update to refresh it.` };
    }
    return { status: "error", label, message: `cliPath could not be checked (${code}): ${cliPath}.` };
  }
};

// The check of each recorded command line path, in every scope that each agent records.
const serverRows = async (io: FlowIo): Promise<Row[]> => {
  const rows: Row[] = [];
  for (const adapter of adaptersOf(io)) {
    let keys: string[];
    try {
      keys = await recordedScopeKeys(adapter.id);
    } catch (error) {
      rows.push({ status: "error", label: adapter.id, message: reasonOf(error) });
      continue;
    }
    for (const key of keys) {
      const label = `${adapter.id} ${scopeLabel(key)}`;
      let items: Item[];
      try {
        items = await recordedItems(adapter.id, key);
      } catch (error) {
        rows.push({ status: "error", label, message: reasonOf(error) });
        continue;
      }
      for (const item of items) {
        if (item.kind === "server") {
          rows.push(await serverRow(label, item.cliPath));
        }
      }
    }
  }
  return rows;
};

// Whether the store holds a value for an account. The value is used for this one check and is not returned, so no caller keeps it.
const tokenPresent = async (tokens: TokenStore, name: string): Promise<boolean> => {
  const value = await tokens.get(name);
  return value !== undefined && value !== "";
};

// The check of each account in the registry. The store must hold a value for the account. A store error gives a fixed message,
// because the store's own text can hold more than the name.
const accountRows = async (io: FlowIo): Promise<Row[]> => {
  let registry: Registry;
  try {
    registry = await Registry.load(path.join(dataFolder(io.env, process.platform, io.homeDir), "accounts.json"));
  } catch (error) {
    return [{ status: "error", label: "accounts", message: reasonOf(error) }];
  }
  const rows: Row[] = [];
  for (const name of registry.names()) {
    const label = `account ${name}`;
    try {
      const present = await tokenPresent(io.tokens, name);
      rows.push(
        present
          ? { status: "ok", label, message: "a token is in the store." }
          : { status: "error", label, message: "no token in the store." },
      );
    } catch {
      rows.push({ status: "error", label, message: "the token could not be checked." });
    }
  }
  return rows;
};

// Doctor. Each adapter's own check runs first. Then each recorded command line path is checked, and then each account's token.
// A check that fails does not stop the others. The exit code is 1 when any row is an error.
const doctorCommand = async (io: FlowIo): Promise<number> => {
  const result = await runPlan({ adapters: adaptersOf(io), action: "doctor", ctx: contextFor(io, false) });
  const rows = [...result.steps.map(rowOf), ...(await serverRows(io)), ...(await accountRows(io))];
  printRows(io, rows);
  return hasError(rows) ? 1 : 0;
};

export const doctor = (io: FlowIo): Promise<number> => guarded(io, () => doctorCommand(io));
