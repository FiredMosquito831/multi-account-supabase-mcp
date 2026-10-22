# multi-account-supabase-mcp

multi-account-supabase-mcp is a local MCP server. It wraps the official Supabase MCP server (`@supabase/mcp-server-supabase`) so that one server can use several Supabase accounts. Each account has its own personal access token. A read may go to several accounts at once. A change goes to one account only, and the call must name that account.

## Status

- The core and the command-line tool work. They are tested offline.
- The installers are built and tested offline for four agents: Claude Code, Codex, opencode and Antigravity. They are tested with fake command results and temporary folders, and not against a real agent. See the install, update, uninstall and doctor commands under "Commands".
- The Claude Code plugin is not built yet. The Claude Code install step needs a marketplace that is not published yet.
- The package is not published.
- It needs Node 22 or newer. See `engines` in `package.json`.

Not verified yet, because none of these has been run:

- A live call to Supabase with a real token. No such call has been made.
- The real credential store, on any system. The tests use a fake store.
- Hidden input in a real terminal window. The reader is tested with fake input.
- Ctrl+C at the token prompt, and Ctrl+C while a child process runs.
- Node 22. The local runtime is Node 24.6.0.
- The MCP protocol version 2026-07-28. Only the older startup path is tested.
- The installers against a real Claude Code, Codex, opencode or Antigravity. The file locations, the listings and the entry layouts are ASSUMED for some agents. Each one is marked in `docs/install.md` and `docs/scopes.md`.
- The Claude Code marketplace, `FiredMosquito831/multi-account-supabase-mcp`. It is not created, so the Claude Code install step is expected to fail until it exists.

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
  add <name> --pat      Add an account. The token is typed in a terminal, and it is hidden.
  list                  List the accounts. The default is marked with an asterisk.
  default <name>        Make an account the default.
  remove <name>         Remove an account and its stored token.
  install [agent...]    Add the server to the named agents, or to all agents. Needs --yes without a terminal.
  update [agent...]     Update the installed entries and the recorded command line path.
  uninstall [agent...]  Remove what install recorded. The accounts and the Claude marketplace stay.
  doctor                Check the recorded paths, the agents and each account's token.
  serve                 Run the MCP server over stdio.
  help                  Show this text.

Options for install, update and uninstall:
  --scope <scope>       global, project or local. Antigravity has global only.
                        Install uses global when none is given. Update and uninstall
                        act in every scope where a record exists when none is given.
  --dry-run             Show the plan and change nothing.
  --yes                 Install only: apply the plan without asking.
