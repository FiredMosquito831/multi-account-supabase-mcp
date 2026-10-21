import type { Scope } from "./scopes.js";
import type { AgentId } from "./state.js";
import { type AgentAdapter, type Context, type Step, UnsupportedScope, unsupportedReason } from "./types.js";

export type Action = "install" | "update" | "uninstall" | "doctor";

export interface PlanOptions {
  adapters: readonly AgentAdapter[];
  action: Action;
  // The agents the caller named. When this is given, an agent that is not in the list is left out. An empty list leaves
  // out every agent.
  agents?: readonly AgentId[];
  // The scope to act in. The default is global. The doctor action ignores the scope.
  scope?: Scope;
  ctx: Context;
}

export interface PlanResult {
  steps: Step[];
  // The command lines and file actions, in order, as the context recorded them.
  shown: string[];
}

// One entry of the plan: either a step that is already known, or an agent that is to be called.
type Planned = { skipped: Step } | { adapter: AgentAdapter; scope: Scope };

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

// Runs one action over the agents, in the order given. The whole plan is decided before any agent is called. So a named
// agent that lacks the scope stops the command before anything is written, including for the agents listed before it.
// An agent that was not named and lacks the scope gets a skipped step with its reason. An agent that throws gets one
// error step, and the agents after it still run.
export const runPlan = async (options: PlanOptions): Promise<PlanResult> => {
  const { adapters, action, agents, ctx } = options;
  // Doctor has no scope of its own, so its steps name the global scope.
  const scope: Scope = action === "doctor" ? "global" : (options.scope ?? "global");
  const planned: Planned[] = [];
  for (const adapter of adapters) {
    if (agents !== undefined && !agents.includes(adapter.id)) {
      continue;
    }
    // The doctor action only reads each agent's state, so the scope does not apply to it.
    if (action !== "doctor" && !adapter.scopes.includes(scope)) {
      if (agents !== undefined) {
        throw new UnsupportedScope(adapter.id, scope);
      }
      planned.push({
        skipped: { agent: adapter.id, scope, status: "skipped", message: unsupportedReason(adapter.id, scope) },
      });
      continue;
    }
    planned.push({ adapter, scope });
  }
  const steps: Step[] = [];
  for (const entry of planned) {
    if ("skipped" in entry) {
      steps.push(entry.skipped);
      continue;
    }
    try {
      steps.push(...(await callAdapter(entry.adapter, action, ctx, entry.scope)));
    } catch (error) {
      // The failure becomes one step, so the steps of the other agents are kept, and the next agent still runs.
      steps.push({ agent: entry.adapter.id, scope: entry.scope, status: "error", message: failureMessage(error) });
    }
  }
  return { steps, shown: ctx.shown };
};
