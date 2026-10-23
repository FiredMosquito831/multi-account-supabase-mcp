# Install guide

This guide shows how to add the server to each agent with the install commands. Read `docs/AGENTS.md` for the scopes, and `docs/TROUBLESHOOTING.md` when a step fails.

## Before you start

- Node 22 or newer.
- The package is not published yet. Not verified: the install from npm. The examples use the command `multi-account-supabase-mcp`, which the package provides. Until the package is installed, run the same commands as `node dist/cli.js` from the checkout, after `npm run build`.
- Add at least one account before you use the server: `multi-account-supabase-mcp add <name> --pat`. Installing does not need an account, but the server refuses every call except `account_list` until an account exists. See `README.md`.
- Run the install commands in a terminal window. A terminal lets the command ask questions. Without a terminal, add `--yes`.
- Each install, update and uninstall command prints its plan before it changes anything. `--dry-run` prints the plan and changes nothing. In a terminal, a dry run also asks which agents, and which scope when `--scope` is not given, when no agent is named and `--yes` is not given. It still changes nothing.

## What an agent's entry starts

For Codex, opencode and Antigravity, the entry starts the server with the Node program that ran the command, the command line program of this package, and the word `serve`. For example, `node <path to dist/cli.js> serve`. The entry holds no token. The token of each account stays in the credential store, and the server reads it from there. Claude Code gets the server from its plugin. The plugin is in this repository, and it is not published yet (checked on 2026-10-20 only; see the Claude Code section).

The record keeps the path of the command line program that ran the install. If that program moves, run `update` from its new location. `doctor` checks that the recorded command line program still exists. It does not check the Node program.

The entry does not set `MULTI_ACCOUNT_SUPABASE_HOME`. See "The server does not find the accounts file" in `docs/TROUBLESHOOTING.md`.

## One command for all agents

In a terminal, with no agent named and no `--yes`, the command asks two questions. A `--dry-run` asks the same two questions, and it still changes nothing:

```
multi-account-supabase-mcp install
```

- `Which agents?` Names separated by spaces or commas. A blank answer means all four agents.
- `Which scope?` `global`, `project` or `local`. A blank answer means `global`. This question is asked only when `--scope` is not given, and when no agent is named.

After the plan prints, the command asks `Apply these changes? [y/N]`. Only `y` or `yes`, in any letter case, applies the plan. Ctrl+C at any of the three questions stops the command with exit code 1, and no change is made. Not verified in a real terminal.

Other forms:

```
multi-account-supabase-mcp install --dry-run
multi-account-supabase-mcp install claude codex --scope project
multi-account-supabase-mcp install --yes
```

- `--yes` applies the plan without a question. Without a terminal, install needs `--yes`.
- With `--yes` and no agent named, all four agents are used in the global scope.
- If any step in the plan is an error, nothing is applied, even with `--yes`. Name only the agents you have. For example, if `claude` is not on PATH, run `install codex opencode antigravity --yes`.

## Claude Code (`claude`)

Scopes: global, project and local.

This part describes the installer route. The manual route, which adds the plugin inside Claude Code, is at the end of this part.

Requirement: the `claude` command must be on PATH. The check runs in a dry run too.

What install runs, for the scope (not verified: these command forms):

1. `claude plugin marketplace add FiredMosquito831/multi-account-supabase-mcp --scope <user, project or local>`
2. `claude plugin install multi-account-supabase@multi-account-supabase-mcp --scope <user, project or local> -y`

The `-y` flag makes the plugin install run without a prompt (not verified). Not verified: how claude treats -y here. The reading comes from its help output. A marketplace can declare a command that `-y` would accept (not verified). This marketplace must declare none. A later release of this package must keep it so.

The global scope passes `--scope user`. The project and local scopes run the commands in the project folder.

Not verified: the marketplace repository. It has not been created (checked on 2026-10-20 only), so the marketplace add is expected to fail until it exists. The plugin files are in this repository. Until the repository exists, the Claude Code step fails. Not verified: how the claude command responds to these commands. The install has not been run against a real Claude Code.

Install does not check for an existing plugin with this name, so it does not refuse one. Not verified: the Claude Code listing does not show a scope that this tool can verify. See `SECURITY.md`, section 7.

Update runs `claude plugin update multi-account-supabase@multi-account-supabase-mcp --scope <...> -y` for a scope that has a record. Not verified: this command form.

Uninstall runs `claude plugin uninstall multi-account-supabase@multi-account-supabase-mcp --scope <...>` (not verified). It does not remove the marketplace. The step prints the command that removes it:

- Global: `claude plugin marketplace remove multi-account-supabase-mcp --scope user` (not verified: this command form)
- Project: `claude plugin marketplace remove multi-account-supabase-mcp --scope project` (not verified: this command form), run in the project folder
- Local: `claude plugin marketplace remove multi-account-supabase-mcp --scope local` (not verified: this command form), run in the project folder