```

### install [agent...]

Adds the server to the named agents. With no agent named, it uses all four: `claude` (Claude Code), `codex` (Codex), `opencode` and `antigravity` (Antigravity).

```
multi-account-supabase-mcp install
multi-account-supabase-mcp install claude codex --scope project
multi-account-supabase-mcp install --yes
```

- In a terminal, with no agent named and no `--yes`, the command asks which agents and, when `--scope` is not given, which scope. Then it prints the plan and asks `Apply these changes? [y/N]`. Only `y` or `yes`, in any letter case, applies it. Ctrl+C at any of the three questions stops the command with exit code 1, and no change is made. Not verified in a real terminal.
- The plan lists each command and file change first, then one line for each agent. `--dry-run` prints the plan and changes nothing.
- If any line in the plan is an error, nothing is applied, even with `--yes`.
- `--scope` takes `global` (the default), `project` or `local`. `local` is for Claude Code only. Antigravity has `global` only. A named agent that lacks the scope stops the command with exit code 1.
- The Codex, opencode and Antigravity entries start the server with the Node program that ran install, this package's command line program, and `serve`. Claude Code gets the server from the plugin instead. No token is written to an agent's configuration.
- A record keeps what this tool wrote, for each agent and each scope. The record is a JSON file for each agent in the `state` folder of the data folder. For Codex, opencode and Antigravity, install refuses to take over an entry that it did not write. The Claude Code install does not check for an existing plugin. See SECURITY.md, section 7. Update and uninstall change only what the record lists.

The agents, the scopes and the file locations are in `docs/scopes.md`. The steps for each agent are in `docs/install.md`. Problems and their messages are in `docs/troubleshooting.md`.

### update [agent...]

Runs again in each scope where the record lists an entry for the agent. For Codex, opencode and Antigravity, it rewrites the entry so that it starts the Node program and the command line program that run update. For Claude Code, it runs only `claude plugin update` (not verified: this command form) and writes no program path into Claude's configuration. In every case, the record keeps the path of the command line program, in each scope where no step failed. It takes `--scope` and `--dry-run`. It does not take `--yes`. When `--scope` is given, a named agent with no record in that scope gets a skipped line, and nothing runs for it. Without `--scope`, an agent with no record in any scope is left out, and when no agent has a record, the command prints `Nothing to update`.

### uninstall [agent...]

Removes what install recorded, in the scopes that have a record. It takes `--scope` and `--dry-run`. It does not take `--yes`.

It does not remove:

- the accounts or their tokens,
- the Claude Code marketplace. The step prints the command that removes it, for the same scope,
- the backup files that the installers made. They are named in the step.

### doctor

Checks, for each scope that has a record: the agent's own check, and that the command line program recorded at install still exists. It also checks that each account has a token in the credential store. It reads only whether a token is present, and never prints it. `doctor` takes no option. Any argument is a usage error.

## Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| 0 | The command succeeded. | Any command that prints its success line. `serve` returns 0 when the client closes stdin. An install, update or uninstall with no step that failed. A dry run with no error line. A plan that you answer no to. |
| 1 | The command ran and failed. | A name that is not valid, such as `Work`. The name `all`. An unknown name for `default` or `remove`. A name that is already taken. A store or file error. Supabase rejects the token. No token is typed. Ctrl+C at the token prompt. Ctrl+C at a question during install (which agents, which scope, or apply), which prints `No answer could be read, so nothing was changed.` Not verified in a real terminal. An agent's step failed. An install plan has an error, so nothing was applied. An unknown agent name. A named agent that lacks the scope. `doctor` found a row that is an error. |
| 2 | The command line is wrong. | A name that contains `sbp_` in any letter case, for `add`, `default`, `remove`, `install`, `update` and `uninstall`, and an unknown command. The tool treats that text as the shape of a token. A missing `--pat`. Piped input for `add`. A wrong number of arguments, or an unknown option. An unknown scope. `--yes` on `update` or `uninstall`. `install` with no terminal and no `--yes`. Any argument to `doctor`. |
| 130 | Ctrl+C at any other time while an install, update or uninstall that is not a dry run is running. | The command prints the notice `Stopped by Ctrl+C. If a change had started, it may be partly made.` and stops. Not verified in a real terminal. |

Most errors go to stderr with the prefix `Error:`. Usage errors, unknown commands, refused command lines and the lock warning (the line that says a lock file could not be removed) do not have that prefix. The lock busy message does have it, as the accounts file section shows. Install, update, uninstall and doctor print their plans and their results on stdout, one line for each step, as `[ok] claude global: ...`, `[skipped] ...` or `[error] ...`. For example, a name that is not valid prints:

```
Error: Invalid account name "Work". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.
```

A usage error prints `Usage error.` and then the usage text. Text that contains `sbp_` is never printed. For `add`, `default`, `remove`, `install`, `update` and `uninstall` with a name that has such text, and for an unknown command, the output is the note below, and the exit code is 2. For `add`, the --pat or terminal message is printed first when it applies. The commands `list`, `serve`, `help` and `doctor` take no name. With a token-shaped argument they print `Usage error.` and the usage text, with exit code 2, and not the note. The note below is printed for the commands named above:

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

- While a change is made, a lock file, `accounts.json.lock`, sits next to the accounts file. A lock file older than two minutes is taken over, because it was left by a command that stopped. A command that finds the lock held waits up to 60 seconds. If the lock is still held after that, the command stops with `Error: Another multi-account-supabase-mcp command is changing accounts.json. Try again in a moment.`
- If the lock file cannot be read or removed after a change, the command prints `The lock file could not be removed. It expires two minutes after it was written, and a change waits for it until then.` The result of the change is still returned.
- A save writes a temporary file next to the accounts file, and then renames it over the file. A rename that is refused with `EPERM`, `EBUSY` or `EACCES` is tried again, up to 10 tries in all, 100 ms apart. Other errors are not retried.

## Where the install records are

The installers keep one record file for each agent, in the `state` folder of the data folder: `claude.json`, `codex.json`, `opencode.json` and `antigravity.json`. The data folder is the same folder as the accounts file. Each record lists what this tool wrote for each scope: the entries, the tables, the files, the folders it made, the backups it kept, the Claude Code marketplace, and the command line program path. A record holds no token.

- A record that cannot be read stops the install before anything changes. The error names the file and the reason only.
- The records are written under a lock file of their own, `<record file>.lock`.

## Limits

- The tool names are the official server's names.
- Reading the official tool list needs network access (read in the code, not run). With no accounts, no call reads it. The official server reads the `search_docs` description from Supabase's docs service. This was read in the official package's code. It has not been run.
- With no accounts, the tool list shows only `account_list`. Every other call, including `search_docs`, is refused with the setup text, before any child starts, until an account is added.
- A read-only query tool is in the code, but it is switched off. It is not listed, and a call to it is refused as an unknown tool when at least one account exists. It stays off until a separate check is done.
- The official server runs destructive SQL, and `apply_migration`, without a confirmation step, in the build this tool uses. This tool adds no confirmation step of its own. This was read in the official build. It was not checked with a live call.
- Every official child starts with all nine feature groups: `docs`, `account`, `database`, `debugging`, `development`, `functions`, `branching`, `storage` and `notebooks`. The official defaults leave out `storage` and `notebooks`.
- On Windows, each child process receives eight system names that the Windows process start adds when the child's environment does not have them. None of them is a credential. See `SECURITY.md`.
- The token of an account is in the environment of its child process while that process runs. See `SECURITY.md`.
- The installers run the agents' own commands: `claude`, `codex` and `agy`. Those commands get the whole environment of the installer. What they do is not verified here. See `SECURITY.md`.
- The installers have no tests against a real agent. The tests use fake command results and temporary folders.

## License

Licensed under the Apache License 2.0 (`Apache-2.0`). The `LICENSE` and `NOTICE` files are at the root of the repository.
