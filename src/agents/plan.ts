import { isAbsoluteLocation } from "../paths.js";
import { type Scope, isScope } from "./scopes.js";
import {
  type AgentAdapter,
  type Context,
  PlanRefused,
  type Step,
  unsupportedReason,
} from "./types.js";

export type Action = "install" | "update" | "uninstall" | "doctor";

export interface PlanOptions {
  adapters: readonly AgentAdapter[];
  action: Action;
  // The agents the caller named, by id. An agent that is not in the list is left out. A name that matches no agent,
  // and an empty list, each give an error step.
  agents?: readonly string[];
  // The scope to act in, as the caller wrote it. The default is global. The doctor action ignores the scope, but a text
  // that is not a scope still refuses the plan.
  scope?: string;
  ctx: Context;
}

export interface PlanResult {
  steps: Step[];
  // The command lines and file actions, in order, as the context recorded them. This is a copy, so a later run with
  // the same context does not change it. A real run returns the list after its changes, so a caller that must show the
  // lines first runs a dry pass before the real pass.
  shown: string[];
}

// One entry of the plan: either a step that is already known, or an agent that is to be called.
type Planned = { known: Step } | { adapter: AgentAdapter; scope: Scope };

const callAdapter = (adapter: AgentAdapter, action: Action, ctx: Context, scope: Scope): Promise<Step[]> => {
  switch (action) {
    case "install":
      return adapter.install(ctx, scope);
    case "update":
      return adapter.update(ctx, scope);
    case "uninstall":
      return adapter.uninstall(ctx, scope);
    case "doctor":
      return adapter.doctor(ctx);
  }
};

// The message of a failed step is the message of its error. An adapter must keep a file's text out of its error
// messages, because this message is shown as it is. Any other thrown value gives a fixed text, so its contents are
// never written out.
const FAILED_WITHOUT_MESSAGE = "The step failed without a message.";

const failureMessage = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : FAILED_WITHOUT_MESSAGE;

// A name is repeated in a message only when it looks like a plain word. Any other text may be a secret that was typed
// in the wrong place, so the planner shows a placeholder for it.
const PLAIN_WORD = /^[A-Za-z][A-Za-z-]{0,23}$/;
const shownName = (name: string): string => (PLAIN_WORD.test(name) ? name : "<not shown>");

// The scope asked for. The default is global. A text that is not a scope refuses the plan. The error names the text
// when it is a plain word. A value that is not a plain word is shown as a placeholder, so a token typed into the
// agent list or the scope is not repeated in output. A plain word is repeated, so a secret made only of letters and
// hyphens, up to 24 characters, is repeated too.
const scopeAsked = (requested: string | undefined): Scope => {
  if (requested === undefined) {
    return "global";
  }
  if (!isScope(requested)) {
    throw new PlanRefused(
      "unknown-scope",
      `unknown scope ${shownName(requested)}; the scopes are global, project and local`,
    );
  }
  return requested;
};

// Runs one action over the agents, in the order given. The checks come first, and each one refuses the whole plan
// before any agent is called: an unknown scope, a command line program path that is not absolute (for install and
// update), and a named agent that lacks the scope. An agent that was not named and lacks the scope gets a skipped step
// with its reason. A name that matches no agent, and an empty list of agents, each give an error step, and the plan
// goes on. An agent that throws gets one error step, and the agents after it still run.
export const runPlan = async (options: PlanOptions): Promise<PlanResult> => {
  const { adapters, action, agents, ctx } = options;
  const asked = scopeAsked(options.scope);
  // Doctor has no scope of its own, so its steps name the global scope.
  const scope: Scope = action === "doctor" ? "global" : asked;
  if ((action === "install" || action === "update") && !isAbsoluteLocation(ctx.cliPath)) {
    throw new PlanRefused(
      "relative-path",
      "The command line program path must be absolute, so nothing was changed.",
    );
  }
  const planned: Planned[] = [];
  for (const adapter of adapters) {
    if (agents !== undefined && !agents.includes(adapter.id)) {
      continue;
    }
    // The doctor action only reads each agent's state, so the scope does not apply to it.
    if (action !== "doctor" && !adapter.scopes.includes(scope)) {
      if (agents !== undefined) {
        throw new PlanRefused("unsupported-scope", unsupportedReason(adapter.id, scope));
      }
      planned.push({
        known: { agent: adapter.id, scope, status: "skipped", message: unsupportedReason(adapter.id, scope) },
      });
      continue;
    }
    planned.push({ adapter, scope });
  }
  const ids: string[] = adapters.map((adapter) => adapter.id);
  for (const name of new Set(agents ?? [])) {
    if (!ids.includes(name)) {
      planned.push({
        known: {
          agent: shownName(name),
          scope,
          status: "error",
          message: `unknown agent; the agents are ${ids.join(", ")}`,
        },
      });
    }
  }
  if (agents !== undefined && agents.length === 0) {
    planned.push({
      known: {
        agent: "",
        scope,
        status: "error",
        message: "name at least one agent, or leave the list out for all",
      },
    });
  }
  const steps: Step[] = [];
  for (const entry of planned) {
    if ("known" in entry) {
      steps.push(entry.known);
      continue;
    }
    try {
      steps.push(...(await callAdapter(entry.adapter, action, ctx, entry.scope)));
    } catch (error) {
      // The failure becomes one step, so the steps of the other agents are kept, and the next agent still runs.
      steps.push({ agent: entry.adapter.id, scope: entry.scope, status: "error", message: failureMessage(error) });
    }
  }
  // A copy, so a later run with the same context does not change this result.
  return { steps, shown: [...ctx.shown] };
};
