# Supabase multi-account MCP: Plan 1 of 4 (core, accounts, CLI) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The owner's rule for this project is that subagents do read-only work only, so the implementer works in the session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local stdio MCP server that starts one official child per account, routes each call by the policy table, fans reads out, refuses changes on lists and on calls with no account name, keeps accounts in a metadata file with their tokens in the credential store, and has the CLI to add, list, set the default and remove accounts.

**Architecture:** Small TypeScript modules with one job each: a policy table (a `Map`), name and path rules, an accounts registry (metadata only, atomic save), a token store (credential store, injectable for tests), an identity check against `GET /v1/profile`, an add flow with rollback, routing and fan-out, a child pool that starts the official server with the account's token in an allowlisted environment, the MCP server that composes them, and a CLI that wires them to the terminal. Every test uses fakes or temporary folders.

**Tech Stack:** TypeScript 5.9 (strict, ESM, NodeNext, ES2022), Node.js 22 or newer, `@modelcontextprotocol/server` and `@modelcontextprotocol/client` `^2.3.1`, `@supabase/mcp-server-supabase` `^0.14.0` (the official server, run as child processes), `@napi-rs/keyring` `^2.1.2`, `node:test`.

**Spec:** `docs/superpowers/specs/2026-10-20-supabase-mcp-design.md` (approved by the owner on 2026-10-20). Facts and line references: `docs/research/findings-note.md`.

**Plan series.** Plan 1 (this file) covers design sections 6.1 to 6.4, 6.6, 6.7 and the template defects T1, T2, T4 and T5 of section 6.12. Plan 2 covers the four agent installers and the skill (6.8, the installer part). Plan 3 covers the Claude Code plugin, the launcher, the slash commands and the marketplace (6.8, the plugin part, and T3, T7). Plan 4 covers documentation, CI, the release workflow and the live checks (6.9, 6.10, 6.11). Each plan is written and reviewed before it runs.

## Global Constraints

- Node.js 22 or newer (`engines.node >= 22`).
- TypeScript 5.9; `module` and `moduleResolution` NodeNext; target ES2022; strict; `rootDir` `src`; `outDir` `dist`.
- Official package `@supabase/mcp-server-supabase` `^0.14.0` (decision S5).
- MCP SDK `@modelcontextprotocol/server` and `@modelcontextprotocol/client` `^2.3.1` (the same pin as the Netlify template).
- Credential store `@napi-rs/keyring` `^2.1.2`. Service name `multi-account-supabase-mcp`, one entry per account name.
- A token never goes into a file, a log, command output, a test fixture or a chat message. A token reaches a child only in the child's environment as `SUPABASE_ACCESS_TOKEN`, and reaches the credential store and nothing else.
- A change never goes to several accounts. A list or `all` for a change is refused before any child is contacted. A change that names no account is refused (decision S10). An operation the policy does not classify is `one`.
- Official tool names and parameters are unchanged. The only addition is the optional `account` argument, plus one read-only query tool (`execute_sql_readonly`, decision S3) that is not listed until its F17 check passes (`READONLY_QUERY_EXPOSED = false` in this plan).
- In serve mode stdout carries the MCP protocol only. Logs go to stderr.
- Account names: 1 to 32 lowercase letters, digits or hyphens, starting with a letter or digit. `all` is reserved.
- Identity: `GET https://api.supabase.com/v1/profile` with `Authorization: Bearer <token>`. A profile without a string `gotrue_id` is refused (fail closed).
- Fan-out at most 4 accounts at a time. Each tool call has a 15-minute timeout (`TOOL_TIMEOUT_MS = 15 * 60_000`).
- Child environment allowlist: `PATH`, `Path`, `PATHEXT`, `SYSTEMROOT`, `SystemRoot`, `TEMP`, `TMP`, plus `SUPABASE_ACCESS_TOKEN` when a token is given. Nothing else from the parent environment is copied.
- Data folder: `MULTI_ACCOUNT_SUPABASE_HOME` if set. On Windows `%LOCALAPPDATA%\multi-account-supabase-mcp`. Elsewhere `$XDG_DATA_HOME/multi-account-supabase-mcp` if set, else `<home>/.local/share/multi-account-supabase-mcp`.
- Tests use `node:test`. `npm test` never reaches the network, the owner's data folder, the owner's agent configurations or the credential store.
- Commits: author `79049343+FiredMosquito831@users.noreply.github.com`, set before the first commit. Each message ends with the line `by FiredMosquito831`. Messages are written to a file and committed with `git commit -F`.

## Review Focus

Five inputs the spec implies but no tests yet exercise. Each one has a test in the task that owns the code.

1. Names that look like object properties (`constructor`, `toString`, `__proto__`) reach the policy lookup. They must be treated as unknown, so as `one`. Test: Task 3 (policy) and Task 12, case l.
2. An `accounts.json` that cannot be parsed. It must be refused and left unchanged, never overwritten. Test: Task 5, case h.
3. Account name edge cases: `all`, uppercase letters, spaces, a 33-character name, a leading hyphen, an underscore. Test: Task 4, names test.
4. A profile without `gotrue_id`, and a 401 from `/v1/profile`. Nothing is stored, and no record is written. Test: Task 7 (cases d and e) and Task 8 (case b).
5. A child that exits during a call, or never answers. The next call starts a new child, and a call that never answers fails after the timeout instead of hanging. Test: Task 10, cases d and e.

## File Structure (Plan 1)

