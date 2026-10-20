import type { Transport } from "@modelcontextprotocol/server";
import { serveStdio as sdkServeStdio, StdioServerTransport } from "@modelcontextprotocol/server/stdio";
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
      // An empty value is not a token, so it counts as missing, and no child starts.
      if (token === undefined || token === "") {
        throw new Error(
          `No token is stored for the account "${account}". Run multi-account-supabase-mcp remove ${account}, then add the account again with --pat in a terminal.`,
        );
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

// Serves the MCP server over the transport in options, or over stdio when none is given. The SDK's helper picks the
// protocol era from the first message. It returns a handle at once, and it does not wait for the transport to close, so
// the promise here resolves when the transport closes. That happens when the client closes stdin, or when the other end of
// a given transport closes. The pool's children are closed before the promise resolves. Nothing is written to stdout here.
export async function serveStdio(deps: CallDeps, options?: { transport?: Transport }): Promise<void> {
  const transport = options?.transport ?? new StdioServerTransport();
  const handle = sdkServeStdio(() => createServer(deps), { transport });
  // The helper has set its own onclose on the transport. This hook runs after it, then resolves the promise.
  const closed = new Promise<void>((resolve) => {
    const onSdkClose = transport.onclose;
    transport.onclose = () => {
      onSdkClose?.();
      resolve();
    };
  });
  try {
    await closed;
  } finally {
    await handle.close();
    await deps.pool.closeAll();
  }
}
