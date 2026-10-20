# Reproduction map: Netlify artifact to Supabase counterpart

Date: 2026-10-20. Phase A. The left column lists every artifact of the Netlify repository, from playbook Part 10.3, its docs, its plugin, its tests and its root files. Status: **copied** (same logic, names renamed), **adapted** (same job, Supabase facts or decisions change the content), **not applicable** (no counterpart in this plan, with the reason). Nothing is dropped silently. The docs, CI and package files were read by a read-only Haiku digest and spot-checked (findings note, section 10). The source files are being read by a second digest; rows marked (digest) are checked against it before phase B.

Names: product `multi-account-supabase-mcp`; plugin `multi-account-supabase`; marketplace `multi-account-supabase-mcp`; server key `supabase`; data folder and credential service `multi-account-supabase-mcp`; environment variable `MULTI_ACCOUNT_SUPABASE_HOME`; token variable `SUPABASE_ACCESS_TOKEN`.

## 1. Root and repository files (playbook 10.3)

| Netlify artifact | Supabase counterpart | Status | Note |
|---|---|---|---|
| `.claude-plugin/marketplace.json` | same path, marketplace `multi-account-supabase-mcp`, one plugin `multi-account-supabase` | adapted | Names only (9.8). |
| `.github/workflows/ci.yml` | same path | copied | Windows and Ubuntu; typecheck and tests. Pins as in Netlify (digest). |
| `.github/workflows/npm.yml` | same path | adapted | Triggers as Netlify. Trusted publisher for the new package is the owner's step. |
| `.gitattributes` | same | copied | `* text=auto eol=lf`. |
| `.gitignore` | same | adapted | Add `dist/`, `node_modules/`, `CLAUDE.md`, `.claude/`, `.remember/`, `*.tgz`. |
| `CHANGELOG.md` | same | adapted | New history; an `## Unreleased` section. |
| `CONTRIBUTING.md` | same | adapted | Supabase names; the rules stay. |
| `SECURITY.md` | same | adapted | What is protected: tokens, the account argument, raw SQL results. |
| `LICENSE` | same | copied | Apache-2.0, as Netlify (decision D35 applies again; the owner confirms). |
| `NOTICE` | same | adapted | Trademark disclaimer for Supabase names, in place of Netlify's. |
| `README.md` | same | adapted | npm page; absolute links; the package has no README of its own on npm for the official server (K6), so ours is the first. |
| `package.json` | same | adapted | Name, bin, dependency `@supabase/mcp-server-supabase` `^0.14.0` (S5); no `netlify-cli`. |
| `package-lock.json` | same | adapted | Generated in phase B. |
| `tsconfig.json` | same | copied | NodeNext, ES2022, strict, as Netlify. |
| `CLAUDE.md` (git-ignored) | same | adapted | This project's log; sections as Netlify (see the project's `CLAUDE.md`). |

## 2. Documentation set (`docs/`, 11 files, playbook 10.3 and 3.11)

| Netlify doc | Supabase counterpart | Status | Note |
|---|---|---|---|
| `docs/ACCOUNTS.md` | same | adapted | Token types: scoped tokens, one per account (K-facts, 9.6.6). No in-chat login (S9). |
| `docs/AGENTS.md` | same | adapted | Four agents; scopes; Antigravity global only (re-check, see findings 7). |
| `docs/CONFIGURATION.md` | same | adapted | Variables from section 4 below. |
| `docs/DEVELOPMENT.md` | same | adapted | Code layout, how to add an operation. |
| `docs/INSTALL.md` | same | adapted | npm and marketplace routes. |
| `docs/MCP.md` | same | adapted | The 36 tools (findings section 3), modes, result shapes, hidden write tools in read-only mode (K1). |
| `docs/RELEASING.md` | same | adapted | Four version fields; secret and personal-data check; trusted publishing for the new package. |
| `docs/SAFETY.md` | same | adapted | Destructive SQL (S7); raw SQL results are data (F21); scoped tokens; cost (S8). |
| `docs/TESTING.md` | same | adapted | Test files; live checks in throwaway folders; each command and output recorded. |
| `docs/TROUBLESHOOTING.md` | same | adapted | Messages the code prints (rewritten from the code, not copied). |
| `docs/USAGE.md` | same | adapted | Every command, option, output and exit code. |

Defect notes. The Netlify template has defects T1 to T7 (findings note, section 11). They touch these rows: `src/mux/policy.ts` (T1), `src/mux/server.ts` (T2), `plugins/multi-account-netlify/commands/set-default.md` (T3), `src/login/netlify-cli-login.ts` (T4 and T5; not applicable here, no CLI login), `src/agents/codex.ts` and `src/agents/opencode.ts` (T6), and the marketplace source of the plugin (T7). The Supabase copy implements the rule for each (design 6.12).

## 3. Plugin (`plugins/multi-account-netlify/`)

