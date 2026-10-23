#!/usr/bin/env node
// Runs multi-account-supabase-mcp for the Claude Code plugin.
//
// With no arguments it starts the MCP server (`serve`), which is how .mcp.json uses it. With arguments it runs that
// CLI command, which is how the plugin's slash commands use it (for example `list` or `doctor`).
//
// If the command is on PATH (npm install -g multi-account-supabase-mcp), it is used, whatever its version: the launcher
// does not compare it with the plugin's version. Otherwise the plugin's version is run from npm with npx. The server
// speaks MCP on stdout, so this file never writes to stdout. It writes its own messages to stderr only.
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE = 'multi-account-supabase-mcp';

// On Windows the command goes through a shell, where spaces and characters such as ; & | < > % " ' are special. So
// only plain words are allowed, and the check runs before anything is spawned. Account names and the options the
// commands use all fit this pattern.
export const SAFE_ARGUMENT = /^[A-Za-z0-9._@:=,/\\+-]+$/;

const SIGNALS = ['SIGINT', 'SIGTERM'];

// The first argument that is not a plain word, or undefined when all of them are.
export const unsafeArgument = (args) => args.find((arg) => !SAFE_ARGUMENT.test(arg));

// The plugin version is the package version. The tests check that the plugin, the package and the marketplace agree.
// The version goes into the npx argument and, on Windows, into a shell string, so it must be a plain semantic version
// (for example 0.1.0 or 0.2.0-rc.1). The errors name the file only, never its content or its path.
export const SEMVER = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;

export const pluginVersion = (pluginRoot) => {
  let version;
  try {
    version = JSON.parse(readFileSync(path.join(pluginRoot, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  } catch {
    throw new Error('plugin.json cannot be read');
  }
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    throw new Error('plugin.json has no valid version');
  }
  return version;
};

// What to run: the installed command when it is on PATH, otherwise npx with the same version.
export const launchPlan = ({ version, onPath, windows, args }) => ({
  command: onPath ? PACKAGE : 'npx',
  args: onPath ? args : ['-y', `${PACKAGE}@${version}`, ...args],
  shell: windows,
});

// npx run inside this package's own folder finds that local copy first, which has no command shim, and fails.
// In that folder npx runs from a neutral folder instead. Any other folder is used as it is.
export const npxDirectory = (cwd, packageName, neutral) => (packageName === PACKAGE ? neutral : cwd);

// Two paths name the same file. On Windows the comparison ignores case: a drive letter or a folder can be written in
// either case and still name one file.
export const samePath = (a, b, windows) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);

// True when the script Node was asked to run is this file. Both paths are resolved first, through symlinks,
// junctions and Windows short names, by the operating system (realpathSync.native). A path that cannot be resolved
// is not this file.
export const isEntryFile = (argv1, moduleFile, windows) => {
  if (!argv1) return false;
  try {
    return samePath(realpathSync.native(argv1), realpathSync.native(moduleFile), windows);
  } catch {
    return false;
  }
};

const isOnPathNow = (name, windows) =>
  spawnSync(windows ? 'where' : 'which', [name], { stdio: 'ignore' }).status === 0;

const packageNameIn = (dir) => {
  try {
    return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).name;
  } catch {
    return undefined;
  }
};

const messageOf = (error) => (error instanceof Error ? error.message : String(error));

const couldNotStart = (reason) =>
  `${PACKAGE} could not start: ${reason}. Node.js and npm must be installed.\n`;

// Runs the launch and resolves with the exit code. It never calls process.exit, so a test can run it with fakes.
export const run = async (deps) => {
  const cliArgs = deps.argv.length > 0 ? deps.argv : ['serve'];

  const refused = unsafeArgument(cliArgs);
  if (refused !== undefined) {
    // The refused argument is not printed, because a token could have been typed there by mistake.
    deps.stderr.write(`${PACKAGE}: refused an argument with spaces or shell characters. Use plain words.\n`);
    return 2;
  }

  const onPath = deps.isOnPath(PACKAGE);
  let version;
  // The installed command needs no plugin version. The npx route needs one, so the version is read only there.
  if (!onPath) {
    // On Windows the command runs through cmd.exe. cmd prints its own line when npx is missing and gives no spawn
    // error, so npx is checked here first.
    if (deps.windows && !deps.isOnPath('npx')) {
      deps.stderr.write(couldNotStart('npx was not found on PATH'));
      return 1;
    }
    try {
      version = pluginVersion(deps.pluginRoot);
    } catch (error) {
      deps.stderr.write(`${PACKAGE} could not start: ${messageOf(error)}. Reinstall the plugin.\n`);
      return 1;
    }
  }

  const plan = launchPlan({ version, onPath, windows: deps.windows, args: cliArgs });
  const cwd = npxDirectory(deps.cwd, deps.readPackageName(deps.cwd), deps.tmpdir);
  const options = { stdio: 'inherit', cwd };

  return new Promise((resolve) => {
    let child;
    try {
      // Through a shell, the command is one string. The arguments and the version were checked above, so joining them
      // is safe.
      child = plan.shell
        ? deps.spawn([plan.command, ...plan.args].join(' '), { ...options, shell: true })
        : deps.spawn(plan.command, plan.args, options);
    } catch (error) {
      deps.stderr.write(couldNotStart(messageOf(error)));
      resolve(1);
      return;
    }

    // Claude Code stops the server with a signal. Pass it on, so the server can close its children.
    // On Windows the signal reaches cmd.exe, not the server, so through this launcher the server cannot close its
    // account children there.
    const forwards = SIGNALS.map((signal) => [signal, () => child.kill(signal)]);
    const finish = (code) => {
      for (const [signal, forward] of forwards) process.off(signal, forward);
      resolve(code);
    };
    for (const [signal, forward] of forwards) process.on(signal, forward);

    child.on('error', (error) => {
      deps.stderr.write(couldNotStart(messageOf(error)));
      finish(1);
    });
    // A child that ends by a signal has no exit code, and counts as a failure.
    child.on('exit', (code) => finish(code ?? 1));
  });
};

// Runs only when this file is the one Node was asked to run, not when a test imports it.
const windows = process.platform === 'win32';
if (isEntryFile(process.argv[1], fileURLToPath(import.meta.url), windows)) {
  run({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    windows,
    pluginRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '..'),
    isOnPath: (name) => isOnPathNow(name, windows),
    spawn,
    stderr: process.stderr,
    tmpdir: os.tmpdir(),
    readPackageName: packageNameIn,
  }).then((code) => {
    // The exit code is set, not passed to exit, so that stderr can finish writing before the process ends.
    process.exitCode = code;
  });
}
