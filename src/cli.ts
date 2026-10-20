#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { dataFolder } from "./paths.js";
import { type CliIo, runCli } from "./run.js";
import { KeyringTokenStore } from "./secrets/token-store.js";
import { type FetchLike, fetchProfile } from "./supabase/api.js";

// The identity check is the only network call in the add flow. It is bounded, so a hang cannot stall the add (R21).
const IDENTITY_CHECK_TIMEOUT_MS = 30_000;
const boundedFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(IDENTITY_CHECK_TIMEOUT_MS) });

// Reads keys until Enter (R41). Nothing is echoed. Backspace removes one character. Ctrl+C rejects with "Cancelled.",
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

// Reads the token with hidden input (R41). Raw mode is on only while the keys are read, and it is restored in a
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

// Task 14 replaces this stub with the stdio server (R4). Until then, serve fails with this message.
const serve = async (): Promise<void> => {
  throw new Error("serve is wired in Task 14.");
};

// Builds the real streams and stores, then runs the command. In serve mode stdout carries the protocol, so every log
// goes to stderr. The exit code is set, not forced, so a running server keeps the process alive.
const main = async (): Promise<void> => {
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
    registryFile: path.join(dataFolder(process.env, process.platform, os.homedir()), "accounts.json"),
    tokens: new KeyringTokenStore(),
    fetchProfile: (token) => fetchProfile(token, boundedFetch),
    addedAt: () => new Date().toISOString(),
    serve,
  };
  process.exitCode = await runCli(process.argv.slice(2), io);
};

void main();
