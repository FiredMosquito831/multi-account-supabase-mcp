# Plugin Implementation Plan (Plan 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Each task gets a fresh Haiku implementer, then a fresh Haiku reviewer, then a commit by the lead. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Claude Code plugin `multi-account-supabase`: a marketplace in this repository, one plugin with a launcher, the MCP entry with server key `supabase`, five slash commands that never put user text in a shell line, and the one skill, copied into the plugin.

**Architecture:** The marketplace file at the repository root lists one plugin, at `plugins/multi-account-supabase`. The MCP entry runs the launcher with no argument, which starts `serve`. The launcher runs the installed command when it is on PATH, and otherwise the same version through npx. The commands run the launcher with a fixed word (`list` or `doctor`), or print a terminal line for the owner to run. The token is never typed into the chat.

**Tech Stack:** Node 22 ESM for the launcher (`.mjs`, Node built-ins only, no dependency). Tests are TypeScript, compiled by the existing `tsc` into `dist/test` and run by `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-20-supabase-mcp-design.md`, sections 6.8 (the plugin), 6.10 (docs) and 6.12 (T3, T6, T7). Section 6.12 T6 is done in Plan 2. T7 stays OPEN.

## Global Constraints

- Tokens never go to a file, a log, command output, a test fixture or the chat. No plugin file holds a token value or token-shaped text (`sbp_`). The plugin never reads a token.
- No user text goes into a plugin command's `!` line (T3). The only `!` lines are `list` and `doctor`, with the launcher path.
- The launcher writes only to stderr. In serve mode stdout carries the protocol.
- The launcher accepts plain words only: letters, digits, and the characters `._@:=,/\+-`. Anything else is refused before anything runs, with exit 2. The refused text is never printed.
- The plugin version, the package version and the marketplace metadata version are equal. A test checks all three.
- The marketplace declares no commands, hooks or servers. Its single plugin entry is the only entry.
- The MCP server key is `supabase`. Tool ids read `plugin:multi-account-supabase:supabase`.
- `npm test` never reaches the network, never runs npx, never runs `claude`, and never reads or writes a real configuration or the owner's data folder.
- Dependencies: none added. The launcher uses Node built-ins only.
- Documentation is written in the same change as the behaviour it describes.
- Outward steps are not part of this plan: a push, a release, an npm publish, a real `claude plugin` run, and a live login each need the owner's named go-ahead.

## Review Focus

1. An argument with a space or a shell character (an account name such as `a b` or `x;y`) reaches the launcher. It is refused with exit 2, nothing is spawned, and the text is not echoed. Task 2.
2. The plugin folder sits in a path with spaces (a Windows profile such as `C:\Users\Jane Doe\...`). The launch and the version read still work, and the path is not split. Task 2.
3. Neither the installed command nor npx can start. The launcher prints one stderr line, exits 1, and writes nothing to stdout. Task 2.
4. The plugin version differs from the package version. The npx fallback would then run the wrong version. Task 1 checks the three versions equal. Task 2 checks the npx argument uses the plugin version.
5. A command file gains `$ARGUMENTS`, `$1`, or a user word in a `!` line, or a terminal line carries a token. Task 4 scans every command file.

## Task 1: Marketplace, plugin manifest, and the shared names

**Files:**
- Create: `.claude-plugin/marketplace.json` (repository root)
- Create: `plugins/multi-account-supabase/.claude-plugin/plugin.json`
- Modify: `src/agents/claude.ts`, lines 25 to 30: add the `export` keyword to `MARKETPLACE`, `PLUGIN`, `PLUGIN_ID` and `MARKETPLACE_SOURCE`. Change nothing else.
- Create: `src/test/plugin-manifest.test.ts`

**Interfaces:**
- Consumes: the four exported constants of `src/agents/claude.ts`; `package.json` (`version`, `files`).
- Produces: the two manifest files, which Tasks 2 to 5 read.

**Content of the two manifests** (the marketplace has one plugin entry and no other arrays):

