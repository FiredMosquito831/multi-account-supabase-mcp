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

### Security

- No token is printed, and no token is written to the accounts file.
- A command line that contains `sbp_` in any letter case is refused with exit code 2, and the text is not printed.
- The child environment is an allowlist, and each child gets only the token of its own account.
- The identity check fails closed: a profile without a user id is refused.
- Each call reads the accounts file again, so a removed account stops at the next call.
