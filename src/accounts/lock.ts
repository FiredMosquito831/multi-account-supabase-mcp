import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";
import path from "node:path";

// The options exist so the tests can run fast. The commands use the defaults.
export type RegistryLockOptions = {
  // How long a call waits for a lock that another call holds, before it gives up.
  waitMs?: number;
  // A lock file older than this was left behind by a call that stopped, so the next call takes it over.
  staleMs?: number;
  // How long a waiting call sleeps between two tries.
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type Settings = {
  waitMs: number;
  staleMs: number;
  pollMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_STALE_MS = 120_000;
const DEFAULT_POLL_MS = 100;

const BUSY_MESSAGE = "Another multi-account-supabase-mcp command is changing the accounts. Try again in a moment.";

const errorCode = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

const sleepFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// Creates the lock file. The open uses flag wx, so it fails when the file already exists, and that is how a second call
// learns that the lock is held. The file holds one line of JSON: a random id and the time. It holds no secret.
// Returns false when the file already exists.
const createLockFile = async (lockPath: string, id: string, now: number): Promise<boolean> => {
  let handle: FileHandle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      return false;
    }
    throw error;
  }
  try {
    await handle.writeFile(`${JSON.stringify({ id, acquiredAt: new Date(now).toISOString() })}\n`, "utf8");
    await handle.close();
  } catch (error) {
    // A file that could not be written is removed, so it does not hold the lock for the next call.
    await handle.close().catch(() => undefined);
    await unlink(lockPath).catch(() => undefined);
    throw error;
  }
  return true;
};

// On Windows, a lock file can be refused for a moment while it is being removed. These errors mean the lock is busy, so
// the call waits for it as it waits for a held lock, and the errors are reported only when the wait runs out.
const isBusyError = (error: unknown): boolean => {
  const code = errorCode(error);
  return code === "EPERM" || code === "EACCES" || code === "EBUSY";
};

// What one try at the lock found. "retry" means the lock file changed, so the try is made again at once.
type Attempt = { outcome: "taken" } | { outcome: "held" } | { outcome: "retry" } | { outcome: "busy"; error: unknown };

const tryOnce = async (lockPath: string, id: string, settings: Settings): Promise<Attempt> => {
  try {
    if (await createLockFile(lockPath, id, settings.now())) {
      return { outcome: "taken" };
    }
  } catch (error) {
    if (!isBusyError(error)) {
      throw error;
    }
    return { outcome: "busy", error };
  }
  let modifiedMs: number;
  try {
    modifiedMs = (await stat(lockPath)).mtimeMs;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      // The holder released the lock between the open and the stat.
      return { outcome: "retry" };
    }
    if (isBusyError(error)) {
      return { outcome: "busy", error };
    }
    throw error;
  }
  if (settings.now() - modifiedMs <= settings.staleMs) {
    return { outcome: "held" };
  }
  // The lock is older than staleMs, so a call that stopped left it behind. It is removed, and the create is tried again.
  try {
    await unlink(lockPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { outcome: "retry" };
    }
    if (isBusyError(error)) {
      return { outcome: "busy", error };
    }
    throw error;
  }
  return { outcome: "retry" };
};

// Takes the lock for this call's id. A held or busy lock is waited for. Once the wait reaches waitMs, the call throws the
// busy message, or the error that kept the lock busy, so a real permission problem is reported as itself.
const acquire = async (lockPath: string, id: string, settings: Settings): Promise<void> => {
  const started = settings.now();
  for (;;) {
    const attempt = await tryOnce(lockPath, id, settings);
    if (attempt.outcome === "taken") {
      return;
    }
    if (attempt.outcome === "retry") {
      continue;
    }
    if (settings.now() - started >= settings.waitMs) {
      throw attempt.outcome === "busy" ? attempt.error : new Error(BUSY_MESSAGE);
    }
    await settings.sleep(settings.pollMs);
  }
};

// The id written in a lock file, or undefined when the text is not one (for example, a file that was created but not
// yet written).
const holderIdOf = (text: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "id" in parsed && typeof parsed.id === "string") {
      return parsed.id;
    }
    return undefined;
  } catch {
    return undefined;
  }
};

// Removes the lock file only when it still holds this call's id. When another call took the lock over as stale, the file
// is that call's, so it is left alone. A failure here is not thrown, so the caller sees the work's own result or error.
// A file that stays behind expires after staleMs.
const releaseLock = async (lockPath: string, id: string): Promise<void> => {
  let text: string;
  try {
    text = await readFile(lockPath, "utf8");
  } catch {
    // The file is gone, so there is nothing left to remove.
    return;
  }
  if (holderIdOf(text) !== id) {
    return;
  }
  try {
    await unlink(lockPath);
  } catch {
    // The file stays until it expires after staleMs. The next call then reports that the accounts are being changed.
  }
};

// Runs work while this call holds the lock for the registry file. The lock file is the registry file's path with ".lock"
// added. The lock is released when the work returns and when it throws.
export const withRegistryLock = async <T>(
  registryFile: string,
  work: () => Promise<T>,
  options: RegistryLockOptions = {},
): Promise<T> => {
  const settings: Settings = {
    waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
    staleMs: options.staleMs ?? DEFAULT_STALE_MS,
    pollMs: options.pollMs ?? DEFAULT_POLL_MS,
    now: options.now ?? (() => Date.now()),
    sleep: options.sleep ?? sleepFor,
  };
  // The folder is made first, as the registry's save does, so the lock file can be created in it.
  await mkdir(path.dirname(registryFile), { recursive: true });
  const lockPath = `${registryFile}.lock`;
  const id = randomUUID();
  await acquire(lockPath, id, settings);
  try {
    return await work();
  } finally {
    await releaseLock(lockPath, id);
  }
};