`.claude-plugin/marketplace.json`:
```json
{
  "name": "multi-account-supabase-mcp",
  "owner": { "name": "FiredMosquito831" },
  "metadata": {
    "description": "Multi-account Supabase MCP: one official @supabase/mcp-server-supabase per account, with tool calls sent to one, several or all accounts",
    "version": "0.1.0"
  },
  "plugins": [
    {
      "name": "multi-account-supabase",
      "description": "Supabase MCP tools for several accounts at once. Add each account with its own token in a terminal, then send a call to one account, a list, or all of them.",
      "source": "./plugins/multi-account-supabase",
      "strict": false
    }
  ]
}
```

`plugins/multi-account-supabase/.claude-plugin/plugin.json`:
```json
{
  "name": "multi-account-supabase",
  "displayName": "Multi-account Supabase",
  "version": "0.1.0",
  "description": "Supabase MCP tools for several accounts: projects, databases, functions, branches, debugging and docs, sent to one account, a list, or all of them. An add-on to the multi-account-supabase-mcp npm package: it runs the installed copy when there is one, and the same version from npm otherwise.",
  "author": { "name": "FiredMosquito831" },
  "homepage": "https://github.com/FiredMosquito831/multi-account-supabase-mcp",
  "repository": "https://github.com/FiredMosquito831/multi-account-supabase-mcp",
  "keywords": ["supabase", "mcp", "multi-account", "database"]
}
```

`strict: false` follows the Netlify template. Its meaning in Claude Code is not verified (ASSUMED, from the template). Record it as such in the docs (Task 5).

- [ ] **Step 1: Write the failing test**

`src/test/plugin-manifest.test.ts` reads the two manifests and `package.json` from the repository root (`new URL('../../', import.meta.url)` from `dist/test`). It asserts:
- `marketplace.name === MARKETPLACE`.
- `marketplace.plugins` has exactly one entry; its `name === PLUGIN`; its `source === "./plugins/multi-account-supabase"`; `strict === false`.
- The marketplace's top-level keys are a subset of `name, owner, metadata, plugins`. The plugin entry has none of the keys `commands`, `hooks`, `mcpServers`.
- `plugin.json.name === PLUGIN`; `plugin.json.version === package.json.version`; `marketplace.metadata.version === package.json.version`.
- `PLUGIN_ID === `${PLUGIN}@${MARKETPLACE}``; `MARKETPLACE_SOURCE === "FiredMosquito831/multi-account-supabase-mcp"`.
- The source path `plugins/multi-account-supabase` is a directory that holds `.claude-plugin/plugin.json`.
- `package.json.files` contains `.claude-plugin/`, `plugins/` and `skills/`.

- [ ] **Step 2: Run it and see it fail**

Run: `npm test`. Expected: the new test fails, because the manifests and exports do not exist yet. Record the failing names.

- [ ] **Step 3: Create the files and add the exports**

