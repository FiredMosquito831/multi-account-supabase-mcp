# Findings note: Supabase version of the multi-account MCP

Date: 2026-10-20. Phase A only: research and decisions. No code, no repository, no remote, no install of the official package in this folder.

Labels. VERIFIED: read in a named source (file and line given). ASSUMED: our reasoning, not yet checked. OPEN: a question for the owner or a live check.

Sources. The official repository `supabase/mcp` at commit `2fca0719e46a9941a076590cc47d22583429c948` (committed 2026-10-19), cloned with `--depth 1` into the scratchpad, read only and not run. The npm registry (read only, nothing installed). The GitHub API through `gh repo view` (read only). The Netlify template: its repository, its `CLAUDE.md` and the playbook at `D:\Projects2\mcp-playbook\PLAYBOOK.md`.

## 1. Answer in brief

- The plan holds. The official server takes one personal access token per process, from the environment variable `SUPABASE_ACCESS_TOKEN` or the flag `--access-token`. One child process per account therefore works, as it does for Netlify. (VERIFIED, `packages/mcp-server-supabase/src/cli.ts` lines 98 to 105.)
- The playbook's Supabase section (9.6) has eleven errors or gaps. The two that change the design: a read-only flag hides the write tools from the list but does not block a call to them (the handler refuses it), and the stdio build does not ask for confirmation before destructive SQL. Section 4 lists all of them.
- `tools/list` makes no Management API call. It does call the content API, because the `search_docs` description is loaded from a GraphQL schema. (VERIFIED, `docs-tools.ts` lines 20 to 38.)
- Every child needs a token value to start, even one that only lists tools or searches docs. So the "no-token process" in decision S6 is not possible, and S4 becomes a placeholder question. (VERIFIED, `cli.ts` lines 100 to 105.)
- The three names are free today: npm `multi-account-supabase-mcp` and `multi-account-supabase` return E404, and `gh repo view FiredMosquito831/multi-account-supabase-mcp` finds no repository. (VERIFIED on 2026-10-20.)
- Several owner quotes in the Netlify playbook are not the owner's own words. Section 5 gives the verified wording.

## 2. Official facts

