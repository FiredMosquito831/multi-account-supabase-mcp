import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, readdirSync, statSync } from "node:fs";
import path from "node:path";

export type CommandResult = { code: number; stdout: string; stderr: string };

export type CommandOptions = { cwd?: string; timeoutMs?: number };

// Runs a command with fixed arguments and no shell. The one exception is a Windows .cmd or .bat file, which Node
// cannot start directly: it runs through cmd.exe, after every argument has been checked.
export type Runner = (command: string, args: readonly string[], options?: CommandOptions) => Promise<CommandResult>;

export type ResolvedCommand = { file: string; viaCmd: boolean };

type Invocation = { file: string; args: string[]; verbatim: boolean };

// A command that runs longer than this is ended. The default is two minutes.
const DEFAULT_TIMEOUT_MS = 120_000;

// The longest delay a timer accepts. A longer delay fires at once, so a larger limit is refused.
const MAX_TIMEOUT_MS = 2_147_483_647;

// How long the result waits for the output of a command that has already exited. The output is complete at once in
// the usual case. The wait matters only when a process that the command started still holds the output open.
const OUTPUT_GRACE_MS = 1_000;

const CMD_CHARACTERS =
  "a double quote, a percent sign, an exclamation mark, an ampersand, a pipe, a less-than sign, " +
  "a greater-than sign, a caret, a line break or a NUL character";

// The characters that cmd.exe cannot carry in an argument. Inside double quotes, a double quote ends the quoted text,
// and a percent sign or an exclamation mark is expanded (the exclamation mark when delayed expansion is on, which a
// registry setting can switch on). An ampersand, a pipe, a less-than sign, a greater-than sign and a caret are
// operators outside quotes, so they are refused rather than trusted to stay inside the quotes. A line break ends the
// command line, and a NUL character ends the text early in the program that receives it.
const CMD_UNSAFE_CHARACTER = /["%!&|<>^\0\r\n]/;

// The system folder of Windows. cmd.exe and taskkill.exe are started by their full paths, so a program of the same
// name in the working folder or on PATH cannot take their place.
const systemProgram = (name: string): string =>
  path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);

// Whether a PATH entry names a whole folder. On Windows that is a path with a drive letter or a network share. A
// rooted entry without a drive letter, such as \tools, depends on the current drive, so it is not used. Elsewhere the
// entry must be an absolute path.
const isAbsoluteEntry = (dir: string): boolean => {
  if (dir === "") {
    return false;
  }
  if (process.platform === "win32") {
    return /^[A-Za-z]:[\\/]/.test(dir) || /^\\\\[^\\/]+[\\/][^\\/]+/.test(dir);
  }
  return path.posix.isAbsolute(dir);
};

// One pair of double quotes around an entry is removed. Windows writes an entry that has a space in quotes, such as
// "C:\Program Files\nodejs", and the quotes are not part of the folder name. Only one pair is removed.
const unquoted = (entry: string): string =>
  entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"') ? entry.slice(1, -1) : entry;

// The PATH entries that name a whole folder, in order. Each entry loses one pair of surrounding quotes first. A relative
// entry would be read from whichever folder the caller is in, so it is skipped. An empty entry is skipped too, because it
// would name the current folder.
const absoluteEntries = (): string[] =>
  (process.env.PATH ?? "").split(path.delimiter).map(unquoted).filter(isAbsoluteEntry);

// A regular file, following a symbolic link. A folder with the same name is not a program.
const isFile = (file: string): boolean => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

// On POSIX a program is a regular file that this user is allowed to run. Other files on PATH are not commands.
const isExecutable = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

// The extensions that Windows runs as programs, in upper case. Without PATHEXT, the fallback list is used.
// The fallback is .COM;.EXE;.BAT;.CMD. That list is shorter than a full Windows PATHEXT, so script types such
// as .VBS are not in it.
const pathExtensions = (): string[] =>
  (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toUpperCase());

// The file names to try for a name in one folder. A name that already ends with one of the extensions is tried as is.
const namesWithExtensions = (name: string, extensions: readonly string[]): string[] => {
  const lower = name.toLowerCase();
  if (extensions.some((ext) => lower.endsWith(ext.toLowerCase()))) {
    return [name];
  }
  return extensions.map((ext) => `${name}${ext.toLowerCase()}`);
};

