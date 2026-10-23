import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

// This file runs from dist/test, so two levels up is the repository root.
const LAUNCHER_URL = new URL("../../plugins/multi-account-supabase/bin/launch.mjs", import.meta.url);
const LAUNCHER_PATH = fileURLToPath(LAUNCHER_URL);
const PLUGIN_ROOT = fileURLToPath(new URL("../../plugins/multi-account-supabase/", import.meta.url));
const THIS_TEST_FILE = fileURLToPath(import.meta.url);
const PACKAGE = "multi-account-supabase-mcp";
const REFUSAL = `${PACKAGE}: refused an argument with spaces or shell characters. Use plain words.\n`;
const COULD_NOT_START_NPX = `${PACKAGE} could not start: npx was not found on PATH. Node.js and npm must be installed.\n`;
const SIGNALS = ["SIGINT", "SIGTERM"] as const;
const WINDOWS = process.platform === "win32";
// The forms that write to stdout or the console, as text. The launcher's file must match none of them.
const STDOUT_PATTERN = /process\.stdout|process\[|console[.\[]|writeSync\(\s*1/;

type SpawnOptions = { stdio?: string; cwd?: string; shell?: boolean };
type SpawnCall = { command: string; args: string[] | undefined; options: SpawnOptions };

type Deps = {
  argv: string[];
  cwd: string;
  windows: boolean;
  pluginRoot: string;
  isOnPath: (name: string) => boolean;
  spawn: (command: string, ...rest: unknown[]) => FakeChild;
  stderr: { write: (text: string) => boolean };
  tmpdir: string;
  readPackageName: (dir: string) => string | undefined;
};

type Launcher = {
  PACKAGE: string;
  SAFE_ARGUMENT: RegExp;
  unsafeArgument: (args: string[]) => string | undefined;
  pluginVersion: (pluginRoot: string) => string;
  launchPlan: (input: { version: string | undefined; onPath: boolean; windows: boolean; args: string[] }) => {
    command: string;
    args: string[];
    shell: boolean;
  };
  npxDirectory: (cwd: string, packageName: string | undefined, neutral: string) => string;
  samePath: (a: string, b: string, windows: boolean) => boolean;
  isEntryFile: (argv1: string | undefined, moduleFile: string, windows: boolean) => boolean;
  run: (deps: Deps) => Promise<number>;
};

class FakeChild extends EventEmitter {
  readonly killed: string[] = [];
  kill(signal?: string): boolean {
    this.killed.push(String(signal));
    return true;
  }
}

// The launcher module is loaded per test, so a missing file fails each test that needs it.
const load = (): Promise<Launcher> => import(LAUNCHER_URL.href);

// Every dependency is a fake. Nothing runs npx, starts a server or reads the owner's files.
const harness = (overrides: Partial<Deps> = {}) => {
  const calls: SpawnCall[] = [];
  const stderr: string[] = [];
  const child = new FakeChild();
  const deps: Deps = {
    argv: [],
    cwd: "/work/project",
    windows: false,
    pluginRoot: PLUGIN_ROOT,
    isOnPath: () => true,
    spawn: (command, ...rest) => {
      const options = rest[rest.length - 1] as SpawnOptions;
      const args = rest.length === 2 ? (rest[0] as string[]) : undefined;
      calls.push({ command, args, options });
      return child;
    },
    stderr: {
      write: (text) => {
        stderr.push(text);
        return true;
      },
    },
    tmpdir: "/neutral",
    readPackageName: () => "some-other-project",
    ...overrides,
  };
  return { deps, calls, stderr, child };
};

const onlyNpx = (name: string) => name === "npx";
const listenerCounts = () => SIGNALS.map((signal) => process.listenerCount(signal));

test("with no argument, the installed command runs serve", async () => {
  const { run } = await load();
  const { deps, calls, child } = harness({ isOnPath: () => true });
  const done = run(deps);
  child.emit("exit", 0, null);
  assert.equal(await done, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, PACKAGE);
  assert.deepEqual(calls[0].args, ["serve"]);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.notEqual(calls[0].options.shell, true);
});

test("with arguments, the installed command runs them and no shell is used", async () => {
  const { run } = await load();
  const { deps, calls, child } = harness({ argv: ["doctor"], isOnPath: () => true });
  const done = run(deps);
  child.emit("exit", 0, null);
  await done;
  assert.equal(calls[0].command, PACKAGE);
  assert.deepEqual(calls[0].args, ["doctor"]);
  assert.notEqual(calls[0].options.shell, true);
});

// The literal is updated on each version bump, so a bump fails this test on purpose.
test("the plugin version read from the real plugin.json is 0.1.0, as the file is written now", async () => {
  const { pluginVersion } = await load();
  assert.equal(pluginVersion(PLUGIN_ROOT), "0.1.0");
});

// A plugin folder whose plugin.json holds the given text. The caller removes it with cleanup().
const tempPluginRoot = (manifest: string) => {
  const base = mkdtempSync(join(tmpdir(), "launcher-test-"));
  mkdirSync(join(base, ".claude-plugin"), { recursive: true });
  writeFileSync(join(base, ".claude-plugin", "plugin.json"), manifest);
  return { root: base, cleanup: () => rmSync(base, { recursive: true, force: true }) };
};

const NO_VALID_VERSION = `${PACKAGE} could not start: plugin.json has no valid version. Reinstall the plugin.\n`;

test("pluginVersion accepts a semantic version and refuses anything else, naming only the file", async () => {
  const { pluginVersion } = await load();
  for (const good of ["0.1.0", "10.20.30", "0.2.0-rc.1", "1.0.0-alpha-2"]) {
    const { root, cleanup } = tempPluginRoot(JSON.stringify({ version: good }));
    try {
      assert.equal(pluginVersion(root), good);
    } finally {
      cleanup();
    }
  }
  for (const bad of ["0.1", "0.1.0 & calc", "v0.1.0", "0.1.0;x", "0.1.0\n", "0.1.0+build", "", " 0.1.0", 42, undefined]) {
    const { root, cleanup } = tempPluginRoot(JSON.stringify({ version: bad }));
    try {
      assert.throws(
        () => pluginVersion(root),
        (error: Error) => error.message === "plugin.json has no valid version" && !error.message.includes(root),
        `refuse ${JSON.stringify(bad)}`,
      );
    } finally {
      cleanup();
    }
  }
});

test("a plugin.json without a version: the npx route exits 1, spawns nothing, and names only the file", async () => {
  const { run } = await load();
  const { root, cleanup } = tempPluginRoot(JSON.stringify({ name: "multi-account-supabase" }));
  try {
    const { deps, calls, stderr, child } = harness({ pluginRoot: root, isOnPath: () => false });
    const done = run(deps);
    // Under the bug this resolves with 0 after a spawn of multi-account-supabase-mcp@undefined.
    child.emit("exit", 0, null);
    assert.equal(await done, 1);
    assert.equal(calls.length, 0);
    assert.deepEqual(stderr, [NO_VALID_VERSION]);
  } finally {
    cleanup();
  }
});

test("a plugin.json without a version does not affect the installed-command route", async () => {
  const { run } = await load();
  const { root, cleanup } = tempPluginRoot(JSON.stringify({ name: "multi-account-supabase" }));
  try {
    const { deps, calls, child } = harness({ pluginRoot: root, isOnPath: () => true });
    const done = run(deps);
    child.emit("exit", 0, null);
    assert.equal(await done, 0);
    assert.equal(calls[0].command, PACKAGE);
    assert.deepEqual(calls[0].args, ["serve"]);
  } finally {
    cleanup();
  }
});

test("a version with shell characters is refused on Windows, with one line naming the file, and nothing is spawned", async () => {
  const { run } = await load();
  const { root, cleanup } = tempPluginRoot(JSON.stringify({ version: "0.1.0 & calc" }));
  try {
    const { deps, calls, stderr, child } = harness({ pluginRoot: root, windows: true, argv: ["doctor"], isOnPath: onlyNpx });
    const done = run(deps);
    child.emit("exit", 0, null);
    assert.equal(await done, 1);
    assert.equal(calls.length, 0);
    assert.deepEqual(stderr, [NO_VALID_VERSION]);
  } finally {
    cleanup();
  }
});

test("a plain semantic version passes, and npx gets it", async () => {
  const { run } = await load();
  const { root, cleanup } = tempPluginRoot(JSON.stringify({ version: "0.1.0" }));
  try {
    const { deps, calls, child } = harness({ pluginRoot: root, windows: true, argv: ["doctor"], isOnPath: onlyNpx });
    const done = run(deps);
    child.emit("exit", 0, null);
    assert.equal(await done, 0);
    assert.equal(calls[0].command, `npx -y ${PACKAGE}@0.1.0 doctor`);
  } finally {
    cleanup();
  }
});

test("without the installed command, npx runs the same version as the plugin", async () => {
  const { run, pluginVersion } = await load();
  const version = pluginVersion(PLUGIN_ROOT);
  const { deps, calls, child } = harness({ argv: ["list"], isOnPath: () => false });
  const done = run(deps);
  child.emit("exit", 0, null);
  await done;
  assert.equal(calls[0].command, "npx");
  assert.deepEqual(calls[0].args, ["-y", `${PACKAGE}@${version}`, "list"]);
  assert.notEqual(calls[0].options.shell, true);
});

test("on Windows, the installed command runs through one shell string", async () => {
  const { run } = await load();
  const { deps, calls, child } = harness({ argv: ["list"], windows: true, isOnPath: () => true });
  const done = run(deps);
  child.emit("exit", 0, null);
  await done;
  assert.equal(calls[0].command, `${PACKAGE} list`);
  assert.equal(calls[0].args, undefined);
  assert.equal(calls[0].options.shell, true);
});

test("on Windows, the installed command runs without checking for npx", async () => {
  const { run } = await load();
  const { deps, calls, child } = harness({ argv: ["list"], windows: true, isOnPath: (name) => name === PACKAGE });
  const done = run(deps);
  child.emit("exit", 0, null);
  assert.equal(await done, 0);
  assert.equal(calls[0].command, `${PACKAGE} list`);
});

test("on Windows, npx runs the plugin version through one shell string", async () => {
  const { run, pluginVersion } = await load();
  const version = pluginVersion(PLUGIN_ROOT);
  const { deps, calls, child } = harness({ argv: ["doctor"], windows: true, isOnPath: onlyNpx });
  const done = run(deps);
  child.emit("exit", 0, null);
  await done;
  assert.equal(calls[0].command, `npx -y ${PACKAGE}@${version} doctor`);
  assert.equal(calls[0].args, undefined);
  assert.equal(calls[0].options.shell, true);
});

test("on Windows, when npx is not on PATH, one line is printed, exit code 1, and nothing is spawned", async () => {
  const { run } = await load();
  const { deps, calls, stderr, child } = harness({ argv: ["serve"], windows: true, isOnPath: () => false });
  const done = run(deps);
  // Under the bug this resolves with 0 after a spawn, and the assertions below fail. Nothing hangs.
  child.emit("exit", 0, null);
  assert.equal(await done, 1);
  assert.equal(calls.length, 0);
  assert.deepEqual(stderr, [COULD_NOT_START_NPX]);
});

test("an unreadable plugin.json does not block the installed-command route", async () => {
  const { run } = await load();
  const base = mkdtempSync(join(tmpdir(), "launcher-test-"));
  try {
    const { deps, calls, child } = harness({ pluginRoot: base, isOnPath: () => true });
    const done = run(deps);
    child.emit("exit", 0, null);
    assert.equal(await done, 0);
    assert.equal(calls[0].command, PACKAGE);
    assert.deepEqual(calls[0].args, ["serve"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an argument with a space or a shell character is refused before anything runs, and is not printed", async () => {
  const { run } = await load();
  const realExit = process.exit;
  process.exit = (() => {
    throw new Error("process.exit must not be called by run");
  }) as typeof process.exit;
  try {
    for (const bad of ["a b", "x;y", "list&calc", "$HOME", 'a"b', ""]) {
      const { deps, calls, stderr } = harness({ argv: ["list", bad] });
      assert.equal(await run(deps), 2, `exit code for ${JSON.stringify(bad)}`);
      assert.equal(calls.length, 0, `no spawn for ${JSON.stringify(bad)}`);
      assert.deepEqual(stderr, [REFUSAL]);
      if (bad !== "") {
        assert.equal(stderr.join("").includes(bad), false, "the refused argument is not printed");
      }
    }
  } finally {
    process.exit = realExit;
  }
});

test("the child's exit code is the launcher's exit code", async () => {
  const { run } = await load();
  const { deps, child } = harness();
  const done = run(deps);
  child.emit("exit", 3, null);
  assert.equal(await done, 3);
});

test("a child that ends by a signal gives exit code 1", async () => {
  const { run } = await load();
  const { deps, child } = harness();
  const done = run(deps);
  child.emit("exit", null, "SIGTERM");
  assert.equal(await done, 1);
});

test("SIGINT and SIGTERM are forwarded to the child, and the listeners are removed when it exits", async () => {
  const { run } = await load();
  const before = listenerCounts();
  const { deps, child } = harness();
  const done = run(deps);
  process.emit("SIGINT");
  process.emit("SIGTERM");
  assert.deepEqual(child.killed, ["SIGINT", "SIGTERM"]);
  child.emit("exit", 0, null);
  assert.equal(await done, 0);
  assert.deepEqual(listenerCounts(), before);
});

test("a spawn error gives one stderr line and exit code 1, and removes the listeners", async () => {
  const { run } = await load();
  const before = listenerCounts();
  const { deps, stderr, child } = harness();
  const done = run(deps);
  child.emit("error", new Error("spawn npx ENOENT"));
  assert.equal(await done, 1);
  assert.deepEqual(stderr, [`${PACKAGE} could not start: spawn npx ENOENT. Node.js and npm must be installed.\n`]);
  assert.deepEqual(listenerCounts(), before);
});

test("a spawn that throws at once gives one stderr line and exit code 1", async () => {
  const { run } = await load();
  const { deps, stderr, calls } = harness({
    spawn: () => {
      throw new Error("spawn EINVAL");
    },
  });
  assert.equal(await run(deps), 1);
  assert.equal(calls.length, 0);
  assert.deepEqual(stderr, [`${PACKAGE} could not start: spawn EINVAL. Node.js and npm must be installed.\n`]);
});

test("a plugin folder with no readable version gives exit code 1 and starts nothing on the npx route", async () => {
  const { run } = await load();
  const base = mkdtempSync(join(tmpdir(), "launcher-test-"));
  try {
    const { deps, stderr, calls } = harness({ pluginRoot: base, isOnPath: () => false });
    assert.equal(await run(deps), 1);
    assert.equal(calls.length, 0);
    assert.equal(stderr.length, 1);
    assert.ok(stderr[0].startsWith(`${PACKAGE} could not start:`));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a plugin folder with a space in its path is read, and npx gets its version", async () => {
  const { run, pluginVersion } = await load();
  const base = mkdtempSync(join(tmpdir(), "launcher-test-"));
  try {
    const root = join(base, "a b");
    mkdirSync(join(root, ".claude-plugin"), { recursive: true });
    writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify({ version: "1.2.3" }));
    assert.equal(pluginVersion(root), "1.2.3");
    const { deps, calls, child } = harness({ pluginRoot: root, isOnPath: () => false });
    const done = run(deps);
    child.emit("exit", 0, null);
    await done;
    assert.deepEqual(calls[0].args, ["-y", `${PACKAGE}@1.2.3`, "serve"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the child runs in the neutral folder when the current folder is this package", async () => {
  const { run } = await load();
  const { deps, calls, child } = harness({ readPackageName: () => PACKAGE, tmpdir: "/neutral" });
  const done = run(deps);
  child.emit("exit", 0, null);
  await done;
  assert.equal(calls[0].options.cwd, "/neutral");
});

test("the child runs in the current folder for any other package", async () => {
  const { run } = await load();
  const { deps, calls, child } = harness({ cwd: "/work/project", readPackageName: () => "other" });
  const done = run(deps);
  child.emit("exit", 0, null);
  await done;
  assert.equal(calls[0].options.cwd, "/work/project");
});

test("npxDirectory returns the neutral folder only for this package", async () => {
  const { npxDirectory } = await load();
  assert.equal(npxDirectory("/repo", PACKAGE, "/neutral"), "/neutral");
  assert.equal(npxDirectory("/repo", "other", "/neutral"), "/repo");
  assert.equal(npxDirectory("/repo", undefined, "/neutral"), "/repo");
});

test("launchPlan for npx puts the version it is given after -y", async () => {
  const { launchPlan } = await load();
  assert.deepEqual(launchPlan({ version: "9.8.7", onPath: false, windows: false, args: ["list"] }), {
    command: "npx",
    args: ["-y", `${PACKAGE}@9.8.7`, "list"],
    shell: false,
  });
});

test("launchPlan uses the installed command, with the arguments, when it is on PATH", async () => {
  const { launchPlan } = await load();
  assert.deepEqual(launchPlan({ version: undefined, onPath: true, windows: true, args: ["serve"] }), {
    command: PACKAGE,
    args: ["serve"],
    shell: true,
  });
});

test("unsafeArgument accepts plain words and refuses every other character", async () => {
  const { unsafeArgument, SAFE_ARGUMENT } = await load();
  assert.equal(unsafeArgument(["serve", "a-b_c.d@e:f=g,h/i\\j+k", "Z9"]), undefined);
  assert.equal(SAFE_ARGUMENT.test("a-b_c.d@e:f=g,h/i\\j+k"), true);
  for (const bad of ['"', "'", "$", "&", "|", "<", ">", "%", "^", "(", ")", "!", "`", "*", "?", ";", "#", "{", "}", "[", "]", "~", " ", "\t", "\n", ""]) {
    assert.equal(unsafeArgument(["ok", bad]), bad, `refuse ${JSON.stringify(bad)}`);
  }
});

test("samePath ignores case only on Windows", async () => {
  const { samePath } = await load();
  const upper = "C:\\Work\\Plugin\\bin\\launch.mjs";
  const lower = "c:\\work\\plugin\\bin\\launch.mjs";
  assert.equal(samePath(upper, lower, true), true);
  assert.equal(samePath(upper, lower, false), false);
  assert.equal(samePath(upper, upper, true), true);
  assert.equal(samePath(upper, upper, false), true);
});

test("isEntryFile is true for this file, also through a path that is not normalised", async () => {
  const { isEntryFile } = await load();
  // String concatenation keeps the ".." parts. join() would remove them, and the test would prove nothing.
  const unnormalised = dirname(LAUNCHER_PATH) + sep + ".." + sep + "bin" + sep + "launch.mjs";
  assert.notEqual(unnormalised, normalize(unnormalised));
  assert.equal(isEntryFile(LAUNCHER_PATH, LAUNCHER_PATH, WINDOWS), true);
  assert.equal(isEntryFile(unnormalised, LAUNCHER_PATH, WINDOWS), true);
});

test("isEntryFile is false for another file and for no path", async () => {
  const { isEntryFile } = await load();
  assert.equal(isEntryFile(THIS_TEST_FILE, LAUNCHER_PATH, WINDOWS), false);
  assert.equal(isEntryFile(undefined, LAUNCHER_PATH, WINDOWS), false);
});

test("isEntryFile follows a symlink to this file", { skip: WINDOWS ? "symlinks may need a Windows privilege" : false }, async () => {
  const { isEntryFile } = await load();
  const base = mkdtempSync(join(tmpdir(), "launcher-test-"));
  try {
    const link = join(base, "launch-link.mjs");
    symlinkSync(LAUNCHER_PATH, link);
    assert.equal(isEntryFile(link, LAUNCHER_PATH, false), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("isEntryFile matches a drive letter written in the other case, on Windows", { skip: WINDOWS ? false : "Windows only" }, async () => {
  const { isEntryFile } = await load();
  const flipped = LAUNCHER_PATH.replace(/^([A-Za-z]):/, (_, drive: string) => `${drive === drive.toLowerCase() ? drive.toUpperCase() : drive.toLowerCase()}:`);
  assert.notEqual(flipped, LAUNCHER_PATH);
  assert.equal(isEntryFile(flipped, LAUNCHER_PATH, true), true);
});

test("the stdout pattern catches each form that writes to stdout or the console", () => {
  for (const sample of [
    "process.stdout.write('x')",
    "process['stdout'].write('x')",
    'process["stdout"].write("x")',
    "console.log('x')",
    "console.info('x')",
    "console['log']('x')",
    "fs.writeSync(1, 'x')",
    "fs.writeSync( 1, 'x')",
  ]) {
    assert.equal(STDOUT_PATTERN.test(sample), true, sample);
  }
  for (const other of ["process.stderr.write('x')", "fs.writeSync(2, 'x')", "const stdout = 1"]) {
    assert.equal(STDOUT_PATTERN.test(other), false, other);
  }
});

test("the launcher file contains no match for the stdout pattern", () => {
  const text = readFileSync(LAUNCHER_PATH, "utf8");
  assert.equal(STDOUT_PATTERN.test(text), false, "launch.mjs has a form that writes to stdout or the console");
});

test("the entry point ends by setting the exit code, not by calling process.exit", () => {
  const text = readFileSync(LAUNCHER_PATH, "utf8");
  assert.equal(/process\.exit\(/.test(text), false, "launch.mjs calls process.exit");
  assert.match(text, /process\.exitCode = code;/);
});