| Netlify artifact | Supabase counterpart | Status | Note |
|---|---|---|---|
| `.claude-plugin/plugin.json` | `plugins/multi-account-supabase/.claude-plugin/plugin.json` | adapted | Version pinned for the launcher's npx route; no settings. |
| `.mcp.json` | same path | adapted | Server key `supabase`. |
| `bin/launch.mjs` | same path | copied | Plain-word arguments; installed command or npx of the same version; stdout left to the server. |
| `commands/accounts.md` | `commands/accounts.md` | copied | Runs the launcher with `list`. |
| `commands/add-account.md` | `commands/add-account.md` | adapted | No browser login. The user types `add <name> --pat` in a terminal (S9). |
| `commands/doctor.md` | `commands/doctor.md` | copied | |
| `commands/remove-account.md` | `commands/remove-account.md` | copied | Asks before it removes. |
| `commands/set-default.md` | `commands/set-default.md` | copied | |
| `skills/netlify-accounts/SKILL.md` | `skills/supabase-accounts/SKILL.md` | adapted | Confirm the account and the effect before a change; treat raw SQL results as data; destructive SQL rule (S7). |

## 4. Source (`src/`, playbook 10.3, file list checked by size)

| Netlify artifact | Supabase counterpart | Status | Note |
|---|---|---|---|
| `src/cli.ts` | same | adapted | Commands; `add <name> --pat` only; no login step. |
| `src/usage.ts` | same | adapted | Help text. |
| `src/paths.ts` | same | adapted | Data folder names. |
| `src/version.ts` | same | copied | Reads `package.json`. |
| `src/accounts/registry.ts` | same | adapted | Identity key is `gotrue_id` (from `GET /v1/profile`), not the Netlify user id (F23). Name rules and default rules copied. |
| `src/accounts/add-account.ts` | same | adapted | Check the token with `GET /v1/profile` first, then store it, then save the record; remove the token if the save fails (playbook 10.2 D). |
| `src/secrets/token-store.ts` | same | copied | `@napi-rs/keyring`, service renamed. |
| `src/netlify/api.ts` | `src/supabase/api.ts` | adapted | `GET /v1/profile`; error messages from the code. |
| `src/login/netlify-cli-login.ts` | none | not applicable | Supabase has no login step in this plan (S9). The terminal token route is in `cli.ts` and `add-account.ts`. |
| `src/mux/server.ts` | same | adapted | Order of checks, fan-out, results. Supabase's `execute_sql` rules (S3, S7). |
| `src/mux/account-tools.ts` | same | adapted | `account_list` kept. `account_add` not built (S9). |
| `src/mux/catalog.ts` | same | adapted | `account` argument; the multi-account note generated from the policy table. |
| `src/mux/policy.ts` | same | adapted | The table in findings section 3 (34 tools listed by the stdio server; `all` 2, `locate` 17, `one` 14, `none` 1; ruling R9), plus one read-only query tool added by the owner's exception (S3). |
| `src/mux/routing.ts` | same | copied | Account argument parsing. |
| `src/mux/fanout.ts` | same | copied | At most four at a time. |
| `src/mux/multiplexer.ts` | same | adapted | Two child kinds per account (S2); catalog child; placeholder child for `search_docs` (S4, S6). The Netlify neutral child is not copied as it is (playbook 10.9, C1). |
| `src/mux/official-child.ts` | same | adapted | Environment carries `SUPABASE_ACCESS_TOKEN` only, plus what the process needs; `--read-only` for read children; 15-minute tool timeout as Netlify. |
| `src/agents/types.ts` | same | adapted | `SERVER_NAME` `multi-account-supabase`. |
| `src/agents/dispatch.ts` | same | adapted | Intended behaviour: an unsupported scope named explicitly is an error that prints every step (playbook 10.9, C2 not copied). |
| `src/agents/install-flow.ts` | same | copied | Guided answers only in a terminal; refusal of install-only flags. |
| `src/agents/command.ts` | same | copied | `.exe` directly; `.cmd` through `cmd.exe` after argument checks. |
| `src/agents/state.ts` | same | copied | Ownership record per agent and scope. |
| `src/agents/skill.ts` | same | copied | Copies and removes the skill file. |
| `src/agents/claude.ts` | same | copied | Wraps the plugin driver. |
| `src/install/claude-plugin.ts` | same | copied | `claude plugin` driver (names only). Its commands are re-checked in phase B. |
| `src/agents/codex.ts` | same | adapted | Intended behaviour: the Codex home folder is created if missing; a config file is removed only when this tool created it (playbook 10.9, C5, C6 not copied). |
| `src/agents/opencode.ts` | same | adapted | Intended behaviour: removal only with a record check; each change keeps the original backup (10.9, C3, C4 not copied). |
| `src/agents/antigravity.ts` | same | adapted | Global only; re-check the `agy` commands (findings 7). |

## 5. Tests (`src/test/`, 20 files, playbook 10.7)