// The first file that exists, looking through the folders in order and, in each folder, through the names in order.
const firstFile = (dirs: readonly string[], names: readonly string[]): string | undefined => {
  for (const dir of dirs) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (isFile(file)) {
        return file;
      }
    }
  }
  return undefined;
};

// On Windows an .exe is started directly, and a .cmd or .bat shim goes through cmd.exe. Every folder is searched for
// an .exe before any folder is searched for a shim, so an .exe in a later folder wins over a shim in an earlier one.
const resolveOnWindows = (name: string): ResolvedCommand | undefined => {
  const extensions = pathExtensions();
  const dirs = absoluteEntries();
  const exe = firstFile(dirs, namesWithExtensions(name, extensions.filter((ext) => ext === ".EXE")));
  if (exe !== undefined) {
    return { file: exe, viaCmd: false };
  }
  const shimExtensions = [".CMD", ".BAT"].filter((ext) => extensions.includes(ext));
  const shim = firstFile(dirs, namesWithExtensions(name, shimExtensions));
  return shim === undefined ? undefined : { file: shim, viaCmd: true };
};

const resolveOnPosix = (name: string): ResolvedCommand | undefined => {
  for (const dir of absoluteEntries()) {
    const file = path.join(dir, name);
    if (isExecutable(file)) {
      return { file, viaCmd: false };
    }
  }
  return undefined;
};

// Where a command lives, found by reading the PATH entries in order. Nothing is started to find it.
export const resolveCommand = (name: string): ResolvedCommand | undefined =>
  process.platform === "win32" ? resolveOnWindows(name) : resolveOnPosix(name);

export const isPresent = (name: string): boolean => resolveCommand(name) !== undefined;

// Exported for the tests. An argument that cmd.exe cannot carry is refused, and the message does not repeat the
// argument, because an argument can be a secret. An argument that ends with a backslash is refused as well.
export const quoteForCmd = (arg: string): string => {
  if (CMD_UNSAFE_CHARACTER.test(arg)) {
    throw new Error(`An argument has ${CMD_CHARACTERS}, so it cannot be passed through cmd.exe. Nothing was run.`);
  }
  // A backslash before the closing quote is read by the receiving program as an escaped quote, which breaks the
  // arguments after it. This is a .cmd or .bat problem only: an .exe is launched with its arguments quoted by Node.
  if (arg.endsWith("\\")) {
    throw new Error("An argument ends with a backslash, so it cannot be passed through cmd.exe. Nothing was run.");
  }
  return `"${arg}"`;
};

// The file names that a node program can have: node with each extension that Windows runs as a program (PATHEXT).
const nodeFileNames = (): string[] =>
  pathExtensions()
    .filter((ext) => ext !== "")
    .map((ext) => `node${ext.toLowerCase()}`);

// cmd.exe searches the current folder before PATH, unless NoDefaultCurrentDirectoryInExePath is set. An npm shim
// starts node by its bare name when no node program is beside it, so a node file in the folder the shim runs in would
// run in place of the real one. A folder that holds such a file is refused, and so is a folder that cannot be read.
// Only the names are read.
const checkShimFolder = (folder: string): void => {
  let entries: string[];
  try {
    entries = readdirSync(folder);
  } catch {
    throw new Error(
      `The folder ${folder} cannot be read, so it cannot be checked for a node program. Nothing was run.`,
    );
  }
  const names = nodeFileNames();
  const found = entries.find((entry) => names.includes(entry.toLowerCase()));
  if (found !== undefined) {
    throw new Error(
      `The folder ${folder} holds ${found}, and cmd.exe searches that folder before PATH. Nothing was run.`,
    );
  }
};

// A .cmd or .bat file runs through cmd.exe as one quoted command line. With /s, cmd.exe removes the outer pair of
// quotes and runs the rest. /d turns off AutoRun commands but not delayed expansion, which a registry setting can
// switch on. verbatim stops Node from adding its own quotes, which would break the line.
const cmdInvocation = (shim: string, args: readonly string[]): Invocation => {
  if (CMD_UNSAFE_CHARACTER.test(shim)) {
    throw new Error(`The program ${shim} has a character that cmd.exe cannot carry. Nothing was run.`);
  }
  return {
    file: systemProgram("cmd.exe"),
    args: ["/d", "/s", "/c", `"${[shim, ...args].map((arg) => quoteForCmd(arg)).join(" ")}"`],
    verbatim: true,
  };
};