Write the two manifests exactly as above. Add the `export` keyword to the four constants in `src/agents/claude.ts`.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm test` and `npm run typecheck`. Expected: all pass, and the typecheck exits 0.

- [ ] **Step 5: Commit** (the lead commits after review, with the message in the Commit section below)

## Task 2: The launcher

**Files:**
- Create: `plugins/multi-account-supabase/bin/launch.mjs`
- Create: `src/test/launcher.test.ts`

**Interfaces:**
- Consumes: `plugins/multi-account-supabase/.claude-plugin/plugin.json` (version), `package.json` (the package name).
- Produces, as named exports of `launch.mjs`:
  - `PACKAGE` = `"multi-account-supabase-mcp"`.
  - `SAFE_ARGUMENT` = `/^[A-Za-z0-9._@:=,/\\+-]+$/`.
  - `unsafeArgument(args: string[]): string | undefined`: the first argument that fails `SAFE_ARGUMENT`, or `undefined`.
  - `pluginVersion(pluginRoot: string): string`: reads `.claude-plugin/plugin.json`.
  - `launchPlan({ version, onPath, windows, args }): { command, args, shell }`: when `onPath`, the command is `PACKAGE` and the arguments are `args`; otherwise the command is `npx` and the arguments are `['-y', `${PACKAGE}@${version}`, ...args]`; `shell` is `windows`.
  - `npxDirectory(cwd, packageName, neutral): string`: `neutral` when `packageName === PACKAGE`, otherwise `cwd`.
  - `run(deps): Promise<number>`: the whole launch. `deps` injects `argv`, `cwd`, `windows`, `pluginRoot`, `isOnPath`, `spawn`, `stderr`, `tmpdir`, `readPackageName`. It resolves with the exit code and never calls `process.exit`.
  - The entry point runs `run` with the real dependencies only when the file is the one Node was asked to run, and passes the code to `process.exit`.

**Behaviour, from the review focus:**
- No argument: the arguments are `['serve']`.
- Any argument that fails `SAFE_ARGUMENT`: stderr gets one line, `multi-account-supabase-mcp: refused an argument with spaces or shell characters. Use plain words.` Exit 2. Nothing is spawned. The argument itself is not printed (a token could be typed there by mistake).
- On Windows the spawn uses `shell: true` with the joined command string. The arguments were checked first, so the join is safe. On other platforms it uses no shell.
- The child gets `stdio: 'inherit'`. `SIGINT` and `SIGTERM` are forwarded to the child. The launcher's exit code is the child's code, or 1 when the child ended by a signal.
- A spawn error (for example Node missing) gives one stderr line, `multi-account-supabase-mcp could not start: <message>. Node.js and npm must be installed.` Exit 1.
- The launcher writes nothing to stdout itself.

- [ ] **Step 1: Write the failing tests**

`src/test/launcher.test.ts` imports the module by its file URL, `pathToFileURL(new URL('../../plugins/multi-account-supabase/bin/launch.mjs', import.meta.url))`. Each test injects its own `spawn` and `isOnPath` fakes, and a captured `stderr` and `stdout`. Write one test for each behaviour in the list above, plus:
- `npxDirectory` returns the neutral folder when the package name is `PACKAGE`.
- `launchPlan` for npx puts `${PACKAGE}@<plugin version>` after `-y`, and the version is the one passed in (not a literal).
- A plugin folder with a space in its path (create a temporary folder named `a b`) reads the version correctly through `pluginVersion`.
- The file itself has no `process.stdout` and no `console.log` call (a text search of the file).

- [ ] **Step 2: Run and see it fail**

Run: `npm test`. Expected: the launcher tests fail, because the file does not exist.

- [ ] **Step 3: Write the launcher**

Create `plugins/multi-account-supabase/bin/launch.mjs`. Use only `node:child_process`, `node:fs`, `node:os`, `node:path` and `node:url`. Keep the functions above small and named as listed. Put a short comment on the rule that the arguments are plain words, and why (Windows shell).

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm test` and `npm run typecheck`. Expected: all pass.

## Task 3: The server entry and the skill copy

**Files:**
- Create: `plugins/multi-account-supabase/.mcp.json`
- Create: `plugins/multi-account-supabase/skills/supabase-accounts/SKILL.md` (a byte copy of `skills/supabase-accounts/SKILL.md`)
- Create: `src/test/plugin-files.test.ts`

**Interfaces:**
- Consumes: `SKILL_NAME` and `SKILL_FILE` from `src/agents/skill.ts`.
- Produces: the MCP entry, which the plugin loads.

`.mcp.json` content:
```json
{
  "mcpServers": {
    "supabase": {
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs"]
    }
  }
}
```

- [ ] **Step 1: Write the failing test**