- `package.json`, `tsconfig.json`, `.gitignore`, `.gitattributes`, `LICENSE` (copied from the Netlify template, byte for byte), `NOTICE`.
- `src/version.ts`: reads the package version.
- `src/paths.ts`: the data folder rule.
- `src/accounts/names.ts`: name rules.
- `src/accounts/registry.ts`: `accounts.json`, metadata only, atomic save.
- `src/accounts/add-account.ts`: the add flow with rollback.
- `src/secrets/token-store.ts`: the token store interface, the credential store binding and the memory fake.
- `src/supabase/api.ts`: `GET /v1/profile`.
- `src/mux/policy.ts`: the mode of each tool.
- `src/mux/routing.ts`: `account` argument to targets.
- `src/mux/fanout.ts`: the concurrency limit.
- `src/mux/children.ts`: the child pool, the allowlist, the timeout.
- `src/mux/official-child.ts`: the real stdio child.
- `src/mux/catalog.ts`: the `account` argument and the notes in each description.
- `src/mux/account-tools.ts`: the `account_list` text.
- `src/mux/server.ts`: `handleCall`, `listTools`, `createServer`.
- `src/serve.ts`: serve over stdio.
- `src/run.ts`: the CLI commands (testable, no side effects at import).
- `src/cli.ts`: the bin. Wires the real dependencies to `runCli`. Not tested.
- `src/usage.ts`: the help text.
- `scripts/capture-official-tools.mjs`: a throwaway capture of the official tool list (Task 2).
- `test/fixtures/official-tools.json`: the captured list (Task 2).
- `src/test/*.test.ts`: one test file per module above.

---

### Task 1: Repository skeleton and dependencies (local only)

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `.gitattributes`, `LICENSE`, `NOTICE`, `src/version.ts`, `src/test/version.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `readPackageVersion(packageJsonPath: string): string` in `src/version.ts`.

- [ ] **Step 1: Check the package versions and peer dependencies**

Run: `npm view @modelcontextprotocol/server@^2.3.1 version` and `npm view @supabase/mcp-server-supabase@0.14.0 peerDependencies` and `npm view @napi-rs/keyring@^2.1.2 version`.
Expected: each prints versions that satisfy the range. The peer list of the official package names `@modelcontextprotocol/server` and `zod`. If `zod` is a peer, add `zod` to `dependencies` with the same range, and record the reason in the commit message: "peer dependency of @supabase/mcp-server-supabase".

- [ ] **Step 2: Initialise git locally, with no remote**

Run in `D:\Projects2\SupabaseMcp`: `git init`, then `git config user.name "FiredMosquito831"`, then `git config user.email "79049343+FiredMosquito831@users.noreply.github.com"`.
Expected: `git remote -v` prints nothing.

- [ ] **Step 3: Write `package.json`**

Name `multi-account-supabase-mcp`, version `0.1.0`, `"type": "module"`, `"license": "Apache-2.0"`, `"engines": { "node": ">=22" }`, `"bin": { "multi-account-supabase-mcp": "dist/cli.js" }`, `"files": ["dist/", "!dist/test/", ".claude-plugin/", "plugins/", "README.md", "LICENSE", "NOTICE"]`. Scripts: `build` = `tsc -p tsconfig.json`; `typecheck` = `tsc -p tsconfig.json --noEmit`; `test` = `npm run build && node --test "dist/test/*.test.js"`; `prepack` = `npm run build`. Dependencies: `@modelcontextprotocol/client` `^2.3.1`, `@modelcontextprotocol/server` `^2.3.1`, `@napi-rs/keyring` `^2.1.2`, `@supabase/mcp-server-supabase` `^0.14.0`. Dev dependencies: `@types/node` `^22.20.5`, `typescript` `^5.9.3`. No lifecycle scripts other than `prepack`.

- [ ] **Step 4: Write `tsconfig.json`**

Copy the Netlify template's settings exactly: `compilerOptions`: `target` ES2022, `module` NodeNext, `moduleResolution` NodeNext, `lib` `["ES2022"]`, `types` `["node"]`, `strict` true, `esModuleInterop` true, `skipLibCheck` true, `outDir` `dist`, `rootDir` `src`, `declaration` false, `sourceMap` false. `include`: `["src/**/*.ts"]`.

- [ ] **Step 5: Write `.gitignore`, `.gitattributes`, `LICENSE`, `NOTICE`**

`.gitignore` lines: `node_modules/`, `dist/`, a blank line, `# Local only, never committed`, `CLAUDE.md`, `.remember/`, `.claude/`, `*.tgz`. `.gitattributes`: `* text=auto eol=lf`. `LICENSE`: a byte copy of `D:\Projects2\NetlifyMcp\LICENSE`. `NOTICE`: the project name, `Copyright 2026 FiredMosquito831`, `Licensed under the Apache License, Version 2.0`, the attribution "This project depends on @supabase/mcp-server-supabase (Apache-2.0), maintained by Supabase.", and the line "Supabase is a trademark of its owner. This project is not affiliated with or endorsed by Supabase."

- [ ] **Step 6: Install dependencies and verify the paths**

Run: `npm install`. Expected: exit 0.
Run: `node -e "console.log(require.resolve('@supabase/mcp-server-supabase'))"`. Expected: a path inside `node_modules/@supabase/mcp-server-supabase/dist/`. Then `node -e "console.log(require('fs').existsSync(require('path').join(require('path').dirname(require.resolve('@supabase/mcp-server-supabase')), 'cli.js')))"`. Expected: `true`. The official CLI is `dist/cli.js`, beside the resolved entry.

- [ ] **Step 7: Check the SDK names this plan relies on**

Run: `node -e "import('@modelcontextprotocol/server').then(m=>console.log(Object.keys(m).sort().join(' ')))"` and `node -e "import('@modelcontextprotocol/server/stdio').then(m=>console.log(Object.keys(m).join(' ')))"` and `node -e "import('@modelcontextprotocol/client/stdio').then(m=>console.log(Object.keys(m).join(' ')))"`.
Expected: the server export list includes `Server`, `InMemoryTransport` (or its equivalent) and the types for `CallToolResult`; the `/stdio` subpaths include `serveStdio` and `StdioClientTransport`. Write the exact names used into the notes of this task. Check the `callTool` signature in the client's type declarations and use its per-call timeout option in Task 10.

- [ ] **Step 8: Write the failing test for `readPackageVersion`**

`src/test/version.test.ts`: write a temporary `package.json` with `{"version":"9.9.9"}` in `os.tmpdir()` subfolder created by the test; assert `readPackageVersion(file) === "9.9.9"`.

- [ ] **Step 9: Run the test to verify it fails**

Run: `npm test`. Expected: FAIL, the module `version.js` is missing.

- [ ] **Step 10: Implement**

`src/version.ts`: `import { readFileSync } from "node:fs"; export const readPackageVersion = (packageJsonPath: string): string => JSON.parse(readFileSync(packageJsonPath, "utf8")).version as string;`

