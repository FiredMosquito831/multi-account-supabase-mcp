# multi-account-supabase-mcp

multi-account-supabase-mcp is a local MCP server. It wraps the official Supabase MCP server (`@supabase/mcp-server-supabase`) so that one server can use several Supabase accounts. Each account has its own personal access token. A read may go to several accounts at once. A change goes to one account only, and the call must name that account.

## Status

- The core and the command-line tool work. They are tested offline.
- The installers are built and tested offline for four agents: Claude Code, Codex, opencode and Antigravity. They are tested with fake command results and temporary folders, and not against a real agent. See the install, update, uninstall and doctor commands under "Commands".
- The Claude Code plugin is in this repository, in `plugins/multi-account-supabase`. It is tested offline. It has not been run in Claude Code (not verified). See "Claude Code plugin" below.
- The package is not published.
- It needs Node 22 or newer. See `engines` in `package.json`.

Not verified yet, because none of these has been run:

- A live call to Supabase with a real token. No such call has been made.
- The real credential store, on any system. The tests use a fake store.
- Hidden input in a real terminal window. The reader is tested with fake input.
- Ctrl+C at the token prompt, and Ctrl+C while a child process runs.
- Node 22. The local runtime is Node 24.6.0.
- The MCP protocol version 2026-07-28. Only the older startup path is tested.
- The installers against a real Claude Code, Codex, opencode or Antigravity. The file locations, the listings and the entry layouts are ASSUMED for some agents. Each one is marked in `docs/INSTALL.md` and `docs/AGENTS.md`.
- The Claude Code marketplace, `FiredMosquito831/multi-account-supabase-mcp`. It is not created (not verified: checked on 2026-10-20 only), so the Claude Code install step is expected to fail until it exists.

## Documentation

The documentation pages are linked below, in the repository on GitHub (Not verified: the repository does not exist yet, so these links do not open until it is created).

- [docs/INSTALL.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/INSTALL.md)
- [docs/ACCOUNTS.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/ACCOUNTS.md)
- [docs/AGENTS.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/AGENTS.md)
- [docs/CONFIGURATION.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/CONFIGURATION.md)
- [docs/DEVELOPMENT.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/DEVELOPMENT.md)
- [docs/MCP.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/MCP.md)
- [docs/SAFETY.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/SAFETY.md)
- [docs/TESTING.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/TESTING.md)
- [docs/TROUBLESHOOTING.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/TROUBLESHOOTING.md)
- [docs/USAGE.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/USAGE.md)
- [docs/RELEASING.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/docs/RELEASING.md)
- [CHANGELOG.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/CHANGELOG.md)
- [CONTRIBUTING.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/CONTRIBUTING.md)
- [SECURITY.md](https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/SECURITY.md)

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

Adds an account. `--pat` means personal access token, and it is the only kind of account for now. Run the command in a Windows console window or another terminal. The token is typed there with hidden input (not verified: the hidden input has not been checked in a real terminal).

```
multi-account-supabase-mcp add work --pat
```

The command shows this prompt on stderr, and then waits for the token:

```
Token (input is hidden, press Enter when done):
```

Type the token and press Enter. Nothing you type is shown (not verified: the hidden input has not been checked in a real terminal). On success the command prints one line:

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

Removes the account record and the token stored for it on this machine. In a terminal it asks first: type `y` or `yes` to remove. Any other answer removes nothing, prints `Nothing was removed.`, and exits 0. Without a terminal it needs `--yes`. Without a terminal and without `--yes` it is refused with exit code 2 and removes nothing. `--yes` removes at once. An account name that has no record and no stored token is reported at once, with no question, because nothing can be removed: it prints `Error: No account named "<name>".` and exits 1. A successful removal prints:

```
Removed "side".
The Supabase token still works until you revoke it in your Supabase account settings.
```

The last line is printed by the command. Not verified against Supabase: that the token still works until it is revoked.

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
  remove <name>         Remove an account and its stored token. Asks first in a terminal; needs --yes without one.
  install [agent...]    Add the server to the named agents, or to all agents. Needs --yes without a terminal.
  update [agent...]     Update the installed entries and the recorded command line path.
  uninstall [agent...]  Remove what install recorded. The accounts and the Claude marketplace stay.
  doctor                Check the recorded paths, the agents and each account's token.
  serve                 Run the MCP server over stdio.
  help                  Show this text.

