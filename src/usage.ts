// The usage text, shown by help, by a usage error, by an unknown command, and by a terminal run with no command.
// It holds no user text, so it never needs the token-shape check.
export const usageText = [
  "Usage: multi-account-supabase-mcp <command>",
  "",
  "Commands:",
  "  add <name> --pat      Add an account. The token is typed in a terminal, and it is hidden.",
  "  list                  List the accounts. The default is marked with an asterisk.",
  "  default <name>        Make an account the default.",
  "  remove <name>         Remove an account and its stored token.",
  "  install [agent...]    Add the server to the named agents, or to all agents. Needs --yes without a terminal.",
  "  update [agent...]     Update the installed entries and the recorded command line path.",
  "  uninstall [agent...]  Remove what install recorded. The accounts and the Claude marketplace stay.",
  "  doctor                Check the recorded paths, the agents and each account's token.",
  "  serve                 Run the MCP server over stdio.",
  "  help                  Show this text.",
  "",
  "Options for install, update and uninstall:",
  "  --scope <scope>       global, project or local. Antigravity has global only.",
  "                        Install uses global when none is given. Update and uninstall",
  "                        act on global and on this folder's project and local scopes, where a record exists, if none is given.",
  "  --dry-run             Show the plan and change nothing.",
  "  --yes                 Install only: apply the plan without asking.",
].join("\n");