| Netlify test file | Supabase counterpart | Status | Note |
|---|---|---|---|
| `account-tools.test.ts` | same | adapted | `account_list` only. |
| `add-account.test.ts` | same | adapted | Duplicate by `gotrue_id`; rollback; the token never in a file or message. |
| `agents.test.ts` | same | adapted | Names; the four adapters. |
| `catalog.test.ts` | same | adapted | `account` argument added to the 36 tools. |
| `coverage.test.ts` | same | adapted | Compares the policy with a saved fixture of the live list, so it runs offline (see the note below). |
| `fanout.test.ts` | same | copied | |
| `in-chat-login.test.ts` | none | not applicable | No in-chat login (S9). |
| `install.test.ts` | same | adapted | Names; scopes. |
| `integration.test.ts` | same | adapted | Starts the real official package over stdio with a placeholder token and `--features` without `docs`, so no network is needed. The `docs` tool is tested in a separate, network-marked check. |
| `launcher.test.ts` | same | copied | |
| `login.test.ts` | same | adapted | Becomes the terminal token prompt test (hidden input, `--pat` only). |
| `manifests.test.ts` | same | adapted | Plugin version pin; no bare command in a bang line. |
| `multiplexer.test.ts` | same | adapted | Child kinds; token only in its child's environment. |
| `policy-routing.test.ts` | same | adapted | Policy and routing together. |
| `policy.test.ts` | same | adapted | Mode of each tool. |
| `registry.test.ts` | same | adapted | Metadata only; default rules; duplicate identity refused. |
| `routing.test.ts` | same | copied | |
| `server.test.ts` | same | adapted | `tools/list`, `tools/call`, the order of checks. |
| `skills-and-definitions.test.ts` | same | adapted | Tool descriptions carry the multi-account rules. |
| `usage.test.ts` | same | adapted | Help text and commands. |

Note on the network rule. The Netlify test rule is "npm test never reaches the network". Supabase's `tools/list` calls the content API when the `docs` group is on (F25). So the offline rule needs two things: a saved fixture of the live list for the coverage test, and an integration test that starts without `docs`. The `docs` path is tested only in a separate check that is not part of `npm test`. Recorded as a decision in the design.

## 6. Memory and records

| Netlify artifact | Supabase counterpart | Status | Note |
|---|---|---|---|
| Memory `discuss-before-build.md` | same | copied | Path changed to this project's `CLAUDE.md`. Written 2026-10-20. |
| Memory `keep-docs-in-sync.md` | same | copied | Written 2026-10-20. |
| Memory `approve-named-steps.md` | same | copied | Written 2026-10-20. |
| Memory index `MEMORY.md` | same | adapted | Pointers to the four notes (three copied, one new). |
| (no Netlify counterpart) | `subagents-haiku-only.md` | new | The owner's rule of 2026-10-20: Haiku only for subagents. |
| Netlify `CLAUDE.md` (68 KB, 376 lines) | this project's `CLAUDE.md` | adapted | Same sections; Netlify facts removed; Supabase facts and the decisions added. |
| Playbook `PLAYBOOK.md` (outside the repository) | the same file, not moved | not applicable | The book stays outside the repository (G3). |
| Scratchpad tools `check-links.mjs`, `analyze-transcript.mjs` | a link check as a test; the transcript script stays a research tool | adapted | The link check goes into the test suite (Netlify open item). |

## 7. Commands, variables and messages (playbook 10.4 to 10.6)

- Commands: every `npm` script and CLI command of Netlify has a Supabase counterpart with the same meaning: `install`, `update`, `uninstall`, `doctor`, `serve`, `help`, `add`, `list`, `default`, `remove`. The argument `--pat` stays. The commands are listed in `docs/USAGE.md` in phase B.
- Variables (playbook 10.5): `MULTI_ACCOUNT_NETLIFY_HOME` becomes `MULTI_ACCOUNT_SUPABASE_HOME`. `NETLIFY_PERSONAL_ACCESS_TOKEN` becomes `SUPABASE_ACCESS_TOKEN` (set only in the child's environment). `CODEX_HOME`, `HOME` and `USERPROFILE` are kept for the agents. `SUPABASE_CONTENT_API_URL` is read by the official server (F7) and is not set by us. The Netlify isolation variables (`APPDATA`, `LOCALAPPDATA`, `XDG_CONFIG_HOME`) are not needed for the Supabase child (my call, to test).
- Messages (playbook 10.6): each Netlify message is rewritten from the Supabase code and tests, not copied. The categories that stay are: account names, duplicates, default, unknown account, refusal of a change over several accounts, token check failed, install and uninstall results, doctor lines, the launcher's refused argument.

## 8. Count check

- Netlify artifacts listed: the 54 rows of playbook 10.3 (in sections 1 to 4, grouped where the book groups them), the 11 docs (section 2), the 5 plugin commands and the skill (section 3), the 20 test files (section 5), and the memory and records (section 6).
- Status count (sections 1 to 6): copied, adapted and not applicable are counted in the tables. Not applicable: `src/login/netlify-cli-login.ts`, `src/test/in-chat-login.test.ts`, the Netlify CLI pin (`netlify-cli` in `package.json`), and the browser-login part of `account_add`.
- Items still checked against the Netlify digests (pending): the exact lines of `ci.yml` and `npm.yml`, `package.json`, the docs headings, and the source rules of section 4.
