import type { CallToolResult } from "@modelcontextprotocol/client";
import { DEFAULT_INHERITED_ENV_VARS } from "@modelcontextprotocol/client/stdio";

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

// The text of a call that arrives after closeAll. No child is started for it.
const SHUTTING_DOWN_MESSAGE = "The server is shutting down, so no child is started.";

// The texts of a catalog start and a placeholder start that fail. Each one names no account.
const CATALOG_START_FAILED = "The Supabase server for the catalog did not start. Check that the network is reachable.";
const PLACEHOLDER_START_FAILED =
  "The Supabase server for search_docs did not start. Check that the network is reachable.";

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
// Every SDK default name outside the allowlist is set to undefined. The SDK spreads its defaults under the env it is
// given, and Node skips an undefined value, so the spread leaves those names out. On Windows, the spawn adds some
// parent names back when the env lacks them (HOMEDRIVE, HOMEPATH, LOGONSERVER, SYSTEMDRIVE, USERDOMAIN, USERNAME,
// USERPROFILE, WINDIR), so an undefined mark does not remove those.
export function childEnv(token: string | undefined, parent: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const name of DEFAULT_INHERITED_ENV_VARS) {
    if (!INHERITED_NAMES.includes(name)) {
      env[name] = undefined;
    }
  }
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

