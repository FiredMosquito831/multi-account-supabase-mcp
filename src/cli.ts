#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { Registry } from "./accounts/registry.js";
import { dataFolder } from "./paths.js";
import { type CliIo, runCli } from "./run.js";
import { readSecretFrom } from "./secret-input.js";
import type { TokenStore } from "./secrets/token-store.js";
import { type FetchLike, fetchProfile } from "./supabase/api.js";

// The identity check is the only network call in the add flow. It is bounded, so a hang cannot stall the add.
const IDENTITY_CHECK_TIMEOUT_MS = 30_000;
const boundedFetch: FetchLike = (url, init) =>
  fetch(url, { ...init, signal: AbortSignal.timeout(IDENTITY_CHECK_TIMEOUT_MS) });

// Writes the prompt, then reads the token with hidden input. The reader writes the newline that ends the prompt line.
const readSecret = (): Promise<string> => {
  process.stderr.write("Token (input is hidden, press Enter when done): ");
  return readSecretFrom(process.stdin, process.stderr);
};

// Loads the registry once, then serves the MCP server over stdio until the client closes stdin. The server module is
// loaded here, so the other commands never load the MCP SDK. The registry is read only at this start. So an account added
// while the server runs is not used until the server restarts, and a removed account's running child keeps its token until
// the server restarts.
const serveFromRegistryFile = async (registryFile: string, tokens: TokenStore): Promise<void> => {
  const { buildCallDeps, serveStdio } = await import("./serve.js");
  const registry = await Registry.load(registryFile);
  await serveStdio(buildCallDeps({ registry, tokens }));
};

// Builds the real streams and stores, then runs the command. The token store is loaded inside the try, as the server
// is, so a failure to load it prints its message with the Error prefix and exits with 1, and no stack trace is shown.
// The imports at the top of this file load before main runs, and a failure in those is not covered. In serve mode
// stdout carries the protocol, so every log goes to stderr. The exit code is set, not forced, so a running server keeps
// the process alive.
const main = async (): Promise<void> => {
  try {
    const { KeyringTokenStore } = await import("./secrets/token-store.js");
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
};

void main();
