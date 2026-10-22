import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPresent, quoteForCmd, resolveCommand, runCommand } from "../agents/command.js";

const isWindows = process.platform === "win32";
const folders: string[] = [];
const savedVariables = new Map<string, string | undefined>();

// Every folder a test makes is removed when this file's tests have finished.
const makeFolder = (): string => {
  const folder = mkdtempSync(path.join(tmpdir(), "command-test-"));
  folders.push(folder);
  return folder;
};

// The names that point at a home folder, a configuration folder or the data folder. For the whole file, each one
// points at a temporary folder, so no test can read or write the real one.
const folderVariables = [
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "MULTI_ACCOUNT_SUPABASE_HOME",
];

before(() => {
  for (const name of folderVariables) {
    savedVariables.set(name, process.env[name]);
    process.env[name] = makeFolder();
  }
});

after(() => {
  for (const [name, value] of savedVariables) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  for (const folder of folders) {
    rmSync(folder, { recursive: true, force: true });
  }
});

// Sets PATH for one call and then puts back the value it had. On Windows process.env is case-insensitive, so
// this also changes the variable the system spells as Path.
const withPath = async <T>(value: string, body: () => T | Promise<T>): Promise<T> => {
  const saved = process.env.PATH;
  process.env.PATH = value;
  try {
    return await body();
  } finally {
    if (saved === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = saved;
    }
  }
};

// Sets one environment variable for one call, and then puts back the value it had, or removes it when it had none.
const withVariable = async <T>(name: string, value: string | undefined, body: () => T | Promise<T>): Promise<T> => {
  const saved = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    return await body();
  } finally {
    if (saved === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = saved;
    }
  }
};

// quoteForCmd throws this text for an argument it cannot carry through cmd.exe.
const CMD_REFUSAL = /cannot be passed through cmd\.exe/;

// The runner's refusals end with this sentence, so a test can check that a refused call ran nothing.
const REFUSED = /Nothing was run\./;

// The program a test starts as node. On Windows it is the Node binary that runs the tests. Elsewhere a shell script
// named node stands in for it, in a folder of its own, so the test does not depend on the Node binary.
const nodeProgram = (body: string): { folder: string; name: string } => {
  if (isWindows) {
    return { folder: path.dirname(process.execPath), name: path.basename(process.execPath) };
  }
  const folder = makeFolder();
  const file = path.join(folder, "node");
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return { folder, name: "node" };
};

// A .cmd file that writes the arguments it receives to a marker file. Its folder must be on PATH.
const writeMarkerShim = (folder: string, marker: string): void => {
  writeFileSync(path.join(folder, "fake-tool.cmd"), `@echo off\r\necho ARGS[%*] > "${marker}"\r\nexit /b 0\r\n`);
};

// quoteForCmd is exported so these tests can reach the cmd.exe quoting directly. The Windows tests below run the
// cmd.exe checks through runCommand, with a .cmd file on PATH.
test("quoteForCmd refuses an argument with a double quote, and its message does not repeat the argument", () => {
  assert.throws(
    () => quoteForCmd('hunter"2'),
    (error: unknown) => error instanceof Error && CMD_REFUSAL.test(error.message) && !error.message.includes("hunter"),
  );
});

for (const [label, arg] of [
  ["a percent sign", "100%"],
  ["an exclamation mark", "wow!"],
  ["a carriage return", "first\rsecond"],
  ["a line feed", "first\nsecond"],
  ["a NUL character", "first\0second"],
  ["an ampersand", "a&b"],
  ["a pipe", "a|b"],
  ["a less-than sign", "a<b"],
  ["a greater-than sign", "a>b"],
  ["a caret", "a^b"],
] as const) {
  test(`quoteForCmd refuses an argument with ${label}`, () => {
    assert.throws(() => quoteForCmd(arg), CMD_REFUSAL);
  });
}

test("quoteForCmd refuses an argument that ends with a backslash", () => {
  assert.throws(() => quoteForCmd("C:\\"), /ends with a backslash/);
});

test("quoteForCmd wraps an argument with spaces in one pair of quotes", () => {
  assert.equal(quoteForCmd("C:\\Program Files\\tool.cmd"), '"C:\\Program Files\\tool.cmd"');
});

test("a name that is not on PATH resolves with code 127 and says so", async () => {
  const name = "multi-account-no-such-command";
  await withPath(makeFolder(), async () => {
    assert.equal(resolveCommand(name), undefined);
    assert.equal(isPresent(name), false);
    assert.deepEqual(await runCommand(name, []), {
      code: 127,
      stdout: "",
      stderr: `${name} is not on PATH`,
    });
  });
});

