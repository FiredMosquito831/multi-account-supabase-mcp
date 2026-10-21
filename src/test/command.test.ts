import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPresent, quoteForCmd, resolveCommand, runCommand } from "../agents/command.js";

const isWindows = process.platform === "win32";
const folders: string[] = [];

// Every folder a test makes is removed when this file's tests have finished.
const makeFolder = (): string => {
  const folder = mkdtempSync(path.join(tmpdir(), "command-test-"));
  folders.push(folder);
  return folder;
};

after(() => {
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

const CMD_REFUSAL = /cannot be passed through cmd\.exe/;

// quoteForCmd is exported so these tests can reach the cmd.exe quoting without a Windows shim. runCommand only
// takes the cmd.exe path for a .cmd or .bat file, and that path is checked here through the same function.
test("quoteForCmd refuses an argument with a double quote, and its message does not repeat the argument", () => {
  assert.throws(
    () => quoteForCmd('hunter"2'),
    (error: unknown) =>
      error instanceof Error && CMD_REFUSAL.test(error.message) && !error.message.includes("hunter"),
  );
});

for (const [label, arg] of [
  ["a percent sign", "100%"],
  ["an exclamation mark", "wow!"],
  ["a carriage return", "first\rsecond"],
  ["a line feed", "first\nsecond"],
] as const) {
  test(`quoteForCmd refuses an argument with ${label}`, () => {
    assert.throws(() => quoteForCmd(arg), CMD_REFUSAL);
  });
}

test("quoteForCmd wraps an argument with spaces in one pair of quotes", () => {
  assert.equal(quoteForCmd("C:\\Program Files\\tool.cmd"), '"C:\\Program Files\\tool.cmd"');
  // Inside double quotes cmd.exe reads these characters as plain text.
  assert.equal(quoteForCmd("a&b|c^d<e>f"), '"a&b|c^d<e>f"');
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
  { skip: isWindows ? "Windows finds commands with where.exe, so this POSIX PATH walk is not used here" : false },
  async () => {
    const folder = makeFolder();
    const name = "multi-account-fake-tool";
    const file = path.join(folder, name);
    writeFileSync(file, "#!/bin/sh\nexit 0\n");
    // The mode given to writeFileSync is reduced by the umask, so the execute bits are set again here.
    chmodSync(file, 0o755);
    await withPath(folder, () => {
      assert.deepEqual(resolveCommand(name), { file, viaCmd: false });
    });
  },
);

test("runCommand resolves with the exit code and both output streams of a real process", async () => {
  // The folder of the running Node binary is put on PATH, so the binary is found by name, as an agent CLI would be.
  const script = "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 3;";
  await withPath(path.dirname(process.execPath), async () => {
    const result = await runCommand(path.basename(process.execPath), ["-e", script]);
    assert.deepEqual(result, { code: 3, stdout: "out", stderr: "err" });
  });
});
