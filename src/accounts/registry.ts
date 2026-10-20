import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { assertValidName } from "./names.js";

// One account, as accounts.json holds it. Metadata only: a token never goes into this file.
export type AccountRecord = {
  name: string;
  email: string;
  gotrueId: string;
  added: "pat";
  addedAt: string;
};

type FileContents = { default: string | null; accounts: AccountRecord[] };

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`The account field "${field}" must be a non-empty string.`);
  }
  return value;
};

// Keeps the five fields and nothing else, so no other value (a token, say) can reach the file.
// The name goes through assertValidName, so add shows the owner the name rule's own message.
const toRecord = (value: unknown): AccountRecord => {
  if (typeof value !== "object" || value === null) {
    throw new Error("An account must be an object.");
  }
  const fields = value as Record<string, unknown>;
  const rawName = fields.name;
  if (typeof rawName !== "string") {
    throw new Error('The account field "name" must be a string.');
  }
  const name = assertValidName(rawName);
  if (fields.added !== "pat") {
    throw new Error(`The account "${name}" has an unknown "added" value.`);
  }
  return {
    name,
    email: nonEmpty(fields.email, "email"),
    gotrueId: nonEmpty(fields.gotrueId, "gotrueId"),
    added: "pat",
    addedAt: nonEmpty(fields.addedAt, "addedAt"),
  };
};

// Checks the whole parsed file before anything is kept. Any wrong shape throws, and load turns that into one fixed reason.
const checkContents = (data: unknown): FileContents => {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("The file does not hold a JSON object.");
  }
  const fields = data as Record<string, unknown>;
  const defaultName = fields.default;
  if (defaultName !== null && typeof defaultName !== "string") {
    throw new Error('The "default" value must be an account name or null.');
  }
  if (!Array.isArray(fields.accounts)) {
    throw new Error('The "accounts" value must be an array.');
  }
  const accounts: AccountRecord[] = fields.accounts.map(toRecord);
  if (new Set(accounts.map((account) => account.name)).size !== accounts.length) {
    throw new Error("Two accounts have the same name.");
  }
  if (new Set(accounts.map((account) => account.gotrueId)).size !== accounts.length) {
    throw new Error("Two accounts are the same Supabase user.");
  }
  if (defaultName !== null && !accounts.some((account) => account.name === defaultName)) {
    throw new Error('The "default" value names no account.');
  }
  return { default: defaultName, accounts };
};

// The one message for a file that cannot be read or has the wrong shape. The reason is a system error code or a fixed
// phrase. The file's text never reaches the message, and no cause is kept, because a parser error can quote the text.
const corrupt = (file: string, reason: string): Error =>
  new Error(`accounts.json cannot be read, so it was not changed: ${file} (${reason})`);

// The reason for a file that cannot be read: the system error code (for example EACCES), or a fixed phrase without one.
const readReason = (error: unknown): string => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" ? code : "read failed";
};

// Callers get copies, so they can change the registry only through add, remove and setDefault.
const copyOf = (account: AccountRecord | undefined): AccountRecord | undefined =>
  account === undefined ? undefined : { ...account };

// The rename and the wait that save uses. Only tests change this object. Its defaults are the real fs rename and a real
// timer.
export const saveHooks: {
  rename: (from: string, to: string) => Promise<void>;
  wait: (ms: number) => Promise<void>;
} = {
  rename,
  wait: (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms)),
};

const RENAME_TRIES = 10;
const RENAME_WAIT_MS = 100;

// On Windows, a rename can be refused for a moment while another process has the file open. These three codes mean that.
// No other error is retried.
const isRefusedRename = (error: unknown): boolean => {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
};

// Renames temp over file. A refused rename waits RENAME_WAIT_MS and is tried again, up to RENAME_TRIES tries in all. Any
// other error is thrown at once. When every try is refused, the last error is thrown.
const renameWithRetry = async (temp: string, file: string): Promise<void> => {
  let tries = 0;
  for (;;) {
    tries += 1;
    try {
      await saveHooks.rename(temp, file);
      return;
    } catch (error) {
      if (tries >= RENAME_TRIES || !isRefusedRename(error)) {
        throw error;
      }
    }
    await saveHooks.wait(RENAME_WAIT_MS);
  }
};

export class Registry {
  private constructor(
    private readonly file: string,
    private defaultAccount: string | null,
    private readonly accounts: AccountRecord[],
  ) {}

  // A missing file is an empty registry. A file that cannot be read or has the wrong shape throws.
  // load only reads the file, so a refused file is left exactly as it was.
  static async load(file: string): Promise<Registry> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return new Registry(file, null, []);
      }
      throw corrupt(file, readReason(error));
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw corrupt(file, "not valid JSON");
    }
    let contents: FileContents;
    try {
      contents = checkContents(data);
    } catch {
      throw corrupt(file, "unexpected contents");
    }
    return new Registry(file, contents.default, contents.accounts);
  }

  list(): AccountRecord[] {
    return this.accounts.map((account) => ({ ...account }));
  }

  names(): string[] {
    return this.accounts.map((account) => account.name);
  }

  defaultName(): string | null {
    return this.defaultAccount;
  }

  get(name: string): AccountRecord | undefined {
    return copyOf(this.accounts.find((account) => account.name === name));
  }

  findByGotrueId(id: string): AccountRecord | undefined {
    return copyOf(this.accounts.find((account) => account.gotrueId === id));
  }

  add(record: AccountRecord): void {
    const account = toRecord(record);
    if (this.accounts.some((existing) => existing.name === account.name)) {
      throw new Error(`An account named "${account.name}" already exists. Remove it first to replace it.`);
    }
    const sameUser = this.accounts.find((existing) => existing.gotrueId === account.gotrueId);
    if (sameUser) {
      throw new Error(`This Supabase user is already added as "${sameUser.name}".`);
    }
    // The first account added to an empty registry becomes the default. A later add leaves the default as it is.
    const wasEmpty = this.accounts.length === 0;
    this.accounts.push(account);
    if (wasEmpty) {
      this.defaultAccount = account.name;
    }
  }

  // Removing the default leaves no default. Nothing else takes its place.
  remove(name: string): AccountRecord | undefined {
    const index = this.accounts.findIndex((account) => account.name === name);
    if (index === -1) {
      return undefined;
    }
    const [removed] = this.accounts.splice(index, 1);
    if (this.defaultAccount === name) {
      this.defaultAccount = null;
    }
    return removed;
  }

  setDefault(name: string): void {
    if (!this.accounts.some((account) => account.name === name)) {
      throw new Error(`No account named "${name}".`);
    }
    this.defaultAccount = name;
  }

  // Writes a temporary file of its own, syncs it, then renames it over <file>. No two saves share a temporary
  // name, so two saves at the same time never write to the same bytes.
  // A save that fails before the rename leaves <file> as it was. A failed save tries to remove its temporary file.
  // A rename that is refused for a moment is tried again (see renameWithRetry).
  async save(): Promise<void> {
    const text = `${JSON.stringify({ default: this.defaultAccount, accounts: this.accounts }, null, 2)}\n`;
    const temp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(path.dirname(this.file), { recursive: true });
    try {
      const handle = await open(temp, "w");
      try {
        await handle.writeFile(text, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await renameWithRetry(temp, this.file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => undefined);
      throw error;
    }
  }
}
