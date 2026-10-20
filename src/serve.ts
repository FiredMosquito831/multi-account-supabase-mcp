import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Registry } from "./accounts/registry.js";
import { ChildPool, TOOL_TIMEOUT_MS } from "./mux/children.js";
import type { StartChild } from "./mux/children.js";
import { startStdioChild } from "./mux/official-child.js";
import { type CallDeps, createServer } from "./mux/server.js";
import type { TokenStore } from "./secrets/token-store.js";

// The inputs of buildCallDeps. start starts one official child. The real start is used unless a caller gives another,
// which only the tests do, so that they can count the starts.
type CallDepsOptions = { registry: Registry; tokens: TokenStore; start?: StartChild };

// Builds what the server needs from the registry and the token store. It starts no child: a child starts on the first
// call that needs its account, and the token is read from the store at that moment.
export function buildCallDeps(options: CallDepsOptions): CallDeps {
  const pool = new ChildPool(options.start ?? startStdioChild, {
    toolTimeoutMs: TOOL_TIMEOUT_MS,
    tokenFor: async (account) => {
      const token = await options.tokens.get(account);
      // Without a stored token no child can start, so the call fails with this message.
      if (token === undefined) {
        throw new Error(`No token is stored for the account "${account}".`);
      }
      return token;
    },
  });
  return {
    registry: async () => options.registry,
    pool,
    // The catalog is read through the pool, which starts one child for it and closes that child again.
    catalog: () => pool.catalog(),
  };
}

// Serves the MCP server over the stdio transport. The promise resolves when the transport closes, which happens when the
// client closes stdin, and the pool's children are closed before it resolves. Nothing is written to stdout here: the SDK
// writes the replies there, and any other text would break the protocol.
export async function serveStdio(deps: CallDeps): Promise<void> {
  const server = createServer(deps);
  const closed = new Promise<void>((resolve) => {
    server.onclose = () => resolve();
  });
  try {
    await server.connect(new StdioServerTransport());
    await closed;
  } finally {
    await deps.pool.closeAll();
  }
}