| # | Fact | Source | Label |
|---|---|---|---|
| F1 | Package `@supabase/mcp-server-supabase`, version 0.14.0, Apache-2.0, `mcpName` `com.supabase/mcp`. | `packages/mcp-server-supabase/package.json` lines 2 to 6; `.release-please-manifest.json`; `npm view` (modified 2026-10-14) | VERIFIED |
| F2 | The package folder has no README. npm reports no README data, and `files` ships only `dist/**/*`. | `package.json` line 31 to 33; `npm view ... readme` | VERIFIED |
| F3 | Command `mcp-server-supabase` runs `./dist/cli.js`. | `package.json` lines 34 to 36 | VERIFIED |
| F4 | Repository `supabase/mcp`: public, default branch `main`, last push 2026-10-19T20:58:50Z. | `gh repo view supabase/mcp` | VERIFIED |
| F5 | Token: the flag `--access-token`, or the environment variable `SUPABASE_ACCESS_TOKEN` when the flag is missing. The token is checked only for presence. | `cli.ts` lines 17, 98 | VERIFIED |
| F6 | No token: prints "Please provide a personal access token (PAT) with the --access-token flag or set the SUPABASE_ACCESS_TOKEN environment variable" to stderr, then exits with code 1. The check runs before the server is built. | `cli.ts` lines 100 to 105 | VERIFIED |
| F7 | Flags: `--access-token`, `--project-ref`, `--read-only` (default false), `--api-url`, `--content-api-url`, `--secret-url-template`, `--version`, `--features`, `--http` (default false), `--port` (default 3111). The environment variable `SUPABASE_CONTENT_API_URL` is also read. | `cli.ts` lines 14 to 80 | VERIFIED |
| F8 | `--http` starts a local HTTP server instead of stdio. The wrapper must never pass it. | `cli.ts` lines 82 to 96 | VERIFIED |
| F9 | The stdio server is created with `platform`, `projectId`, `readOnly`, `features` and `contentApiUrl` only. No `elicitation` option is passed. | `cli.ts` lines 119 to 129 | VERIFIED |
| F10 | Feature groups: `docs`, `account`, `database`, `debugging`, `development`, `functions`, `branching`, `storage`, `notebooks`. The old name `debug` maps to `debugging`. | `types.ts` lines 12 to 38 | VERIFIED |
| F11 | Default groups: `docs`, `account`, `database`, `debugging`, `development`, `functions`, `branching`. Not `storage`, not `notebooks`. | `server.ts` lines 122 to 130 | VERIFIED |
| F12 | A group that the platform does not have is refused with "This platform does not support the '<group>' feature group." | `util.ts` lines 64 to 92 | VERIFIED |
| F13 | Account tools (list and create projects, and the rest of the account group) are registered only when `--project-ref` is not given and the `account` group is on. | `server.ts` line 251 | VERIFIED |
| F14 | Read-only: the 12 write tools are marked `hidden`. A hidden tool is removed from `tools/list`, but it stays in the map that `tools/call` reads, so it can still be called. Each of the 12 handlers then refuses the call with "... in read-only mode." | `server.ts` lines 346 to 352; `packages/mcp-utils/src/server.ts` lines 64, 530, 572 to 576; the handlers listed in section 3 | VERIFIED |
| F15 | `execute_sql` stays listed in read-only mode. Its `readOnlyHint` is `readOnly ?? false` at run time. Its static annotation is `readOnlyBehavior: 'adapt'`, so it is not in the write set. | `database-operation-tools.ts` lines 264 to 273, 547 to 552; `tool-schemas.ts` lines 150 to 160 | VERIFIED |
| F16 | Every SQL call goes to `POST /v1/projects/{ref}/database/query` with `read_only` in the body. The official code does not call `/database/query/read-only`. | `platform/api-platform.ts` lines 205 to 219 | VERIFIED |
| F17 | Whether the API itself rejects writes when `read_only` is true cannot be checked from the source. | none | ASSUMED |
| F18 | Destructive-SQL confirmation is off in the stdio build. With no `confirmation` config the branch is `bypassReason = 'not_configured'`, and the SQL runs. The confirmation exists only when the server is built with an `elicitation` option. | `database-operation-tools.ts` lines 560 to 571, 626 to 631; `server.ts` lines 189 to 200, 273 to 278; `cli.ts` lines 119 to 129 | VERIFIED |
| F19 | The four elicitation tools are `create_project`, `create_branch`, `execute_sql` and `apply_migration`. In the stdio build no elicitation request is sent, so the wrapper does not have to forward one. | `types.ts` lines 3 to 8; the same as F18 | VERIFIED |
| F20 | Cost flow in the stdio build: `get_cost` (type `project` or `branch`, with the organization), then `confirm_cost` (returns an id), then `create_project` or `create_branch` with `confirm_cost_id`. The `get_cost` description says to repeat the cost to the user before going on. | `account-tools.ts` lines 73 to 113, 137 to 213, 406 to 420; `branching-tools.ts` lines 45 to 54; `server.ts` line 99 | VERIFIED |
| F21 | Raw SQL results are wrapped as untrusted data (`wrapWithUntrustedDataBoundary`). | `database-operation-tools.ts` line 634 | VERIFIED |
| F22 | Management API base `https://api.supabase.com` (overridable with `--api-url`). Both clients send `Authorization: Bearer <token>`. | `platform/api-platform.ts` line 96; `management-api/index.ts` line 22; `management-api-v2/index.ts` line 22 | VERIFIED |
| F23 | Identity call: `GET /v1/profile`, response `gotrue_id`, `primary_email`, `username`. The call itself has not been run. | `management-api/types.ts` lines 321 to 332 and 2774 to 2778 | VERIFIED (schema); OPEN (live call) |
| F24 | Other endpoints in the same types file: `GET /v1/organizations` (line 180), `GET /v1/projects` (137), `GET /v1/projects/{ref}` (809), `GET /v1/organizations/{slug}` (2309), `GET /v1/projects/{ref}/readonly` (1042), `POST /v1/projects/{ref}/readonly/temporary-disable`, "Disables project's readonly mode for the next 15 minutes" (1059 to 1068), `POST /v1/projects/{ref}/database/query/read-only` (1627). | `management-api/types.ts` | VERIFIED |
| F25 | `tools/list` does not call the Management API. Its tool definitions are static, and the only async description is `search_docs`, which loads the GraphQL schema from the content API. The content client is built with no authorization header. | `docs-tools.ts` lines 20 to 38; `content-api/index.ts` lines 15 to 39; `packages/mcp-utils/src/server.ts` lines 524 to 542 | VERIFIED |
| F26 | No network call happens when the platform object is built. `platform.init` only changes the user agent. | `api-platform.ts` lines 91 to 96, 954 to 960 | VERIFIED |
| F27 | The server needs a token value to start (F5, F6), but nothing checks that the value is valid until a Management API call is made. | `cli.ts` lines 98 to 105; F25, F26 | VERIFIED |
| F28 | Repository layout: pnpm monorepo (`pnpm-workspace.yaml`), packages `mcp-utils`, `mcp-server-supabase`, `mcp-server-postgrest`. | repository root | VERIFIED |
| F29 | The MCP registry entry `com.supabase/mcp` exists in `server.json`. | `packages/mcp-server-supabase/server.json` | VERIFIED |
| F30 | The docs on token types (scoped and classic) and the dashboard steps were not re-read today. | none | ASSUMED from the playbook, which says VERIFIED on 2026-10-19 |

