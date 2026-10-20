import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import type { Tool } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { readPackageVersion } from "../version.js";
import { ALL_FEATURES, childEnv } from "./children.js";
import type { ChildClient, ChildSpec, OfficialTool } from "./children.js";

// The official server's CLI, cli.js. It sits beside the package's main entry, dist/index.cjs.
export function officialCliPath(): string {
  const requireFromHere = createRequire(import.meta.url);
  const cli = join(dirname(requireFromHere.resolve("@supabase/mcp-server-supabase")), "cli.js");
  if (!existsSync(cli)) {
    throw new Error(`The official Supabase CLI was not found at ${cli}.`);
  }
  return cli;
}

function toOfficialTool(tool: Tool): OfficialTool {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  };
}

// Starts the official server as a child process, with the environment from childEnv, and connects an MCP client to it
// over stdio. The child is alive until its process exits or close() is called.
export async function startStdioChild(spec: ChildSpec): Promise<ChildClient> {
  const cliArgs = [officialCliPath()];
  if (spec.readOnly) {
    cliArgs.push("--read-only");
  }
  cliArgs.push("--features", (spec.features ?? ALL_FEATURES).join(","));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: cliArgs,
    // The undefined entries are meant to keep the SDK default names out. The SDK spreads its defaults under this env,
    // and Node skips an undefined value. The SDK's type does not allow undefined, so the cast is at this boundary only.
    // childEnv has the Windows limit.
    env: childEnv(spec.token, process.env) as Record<string, string>,
  });
  const client = new Client({
    name: "multi-account-supabase-mcp",
    version: readPackageVersion(fileURLToPath(new URL("../../package.json", import.meta.url))),
  });
  let alive = true;
  client.onclose = () => {
    alive = false;
  };
  try {
    await client.connect(transport);
  } catch (error) {
    // A child that did not connect must not keep running.
    await client.close().catch(() => undefined);
    throw error;
  }
  return {
    async listTools() {
      const tools: OfficialTool[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor === undefined ? undefined : { cursor });
        tools.push(...page.tools.map(toOfficialTool));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return tools;
    },
    // The timeout is the SDK's request timeout, in milliseconds.
    callTool: (name, args, timeoutMs) => client.callTool({ name, arguments: args }, { timeout: timeoutMs }),
    isAlive: () => alive,
    async close() {
      alive = false;
      await client.close();
    },
  };
}
