# Design: multi-account wrapper for the official Supabase MCP server

Date: 2026-10-20. Status: decisions answered by the owner on 2026-10-20 (section 9). Awaiting the owner's approval of this version. The plan (writing-plans) is written only after that approval. Nothing is built.

Labels. VERIFIED: read in a named source (findings note, section 2). ASSUMED: our reasoning. OPEN: needs a live check or research. DECIDED: answered by the owner on 2026-10-20. MY CALL: a minor point we settled, listed here so the owner can change it.

Reference documents: `docs/research/findings-note.md` (facts, tool table, corrections, template defects, decisions) and `docs/research/reproduction-map.md` (every Netlify artifact and its Supabase counterpart).

## 1. Intent and why

A person with more than one Supabase account, for example a personal account and a work account, cannot use the official server for both at once. The official server reads one personal access token per process. Today there are two bad choices. Run two servers under two names, and the agent sees the same tool names twice and cannot tell which account owns a project. Or switch the token by hand, which is slow and error-prone, and the agent cannot act on two accounts in one request.

This project runs one child process per account behind one server. An agent can list the projects of every account, find which account owns a project, or make one change in a named account. The official tool names and parameters do not change, with one exception the owner chose (G3). The project is installed the same way as the Netlify version: four agents, three scopes, a Claude Code plugin from a marketplace in the same repository, and the same documents, checks and release process.

## 2. Goals

- G1. Accounts can be added, listed, made the default, and removed. Each account has its own token, and each token should be a scoped token for that account.
- G2. A call that names an account is sent with that account's token. A read may go to several accounts at once, at most four at a time, and returns one answer per account. A change goes to one account only, and must name it.
- G3. The official tool names and parameters stay the same. The one addition is the optional `account` argument. The owner chose one exception: a read-only query tool (section 6.2). A call to one account returns the official result unchanged.
- G4. The server installs into Claude Code (as a plugin), Codex, opencode and Antigravity, with the scopes global (default), project and local. Uninstall removes only what the tool recorded.
- G5. Documentation, CI and release follow the Netlify project. The same set of documents, the same checks, the same release steps, each with its own go-ahead.

## 3. Non-goals