## 3. Official tools (34 listed by the stdio server; 36 definitions in the source) and the mode we propose

Ruling R9 (2026-10-20): the live capture of the stdio server lists 34 tools. Two definitions are not listed: `get_logs` (hidden in favour of `query_logs` when the platform provides `queryLogs`, `debugging-tools.ts:314`) and `create_edge_function_secret` (hidden unless the client is URL-capable, `server.ts:341-342`).

Read from the static tool definitions. `R` means `readOnlyHint: true` in the source, `W` means `false`. The live list through a throwaway process is still to be read (phase B, step 2).

| # | Tool | Group | File | Hint | Proposed mode | Reason |
|---|---|---|---|---|---|---|
| 1 | list_organizations | account | account-tools | R | all | no id |
| 2 | get_organization | account | account-tools | R | locate | `id` |
| 3 | list_projects | account | account-tools | R | all | no id; each account lists its own projects |
| 4 | get_project | account | account-tools | R | locate | `id` |
| 5 | get_cost | account | account-tools | R | one | organization; a cost read, one named account (S8, answered: both one) |
| 6 | confirm_cost | account | account-tools | R | one | issues the id that authorises a create (see S8) |
| 7 | create_project | account | account-tools | W | one | write, costs money |
| 8 | pause_project | account | account-tools | W | one | write |
| 9 | restore_project | account | account-tools | W | one | write |
| 10 | create_branch | branching | branching-tools | W | one | write, costs money |
| 11 | list_branches | branching | branching-tools | R | locate | `project_id` |
| 12 | delete_branch | branching | branching-tools | W | one | write |
| 13 | merge_branch | branching | branching-tools | W | one | write |
| 14 | reset_branch | branching | branching-tools | W | one | write |
| 15 | rebase_branch | branching | branching-tools | W | one | write |
| 16 | list_tables | database | database-operation-tools | R | locate | `project_id` |
| 17 | list_extensions | database | database-operation-tools | R | locate | `project_id` |
| 18 | list_migrations | database | database-operation-tools | R | locate | `project_id` |
| 19 | apply_migration | database | database-operation-tools | W | one | write |
| 20 | execute_sql | database | database-operation-tools | W static, adapt; runtime follows the flag | one, never fanned out | SQL decides read or write (S3, S7) |
| 21 | get_logs | debugging | debugging-tools | R | not listed | hidden by the stdio server; `query_logs` is listed instead (R9) |
| 22 | query_logs | debugging | debugging-tools | R | locate | `project_id` |
| 23 | get_advisors | debugging | debugging-tools | R | locate | `project_id` |
| 24 | get_project_url | development | development-tools | R | locate | `project_id` |
| 25 | get_publishable_keys | development | development-tools | R | locate | `project_id`; a sensitive read |
| 26 | generate_typescript_types | development | development-tools | R | locate | `project_id` |
| 27 | search_docs | docs | docs-tools | R | none | content API only; needs a child to start (S4, S6) |
| 28 | list_edge_functions | functions | edge-function-tools | R | locate | `project_id` |
| 29 | get_edge_function | functions | edge-function-tools | R | locate | `project_id` |
| 30 | deploy_edge_function | functions | edge-function-tools | W | one | write |
| 31 | create_edge_function_secret | functions | secret-tools | W | not listed | HTTP-only: hidden unless the client is URL-capable (`server.ts:341-342`; R9) |
| 32 | list_notebooks | notebooks | notebook-tools | R | locate | `project_id` |
| 33 | get_notebook | notebooks | notebook-tools | R | locate | `project_id`, `notebook_id` |
| 34 | list_storage_buckets | storage | storage-tools | R | locate | `project_id` |
| 35 | get_storage_config | storage | storage-tools | R | locate | `project_id` |
| 36 | update_storage_config | storage | storage-tools | W | one | write |

