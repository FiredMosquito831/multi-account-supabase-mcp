import { isAbsoluteLocation } from "../paths.js";
import type { AgentId } from "./state.js";

// Where an agent's configuration applies. Local is for Claude Code only, and Antigravity has the global scope only.
export type Scope = "global" | "project" | "local";

const SCOPE_NAMES: readonly Scope[] = ["global", "project", "local"];

// Whether a text is one of the scopes. The planner refuses any other text.
export const isScope = (value: string): value is Scope => SCOPE_NAMES.some((name) => name === value);

// The name of the server in an agent's configuration when this tool installs it directly.
export const DIRECT_KEY = "multi-account-supabase";

// The name the plugin gives the same server. The two names differ, so both can be installed side by side.
export const PLUGIN_KEY = "supabase";

// The scopes each agent accepts. An agent that is not in this table accepts no scope at all.
const SCOPES = new Map<AgentId, readonly Scope[]>([
  ["claude", ["global", "project", "local"]],
  ["codex", ["global", "project"]],
  ["opencode", ["global", "project"]],
  ["antigravity", ["global"]],
]);

export const supportedScopes = (agent: AgentId): readonly Scope[] => SCOPES.get(agent) ?? [];

// The entry that starts this tool's server, with the key it is kept under: the Node binary that runs this code,
// then the command line program with the serve argument. The command is an absolute path, so no .cmd shim is needed
// on Windows. The platform decides what counts as absolute, and it defaults to the system this runs on.
export const directEntry = (
  cliPath: string,
  platform: NodeJS.Platform = process.platform,
): { key: string; command: string; args: string[] } => {
  if (!isAbsoluteLocation(cliPath, platform)) {
    throw new Error("The command line program path must be absolute.");
  }
  return { key: DIRECT_KEY, command: process.execPath, args: [cliPath, "serve"] };
};