Options for install, update and uninstall:
  --scope <scope>       global, project or local. Antigravity has global only.
                        Install uses global when none is given. Update and uninstall
                        act on global and on this folder's project and local scopes, where a record exists, if none is given.
  --dry-run             Show the plan and change nothing.
  --yes                 Install and remove only: apply without asking.
```

### install [agent...]

Adds the server to the named agents. With no agent named, it uses all four: `claude` (Claude Code), `codex` (Codex), `opencode` and `antigravity` (Antigravity).

```
multi-account-supabase-mcp install
multi-account-supabase-mcp install claude codex --scope project
multi-account-supabase-mcp install --yes
```

- In a terminal, with no agent named and no `--yes`, the command asks which agents and, when `--scope` is not given, which scope. Then it prints the plan and asks `Apply these changes? [y/N]`. Only `y` or `yes`, in any letter case, applies it. Ctrl+C at any of the three questions stops the command with exit code 1, and no change is made. Not verified in a real terminal. `--dry-run` asks only the agent and scope questions in a terminal, and it still changes nothing.
- The plan lists each command and file change first, then one line for each agent. `--dry-run` prints the plan and changes nothing.
- If any line in the plan is an error, nothing is applied, even with `--yes`.
- `--scope` takes `global` (the default), `project` or `local`. `local` is for Claude Code only. Antigravity has `global` only. A named agent that lacks the scope stops the command with exit code 1.
- The Codex, opencode and Antigravity entries start the server with the Node program that ran install, this package's command line program, and `serve`. Claude Code gets the server from the plugin instead. No token is written to an agent's configuration.
- A record keeps what this tool wrote, for each agent and each scope. The record is a JSON file for each agent in the `state` folder of the data folder. For Codex, opencode and Antigravity, install refuses to take over an entry that it did not write. The Claude Code install does not check for an existing plugin. See SECURITY.md, section 7. Update and uninstall change only what the record lists.

The agents, the scopes and the file locations are in `docs/AGENTS.md`. The steps for each agent are in `docs/INSTALL.md`. Problems and their messages are in `docs/TROUBLESHOOTING.md`.

### update [agent...]

Runs again in each scope where the record lists an entry for the agent. For Codex, opencode and Antigravity, it rewrites the entry so that it starts the Node program and the command line program that run update. For Claude Code, it runs only `claude plugin update` (not verified: this command form) and writes no program path into Claude's configuration. In every case, the record keeps the path of the command line program, in each scope where no step failed. It takes `--scope` and `--dry-run`. It does not take `--yes`. Without `--scope`, it acts on the global scope, and on the project and local scopes of the current folder, where a record exists. A named agent with no record in a scope gets one skipped line for that scope, with or without `--scope`, and nothing runs for it. An agent that is not named and has no record is left out. When no agent has a record, the command prints `Nothing to update: no agent has a record in any scope.`, or the same line with `in the <scope> scope` when `--scope` is given. As install does, update stops before any change when a step in the plan is an error line.

### uninstall [agent...]

Removes what install recorded. Without `--scope`, it acts on the global scope, and on the project and local scopes of the current folder, where a record exists. It takes `--scope` and `--dry-run`. It does not take `--yes`. As install does, it stops before any change when a step in the plan is an error line.

It does not remove:

- the accounts or their tokens,
- the Claude Code marketplace. The step prints the command that removes it, for the same scope,
- the backup files that the installers made. They are named in the step.

### doctor

Checks, for each scope that has a record: the agent's own check, and that the command line program recorded at install still exists. It also checks that each account has a token in the credential store. It reads only whether a token is present, and never prints it. `doctor` takes no option. Any argument is a usage error.

## Claude Code plugin

The repository holds a Claude Code plugin, `multi-account-supabase`, in `plugins/multi-account-supabase`. Its marketplace is `multi-account-supabase-mcp`, in this repository (`.claude-plugin/marketplace.json`). The plugin's files are tested offline by `npm test`. Claude Code has not been run with the plugin (not verified).

### What the plugin starts

The plugin's server key is `supabase`. Claude Code is expected to name the tools `plugin:multi-account-supabase:supabase` (not verified: Claude Code was not run). The Codex, opencode and Antigravity entries that the installer writes use the key `multi-account-supabase` (`src/agents/scopes.ts`, lines 12 to 16). The two keys differ (`src/test/scopes.test.ts`, lines 104 to 105), so both can be installed side by side (ASSUMED, not verified: no agent was run with both).

The plugin has five slash commands. Claude Code is expected to name them `/multi-account-supabase:<command>` (ASSUMED, not verified: Claude Code was not run).

| Command | What it does |
| --- | --- |
| `accounts` | Runs `list` through the launcher and shows the accounts. No token value is shown. |
| `doctor` | Runs `doctor` through the launcher and explains each line. No token value is shown. |
| `add-account` | Explains the steps, and gives a terminal line: `npx -y multi-account-supabase-mcp@0.1.0 add <name> --pat`. You type the token in that terminal, with hidden input (not verified: the hidden input has not been checked in a real terminal). The token is never typed in the chat. |
| `set-default` | Gives a terminal line: `npx -y multi-account-supabase-mcp@0.1.0 default <name>`. |
| `remove-account` | After you confirm the name in the chat, gives a terminal line: `npx -y multi-account-supabase-mcp@0.1.0 remove <name>`. |

- `accounts` and `doctor` each run one command, with one fixed word. The other three give a terminal line for you to run. No command passes a name through a shell (`plugins/multi-account-supabase/commands/`).
- Each terminal line names the plugin version, `0.1.0`, so the same version runs. The package is not published (checked on 2026-10-20 only), so these lines fail until it is (ASSUMED, not verified: npx was not run).
- `remove` asks in the terminal before it removes anything. Only `y` or `yes` removes the account. Without a terminal it needs `--yes` after the name (`src/run.ts`, `removeCommand`). The Supabase token still works until you revoke it in your Supabase account settings (not verified against Supabase).

### Install routes

- Installer route: `multi-account-supabase-mcp install claude` runs the `claude plugin` commands for one scope: global, unless `--scope` names another. See `install [agent...]`, above. Not verified against a real Claude Code.
- Manual route: in Claude Code, run `/plugin marketplace add FiredMosquito831/multi-account-supabase-mcp`, then `/plugin install multi-account-supabase@multi-account-supabase-mcp` (not verified: the Claude Code interface was not run). `docs/INSTALL.md` has the same steps.
- The installer's `update`, `uninstall` and `doctor` act only on what the tool recorded, so they do not act on a plugin added by hand (`src/agents/claude.ts`, lines 191, 227 and 298). The installer's `install` does not check for a plugin added by hand. It runs `claude plugin install` (`src/agents/claude.ts`, line 158). What `claude plugin install` does with a plugin that is already installed is not verified.

### Marketplace and manifest

- The marketplace declares no command, hook or server. Its one plugin entry is the only entry (`.claude-plugin/marketplace.json`; `src/test/plugin-manifest.test.ts`). Whether the installer's `-y` flag then accepts nothing is not verified (see `SECURITY.md`, section 7).
- The marketplace add commands name no branch and no release (`src/agents/claude.ts`, line 132). Claude Code is expected to read the default branch (ASSUMED, not verified). Whether Claude Code accepts a release ref is OPEN.
- The plugin entry sets `strict` to `false`. Its meaning in Claude Code is ASSUMED, not verified.
- The plugin, the package and the marketplace have the same version, `0.1.0`. A test checks it (`src/test/plugin-manifest.test.ts`).

### The launcher

The plugin's server entry runs `bin/launch.mjs` with `node` and no argument. With no argument, the launcher starts `serve` (`plugins/multi-account-supabase/.mcp.json`; `bin/launch.mjs`, line 91).

- If `multi-account-supabase-mcp` is on PATH, the launcher runs it. It does not compare that copy's version with the plugin's version (`bin/launch.mjs`, lines 100 to 103).
- Otherwise it runs `npx -y multi-account-supabase-mcp@<plugin version>` (`bin/launch.mjs`, lines 47 to 51 and 110 to 118).
- The launcher accepts plain words only: letters, digits, and the characters `._@:=,/\+-`. Any other argument stops it with exit code 2, before anything runs. It does not print the refused argument (`bin/launch.mjs`, lines 18 to 21 and 93 to 98).
- On Windows, the launcher first checks that `npx` is on PATH. If it is not, it prints one line and exits with code 1 (`bin/launch.mjs`, lines 104 to 109).
- The launcher writes its own messages to stderr only. In serve mode, stdout carries the MCP protocol (`bin/launch.mjs`, lines 8 to 9).
- The launcher forwards SIGINT and SIGTERM to the server (`bin/launch.mjs`, lines 136 to 144). On Windows, a stop signal reaches `cmd.exe` and not the server, so the server may not close its account processes there (ASSUMED, not verified: check on Windows, OPEN).

### The skill

The plugin carries one skill, `supabase-accounts`. Its file is a byte copy of `skills/supabase-accounts/SKILL.md` at the root. A test checks that the two files are the same (`src/test/plugin-files.test.ts`).

### Not verified

- The Claude Code interface, the command names, the tool ids and the manual install route. None was run.
- The installer's `claude plugin` commands against a real Claude Code. See the installer route above.
- The dashboard steps for creating a token with scopes are OPEN. They are read again before a release.
- The repository `FiredMosquito831/multi-account-supabase-mcp` and the package `multi-account-supabase-mcp` do not exist on GitHub or npm yet (checked on 2026-10-20 only).

## Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| 0 | The command succeeded. | Any command that prints its success line. `serve` returns 0 when the client closes stdin. An install, update or uninstall with no step that failed. A dry run with no error line. A plan that you answer no to. A remove that you answer with anything other than y or yes, which prints `Nothing was removed.` |
| 1 | The command ran and failed. | A name that is not valid, such as `Work`. The name `all`. An unknown name for `default` or `remove`. A name that is already taken. A store or file error. Supabase rejects the token. No token is typed. Ctrl+C at the token prompt. Ctrl+C at a question during install (which agents, which scope, or apply), which prints `No answer could be read, so nothing was changed.` Ctrl+C at the remove question, which prints `No answer could be read, so nothing was removed.` Not verified in a real terminal. An agent's step failed. An install plan has an error, so nothing was applied. An unknown agent name. A named agent that lacks the scope. `doctor` found a row that is an error. |
| 2 | The command line is wrong. | A name that contains `sbp_` in any letter case, for `add`, `default`, `remove`, `install`, `update` and `uninstall`, and an unknown command. The tool treats that text as the shape of a token. A missing `--pat`. Piped input for `add`. A wrong number of arguments, an unknown option, or a switch given twice. An unknown scope. `--yes` on `update` or `uninstall`. `install` or `remove` with no terminal and no `--yes`. Any argument to `doctor`. |
| 130 | Ctrl+C during an install, update or uninstall that is not a dry run, and not at a question. | The first Ctrl+C asks the command to stop. The stop is checked between real steps, so a command inside a step that has started still runs to its end, and no later step starts. If a step had started, the command prints `Stopped by Ctrl+C. The step that was running finished, and the steps after it did not run. Run multi-account-supabase-mcp uninstall --dry-run to see what is recorded.` If no step had started, it prints `Stopped by Ctrl+C before any step started, so nothing was changed.` Both go to stdout, and the exit code is 130. A second Ctrl+C exits at once with 130, and prints `Stopped by Ctrl+C. If a change had started, it may be partly made. Check the agent's own configuration, and run multi-account-supabase-mcp uninstall --dry-run to see what is recorded.` on stderr. Not verified in a real terminal. |