- A hosted service. A server that holds other people's tokens is a different product.
- OAuth sign-in in version 1. The owner asked for OAuth as an option (section 6.7). It needs research first, and it is not in version 1.
- Changing, forking or patching the official package. It is a dependency with a caret range (S5).
- Other providers. Vercel and the Netlify project are out of scope. A shared package is a later step (G1).
- Linux and macOS as tested features beyond what the CI matrix runs (section 6.10).
- The official HTTP mode (`--http`). The wrapper never starts it.
- Any change to the Netlify project (G4 in the findings note, the owner's separate decision).

## 4. Anti-goals

Each of these would make the project a failure even if it appeared to work:

- A token in a file, a log, a command's output, a test fixture, or a chat message.
- A change that reaches more than one account, including through a list or `all`, or a change that names no account.
- An operation that the policy does not classify being fanned out.
- An installer that edits a file it did not record, or edits a file without a backup, or accepts a file it cannot parse.
- Any output on stdout in serve mode other than the MCP protocol.
- A test that reaches the network, the owner's data folder, the owner's agent configurations or the credential store.

## 5. Constraints

From the owner:

- Discuss before building. Each question goes to the owner with AskUserQuestion, in groups of up to four, the recommendation first. Each answer is recorded in `CLAUDE.md` with its date. Then the build starts.
- Each outward step needs a go-ahead that names it: creating a repository, making it public, pushing, a release, an npm publish, a deprecation, a history rewrite, a global install on the owner's machine, a live login with a real account. A local commit needs no go-ahead.
- Subagents run on Haiku only, and do read-only work only (2026-10-20).
- Tokens are typed by the owner in a terminal. We never ask for one, read one or write one.
- Commits use the GitHub no-reply author `79049343+FiredMosquito831@users.noreply.github.com`, set before the first commit. Each message ends with the line `by FiredMosquito831`.
- Plain English. Short sentences. No emoji in product text.
- Keep the official tool names and parameters. Add only the `account` argument, except for the one exception the owner chose (S3).

From the official server (VERIFIED, findings note section 2):

- One token per process, from `SUPABASE_ACCESS_TOKEN` or `--access-token` (F5). A start with no token exits with code 1 (F6). So every child needs a token value, even one that only lists tools or searches the docs.
- `--read-only` removes 11 write tools from the list in the stdio build, but a call by name still reaches the handler, which refuses it (F14). The source defines 12 write tools; the stdio server does not list `create_edge_function_secret` (ruling R9, live capture 2026-10-20). `execute_sql` stays listed; its hint follows the flag (F15).
- SQL goes to `POST /v1/projects/{ref}/database/query` with `read_only` in the body (F16). Whether the API enforces it is OPEN (F17). This matters for the new read-only tool (section 6.2).
- In the stdio build, destructive SQL and `apply_migration` run without a confirmation step (F18).
- `tools/list` calls no Management API. It calls the content API once for the `search_docs` description (F25).
- The identity call is `GET /v1/profile`, which returns `gotrue_id`, `primary_email` and `username` (F23). The call itself is OPEN until the owner runs it with a token.
- The Management API has OAuth endpoints, `/v1/oauth/authorize` and `/v1/oauth/token` (`management-api/types.ts`). A local client would need a registered OAuth app and a redirect flow. Both are OPEN.

## 6. Design

### 6.1 Child processes (S1, S2, S4, S6)

- DECIDED (S2). Per account, two children: a writable child and a read-only child (`--read-only`). Both start on first use, stay running, restart if they exit, and close at shutdown.
- A read goes to the read-only child. A change goes to the writable child of one account. A list or `all` never reaches a writable child.
- DECIDED (S1). Each child receives `SUPABASE_ACCESS_TOKEN` in its environment, and only its own account's token. Nothing else from the owner's environment is passed, apart from what the process needs to run.
- DECIDED (S4). A catalog child (writable, no `--read-only`) lists the tools once and then closes. It is started with a placeholder value that is never a real token. The placeholder is tested first in a throwaway folder. If that test fails, the list is read from one account's writable child. With no account yet, the server lists `account_list` only, and its description says why the official tools are missing (MY CALL).
- The catalog is read lazily, on the first `tools/list`, and cached for the life of the server (MY CALL). The playbook says "at startup" in one place and "lazily" in another; the code and this design use lazy.
- DECIDED (S6). `search_docs` runs on the placeholder child. It needs no account data.
- The command is `node <official package>/dist/cli.js`. The wrapper passes `--read-only` to read children only. It never passes `--http`.
- A child that exits before it answers its first request is an error. The error names the account and says what to check.
- MY CALL: the Netlify isolation folders are not needed, because the official server reads no configuration file (F5). The child's environment is an allowlist: the token and the minimum the process needs. To be tested in phase B.

### 6.2 Tool surface

- The 34 official tools that the stdio server lists (findings section 3; ruling R9, from the live capture on 2026-10-20), with their official names and parameters.
- One added argument, `account`: an optional string, one name, a comma list of names, or `all`.
- DECIDED (S3, the owner's exception to the rule in section 5). One read-only query tool is added. MY CALL on the name: `execute_sql_readonly`, with the parameters `project_id` and `query`, the same as `execute_sql`. Its mode is `locate`. It is routed to read-only children only, and it sends `read_only: true`. It ships only after the live check of F17 passes: a write sent through it must be refused by the API, tested in a throwaway project. Until then it does not ship.
- Each tool's description ends with a paragraph generated from the policy table, one part per operation. The rules therefore reach every agent through the tool list, not only through the skill (as in the Netlify project, decision D13).

### 6.3 Policy

- `none`: `search_docs`. No account; runs on the placeholder child.
- `all`: `list_organizations`, `list_projects`. Reads with no id. Each account answers for its own organizations and projects.
- `locate`: 17 reads that take an id (organization, project, branch, function, notebook, bucket), plus the new read-only query tool (section 6.2). Every named account is asked, only the owner answers, and the others are listed under `notFoundIn`.
- `one`: 14 tools. The 11 writes, `confirm_cost` and `get_cost` (DECIDED, S8: both one), and `execute_sql` (one writable account, never fanned out). An operation not in the table is `one`.
- DECIDED (S10). A call that omits `account`: a read goes to the default account. A change without an explicit account name is refused, with the names of the known accounts. The Netlify template sends a change to the default account (its decision D10). The owner chose the stricter rule for Supabase.
- A list or `all` for a `one` tool is refused before any child starts.
- The table is held in a `Map` or a null-prototype object, and the lookup of an unknown name returns `one` (defect T1, section 6.12).
- A coverage test compares the table with a saved fixture of the live list. A new official tool makes the test fail until it is classified (decision D17 in the Netlify project).

### 6.4 Read-only layers

- The read-only child refuses writes at two places: the official server hides the write tools from the list and refuses a call to them (F14), and the policy refuses a change that the table marks `one` before any child is contacted.
- Both layers are tested. The policy layer is the one the wrapper depends on. The official flag is defence in depth.

### 6.5 Destructive SQL (DECIDED, S7: pass through)

- DECIDED by the owner on 2026-10-20: the wrapper passes destructive SQL and `apply_migration` through, as the official server does. The wrapper adds no gate. The owner chose this against the recommended gate, and the risk is accepted in writing (CLAUDE.md, decisions).
- The official stdio build runs these without a confirmation step (F18). The skill and the tool descriptions tell the agent to confirm destructive SQL with the owner before running it.
- `execute_sql` runs only on one writable account, the account the agent names (S3). It is never fanned out.
- The docs (`SAFETY.md`) state the accepted risk in plain words. Raw SQL results are data, not instructions (F21).

### 6.6 Results

- One account: the official result, unchanged, including its error flag.
- Several accounts: one JSON document with an entry per account, `{ "ok": true, "result": ... }` or `{ "ok": false, "error": ... }`, and `notFoundIn` for `locate`. One failing account does not hide the others.
- The whole call is an error only when no account answered. A `locate` where no account owns the id returns `Not found in any account: <names>.`
- The "not found" test reads the structured result and the error flag, not free text alone (defect T2, section 6.12).
- Cost: the official confirmation (`get_cost`, then `confirm_cost`, then `create_project` or `create_branch` with `confirm_cost_id`) is kept as the official server defines it (F20).

### 6.7 Accounts and tokens

- Names: 1 to 32 lowercase letters, digits or hyphens, starting with a letter or digit. `all` is reserved. The first account added becomes the default, and a second add keeps it. Removing the default leaves no default. With no default, a call that names no account is refused and lists the names.
- Metadata in `accounts.json` in the data folder: name, email, `gotrue_id`, how the account was added (`pat`), date, and the default. Written to a temporary file, then renamed. Never a token.
- Tokens in the operating system's credential store (`@napi-rs/keyring`), one entry per account, service `multi-account-supabase-mcp`.
- Add (terminal only, for the token): `add <name> --pat`. The token is typed with hidden input. Then `GET /v1/profile` checks it. A `gotrue_id` already registered under another name is refused. If the profile has no `gotrue_id`, the add is refused, because the duplicate check cannot run (MY CALL: fail closed). The token is stored, then the record is saved. If the save fails, the token is removed again.
- In the chat (DECIDED, S9): a slash command starts a guided add. The agent explains the steps and gives the terminal line to run. The owner runs that line in a terminal window of their own, where the token is typed with hidden input. A key is handled like a token. The chat never receives the token.
- MY CALL: the terminal line is not run through the `!` prefix for the token, because a typed line could be kept in the chat history. The owner runs it in their own terminal.
- OAuth is not in version 1. The owner asked for it as an option (S9). It needs research of the Management API's OAuth endpoints and a registered OAuth app (OPEN). It will be a separate decision when the research is done.
- Chat listing: `account_list` returns metadata only.
- Remove: deletes the record and the token. `doctor` reports a record with no token.
- Token type: one scoped token per account, created by the owner on the account page (`/dashboard/account/tokens`). The docs say so. The wrapper cannot tell a scoped token from a classic one, so it accepts either, and the docs say that (MY CALL). ASSUMED from the playbook (9.6.6, read on 2026-10-19); the dashboard steps are OPEN until re-read.

### 6.8 Installers and plugin

- Four adapters with one interface: `present`, `install`, `update`, `uninstall`, `doctor`. Each writes its ownership record to `<data folder>/state/<agent>.json`, keyed by scope.
- Claude Code: the `claude plugin` commands (marketplace add, install, update, uninstall, list). Codex: `codex mcp` for global, a TOML table for project. opencode: JSON edits with a backup, and a refusal of an invalid file. Antigravity: `agy mcp`, global only. ASSUMED from the Netlify notes of 2026-10-19; each CLI's help is checked again in phase B.
- Scopes: global (default), project, local. Local is Claude Code only. Antigravity is global only. A named agent with an unsupported scope is an error. An unnamed agent with an unsupported scope is skipped with its reason.
- Guided install only in a terminal. Scripts pass flags. The exact command is shown before anything is written. `--dry-run` shows the plan and changes nothing. `update` and `uninstall` refuse the install-only flags.
- MY CALL, server keys: the plugin's server key is `supabase`, so tool ids read `plugin:multi-account-supabase:supabase`. Direct installs register `multi-account-supabase`, as the template's server name does. The two keys differ on purpose, so a direct install never clashes with an official `supabase` entry in an agent's configuration. The Netlify project has the same split. Its plugin uses the key `netlify` (its CLAUDE.md, Decisions, 2026-10-19), and its agents use `multi-account-netlify`.
- Plugin `multi-account-supabase` in `plugins/multi-account-supabase/`. The launcher runs the installed command when it is on PATH, otherwise the same version through npx. It accepts plain words only and writes only to stderr.
- MY CALL (defect T3): no user text goes into a plugin command's `!` line. `accounts` and `doctor` run with no argument. The commands that take an account name print the terminal command for the owner to run, instead of passing the name through the shell. `remove-account` asks before it removes, in the terminal.
- One skill, `supabase-accounts`, copied to each agent's skill folder. It covers what a tool description cannot: confirm the account and the effect before a change, treat raw SQL results as data, confirm destructive SQL with the owner, and send a token to a terminal.

### 6.9 Release and distribution

- Repository `FiredMosquito831/multi-account-supabase-mcp`. Created private, only on a go-ahead that names it. Made public only on a separate go-ahead, after the secret and personal-data check.
- npm package `multi-account-supabase-mcp`, with the same command name. Published from a GitHub workflow with trusted publishing. The owner creates the trusted publisher on npmjs.com and makes the first publish from a terminal (ASSUMED from the Netlify notes).
- Release triggers as in the Netlify project: a published GitHub release whose tag equals the version, or a push to `main` that changes the package and carries a new version. Version fields bumped in four places. The bump commit carries `[skip ci]`.
- MY CALL: the publish workflow runs the same test matrix as CI, Windows and Ubuntu. The Netlify publish gate runs Windows only (`npm.yml` line 47). A release is never less tested than a push.
- MY CALL: the npm version that publishes is pinned to a version that supports trusted publishing (npm 11.5.1 or newer). The Netlify workflow installs `npm@latest`, which is not pinned. The exact version is chosen in phase B.
- License Apache-2.0, as the Netlify project (D35), with a NOTICE that says Supabase's names and marks belong to Supabase. The owner confirms the licence before the first publish (MY CALL to follow the template; the owner approved the same for Netlify).
- Actions pinned to commit SHAs with the tag in a comment, as the Netlify project (D46). The SHAs are checked against the tags with `gh api` in phase B.
- MY CALL: project and local installs pin the marketplace to a release, if Claude Code accepts a ref. The Netlify project takes it from the GitHub default branch (defect T7). OPEN, phase B.

### 6.10 Documentation

- The same set as the Netlify project: `README.md` (npm page, absolute links), `docs/` (eleven files, adapted), `CHANGELOG.md` with an Unreleased section, `CONTRIBUTING.md`, `SECURITY.md`. `CLAUDE.md` stays local and git-ignored.
- Each behaviour change updates the code, its tests, the page of `docs/` that owns the topic, the README where the npm page shows it, and the CHANGELOG, in the same change.
- MY CALL: the docs state the tested platforms exactly as the CI matrix runs them (Windows and Ubuntu, Node 22). The Netlify docs say Linux is untested while CI runs it (its contradiction D1).
- MY CALL: the link check (relative links and heading anchors) becomes a test in the suite, not a loose script. This closes an open item of the Netlify project.

### 6.11 Tests and checks

- `npm test` is offline. Node's built-in runner. Fakes for the official child (a fake runner), temporary folders, and one data folder per test. A saved fixture of the live tool list (created in phase B) drives the coverage test.
- The integration test starts the real official package over stdio with a placeholder value and without the `docs` group, so it needs no network.
- The `docs` group needs the content API. It is checked in a separate live step, not in `npm test`.
- The new read-only tool has tests for routing (read-only children only, `locate`) and for the refusal of a change through it. Its live check (F17) runs in a throwaway project and is recorded.
- Live checks run only in throwaway folders. The owner types any token. Every command and its output are recorded in `docs/TESTING.md`.
- Before any push: `npm test`, `npm run typecheck`, `npm pack --dry-run`, the link check, and the secret and personal-data check.

### 6.12 Template defects not copied

The Netlify source has defects, listed in findings section 11 (T1 to T7). The Supabase copy does not repeat them. Each rule has a test.

- Policy lookups use a `Map` or a null-prototype table. The test sends `constructor`, `toString` and `__proto__`, and expects an unknown operation, which is refused for a change (T1).
- The "not found" test reads the structured result and the error flag, not free text alone. A short successful answer that contains those words is kept (T2).
- No user text reaches a `!` line of a plugin command (T3, section 6.8).
- The child environment is an allowlist: `SUPABASE_ACCESS_TOKEN` and the minimum system variables the process needs (T4).
- A failed removal of a credential is an error that is reported. Nothing is swallowed (T5).
- Uninstall removes only what the ownership record lists, by the recorded key, never by name alone (T6).
- The marketplace source is pinned to a release, if Claude Code accepts a ref (T7, OPEN, phase B).

## 7. Risks

- Destructive SQL and `apply_migration` run without a wrapper gate (F18, the owner's decision S7). The skill and the descriptions ask the agent to confirm first. The risk is accepted in writing, and the docs state it.
- Raw SQL results can contain text written by other people (F21). The official server wraps them as untrusted data. The wrapper adds no wrapping of its own and passes the official result on unchanged (G3). The skill says so too.
- The new read-only tool is only as strong as the API's enforcement of `read_only` (F17, OPEN). It does not ship until the live check passes. The policy layer does not depend on it.
- A classic token carries all privileges of its user. The wrapper cannot tell the two token types apart. Mitigation: the docs recommend scoped tokens, one per account.
- `tools/list` depends on the content API for `search_docs`. A failed schema load may fail the list (ASSUMED, not tested). Mitigation: the catalog is read once and cached, and the failure is tested.
- OAuth is not in version 1. Any OAuth route needs research and a separate decision.
- The official package may change. Mitigation: the caret pin (for 0.x, patch releases only, S5) and the coverage test.
- A bad `--features` value may print an error and exit with code 0 (ASSUMED from reading). Mitigation: a child that exits before its first answer is an error, tested with a fake.

## 8. Left to the builder

- The code layout and names, following the reproduction map.
- The name of the read-only query tool (MY CALL: `execute_sql_readonly`). The owner may rename it before the tool ships.
- The fixture of the live tool list, made by a throwaway child in phase B. We do not type a token to make it.
- The exact wording of each message, taken from the code and the tests, not from the Netlify playbook.
- The exact CI steps and action pins, checked against the Netlify files and `gh api` in phase B.
- The skill text and the generated descriptions, from the policy table.

## 9. Decisions (answered by the owner, 2026-10-20)

- S1 DECIDED: the token goes in `SUPABASE_ACCESS_TOKEN`, set only in the child's environment.
- S2 DECIDED: two child processes per account, read-only for reads, writable for a single-account change.
- S3 DECIDED: `execute_sql` runs on one writable account. The owner also chose a read-only query tool now, as an exception to the rule that only the `account` argument is added (section 6.2). Its name is ours to propose (MY CALL), and it ships after the F17 live check.
- S4 DECIDED: the catalog child uses a placeholder value that is never a real token, tested first. The fallback reads the list from one account.
- S5 DECIDED: the official package is pinned with `^0.14.0`. For a 0.x package npm takes patch releases only.
- S6 DECIDED: `search_docs` runs on the placeholder child.
- S7 DECIDED: pass through, as the official server does. The wrapper adds no gate. The owner accepted the risk against the recommended gate.
- S8 DECIDED: `confirm_cost` and `get_cost` are both `one`.
- S9 DECIDED: in the chat, a slash command starts a guided add. The token is typed in a terminal. A key is handled like a token. OAuth is researched later, not in version 1.
- S10 DECIDED: a read without an account uses the default account. A change without an account name is refused.
- G1 DECIDED: copy the core now. A shared package comes later.
- G2 DECIDED: the names as proposed. Repository, npm package and command `multi-account-supabase-mcp`; server key `supabase`; plugin `multi-account-supabase`; marketplace `multi-account-supabase-mcp`.
- G3 DECIDED: the playbook stays outside the repository. `CLAUDE.md` summarises what the project needs.

## 10. Stop points

1. The owner's approval of this version of the design. Then the plan (writing-plans) is written, and the plan is shown before any build.
2. Phase B, step 1: `git init` in this folder, locally, with no remote and the no-reply author set. A local commit needs no go-ahead.
3. Creating the GitHub repository, private. Needs a go-ahead that names the repository.
4. Any live check with a real token. The owner types the command, in a throwaway folder. This includes the F17 check that the read-only tool needs, and the live check on the placeholder (S4).
5. Making the repository public. A separate go-ahead.
6. Push. A separate go-ahead that names the push.
7. Each release, npm publish, or deprecation. A separate go-ahead for each step, named.