- [ ] **Step 11: Run the tests to verify they pass**

Run: `npm test`. Expected: 1 test passes, 0 fail. Run `npm run typecheck`. Expected: exit 0.

- [ ] **Step 12: Commit**

Write `scratchpad/msgs/task-01.txt`:
```
chore: add the repository skeleton

Package metadata, TypeScript settings, ignore rules and the Apache-2.0 licence,
with the MCP SDK pins of the Netlify template and the official server at ^0.14.0.
Verified: npm install exit 0; npm test passes (1 test); typecheck exit 0.
Not done: no remote, no push.

by FiredMosquito831
```
Run: `git add -A` then `git commit -F <that file>`.

---

### Task 2: Capture the official tool list (throwaway process, placeholder token)

**Files:**
- Create: `scripts/capture-official-tools.mjs`, `test/fixtures/official-tools.json`

**Interfaces:**
- Consumes: the official CLI from Task 1, Step 6, and the MCP client from Task 1, Step 7.
- Produces: `test/fixtures/official-tools.json`, a JSON array sorted by `name`, each entry `{ name, description, annotations, inputSchema }`.

- [ ] **Step 1: Write the capture script**

`scripts/capture-official-tools.mjs`: resolve the official CLI as in Task 1, Step 6. Spawn `process.execPath` with the CLI and `--features docs,account,database,debugging,development,functions,branching,storage,notebooks`. Set the environment to `{ SUPABASE_ACCESS_TOKEN: "placeholder-not-a-real-token" }` only, plus the allowlist of Global Constraints. Connect the MCP client, call `listTools()`, sort by name, write the JSON array to stdout. Write `tools: <count>` to stderr. The script contains the placeholder string and nothing else secret.

- [ ] **Step 2: Run it**

Run: `node scripts/capture-official-tools.mjs > test/fixtures/official-tools.json`.
Expected: exit 0. Stderr prints `tools: 34` (ruling R9: the stdio server lists 34 tools; `get_logs` is hidden in favour of `query_logs`, and `create_edge_function_secret` is HTTP-only). The fixture contains `search_docs` and `create_project`, and `create_project` has `annotations.readOnlyHint` equal to `false`. The docs tool's description calls the public content API; no Management API call is made.

- [ ] **Step 3: Check that the placeholder is not in the fixture**

Run: `grep -c "placeholder-not-a-real-token" test/fixtures/official-tools.json`.
Expected: `0`.

- [ ] **Step 4: Commit**

Message: `test: capture the official Supabase tool list as a fixture` with a body that lists the count (34, ruling R9), the command used, the placeholder check result (0), and the line `by FiredMosquito831`.

---

### Task 3: Policy table (a Map; unknown means one) and the coverage test

**Files:**
- Create: `src/mux/policy.ts`, `src/test/policy.test.ts`, `src/test/coverage.test.ts`

**Interfaces:**
- Consumes: `test/fixtures/official-tools.json` (Task 2).
- Produces: `type Mode = "none" | "all" | "locate" | "one"`; `OPERATION_MODES: ReadonlyMap<string, Mode>`; `modeOf(tool: string): Mode`; `READONLY_QUERY_TOOL = "execute_sql_readonly"`; `READONLY_QUERY_EXPOSED = false`.

- [ ] **Step 1: Write the failing policy test**

`src/test/policy.test.ts` asserts, with `node:test` and `strict` assertions:
- `modeOf` for each name in the table below equals the listed mode (34 names in total, ruling R9):
  - `none`: `search_docs`.
  - `all`: `list_organizations`, `list_projects`.
  - `one` (14): `create_project`, `pause_project`, `restore_project`, `create_branch`, `delete_branch`, `merge_branch`, `reset_branch`, `rebase_branch`, `apply_migration`, `deploy_edge_function`, `update_storage_config`, `confirm_cost`, `get_cost`, `execute_sql`.
  - `locate` (17): `get_organization`, `get_project`, `list_branches`, `list_tables`, `list_extensions`, `list_migrations`, `query_logs`, `get_advisors`, `get_project_url`, `get_publishable_keys`, `generate_typescript_types`, `list_edge_functions`, `get_edge_function`, `list_notebooks`, `get_notebook`, `list_storage_buckets`, `get_storage_config`.
- Review focus 1: `modeOf("constructor") === "one"`, `modeOf("__proto__") === "one"`, `modeOf("toString") === "one"`, `modeOf("hasOwnProperty") === "one"`.
- `READONLY_QUERY_EXPOSED === false`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`. Expected: FAIL, the module `policy.js` is missing.

- [ ] **Step 3: Implement the table**

`src/mux/policy.ts`: `export type Mode = "none" | "all" | "locate" | "one";` `export const OPERATION_MODES: ReadonlyMap<string, Mode> = new Map<string, Mode>([ ... ])` with the 34 entries above (ruling R9). `export const modeOf = (tool: string): Mode => OPERATION_MODES.get(tool) ?? "one";` A `Map` is used so that inherited names do not resolve (defect T1 of the Netlify template). `export const READONLY_QUERY_TOOL = "execute_sql_readonly";` `export const READONLY_QUERY_EXPOSED = false;`

- [ ] **Step 4: Write the coverage test**

`src/test/coverage.test.ts` reads `test/fixtures/official-tools.json` through `new URL("../../test/fixtures/official-tools.json", import.meta.url)`. Assertions: (a) the set of fixture names equals the set of `OPERATION_MODES` keys; (b) every fixture tool with `annotations.readOnlyHint === false` has mode `one`; (c) the only fixture tools with `readOnlyHint === true` and mode `one` are `confirm_cost` and `get_cost` (decision S8).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test`. Expected: all policy and coverage tests pass.

- [ ] **Step 6: Commit**

Message: `feat: add the policy table as a Map, unknown means one` with the body: the 34 modes (R9), the Map reason (defect T1), the coverage rule, and `by FiredMosquito831`.

---

### Task 4: Account names and the data folder

**Files:**
- Create: `src/accounts/names.ts`, `src/paths.ts`, `src/test/names.test.ts`, `src/test/paths.test.ts`