Run that command only when no other plugin uses the marketplace.

When claude's failed output has a line that says "not installed" and names the plugin id, uninstall treats the plugin as absent and clears the record (ASSUMED, not verified: that wording). Any other failure keeps the record, so a later uninstall can try again.

Doctor runs `claude plugin list --json` (not verified: this command form) and looks for the plugin id `multi-account-supabase@multi-account-supabase-mcp` as a whole word. Not verified: the listing format. The listing has no scope field that is verified, so doctor says the scope is not confirmed.

### Plugin route, by hand

Use this route to add the plugin inside Claude Code. The installer does not use it. The installer's `update`, `uninstall` and `doctor` act only on what the tool recorded, so they do not act on a plugin added this way (`src/agents/claude.ts`, lines 191, 227 and 298). The installer's `install` does not check for a plugin added this way. It runs `claude plugin install` (`src/agents/claude.ts`, line 158). What `claude plugin install` does with a plugin that is already installed is not verified.

In Claude Code, run these two commands (not verified: the Claude Code interface was not run):

```
/plugin marketplace add FiredMosquito831/multi-account-supabase-mcp
/plugin install multi-account-supabase@multi-account-supabase-mcp
```

- The marketplace repository must exist first. It has not been created (checked on 2026-10-20 only).
- The marketplace add names no branch and no release. Claude Code is expected to read the default branch (ASSUMED, not verified). Whether Claude Code accepts a release ref is OPEN.
- The plugin's server key is `supabase`, so its tools are expected to read `plugin:multi-account-supabase:supabase` (not verified).
- The server starts through the launcher. It runs the installed command when that is on PATH, and otherwise `npx` with the plugin's version. The package is not published (checked on 2026-10-20 only). See "Claude Code plugin" in `README.md`.
- Add an account in a terminal window of your own, with `multi-account-supabase-mcp add <name> --pat`, as in `README.md`.

## Codex (`codex`)

Scopes: global and project.

### Global

Requirement: the `codex` command must be on PATH.

Install runs `codex mcp add multi-account-supabase -- <Node program> <command line program> serve` (not verified: this command form). When the record does not list the entry, install runs `codex mcp list` (not verified: this command form) before it adds the entry. A dry run does not run that listing. If the listing cannot be read, install stops. If the listing names `multi-account-supabase` as a whole word, and this tool did not write it, install stops and changes nothing (ASSUMED, not verified: the layout of the listing). When the record lists the entry, install first checks it. The check reads the Codex configuration file (ASSUMED, not verified: `codex mcp add` writes the entry there). If the entry was edited, install refuses it: the entry is left in place, the record is kept, and the step is an error, so the exit is 1. An entry is edited when its arguments are not the recorded command line program path followed by `serve`, when its command is not an absolute path, or when it has an env key whose value is not an empty table (ASSUMED, not verified: the real layout of the entry is not run). An empty `env` table is not an edit, and other keys are ignored. A missing record of the program path makes the entry edited. A changed Node path is not detected as an edit. Update rewrites an unedited entry with the current command and arguments. The way out is to delete the entry by hand, or to run `codex mcp remove multi-account-supabase` (not verified: this command form), and then run this command again. If the entry was not edited, install first runs `codex mcp remove multi-account-supabase` (not verified: this command form), and then adds it again.

Install also writes a skill file, `skills/supabase-accounts/SKILL.md`, in the Codex home folder. The Codex home folder is the `CODEX_HOME` variable, or `.codex` in your home folder when `CODEX_HOME` is not set. The location is ASSUMED, not verified: Codex reads user skills from that folder. ASSUMED: Codex has no command for installing skills, so this tool writes the file itself. The help text read for this covers `codex mcp` only. The skill file is replaced without a backup, and only when this tool created it. A skill file that this tool did not write is never replaced.

Uninstall runs `codex mcp remove multi-account-supabase` (not verified: this command form), then removes the skill file. If the output of that command has a line with the server name and the words "not found", "not installed", "does not exist", "no such" or "no mcp server", uninstall treats the server as absent and clears the record (ASSUMED, not verified: that wording). Any other failure keeps the record, so uninstall can try again. If the entry was edited, uninstall leaves it in place, keeps the record, and the step is an error. The way out is the same as in the install section. It removes the folders that this tool made, when they are empty.

### Project

Requirement: the project folder must exist. Install does not create it. The `codex` command is not used for the project scope.

Install adds this table to `.codex/config.toml` in the project folder (ASSUMED, not verified: that Codex reads this path):

```
[mcp_servers.multi-account-supabase]
```

