import { Entry } from "@napi-rs/keyring";

// The credential store service. Each account name is one entry under this service.
export const SERVICE = "multi-account-supabase-mcp";

// Keeps one token for each account name. A token is never written to any other place.
export interface TokenStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, token: string): Promise<void>;
  delete(account: string): Promise<void>;
}

// Keeps tokens in memory only. It is a fake for tests, and it never touches the credential store.
export class MemoryTokenStore implements TokenStore {
  private readonly tokens = new Map<string, string>();

  async get(account: string): Promise<string | undefined> {
    return this.tokens.get(account);
  }

  async set(account: string, token: string): Promise<void> {
    this.tokens.set(account, token);
  }

  async delete(account: string): Promise<void> {
    this.tokens.delete(account);
  }
}

// The part of a keyring Entry that the store uses. The tests pass a fake with these three methods.
export interface KeyringEntryLike {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

// Makes the entry for one service and account.
export type MakeEntry = (service: string, account: string) => KeyringEntryLike;

// The default factory opens the real credential store. The program uses it. No test calls it.
const defaultMakeEntry: MakeEntry = (service, account) => new Entry(service, account);

// Keeps each token in the operating system's credential store, one entry per account name.
// The methods are async, so a store error reaches the caller as a rejected promise.
export class KeyringTokenStore implements TokenStore {
  constructor(private readonly makeEntry: MakeEntry = defaultMakeEntry) {}

  async get(account: string): Promise<string | undefined> {
    // getPassword returns null when the entry holds no password. The interface reports that as undefined.
    return this.makeEntry(SERVICE, account).getPassword() ?? undefined;
  }

  async set(account: string, token: string): Promise<void> {
    this.makeEntry(SERVICE, account).setPassword(token);
  }

  // deletePassword returns false only when there was no credential, which is the state delete leaves.
  // A credential that exists but cannot be removed makes the keyring throw, and that error is not caught here.
  async delete(account: string): Promise<void> {
    this.makeEntry(SERVICE, account).deletePassword();
  }
}