Most errors go to stderr with the prefix `Error:`. Usage errors, unknown commands, refused command lines and the lock warning (the line that says a lock file could not be removed) do not have that prefix. The lock busy message does have it, as the accounts file section shows. Install, update, uninstall and doctor print their plans and their results on stdout, one line for each step, as `[ok] claude global: ...`, `[skipped] ...` or `[error] ...`. For example, a name that is not valid prints:

```
Error: Invalid account name "Work". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.
```

A usage error prints `Usage error.` and then the usage text. On a command line, text that contains `sbp_` in any letter case is refused. In installer output (plans, step lines and reasons), text shaped like a token, `sbp_` followed by letters, digits, underscores or hyphens, is shown as `[redacted]`. A bare `sbp_` with nothing after it is printed. For `add`, `default`, `remove`, `install`, `update` and `uninstall` with a name that has such text, and for an unknown command, the output is the note below, and the exit code is 2. For `add`, the --pat or terminal message is printed first when it applies. The commands `list`, `serve`, `help` and `doctor` take no name. With a token-shaped argument they print `Usage error.` and the usage text, with exit code 2, and not the note. The note below is printed for the commands named above:

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

`remove <name>` deletes the account record from the accounts file, and it deletes the token stored for that account on this machine. In a terminal it asks first, and `--yes` skips the question. Without a terminal it needs `--yes`.

