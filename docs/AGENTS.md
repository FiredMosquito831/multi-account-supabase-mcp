# Scopes

A scope says where an agent keeps the entry for this server. There are three scopes: `global`, `project` and `local`. The install commands take them with `--scope`.

## Which agent supports which scope

| Agent | global | project | local |
| --- | --- | --- | --- |
| Claude Code (`claude`) | yes, Claude Code's user scope (ASSUMED, not verified) | yes | yes |
| Codex (`codex`) | yes | yes (ASSUMED, not verified) | no |
| opencode (`opencode`) | yes | yes (ASSUMED, not verified) | no |
| Antigravity (`antigravity`) | yes | no (ASSUMED, not verified) | no (ASSUMED, not verified) |

- `local` is for Claude Code only.
- Antigravity has the `global` scope only (ASSUMED, not verified: that agy has no project or local scope). The code sets this.

## What each scope means

- **global** applies to the whole machine, for the user who runs the command.
  - Claude Code: its user scope (ASSUMED, not verified: that Claude Code has this scope). The installer passes `--scope user` to Claude Code.
  - Codex: the user's Codex configuration, written by `codex mcp add` (not verified), and a skill file in the Codex home folder. The skill folder is ASSUMED, not verified.
  - opencode: `opencode.json` in opencode's configuration folder (file name and folder ASSUMED, not verified). See `docs/INSTALL.md` for the folder.
  - Antigravity: agy's own configuration. This tool does not read it. The location is ASSUMED, not verified.
- **project** applies to one project folder. The project folder is the folder you are in when you run the command.
  - Codex: a table in `.codex/config.toml` in that folder (ASSUMED, not verified: the path), and a skill file in `.agents/skills`. The skill folder is ASSUMED, not verified, and Codex reads the project file only when the folder is trusted (ASSUMED, not verified).
  - opencode: `opencode.json` in that folder (file name ASSUMED, not verified). The folder must exist: install and update refuse it when it does not.
  - Claude Code: its project scope. The commands run in that folder.
- **local** is Claude Code's local scope, for one project folder. Claude Code decides what the scope means (not verified here).

## Defaults

- `install` with no `--scope` uses `global`.
- `update` and `uninstall` with no `--scope` act on the global scope, and on the project and local scopes of the current folder, where a record exists. They go in the order global, project, local.
- `doctor` has no `--scope`. It checks every scope that has a record.

## Records are kept per folder

A project or local record is keyed by the folder path. The key is taken when the command runs. If you install from one folder and then run `update` or `uninstall` from another, the command does not see the record. Run those commands from the folder where you installed.

On Windows, the case of the letters in the folder path does not change the key.

## A named agent that lacks the scope

If you name an agent that does not support the scope you give with `--scope`, the command stops before any change, prints the reason, and exits with code 1. For example:

```
multi-account-supabase-mcp install antigravity --scope project
```

prints `antigravity has no project scope. Nothing was changed.`

Otherwise, an agent that does not support a scope gets one skipped line for that scope, with the reason, whether it was named or not. For example, `[skipped] antigravity project: antigravity has no project scope`. The other agents still act when the plan has no error line.

## Scope and the Claude marketplace

Claude Code gets the marketplace in the same scope as the plugin. Uninstall does not remove the marketplace. It prints the command that removes it in that scope. See `docs/INSTALL.md`.

Not verified: how Claude Code treats each scope when it reads the plugin. The commands are the ones this tool runs. The results have not been run against a real Claude Code.
