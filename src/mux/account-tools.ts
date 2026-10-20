import type { Tool } from "@modelcontextprotocol/server";
import type { Registry } from "../accounts/registry.js";

// The tool that lists the accounts. The server adds it to every tools/list, and it never shows a token.
export const ACCOUNT_LIST_NAME = "account_list";

export const ACCOUNT_LIST_TOOL: Tool = {
  name: ACCOUNT_LIST_NAME,
  description:
    "Lists the accounts this server knows, with the email of each. The default account is marked with an asterisk. Tokens are never shown.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

// One line per account: an asterisk on the default, then the name, the email and the kind of token, tab-separated.
// With no default, the last line says so. With no accounts, the text only says how to add one.
export function accountListText(registry: Registry): string {
  const accounts = registry.list();
  if (accounts.length === 0) {
    return "No accounts yet. Add one in a terminal with: multi-account-supabase-mcp add <name> --pat";
  }
  const defaultName = registry.defaultName();
  const lines = accounts.map(
    (account) => `${account.name === defaultName ? "*" : " "}${account.name}\t${account.email}\t${account.added}`,
  );
  if (defaultName === null) {
    lines.push('No default account. Calls must name one, or use "all".');
  }
  return lines.join("\n");
}