// Runs work, and rejects with the fixed message if it has not settled within limitMs. When the time runs out, onExpire
// runs before the rejection. The timer is cleared as soon as work settles, so a call that answers in time leaves no
// timer behind.
async function withLimit<T>(work: () => Promise<T>, limitMs: number, onExpire: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onExpire();
      reject(new Error(NO_ANSWER_MESSAGE));
    }, limitMs);
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
  // Set by closeAll. A closed pool starts no child.
  private closed = false;
  // The children by kind and account. An entry is the start itself, so two calls that arrive together share one start.
  private readonly children = new Map<string, Promise<ChildClient>>();
  // The catalog starts, from the moment each one starts until its child is closed. An entry is the start itself, so a
  // catalog start that is still pending is closed too. Whoever takes an entry out of this set closes its child, so each
  // child is closed once: closeAll takes every entry, and catalog() takes its own when its listing ends.
  private readonly catalogStarts = new Set<Promise<ChildClient>>();
  // The closes that a catalog call or a timed-out call started, until each one settles. closeAll waits for them, so a
  // close that is still running is not left open when closeAll returns.
  private readonly pendingCloses = new Set<Promise<void>>();

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

  // The placeholder child serves only search_docs, a read, so it is read-only. The catalog child is not, so that its
  // list holds every tool.
  placeholder(): Promise<ChildClient> {
    return this.ensure("placeholder", () =>
      this.startOrFail({ account: null, readOnly: true, token: PLACEHOLDER_TOKEN }, PLACEHOLDER_START_FAILED),
    );
  }

  // Starts a child for the catalog, lists its tools and closes it, also when the listing fails. A close error is not
  // reported, because the result is the listing. When closeAll has taken the child, closeAll closes it, and this call
  // does not close it again.
  async catalog(): Promise<OfficialTool[]> {
    this.refuseWhenClosed();
    const starting = this.startOrFail(
      { account: null, readOnly: false, token: PLACEHOLDER_TOKEN },
      CATALOG_START_FAILED,
    );
    this.catalogStarts.add(starting);
    let child: ChildClient;
    try {
      child = await starting;
    } catch (error) {
      this.catalogStarts.delete(starting);
      throw error;
    }
    try {
      // A start that finished after closeAll began is closed by closeAll, so no listing starts for it.
      this.refuseWhenClosed();
      return await child.listTools();
    } finally {
      // Only the caller that takes the entry out of the set closes the child. closeAll waits for that close.
      if (this.catalogStarts.delete(starting)) {
        await this.closeTracked(child);
      }
    }
  }

  // Closes the pool. The flag is set first, so no call starts a child from now on. Every start in the map, and every
  // catalog start still in its set, is taken out and closed here, including a start that is still pending. closeAll
  // also waits for the closes that are still running, the ones that a catalog call or a timed-out call started. It
  // throws the first error among the closes that it takes itself, that is, the map entries and the catalog starts it
  // holds. The errors of the closes that catalog() and a timed-out call start are not reported, because their callers
  // already have a result.
  async closeAll(): Promise<void> {
    this.closed = true;
    const opened = [...this.children.values(), ...this.catalogStarts];
    const running = [...this.pendingCloses];
    this.children.clear();
    this.catalogStarts.clear();
    const results = await Promise.allSettled([
      ...opened.map(async (entry) => {
        // A start that failed has nothing to close.
        const child = await entry.catch(() => undefined);
        await child?.close();
      }),
      ...running,
    ]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }

  private async startAccount(account: string, readOnly: boolean): Promise<ChildClient> {
    const token = await this.options.tokenFor(account);
    // The pool may have closed while the token was read. Then no child starts.
    this.refuseWhenClosed();
    // An account child never gets the placeholder. A stored value that equals it is refused before a child starts.
    if (token === PLACEHOLDER_TOKEN) {
      throw new Error(`The stored token for account "${account}" is the placeholder, so no child was started.`);
    }
    try {
      return await this.start({ account, readOnly, token });
    } catch {
      // The start's own error is not attached, because its text is not reviewed for token content.
      throw new Error(
        `The server for account "${account}" did not start. Check that its token is still valid and that the network is reachable.`,
      );
    }
  }

  // Starts a child for the catalog or the placeholder. A failed start gives the given text, with no cause, because the
  // start's own error is not reviewed for token content.
  private async startOrFail(spec: ChildSpec, failedText: string): Promise<ChildClient> {
    try {
      return await this.start(spec);
    } catch {
      throw new Error(failedText);
    }
  }

  // Returns the child under key while it is alive. Otherwise it starts a new one, and keeps the start under key.
  private async ensure(key: string, open: () => Promise<ChildClient>): Promise<ChildClient> {
    this.refuseWhenClosed();
    const held = this.children.get(key);
    if (held !== undefined) {
      const current = await held.catch(() => undefined);
      // The pool may have closed while this call waited. Then the call gets the shutdown message, not a closing child.
      this.refuseWhenClosed();
      if (current?.isAlive()) {
        return current;
      }
      // While this call waited, another call may have replaced the entry. Then that replacement is used.
      if (this.children.get(key) !== held) {
        return this.ensure(key, open);
      }
    }
    // The entry is the start itself. A child that times out finds its entry here, and leaves the pool through it.
    const entry: { start?: Promise<ChildClient> } = {};
    const opening = open().then((child) => this.wrap(child, () => this.forget(key, entry)));
    entry.start = opening;
    this.children.set(key, opening);
    let child: ChildClient;
    try {
      child = await opening;
    } catch (error) {
      // A failed start is not kept, so the next call starts again.
      if (this.children.get(key) === opening) {
        this.children.delete(key);
      }
      throw error;
    }
    // A start that finished after closeAll began is closed by closeAll, so it is not handed out.
    this.refuseWhenClosed();
    return child;
  }

  // A closed pool starts no child. The call that asks for one fails with the shutdown message.
  private refuseWhenClosed(): void {
    if (this.closed) {
      throw new Error(SHUTTING_DOWN_MESSAGE);
    }
  }

  // Removes the entry of a child whose call timed out. It returns true when this call removed the entry, and false when
  // the entry was already gone, because closeAll took it or a later start replaced it.
  private forget(key: string, entry: { start?: Promise<ChildClient> }): boolean {
    if (this.children.get(key) !== entry.start) {
      return false;
    }
    this.children.delete(key);
    return true;
  }

  // Closes a child, and keeps the close in pendingCloses until it settles, so closeAll waits for it.
  // A close error is not reported here, because the caller already has its own result.
  private closeTracked(child: ChildClient): Promise<void> {
    const closing = child.close().catch(() => undefined);
    this.pendingCloses.add(closing);
    void closing.then(() => {
      this.pendingCloses.delete(closing);
    });
    return closing;
  }

  // The child that callers get. Its callTool is limited by the pool's own timer as well as by the SDK's timeout.
  // The child gets the smaller of the caller's timeout and the pool's limit, so the SDK's timeout never fires first.
  // When the pool's timer wins, leave takes the child out of the pool, and the child is closed without waiting for the
  // close, but closeAll still waits for that close. The caller gets the timeout error at once. A child whose entry is
  // already gone is not closed here: closeAll closes the children it took, and a later start replaces only a child that
  // reported that it was not alive.
  private wrap(child: ChildClient, leave: () => boolean): ChildClient {
    return {
      listTools: () => child.listTools(),
      callTool: (name, args, timeoutMs) => {
        const limit = Math.min(timeoutMs, this.toolTimeoutMs);
        return withLimit(() => child.callTool(name, args, limit), limit, () => {
          if (leave()) {
            // The close is tracked, so closeAll waits for it. The caller already has the timeout error.
            void this.closeTracked(child);
          }
        });
      },
      isAlive: () => child.isAlive(),
      close: () => child.close(),
    };
  }
}
