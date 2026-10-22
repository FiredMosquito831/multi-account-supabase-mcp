import { mkdir, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { type CommandOptions, type CommandResult, type Runner, isPresent, runCommand } from "./command.js";
import type { Scope } from "./scopes.js";
import type { AgentId } from "./state.js";

// One outcome of an agent's action, for one scope. A skipped step says why it was skipped. An error about a name, or
// about an empty list, carries the name as the planner shows it, or nothing, because no agent has that name.
export interface Step {
  agent: string;
  scope: Scope;
  status: "ok" | "skipped" | "error";
  message: string;
}

// The reason an agent gives for lacking a scope. The error and the skipped step use the same words.
export const unsupportedReason = (agent: AgentId, scope: Scope): string => `${agent} has no ${scope} scope`;

// Raised by an adapter that is called with a scope it does not support. The planner does not raise it: for a named
// agent it refuses the whole plan with PlanRefused, and an agent that was not named is skipped instead. The message is
// the standard text, unless the caller gives a fuller one.
export class UnsupportedScope extends Error {
  readonly agent: AgentId;
  readonly scope: Scope;

  constructor(agent: AgentId, scope: Scope, message = unsupportedReason(agent, scope)) {
    super(message);
    this.name = "UnsupportedScope";
    this.agent = agent;
    this.scope = scope;
  }
}

// Raised when the planner refuses a whole plan. The kind says why, so the CLI can choose its exit code without reading
// the message. An unknown scope is a command line that is wrong. A path that is not absolute is a fault in how the
// program was started. A named agent that lacks the scope is refused before any agent is called.
export type PlanRefusalKind = "unknown-scope" | "relative-path" | "unsupported-scope";

export class PlanRefused extends Error {
  readonly kind: PlanRefusalKind;

  constructor(kind: PlanRefusalKind, message: string) {
    super(message);
    this.name = "PlanRefused";
    this.kind = kind;
  }
}

// What a command returns through the context. A dry run returns a fake success marked with dryRun, so an adapter can
// tell it from a real result.
export type ContextResult = CommandResult & { dryRun?: boolean };

// What an adapter may use. Each command and file change is listed in shown, and a dry run makes none of them. The
// ownership record is not written through this context: an adapter that writes it checks dryRun first, so a dry run
// writes no record.
export interface Context {
  projectDir: string;
  cliPath: string;
  packageRoot: string;
  dryRun: boolean;
  // The environment the agents' folders will be read from. makeContext sets it from the caller's env, or else from
  // the process environment. No code reads it yet, so the agents and state.ts still read the process environment.
  env: NodeJS.ProcessEnv;
  // Each command line and file action, in the order it was asked for. When the install flow is built, it runs a dry
  // pass first and shows this list, so the lines are shown before the real pass makes any change.
  shown: string[];
  present(name: string): boolean;
  // A command runs in the folder of this process, unless the options name another folder. A folder that is named is
  // listed in shown before the command line, so a dry run shows where each command would run. In a dry run this returns
  // a fake success with no output, marked dryRun. That is not what the command would print. An adapter must not report
  // that result or act on it, and must check dryRun before it reads the result.
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<ContextResult>;
  writeFile(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  // Creates one folder. Its parent must already exist, so callers create parents first, one call per folder.
  // A folder that exists already is left as it is, and a file at the path is an error.
  ensureDir(path: string): Promise<void>;
  // Removes a folder only when it is empty. A folder that holds anything, or that is not there, is left as it is.
  removeDirIfEmpty(path: string): Promise<void>;
}

// The methods of one agent's adapter. Each one returns the steps it made, so the caller can show them.
export interface AgentAdapter {
  id: AgentId;
  scopes: readonly Scope[];
  present(ctx: Context): boolean;
  install(ctx: Context, scope: Scope): Promise<Step[]>;
  update(ctx: Context, scope: Scope): Promise<Step[]>;
  uninstall(ctx: Context, scope: Scope): Promise<Step[]>;
  doctor(ctx: Context): Promise<Step[]>;
}

// The file functions a context uses. The real ones are the default. A test passes fakes.
export interface FileOps {
  writeFile(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  removeDirIfEmpty(path: string): Promise<void>;
}

export interface ContextOptions {
  projectDir: string;
  cliPath: string;
  packageRoot: string;
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  present?: (name: string) => boolean;
  run?: Runner;
  fs?: FileOps;
}

const realFiles: FileOps = {
  writeFile: (file, text) => writeFile(file, text, "utf8"),
  // A file that is already gone is not a failure, because the goal of a removal is that the file is gone. Other errors,
  // such as a folder given in place of a file, are reported.
  removeFile: (file) => rm(file, { force: true }),
  // One folder is created, and its parent must exist. A folder that is there already is left as it is. A file at the
  // path is not a folder, so the creation below refuses it.
  ensureDir: async (dir) => {
    if ((await stat(dir).catch(() => undefined))?.isDirectory()) {
      return;
    }
    await mkdir(dir);
  },
  // A folder is removed only when it is empty. rmdir refuses a folder that holds anything, and some systems report that
  // as EEXIST. A folder that is not there is already gone, so it is not an error. Any other error is reported.
  removeDirIfEmpty: async (dir) => {
    try {
      await rmdir(dir);
    } catch (error) {
      const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
      if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") {
        throw error;
      }
    }
  },
};

// A command line as a person would type it. An argument that is empty, or that has a space or a
// double quote, is wrapped in double quotes. The text is for display only: nothing is run from it.
const commandLine = (command: string, args: readonly string[]): string =>
  [command, ...args].map((part) => (part === "" || /[\s"]/.test(part) ? `"${part}"` : part)).join(" ");

// The caller builds this context with makeContext, and passes the same context to every agent in one run. Each
// command and file change is listed in shown. A dry run makes none of them, and a real run lists each one before
// making it. A dry run's command results are fake (see run).
export const makeContext = (options: ContextOptions): Context => {
  const { dryRun } = options;
  const present = options.present ?? isPresent;
  const runner: Runner = options.run ?? runCommand;
  const files = options.fs ?? realFiles;
  const shown: string[] = [];
  return {
    projectDir: options.projectDir,
    cliPath: options.cliPath,
    packageRoot: options.packageRoot,
    dryRun,
    env: options.env ?? process.env,
    shown,
    present,
    async run(command, args, commandOptions) {
      if (commandOptions?.cwd !== undefined) {
        shown.push(`cwd ${commandOptions.cwd}`);
      }
      shown.push(commandLine(command, args));
      if (dryRun) {
        return { code: 0, stdout: "", stderr: "", dryRun: true };
      }
      return runner(command, args, commandOptions);
    },
    async writeFile(file, text) {
      shown.push(`write ${file}`);
      if (!dryRun) {
        await files.writeFile(file, text);
      }
    },
    async removeFile(file) {
      shown.push(`remove ${file}`);
      if (!dryRun) {
        await files.removeFile(file);
      }
    },
    async ensureDir(dir) {
      shown.push(`mkdir ${dir}`);
      if (!dryRun) {
        await files.ensureDir(dir);
      }
    },
    async removeDirIfEmpty(dir) {
      shown.push(`remove empty folder ${dir}`);
      if (!dryRun) {
        await files.removeDirIfEmpty(dir);
      }
    },
  };
};
