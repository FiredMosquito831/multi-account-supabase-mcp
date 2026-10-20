// Throwaway capture of the official Supabase MCP tool list (Plan 1, Task 2).
// Starts the official CLI over stdio with a placeholder token, lists its tools,
// writes them sorted by name to stdout and the count to stderr.
// Run: node scripts/capture-official-tools.mjs > test/fixtures/official-tools.json
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const FEATURES = "docs,account,database,debugging,development,functions,branching,storage,notebooks";
const PLACEHOLDER_TOKEN = "placeholder-not-a-real-token";
const ALLOWED_FROM_PARENT = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP"];

function officialCliPath() {
  const requireFrom = createRequire(import.meta.url);
  const cli = join(dirname(requireFrom.resolve("@supabase/mcp-server-supabase")), "cli.js");
  if (!existsSync(cli)) throw new Error(`official CLI not found: ${cli}`);
  return cli;
}

function childEnvironment() {
  const env = {};
  for (const name of Object.keys(process.env)) {
    if (ALLOWED_FROM_PARENT.includes(name)) env[name] = process.env[name];
  }
  // The SDK merges its default inherited variables under the env it is given.
  // Setting each default that is not allowed to undefined removes it, because Node skips undefined values.
  for (const name of DEFAULT_INHERITED_ENV_VARS) {
    if (!(name in env)) env[name] = undefined;
  }
  env.SUPABASE_ACCESS_TOKEN = PLACEHOLDER_TOKEN;
  return env;
}

async function listAllTools(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor === undefined ? undefined : { cursor });
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return tools;
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [officialCliPath(), "--features", FEATURES],
  env: childEnvironment(),
});
const client = new Client({ name: "capture-official-tools", version: "0.0.0" });
try {
  await client.connect(transport);
  const entries = (await listAllTools(client))
    .map(({ name, description, annotations, inputSchema }) => ({ name, description, annotations, inputSchema }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
  process.stderr.write(`tools: ${entries.length}\n`);
} finally {
  await client.close();
}