`src/test/plugin-files.test.ts` asserts:
- `.mcp.json` has exactly one server, with the key `supabase`, `command === "node"`, and `args` equal to `["${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs"]`. It has no `env` key on the server (no environment is set in the config; the child's environment is the allowlist of the server, and the token is never in a file).
- The plugin's `skills/supabase-accounts/SKILL.md` has the same bytes as the root `skills/supabase-accounts/SKILL.md`.
- The skill's frontmatter `name` is `SKILL_NAME`.

- [ ] **Step 2: Run and see it fail**

Run: `npm test`. Expected: the new assertions fail (the files do not exist yet).

- [ ] **Step 3: Create the two files**

Write `.mcp.json` as above. Copy the skill with `cp` (byte copy, not a retyped file).

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm test` and `npm run typecheck`. Expected: all pass.

## Task 4: The five slash commands

**Files:**
- Create: `plugins/multi-account-supabase/commands/accounts.md`
- Create: `plugins/multi-account-supabase/commands/doctor.md`
- Create: `plugins/multi-account-supabase/commands/add-account.md`
- Create: `plugins/multi-account-supabase/commands/set-default.md`
- Create: `plugins/multi-account-supabase/commands/remove-account.md`
- Create: `src/test/plugin-commands.test.ts`

**Interfaces:**
- Consumes: the plugin version (Task 1), the launcher's path and words (Task 2), and the CLI's words `list`, `doctor`, `add`, `default`, `remove` (`src/usage.ts`).

**The five files:**

- `accounts.md`: frontmatter `description` (one sentence, no token) and `allowed-tools: Bash(node:*)`. A single `!` line, exactly: `` !`node "${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs" list` ``. The body asks the agent to show the list, mark the default, and say how to add one when the list is empty.
- `doctor.md`: the same shape, with `doctor` in place of `list`. The body shows the result and explains each line, and says that no token is shown.
- `add-account.md`: no `!` line. The body explains the steps (create a token in the Supabase dashboard, one per account, scoped if possible; the dashboard steps are OPEN, see the docs). It gives the terminal line exactly as `npx -y multi-account-supabase-mcp@<plugin version> add <name> --pat`, where `<name>` is for the owner to choose. It says the token is typed in that terminal, hidden, and never in the chat. If the owner pastes a token into the chat, the body says: do not use it or repeat it; tell the owner to revoke it in the Supabase dashboard and add the account again in a terminal.
- `set-default.md`: no `!` line. The body gives the terminal line `npx -y multi-account-supabase-mcp@<plugin version> default <name>` for the owner to run.
- `remove-account.md`: no `!` line. The body asks the owner, in the chat, to confirm the account name. Only after the owner confirms does it give the terminal line `npx -y multi-account-supabase-mcp@<plugin version> remove <name>`. It says that the Supabase token still works until it is revoked in the dashboard. Before writing the body, read `src/run.ts` to check whether `remove` asks for confirmation itself. Write the text to match what the CLI does, and record in the report which of the two it is.

The plugin version is written as a literal in each terminal line (the value of `plugin.json`'s `version`, `0.1.0`), and Step 1's test checks it.

- [ ] **Step 1: Write the failing test**

`src/test/plugin-commands.test.ts` reads the five files and asserts:
- Each file has a frontmatter `description:` with a non-empty value.
- Every line that starts with `!` is exactly one of the two literal lines (`list` or `doctor`, with the launcher path). No `$ARGUMENTS`, `$1`, or any `$` other than `${CLAUDE_PLUGIN_ROOT}`.
- `accounts.md` and `doctor.md` each have one `!` line; `add-account.md`, `set-default.md` and `remove-account.md` have none.
- No file contains `sbp_`, and no file contains a run of 24 or more letters and digits with no space (a token-shaped string). The check runs on the file text.
- Every `multi-account-supabase-mcp@<x>` in the files has `<x>` equal to the plugin version.
- `add-account.md` contains `--pat`.

- [ ] **Step 2: Run and see it fail**

Run: `npm test`. Expected: the command tests fail, because the files do not exist.

- [ ] **Step 3: Write the five files**

Write the files as described. Keep each body short: the agent needs the steps and the line, nothing more.

- [ ] **Step 4: Run the tests and the typecheck**

Run: `npm test` and `npm run typecheck`. Expected: all pass.

## Task 5: Documentation, in the same change

**Files:**
- Modify: `README.md` (a "Claude Code plugin" section)
- Modify: `docs/install.md` (the Claude Code plugin route, beside the installer route)
- Modify: `SECURITY.md` (the plugin rules)
- Modify: `CHANGELOG.md` (an Unreleased entry)
- Modify: `CONTRIBUTING.md` (where the plugin lives, and the version rule)

**Content, each point as a sentence in the file:**
- The plugin is `multi-account-supabase`, from the marketplace `multi-account-supabase-mcp` in this repository. The server key is `supabase`, so the tool ids read `plugin:multi-account-supabase:supabase`. A direct install uses the key `multi-account-supabase`, and the two do not clash.
- The five commands and what each does. The two that take a name print a terminal line; they do not pass the name through a shell.
- Two install routes: the installer (`multi-account-supabase-mcp install claude`, Plan 2) runs the `claude plugin` commands; the manual route is `/plugin marketplace add FiredMosquito831/multi-account-supabase-mcp`, then `/plugin install multi-account-supabase@multi-account-supabase-mcp`. The manual route is **Not verified** (the Claude Code interface was not run).
- The marketplace is pinned to the default branch (T7). A release ref is **OPEN**, because Claude Code's support for a ref is not verified.
- `strict: false` is ASSUMED, from the Netlify template. Its meaning is not verified.
- The marketplace declares no commands, so the `-y` flag of the installer accepts none (the claim is the one in `src/agents/claude.ts`, and it stays marked OPEN until a real run confirms it).
- The launcher rules: plain words only, refused text is not printed, stderr only, the installed command is used when on PATH, npx otherwise with the plugin's version.
- The dashboard steps for creating a token are **OPEN**; they are re-read before a release.

Rules for the text: plain English, short sentences, no emoji, no ruling IDs, no plan references, no token value, and no claim that a real Claude Code run passed.

- [ ] **Step 1: Check the text against the code**

Each claim above is checked against the file it names (grep and read). Record the line numbers in the report.

- [ ] **Step 2: Write the changes**

Edit the five files. Add the CHANGELOG entry under Unreleased.

- [ ] **Step 3: Run the tests**

Run: `npm test` and `npm run typecheck`. Expected: all pass. A test in the suite already checks for ruling IDs in the documents, if one exists; if none does, the report says so.

## Task 6: Whole-plugin verification (lead, no subagent)

- [ ] Run `npm test` and `npm run typecheck` on the whole tree. Expected: all pass.
- [ ] Run `node --check plugins/multi-account-supabase/bin/launch.mjs`. Expected: exit 0.
- [ ] Run `npm pack --dry-run`. Read the file list. Expected: it includes `.claude-plugin/marketplace.json`, the `plugins/multi-account-supabase/` tree, and `skills/supabase-accounts/SKILL.md`, and it includes no file from `src/test`, no `.superpowers` folder, and no `.env` or credential file.
- [ ] Run the whole-branch review of Plan 3 (two read-only Haiku reviewers: launcher and commands; manifest, marketplace and documents). Fix what they find, and re-run the tests.

## Commit

Each task is committed by the lead after its review passes, with `git commit -F` and a message file. The message ends with `by FiredMosquito831`. Example for Task 2:

```
feat: add the plugin launcher, which runs the installed command or the same version through npx

It refuses an argument that is not a plain word before anything runs, and it never prints the refused text. It writes only to stderr, and it forwards SIGINT and SIGTERM to the server.

by FiredMosquito831
```

## Open items (not done by this plan; each needs the owner's go-ahead)

- A real `claude plugin marketplace add`, `claude plugin install` and `/multi-account-supabase:accounts` run in Claude Code (needs a go-ahead and a throwaway profile).
- Whether Claude Code accepts a marketplace ref (T7).
- Whether `-y` accepts anything a plugin declares (the H12 claim).
- The dashboard steps for a scoped token.

## Self-review

- Spec coverage: 6.8 plugin (manifest and marketplace in Task 1; launcher in Task 2; MCP entry and skill in Task 3; commands in Task 4); 6.10 docs (Task 5); T3 (Tasks 2 and 4); T6 (done in Plan 2); T7 (OPEN, stated in Task 5 and Open items).
- Names: `PACKAGE`, `unsafeArgument`, `pluginVersion`, `launchPlan`, `npxDirectory`, `run` are used the same way in Tasks 2 and 4. The constants `MARKETPLACE`, `PLUGIN`, `PLUGIN_ID`, `MARKETPLACE_SOURCE` are exported in Task 1 and read by Task 1's test.
- Tests: each task names its test file; no two tasks write the same test file.
- Conflicts: Task 1 is the only task that edits `src/agents/claude.ts`, and it changes only the `export` keyword.