**Interfaces:**
- Produces: `NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/`; `assertValidName(name: string): string` (returns the name, throws otherwise); `dataFolder(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, homeDir: string): string`.

- [ ] **Step 1: Write the failing tests**

`names.test.ts`: accepts `work`, `a`, `0-day` and a 32-character name. Refuses `""`, `All`, `all`, `has space`, a 33-character name, `-leading`, `under_score` and `ünï`. The message for an invalid name is exactly `Invalid account name "<name>". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.`. The message for `all` is exactly `"all" is reserved. Pick another account name.`. Review focus 3.
`paths.test.ts`: `MULTI_ACCOUNT_SUPABASE_HOME` wins on every platform. On `win32` with `LOCALAPPDATA` set, the result is `<LOCALAPPDATA>\multi-account-supabase-mcp`. On Linux with `XDG_DATA_HOME` set, the result is `<XDG>/multi-account-supabase-mcp`. On Linux without it, the result is `<home>/.local/share/multi-account-supabase-mcp`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL, modules missing.

- [ ] **Step 3: Implement**

`names.ts` and `paths.ts` with exactly the signatures above. Use `path.join` for the paths and `path.win32.join` when `platform === "win32"`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

Message: `feat: add account name rules and the data folder` with the name rules and the path rules listed, and `by FiredMosquito831`.

---

### Task 5: The registry (`accounts.json`, metadata only, atomic save)

**Files:**
- Create: `src/accounts/registry.ts`, `src/test/registry.test.ts`

**Interfaces:**
- Consumes: `assertValidName` (Task 4).
- Produces:
  - `type AccountRecord = { name: string; email: string; gotrueId: string; added: "pat"; addedAt: string }`
  - `class Registry` with `static load(file: string): Promise<Registry>`, `list(): AccountRecord[]`, `names(): string[]`, `defaultName(): string | null`, `get(name: string): AccountRecord | undefined`, `findByGotrueId(id: string): AccountRecord | undefined`, `add(record: AccountRecord): void`, `remove(name: string): AccountRecord | undefined`, `setDefault(name: string): void`, `save(): Promise<void>`.
- File format: `{"default": "<name>" | null, "accounts": [<AccountRecord>, ...]}`.

- [ ] **Step 1: Write the failing tests**

Using a temporary folder per test:
(a) the first `add` makes that account the default; a second `add` keeps the default.
(b) `remove` of the default sets `defaultName()` to `null`.
(c) `add` of a taken name throws `An account named "<name>" already exists. Remove it first to replace it.`.
(d) `add` of a taken `gotrueId` throws `This Supabase user is already added as "<name>".`.
(e) `setDefault("nobody")` throws `No account named "nobody".`.
(f) `save` then `load` gives the same records and default.
(g) `save` leaves no `<file>.tmp` behind.
(h) Review focus 2: a file containing `{ not json` makes `load` throw `accounts.json cannot be read, so it was not changed: <file>`, and the file bytes are unchanged afterwards. A file that is valid JSON but has no `accounts` array makes `load` throw the same message.
(i) `load` of a missing file returns an empty registry.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement**

Keep the records in memory; `load` parses and validates the shape (every record has a non-empty `name`, `email`, `gotrueId`, `added` `"pat"`, `addedAt`); `save` writes `${file}.tmp` and renames it over `file`. Validate names with `assertValidName` in `add`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

Message: `feat: add the accounts registry with an atomic save` with the rules (cases a to i, review focus 2), and `by FiredMosquito831`.

---

### Task 6: The token store (interface, credential store binding, memory fake)

**Files:**
- Create: `src/secrets/token-store.ts`, `src/test/token-store.test.ts`

**Interfaces:**
- Produces: `SERVICE = "multi-account-supabase-mcp"`; `interface TokenStore { get(account: string): Promise<string | undefined>; set(account: string, token: string): Promise<void>; delete(account: string): Promise<void>; }`; `class MemoryTokenStore implements TokenStore`; `interface KeyringEntryLike { getPassword(): string | null; setPassword(password: string): void; deletePassword(): boolean; }`; `class KeyringTokenStore implements TokenStore` with `constructor(makeEntry?: (service: string, account: string) => KeyringEntryLike)`. The default factory is `new Entry(service, account)` from `@napi-rs/keyring`.

- [ ] **Step 1: Write the failing tests**

(a) Memory store: `set` then `get` returns the token; `get` of an unknown name is `undefined`; `delete` then `get` is `undefined`.
(b) Keyring adapter with a fake factory that records `(service, account)`: `set("work", "tok")` calls `setPassword("tok")` on an entry created with `(SERVICE, "work")`; `get` returns `undefined` when `getPassword()` returns `null`; `delete` calls `deletePassword()`.
The tests never call the default factory, so they never touch the real credential store.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement**

The `KeyringTokenStore` default factory is written as a function that imports `Entry` from `@napi-rs/keyring` and is not called by any test.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

Message: `feat: add the token store interface, the credential store binding and a memory fake` with the note that no test touches the credential store, and `by FiredMosquito831`.

---

### Task 7: The identity check (`GET /v1/profile`, fail closed)

**Files:**
- Create: `src/supabase/api.ts`, `src/test/api.test.ts`

**Interfaces:**
- Produces: `type Profile = { gotrueId: string; email: string; username: string }`; `type FetchLike = (url: string, init: { method: "GET"; headers: Record<string, string> }) => Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>`; `fetchProfile(token: string, fetchFn?: FetchLike, apiUrl?: string): Promise<Profile>`. Defaults: `fetchFn` wraps the global `fetch`; `apiUrl` is `https://api.supabase.com`.

- [ ] **Step 1: Write the failing tests**

(a) A 200 response with `{"gotrue_id":"u1","primary_email":"a@example.com","username":"x"}` gives `{ gotrueId: "u1", email: "a@example.com", username: "x" }`.
(b) The request URL is `https://api.supabase.com/v1/profile`, the method is `GET`, and the header `Authorization` is `Bearer tok-1`.
(c) A 401 throws `Supabase rejected this token (HTTP 401).`; a 503 throws `Supabase API returned HTTP 503 while checking the token.`.
(d) Review focus 4: a 200 response without `gotrue_id` throws `Unexpected response from Supabase /v1/profile.`.
(e) Review focus 4: a 200 response with `gotrue_id` but no string `primary_email` throws the same message.
(f) No thrown message contains `tok-1`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement**

