import type { TokenStore } from "../secrets/token-store.js";
import type { Profile } from "../supabase/api.js";
import { assertValidName } from "./names.js";
import type { AccountRecord, Registry } from "./registry.js";

// The default warning. It goes to stderr, because stdout carries the MCP protocol in serve mode.
const writeToStderr = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

// Adds one account. The identity check is passed in, so this flow never picks a URL, and the token goes only
// to the check and to the token store. Any failure after the token is stored removes the token again, and the
// record too when this call added it. The error that caused the failure is rethrown. If the token cannot be
// removed, warn gets a fixed message. If warn throws, the same message goes to stderr, so it is not lost.
export const addAccount = async (
  deps: {
    registry: Registry;
    tokens: TokenStore;
    fetchProfile: (token: string) => Promise<Profile>;
    addedAt: () => string;
    warn?: (message: string) => void;
  },
  name: string,
  token: string,
): Promise<AccountRecord> => {
  const { registry, tokens, fetchProfile, addedAt, warn = writeToStderr } = deps;
  assertValidName(name);
  if (token === "") {
    throw new Error("No token was given.");
  }
  // A taken name is refused before the identity check runs, so a repeated name makes no call to Supabase.
  if (registry.get(name) !== undefined) {
    throw new Error(`An account named "${name}" already exists. Remove it first to replace it.`);
  }
  const profile = await fetchProfile(token);
  const sameUser = registry.findByGotrueId(profile.gotrueId);
  if (sameUser !== undefined) {
    throw new Error(`This Supabase user is already added as "${sameUser.name}".`);
  }
  await tokens.set(name, token);
  // Everything from here on is inside the try, so any failure removes the token that was just stored.
  let added = false;
  try {
    const record: AccountRecord = {
      name,
      email: profile.email,
      gotrueId: profile.gotrueId,
      added: "pat",
      addedAt: addedAt(),
    };
    registry.add(record);
    added = true;
    await registry.save();
    return record;
  } catch (error) {
    // The record is removed only if this call added it.
    if (added) {
      registry.remove(name);
    }
    try {
      await tokens.delete(name);
    } catch {
      // The warning holds the account name only, never the token or the error text. If warn throws, the same
      // message goes to stderr, so the failed removal is still reported. The original error is thrown either way.
      const message = `The token for ${name} could not be removed after a failed save. Remove it with: multi-account-supabase-mcp remove ${name}`;
      try {
        warn(message);
      } catch {
        writeToStderr(message);
      }
    }
    throw error;
  }
};
