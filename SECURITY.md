# Security

This file says what multi-account-supabase-mcp protects, how it handles tokens, what the official server receives, what the agent can see, and what it does not protect.

## 1. Scope

The tool protects three things: the Supabase personal access token of each account, the accounts file, and the configuration of each agent that the installers change. The installers change only what their record lists. See section 7.

It is for one person on one machine. It protects the tokens in these ways:

- A token is never printed.
- A token is never written to the accounts file.
- A token is never sent to a child process other than the one for its own account.
- A token is never put in a reply to the agent.

It does not protect against a program that runs as the same user. See section 6.

## 2. How the token is handled

- The token is typed into a terminal window, with hidden input. The prompt is written to stderr. The tests read the typed input through a fake, so the hidden input has not been checked in a real terminal window.
- The token is never printed. If the add command fails, the typed token is removed from the message and from the cause of the error before anything is shown.
- The token is never written to the accounts file. The file holds five fields for each account: the name, the email, the Supabase user id, how the account was added, and the time it was added.
- The token is stored in the operating system's credential store, through the `@napi-rs/keyring` package. Each account has one entry, under the service name `multi-account-supabase-mcp`, with the account name as the key. The real credential store has not been run on any system. The automated tests use a fake store.
- A command line that has a name containing `sbp_` in any letter case is refused with exit code 2, and the text is never printed. The names are the account name for `add`, `default` and `remove`, the agent names for `install`, `update` and `uninstall`, and an unknown command. Any other extra argument is a usage error, also with exit code 2, and it is not printed.
- When the accounts file cannot be read, or does not have the expected shape, the error names the file and the reason only. The reason is a system error code, such as `EACCES`, or one of three fixed phrases: `read failed`, `not valid JSON` or `unexpected contents`. The error never shows the file's content.

## 3. What the child processes receive

Each account has an official server running as a child process. Each child gets only the token of its own account. The token is given in the environment variable that the official server reads, `SUPABASE_ACCESS_TOKEN`.

The child environment is an allowlist. Only these names are copied from the parent, and only when the parent has them: `PATH`, `Path`, `PATHEXT`, `SYSTEMROOT`, `SystemRoot`, `TEMP` and `TMP`. Every other name in the SDK's default list is not passed to the child, except the Windows names in the next part. On macOS and Linux, that list includes `HOME`, `LOGNAME`, `SHELL`, `TERM` and `USER`. Those names are not passed on macOS and Linux. This was read in the code. It was not run there.

The placeholder child, which serves `search_docs`, and the catalog child, which lists the tools, get a fixed placeholder value. The placeholder is not a real token. An account child never gets the placeholder. With no account registered, neither child starts, because every call except `account_list` is refused first.

On Windows, the process start adds eight system variables back when they are missing from the environment given to a child (not verified: the names reaching the child in a live run were not checked; the list is in a code comment, and no test checks it):

- `HOMEDRIVE`
- `HOMEPATH`
- `LOGONSERVER`
- `SYSTEMDRIVE`
- `USERDOMAIN`
- `USERNAME`
- `USERPROFILE`
- `WINDIR`

None of them is a credential. Not verified here: whether a child process on Windows receives these names. The check that would show it, a child process started with the environment that the code builds, was not run for this document, and no output exists for it. The names were read from the code only.

The token of an account is also in the environment of its child process while that process runs. The official server reads it from there. Whether another program running as the same user can read a process's environment has not been tested.

## 4. What the agent can see

- The agent receives every reply from Supabase, as the official server returns it. This tool does not filter or redact those replies. A reply can contain any data that Supabase returns, for example the result of a SQL query.
- The tool never puts an account token in a reply.
- The agent sees the account names and emails in `account_list`. With accounts, the description of the `account` argument lists the known names.
- The tool refuses a call that names no account for a change. It refuses a change that names several accounts. A read that names several accounts runs on each of them, and the replies come back together in one document.

## 5. Removing an account and revocation

`remove <name>` deletes the account record and the token stored on this machine. It does not revoke the token at Supabase. The Supabase token still works until you revoke it in your Supabase account settings. Not verified against Supabase. The tool has no command that revokes a token.

