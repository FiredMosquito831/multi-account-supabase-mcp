#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { Registry } from "./accounts/registry.js";
import { dataFolder } from "./paths.js";
import { type CliIo, runCli } from "./run.js";
import { buildCallDeps, serveStdio } from "./serve.js";
import { KeyringTokenStore, type TokenStore } from "./secrets/token-store.js";
import { type FetchLike, fetchProfile } from "./supabase/api.js";

// The identity check is the only network call in the add flow. It is bounded, so a hang cannot stall the add.
const IDENTITY_CHECK_TIMEOUT_MS = 30_000;
const boundedFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(IDENTITY_CHECK_TIMEOUT_MS) });

// Reads keys until Enter. Nothing is echoed. Backspace removes one character. Ctrl+C rejects with "Cancelled.",
// and so does a closed input, so the add never waits forever.
const readUntilEnter = (stdin: NodeJS.ReadStream): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    let typed = "";
    const stop = (): void => {
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
    };
    const onEnd = (): void => {
      stop();
      reject(new Error("Cancelled."));
    };
    const onData = (chunk: Buffer | string): void => {
      const text = String(chunk);
      // Escape sequences, such as the arrow keys, are ignored, so none of their characters reach the token.
      if (text.startsWith("\u001b")) {
        return;
      }
      for (const key of text) {
        if (key === "\r" || key === "\n") {
          stop();
          resolve(typed);
          return;
        }
        if (key === "\u0003") {
          stop();
          reject(new Error("Cancelled."));
          return;
        }
        if (key === "\u007f" || key === "\b") {
          typed = [...typed].slice(0, -1).join("");
        } else if (key >= " ") {
          typed += key;
        }
      }
    };
    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });

// Reads the token with hidden input. Raw mode is on only while the keys are read, and it is restored in a
// finally, so a failed read leaves the terminal as it was.
const readSecret = async (): Promise<string> => {
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  process.stderr.write("Token (input is hidden, press Enter when done): ");
  stdin.setRawMode(true);
  try {
    return await readUntilEnter(stdin);
  } finally {
    stdin.setRawMode(wasRaw);
    stdin.pause();
    process.stderr.write("\n");
  }
};

// Loads the registry once, then serves the MCP server over stdio until the client closes stdin. The registry is not read
// again during the session, so an account added while the server runs is not used until the server restarts.
const serveFromRegistryFile = async (registryFile: string, tokens: TokenStore): Promise<void> => {
  const registry = await Registry.load(registryFile);
  await serveStdio(buildCallDeps({ registry, tokens }));
};

// Builds the real streams and stores, then runs the command. In serve mode stdout carries the protocol, so every log
// goes to stderr. The exit code is set, not forced, so a running server keeps the process alive.
const main = async (): Promise<void> => {
  const registryFile = path.join(dataFolder(process.env, process.platform, os.homedir()), "accounts.json");
  const tokens = new KeyringTokenStore();
  const io: CliIo = {
    stdout: (text) => {
      process.stdout.write(`${text}\n`);
    },
    stderr: (text) => {
      process.stderr.write(`${text}\n`);
    },
    stdinIsTerminal: process.stdin.isTTY === true,
    stdoutIsTerminal: process.stdout.isTTY === true,
    readSecret,
    registryFile,
    tokens,
    fetchProfile: (token) => fetchProfile(token, boundedFetch),
    addedAt: () => new Date().toISOString(),
    serve: () => serveFromRegistryFile(registryFile, tokens),
  };
  process.exitCode = await runCli(process.argv.slice(2), io);
};

void main();