Validate the body shape before returning. The check is fail closed: any missing field throws.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

Message: `feat: check a token with GET /v1/profile, fail closed` with the cases, and `by FiredMosquito831`.

---

### Task 8: The add flow (check, store, save, roll back)

**Files:**
- Create: `src/accounts/add-account.ts`, `src/test/add-account.test.ts`

**Interfaces:**
- Consumes: `Registry`, `AccountRecord` (Task 5); `TokenStore` (Task 6); `Profile` (Task 7); `assertValidName` (Task 4).
- Produces: `addAccount(deps: { registry: Registry; tokens: TokenStore; fetchProfile: (token: string) => Promise<Profile>; addedAt: () => string; warn?: (message: string) => void }, name: string, token: string): Promise<AccountRecord>` (`warn` is optional, ruling R23; its default writes to stderr).

Order of work, exactly: (1) `assertValidName(name)`; (2) if `token` is empty, throw `No token was given.`; (3) if `registry.get(name)` exists, throw the existing-name message from Task 5; (4) `profile = await fetchProfile(token)`; (5) if `registry.findByGotrueId(profile.gotrueId)` exists, throw the duplicate message from Task 5; (6) `await tokens.set(name, token)`; (7) `registry.add({ name, email: profile.email, gotrueId: profile.gotrueId, added: "pat", addedAt: deps.addedAt() })`; (8) `try { await registry.save() } catch (error) { registry.remove(name); await tokens.delete(name); throw error; }`; return the record.

- [ ] **Step 1: Write the failing tests**

(a) Success: the token is in the store, the saved `accounts.json` has the name and the email, and the file text does not contain the token.
(b) Review focus 4: a `fetchProfile` that throws `Unexpected response from Supabase /v1/profile.` stores nothing and leaves the registry unchanged.
(c) A duplicate name is refused, and `fetchProfile` is not called.
(d) A duplicate `gotrueId` under a new name is refused, and the token is not stored.
(e) Save failure: a registry whose `save` throws removes the record and the token, and rethrows.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement** the order of work above.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

Message: `feat: add the account add flow with rollback` with the order of work and the cases, and `by FiredMosquito831`.

---

### Task 9: Routing and fan-out

**Files:**
- Create: `src/mux/routing.ts`, `src/mux/fanout.ts`, `src/test/routing.test.ts`, `src/test/fanout.test.ts`

**Interfaces:**
- Consumes: `Registry` (Task 5).
- Produces: `type Targets = { accounts: string[]; multi: boolean }`; `resolveTargets(argument: unknown, registry: Registry): Targets`; `FANOUT_LIMIT = 4`; `mapWithLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>`.

`resolveTargets` rules, exact messages:
- An argument that is neither `undefined` nor a string: throw `account must be a string: one name, comma-separated names, or "all".`
- No accounts at all: throw `No Supabase accounts are set up yet. Run: multi-account-supabase-mcp add <name>`
- `undefined`, or an empty string after trimming: if a default exists, `{ accounts: [default], multi: false }`; otherwise throw `No default account is set. Pass account as one of: <names>, or "all".`
- `all`: every name, `multi: true`.
- Otherwise split on `,` and trim. An empty item throws `account has an empty name in its list.`. Unknown names throw `Unknown account: <name>. Known accounts: <names>.` or `Unknown accounts: <a>, <b>. Known accounts: <names>.`. One name gives `multi: false`; two or more give `multi: true`.

- [ ] **Step 1: Write the failing tests**

Routing: each rule above, one test each. Fan-out: `mapWithLimit` with 10 items and limit 4 never has more than 4 in flight (count with a shared counter) and returns the results in input order.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement** with exactly the rules above.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

Message: `feat: add account routing and the fan-out limit` with the rules, and `by FiredMosquito831`.

---

### Task 10: Child processes (pool, allowlist, restart, timeout)

**Files:**
- Create: `src/mux/children.ts`, `src/mux/official-child.ts`, `src/test/children.test.ts`

**Interfaces:**
- Produces:
  - `TOOL_TIMEOUT_MS = 15 * 60_000`; `PLACEHOLDER_TOKEN = "placeholder-not-a-real-token"`; `ALL_FEATURES = ["docs","account","database","debugging","development","functions","branching","storage","notebooks"]`.
  - `childEnv(token: string | undefined, parent: NodeJS.ProcessEnv): Record<string, string>` (the allowlist).
  - `type OfficialTool = { name: string; description?: string; inputSchema: Record<string, unknown>; annotations?: { readOnlyHint?: boolean } }`.
  - `interface ChildClient { listTools(): Promise<OfficialTool[]>; callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<CallToolResult>; isAlive(): boolean; close(): Promise<void>; }`
  - `type ChildSpec = { account: string | null; readOnly: boolean; token: string | undefined; features?: readonly string[] }`; `type StartChild = (spec: ChildSpec) => Promise<ChildClient>`.
  - `class ChildPool { constructor(start: StartChild, options: { toolTimeoutMs?: number; tokenFor: (account: string) => Promise<string> }); read(account: string): Promise<ChildClient>; write(account: string): Promise<ChildClient>; placeholder(): Promise<ChildClient>; catalog(): Promise<OfficialTool[]>; closeAll(): Promise<void>; }`
  - `startStdioChild(spec: ChildSpec): Promise<ChildClient>` in `official-child.ts`. It runs `process.execPath` with `officialCliPath()` (from Task 1, Step 6), `--read-only` when `spec.readOnly`, and `--features` with `spec.features ?? ALL_FEATURES`, and the environment `childEnv(spec.token, process.env)`. It connects the MCP client over `StdioClientTransport`. Its `callTool` passes the timeout from Task 1, Step 7.

