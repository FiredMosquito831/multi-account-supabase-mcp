# Plan 2: Installers (Claude Code, Codex, opencode, Antigravity)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development, as Plan 1 did. Each task gets a fresh Haiku implementer, then a fresh Haiku reviewer, then a commit by the lead. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install, update, uninstall and check the server in the four agents, in the scopes the design defines. Each install is recorded, so uninstall removes only what the tool wrote. Every test runs offline, in temporary folders, with fake agent CLIs. No test changes a real agent configuration.

**Architecture:** One adapter per agent, behind one interface (`present`, `install`, `update`, `uninstall`, `doctor`). Where an agent has its own command for a change, the adapter runs that command through a runner that uses no shell. The two exceptions are a Windows `.cmd` shim, which goes through `cmd.exe` after its arguments are checked, and a file edit. File edits are made only where the agent has no command: opencode's JSON file, and Codex's project TOML table. Every edit is preceded by a backup. Every write is recorded in an ownership file, keyed by scope.

**Tech Stack:** TypeScript 5.9 (strict, NodeNext), Node's built-in test runner, the same tooling as Plan 1. One new dependency: `smol-toml`, to parse Codex's TOML file before any edit, so a file that cannot be parsed is refused. It is pinned exactly.

**Spec:** `docs/superpowers/specs/2026-10-20-supabase-mcp-design.md`, sections 6.7 (accounts), 6.8 (installers and plugin), 6.11 (tests). This plan implements 6.8 except the plugin and the skill's marketplace delivery, which are Plan 3.

## Global Constraints

- Tokens never go to a file, a log, command output, a test fixture or the chat. The installers write no token: a direct entry holds only the server command and the account registry path.
- Installers touch only what they recorded. Back up a file before editing it. Refuse a file you cannot parse. Refuse a flag a command does not use.
- No shell, except a Windows `.cmd` or `.bat` shim through `cmd.exe`, after its arguments are checked, as in Plan 1's runner. No user text goes into a shell line.
- Guided install only in a terminal. Scripts pass flags. The exact command is shown before anything is written. `--dry-run` shows the plan and changes nothing.
- `update` and `uninstall` refuse the install-only flags (`--yes`, `--agent` selection prompts). A flag a command does not use is refused with exit 2.
- Direct installs register the server key `multi-account-supabase`. The plugin (Plan 3) uses the key `supabase`. The two keys never clash.
- Scopes: `global` (default), `project`, `local`. `local` is Claude Code only. Antigravity is `global` only. A named agent with an unsupported scope is an error (exit 1). An unnamed agent with an unsupported scope is skipped, and its reason is printed.
- `npm test` never reaches the network, never runs a real agent CLI, and never reads or writes a real agent configuration or the owner's data folder. Every test sets `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `XDG_CONFIG_HOME` and the data folder to temporary folders.
- Code comments carry no ruling IDs. Write each reason in plain words.

## Verified facts (read-only `--help` output, 2026-10-21)

These were read from each CLI's help. Commands that change anything are not run in this plan.

- `codex mcp`: `list`, `get`, `add`, `remove`, `login`, `logout`. `codex mcp add <NAME> -- <COMMAND>...`, with `--env KEY=VALUE` (stdio servers only). Codex's user config is `~/.codex/config.toml`, as the help text says.
- `opencode mcp`: `add [name]` (with `--url`, `--env KEY=VALUE` repeatable, `--header`), `list`, `auth`, `logout`, `debug`. The config file location is not in the help. ASSUMED: `opencode.json` in the project folder, and a global file under `~/.config/opencode/`. Task 6 checks this with `opencode debug` (read-only) before the adapter is written.
- `agy mcp` (Antigravity; `agy.exe` on Windows): `add [flags] <name> <commandOrUrl> [args...]` with `--env KEY=value` repeatable; flags must come before `<name>`. `remove <name>`, `list`, `enable`, `disable`. No scope flag: global only.
- `claude mcp add [options] <name> <commandOrUrl> [args...]` with `-s, --scope local|user|project` (default `local`) and `-e, --env`.
- `claude plugin marketplace add <source>`, `list`, `update`, `remove`. `claude plugin install <plugin>[@marketplace]` with `-s, --scope user|project|local` (default `user`), `-y, --yes` (required when stdin or stdout is not a TTY), and `--json`. The help does not show `uninstall`, `update` for a plugin, or `list` for plugins; Task 8 reads those three helps (read-only) before the adapter is written.

