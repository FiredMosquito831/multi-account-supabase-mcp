import { mkdir, rm, rmdir, writeFile } from "node:fs/promises";
import { type CommandResult, type Runner, isPresent, runCommand } from "./command.js";
import type { Scope } from "./scopes.js";
import type { AgentId } from "./state.js";

// One outcome of an agent's action, for one scope. A skipped step says why it was skipped.
export interface Step {
  agent: AgentId;
  scope: Scope;
  status: "ok" | "skipped" | "error";
  message: string;
}

// The reason an agent gives for lacking a scope. The error and the skipped step use the same words.
export const unsupportedReason = (agent: AgentId, scope: Scope): string => `${agent} has no ${scope} scope`;

// Raised when an agent that the caller named does not have the scope asked for. The message is the standard text, unless
// the caller gives a fuller one.
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

// What an adapter may use. Every command and every file change goes through here, so a dry run can record them instead
// of making them.
export interface Context {
  projectDir: string;
  cliPath: string;
  packageRoot: string;
  dryRun: boolean;
  // Each command line and file action, in the order it was asked for. A caller prints this list
  // before a change is made.
  shown: string[];
  present(name: string): boolean;
  run(command: string, args: readonly string[]): Promise<CommandResult>;
  writeFile(path: string, text: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  // Creates a folder, and any folder above it that is missing. A folder that exists already is not an error.
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
  present?: (name: string) => boolean;
  run?: Runner;
  fs?: FileOps;
}

const realFiles: FileOps = {
  writeFile: (file, text) => writeFile(file, text, "utf8"),
  // A file that is already gone is not a failure, because the goal of a removal is that the file is gone. Other errors,
  // such as a folder given in place of a file, are reported.
  removeFile: (file) => rm(file, { force: true }),
  // An existing folder is not an error. Folders above a missing one are created as well.
  ensureDir: async (dir) => {
    await mkdir(dir, { recursive: true });
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

// The context for one agent's actions. In a dry run each command and file change is recorded in shown
// and not made. A real run records the same list, then makes each change, so the list is the same in
// both cases.
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
    shown,
    present,
    async run(command, args) {
      shown.push(commandLine(command, args));
      if (dryRun) {
        return { code: 0, stdout: "", stderr: "" };
      }
      return runner(command, args);
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
