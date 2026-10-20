// The usage text, shown by help, by a usage error, by an unknown command, and by a terminal run with no command.
// It holds no user text, so it never needs the token-shape check.
export const usageText = [
  "Usage: multi-account-supabase-mcp <command>",
  "",
  "Commands:",
  "  add <name> --pat   Add an account. The token is typed in a terminal, and it is hidden.",
  "  list               List the accounts. The default is marked with an asterisk.",
  "  default <name>     Make an account the default.",
  "  remove <name>      Remove an account and its stored token.",
  "  serve              Run the MCP server over stdio.",
  "  help               Show this text.",
].join("\n");
