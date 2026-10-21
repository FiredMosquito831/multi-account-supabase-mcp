import { spawn, spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";

export type CommandResult = { code: number; stdout: string; stderr: string };

export type CommandOptions = { cwd?: string };

// Runs a command with fixed arguments and no shell. The one exception is a Windows .cmd or .bat file, which Node
// cannot start directly: it runs through cmd.exe, after every argument has been checked.
export type Runner = (command: string, args: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

export type ResolvedCommand = { file: string; viaCmd: boolean };

type Invocation = { file: string; args: string[]; verbatim: boolean };

const systemRoot = (): string => process.env.SystemRoot ?? "C:\\Windows";

// Windows looks in the current folder before PATH for a bare program name. The programs this file starts are
// therefore given by their full path in the system folder.
const systemProgram = (name: string): string => path.win32.join(systemRoot(), "System32", name);

// A regular file, following a symbolic link. A folder with the command's name is not a command.
const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const resolveOnPath = (name: string): ResolvedCommand | undefined => {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    // An empty entry means the current folder. It is skipped, so a file planted in the working folder is never run.
    const file = path.join(dir, name);
    if (dir !== "" && isFile(file)) {
      return { file, viaCmd: false };
    }
  }
  return undefined;
};

const resolveOnWindows = (name: string): ResolvedCommand | undefined => {
  // where.exe lists the matches in its current folder before PATH, so it runs from the system root.
  const listing = spawnSync(systemProgram("where.exe"), [name], {
    cwd: systemRoot(),
    encoding: "utf8",
    windowsHide: true,
  }).stdout;
  const found = (listing ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const exe = found.find((file) => /\.exe$/i.test(file));
  if (exe) {
    return { file: exe, viaCmd: false };
  }
  const script = found.find((file) => /\.(cmd|bat)$/i.test(file));
  return script ? { file: script, viaCmd: true } : undefined;
};

// Where a command lives. On Windows npm installs most agent CLIs as .cmd shims next to a shell script, and only an
// .exe can be started without a shell, so an .exe is preferred when there is one.
export const resolveCommand = (name: string): ResolvedCommand | undefined =>
  process.platform === "win32" ? resolveOnWindows(name) : resolveOnPath(name);

export const isPresent = (name: string): boolean => resolveCommand(name) !== undefined;

// Exported for the tests. An argument with a double quote, a percent sign or a line break is refused, because cmd.exe
// reads each of these in a special way, even inside double quotes. An exclamation mark is refused for a different
// reason: when delayed expansion is on, which a registry setting can switch on, cmd.exe replaces the text between two
// marks with the value of a variable of that name, even inside double quotes. The refusal happens before anything
// starts. The message does not repeat the argument, because an argument can be a secret.
export const quoteForCmd = (arg: string): string => {
  if (/["%!\r\n]/.test(arg)) {
    throw new Error(
      "An argument has a double quote, a percent sign, an exclamation mark or a line break, " +
        "so it cannot be passed through cmd.exe",
    );
  }
  return `"${arg}"`;
};

// A .cmd or .bat file runs through cmd.exe as one quoted command line. With /s, cmd.exe removes the outer pair of
// quotes and runs the rest. /d turns off AutoRun, but not delayed expansion, which a registry setting can switch on,
// so quoteForCmd also refuses an exclamation mark. verbatim stops Node from adding quotes of its own, which would
// break the line.
const cmdInvocation = (shim: string, args: readonly string[]): Invocation => ({
  file: systemProgram("cmd.exe"),
  args: ["/d", "/s", "/c", `"${[shim, ...args].map((arg) => quoteForCmd(arg)).join(" ")}"`],
  verbatim: true,
});

// Starts the process and collects its output. Standard input is not connected, so a command that asks a question
// reads end-of-file instead of waiting for an answer.
const runChild = (invocation: Invocation, cwd: string | undefined): Promise<CommandResult> =>
  new Promise((resolve) => {
    const child = spawn(invocation.file, invocation.args, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: invocation.verbatim,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    // setEncoding keeps a multi-byte character that is split between two chunks whole.
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) =>
      resolve({ code: 1, stdout, stderr: [stderr, error.message].filter((part) => part !== "").join("\n") }),
    );
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

// Runs a command and resolves with its exit code and output. A name that is not on PATH resolves with code 127, the
// code a shell gives for the same case. A command that cannot be started resolves with code 1. An argument that
// cmd.exe cannot carry rejects, and nothing is started.
export const runCommand: Runner = async (command, args, options = {}) => {
  const resolved = resolveCommand(command);
  if (!resolved) {
    return { code: 127, stdout: "", stderr: `${command} is not on PATH` };
  }
  // Built before the process starts, so a refused argument throws here.
  const invocation: Invocation = resolved.viaCmd
    ? cmdInvocation(resolved.file, args)
    : { file: resolved.file, args: [...args], verbatim: false };
  try {
    return await runChild(invocation, options.cwd);
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
};