See the README section "Removing an account".

## 6. Known limits

- A program that runs as the same user may be able to read the credential store, and the environment of a child process. This is how operating systems normally work. It has not been tested here.
- A token that Supabase has revoked is found only when a call uses it. Not verified: what Supabase returns for a revoked token. The add command checks the token once, when the account is added.
- In the official build that this tool uses, destructive SQL and `apply_migration` run without a confirmation step. This tool adds no gate of its own. This was read in the official build's code. It was not checked with a live call.
- An accounts file that is edited by hand can name accounts. The tool still needs a stored token for each one. An account with no stored token is refused, and no child is started for it.
- A change that times out may still have run at Supabase. The reply says so.
- The continuous integration on Ubuntu is not set up yet.
- The installers have not been run against a real Claude Code, Codex, opencode or Antigravity. The commands they run, the Codex and Antigravity listings, the opencode file layout and the Codex skill folders are not verified. Some of these are ASSUMED, and the docs mark each one.

## 7. The installers

The `install`, `update`, `uninstall` and `doctor` commands add the server to four agents: Claude Code, Codex, opencode and Antigravity. Their rules:

- **No token is written.** The entries that this tool writes for Codex, opencode and Antigravity hold the program to run, its arguments, and, for opencode, a type and an enabled flag. They hold no token and no account name. The Claude Code plugin is not written by this tool. The token of each account stays in the credential store, and the server reads it there.
- **Only what the record lists is changed.** Each agent has a record of what this tool wrote, for each scope. Update and uninstall act only on the items that the record lists. A scope with no record gets no command. An agent that does not support a scope gets one skipped line with the reason, for each such scope, whether it was named or not. The one exception is a named agent that does not support the scope named with `--scope`: that refuses the whole command, with exit code 1, and nothing is changed. For install, the scope is always known, so the refusal applies to any named agent that lacks it. For update and uninstall, it applies only when `--scope` names the scope. For update and uninstall, a named agent with no record gets one skipped line for each scope where it has none, with or without `--scope`. An agent that is not named and has no record is not listed.
- **An edited entry or table is never removed or replaced.** For Codex and opencode, an entry is edited when its arguments are not the recorded command line program path followed by `serve`, when its command is not an absolute path, when it has an env key (Codex) or an environment or env key (opencode) whose value is not empty, or, for opencode, when its type or enabled flag differs (ASSUMED, not verified: the real CLI layout is not run). An empty environment table is not an edit, and other keys are ignored. A missing record of the program path makes the entry edited. The Node path in the command is not compared, so a changed Node path is not detected as an edit. Install, update and uninstall leave an edited entry in place with its record, the step is an error, and the exit is 1. Update rewrites an unedited entry with the current command and arguments. The way out is to delete the entry by hand, then run the command again.
- **An entry that this tool did not write is never taken over.** For Codex, opencode and Antigravity, install checks for an entry with the same name that the record does not list. For opencode and the Codex project file, the check reads the file. For Codex (global) and Antigravity, it reads the agent's list. If one exists, install refuses and changes nothing. Claude Code is different: install does not check for an existing plugin. Not verified: the Claude Code listing does not show a scope that this tool can verify, so no such check is made.
- **A file that cannot be parsed is refused.** A JSON or TOML file that does not parse, or that has an unexpected shape, stops the change. Nothing is written. The error names the file. It never shows the contents.
- **The records are JSON files in the data folder.** There is one file for each agent, in the `state` folder: `claude.json`, `codex.json`, `opencode.json` and `antigravity.json`. A record that cannot be read stops install, update and uninstall before any change. The error names the file and the reason, never the contents. Each record is changed under its own lock file, `<record file>.lock`.
- **An agent's list is read before an entry is added.** For Codex (global scope) and Antigravity, install reads the agent's list of servers before it adds this tool's entry, unless the record already lists the entry (not in a dry run). If the list cannot be read, install stops. If the list names the server, and the record does not list it, install refuses. The layout of those lists is ASSUMED, not verified.
- **Backups are kept and never overwritten.** Before an edit to a config file (the Codex project `config.toml`, or opencode's `opencode.json`; names ASSUMED, not verified), the installer writes a copy next to it, named `<file>.bak`, then `<file>.bak2`, `<file>.bak3`, and so on, using the first free name. Uninstall keeps every backup and names it. It never removes one. A `SKILL.md` file is different: it is replaced without a backup, and only when the record lists it as created by this tool. A `SKILL.md` that this tool did not write is never replaced.
- **The Claude Code marketplace stays after uninstall.** Install adds the marketplace `multi-account-supabase-mcp` with `claude plugin marketplace add` (not verified: this command form), in the same scope as the plugin. Uninstall never removes it, because other plugins may use it. Its step prints the command that removes it, with the scope the marketplace was added in (not verified: this command form):

  ```
  claude plugin marketplace remove multi-account-supabase-mcp --scope <user, project or local>
  ```

  For the project and local scopes, run it in the project folder. Run it only when no other plugin needs the marketplace.
- **The `-y` flag on the Claude Code plugin.** Install and update pass `-y` to `claude plugin install` and `claude plugin update`. The flag lets a command that a marketplace declares run without a prompt (not verified: how claude treats `-y`). This marketplace must declare no command, so `-y` accepts none (not verified). Not verified: how claude treats `-y` here. The reading comes from its help output. A later release of this package must keep it so. Open until the plugin exists. Not verified: how the claude command decides which commands a marketplace declares.
- **Folders.** A folder that an install makes is recorded. Uninstall removes a recorded folder only when it is empty. It never removes a folder that the record does not list.
- **Commands run without a shell.** The installers start `claude`, `codex` and `agy` with fixed arguments, and no shell reads them. The one exception is a Windows `.cmd` or `.bat` file, which runs through `cmd.exe`. Only for such a file, the path and each argument are checked before the command starts. A path or argument that holds a double quote, a percent sign, an exclamation mark, an ampersand, a pipe, a less-than or greater-than sign, a caret, a line break or a NUL character, or an argument that ends with a backslash, is refused, and nothing runs. An `.exe` file gets no such check, because Node quotes its arguments. A NUL character in the command name or in any argument is refused for every command, `.exe` files included, and nothing runs.
- **A shim can start a node program in its folder.** On Windows, an npm shim runs through `cmd.exe`. `cmd.exe` searches the current folder before PATH. So a node program in the folder where the command runs could run in place of the real one. Before such a shim runs, the runner reads the file names in that folder. It refuses to run the shim when the folder holds a node program, and when the folder cannot be read. It reads only the names.
- **The agents' commands get the full environment of the installer.** Unlike the server's child processes (section 3), the commands that `claude`, `codex` and `agy` run inherit every variable of the installer's environment. A variable that you set in your shell is visible to them. On Windows, the process start adds the eight names listed in section 3 when a child's environment lacks them. The installers' commands inherit the installer's environment, which normally has them already. The installers set no token variable. The commands get no input. A command that asks a question reads end of file, and does not wait.
- **A command that runs too long is ended.** A command that runs longer than two minutes is ended. On Windows, its whole process tree is ended. On other systems, only the command itself is ended, so a program that it started may keep running. Not verified on other systems.
- **doctor reads tokens only to see that they exist.** It checks whether each account has a token in the credential store. It prints one line for each account: a token is present, no token is present, or the token could not be checked. It never prints a token.
- **The installers do not start the server.** The server starts when an agent starts the entry it was given.

The installers print paths, file names, and the message of each step. When a command fails, the first line of its error output, or of its standard output, is printed. Every printed installer line, including a plan row, a step line and a reason, shows text of the token shape as `[redacted]`. The token shape is `sbp_` followed by letters, digits, underscores or hyphens, in any letter case. A bare `sbp_` with nothing after it does not match, so it is printed. The contents of a file, a token and the output of a successful listing are not printed.

## 8. Reporting a problem

The project is not published yet. Report a suspected security problem in the repository that publishes this project, `FiredMosquito831/multi-account-supabase-mcp`. That repository is not created yet (not verified: checked on 2026-10-20 only), so there is no public place for a report until it exists. Do not send a token, or a file that holds a token, in any message.