Pool rules:
- `read(a)` and `write(a)` start a child with `{ account: a, readOnly: true|false, token: await options.tokenFor(a) }`. `tokenFor` reads the token store, so the pool itself never holds a token.
- A child is reused while `isAlive()` is true. A dead child is replaced by a new start on the next call.
- `placeholder()` starts (once) a child with `{ account: null, readOnly: false, token: PLACEHOLDER_TOKEN }`.
- `catalog()` starts a child with `{ account: null, readOnly: false, token: PLACEHOLDER_TOKEN }`, calls `listTools()`, closes the child, and returns the tools.
- `callTool` through the pool races the child's `callTool` against a timer of `toolTimeoutMs`. On timeout it throws `Supabase did not answer in time (limit: 15 minutes).`, whatever the configured limit is.
- An account child never receives `PLACEHOLDER_TOKEN`.

- [ ] **Step 1: Write the failing tests** (fake `StartChild` that records each spec and returns a fake child)

(a) `read("work")` gives a child started with `{ account: "work", readOnly: true, token: <work token> }`; a second `read("work")` reuses it (one start).
(b) `write("work")` starts a child with `readOnly: false`.
(c) `catalog()` starts a child with `token: PLACEHOLDER_TOKEN`, calls `listTools`, closes it once, and returns the list.
(d) Review focus 5: after a fake child reports `isAlive() === false`, the next `read("work")` starts a new child (two starts in total).
(e) Review focus 5: with `toolTimeoutMs: 20`, a fake `callTool` that never resolves makes the pool reject with a message matching `/did not answer in time/`, and the rejection comes within one second.
(f) No account child receives `PLACEHOLDER_TOKEN`; `placeholder()` receives it.
(g) `childEnv("tok", { PATH: "p", AWS_SECRET_ACCESS_KEY: "x", GITHUB_TOKEN: "y", HOME: "h" })` returns exactly `PATH` and `SUPABASE_ACCESS_TOKEN`. `childEnv(undefined, same)` has no `SUPABASE_ACCESS_TOKEN` key.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement**

`children.ts` holds the pool and `childEnv`. `official-child.ts` holds `startStdioChild` and `officialCliPath`. The pool keys children by account and kind. Keep the timer cleared on success.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass. `startStdioChild` is exercised in Task 15.

- [ ] **Step 5: Commit**

Message: `feat: add the child pool with the environment allowlist, restart and timeout` with the rules and cases, and `by FiredMosquito831`.

---

### Task 11: The catalog (the `account` argument and the notes)

**Files:**
- Create: `src/mux/catalog.ts`, `src/test/catalog.test.ts`

**Interfaces:**
- Consumes: `OfficialTool` (Task 10), `Mode` (Task 3).
- Produces: `withAccountParam(tool: OfficialTool, mode: Mode, accounts: readonly string[]): OfficialTool`; `noteFor(mode: Mode): string`.

- For `mode === "none"` the tool is returned unchanged.
- Otherwise `inputSchema.properties.account` is `{ type: "string", description: 'The account to use: one name, a comma list of names, or "all". Known accounts: <names joined by ", ", or "none yet">.' }`. `required` is unchanged. `description` is the original text, a blank line, then `noteFor(mode)`.
- `noteFor` texts, exact:
  - `all`: `Accounts: "account" may be one name, a comma list, or "all". Lists and "all" run on every named account and return one entry per account.`
  - `locate`: `Accounts: "account" may be one name, a comma list, or "all". Every named account is asked. Only the account that owns the id answers. Accounts without it are listed under notFoundIn.`
  - `one`: `Accounts: this tool can change data, so it runs on one account only. Name one account in "account". A list or "all" is refused.`

- [ ] **Step 1: Write the failing tests**

The `account` property is added to every tool except `search_docs`. `search_docs` deep-equals its input. Each mode's note is the last paragraph of the description. The original `required` array and other properties are unchanged. With no accounts the text ends `none yet`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement** with exactly the texts above.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

Message: `feat: add the account argument and the per-mode notes to the tool list` with the rule, and `by FiredMosquito831`.

---

### Task 12: The MCP server (routing, results, refusals, the not-found rule)

**Files:**
- Create: `src/mux/account-tools.ts`, `src/mux/server.ts`, `src/test/server.test.ts`

**Interfaces:**
- Consumes: `Registry` (Task 5); `ChildPool`, `ChildClient`, `OfficialTool` (Task 10); `modeOf`, `READONLY_QUERY_TOOL`, `READONLY_QUERY_EXPOSED`, `Mode` (Task 3); `resolveTargets` (Task 9); `mapWithLimit`, `FANOUT_LIMIT` (Task 9); `withAccountParam` (Task 11).
- Produces:
  - `accountListText(registry: Registry): string` (in `account-tools.ts`). Lines are `<*|space><name><TAB><email><TAB>pat`, with `*` on the default. With no accounts: `No accounts yet. Add one with: multi-account-supabase-mcp add <name>`. With no default: `No default account. Calls must name one, or use "all".` as a final line.
  - `type CallDeps = { registry: () => Promise<Registry>; pool: ChildPool; catalog: () => Promise<OfficialTool[]> }`.
  - `listTools(deps: CallDeps): Promise<Tool[]>`: the catalog with `withAccountParam` applied, plus the tool `account_list` (no input). Adds `READONLY_QUERY_TOOL` only when `READONLY_QUERY_EXPOSED` is true.
  - `handleCall(deps: CallDeps, name: string, args: Record<string, unknown>): Promise<CallToolResult>`.
  - `createServer(deps: CallDeps): Server` wires `tools/list` and `tools/call` to `listTools` and `handleCall`.
  - `looksNotFound(text: string): boolean`, with the regex `/\b404\b|not found|does not exist|do not exist/i`.

