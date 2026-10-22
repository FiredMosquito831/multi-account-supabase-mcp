# Install guide

This guide shows how to add the server to each agent with the install commands. Read `docs/scopes.md` for the scopes, and `docs/troubleshooting.md` when a step fails.

## Before you start

- Node 22 or newer.
- The package is not published yet. Not verified: the install from npm. The examples use the command `multi-account-supabase-mcp`, which the package provides. Until the package is installed, run the same commands as `node dist/cli.js` from the checkout, after `npm run build`.
- Add at least one account before you use the server: `multi-account-supabase-mcp add <name> --pat`. Installing does not need an account, but the server refuses every call except `account_list` until an account exists. See `README.md`.
- Run the install commands in a terminal window. A terminal lets the command ask questions. Without a terminal, add `--yes`.
- Each install, update and uninstall command prints its plan before it changes anything. `--dry-run` prints the plan and changes nothing.

## What an agent's entry starts

For Codex, opencode and Antigravity, the entry starts the server with the Node program that ran the command, the command line program of this package, and the word `serve`. For example, `node <path to dist/cli.js> serve`. The entry holds no token. The token of each account stays in the credential store, and the server reads it from there. Claude Code gets the server from its plugin, and the plugin is not built yet (see the Claude Code section).

The record keeps the path of the command line program that ran the install. If that program moves, run `update` from its new location. `doctor` checks that the recorded command line program still exists. It does not check the Node program.

## One command for all agents

In a terminal, with no agent named and no `--yes`, the command asks two questions:

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

Requirement: the `claude` command must be on PATH. The check runs in a dry run too.

What install runs, for the scope (not verified: these command forms):

1. `claude plugin marketplace add FiredMosquito831/multi-account-supabase-mcp --scope <user, project or local>`
2. `claude plugin install multi-account-supabase@multi-account-supabase-mcp --scope <user, project or local> -y`

The `-y` flag makes the plugin install run without a prompt. Not verified: how claude treats -y here. The reading comes from its help output. A marketplace can declare a command that `-y` would accept. This marketplace must declare none. A later release of this package must keep it so.

The global scope passes `--scope user`. The project and local scopes run the commands in the project folder.

Not verified: the marketplace repository. It has not been created, so the marketplace add is expected to fail until it exists. The Claude Code plugin is not built yet. Until both exist, the Claude Code step fails. Not verified: how the claude command responds to these commands. The install has not been run against a real Claude Code.

Install does not check for an existing plugin with this name, so it does not refuse one. Not verified: the Claude Code listing does not show a scope that this tool can verify. See `SECURITY.md`, section 7.

Update runs `claude plugin update multi-account-supabase@multi-account-supabase-mcp --scope <...> -y` for a scope that has a record. Not verified: this command form.

Uninstall runs `claude plugin uninstall multi-account-supabase@multi-account-supabase-mcp --scope <...>` (not verified). It does not remove the marketplace. The step prints the command that removes it:

- Global: `claude plugin marketplace remove multi-account-supabase-mcp --scope user` (not verified: this command form)
- Project: `claude plugin marketplace remove multi-account-supabase-mcp --scope project` (not verified: this command form), run in the project folder
- Local: `claude plugin marketplace remove multi-account-supabase-mcp --scope local` (not verified: this command form), run in the project folder

Run that command only when no other plugin uses the marketplace.

When claude's failed output has a line that says "not installed" and names the plugin id, uninstall treats the plugin as absent and clears the record. That wording is ASSUMED, not verified. Any other failure keeps the record, so a later uninstall can try again.

Doctor runs `claude plugin list --json` (not verified: this command form) and looks for the plugin id `multi-account-supabase@multi-account-supabase-mcp` as a whole word. Not verified: the listing format. The listing has no scope field that is verified, so doctor says the scope is not confirmed.

## Codex (`codex`)

Scopes: global and project.

### Global

Requirement: the `codex` command must be on PATH.