// Ends the command when its time limit passes. On Windows taskkill ends the whole process tree, started by its full
// path. If taskkill cannot be started, the command itself is ended. Elsewhere only the command is ended, with SIGKILL,
// which the command cannot catch. On those systems a grandchild that the command started may outlive the time limit,
// because it is not ended with the command.
const endChild = (child: ChildProcess): void => {
  if (child.pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn(systemProgram("taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.on("error", () => child.kill("SIGKILL"));
      return;
    } catch {
      // A missing taskkill.exe raises an 'error' event, which the listener above handles. This catch runs only for a
      // synchronous throw from spawn, and then the command is ended directly below.
    }
  }
  child.kill("SIGKILL");
};

// Puts a line after the text collected so far, on a line of its own. A line break that already ends the text is not
// doubled.
const appendLine = (text: string, line: string): string =>
  text === "" ? line : `${text.replace(/\r?\n$/, "")}\n${line}`;

// Starts the process and collects its output. Standard input is not connected, so a command that asks a question
// reads end-of-file instead of waiting. The child shares the process group of its caller, so Ctrl+C reaches it. A
// command that is still running when the time limit passes is ended (see endChild), and the result has code 124.
const runChild = (invocation: Invocation, cwd: string | undefined, timeoutMs: number): Promise<CommandResult> =>
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
    let exitCode: number | undefined;
    let settled = false;
    let limit: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    const finish = (result: CommandResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(limit);
      clearTimeout(grace);
      resolve(result);
    };
    limit = setTimeout(() => {
      try {
        endChild(child);
      } catch {
        // Whatever goes wrong while the command is ended, the result is still the timeout.
      }
      finish({ code: 124, stdout, stderr: appendLine(stderr, `timed out after ${timeoutMs / 1000} seconds`) });
    }, timeoutMs);
    // setEncoding keeps a multi-byte character that is split between two chunks whole.
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({ code: 1, stdout, stderr: appendLine(stderr, error.message) });
    });
    child.on("exit", (code) => {
      if (settled) {
        return;
      }
      // The command has ended, so the time limit no longer applies. Its output is waited for only for a grace period.
      exitCode = code ?? 1;
      clearTimeout(limit);
      grace = setTimeout(() => finish({ code: exitCode ?? 1, stdout, stderr }), OUTPUT_GRACE_MS);
    });
    child.on("close", (code) => {
      finish({ code: exitCode ?? code ?? 1, stdout, stderr });
    });
  });

// Runs a command and resolves with its exit code and output. A name that is not on PATH resolves with code 127, the
// code a shell gives for the same case. A command that cannot be started resolves with code 1, and one that is still
// running at its time limit with code 124. A refused call resolves with code 1 and a message that says nothing was
// run, and it does not reject.
export const runCommand: Runner = async (command, args, options = {}) => {
  try {
    // A NUL character cannot be passed to any program, and Node's own error for it would repeat the argument, so it is
    // refused for every command before the lookup. The other characters are checked for a .cmd or .bat file only.
    if (command.includes("\0")) {
      throw new Error("The command name has a NUL character. Nothing was run.");
    }
    if (args.some((arg) => arg.includes("\0"))) {
      throw new Error("An argument has a NUL character, which no program can receive. Nothing was run.");
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error("timeoutMs must be a number of milliseconds from 1 to 2147483647. Nothing was run.");
    }
    const resolved = resolveCommand(command);
    if (!resolved) {
      return { code: 127, stdout: "", stderr: `${command} is not on PATH` };
    }
    // Built before the process starts, so a refused argument or a shim folder that holds a node program starts nothing.
    let invocation: Invocation;
    if (resolved.viaCmd) {
      checkShimFolder(options.cwd ?? process.cwd());
      invocation = cmdInvocation(resolved.file, args);
    } else {
      invocation = { file: resolved.file, args: [...args], verbatim: false };
    }
    return await runChild(invocation, options.cwd, timeoutMs);
  } catch (error) {
    return { code: 1, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
  }
};