`handleCall` order, exact:
1. `name === "account_list"`: return the text of `accountListText`.
2. Look up the tool. If `name` is `READONLY_QUERY_TOOL` and `READONLY_QUERY_EXPOSED` is false, or the name is not in the catalog (and is not `READONLY_QUERY_TOOL`), return an error result `Unknown tool "<name>".`.
3. `const { account, ...rest } = args`. The mode is `modeOf(name)`, or `"locate"` for `READONLY_QUERY_TOOL`.
4. Mode `none`: call the placeholder child with the official name and `rest`. Return its result unchanged.
5. Mode `one` and `account === undefined`: return an error result `"<name>" runs on one account only, because it can change data or is not classified yet. Name one account, for example account: "<default, or the first account name>".`
6. `resolveTargets(account, registry)`. A thrown message becomes an error result with that message.
7. Targets `multi` and mode `one`: return the same message as step 5, with the first account named. No child is contacted.
8. Single target: mode `one` uses `pool.write(acc)`, other modes use `pool.read(acc)`. The official name is `execute_sql` for `READONLY_QUERY_TOOL`. Return the child's result unchanged.
9. Several targets: `mapWithLimit(targets, FANOUT_LIMIT, ...)`. Each account's outcome: a thrown error becomes `fail` with the message; a result with `isError === true`, mode `locate`, and `looksNotFound(text)` becomes `miss`; a result with `isError === true` otherwise is `fail` with its text; anything else is `ok` with the result.
10. Response: if every outcome is `miss`, an error result `Not found in any account: <names>.`. If every outcome is `fail`, an error result whose text is the JSON document. Otherwise a non-error result whose text is the JSON document `{ "accounts": { "<name>": { "ok": true, "result": ... } | { "ok": false, "error": "<text>" } }, "notFoundIn": ["<name>", ...] }`. Misses are listed in `notFoundIn` and left out of `accounts`.

- [ ] **Step 1: Write the failing tests** (a test double for the pool: `read`, `write` and `placeholder` return fake children that record each call; `catalog` returns a fixed list of three tools: `list_projects`, `get_project`, `create_project`, plus `search_docs` and `constructor`-free names)

(a) `nope` is not in the catalog: `isError` is true, text `Unknown tool "nope".`.
(b) `account_list` with no accounts starts with `No accounts yet.`.
(c) `list_projects` with no `account` and a default `work`: only `work`'s read child is called, and the result is the child's result object unchanged.
(d) `list_projects` with `account: "all"` and two accounts: both read children are called once; the text parses to `accounts` with both names and `notFoundIn: []`.
(e) `create_project` with `account: "work,personal"`: refused with the step 7 message; `write` is never called.
(f) `create_project` with no `account`, default set: refused with the step 5 message; `write` is never called. This is decision S10.
(g) `create_project` with `account: "work"`: `write("work")` is called once; the result is unchanged.
(h) `get_project` with `all`, two accounts: one child returns `isError: true` with text `Project not found`; the response lists that account under `notFoundIn` and the other under `accounts`; `isError` is false.
(i) Review focus 6, the not-found rule (defect T2): `get_project` with `all`, one child returns a successful result whose text is `{"status": 404}`. That account stays under `accounts` with `ok: true`.
(j) One child throws `boom`: that account is `{ ok: false, error: "boom" }`, the other is `ok`, and the result is not an error.
(k) Every child throws: the result is an error.
(l) Review focus 1 at server level: `constructor` returns `Unknown tool "constructor".`.
(m) `execute_sql_readonly` returns `Unknown tool "execute_sql_readonly".` while `READONLY_QUERY_EXPOSED` is false.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement** the order above in `handleCall`, then `listTools`, then `createServer`. `createServer` uses `Server` from the SDK checked in Task 1, Step 7 and sets the `tools/list` and `tools/call` request handlers.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

Message: `feat: add the MCP server with routing, fan-out and results` with the order of checks and the cases, and `by FiredMosquito831`.

---

### Task 13: The CLI commands (add, list, default, remove, serve, help)

**Files:**
- Create: `src/usage.ts`, `src/run.ts`, `src/cli.ts`, `src/test/cli.test.ts`

**Interfaces:**
- Consumes: `Registry` (Task 5); `addAccount` (Task 8, called with `warn` built on `io.stderr`, ruling R25); `TokenStore` (Task 6); `fetchProfile` (Task 7); `accountListText` (Task 12); `assertValidName` (Task 4); `dataFolder` (Task 4).
- Produces:
  - `type CliIo = { stdout(text: string): void; stderr(text: string): void; stdinIsTerminal: boolean; stdoutIsTerminal: boolean; readSecret(): Promise<string>; registryFile: string; tokens: TokenStore; fetchProfile: (token: string) => Promise<Profile>; addedAt: () => string; serve: () => Promise<void> }`.
  - `runCli(argv: string[], io: CliIo): Promise<number>` in `src/run.ts`. No side effects at import.
  - `src/cli.ts` is the bin. It builds the real `CliIo` (the data folder from `dataFolder`, `KeyringTokenStore`, `fetchProfile` with the global fetch, `serve` from `src/serve.ts`) and calls `runCli`. It is not tested.

Commands, exact behaviour:
- `add <name> --pat`: if `stdinIsTerminal` is false, stderr `The token is typed in a terminal, not piped. Run this command in a terminal window.` and exit 2. Otherwise read the token with `readSecret()` (hidden input), call `addAccount`, and print `Added "<name>" (<email>).`, followed by ` It is the default account.` when it is the default. Errors go to stderr as `Error: <message>` with exit 1. The token is never printed.
- `add <name>` without `--pat`: stderr `Adding an account needs --pat. Run in a terminal: multi-account-supabase-mcp add <name> --pat`, exit 2.
- `list`: stdout is `accountListText`. No token.
- `default <name>`: `setDefault`, then stdout `Default account: <name>`. An unknown name is an error (exit 1).
- `remove <name>`: removes the record and the token. A name with no record but a stored token also has its token removed (ruling R24), so the rollback's remediation text works, then stdout `Removed "<name>".`. An unknown name is an error (exit 1).
- `serve`: calls `io.serve()`, exit 0.
- `help`, `--help`, `-h`: stdout is the usage text.
- No command: if `stdinIsTerminal` is true, stdout is the usage text, exit 0. Otherwise `serve`.
- An unknown command: stderr `Unknown command "<command>".` and the usage text, exit 2.

- [ ] **Step 1: Write the failing tests** (a temporary registry file, a memory token store, a fake `fetchProfile`, and captured stdout and stderr)

