import type { CallToolResult } from "@modelcontextprotocol/client";

// The longest a tool call may take. It is the default limit of ChildPool.
export const TOOL_TIMEOUT_MS = 15 * 60_000;

// The token of the placeholder child and the catalog child. It is not a real token.
export const PLACEHOLDER_TOKEN = "placeholder-not-a-real-token";

// Every feature group of the official server.
export const ALL_FEATURES: readonly string[] = [
  "docs",
  "account",
  "database",
  "debugging",
  "development",
  "functions",
  "branching",
  "storage",
  "notebooks",
];

// The names a child may take from the parent environment. Nothing else from the parent is copied.
const INHERITED_NAMES: readonly string[] = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "TEMP", "TMP"];

// The text of a tool call that passes the limit. It does not change with the configured limit.
const NO_ANSWER_MESSAGE = "Supabase did not answer in time (limit: 15 minutes).";

export type OfficialTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean };
};

// One running official server, as the pool sees it.
export interface ChildClient {
  listTools(): Promise<OfficialTool[]>;
  callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult>;
  isAlive(): boolean;
  close(): Promise<void>;
}

// What a child is started for. The features are optional, and ALL_FEATURES is used when they are not given.
export type ChildSpec = {
  account: string | null;
  readOnly: boolean;
  token: string | undefined;
  features?: readonly string[];
};

export type StartChild = (spec: ChildSpec) => Promise<ChildClient>;

// The environment of a child. It holds the allowed names from the parent, and the token when one is given.
export function childEnv(token: string | undefined, parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  // The names come from the parent's own keys, so a name is copied once with the case it has there.
  for (const name of Object.keys(parent)) {
    const value = parent[name];
    if (INHERITED_NAMES.includes(name) && value !== undefined) {
      env[name] = value;
    }
  }
  if (token !== undefined) {
    env.SUPABASE_ACCESS_TOKEN = token;
  }
  return env;
}

// Runs work, and rejects with the fixed message if it has not settled within limitMs. The timer is cleared as soon
// as work settles, so a call that answers in time leaves no timer behind.
async function withLimit<T>(work: () => Promise<T>, limitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(NO_ANSWER_MESSAGE)), limitMs);
  });
  try {
    return await Promise.race([work(), expired]);
  } finally {
    clearTimeout(timer);
  }
}

// Starts the official children for the accounts, the placeholder and the catalog, and keeps each one while it is alive.
// The pool never holds a token. It asks tokenFor for the token of each account child when that child is started.
export class ChildPool {
  private readonly toolTimeoutMs: number;
  // The children by kind and account. An entry is the start itself, so two calls that arrive together share one start.
  private readonly children = new Map<string, Promise<ChildClient>>();

  constructor(
    private readonly start: StartChild,
    private readonly options: { toolTimeoutMs?: number; tokenFor: (account: string) => Promise<string> },
  ) {
    this.toolTimeoutMs = options.toolTimeoutMs ?? TOOL_TIMEOUT_MS;
  }

  read(account: string): Promise<ChildClient> {
    return this.ensure(`read:${account}`, () => this.startAccount(account, true));
  }

  write(account: string): Promise<ChildClient> {
    return this.ensure(`write:${account}`, () => this.startAccount(account, false));
  }

  placeholder(): Promise<ChildClient> {
    return this.ensure("placeholder", async () =>
      this.wrap(await this.start({ account: null, readOnly: false, token: PLACEHOLDER_TOKEN })),
    );
  }

  // Starts a child for the catalog, lists its tools and closes it, also when the listing fails.
  async catalog(): Promise<OfficialTool[]> {
    const child = await this.start({ account: null, readOnly: false, token: PLACEHOLDER_TOKEN });
    try {
      return await child.listTools();
    } finally {
      await child.close();
    }
  }

  async closeAll(): Promise<void> {
    const opened = [...this.children.values()];
    this.children.clear();
    await Promise.all(
      opened.map(async (entry) => {
        // A start that failed has nothing to close.
        const child = await entry.catch(() => undefined);
        await child?.close();
      }),
    );
  }

  private async startAccount(account: string, readOnly: boolean): Promise<ChildClient> {
    const token = await this.options.tokenFor(account);
    // An account child never gets the placeholder. A stored value that equals it is refused before a child starts.
    if (token === PLACEHOLDER_TOKEN) {
      throw new Error(`The stored token for account "${account}" is the placeholder, so no child was started.`);
    }
    return this.wrap(await this.start({ account, readOnly, token }));
  }

  // Returns the child under key while it is alive. Otherwise it starts a new one, and keeps the start under key.
  private async ensure(key: string, open: () => Promise<ChildClient>): Promise<ChildClient> {
    const held = this.children.get(key);
    if (held !== undefined) {
      const current = await held.catch(() => undefined);
      if (current?.isAlive()) {
        return current;
      }
      // While this call waited, another call may have replaced the entry. Then that replacement is used.
      if (this.children.get(key) !== held) {
        return this.ensure(key, open);
      }
    }
    const opening = open();
    this.children.set(key, opening);
    try {
      return await opening;
    } catch (error) {
      // A failed start is not kept, so the next call starts again.
      if (this.children.get(key) === opening) {
        this.children.delete(key);
      }
      throw error;
    }
  }

  // The child that callers get. Its callTool is limited by the pool's own timer as well as by the SDK's timeout.
  // The child gets the smaller of the caller's timeout and the pool's limit, so the SDK's timeout never fires first.
  private wrap(child: ChildClient): ChildClient {
    return {
      listTools: () => child.listTools(),
      callTool: (name, args, timeoutMs) => {
        const limit = Math.min(timeoutMs, this.toolTimeoutMs);
        return withLimit(() => child.callTool(name, args, limit), limit);
      },
      isAlive: () => child.isAlive(),
      close: () => child.close(),
    };
  }
}