test(
  "resolveCommand finds an executable file on PATH",
  { skip: isWindows ? "Windows finds programs by PATHEXT, so the POSIX execute-bit lookup is not used here" : false },
  async () => {
    const folder = makeFolder();
    const file = path.join(folder, "node");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    // The mode given to writeFileSync is reduced by the umask, so the execute bits are set again here.
    chmodSync(file, 0o755);
    await withPath(folder, () => {
      assert.deepEqual(resolveCommand("node"), { file, viaCmd: false });
    });
  },
);

test(
  "on POSIX, a file without the execute bit is not a command",
  { skip: isWindows ? "POSIX only: Windows does not use the execute bit" : false },
  async () => {
    const folder = makeFolder();
    const file = path.join(folder, "node");
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    chmodSync(file, 0o644);
    await withPath(folder, async () => {
      assert.equal(resolveCommand("node"), undefined);
      assert.equal((await runCommand("node", [])).code, 127);
    });
  },
);

test("a PATH entry wrapped in double quotes is searched, so a program in that folder is found, even when the folder name has a space", async () => {
  const dir = path.join(makeFolder(), "Program Files");
  mkdirSync(dir);
  const file = path.join(dir, isWindows ? "tool.exe" : "tool");
  writeFileSync(file, isWindows ? "placeholder\r\n" : "#!/bin/sh\nexit 0\n");
  // The mode given to writeFileSync is reduced by the umask, so the execute bits are set again here.
  chmodSync(file, 0o755);
  // Windows writes an entry that has a space in double quotes, such as "C:\Program Files\nodejs".
  await withPath(`"${dir}"`, () => {
    assert.deepEqual(resolveCommand("tool"), { file, viaCmd: false });
  });
});

test("an unquoted PATH entry is searched, as before, with or without a space in its name", async () => {
  const dir = path.join(makeFolder(), "Program Files");
  mkdirSync(dir);
  const file = path.join(dir, isWindows ? "tool.exe" : "tool");
  writeFileSync(file, isWindows ? "placeholder\r\n" : "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  await withPath(dir, () => {
    assert.deepEqual(resolveCommand("tool"), { file, viaCmd: false });
  });
});

