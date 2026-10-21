# multi-account-supabase-mcp

multi-account-supabase-mcp is a local MCP server. It wraps the official Supabase MCP server (`@supabase/mcp-server-supabase`) so that one server can use several Supabase accounts. Each account has its own personal access token. A read may go to several accounts at once. A change goes to one account only, and the call must name that account.

## Status

- The core and the command-line tool work. They are tested offline.
- There are no installers and no plugin yet. Installers for each agent come later, and a plugin comes after them.
- The package is not published.
- It needs Node 22 or newer. See `engines` in `package.json`.

Not verified yet, because none of these has been run:

- A live call to Supabase with a real token. No such call has been made.
- The real credential store, on any system. The tests use a fake store.
- Hidden input in a real terminal window. The reader is tested with fake input.
- Ctrl+C at the token prompt, and Ctrl+C while a child process runs.
- Node 22. The local runtime is Node 24.6.0.
- The MCP protocol version 2026-07-28. Only the older startup path is tested.

## Build and test from the checkout

Run these in the checkout folder:

```
npm install
npm run build
npm test
npm run typecheck
```

- `npm install` installs the packages listed in `package-lock.json`.
- `npm run build` deletes `dist/` and compiles `src/` into `dist/`. The command-line entry point is `dist/cli.js`.
- `npm test` builds, then runs the tests in `dist/test`. The tests use fakes and temporary folders. They do not use the credential store.
- `npm run typecheck` checks the types and writes no files. It prints nothing when the check passes.

The examples below use the command `multi-account-supabase-mcp`. Until the package is installed, run the same commands as `node dist/cli.js` from the checkout, after `npm run build`.

## Commands

### add <name> --pat

Adds an account. `--pat` means personal access token, and it is the only kind of account for now. Run the command in a Windows console window or another terminal. The token is typed there with hidden input.

```
multi-account-supabase-mcp add work --pat
```

The command shows this prompt on stderr, and then waits for the token:

```
Token (input is hidden, press Enter when done):
```

Type the token and press Enter. Nothing you type is shown. On success the command prints one line:

```
Added "work" (you@example.com).
```

If this is the first account, the line ends with ` It is the default account.`

Before anything is saved, the tool asks Supabase whose token it is. It sends a GET request to `/v1/profile`. If Supabase rejects the token, or cannot be reached, nothing is saved. If a later step fails, the token that was just stored is removed again.

- The command never prints the token. It never writes the token to the accounts file, and the accounts file holds no token.
- Piped input is refused. Run the command in a terminal.
- The tool does not check what kind of token it is. A scoped token and a classic token look the same to it, so it accepts either. Not verified: whether Supabase accepts a scoped token at /v1/profile. It accepts a token only when Supabase accepts it at `/v1/profile`.
- A name that is already taken is refused before the prompt.
- A token for a Supabase user who is already added under another name is refused. This is found after Supabase checks the token.
- An account name has 1 to 32 lowercase letters, digits or hyphens. It starts with a letter or digit. `all` is reserved.
- Whitespace at the start and end of the typed text is removed.

### list

Prints one line per account. A `*` marks the default account. The fields are separated by tabs: the name, the email, and how the account was added. `pat` is the only value so far.

```
*work	you@example.com	pat
 side	second@example.com	pat
```

With no accounts, it prints this one line:

```
No accounts yet. Add one in a terminal with: multi-account-supabase-mcp add <name> --pat
```

With no default account, the last line is:

```
No default account. Calls must name one, or use "all".
```

### default <name>

Makes an account the default. It prints:

```
Default account: side
```

### remove <name>

Removes the account record and the token stored for it on this machine. It prints:

```
Removed "side".
The Supabase token still works until you revoke it in your Supabase account settings.
```

This command does not revoke the token at Supabase. See "Removing an account" below.

### serve

Runs the MCP server over stdio. An MCP client starts this command. Stdout carries the protocol, so the server writes its own log messages to stderr only. The command returns exit code 0 when the client closes stdin.

With no command and no terminal, the tool also runs `serve`. So a client that starts the command with no arguments starts the server.

### help

Prints the usage text. `--help` and `-h` do the same. With no command in a terminal, the usage text is printed.

```
Usage: multi-account-supabase-mcp <command>

Commands:
  add <name> --pat   Add an account. The token is typed in a terminal, and it is hidden.
  list               List the accounts. The default is marked with an asterisk.
  default <name>     Make an account the default.
  remove <name>      Remove an account and its stored token.
  serve              Run the MCP server over stdio.
  help               Show this text.
```

## Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| 0 | The command succeeded. | Any command that prints its success line. `serve` returns 0 when the client closes stdin. |
| 1 | The command ran and failed. | A name that is not valid, such as `Work`. The name `all`. An unknown name for `default` or `remove`. A name that is already taken. A store or file error. Supabase rejects the token. No token is typed. Ctrl+C at the token prompt. |
| 2 | The command line is wrong. | Text that contains `sbp_` in any letter case. The tool treats that text as the shape of a token. A missing `--pat`. Piped input for `add`. An unknown command. A wrong number of arguments, or an unknown option. |

Most errors go to stderr with the prefix `Error:`. Usage errors, unknown commands, refused command lines and the lock warning do not have that prefix. For example, a name that is not valid prints:

```
Error: Invalid account name "Work". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.
```

A usage error prints `Usage error.` and then the usage text. Text that contains `sbp_` is never printed. For a command that has such text, the output is this note, or the usage error, or, for add, the --pat or terminal message, which is printed first:

```
That input looks like a token, so it is not repeated.
```

## How account names are used

Each tool call can take an `account` argument. The rules are these.

- If `account` is left out, or is blank, a read uses the default account.
- `account` can be one name, a comma-separated list of names, or `all`.
- A read that names one account returns that account's result unchanged.
- A read that names several accounts runs on each one. At most four accounts run at the same time. The reply is one JSON document. One entry for each account that answered. A miss is listed in `notFoundIn` only. An entry is `"ok": true` with the result, or `"ok": false` with the error text. `notFoundIn` lists the accounts that do not have the id that a lookup asked for. It is an empty list for the other tools.
- If every account is missing the id, the reply is one line: `Not found in any account: <names>.` It is an error.
- A change runs on one account only. A change that names no account is refused. A change with a list, or with `all`, is refused. The refusal names one account to use, for example: `"<tool>" runs on one account only, because it can change data or is not classified yet. Name one account, for example account: "<name>".`
- A tool that the table below does not name counts as a change.
- `search_docs` needs an account. It runs on the placeholder child only once accounts exist, and it does not use the account argument: an `account` value sent with it is ignored.
- `account_list` shows each account with its email. It never shows a token.
- A tool call has a limit of 15 minutes. If Supabase does not answer in time, the reply is `Supabase did not answer in time (limit: 15 minutes).` For a change, the reply adds `The change may still have happened. Check before you retry.`
- With no default account, a read with no name is refused with `No default account is set. Pass account as one of: <names>, or "all".`
- With no accounts, every call except `account_list` is refused before any child starts, and no network call is made. The refusal is this text: `No Supabase accounts are set up yet. Run in a terminal: multi-account-supabase-mcp add <name> --pat`. For a change, or for a tool that the table does not name, that names no account, the sentence `"<tool>" runs on one account only, because it can change data or is not classified yet.` comes first. The same text follows it.
- A call to an account with no stored token is refused with `No token is stored for the account "<name>". Run multi-account-supabase-mcp remove <name>, then add the account again with --pat in a terminal.`

The table below lists the 34 tool names in the server's policy table, by mode.

| Mode | Count | Tools | What the server does |
| --- | --- | --- | --- |
| none | 1 | `search_docs` | Runs on a placeholder child, only once accounts exist. It takes no account argument. |
| all | 2 | `list_organizations`, `list_projects` | A read on each named account. Without a name, the default account. |
| locate | 17 | `get_organization`, `get_project`, `list_branches`, `list_tables`, `list_extensions`, `list_migrations`, `query_logs`, `get_advisors`, `get_project_url`, `get_publishable_keys`, `generate_typescript_types`, `list_edge_functions`, `get_edge_function`, `list_notebooks`, `get_notebook`, `list_storage_buckets`, `get_storage_config` | A lookup by id. Each named account is asked. Accounts without the id are listed in `notFoundIn`. |
| one | 14 | `create_project`, `pause_project`, `restore_project`, `create_branch`, `delete_branch`, `merge_branch`, `reset_branch`, `rebase_branch`, `apply_migration`, `deploy_edge_function`, `update_storage_config`, `confirm_cost`, `get_cost`, `execute_sql` | A change. It needs one named account. `execute_sql` can change data, so it is in this group. `confirm_cost` and `get_cost` are in this group too. |

## The tool list

With no accounts, the tool list shows one tool: `account_list`. Its description says that no Supabase accounts are set up, and how to add one. The list does not read the official tool list, so no child process starts for it. Every other call is refused before any child starts. See "How account names are used".

