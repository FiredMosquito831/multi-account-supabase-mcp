# Contributing

## Set up

- Use Node 22 or newer. Node 22 has not been run here. `package.json` sets `engines` to `>=22`. The local runtime used so far is Node 24.6.0, with npm 11.14.1. The continuous integration on Node 22 is not set up yet.
- Run `npm install` in the checkout.
- To look at the installers without changing any agent, run `node dist/cli.js install --dry-run` after `npm run build`. A dry run changes nothing. It reads your data folder, the PATH and the agent files it would change, and it runs no agent command. A real install, update or uninstall changes an agent's own configuration, so run those only in a throwaway setup.

## Run the checks

- `npm test` builds the project, then runs the tests in `dist/test`.
- `npm run typecheck` checks the types. It prints nothing when the check passes.
- `npm run build` deletes `dist/` and compiles `src/` into `dist/`.

Run `npm test` after each change. Run `npm run typecheck` when you change a type.

The file `test/fixtures/official-tools.json` holds the official tool list. To refresh it, run `node scripts/capture-official-tools.mjs > test/fixtures/official-tools.json`. `src/test/coverage.test.ts` checks that the policy table has the same tool names as the fixture, and that every write tool is in mode `one`. The capture script includes the docs group, which reads from Supabase's docs service. So the script needs network access. Not verified: the docs service answers without a token, and the test is not run here. The tests do not run it.

## Test rules

- Tests use fakes and temporary folders. A test makes its folder with `mkdtemp` or `mkdtempSync`, and removes it when it ends.
- A test does not use the network. Use a fake `fetch`.
- A test does not use the credential store. Use a fake store.
- No test uses a real token. The sbp_-shaped values in the refusal tests are fake. Use a plain, obviously fake value.
- The one test that starts the official package leaves out the docs group. It uses the placeholder token.
- An installer test sets `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `XDG_CONFIG_HOME` and `MULTI_ACCOUNT_SUPABASE_HOME` to temporary folders. It uses fake command results in place of the agents. `src/test/no-real-config.test.ts` checks that no file outside the temporary folders changes.
- Each uninstall test has a case with no record.
- A test that would still pass without the behaviour it names must be rewritten so that it fails without that behaviour.

## Code rules

- Use strict types. `tsconfig.json` sets `"strict": true`.
- Do not add a dependency without a stated reason in the change.
- Write comments that explain why, in plain words.
- In serve mode, stdout carries the MCP protocol. Write logs to stderr only.
- Never write a token to a file, a log, command output, a test fixture or a chat.
- A change tool never runs on several accounts. A tool that the policy table does not name counts as a change.

## Installers

The install, update, uninstall and doctor commands are in `src/install/flow.ts`. The adapters are in `src/agents/`: `claude.ts`, `codex.ts`, `opencode.ts` and `antigravity.ts`. The record code is in `src/agents/state.ts`, and the scopes are in `src/agents/scopes.ts`.

- Each adapter acts only on what its record lists. Update and uninstall never act on an item that the record does not list.
- For Codex, opencode and Antigravity, install refuses an entry, table or file that this tool did not write, and it never takes one over. The Claude Code install does not check for an existing plugin. See `SECURITY.md`, section 7.
- Refuse a file that cannot be parsed. Read and check the record before the first change.
- Back up a config file, such as the Codex project `config.toml` or opencode's `opencode.json`, before an edit. A backup takes the first free name and is never overwritten. Uninstall never removes a backup. The one exception is `SKILL.md`: it is replaced without a backup, and only when the record lists it as created by this tool.
- Write a record before an edit to a file, so a failed edit leaves a record that describes nothing, except for an agent's own command, where the record is written after the command, because the command is the change, as the Claude Code install does; if that record cannot be written, the step says what to remove.
- A dry run lists each command line and each file change, and it changes nothing. A check that a program is on PATH runs in a dry run, because it only reads. A listing does not run in a dry run, and the step says so. Each dry-run message says what would happen, with "Would", and never what happened.
- A failed step gives one line. It uses the first non-empty line of the error output, then the first non-empty line of the standard output, then the exit code. The exception is the Claude Code install, which can give more than one line: one for each failed command, and a note about the marketplace.
- Explain each reason in a comment, in plain words. Do not put a rule ID in a comment.
- When an adapter edits an agent's file, instead of using the agent's own command, its comment says why.
- A new agent needs an adapter, its scopes in `src/agents/scopes.ts`, a place in the list of adapters in `src/install/flow.ts`, tests with fake command results, and the docs in `docs/`.
- The Claude Code `-y` flag must stay tied to a marketplace that declares no command. See `SECURITY.md`.

## Documentation rules

- Documentation for a feature comes in the same change as the feature.
- When behavior changes, update the documents that describe it: `README.md`, `SECURITY.md` and `CONTRIBUTING.md`, the Unreleased section of `CHANGELOG.md`, and the guides in `docs/` (`install.md`, `scopes.md` and `troubleshooting.md`).
- Every number, message, path and exit code in the documentation must match the source. Check each one against the code before you commit.

## Commit messages

- The subject line is one line, in the imperative. For example: `fix: keep the save error when stderr fails`.
- The history uses a type prefix, such as `feat:` or `fix:`.
- Add a short body. It says what changed and why.
