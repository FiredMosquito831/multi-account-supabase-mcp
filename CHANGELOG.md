# Changelog

This project follows the format of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## Unreleased

### Added

- `add <name> --pat` adds an account. The token is typed in a terminal, with hidden input. Hidden input is not checked in a real terminal; see README.md.
- `list`, `default <name>` and `remove <name>` manage the accounts.
- `remove <name>` asks first in a terminal. Only `y` or `yes` (in any case, trimmed) removes the account. Any other answer removes nothing and exits 0. Without a terminal, `remove` needs `--yes`, and without it the command is refused with exit code 2. A name with no record and no stored token is reported at once, with no question. `--yes` skips the question.
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
- The token store keeps one credential-store entry for each account (not verified: the real store has not been run; see SECURITY.md).
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
- `install [agent...]` adds the server to Claude Code, Codex, opencode and Antigravity (not verified against a real agent). With no agent named, it uses all four. A terminal run asks which agents and which scope, and shows the plan before it applies it.
- `update [agent...]` runs again where the record lists an entry. For Codex, opencode and Antigravity, it rewrites the entry with the current Node program and command line program path (not verified against a real agent). For Claude Code, it runs `claude plugin update` (not verified: this command form), and the record keeps the current command line program path.
- `uninstall [agent...]` removes what install recorded (not verified against a real agent). It keeps the accounts, the Claude Code marketplace and the backups, and it names them.
- `doctor` checks each recorded scope, the recorded command line program path, and each account's token.
- Options for the install commands: `--scope <scope>`, `--dry-run` and `--yes`. `--yes` is for install and remove only. The scopes are `global`, `project` and `local`. `local` is for Claude Code only, and Antigravity has `global` only.
- For install, a plan with an error line is not applied, even with `--yes`. Update and uninstall also stop before any change when a step in the plan is an error line.
- For Codex, opencode and Antigravity, an entry that this tool did not write is refused, not taken over. The Claude Code install does not check for an existing plugin.
- One record file for each agent, in the `state` folder of the data folder. It holds what this tool wrote, and no token.
- Backups of an edited config file, such as the Codex project `config.toml` or opencode's `opencode.json` (names ASSUMED, not verified): `<file>.bak`, then `.bak2` and so on. A backup is never overwritten. A `SKILL.md` file is replaced without a backup, and only when this tool created it.
- The Claude Code marketplace is added in the scope of the plugin, and it is recorded (not verified against a real Claude Code). Uninstall keeps it and prints the command that removes it.
- The Codex skill file `supabase-accounts`, in the global and project scopes. Its location is ASSUMED, not verified; see `docs/INSTALL.md`.
- Ctrl+C at an install question (which agents, which scope, or apply) exits with code 1, and changes nothing. Ctrl+C at any other time during an install, update or uninstall that is not a dry run exits with code 130 and prints a notice (not verified in a real terminal).
- The guides `docs/INSTALL.md`, `docs/AGENTS.md` and `docs/TROUBLESHOOTING.md`.
- The Claude Code plugin `multi-account-supabase`, in the marketplace `multi-account-supabase-mcp` in this repository. Its server key is `supabase`. Claude Code has not been run with it (not verified).
- Five plugin commands (not verified: Claude Code was not run): `accounts` and `doctor` run the launcher with one fixed word, and `add-account`, `set-default` and `remove-account` give a terminal line for you to run.
- The launcher runs the installed command when it is on PATH, and otherwise `npx` with the plugin's version (ASSUMED, not verified: npx was not run). It accepts plain words only.
- A copy of the `supabase-accounts` skill in the plugin.
- A test checks that the plugin, the package and the marketplace have the same version.

### Security

- No token is printed, and no token is written to the accounts file.
- A command line with a name that contains `sbp_` in any letter case is refused with exit code 2, and the text is not printed. This applies to `add`, `default`, `remove`, `install`, `update` and `uninstall`, and to an unknown command.
- The child environment is an allowlist, and each child gets only the token of its own account.
- The identity check fails closed: a profile without a user id is refused.
- Each call reads the accounts file again, so a removed account stops at the next call.
- The installers write no token. The entries they write hold the program to run and its arguments. For opencode, the entry also holds a type and an enabled flag.
- A Windows `.cmd` or `.bat` shim does not run from a folder that holds a node program, or from a folder that cannot be read.
- The installers' agent commands get the whole environment of the installer, not the allowlist. `SECURITY.md` says so.
- For Codex and opencode, an edited entry or table is never removed or replaced. An entry is edited when its arguments are not the recorded command line program path followed by `serve`, when its command is not an absolute path, when it has an env key (Codex) or an environment or env key (opencode) whose value is not empty, or, for opencode, when its type or enabled flag differs (ASSUMED, not verified: the real CLI layout is not run). Install, update and uninstall leave it in place, and the step is an error.
- The plugin's command files take no argument from you. Only the `accounts` and `doctor` lines run a command, each with one fixed word.
- The launcher refuses an argument that is not a plain word with exit code 2, before anything runs. It does not print the refused argument.