Install runs `codex mcp add multi-account-supabase -- <Node program> <command line program> serve` (not verified: this command form). Before it adds the entry, install runs `codex mcp list` (not verified: this command form), unless this tool already recorded the entry. When the record lists the entry, install first runs `codex mcp remove multi-account-supabase` (not verified: this command form), and then adds it again. If the listing cannot be read, install stops. If the listing already names `multi-account-supabase`, and this tool did not write it, install stops and changes nothing. The layout of the listing is ASSUMED, not verified.

Install also writes a skill file, `skills/supabase-accounts/SKILL.md`, in the Codex home folder. The Codex home folder is the `CODEX_HOME` variable, or `.codex` in your home folder when `CODEX_HOME` is not set. The location is ASSUMED, not verified: Codex reads user skills from that folder. ASSUMED: Codex has no command for installing skills, so this tool writes the file itself. The help text read for this covers `codex mcp` only. The skill file is replaced without a backup, and only when this tool created it. A skill file that this tool did not write is never replaced.

Uninstall runs `codex mcp remove multi-account-supabase` (not verified: this command form), then removes the skill file. If the output of that command has a line with the server name and the words "not found", "not installed", "does not exist", "no such" or "no mcp server", uninstall treats the server as absent and clears the record. That wording is ASSUMED, not verified. Any other failure keeps the record. It removes the folders that this tool made, when they are empty.

### Project

Requirement: the project folder must exist. Install does not create it. The `codex` command is not used for the project scope.

Install adds this table to `.codex/config.toml` in the project folder (the path is not verified against Codex):

```
[mcp_servers.multi-account-supabase]
```

- If the file exists, a backup is made first, as `config.toml.bak`, or `config.toml.bak2` when that name is taken. The backup is kept on uninstall.
- If the file does not parse as TOML, install refuses it and changes nothing.
- If the file already has the table, and this tool did not write it, install refuses.
- The other tables in the file keep their text.

Install also writes the skill file to `.agents/skills/supabase-accounts/SKILL.md` in the project folder. The location is ASSUMED, not verified: Codex reads project skills from that folder. The skill file is replaced without a backup, and only when this tool created it. A skill file that this tool did not write is never replaced.

ASSUMED, not verified: Codex reads the project file only when the folder is trusted.

## opencode

Scopes: global and project.

Requirement: none. Install edits opencode's JSON file directly, and it does not run the `opencode` command. Not verified: that opencode reads the file as this guide says. The file name and the layout of the entry are ASSUMED.

- Global file: `opencode.json`, in opencode's configuration folder (file name and folder ASSUMED, not verified). The folder is `.config` and then `opencode` in your home folder (ASSUMED, not verified). If the `XDG_CONFIG_HOME` variable is set to an absolute path, that path replaces `.config` (ASSUMED, not verified). The default folder was seen on one development machine. Not verified on other machines.
- Project file: `opencode.json` in the project folder (file name ASSUMED, not verified).

The entry sits under the key `mcp`, with the name `multi-account-supabase`. It has `type` set to `local`, `command` as a list that holds the Node program, the command line program and `serve`, and `enabled` set to `true`. The layout is ASSUMED, not verified with opencode.

Install refuses a file that is not valid JSON, a file whose top level or `mcp` value is not an object, a file that repeats a key, and an entry under the same name that this tool did not write.

Before it changes an existing file, install makes a backup, `opencode.json.bak`, or `opencode.json.bak2` when that name is taken. Uninstall keeps every backup. The file is written again as a whole, so the indentation and the line endings may change. The backup keeps the old bytes.

## Antigravity (`antigravity`)

Scopes: global only.

Requirement: the `agy` command must be on PATH. The check runs in a dry run too.

Install runs `agy mcp list` first (not verified: this command form), unless the entry is already recorded. If the listing names `multi-account-supabase`, and this tool did not write it, install stops and changes nothing. Then install runs `agy mcp add multi-account-supabase <Node program> <command line program> serve` (not verified: this command form). The listing format is not verified.

Update removes the entry and adds it again. Uninstall runs `agy mcp remove multi-account-supabase` (not verified: this command form). Not verified: the wording agy uses when an entry is absent. The uninstall step treats some wording as "not installed". Other failures keep the record, so a later uninstall can try again.

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

It removes a folder that this tool made only when the folder is empty.