- The Supabase token still works. It stays valid until you revoke it in your Supabase account settings. Not verified against Supabase. This tool does not revoke it, and it has no command to do so.
- A running server refuses the account at its next call. When the list of accounts changes, the server closes its account child processes. A later call starts new ones.
- If the stored token cannot be deleted, `remove` says so and prints the command to run again. Running that command again tries the delete again.

## Where the accounts file is

- On Windows: `%LOCALAPPDATA%\multi-account-supabase-mcp\accounts.json`. If `LOCALAPPDATA` is not set, the folder is `AppData\Local` in your home folder.
- On other systems: `$XDG_DATA_HOME/multi-account-supabase-mcp/accounts.json`. When `XDG_DATA_HOME` is not set, the file is `~/.local/share/multi-account-supabase-mcp/accounts.json`.
- If `MULTI_ACCOUNT_SUPABASE_HOME` is set to a folder, that folder is used instead, and the file is `accounts.json` inside it. The installer, `update` and `doctor` read this variable from their own environment, so they use the folder it names.
- The entries that install writes do not set this variable, and the tool does not write it into agent configuration. The installed server reads the default accounts file, unless the variable is set in the environment that the agent gives the server (ASSUMED, not verified: how each agent passes its environment). If the variable is set only for the installer, or in a shell that does not start the agent, the server reads the default file, and if that file has no accounts it refuses calls with the setup text (ASSUMED, not verified: how each agent passes its environment). See "The server does not find the accounts file" in `docs/TROUBLESHOOTING.md`.

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