test("an empty PATH entry, or an empty pair of quotes, names no folder, and the folders around it are still searched", async () => {
  const folder = makeFolder();
  const dir = path.join(folder, "bin");
  mkdirSync(dir);
  const program = isWindows ? "tool.exe" : "tool";
  const file = path.join(dir, program);
  writeFileSync(file, isWindows ? "placeholder\r\n" : "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  // A copy of the program sits in the working folder, which an empty entry would name, so it must not be found.
  const inWorkingFolder = path.join(folder, program);
  writeFileSync(inWorkingFolder, isWindows ? "placeholder\r\n" : "#!/bin/sh\nexit 0\n");
  chmodSync(inWorkingFolder, 0o755);
  const saved = process.cwd();
  process.chdir(folder);
  try {
    await withPath('""', () => {
      assert.equal(resolveCommand("tool"), undefined);
    });
    await withPath(`${path.delimiter}""${path.delimiter}${dir}`, () => {
      assert.deepEqual(resolveCommand("tool"), { file, viaCmd: false });
    });
  } finally {
    process.chdir(saved);
  }
});

test("a relative PATH entry is not used", async () => {
  const project = makeFolder();
  const bin = path.join(project, "bin");
  mkdirSync(bin);
  const file = path.join(bin, isWindows ? "node.exe" : "node");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  // The relative entry "bin" names this folder only from the project folder, so the working folder is the project.
  const saved = process.cwd();
  process.chdir(project);
  try {
    await withPath("bin", async () => {
      assert.equal(resolveCommand("node"), undefined);
      assert.equal((await runCommand("node", [])).code, 127);
    });
  } finally {
    process.chdir(saved);
  }
});

test(
  "on Windows, an .exe in a later folder wins over a shim in an earlier folder, and a shim alone is found",
  { skip: isWindows ? false : "Windows only: the .exe and shim order is a Windows rule" },
  async () => {
    const shimFolder = makeFolder();
    const exeFolder = makeFolder();
    writeFileSync(path.join(shimFolder, "tool.cmd"), "@echo off\r\n");
    writeFileSync(path.join(exeFolder, "tool.exe"), "placeholder\r\n");
    await withPath(`${shimFolder};${exeFolder}`, () => {
      assert.deepEqual(resolveCommand("tool"), { file: path.join(exeFolder, "tool.exe"), viaCmd: false });
    });
    await withPath(shimFolder, () => {
      assert.deepEqual(resolveCommand("tool"), { file: path.join(shimFolder, "tool.cmd"), viaCmd: true });
    });
  },
);

test(
  "on Windows, an argument with an ampersand is refused for a .cmd file before anything runs",
  { skip: isWindows ? false : "Windows only: this runs a .cmd file through cmd.exe" },
  async () => {
    const folder = makeFolder();
    const marker = path.join(folder, "marker.txt");
    writeMarkerShim(folder, marker);
    await withPath(folder, async () => {
      const result = await runCommand("fake-tool", ["a&b"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, REFUSED);
      assert.equal(existsSync(marker), false);
    });
  },
);

test("a program that is not a .cmd or .bat file receives an argument with an ampersand", async () => {
  const program = nodeProgram('printf "%s" "$1"');
  const args = isWindows ? ["-e", "process.stdout.write(process.argv[1])", "a&b"] : ["a&b"];
  await withPath(program.folder, async () => {
    assert.deepEqual(await runCommand(program.name, args), { code: 0, stdout: "a&b", stderr: "" });
  });
});

test("a NUL character in an argument resolves with code 1, and the promise does not reject", async () => {
  const program = nodeProgram("exit 0");
  await withPath(program.folder, async () => {
    const result = await runCommand(program.name, ["first\0second"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, REFUSED);
  });
});

test("a NUL character in the command name resolves with code 1, and the promise does not reject", async () => {
  const result = await runCommand("multi\0account", []);
  assert.equal(result.code, 1);
  assert.match(result.stderr, REFUSED);
});

test(
  "on Windows, a .cmd file on PATH runs with a normal argument and writes its marker",
  { skip: isWindows ? false : "Windows only: this runs a .cmd file through cmd.exe" },
  async () => {
    const folder = makeFolder();
    const marker = path.join(folder, "marker.txt");
    writeMarkerShim(folder, marker);
    await withPath(folder, async () => {
      const result = await runCommand("fake-tool", ["plain"]);
      assert.equal(result.code, 0);
      assert.equal(readFileSync(marker, "utf8").trim(), 'ARGS["plain"]');
    });
  },
);

test(
  "on Windows, an argument with a double quote writes no marker and returns code 1",
  { skip: isWindows ? false : "Windows only: this runs a .cmd file through cmd.exe" },
  async () => {
    const folder = makeFolder();
    const marker = path.join(folder, "marker.txt");
    writeMarkerShim(folder, marker);
    await withPath(folder, async () => {
      const result = await runCommand("fake-tool", ['say "hi"']);
      assert.equal(result.code, 1);
      assert.match(result.stderr, REFUSED);
      assert.equal(existsSync(marker), false);
    });
  },
);

test(
  "on Windows, a .cmd file is refused when its folder holds a node program, and nothing runs",
  { skip: isWindows ? false : "Windows only: this runs a .cmd file through cmd.exe" },
  async () => {
    const shimFolder = makeFolder();
    const workFolder = makeFolder();
    const toolMarker = path.join(workFolder, "tool-ran.txt");
    const nodeMarker = path.join(workFolder, "node-ran.txt");
    // The shim starts node by its bare name, as an npm shim does when no node program is beside it.
    writeFileSync(path.join(shimFolder, "fake-tool.cmd"), `@echo off\r\nnode\r\necho ran > "${toolMarker}"\r\n`);
    writeFileSync(path.join(workFolder, "node.cmd"), `@echo off\r\necho ran > "${nodeMarker}"\r\n`);
    await withPath(shimFolder, async () => {
      const result = await runCommand("fake-tool", [], { cwd: workFolder });
      assert.equal(result.code, 1);
      assert.match(result.stderr, /node\.cmd/);
      assert.match(result.stderr, REFUSED);
      assert.equal(existsSync(nodeMarker), false);
      assert.equal(existsSync(toolMarker), false);
    });
  },
);

test(
  "on Windows, a .cmd file is refused when its folder holds node.vbs, and nothing runs",
  { skip: isWindows ? false : "Windows only: this runs a .cmd file through cmd.exe" },
  async () => {
    const shimFolder = makeFolder();
    const workFolder = makeFolder();
    const toolMarker = path.join(workFolder, "tool-ran.txt");
    writeFileSync(path.join(shimFolder, "fake-tool.cmd"), `@echo off\r\nnode\r\necho ran > "${toolMarker}"\r\n`);
    // A VBScript file is a program for cmd.exe, because .VBS is in PATHEXT. The file holds a comment only.
    writeFileSync(
      path.join(workFolder, "node.vbs"),
      "' Holds nothing. The test checks that this folder is refused.\r\n",
    );
    // cmd.exe searches the working folder only when NoDefaultCurrentDirectoryInExePath is not set, and this machine
    // sets it. The variable is removed for this call, so the search that the check guards against is on.
    await withVariable("NoDefaultCurrentDirectoryInExePath", undefined, () =>
      withPath(shimFolder, async () => {
        const result = await runCommand("fake-tool", [], { cwd: workFolder });
        assert.equal(result.code, 1);
        assert.match(result.stderr, /node\.vbs/);
        assert.match(result.stderr, REFUSED);
        assert.equal(existsSync(toolMarker), false);
      }),
    );
  },
);

test("the home, configuration and data variables point at temporary folders", () => {
  for (const name of folderVariables) {
    const value = process.env[name];
    assert.ok(value !== undefined && value.startsWith(tmpdir()), `${name} is not a temporary folder`);
  }
});

test("runCommand resolves with the exit code and both output streams of a real process", async () => {
  const script = "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3;";
  const program = nodeProgram("printf out; printf err >&2; exit 3");
  // On Windows the Node binary runs the script. Elsewhere the stand-in ignores its arguments and prints the same text.
  const args = isWindows ? ["-e", script] : [];
  await withPath(program.folder, async () => {
    assert.deepEqual(await runCommand(program.name, args), { code: 3, stdout: "out", stderr: "err" });
  });
});

test("a command that outlives timeoutMs is ended, and the result is code 124 with the limit in seconds", async () => {
  const folder = makeFolder();
  const started = path.join(folder, "started.txt");
  const late = path.join(folder, "late.txt");
  // The stand-in records that it started, then writes the late marker five seconds later, unless it has been ended.
  // On POSIX only the stand-in is ended, and its wait runs in the foreground, so the marker is never written. A
  // grandchild that it started may still run after the timeout, but it writes nothing. On Windows the Node binary waits
  // the same way, and taskkill ends it. The function form is used, because an arrow function has a greater-than
  // sign. A greater-than sign is refused only in an argument to a .cmd or .bat command, and this test runs node.exe
  // directly, so the form is a precaution.
  const program = nodeProgram(`echo started > "${started}"\n/bin/sleep 5\necho late > "${late}"`);
  const script =
    "require('fs').writeFileSync(process.argv[1], 'started');" +
    " setTimeout(function () { require('fs').writeFileSync(process.argv[2], 'late'); }, 5000);";
  const args = isWindows ? ["-e", script, started, late] : [];
  await withPath(program.folder, async () => {
    const result = await runCommand(program.name, args, { timeoutMs: 3000 });
    assert.equal(result.code, 124);
    assert.equal(result.stderr, "timed out after 3 seconds");
    // Wait past the time the command needs to write the late marker, to show that it was ended.
    await new Promise((resolve) => setTimeout(resolve, 6000));
    assert.equal(existsSync(started), true, "the command did not start, so the timeout ended nothing");
    assert.equal(existsSync(late), false, "the command kept running after its timeout");
  });
});

test("a command that exits while a process it started still holds its output keeps its own result", async () => {
  if (isWindows) {
    // The shim prints and exits. A process that it starts with start /b keeps the output pipe open past the time limit.
    // ping is called by its full path, because the test sets PATH to the shim's folder alone.
    const folder = makeFolder();
    writeFileSync(
      path.join(folder, "fake-tool.cmd"),
      "@echo off\r\necho done\r\nstart /b %SystemRoot%\\System32\\ping.exe -n 8 127.0.0.1\r\n",
    );
    await withPath(folder, async () => {
      const result = await runCommand("fake-tool", [], { timeoutMs: 6000 });
      assert.equal(result.code, 0);
      assert.ok(result.stdout.startsWith("done"), "the output of the command is missing");
    });
    return;
  }
  // The stand-in prints and exits at once. A background sleep holds the output open past the time limit.
  const program = nodeProgram("/bin/sleep 8 &\nprintf done");
  await withPath(program.folder, async () => {
    assert.deepEqual(await runCommand(program.name, [], { timeoutMs: 4000 }), { code: 0, stdout: "done", stderr: "" });
  });
});

test("a timeout is reported after the error text that the command wrote", async () => {
  const program = nodeProgram("printf 'oops\\n' >&2\n/bin/sleep 8");
  const args = isWindows ? ["-e", "process.stderr.write('oops\\n'); setTimeout(function () {}, 8000)"] : [];
  await withPath(program.folder, async () => {
    const result = await runCommand(program.name, args, { timeoutMs: 3000 });
    assert.equal(result.code, 124);
    assert.equal(result.stderr, "oops\ntimed out after 3 seconds");
  });
});

test(
  "on Windows, a .cmd file is refused an argument that ends with a backslash, and nothing runs",
  { skip: isWindows ? false : "Windows only: this runs a .cmd file through cmd.exe" },
  async () => {
    const folder = makeFolder();
    const marker = path.join(folder, "marker.txt");
    writeMarkerShim(folder, marker);
    await withPath(folder, async () => {
      const result = await runCommand("fake-tool", ["C:\\"]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /ends with a backslash/);
      assert.equal(existsSync(marker), false);
    });
  },
);

test(
  "on Windows, a .cmd file in a folder whose name has a space runs with its arguments",
  { skip: isWindows ? false : "Windows only: this runs a .cmd file through cmd.exe" },
  async () => {
    const folder = path.join(makeFolder(), "a folder");
    mkdirSync(folder);
    const marker = path.join(folder, "marker.txt");
    writeMarkerShim(folder, marker);
    await withPath(folder, async () => {
      const result = await runCommand("fake-tool", ["plain"]);
      assert.equal(result.code, 0);
      assert.equal(readFileSync(marker, "utf8").trim(), 'ARGS["plain"]');
    });
  },
);

test(
  "on Windows, a PATH entry without a drive letter is not used",
  { skip: isWindows ? false : "Windows only: a PATH entry without a drive letter is a Windows form" },
  async () => {
    const folder = makeFolder();
    const bin = path.join(folder, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "node.exe"), "placeholder\r\n");
    // The process moves to the folder's drive, so an entry without a drive letter reaches the same folder.
    const saved = process.cwd();
    process.chdir(folder);
    try {
      await withPath(bin.slice(2), () => {
        assert.equal(resolveCommand("node"), undefined);
      });
    } finally {
      process.chdir(saved);
    }
  },
);

test(
  "on Windows, a process that the command started is ended with it at the time limit",
  { skip: isWindows ? false : "Windows only: taskkill ends the whole process tree", timeout: 30000 },
  async () => {
    const folder = makeFolder();
    // The shim starts a process with start /b. That process records that it started, and then writes late.txt about six
    // seconds later, unless it has been ended. The shim waits in the foreground, so the time limit ends it. The started
    // process is ended only when taskkill ends the whole process tree. ping is called by its full path, because the
    // test sets PATH to the shim's folder alone.
    const inner =
      "echo started > started.txt & %SystemRoot%\\System32\\ping.exe -n 7 127.0.0.1 > nul & echo late > late.txt";
    writeFileSync(
      path.join(folder, "fake-tool.cmd"),
      `@echo off\r\nstart /b cmd /c "${inner}"\r\n%SystemRoot%\\System32\\ping.exe -n 30 127.0.0.1 > nul\r\n`,
    );
    await withPath(folder, async () => {
      const result = await runCommand("fake-tool", [], { cwd: folder, timeoutMs: 4000 });
      assert.equal(result.code, 124);
      await new Promise((resolve) => setTimeout(resolve, 6000));
      const started = path.join(folder, "started.txt");
      assert.equal(existsSync(started), true, "the started process did not start before the limit");
      assert.equal(existsSync(path.join(folder, "late.txt")), false, "a process the command started kept running");
    });
  },
);

test(
  "on Windows, a .cmd file in a folder whose path has an ampersand is refused, and the message names the file",
  { skip: isWindows ? false : "Windows only: this runs a .cmd file through cmd.exe" },
  async () => {
    const folder = path.join(makeFolder(), "R&D");
    mkdirSync(folder);
    const marker = path.join(folder, "marker.txt");
    writeMarkerShim(folder, marker);
    await withPath(folder, async () => {
      const result = await runCommand("fake-tool", ["plain"]);
      assert.equal(result.code, 1);
      assert.ok(result.stderr.includes(path.join(folder, "fake-tool.cmd")), "the message does not name the file");
      assert.match(result.stderr, REFUSED);
      assert.equal(existsSync(marker), false);
    });
  },
);

test("a timeoutMs that is not a positive number of milliseconds is refused, and nothing runs", async () => {
  for (const timeoutMs of [0, -5, Number.NaN, 2147483648]) {
    const result = await runCommand("multi-account-no-such-command", [], { timeoutMs });
    assert.equal(result.code, 1);
    assert.match(result.stderr, REFUSED);
  }
});