Count: `all` 2, `locate` 17, `one` 14 (includes `confirm_cost`, `get_cost` and `execute_sql`), `none` 1. Total 34 listed by the stdio server (R9). The owner also chose one read-only query tool, mode `locate` (S3, exception to the rule of adding only the `account` argument). It is not in the official list. The read-only write set has 11 members in the stdio list: tools 7, 8, 9, 10, 12, 13, 14, 15, 19, 30, 36 (`create_edge_function_secret`, tool 31, is not listed). `execute_sql` is not in it, because its readOnlyBehavior is `adapt`.

Modes follow the Netlify rule (P4): `all` for reads with no id, `locate` for reads with an id, `one` for every change and every operation the table does not know (P5). The coverage test will check this table against the live list in phase B.

## 4. Corrections to the playbook (Supabase parts)

| # | Playbook place | What it says | What the code says | Effect |
|---|---|---|---|---|
| K1 | 9.6.3 and 9.6.1 (read-only) | "A tool stays in the list, and the call fails." | The 12 write tools are removed from the list, but a call by name reaches the handler and is refused there (F14). Only `execute_sql` stays listed (F15). | The catalog child must not run with `--read-only`, or it would not list the write tools. The policy must not depend on the list. |
| K2 | 9.6.1 (read-only SQL endpoint) | Implies the official server uses `/database/query/read-only`. | It always uses `/database/query` with `read_only` in the body (F16). | The read-only endpoint is not part of the official path. Whether the API enforces `read_only` is ASSUMED (F17). |
| K3 | 9.6.1 (default feature groups, OPEN item 5) | Open. | Answered (F11). | Default: `docs, account, database, debugging, development, functions, branching`. |
| K4 | 9.6.1 (list of 22 tool names) | 22 names. | 36 definitions. Missing from the book: `get_organization`, `list_branches`, `delete_branch`, `rebase_branch`, `query_logs`, `get_project_url`, `list_edge_functions`, `get_edge_function`, `create_edge_function_secret`, `list_notebooks`, `get_notebook`, `list_storage_buckets`, `get_storage_config`, `update_storage_config`. Also `get_logs` etc. are present. | Section 3 is the list to use. |
| K5 | 9.6.1 (flags) | Lists six flags and the npm-only ones. | Ten flags, including `--http` and `--port`, and `--version`. `--http` is a server mode that the wrapper must not use (F7, F8). | Add `--http` and `--port` to the refused-flags list of the wrapper's own docs. |
| K6 | 9.6.6 item 4 (package README, OPEN) | "Read it." | The package has no README (F2). The root `README.md` covers the monorepo and gives a hosted example at line 95. | Close the item. Our own package README is written from scratch. |
| K7 | 9.6.6 (open: does `tools/list` make an API call?) | Open. | It calls the content API for `search_docs`, not the Management API (F25). | Answered. The catalog child needs network access (or the docs description fails). ASSUMED: a failed schema load fails the whole list. Not tested. |
| K8 | 9.6.1 (confirmation: "Destructive SQL goes through a confirmation record") and 9.6.5 | Implies destructive SQL is confirmed. | In the stdio build it is not (F18). This is a real risk for `execute_sql` and `apply_migration`. | New decision S7. |
| K9 | 9.6.2 item 2 and 9.9 S6 | "A process with no token for search_docs." | A start with no token exits with code 1 (F6). A no-token process is not possible. | S4 and S6 change (section 6). |
| K10 | 9.6.6 item 6 (cost flow, OPEN) | Open. | The flow is known from code (F20). The price is not known; a live create costs money and is not planned. | Keep the create checks in the live list only. |
| K11 | 9.6.1 ("the npm build has `--secret-url-template` and `--version`") | Npm-only. | Both are in `cli.ts` too. | Minor. |
| K12 | 9.6.1 (monorepo) | Not stated. | The official repository uses pnpm. Our template uses npm. | Our package keeps npm, as the template does (my call). |
| K13 | 9.6.1 and section 3 (tool count) | 36 tools. | The stdio server lists 34 (live capture, 2026-10-20, ruling R9). `get_logs` is hidden in favour of `query_logs`; `create_edge_function_secret` is HTTP-only. | The table, the counts and the coverage fixture use 34. |

Corrections to the Netlify side are not part of this note. The owner's G4 decision covers them, and the book's section 10.9 is the list.

## 5. Owner quotes (from the saved Netlify transcript, read by script)

The script reads the transcript one line at a time and only the entries whose role is user. It covered 116 user-text entries. It may miss a message stored in another format.

