# Contributing

## Set up

- Use Node 22 or newer. Node 22 has not been run here. `package.json` sets `engines` to `>=22`. The local runtime used so far is Node 24.6.0, with npm 11.14.1. The continuous integration on Node 22 is not set up yet.
- Run `npm install` in the checkout.

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

## Code rules

- Use strict types. `tsconfig.json` sets `"strict": true`.
- Do not add a dependency without a stated reason in the change.
- Write comments that explain why, in plain words.
- In serve mode, stdout carries the MCP protocol. Write logs to stderr only.
- Never write a token to a file, a log, command output, a test fixture or a chat.
- A change tool never runs on several accounts. A tool that the policy table does not name counts as a change.

## Documentation rules

- Documentation for a feature comes in the same change as the feature.
- When behavior changes, update the documents that describe it: `README.md`, `SECURITY.md` and `CONTRIBUTING.md`, and the Unreleased section of `CHANGELOG.md`.
- Every number, message, path and exit code in the documentation must match the source. Check each one against the code before you commit.

## Commit messages

- The subject line is one line, in the imperative. For example: `fix: keep the save error when stderr fails`.
- The history uses a type prefix, such as `feat:` or `fix:`.
- Add a short body. It says what changed and why.