- A record that cannot be read stops install, update and uninstall before anything changes. The error names the file and the reason only.
- The records are written under a lock file of their own, `<record file>.lock`.

## Limits

- The tool names are the official server's names.
- Reading the official tool list needs network access (read in the code, not run). With no accounts, no call reads it. The official server reads the `search_docs` description from Supabase's docs service. This was read in the official package's code. It has not been run.
- With no accounts, the tool list shows only `account_list`. Every other call, including `search_docs`, is refused with the setup text, before any child starts, until an account is added.
- A read-only query tool is in the code, but it is switched off. It is not listed, and a call to it is refused as an unknown tool when at least one account exists. It stays off until a separate check is done.
- The official server runs destructive SQL, and `apply_migration`, without a confirmation step, in the build this tool uses. This tool adds no confirmation step of its own. This was read in the official build. It was not checked with a live call.
- Every official child starts with all nine feature groups: `docs`, `account`, `database`, `debugging`, `development`, `functions`, `branching`, `storage` and `notebooks`. The official defaults leave out `storage` and `notebooks`.
- On Windows, each child process receives eight system names that the Windows process start adds when the child's environment does not have them (not verified: the names reaching the child in a live run were not checked; the list is in a code comment, and no test checks it). None of them is a credential. See `SECURITY.md`.
- The token of an account is in the environment of its child process while that process runs. See `SECURITY.md`.
- The installers run the agents' own commands: `claude`, `codex` and `agy`. Those commands get the whole environment of the installer. What they do is not verified here. See `SECURITY.md`.
- The installers have no tests against a real agent. The tests use fake command results and temporary folders.

## License

Licensed under the Apache License 2.0 (`Apache-2.0`). The `LICENSE` and `NOTICE` files are at the root of the repository.
