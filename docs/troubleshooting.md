# Troubleshooting

## Exit codes

| Code | Meaning | Examples |
| --- | --- | --- |
| 0 | The command ran, and no step failed. | An install that worked. A dry run with no error line. A plan you answered no to. An update or uninstall with nothing to do. |
| 1 | A step failed, or the command could not finish. | An agent's command is not on PATH. An install plan has an error line, so nothing was applied. A state file cannot be read. A listing failed. A named agent lacks the scope. An unknown agent name. The command stopped with an unexpected error. No answer could be read at a question, which includes Ctrl+C at "Which agents?", "Which scope?" or "Apply these changes?". |
| 2 | The command line is wrong. Nothing ran. | A name that has the shape of a token, for `add`, `default`, `remove`, `install`, `update` and `uninstall`, or an unknown command. The name is not printed. An option the command does not use, such as `--yes` on `update`. A missing or repeated value after `--scope`. An unknown scope. `install` with no terminal and no `--yes`. Any argument to `doctor`. |
| 130 | Ctrl+C at any other time while an install, update or uninstall that is not a dry run is running. | The command prints the notice and stops. A change may be partly made. Not verified in a real terminal. |

Installer plans and results are printed on stdout. Usage errors and the Ctrl+C notice are printed on stderr. A usage error prints `Usage error.` and then the usage text. Text that contains `sbp_` is never printed.

## Problems and fixes

### `claude is not on PATH, so the plugin cannot be installed in this scope.`

The `claude` command was not found. The install does not run for that agent, and the plan is an error, so nothing is applied. Install Claude Code, open a new terminal, and run the command again. Or name only the agents you have.

The check reads the PATH entries that are absolute paths. A relative entry on PATH is ignored. On Windows, an `.exe` is found before a `.cmd` or `.bat` file.

Uninstall and doctor do not stop for a missing program. They print `skipped` and leave the record in place, so a later run can finish the work.

### `codex is not on PATH, so nothing was changed.` and `agy is not on PATH, so nothing was changed.`

The same as above, for Codex and Antigravity. The project scope for Codex does not run `codex`, so it does not need `codex` on PATH.

### `Codex already lists a server named multi-account-supabase that this tool did not write, so nothing was changed.`

An entry with this name is already in Codex. The installer will not take it over. Check the entry with `codex mcp list` (not verified: this command form). Remove it with Codex's own command if you do not need it, then run install again.

### `agy already lists multi-account-supabase, but the record does not list it, so nothing was changed.`

The same case for Antigravity. Remove the entry with `agy mcp remove multi-account-supabase` (not verified: this command form) if you do not need it, then run install again.

### `... already has an entry named "multi-account-supabase" under "mcp" that this tool did not write, so nothing was changed.`

The same case for opencode. Edit the file yourself, or move the entry, then run install again. The file name and the layout are ASSUMED, not verified. See `docs/install.md`.

### `... already has the table mcp_servers.multi-account-supabase, which this tool did not write, so nothing was changed.`

The same case for the Codex project file.

### Claude Code plugin already installed

Install does not check for an existing Claude Code plugin with this name, so it does not refuse one. It runs `claude plugin install` again (not verified: this command form), and the result is what claude reports. See `SECURITY.md`, section 7.

### `... is not valid JSON, so nothing was changed.`, `... is not valid TOML, so nothing was changed.`, `... has unexpected contents, so nothing was changed.`

The installer will not edit a file it cannot read. Fix the file by hand, then run the command again. The installer never prints the contents of the file.

### `The agent state file cannot be read, so nothing was changed: <file> (<reason>)`

The record that this tool keeps for an agent cannot be read. The record is in the data folder, in the `state` folder, one file for each agent: `claude.json`, `codex.json`, `opencode.json` and `antigravity.json`. The reason is `not valid JSON`, `unexpected contents`, `read failed` (when the error has no code), or a system error code such as `EACCES`.

For install, the command stops before it changes anything. For update and uninstall, that agent gets an error line and is not changed, and the other agents in the same command still change. Keep a copy of the file, and do not edit it unless you know its format. If you move the file aside, this tool forgets the entries it wrote for that agent. Remove those entries with the agent's own command, or edit the agent's file by hand. Not verified: the agent's own removal wording.

### `The listing of codex mcp list failed (...)` and `agy mcp list failed, so nothing was changed: ...`

The check before an install could not read the agent's list of servers, so the install stopped. Run `codex mcp list` (not verified: this command form) or `agy mcp list` (not verified: this command form) yourself to see the error. The listing format is not verified, so the installer's reading of the listing may also be wrong.

### `The plan has an error, so nothing was changed. Fix the problem and run the command again.`

One step in the plan is an error. For install, the installer does not apply a plan with an error line, even with `--yes`. Update and uninstall do not hold back the other agents for an error line: each error line is printed, and the other agents still run. Read the `[error]` line above it, fix that problem, and run the command again.