(a) `add work --pat` from a pipe is refused with the exact message, exit 2, and the token store is empty.
(b) `add work --pat` in a terminal with `readSecret` returning `tok-SECRET-123` stores the token, prints `Added "work" (a@example.com).` and ` It is the default account.`, and the registry file does not contain `tok-SECRET-123`.
(c) The captured stdout and stderr of every command in (a) to (g) never contain `tok-SECRET-123`.
(d) `list` prints `*<TAB>` before the default's name, and `pat` as the last column.
(e) `default nobody` exits 1 with `No account named "nobody".`.
(f) `remove work` removes the record and the token, and prints `Removed "work".`.
(g) `add work` without `--pat` exits 2 with the exact message.
(h) No command from a pipe calls `serve`. No command in a terminal prints the usage text and does not call `serve`.
(i) `bogus` exits 2 with `Unknown command "bogus".` and the usage text.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement** `usage.ts` (the commands listed above), `run.ts` (the dispatch), and `cli.ts` (the bin wiring).

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass. Run `npm run typecheck`. Expected: exit 0.

- [ ] **Step 5: Commit**

Message: `feat: add the account commands and the bin` with the behaviour list, and `by FiredMosquito831`.

---

### Task 14: Serve over stdio (stdout is the protocol)

**Files:**
- Create: `src/serve.ts`, `src/test/serve.test.ts`

**Interfaces:**
- Consumes: `createServer`, `CallDeps` (Task 12).
- Produces: `serveStdio(deps: CallDeps): Promise<void>`, which connects the server to the SDK's stdio transport (the names checked in Task 1, Step 7).

- [ ] **Step 1: Write the failing tests**

(a) Source guard for the protocol: scan `src/mux/`, `src/accounts/`, `src/secrets/`, `src/supabase/` and `src/serve.ts` (all `.ts` files, excluding `src/test/`) for the text `console.log(`. Assert none is found.
(b) With the SDK's in-memory transport (Task 1, Step 7), connect the server and a client, call `tools/list`, and assert it contains `account_list` and the catalog names, with `account` in each input schema.

- [ ] **Step 2: Run them to verify they fail**

Run: `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement** `serve.ts` with the stdio transport. It writes nothing to stdout itself.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm test`. Expected: all pass.

- [ ] **Step 5: Commit**

Message: `feat: serve the MCP server over stdio, with a guard against stdout output` with the two checks, and `by FiredMosquito831`.

---

### Task 15: The real integration test with the official package (offline)

**Files:**
- Create: `src/test/integration.test.ts`

**Interfaces:**
- Consumes: `startStdioChild`, `PLACEHOLDER_TOKEN`, `ALL_FEATURES` (Task 10).

The test uses the nine groups without `docs`, so it needs no network. The write-capable child and the read-only child are both started with `PLACEHOLDER_TOKEN`.

- [ ] **Step 1: Write the failing test**

(a) `startStdioChild({ account: null, readOnly: false, token: PLACEHOLDER_TOKEN, features: ["account","database","debugging","development","functions","branching","storage","notebooks"] })`: `listTools()` returns 33 names, including `create_project` and `execute_sql`.
(b) The same with `readOnly: true`: `listTools()` returns 22 names, `create_project` is absent, and `execute_sql` is present (the eleven write tools are hidden, so 33 minus 11 is 22; `execute_sql` is not hidden, see R9).
(c) On the read-only child, `callTool("pause_project", { project_id: "abc" }, 60000)` returns `isError: true`, and the text contains `read-only mode`.
(d) Both children are closed at the end of the test.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm test`. Expected: FAIL if any count differs.

- [ ] **Step 3: Adjust the implementation only if a count differs**

If a count differs, check the fixture from Task 2 and the rule in `packages/mcp-server-supabase/src/server.ts` (lines 346 to 352) before changing any code. Record the finding in the commit message.

- [ ] **Step 4: Run it to verify it passes**

Run: `npm test`. Expected: all pass, offline.

- [ ] **Step 5: Commit**

Message: `test: check the official server over stdio, read-only and writable, offline` with the three counts and the refusal, and `by FiredMosquito831`.

---

### Task 16: Checkpoint for Plan 1

- [ ] **Step 1: Run the full checks**

Run: `npm test`. Expected: every test passes and the count is printed. Run: `npm run typecheck`. Expected: exit 0. Run: `git status`. Expected: clean. Run: `git log --oneline`. Expected: 15 commits (Tasks 1 to 15).

- [ ] **Step 2: Record the result**

Write the printed test count, the typecheck result and the commit list into the final report of this plan. No commit. No push, no remote, no release.

---

## Self-review (run by the author, 2026-10-20)

**1. Spec coverage.** Design 6.1: Tasks 10 and 15. 6.2: Tasks 3, 11, 12 (the read-only tool is kept unlisted until its F17 check, as the design requires). 6.3: Tasks 3, 9, 12. 6.4: Tasks 12 and 15. 6.6: Task 12. 6.7: Tasks 4 to 8 and 13. 6.12, T1: Tasks 3 and 12. T2: Task 12, case i. T4: Task 10, case g. T5: Tasks 6 and 8. Plans 2 and 3 cover 6.8 and T3, T6, T7. Plan 4 covers 6.9 to 6.11. Section 6.5 (pass-through) has no code: the skill and the SAFETY page in Plans 3 and 4.

**2. Step scan.** Every step names one action with a checkable result. Behaviour is given as exact messages and orders, not as code. The implementer writes the bodies.

**3. Type consistency.** `Registry`, `AccountRecord`, `TokenStore`, `Profile`, `Mode`, `Targets`, `ChildPool`, `ChildClient`, `ChildSpec`, `StartChild`, `OfficialTool`, `CallDeps`, `CliIo` are each defined once, in the task named as "Produces", and used with the same names later.

**4. Review focus.** Five lines, each with its test in the owning task: 1 (Tasks 3, 12l), 2 (Task 5h), 3 (Task 4), 4 (Tasks 7d, 7e, 8b), 5 (Tasks 10d, 10e).

**5. Proportion.** The plan describes behaviour and checks. The bodies are left to the implementer, except the fixed texts and orders the spec pins.

## Execution

- Recommended: Native (the implementer works in this session, task by task). The owner's rule is that subagents do read-only work, so Subagent-driven would break that rule. The tasks depend on each other's interfaces, and the tests stop a shipped mistake before it reaches a commit.
