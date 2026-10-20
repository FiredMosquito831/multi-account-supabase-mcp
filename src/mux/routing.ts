import type { Registry } from "../accounts/registry.js";

// The accounts one tool call goes to. multi is true for "all", for a list, and for two or more names.
export type Targets = { accounts: string[]; multi: boolean };

const joinNames = (names: readonly string[]): string => names.join(", ");

// The checks run in this order, and the first one that applies decides.
export function resolveTargets(argument: unknown, registry: Registry): Targets {
  if (argument !== undefined && typeof argument !== "string") {
    throw new Error('account must be a string: one name, comma-separated names, or "all".');
  }
  const names = registry.names();
  if (names.length === 0) {
    throw new Error(
      "No Supabase accounts are set up yet. Run in a terminal: multi-account-supabase-mcp add <name> --pat",
    );
  }
  const text = typeof argument === "string" ? argument.trim() : "";
  if (text === "") {
    const fallback = registry.defaultName();
    if (fallback === null) {
      throw new Error(`No default account is set. Pass account as one of: ${joinNames(names)}, or "all".`);
    }
    return { accounts: [fallback], multi: false };
  }
  if (text === "all") {
    return { accounts: names, multi: true };
  }
  const items = text.split(",").map((item) => item.trim());
  if (items.some((item) => item === "")) {
    throw new Error("account has an empty name in its list.");
  }
  const missing = items.filter((item) => !names.includes(item));
  if (missing.length === 1) {
    throw new Error(`Unknown account: ${missing[0]}. Known accounts: ${joinNames(names)}.`);
  }
  if (missing.length > 1) {
    throw new Error(`Unknown accounts: ${joinNames(missing)}. Known accounts: ${joinNames(names)}.`);
  }
  return { accounts: items, multi: items.length > 1 };
}
