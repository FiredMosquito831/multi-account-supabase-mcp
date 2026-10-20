import type { TokenStore } from "../secrets/token-store.js";
import type { Profile } from "../supabase/api.js";
import { assertValidName } from "./names.js";
import type { AccountRecord, Registry } from "./registry.js";

// Adds one account. The identity check is passed in, so this flow never picks a URL, and the token goes only
// to the check and to the token store. If the save fails, the record and the token are removed again, and the
// save error is rethrown.
export const addAccount = async (
  deps: {
    registry: Registry;
    tokens: TokenStore;
    fetchProfile: (token: string) => Promise<Profile>;
    addedAt: () => string;
  },
  name: string,
  token: string,
): Promise<AccountRecord> => {
  const { registry, tokens, fetchProfile, addedAt } = deps;
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
  const record: AccountRecord = {
    name,
    email: profile.email,
    gotrueId: profile.gotrueId,
    added: "pat",
    addedAt: addedAt(),
  };
  registry.add(record);
  try {
    await registry.save();
  } catch (error) {
    registry.remove(name);
    await tokens.delete(name);
    throw error;
  }
  return record;
};