Verified as the owner's own words:

- Line 97: "discuss and research with me so we decide on how we will work options preferences etc. Also make my github repo multi-account-netlify-mcp public"
- Line 195: "1. separate netlify login per account and cred stored BUT ALSO ADD fallback option for netlify personal access token" and "2. you decide but basically i want it to be able to send the tool calls/querries to one account or multiple accounts at the same time or all accounts yeah?"
- Line 1639 (2026-10-19T12:39:11Z): "also we should do all ops mostly for read ops with the multi account netlify mcp like checking and finding projects etc i don't think there are many cases where a write to all accounts at once, but we can send qurries to all accounts at once for read operations like seeing accounts keys etc (all read operations). Discuss with me on this regarding all the surfaces nad ops that can be done via this mcp"
- Line 1558 (surfaced during a turn): "also on every push"
- Line 1921 (2026-10-19T12:59:32Z): "release yeah, btw i added the settings to the npm package so when we do a new release on github it happens on npm too so release on gitub and do the version bump"
- Line 2056 (2026-10-19T13:14:43Z): "btw can we install it with sccope like global (default) local or project like with ase moodle and like the official netlif mcp can do so too? do we fully have the features of the normal netlify mcp too?"
- Line 5513: "i was using the wrong link" and "it was my mistake"

Not the owner's own words (found only in compaction summaries, lines 3740, 3765, 3960, 3963, 7160):

- "make it interactive like we do it for google-services-mcps" (book D25 quotes it as the request).
- "i let you make and take all calls" (book 8.3 and R1).
- "i give you go ahead" (summary text).
- "keep everything the official server has" (book D12) and "see all answers" (book D15): no match in the owner's messages.
- "mostly reads" (book D11): a paraphrase. The owner's words are the line 1639 sentence above.
- "Are you sure? Please check the marketplace link." (book 5.1, R2): no match in any user message.

Book R2 is wrong in one respect. The two "wrong link" and "my mistake" messages are in the transcript as user messages (line 5513). Book R1 is correct: "I let you make and take all the calls" appears only in a summary.

## 6. Decisions for the owner

ANSWERED by the owner on 2026-10-20: S1 environment variable. S2 two children. S3 `execute_sql` on one writable account, plus a read-only query tool now (an exception to the rule; the name is ours to propose). S4 placeholder value, tested first, fallback from one account. S5 caret `^0.14.0`. S6 `search_docs` on the placeholder child. S7 pass through, as the official server: the owner chose this against the recommended gate, and the risk is accepted. S8 both `one`. S9 a slash command starts a guided add, the token is typed in a terminal, a key is treated like a token, OAuth is researched later. S10 a read uses the default account, a change without a name is refused. G1 copy now. G2 names as proposed. G3 playbook outside the repository. The options below are kept as the record of what was asked.

- **S1. Token in the environment variable `SUPABASE_ACCESS_TOKEN`, not in a flag.** Recommended. The official server accepts both (F5). A flag shows in the process list.
- **S2. Two child processes per account.** A read-only child (`--read-only`) serves every read. A writable child serves only a single-account change, so a list or `all` can never reach it. Recommended. Note: the writable child is the one that lists the write tools, so the catalog child must be a writable one (K1).
- **S3. `execute_sql` runs on one writable account only.** Recommended. The tool is mixed, and the SQL text decides read or write, so no parameter can classify it. A separate read-only query tool can come later, with its own mode.
- **S4. How the tool list is read when a child needs a token value.** Recommended: start a child with a placeholder that is never a real token, and use it for the catalog only if the list comes back. The platform sends the Bearer token only on Management API calls, and the list makes none (F22, F25). The placeholder is therefore never sent to Supabase's Management API. The list does call the content API, so the test needs network access. Fallback if the test fails: read the list from one account's child. This test is a live check in a throwaway folder, and nothing real is typed.
- **S5. Version pin: caret range `^0.14.0`.** Recommended. The Netlify project pins its official package with a caret (`^1.19.0`). For a 0.x package npm treats `^0.14.0` as `>=0.14.0 <0.15.0`, so only patch releases arrive on their own. A minor release (0.15.0) needs a manual change. The coverage test catches tool changes.
- **S6. Tools that need no account, such as `search_docs`.** Corrected (K9). A process with no token does not start, so `search_docs` runs on the placeholder child from S4. It uses no account data. Recommended.
- **G1. Copy the core now; extract a shared package only after the second provider works.** Recommended.
- **G2. The names.** Checked today (section 8). Recommended as listed: repository and npm package and command `multi-account-supabase-mcp`; server key `supabase`; plugin `multi-account-supabase`; marketplace `multi-account-supabase-mcp`.
- **G3. The book stays outside the repository.** Recommended. The project's `CLAUDE.md` summarises what this project needs from it.
- **S7 (new). Destructive SQL in the stdio build is not confirmed (K8, F18).** Options: (a) keep the official behaviour and say so in the tool descriptions and the skill; (b) the wrapper refuses SQL that matches the destructive-statement rules unless the owner turns it on for one account, with the default off; (c) leave `execute_sql` out of the wrapper until a gate exists. Recommended: (b). It matches the owner's Netlify preference "Changes are refused or confirmed first". It is not a new tool parameter, so P13 still holds. It changes the official result for destructive SQL, so the owner must decide.
- **S8 (new). Classification of `confirm_cost` and `get_cost`.** Both are `readOnlyHint: true` in the official source. `confirm_cost` issues the id that authorises a create. Options: `one` for `confirm_cost` (it belongs with the create), `locate` for `get_cost`. Recommended: as stated. Under the rule that an unknown operation counts as a change, `one` is the safe default.
- **S9 (new). In-chat add of an account.** Netlify has `account_add`, which starts a browser login in the chat. Supabase has no browser login in this plan: the token is typed in a terminal (`add <name> --pat`), as the owner decided for Netlify's PAT route. Options: (a) no `account_add`, and `account_list` only; (b) an `account_add` that only tells the user the terminal command. Recommended: (a).

