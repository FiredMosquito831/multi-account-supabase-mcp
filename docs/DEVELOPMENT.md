# Development

This page shows how the code is laid out, how to run the checks, and how to classify a new official tool. The rules for changes are in [CONTRIBUTING.md](../CONTRIBUTING.md).

## Requirements

- Node 22 or newer (`engines` in `package.json`).
- The local runtime used so far is Node 24.6.0, with npm 11.14.1 (checked on this machine). Not verified: Node 22.

## Commands

Run these in the checkout folder:

```
npm install
npm run build
npm test
npm run typecheck
```

- `npm install` installs the packages in `package-lock.json`.
- `npm run build` deletes `dist/`, then compiles `src/` into `dist/`. The command line program is `dist/cli.js`. `prepack` runs the build as well.
- `npm test` builds, then runs the test files in `dist/test`. The tests use fakes and temporary folders. They do not use the credential store. Not verified: that the tests run with no network. One test starts the official package without the docs feature group (CONTRIBUTING.md).
- `npm run typecheck` checks the types and writes no files. It prints nothing when the check passes.

Which test covers what is in [TESTING.md](TESTING.md).

## Code layout

| Path | What it holds |
| --- | --- |
| `src/cli.ts` | The command line entry point. It builds the real streams and stores, and then runs one command. |
| `src/run.ts` | Command dispatch, and the `add`, `list`, `default`, `remove`, `serve` and `help` commands. |
| `src/usage.ts` | The usage text. Help, usage errors and an unknown command print it. |
| `src/paths.ts` | The rule for the data folder. |
| `src/serve.ts` | Builds what the server needs, and runs it over stdio. |
| `src/secret-input.ts` | Reads a token from a terminal with hidden input. |
| `src/accounts/` | Account names, the accounts file (`registry.ts`), the lock (`lock.ts`) and the add flow (`add-account.ts`). |
| `src/secrets/` | The token store. It uses the operating system's credential store. |
| `src/supabase/api.ts` | The profile check that the add flow makes. |
| `src/mux/` | The server: the tool list and the call routing (`server.ts`), the policy table (`policy.ts`), the account argument (`routing.ts`), the child process pool (`children.ts`), the start of each official child (`official-child.ts`), the fan-out (`fanout.ts`), the catalog notes (`catalog.ts`) and the `account_list` tool (`account-tools.ts`). |
| `src/install/flow.ts` | The install, update, uninstall and doctor commands. |
| `src/agents/` | One adapter for each agent (`claude.ts`, `codex.ts`, `opencode.ts`, `antigravity.ts`). Also the scopes (`scopes.ts`), the record of what was installed (`state.ts`) and the plan runner (`plan.ts`). |
| `src/test/` | The test files. |
| `src/version.ts` | Reads the package version. |
| `plugins/multi-account-supabase/` | The Claude Code plugin: the manifest, the server entry, the launcher, the command files and a copy of the skill. |
| `.claude-plugin/marketplace.json` | The marketplace file for the plugin. |
| `skills/supabase-accounts/SKILL.md` | The skill. The plugin has a byte-for-byte copy, which a test checks. |
| `test/fixtures/official-tools.json` | The saved list of the official tools, used by the coverage test. |
| `scripts/capture-official-tools.mjs` | Writes a new copy of the saved list. It needs network access. |
| `docs/` | These pages. Other folders under `docs/` hold design and research notes. They are not part of the package. |

The package ships the entries of `files` in `package.json` (lines 12 to 21): `dist/` without `dist/test/`, `.claude-plugin/`, `plugins/`, `skills/`, `README.md`, `LICENSE` and `NOTICE`.

## Classifying an official tool

The policy table in `src/mux/policy.ts` has one entry for each official tool name. The mode of each tool decides how the server routes it. See [MCP.md](MCP.md).

A tool that the table does not name is mode `one`. It is treated as a change. That is the safe default.

`src/test/coverage.test.ts` has three tests:

- The names in the table are the names in `test/fixtures/official-tools.json`.
- Every official tool that is not a read (its `readOnlyHint` is false) has mode `one`.
- The only read-only tools in mode `one` are `confirm_cost` and `get_cost`.

To add a tool that the official package has added:

1. Refresh the saved list. Run `node scripts/capture-official-tools.mjs > test/fixtures/official-tools.json`. The script starts the official package, and it needs network access. Not verified in this checkout.
2. Add the name to `OPERATION_MODES` in `src/mux/policy.ts`, with its mode: `none`, `all`, `locate` or `one`. Use `one` for anything that can change data.
3. Run `npm test`. The coverage test fails until the table and the fixture agree.
4. Add the tool to the docs in [MCP.md](MCP.md), and to the changelog.

The package pin is `^0.14.0` in `package.json`. For a 0.x version, npm takes patch releases only. A minor release of the official package needs a manual change to the pin, and a check of its tool list (ASSUMED from the semver rule for 0.x).

## Where a change goes

- A change to the commands goes in `src/run.ts` and `src/usage.ts`. The text in `src/usage.ts` is the text of [USAGE.md](USAGE.md). Keep the two the same.
- A change to the messages the code prints goes in the code, and then in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
- A change to the plugin changes its files, the manifest versions and the copy of the skill together. CONTRIBUTING.md lists the steps.
- A change to what the tool can do goes in [CHANGELOG.md](../CHANGELOG.md) and in the documents that describe it. CONTRIBUTING.md lists them.