- If the file exists, a backup is made first, as `config.toml.bak`, or `config.toml.bak2` when that name is taken. The backup is kept on uninstall.
- If the file does not parse as TOML, install refuses it and changes nothing.
- If the file already has the table, and this tool did not write it, install refuses.
- If this tool wrote the table and it was edited since, install, update and uninstall leave it in place with its record, and the step is an error, so the exit is 1. The table is edited when its arguments are not the recorded command line program path followed by `serve`, when its command is not an absolute path, or when it has an env key whose value is not an empty table (ASSUMED, not verified: the real layout of the table is not run). A changed Node path is not detected as an edit. The way out is to delete the table `[mcp_servers.multi-account-supabase]` from `.codex/config.toml` (ASSUMED, not verified: the path) by hand, then run the command again.
- The other tables in the file keep their text.

Install also writes the skill file to `.agents/skills/supabase-accounts/SKILL.md` in the project folder. The location is ASSUMED, not verified: Codex reads project skills from that folder. The skill file is replaced without a backup, and only when this tool created it. A skill file that this tool did not write is never replaced.

ASSUMED, not verified: Codex reads the project file only when the folder is trusted.

## opencode

Scopes: global and project.

Requirement: none. Install edits opencode's JSON file directly, and it does not run the `opencode` command. Not verified: that opencode reads the file as this guide says. The file name and the layout of the entry are ASSUMED.

- Global file: `opencode.json`, in opencode's configuration folder (file name and folder ASSUMED, not verified). The folder is `.config` and then `opencode` in your home folder (ASSUMED, not verified). If the `XDG_CONFIG_HOME` variable is set to an absolute path, that path replaces `.config` (ASSUMED, not verified). The default folder was seen on one development machine (ASSUMED, not verified). Not verified on other machines.
- Project file: `opencode.json` in the project folder (file name ASSUMED, not verified). The project folder must exist. Install and update refuse it when it does not exist, and never create it. Uninstall never removes it.

The entry sits under the key `mcp`, with the name `multi-account-supabase`. It has `type` set to `local`, `command` as a list that holds the Node program, the command line program and `serve`, and `enabled` set to `true`. The layout is ASSUMED, not verified with opencode.

Install refuses a file that is not valid JSON, a file whose top level or `mcp` value is not an object, a file that repeats a key, and an entry under the same name that this tool did not write.

Before it changes an existing file, install makes a backup, `opencode.json.bak`, or `opencode.json.bak2` when that name is taken. Uninstall keeps every backup. The file is written again as a whole, so the indentation and the line endings may change. The backup keeps the old bytes.

If this tool wrote the entry and it was edited since, install, update and uninstall leave it in place with its record, and the step is an error, so the exit is 1. An entry is edited when its arguments are not the recorded command line program path followed by `serve`, when its command is not an absolute path, when its type or enabled flag is not the one this tool writes, or when it has an environment or env key whose value is not empty (ASSUMED, not verified: the real layout of the entry is not run). An undefined, null, empty or empty-table value counts as empty, and other keys are ignored. A missing record of the program path makes the entry edited. A changed Node path is not detected as an edit, and update rewrites the entry with the current command. The way out is to delete the entry named `multi-account-supabase` by hand from the `mcp` section of the opencode file, then run the command again. The file and the layout are ASSUMED, not verified.

## Antigravity (`antigravity`)

Scopes: global only.

Requirement: the `agy` command must be on PATH. The check runs in a dry run too.

Install runs `agy mcp list` first (not verified: this command form), unless the entry is already recorded. If the listing names `multi-account-supabase`, and this tool did not write it, install stops and changes nothing. Then install runs `agy mcp add multi-account-supabase <Node program> <command line program> serve` (not verified: this command form). The listing format is not verified.

Update removes the entry and adds it again. Uninstall runs `agy mcp remove multi-account-supabase` (not verified: this command form). Not verified: the wording agy uses when an entry is absent. The uninstall step treats some wording as "not installed" (ASSUMED, not verified: the wording agy uses). Other failures keep the record, so a later uninstall can try again.

The location of the entry is ASSUMED: agy keeps it in its own configuration, which this tool does not read.

## After install

- Restart the agent if it was open. Not verified: which agents read the new entry only after a restart.
- Run `multi-account-supabase-mcp doctor`. It checks the recorded paths, each agent's record and each account's token.
- Run `multi-account-supabase-mcp install --dry-run` to see what a change would do.

## Uninstall

```
multi-account-supabase-mcp uninstall
multi-account-supabase-mcp uninstall codex --scope project
```

Uninstall removes what install recorded, and nothing else. It does not remove:

- the accounts, or their tokens,
- the Claude Code marketplace, which prints the command that removes it,
- backup files, which are named in the step.

The tool records each folder it creates. Uninstall removes a folder that this tool made only when the folder is empty.
