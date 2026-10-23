# Usage

This page lists every command, its options, what it prints, and its exit code. The usage text below is the text the program prints. It is copied from `src/usage.ts`.

Run the commands in a terminal window. The command is `multi-account-supabase-mcp`. Until the package is installed, run the same commands as `node dist/cli.js <command>` from the checkout, after `npm run build`.

## Usage text

This is the text that help prints. A usage error prints it too.

```text
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

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | The command did what it was asked. A declined `remove` or `install` also gives 0. |
| 1 | The command ran and failed. This covers an invalid, unknown or taken name, a store or file error, a token that Supabase rejects, a failed install step, a plan with an error, an unknown agent, an agent that has no named scope, a question that got no answer, and a `doctor` row that is an error. |
| 2 | The command line is wrong, so nothing was changed. This covers a missing or extra argument, an unknown option, a switch given twice, an unknown command, an unknown scope, `--yes` on `update` or `uninstall`, `add` without `--pat`, piped input for `add`, and a `remove` or `install` with no terminal and no `--yes`. |
| 130 | A change (`install`, `update` or `uninstall`, not a dry run) was stopped by Ctrl+C. |

Source: `src/run.ts` and `src/install/flow.ts`.

## Token-shaped input

A name or an agent name that has the token prefix, in any letter case, is refused. The command prints this line, and nothing else from the input, and it exits with 2:

```text
That input looks like a token, so it is not repeated.
```

This applies to `add`, `default`, `remove`, `install`, `update`, `uninstall` and an unknown command. For `add`, a missing `--pat` or piped input prints its own message and nothing more. The commands `list`, `serve`, `help` and `doctor` take no name. For them, a token-shaped argument gives the usage error, with exit 2.

Installer output (plans, step lines and reasons) shows any text of the token shape as `[redacted]`. Source: `src/run.ts`, `src/install/flow.ts`.

## add

```text
multi-account-supabase-mcp add <name> --pat
```

- `<name>` is the account name. The rule is in [ACCOUNTS.md](ACCOUNTS.md).
- `--pat` is required. It means personal access token, the only kind for now.
- The command shows this prompt on stderr, then waits for the token:

  ```text
  Token (input is hidden, press Enter when done): 
  ```

  Type the token and press Enter. Nothing you type is shown. Not verified in a real terminal window: hidden input.
- Spaces at the start and end of the typed text are removed. An empty value gives `Error: no token was typed.`

On success, the command prints one line on stdout:

```text
Added "<name>" (<email>).
```

For the first account, the line ends with ` It is the default account.`

Errors are printed on stderr, with the prefix `Error:`. These are the common ones:

- `Error: Invalid account name "<name>". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.` The name `all` gives `"all" is reserved.`
- `Error: An account named "<name>" already exists. Remove it first to replace it.` This is checked before the prompt.
- `Error: Supabase rejected this token (HTTP 401).` The code treats HTTP 401 as a rejected token. Not verified: what Supabase returns for a rejected token.
- `Error: Could not reach Supabase while checking the token.`
- `Error: This Supabase user is already added as "<name>".` The same Supabase user is already added under another name.
- `Error: Cancelled.` Ctrl+C at the prompt (not verified in a real terminal).

If the token cannot be removed after a failed save, this line is printed before the error:

```text
The token for <name> could not be removed after a failed save. Remove it with: multi-account-supabase-mcp remove <name>
```

Usage errors, with exit code 2:

- `Adding an account needs --pat. Run in a terminal: multi-account-supabase-mcp add <name> --pat`
- `The token is typed in a terminal, not piped. Run this command in a terminal window.` This is for piped input.
- A missing or extra name, or an unknown option. The command prints `Usage error.` and the usage text.

## list

```text
multi-account-supabase-mcp list
```

Prints one line for each account, on stdout. The default account has an asterisk. The fields are separated by tabs: the name, the email, and how the account was added. The value is `pat` for now.

```text
*<name>	<email>	pat
 <name>	<email>	pat