### `install needs --yes when there is no terminal, so nothing was changed.`

Install asks questions only in a terminal window. Run the command in a terminal, or add `--yes`. A `--dry-run` works without a terminal.

### `Usage error.` after `update --yes` or `uninstall --yes`

The command line parser refuses `--yes` for `update` and `uninstall` before the command runs. The output is `Usage error.` and the usage text, and the exit code is 2. `--yes` is for install only. Remove it. `update` and `uninstall` never ask questions.

### `Usage error.`

The command line uses an option that the command does not take, a missing value, or a value that repeats. Run `multi-account-supabase-mcp help`. The options for install, update and uninstall are `--scope <scope>`, `--dry-run` and `--yes`. `--yes` is for install only. `doctor` takes no option.

### `unknown scope; the scopes are global, project and local. Nothing was changed.`

Use one of the three scope names. See `docs/scopes.md`.

### `unknown agent; the agents are claude, codex, opencode, antigravity. Nothing was changed.`

Check the agent name. The four names are `claude`, `codex`, `opencode` and `antigravity`.

### `antigravity has no project scope. Nothing was changed.`

You named an agent that does not support the scope. See `docs/scopes.md`.

### `The command line program path must be absolute and written as path.resolve writes it, so nothing was changed.`

The path of the program that runs install is not in the form this tool needs. Run the command again from the installed program, or from the checkout with `node dist/cli.js`.

### `cliPath does not exist: <path>. Run update to refresh it.`

`doctor` found that the command line program recorded for a scope no longer exists. The program was moved or removed. Run `update` from the new location of the program, so the record names the new path.

### `Nothing to update: no agent has a record in any scope.` and `Nothing to uninstall: ...`

No record exists for the agents you named, or for any agent. Check the folder. A project or local record is kept under the folder where you installed it. See `docs/scopes.md`.

### `The marketplace is still registered.`

This line is printed on purpose. Uninstall does not remove the Claude Code marketplace. Run the command that the step prints, when no other plugin needs the marketplace.

The `remove` command for an account is a different command. It prints that the Supabase token still works until it is revoked in your Supabase account settings. This tool does not revoke tokens.

### `The marketplace was added and is still registered.`

Install added the Claude Code marketplace, and then the plugin install failed. The marketplace stays. Run the removal command that the step prints, or run install again after the problem is fixed. Not verified: the cause of the plugin failure, since the Claude Code plugin is not built yet.

### `The folder <dir> holds <file>, and cmd.exe searches that folder before PATH. Nothing was run.`

On Windows, a `.cmd` shim, such as the npm shim for an agent, runs through `cmd.exe`. `cmd.exe` searches the current folder before PATH. A `node` program in the folder could run in place of the real one, so the command is refused. Run the install from another folder. The folder that is checked is the folder the command runs in. For `claude` with the project or local scope, that is the project folder.

### `The folder <dir> cannot be read, so it cannot be checked for a node program. Nothing was run.`

The same check, when the folder cannot be read. Check its permissions, or run the command from another folder.

### `timed out after 120 seconds`

An agent's command ran longer than two minutes, and the installer ended it. Run the command yourself to see what it waits for. On Windows the whole process tree is ended. On other systems only the command itself is ended, so a program that it started may keep running. Not verified on other systems.

### `Stopped by Ctrl+C. If a change had started, it may be partly made. Check the agent's own configuration, and run multi-account-supabase-mcp uninstall --dry-run to see what is recorded.`

Install, update or uninstall was stopped by Ctrl+C while it was not waiting for an answer, and it was not a dry run. The exit code is 130. Check the agent's own configuration, then run `multi-account-supabase-mcp uninstall --dry-run`. The dry run shows what this tool still records. Not verified in a real terminal.

### `The command stopped before it finished: ...`

An unexpected error stopped the command. Nothing after the error ran. Run `doctor`, then the command again.

### `No answer could be read, so nothing was changed.`

The question could not be answered, for example because the input was closed. Ctrl+C at "Which agents?", "Which scope?" or "Apply these changes?" gives this line too. The exit code is 1, and no change was made at that point. Not verified in a real terminal. Run the command again in a terminal.

### doctor prints `skipped` for a listing

`claude plugin list failed for the ... scope, so the plugin was not checked.` means the listing command failed. Not verified: the Claude Code listing format. A listing that does not show a scope is reported as not confirmed.

### doctor prints `error` for `account <name>: no token in the store.`

The account has a record but no token on this machine. Remove the account and add it again in a terminal with `add <name> --pat`. See `README.md`.

### The server does not find the accounts file

The entries do not set the variable `MULTI_ACCOUNT_SUPABASE_HOME`. If you set it to move the data folder, check that the agent passes it to the server. Not verified: how each agent passes its environment to a server.