With at least one account, the list shows each official tool, and `account_list`. The server adds the `account` argument to each official tool, except `search_docs`. The official tool list is read once, the first time it is needed while at least one account exists. A failed read is tried again at the next call.

When the list of accounts changes, in the order the file gives them, or an account is re-added, the server tells the client that the tool list changed. The server reads the accounts file when a tool list request or a tool call arrives, so it sends the notice while it handles the first such request after a change. The first check after the server starts sends no notice. A change to the default account alone sends no notice.

A client that supports this notice updates its list. Another client may need a new session to see the new list. Not verified: no client was run. An automated test checks the notice with the SDK's own client, in memory.

## Removing an account

`remove <name>` deletes the account record from the accounts file, and it deletes the token stored for that account on this machine.

- The Supabase token still works. It stays valid until you revoke it in your Supabase account settings. Not verified against Supabase. This tool does not revoke it, and it has no command to do so.
- A running server refuses the account at its next call. When the list of accounts changes, the server closes its account child processes. A later call starts new ones.
- If the stored token cannot be deleted, `remove` says so and prints the command to run again. Running that command again tries the delete again.

## Where the accounts file is

- On Windows: `%LOCALAPPDATA%\multi-account-supabase-mcp\accounts.json`. If `LOCALAPPDATA` is not set, the folder is `AppData\Local` in your home folder.
- On other systems: `$XDG_DATA_HOME/multi-account-supabase-mcp/accounts.json`. When `XDG_DATA_HOME` is not set, the file is `~/.local/share/multi-account-supabase-mcp/accounts.json`.
- If `MULTI_ACCOUNT_SUPABASE_HOME` is set to a folder, that folder is used instead, and the file is `accounts.json` inside it.

The rules for other systems are tested with fake values. They have not been run on macOS or Linux.

If the accounts file cannot be read, or does not have the expected shape, the error names the file and the reason only, and never shows the file's content.

The file holds, for each account, the name, the Supabase email, the Supabase user id (`gotrueId`), how the account was added, and the time it was added. It holds no token. An example:

```json
{
  "default": "work",
  "accounts": [
    {
      "name": "work",
      "email": "you@example.com",
      "gotrueId": "00000000-0000-0000-0000-000000000000",
      "added": "pat",
      "addedAt": "2026-10-20T00:00:00.000Z"
    }
  ]
}
```

Changes are made under a lock:

- While a change is made, a lock file, `accounts.json.lock`, sits next to the accounts file. A lock file older than two minutes is taken over, because it was left by a command that stopped. A command that finds the lock held waits up to 60 seconds. If the lock is still held after that, the command stops with `Error: Another multi-account-supabase-mcp command is changing the accounts. Try again in a moment.`
- If the lock file cannot be read or removed after a change, the command prints `The lock file could not be removed. It expires two minutes after it was written, and a change waits for it until then.` The result of the change is still returned.
- A save writes a temporary file next to the accounts file, and then renames it over the file. A rename that is refused with `EPERM`, `EBUSY` or `EACCES` is tried again, up to 10 tries in all, 100 ms apart. Other errors are not retried.

## Limits

- The tool names are the official server's names.
- Reading the official tool list needs network access (read in the code, not run). With no accounts, no call reads it. The official server reads the `search_docs` description from Supabase's docs service. This was read in the official package's code. It has not been run.
- With no accounts, the tool list shows only `account_list`. Every other call, including `search_docs`, is refused with the setup text, before any child starts, until an account is added.
- A read-only query tool is in the code, but it is switched off. It is not listed, and a call to it is refused as an unknown tool when at least one account exists. It stays off until a separate check is done.
- The official server runs destructive SQL, and `apply_migration`, without a confirmation step, in the build this tool uses. This tool adds no confirmation step of its own. This was read in the official build. It was not checked with a live call.
- Every official child starts with all nine feature groups: `docs`, `account`, `database`, `debugging`, `development`, `functions`, `branching`, `storage` and `notebooks`. The official defaults leave out `storage` and `notebooks`.
- On Windows, each child process receives eight system names that the Windows process start adds when the child's environment does not have them. None of them is a credential. See `SECURITY.md`.
- The token of an account is in the environment of its child process while that process runs. See `SECURITY.md`.

## License

Licensed under the Apache License 2.0 (`Apache-2.0`). The `LICENSE` and `NOTICE` files are at the root of the repository.