```

With no default account, the last line is:

```text
No default account. Calls must name one, or use "all".
```

With no accounts, the output is one line:

```text
No accounts yet. Add one in a terminal with: multi-account-supabase-mcp add <name> --pat
```

Exit 0. An argument gives a usage error with exit 2. The output never holds a token.

## default

```text
multi-account-supabase-mcp default <name>
```

Makes the account the default. On success it prints:

```text
Default account: <name>
```

An unknown name prints `Error: No account named "<name>".` and exits 1. A missing or extra argument is a usage error with exit 2.

## remove

```text
multi-account-supabase-mcp remove <name> [--yes]
```

Removes the account record and the token stored for it on this machine. The Supabase token is not revoked. See [ACCOUNTS.md](ACCOUNTS.md).

- In a terminal, without `--yes`, the command asks:

  ```text
  Remove the account <name> and its stored token? Type y to remove: 
  ```

  Only `y` or `yes`, in any letter case, removes the account. Any other answer prints `Nothing was removed.` and exits 0.
- `--yes` removes without asking.
- Without a terminal and without `--yes`, the command is refused. It prints `remove needs --yes when there is no terminal to ask in. Nothing was removed.` and exits 2.
- A name that has no record and no stored token is reported at once, with no question.

On success, it prints two lines:

```text
Removed "<name>".
The Supabase token still works until you revoke it in your Supabase account settings.
```

The second line is printed by the command. Not verified against Supabase: that the token still works after removal.

Errors, with exit 1:

- `Error: No account named "<name>".` The name has no record and no stored token.
- `Error: The stored token for "<name>" could not be read. Run: multi-account-supabase-mcp remove <name>`
- `Error: The account "<name>" was removed, but its stored token could not be deleted. Run: multi-account-supabase-mcp remove <name>`. When there was no record, the last line says `The stored token for "<name>" could not be deleted.` instead.
- `No answer could be read, so nothing was removed.` This is printed on stdout when the question gets no answer, such as after Ctrl+C.

## serve

```text
multi-account-supabase-mcp serve
```

Runs the MCP server over stdio. An agent starts this command. Stdout carries the protocol, so log lines go to stderr only. The command exits with 0 when the client closes its input.

With no command and no terminal, the program runs `serve` too. In a terminal, a run with no command prints the usage text and exits 0.

Serve takes no argument. An argument is a usage error with exit 2. Not verified: a run with a real client. See [MCP.md](MCP.md).

## help

```text
multi-account-supabase-mcp help
```

Prints the usage text on stdout and exits 0. `--help` and `-h` do the same. An argument is a usage error with exit 2.

## install

```text
multi-account-supabase-mcp install [agent...] [--scope <scope>] [--dry-run] [--yes]
```

Adds the server to the named agents. With no agent named, it uses all four: `claude`, `codex`, `opencode` and `antigravity`. The scopes each agent accepts are in [AGENTS.md](AGENTS.md).

- `--scope` takes `global`, `project` or `local`. The default is `global`. Any other value exits with 2 and prints `unknown scope; the scopes are global, project and local. Nothing was changed.`
- `--dry-run` prints the plan and changes nothing. It prints `Dry run: nothing was changed.` It exits 1 when the plan has an error line, and 0 otherwise.
- `--yes` applies the change without asking.

In a terminal, with no agent named and no `--yes`, the command asks these questions first:

```text
Which agents? Names separated by spaces, or blank for all: 
Which scope? global, project or local, or blank for global: 
```

The second question is asked only when `--scope` is not given. Then the command prints the plan, and asks:

```text
Apply these changes? [y/N] 
```

Only `y` or `yes`, in any letter case, applies the change. Any other answer prints `Nothing was changed.` and exits 0.

Without a terminal, `install` needs `--yes`. Without it, the command prints the plan, then this line, and exits 2:

```text
install needs --yes when there is no terminal, so nothing was changed.
```

The output has two parts:

- The plan: `Plan for the <scope> scope:`, then each command and file change, indented by two spaces. Then one row for each agent.
- The results, after `Results:`, for a real run.

Each row has the form `[<status>] <agent> <scope>: <message>`. The status is `ok`, `skipped` or `error`. Two cases:

- A plan with an error row is not applied, even with `--yes`. The command prints `The plan has an error, so nothing was changed. Fix the problem and run the command again.` and exits 1.
- A named agent that has no such scope stops the command before any change. For example, `antigravity has no project scope. Nothing was changed.` exits 1.

An unknown agent name gives `[error] agents: unknown agent; the agents are claude, codex, opencode, antigravity. Nothing was changed.` and exits 1.

Exit 0 when no row is an error. Exit 1 when a row is an error. Exit 130 when Ctrl+C stopped a real change. See [Interrupts](#interrupts).

## update

```text
multi-account-supabase-mcp update [agent...] [--scope <scope>] [--dry-run]
```

Runs again for each scope where a record lists the agent. It rewrites the entries so that they point at the program that runs `update`, and it records that path. Update takes no `--yes`, and it never asks a question. With `--yes`, the command prints `Usage error.`, then the usage text, and exits 2.

- Without `--scope`, it acts on the global scope, and on the project and local scopes of the current folder, where a record exists.
- A named agent with no record in a scope gets one skipped row for that scope: `[skipped] <agent> <scope>: no record in this scope, so nothing was changed.`
- When no agent has a record, the command prints `Nothing to update: no agent has a record in any scope.`, or `Nothing to update: no agent has a record in the <scope> scope.` when `--scope` is given. It exits 0.
- `--dry-run` prints the plan and changes nothing, as for install.

The plan, the rows and the exit codes work as they do for install. Update asks no questions.

## uninstall

```text
multi-account-supabase-mcp uninstall [agent...] [--scope <scope>] [--dry-run]
```

Removes what install recorded. It takes the same options as update, and it never asks a question. With `--yes`, it prints `Usage error.`, then the usage text, and exits 2.

It does not remove:

- the accounts or their tokens,
- the Claude Code marketplace. The command prints the command that removes it, for the same scope,
- the backup files that the installers made. The command names them.

With no record, it prints `Nothing to uninstall: no agent has a record in any scope.`, or the same line with `in the <scope> scope`. It exits 0.

## doctor

```text
multi-account-supabase-mcp doctor
```

Checks three things, and prints one row for each check:

- Each agent's own check.
- Each recorded command line path, in each scope that has a record. The path must still exist. A row says `The command line program is at <path>.` when it does, and `cliPath does not exist: <path>. Run update to refresh it.` when it does not.
- Each account. A row says `[ok] account <name>: a token is in the store.` when a token is in the credential store. It says `[error] account <name>: no token in the store.` when there is none, and `[error] account <name>: the token could not be checked.` when the store fails.

If the accounts file cannot be read, one row says `[error] accounts: <reason>`. The reason is the same one the accounts file gives. For a project or local scope, the row's label names the folder.

`doctor` reads only whether a token is present. It never prints a token. It takes no argument. Exit 0 when no row is an error, and 1 otherwise.

## Interrupts

Ctrl+C has two effects during a real change. A dry run is not affected.

- The first Ctrl+C asks the command to stop. The step that is running finishes. The steps after it do not run. If a step had started, the command prints `Stopped by Ctrl+C. The step that was running finished, and the steps after it did not run. Run multi-account-supabase-mcp uninstall --dry-run to see what is recorded.` If no step had started, it prints `Stopped by Ctrl+C before any step started, so nothing was changed.` Both lines go to stdout, and the exit code is 130.
- A second Ctrl+C exits at once with 130. It prints this line on stderr: `Stopped by Ctrl+C. If a change had started, it may be partly made. Check the agent's own configuration, and run multi-account-supabase-mcp uninstall --dry-run to see what is recorded.`

Ctrl+C at a question during install stops the command with exit 1, and prints `No answer could be read, so nothing was changed.` (not verified in a real terminal).
