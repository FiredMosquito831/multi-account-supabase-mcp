# Changelog

This project follows the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- `add <name> --pat` adds an account. The token is typed in a terminal, with hidden input. Hidden input is not checked in a real terminal; see README.md.
- `list`, `default <name>` and `remove <name>` manage the accounts.
- The accounts file, which holds the account records and no token.
- Every change to the accounts file runs under a lock file, `accounts.json.lock`.
- A refused rename of the accounts file is retried, up to 10 tries in all.
- A lock file that cannot be read or removed is reported on stderr, and the result of the change is kept.
- The accounts file is read before each call.
- `remove` prints that the Supabase token still works until it is revoked.
- Exit codes: 0 for success, 1 when a command ran and failed, 2 when the command line is wrong.
- An error about the accounts file names the file and the reason, and never its content.
- With no accounts, the tool list shows only `account_list`, and its description says how to add an account.
- The server sends a tool-list changed notice when the list of accounts changes, in the order the file gives them, or an account is re-added.
- The token store keeps one credential-store entry for each account. The real store has not been run; see SECURITY.md.
- The identity check asks Supabase whose token it is, before anything is saved.
- A failed save removes the token it stored, and the account record it added.
- Routing: a read goes to the default account, to one named account, to a comma-separated list, or to `all`. A change needs one named account.
- At most one read-only and one writable official child process for each account, started on the first call that needs it.
- A placeholder child serves `search_docs`, and a catalog child lists the official tools.
- The tool list of the official server, with an optional `account` argument on each tool except `search_docs`.
- The `account_list` tool lists the accounts with their emails. It never shows a token.
- `serve` runs the MCP server over stdio.
- The tests use fakes and temporary folders. One test starts the official package as a child process, without the docs group.
- A removal stops the account at the next call.
- With no accounts, every call except `account_list` is refused with the setup text, before any child starts.
- `install [agent...]` adds the server to Claude Code, Codex, opencode and Antigravity. With no agent named, it uses all four. A terminal run asks which agents and which scope, and shows the plan before it applies it. Not verified against a real agent.
- `update [agent...]` runs again where the record lists an entry. For Codex, opencode and Antigravity, it rewrites the entry with the current Node program and command line program path. For Claude Code, it runs `claude plugin update` (not verified: this command form), and the record keeps the current command line program path. Not verified against a real agent.
- `uninstall [agent...]` removes what install recorded. It keeps the accounts, the Claude Code marketplace and the backups, and it names them. Not verified against a real agent.
- `doctor` checks each recorded scope, the recorded command line program path, and each account's token.
- Options for the install commands: `--scope <scope>`, `--dry-run` and `--yes`. `--yes` is for install only. The scopes are `global`, `project` and `local`. `local` is for Claude Code only, and Antigravity has `global` only.
- For install, a plan with an error line is not applied, even with `--yes`.
- For Codex, opencode and Antigravity, an entry that this tool did not write is refused, not taken over. The Claude Code install does not check for an existing plugin.
- One record file for each agent, in the `state` folder of the data folder. It holds what this tool wrote, and no token.
- Backups of an edited config file, such as the Codex project `config.toml` or opencode's `opencode.json`: `<file>.bak`, then `.bak2` and so on. A backup is never overwritten. A `SKILL.md` file is replaced without a backup, and only when this tool created it.
- The Claude Code marketplace is added in the scope of the plugin, and it is recorded. Uninstall keeps it and prints the command that removes it. Not verified against a real Claude Code.
- The Codex skill file `supabase-accounts`, in the global and project scopes. Its location is ASSUMED, not verified; see `docs/install.md`.
- Ctrl+C at an install question (which agents, which scope, or apply) exits with code 1, and changes nothing. Ctrl+C at any other time during an install, update or uninstall that is not a dry run exits with code 130 and prints a notice. Not verified in a real terminal.
- The guides `docs/install.md`, `docs/scopes.md` and `docs/troubleshooting.md`.

### Security

- No token is printed, and no token is written to the accounts file.
- A command line with a name that contains `sbp_` in any letter case is refused with exit code 2, and the text is not printed. This applies to `add`, `default`, `remove`, `install`, `update` and `uninstall`, and to an unknown command.
- The child environment is an allowlist, and each child gets only the token of its own account.
- The identity check fails closed: a profile without a user id is refused.
- Each call reads the accounts file again, so a removed account stops at the next call.
- The installers write no token. The entries they write hold the program to run and its arguments. For opencode, the entry also holds a type and an enabled flag.
- A Windows `.cmd` or `.bat` shim does not run from a folder that holds a node program, or from a folder that cannot be read.
- The installers' agent commands get the whole environment of the installer, not the allowlist. `SECURITY.md` says so.