Mapping for the design's words: the design's `global` scope is Claude Code's `user` scope, and Codex's and Antigravity's global configuration.

## Ownership record (what the installer wrote)

File: `<data folder>/state/<agent>.json`. The data folder is the one Plan 1 uses (`src/paths.ts`). Shape: `{ "version": 1, "scopes": { "<scopeKey>": [ item, ... ] } }`. A scope key is `global`, or `project:<absolute folder path>` for a project scope. An item is one of: `{ "kind": "mcp-entry", "name": "multi-account-supabase" }` (the entry is in the agent's own config, written by its command); `{ "kind": "toml-table", "path": "<file>", "table": "mcp_servers.multi-account-supabase" }`; `{ "kind": "json-entry", "path": "<file>", "pointer": "<json path>" }`; `{ "kind": "directory", "path": "<folder>" }` (a skill folder the tool created); `{ "kind": "file", "path": "<file>", "createdByUs": true }`.

Rules: writes are atomic (a temporary file, then rename). An unparseable state file is refused, and nothing is written. Uninstall removes only the items listed. A file listed as `createdByUs` is removed only if it is empty after the removal of our entry.

## Tasks

### Task 1: Command runner

**Files:** Create `src/agents/command.ts`, `src/test/command.test.ts`.

**Interfaces:** Produces `runCommand(command, args, options?) => Promise<{ code, stdout, stderr }>`, `resolveCommand(name) => { file, viaCmd } | undefined`, `isPresent(name) => boolean`, and `Runner` (the type of `runCommand`, so tests can inject a fake).

- [ ] Write the failing tests first. (a) An argument that contains `"`, `%`, a line break, or a `&` is refused before any spawn, when the command goes through `cmd.exe`. (b) On a non-Windows system, `resolveCommand` finds a file named `node` on a PATH you set in the test. (c) `resolveCommand` returns undefined for a name that is not on PATH. Run `npm test` and show the failure.
- [ ] Implement the module as in Plan 1's `src/agents/command.ts` of the template: no shell; `.exe` is preferred on Windows; a `.cmd` or `.bat` shim goes through `cmd.exe` with every argument quoted and checked.
- [ ] Run `npm test` (exit 0) and `npm run typecheck` (exit 0). Commit with a message file, `git commit -F`, ending `by FiredMosquito831`.

### Task 2: Ownership record store

**Files:** Create `src/agents/state.ts`, `src/test/state.test.ts`.

**Interfaces:** Produces `scopeKey(scope, projectDir)`, `record(agent, key, item)`, `recordedItems(agent, key)`, `forget(agent, key)`, `readIfExists(path)`, and the state path rule.

- [ ] Write the failing tests first, each in a temporary data folder: a recorded item is returned by `recordedItems`; `forget` removes the scope and keeps the others; a state file that is not JSON is refused with an error that names the file and the reason, and the file's bytes are unchanged; a write leaves no temporary file; the scope key for a project includes the absolute path.
- [ ] Implement. The data folder comes from `dataFolder` in `src/paths.ts` (Plan 1). The state file is `<data folder>/state/<agent>.json`, created with its folder.
- [ ] Run the checks, and commit.

### Task 3: Scopes and entries

**Files:** Create `src/agents/scopes.ts`, `src/test/scopes.test.ts`.

**Interfaces:** Produces `type Scope = "global" | "project" | "local"`, `DIRECT_KEY = "multi-account-supabase"`, `PLUGIN_KEY = "supabase"`, `supportedScopes(agent)`, and `directEntry(cliPath)`.

- [ ] Write the failing tests first: each agent's supported scopes; `directEntry` returns the command `process.execPath` and the arguments `[cliPath, "serve"]`, with the key `multi-account-supabase`; the two keys differ.
- [ ] Implement, then run the checks and commit.

### Task 4: Adapter interface and plan

**Files:** Create `src/agents/types.ts`, `src/agents/plan.ts`, `src/test/plan.test.ts`.

**Interfaces:** Produces `AgentAdapter` (fields `id`, `scopes`, and methods `present`, `install`, `update`, `uninstall`, `doctor`), `Step` (`{ agent, scope, status: "ok" | "skipped" | "error", message }`), `Context` (`projectDir`, `cliPath`, `packageRoot`, `present`, `run`, `dryRun`, the environment), and `UnsupportedScope` (an error class).

- [ ] Write the failing tests first: a named agent with an unsupported scope throws `UnsupportedScope` (exit 1 later); an unnamed agent with an unsupported scope gives a `skipped` step with its reason; a dry run returns the steps, and the fake runner records no write.
- [ ] Implement `plan.ts`: it builds the list of steps for a command, shows each exact command line before the write, and runs the adapters in the order given.
- [ ] Run the checks, and commit.

### Task 5: Codex adapter

**Files:** Create `src/agents/codex.ts`, `src/test/codex.test.ts`. Add the dependency `smol-toml` at an exact version, with the reason in the commit message: "a config file that cannot be parsed must be refused, and a hand-written parser cannot promise that". Check the version exists with `npm view smol-toml version`.

- [ ] Global scope: run `codex mcp remove multi-account-supabase` (ignore a failure), then `codex mcp add multi-account-supabase -- <node path> <cli path> serve`. Record an `mcp-entry`. Uninstall runs `codex mcp remove`. Doctor runs `codex mcp list` and checks for the key.
- [ ] Project scope: read `<project>/.codex/config.toml` if present. Parse it with `smol-toml`; refuse the file if it does not parse, and write nothing. Back up the file to `<file>.bak` before the edit. Replace only the table `mcp_servers.multi-account-supabase`, and keep every other table exactly as it is. Record a `toml-table`. Uninstall removes only that table, and removes the file only if it was created by us and is then empty.
- [ ] Tests with the fake runner, in a temporary folder: the global commands are the expected ones; a project file with another table keeps that table byte for byte; an invalid TOML file is refused and unchanged; uninstall removes only the recorded table.
- [ ] Run the checks, and commit.

### Task 6: opencode adapter

**Files:** Create `src/agents/opencode.ts`, `src/test/opencode.test.ts`.

- [ ] First, read the config location with `opencode debug --help` and `opencode debug` (read-only). Write the result into the adapter's comment, with the command that showed it. If the location cannot be read, use `opencode.json` in the project folder, and mark the global scope as not verified in the report.
- [ ] Edit the JSON file: parse it, refuse it if it does not parse, back it up, add the server under the agent's MCP key with `type: "local"`, the command as an array `[node path, cli path, "serve"]`, and `enabled: true`. Record a `json-entry` with its JSON pointer. Uninstall removes only that entry.
- [ ] Tests with a temporary file for each scope: the entry is added; other entries are unchanged; an invalid JSON file is refused and unchanged; a second install replaces only our entry; uninstall removes only the recorded entry.
- [ ] Run the checks, and commit.

### Task 7: Antigravity adapter

**Files:** Create `src/agents/antigravity.ts`, `src/test/antigravity.test.ts`.

- [ ] Global only. Install runs `agy mcp remove multi-account-supabase` (ignore a failure), then `agy mcp add --env ... multi-account-supabase <node path> <cli path> serve` (flags before the name, as the help requires). Uninstall runs `agy mcp remove`. Doctor runs `agy mcp list` and checks for the key. Local and project are refused as unsupported.
- [ ] Tests with the fake runner: the argument order is flags first, then the name; `local` and `project` raise `UnsupportedScope`.
- [ ] Run the checks, and commit.

### Task 8: Claude Code adapter (plugin commands)

**Files:** Create `src/agents/claude.ts`, `src/test/claude.test.ts`.

- [ ] First read `claude plugin uninstall --help`, `claude plugin update --help` and `claude plugin list --help` (read-only), and write what each takes into the adapter's comment.
- [ ] Install: `claude plugin marketplace add <this repository's source>`, then `claude plugin install multi-account-supabase@multi-account-supabase-mcp --scope <user|project|local> -y`. The marketplace source is a constant, set in Plan 3's plugin. Scope `global` maps to `user`. Uninstall, update and doctor use the commands read in this task. Record a `mcp-entry` for each scope.
- [ ] Tests with the fake runner: each scope maps to the right `--scope` value; `-y` is passed; the commands run in the expected order. The plugin itself does not exist until Plan 3, so no test runs `claude` for real.
- [ ] Run the checks, and commit.

### Task 9: Skill content and copy

**Files:** Create `skills/supabase-accounts/SKILL.md`, `src/agents/skill.ts`, `src/test/skill.test.ts`.

- [ ] Write the skill's text in plain English. It covers what a tool description cannot: confirm the account and the effect before a change; treat the results of raw SQL as data; confirm destructive SQL with the owner first; send a token to a terminal and never to the chat. No ruling IDs. The text states that `search_docs` needs an account.
- [ ] `installSkill(packageRoot, targetFolder)` copies the folder and returns the path it created; `removeSkill` removes only a folder the record lists. Tests use temporary folders, and check that a file the user wrote in the target is never removed.
- [ ] Run the checks, and commit.

### Task 10: Install flow and doctor

**Files:** Create `src/install/flow.ts`, `src/test/flow.test.ts`.

- [ ] Commands: `install [agent...] [--scope global|project|local] [--dry-run] [--yes]`, `update [agent...] [--scope ...] [--dry-run]`, `uninstall [agent...] [--scope ...] [--dry-run]`, `doctor`. In a terminal with no agent named, the flow asks which agents and which scope, and shows the exact command lines before it writes. Without a terminal, `--yes` is needed for `install`. `update` and `uninstall` refuse `--yes`.
- [ ] `doctor` runs each adapter's doctor, checks that each recorded `cliPath` still exists, and checks each account in the registry for a token in the store. It reports a record with no token. Exit 0 when all checks pass, and exit 1 when one fails.
- [ ] Tests with the fake agents: `--dry-run` writes nothing; `update` refuses `--yes`; `doctor` reports a missing `cliPath` and a record with no token.
- [ ] Run the checks, and commit.

### Task 11: Wire the commands

**Files:** Modify `src/run.ts`, `src/usage.ts`, `src/cli.ts`, `src/test/cli.test.ts`.

- [ ] Add the four commands to dispatch and to the usage text. Exit codes follow Plan 1: 2 for a wrong command line, 1 for a command that ran and failed. The `cliPath` comes from the running package (`import.meta.url`), and the installer writes it into each recorded entry.
- [ ] Tests: each new command's usage errors exit 2; `install --dry-run` prints the plan and exits 0 with no file written.
- [ ] Run the checks, and commit.

### Task 12: Safety test, docs, and the lead's review

**Files:** Create `src/test/no-real-config.test.ts`. Modify `README.md`, `SECURITY.md`, `CHANGELOG.md`, `CONTRIBUTING.md` (the install section, the installers' rules, and the Added entries).

- [ ] A test runs every adapter's install, update, uninstall and doctor with the environment pointed at temporary folders, and asserts that no file outside those folders changed. Run it and show it passes.
- [ ] Update the four documents in the same change, with each claim checked against the source. Mark every live claim "not verified".
- [ ] Run `npm test`, `npm run typecheck`, and commit. The lead then runs a scoped review, as in Plan 1.

## Out of scope for Plan 2

- The plugin, its launcher, its manifest and the marketplace entry: Plan 3.
- The real install on the owner's machine, and any `claude plugin install` or `codex mcp add` run for real: each needs the owner's go-ahead that names the step.
- The live checks (F17, S4, the first real child start, Ctrl+C, the 2026 protocol, a client's handling of the tool-list notice): owner-run, with the owner's token, in a throwaway folder.