- **S10 (new, from the builder check). A call that omits `account`.** A read uses the default account. A change without an explicit name is refused (recommended). The Netlify template sends a change to the default account (its decision D10). The stricter rule follows the owner's preference for refusing changes first.
- **S7, detail added after the builder check.** The setting lives in `accounts.json` (`allowDestructiveSql`, default false). Only a terminal command changes it, and it covers `execute_sql` and `apply_migration`. The text rules are a second layer, not a barrier, because a stored function can still delete data. See design 6.5.

Settled by me, to be checked by the owner while reading (my calls):

- The design goes to `docs/superpowers/specs/2026-10-20-supabase-mcp-design.md` in this folder, not yet committed (there is no repository yet).
- The Netlify defects in book section 10.9 are not copied. The Supabase code implements the intended behaviour, and each rule has a test (G4 stays the owner's decision).
- The child's environment carries only the token variable and the minimum needed to run. The official server reads no config file (F5), so the Netlify isolation folders are not needed. ASSUMED, to test in phase B.
- Node 22 or later, TypeScript 5.9, `node:test`, npm for our package. The same as the Netlify template.

## 7. Not verified and open

- OPEN: the live tool list and each tool's `readOnlyHint` through a throwaway child (phase B, step 2). Static reading only so far.
- OPEN: `tools/list` with a placeholder token (S4). Needs network access and a throwaway child.
- OPEN: `GET /v1/profile` with a real token. The schema is verified, the call is not run.
- OPEN: whether the API rejects writes when `read_only` is true (F17).
- OPEN: what a bad `--features` value does. Reading suggests the error is printed and the process exits with code 0 (ASSUMED). A throwaway test would confirm it.
- OPEN: the live cost flow. It is not planned; creating a project costs money.
- OPEN: the docs on token types (scoped and classic) and the dashboard steps (F30).
- OPEN: the agent CLIs (Claude Code, Codex, opencode, Antigravity) are checked from the Netlify notes of 2026-10-19 only. They must be read again in phase B.
- Not tested: nothing has been run. The official package was not installed. No token was typed or used. No login was done. No network call was made except the registry and GitHub reads listed in section 8.

## 8. Names (checked 2026-10-20)

| Item | Proposed | Result today |
|---|---|---|
| Repository | `multi-account-supabase-mcp` under `FiredMosquito831` | `gh repo view`: not found (VERIFIED) |
| npm package and command | `multi-account-supabase-mcp` | `npm view`: E404 (VERIFIED) |
| npm package for the plugin name | `multi-account-supabase` | `npm view`: E404 (VERIFIED) |
| Server key in agents | `supabase` | Not an npm or GitHub name. Local plugin cache has no `supabase` folder (names only). The official MCP registry name is `com.supabase/mcp` (F29). No clash found. ASSUMED. |
| Marketplace | `multi-account-supabase-mcp` | Not checked on npm (marketplaces are not on npm). ASSUMED free. |
| Credential service and data folder | `multi-account-supabase-mcp` | Our naming. Not checked. |

The official package `@supabase/mcp-server-supabase` is 0.14.0 on npm today (VERIFIED).

## 9. Sources read

- Official repository (clone, depth 1, scratchpad, read only): `README.md` (root), `package.json`, `.release-please-manifest.json`, `pnpm-workspace.yaml`, `server.json`, `packages/mcp-server-supabase/package.json`, `src/cli.ts`, `src/types.ts`, `src/util.ts`, `src/server.ts` (lines 120 to 404), `src/tools/*.ts` (tool definitions, annotations and handlers, by search), `src/platform/api-platform.ts` (by search and reads), `src/management-api/types.ts` (by search), `src/content-api/index.ts`, `src/tools/destructive-sql.ts` (first 30 lines), `packages/mcp-utils/src/server.ts` (lines 518 to 590).
- npm (registry metadata only): `@supabase/mcp-server-supabase` (version, time, readme), `multi-account-supabase-mcp`, `multi-account-supabase`.
- GitHub (read only): `supabase/mcp`, `FiredMosquito831/multi-account-supabase-mcp`.
- Netlify template: `CLAUDE.md` (all 376 lines), `D:\Projects2\mcp-playbook\PLAYBOOK.md` (Parts 0, 1, 2, 8, 9, 10 by reading; Parts 3 to 7 by a digest, pending), the owner's memory notes (3 files), and the transcript by script.
- Netlify docs, CI and package files: a read-only Haiku digest (26 files). Spot-checked by line-numbered search. Section 10.
- Netlify source (`src/`): a read-only Haiku digest (38 files read in full, test files by title). Verified defects, section 11.
- Playbook Parts 3 to 7: a read-only Haiku digest. Its contradictions are inside the book, section 11.

## 11. Netlify source defects, and the playbook digest (2026-10-20)

Source digest: `scratchpad\digests\netlify-src-digest.md`. It read 38 files in full: 28 source files under `src\` outside the tests, and 10 plugin and marketplace files. The test files were read by title only. The harness flagged the digest's output as matching an instruction-shaped pattern. No instruction from it was followed; its claims were checked against the source.

Verified by reading the source (VERIFIED):

- T1 Inherited names fail open. `src/mux/policy.ts` line 10 declares `OPERATION_MODES` as a plain object. Line 57 returns `OPERATION_MODES[operation] ?? 'one'`. For a name such as `constructor`, the lookup returns an inherited function, not `undefined`, so the `?? 'one'` default never applies. The guard at `src/mux/server.ts` line 106 (`mode === 'one'`) then does not refuse. Supabase rule: a `Map` or a null-prototype table, and a test with `constructor`, `toString` and `__proto__`.
- T2 Short successful answers can be dropped. `src/mux/server.ts` lines 46 to 51. In `locate` mode, a successful answer under 200 characters that contains the word "404" or "not found" is classed as a miss and left out. Supabase rule: the miss test reads the error flag and the structured result, not free text alone. A test with a short successful answer that contains those words.
- T3 A user argument reaches the shell first. `plugins/multi-account-netlify/commands/set-default.md` line 6 puts `$1` into a `!` line. The allowlist in `bin/launch.mjs` (line 20, applied at lines 54 to 58) runs after the shell has read the line, so it does not protect this path. The playbook's decision D48 names the refusal as the protection. Supabase rule: no user text in a `!` line (design 6.12).
- T4 The login child gets the whole parent environment. `src/login/netlify-cli-login.ts` lines 45 to 51 copy `process.env` and then override the profile variables. Supabase rule: the child environment is an allowlist.
- T5 A failed clean-up is silent. `forgetProfile` (lines 127 to 132) ignores every error from `rm`. The comment at lines 139 and 140 says the token "only lives in memory and in the credential store". If the file cannot be removed (Windows keeps it locked), the token stays on disk, and nothing reports it. Supabase has no CLI login, so there is no token file. The general rule: a failed removal of a credential is reported, never swallowed.
- T6 Removal by name. `src/agents/codex.ts` lines 55 to 57 and 102 to 103 remove `SERVER_NAME` by name, before an add and at uninstall, not by the ownership record. This matches the playbook's known differences C3 and C5 (10.9). Supabase rule: remove only recorded entries. A pre-existing entry with the same name is reported, not removed.

SUSPECTED, not checked line by line:

- T7 Project and local installs take the marketplace from the GitHub default branch. The launcher's npx route then follows the version in that branch's `plugin.json`, with no integrity check. Supabase: pin the marketplace to a release, if Claude Code allows a ref (OPEN, phase B).
- A test title at `policy-routing.test.ts` line 137 may conflict with `policy.ts` lines 22 and 50 to 52 (the digest's note, not read by me).

These defects are the Netlify side. The owner decides whether to fix them (G4). They are not fixed here, and the Supabase copy does not repeat them (design 6.12).

Playbook Parts 3 to 7 digest (`scratchpad\digests\playbook-parts-3-7-digest.md`). It reports 16 SUSPECTED contradictions inside the book. Those that matter for Supabase:

- The book says the suite never reaches the network. Its integration test starts the real package. Supabase: the integration test runs without the `docs` group, and the `docs` path is checked live (design 6.11).
- The book says the tool list is read "at startup" in one place, and lazily in another. Supabase: the design reads it lazily on the first `tools/list` and caches it (MY CALL).
- The digest's read overran into Part 8. Nothing from Part 8 is in the digest. The digest did not compare Part 10.9; that list is the book's own, and the Supabase plan follows the code.

## 10. Netlify docs, CI and package files (Haiku digest, spot-checked 2026-10-20)

The digest is `scratchpad\digests\netlify-docs-release-digest.md`. It read 26 files and ran no program. The claims below were confirmed by a line-numbered search of the Netlify repository, read only.

Confirmed (VERIFIED by search):

- Publishing uses trusted publishing: `id-token: write` (`.github/workflows/npm.yml` line 69) and `npm publish --provenance --access public` (line 107). No npm token is stored; neither `NODE_AUTH_TOKEN` nor `NPM_TOKEN` appears in the workflows.
- The publish gate runs the tests on Windows only (`npm.yml` line 47). The CI matrix runs Windows and Ubuntu (`ci.yml` line 12).
- The publish job installs `npm@latest` (`npm.yml` line 81), which is not pinned. It publishes on Node 24 (line 77); the tests run on Node 22 (`npm.yml` line 55, `ci.yml` line 19).
- `package.json`: `@netlify/mcp` `^1.19.0` (line 53); `netlify-cli` `27.13.0`, exact (line 54). `files` (lines 31 to 39) leaves out `docs/`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md` and `src/`.
- `.gitignore` line 5 is `CLAUDE.md`. `.claude/` and `.remember/` are ignored too.
- README links to the docs are absolute GitHub URLs (README lines 52 to 63 and 138).

Contradictions in the Netlify docs (checked):

- D1 Linux. `README.md` line 152 and `docs/INSTALL.md` line 14 say "macOS and Linux are untested". `docs/TESTING.md` line 90 says "Ubuntu passes the suite", and CI runs Ubuntu (`ci.yml` line 12). Confirmed.
- D2 Uninstall of empty files and folders. `docs/INSTALL.md` line 86 removes an empty file or folder with no condition. `docs/USAGE.md` line 127 and `docs/DEVELOPMENT.md` line 84 remove one only if this tool created it. Confirmed.
- D3 Backups. `README.md` line 145 says agent config files are backed up before a change. `docs/CONFIGURATION.md` line 81 says only the opencode file. Confirmed as a gap in the wording.
- D4 Locate and secrets. `docs/SAFETY.md` lines 24 and 25 say secret values are read "on every account". `docs/MCP.md` lines 53, 83 and 84 say that in `locate` only the owning account answers. Confirmed.
- D5 Visibility of a new account. `docs/MCP.md` line 141 says "seen immediately"; line 168 says "after the agent restarts". Not checked by me.
- D6 Two server keys. The plugin's `.mcp.json` uses `netlify`; `docs/AGENTS.md` uses `multi-account-netlify`. Taken from the digest, which read both files.

None of these is copied. The Supabase docs state each rule once, in the words of the code. The Netlify side is the owner's separate decision (G4).

My calls for the Supabase copy (listed for review in the design, section 6):

- The publish gate runs the same matrix as CI, Windows and Ubuntu. The release gate is never weaker than CI.
- The docs state the tested platforms exactly as CI runs them.
- The npm version used to publish is pinned to a version that trusted publishing supports (npm 11.5.1 or newer). The exact version is chosen in phase B with `npm view npm version`.
- Server keys: the plugin uses `supabase`, so tool ids read `plugin:multi-account-supabase:supabase`. Direct installs use `multi-account-supabase`, which is the template's server-name pattern. That avoids a clash with an official `supabase` entry in an agent's configuration.
