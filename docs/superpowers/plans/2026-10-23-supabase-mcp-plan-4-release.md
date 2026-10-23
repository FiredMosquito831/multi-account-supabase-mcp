# Release and Documentation Implementation Plan (Plan 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task by task. Each task gets a fresh Haiku implementer, then a fresh Haiku reviewer, then a commit by the lead. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the product for a release that the owner can approve, without doing any outward step: the eleven-file documentation set, a link check as a test, the CI and publish workflows (the publish workflow is written and not run), the live-check runbook, the release process, and the personal-data and secret checks.

**Architecture:** Documents and workflow files are plain text in this repository. The tests that check them run offline in `npm test`. Nothing here creates a GitHub repository, pushes, tags, releases, or publishes. Those are the owner's named go-aheads.

**Tech Stack:** Node 22, Node's built-in test runner, no new dependency.

**Spec:** `docs/superpowers/specs/2026-10-20-supabase-mcp-design.md`, sections 6.9 (release), 6.10 (documentation) and 6.11 (tests). Reproduction map: `docs/research/reproduction-map.md`, section 2 (the eleven files) and the workflow rows.

## Global Constraints

- No outward step: no `git push`, no tag, no GitHub repository or release, no npm publish, no `npm pack` upload, no live login, no real token. `gh` is read-only, and only where a task says so.
- Tokens never go to a file, a log, command output, a test fixture or the chat. No file in the repository holds a token value or token-shaped text (`sbp_` followed by letters or digits).
- No personal data in a shipped or committed file: no owner email address, no absolute path under a user's home folder, no machine name. A test checks the shipped files.
- Every claim about a real CLI, a real configuration, a real GitHub or npm state, or a real Supabase account carries its "Not verified" or "ASSUMED, not verified" mark in the same sentence.
- Documentation comes in the same change as the behaviour it describes.
- `npm test` stays offline. A test never reaches the network.
- Pinned actions: every `uses:` in a workflow names a full commit SHA, with the tag in a comment on the same line.
- Plain English, short sentences, no emoji. No ruling IDs, no plan or task names, no owner label, no Netlify, no superpowers in any product file.

## Review Focus

1. A link in the README, which npm shows without the repository, is relative and breaks on npm. The README must use absolute links to the repository's own files. Task 2.
2. A workflow file runs a publish step on a push or a release that the owner did not approve. The publish workflow must be inert until the owner's trusted-publisher step and go-ahead. Task 4.
3. The four version fields disagree after a bump. A test checks them. Task 6.
4. A personal path or the owner's email address gets into a shipped file or a committed document. A test checks the shipped files. Task 7.
5. A live-check command in the runbook puts a token in the chat, or runs against a real account without the owner typing the token. The runbook says the owner types it, in a throwaway folder, and each step names its go-ahead. Task 5.

## Task 1: The eleven-file documentation set

**Files:**
- Rename (git mv): `docs/install.md` to `docs/INSTALL.md`; `docs/troubleshooting.md` to `docs/TROUBLESHOOTING.md`; `docs/scopes.md` to `docs/AGENTS.md`.
- Create: `docs/ACCOUNTS.md`, `docs/CONFIGURATION.md`, `docs/DEVELOPMENT.md`, `docs/MCP.md`, `docs/RELEASING.md`, `docs/SAFETY.md`, `docs/TESTING.md`, `docs/USAGE.md`. (`docs/TESTING.md` and `docs/RELEASING.md` are written in Tasks 5 and 6; Task 1 creates them as stubs with the headings only, so the link check in Task 2 passes.)
- Modify: `README.md` and the other documents, only where a link points to a renamed file.

**Content rules.** Each file owns one topic and states only what the code does now. Read the matching section of the code before you write a sentence. The content areas:
- `ACCOUNTS.md`: the account name rule, the token types (a scoped token or a classic one, one per account; the dashboard steps are OPEN), the default account, the registry file, and the rule that a token is typed in a terminal.
- `AGENTS.md`: the four agents, their scopes (Antigravity has the global scope only, ASSUMED), and what each install writes.
- `CONFIGURATION.md`: the environment variables (`MULTI_ACCOUNT_SUPABASE_HOME` and the rule that an installed server reads it only from its own environment), the file locations, and the lock file.
- `DEVELOPMENT.md`: the code layout (`src/`, `plugins/`, `skills/`, `docs/`), how to add an operation, and the commands `npm test`, `npm run typecheck`, `npm run build`.
- `INSTALL.md`: the installer routes (the installer command and the manual plugin route), and a pointer to `AGENTS.md`.
- `MCP.md`: the tools the server lists (34 official tools, plus the read-only query tool once it ships), the modes, the `account` argument, and the result shapes. The read-only query tool is OPEN (F17).
- `RELEASING.md`: the release process (Task 6).
- `SAFETY.md`: destructive SQL passes through without a wrapper gate (the owner accepted it), raw SQL results are data, the scoped-token advice, and the cost tools.
- `TESTING.md`: the test files and the live-check runbook (Task 5).
- `TROUBLESHOOTING.md`: the messages the code prints, copied from the code (not from memory).
- `USAGE.md`: every command, option, output and exit code, matching `src/usage.ts` word for word.

- [ ] **Step 1: Write the failing test.** The link check in Task 2 is the test; Task 1 has none of its own. Run `npm test` and record that the suite passes before the rename (the baseline).
- [ ] **Step 2: Rename and create.** Use `git mv` for the three renames. Create the eight new files, with headings and the content above. Update every link to a renamed file in `README.md` and the other documents (search for the old names).
- [ ] **Step 3: Check each sentence.** For each claim, read the code line and record it in the report. Mark each unverified claim in the same sentence.
- [ ] **Step 4: Run `npm test` and `npm run typecheck`.** Expected: all pass.

## Task 2: The link check, as a test

**Files:**
- Create: `src/test/docs-links.test.ts`

**Interfaces:**
- Consumes: the Markdown files `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md` and every file under `docs/` (not `docs/research/` and not `docs/superpowers/`).
- Produces: none.

The test asserts:
- Every relative link `[text](target)` in those files resolves to an existing file, relative to the file that holds it. A `#anchor` part must name a heading in the target file (GitHub's slug rule: lower case, spaces to hyphens, other punctuation removed).
- In `README.md`, no link is relative. Every link is an absolute `https://` URL, except an in-page `#anchor`. The README is the npm page, and npm shows it without the repository's files.
- Every link text that names a file resolves.

- [ ] **Step 1: Write the failing test.** Run `npm test`. Expected: the test fails on the README's relative links, which are present now.
- [ ] **Step 2: Fix the links in README.md** to absolute URLs of the form `https://github.com/FiredMosquito831/multi-account-supabase-mcp/blob/main/<path>`. The owner's repository is not created yet, so mark the README section that uses these links, in the same sentence, with "(not verified: the repository does not exist yet)". Write the mark once, in the section that introduces the links.
- [ ] **Step 3: Run `npm test` and `npm run typecheck`.** Expected: all pass.

## Task 3: The CI workflow

**Files:**
- Create: `.github/workflows/ci.yml`
- Create: `src/test/workflows.test.ts` (shared with Task 4)

**Interfaces:**
- Consumes: `package.json` (`engines.node`, the scripts).
- Produces: the workflow files, which Task 4 extends in the same test.

`ci.yml` content rules: triggers `pull_request` and `push` to `main`. A job matrix on `windows-latest` and `ubuntu-latest`, Node 22. Steps: checkout, setup Node 22, `npm ci`, `npm run typecheck`, `npm test`, `npm pack --dry-run`. No secret, no token, no `id-token` permission. Every `uses:` line pins a full commit SHA with the tag in a comment on the same line, for example `uses: actions/checkout@<40-hex-sha> # v4.2.2`. The SHAs are looked up with a read-only `gh api` call (for example `gh api repos/actions/checkout/git/ref/tags/v4.2.2`), and the lookup result is written in the comment as the tag. Record each lookup in the report with its command and output's first line.

- [ ] **Step 1: Write the failing test.** `src/test/workflows.test.ts` reads `.github/workflows/*.yml` and asserts: `ci.yml` has a matrix with `windows-latest` and `ubuntu-latest`; `node-version` is `22` in each job; every `uses:` has a 40-hex SHA and a `#` tag comment; no `id-token` permission and no `secrets.` reference in `ci.yml`; the steps include `npm test`, `npm run typecheck` and `npm pack --dry-run`. Run `npm test`. Expected: the test fails, because the file does not exist.
- [ ] **Step 2: Look up the SHAs** with read-only `gh api`, and create `ci.yml`.
- [ ] **Step 3: Run `npm test` and `npm run typecheck`.** Expected: all pass.

## Task 4: The publish workflow (written, not run)

**Files:**
- Create: `.github/workflows/npm.yml`
- Modify: `src/test/workflows.test.ts`

**Rules:**
- Triggers, as the Netlify project: a published GitHub release whose tag equals the version in `package.json` (`v` prefix not used); a push to `main` that changes `package.json` and carries a new version.
- The job first runs the same test matrix as `ci.yml` (Windows and Ubuntu, Node 22). The publish job needs both to pass.
- The publish job has `permissions: id-token: write` and no other write permission. It installs npm `11.5.1` or newer (pinned), and runs `npm publish --provenance` (trusted publishing). It has no `NPM_TOKEN` secret.
- The publish job runs only when the repository is the owner's and the owner has created the trusted publisher. The workflow has an `if:` on `github.repository == 'FiredMosquito831/multi-account-supabase-mcp'`. The first publish is the owner's from a terminal (design 6.9), and that is stated in a comment in the file.
- Pinned actions as in Task 3.

- [ ] **Step 1: Write the failing test.** Extend `workflows.test.ts`: `npm.yml` has the two triggers; the publish job `needs` the test job; `id-token: write` is the only write permission; npm is pinned to 11.5.1 or newer; the `if:` names the repository; no `NPM_TOKEN` appears; every `uses:` is pinned. Run `npm test`. Expected: the new assertions fail.
- [ ] **Step 2: Write `npm.yml`.**
- [ ] **Step 3: Run `npm test` and `npm run typecheck`.** Expected: all pass. Do not run the workflow.

## Task 5: The live-check runbook (TESTING.md)

**Files:**
- Modify: `docs/TESTING.md` (created as a stub in Task 1)

**Content:** the test files and what each covers (from `src/test`); the live checks, each as one block with: the goal, the throwaway folder to use, the exact command the owner types, the output to paste back, the expected result, and the go-ahead that the owner must give. The live checks are:
- F17: a write sent through the read-only query tool is refused by the API (not yet built; the block says so).
- S4: the placeholder value of the catalog child, in a throwaway folder.
- The first real child start, and the Ctrl+C check on Windows (the stop signal reaches cmd.exe, not the server, OPEN).
- The 2026 protocol era (the current protocol version, ASSUMED).
- A real client's handling of the tool-list change notice (not verified).
- The real Codex, opencode and agy listings and their exit codes (the layouts are ASSUMED).
- The Windows child-environment check (not run).
- `claude plugin marketplace add`, `claude plugin install`, and the plugin's commands in Claude Code (not run; needs a throwaway profile).
- The marketplace ref (T7): whether Claude Code accepts a ref (OPEN).
- The dashboard steps for a scoped token (OPEN; read again before a release).

Each block says: "Type the token in your own terminal, in a throwaway folder. Paste the output here. The chat does not receive the token." Each block has its go-ahead line: "Needs your go-ahead for this step: <name of the step>."

- [ ] **Step 1: Write the failing test.** `src/test/docs-links.test.ts` (Task 2) already checks links. Add to `src/test/workflows.test.ts` one assertion that `docs/TESTING.md` contains each live-check name above and the phrase "Needs your go-ahead". Run `npm test`. Expected: it fails until the runbook exists.
- [ ] **Step 2: Write the runbook.**
- [ ] **Step 3: Run `npm test` and `npm run typecheck`.** Expected: all pass.

## Task 6: The release process (RELEASING.md)

**Files:**
- Modify: `docs/RELEASING.md` (created as a stub in Task 1)
- Create: `src/test/versions.test.ts`

**Rules, as the design (6.9):**
- The four version fields: `package.json` (`version`), `package-lock.json` (the root `version` and `packages[""].version`), `plugins/multi-account-supabase/.claude-plugin/plugin.json` (`version`), `.claude-plugin/marketplace.json` (`metadata.version`). The test checks all four are equal.
- The release order: a version bump commit with `[skip ci]`, the tests, a release with a tag equal to the version, and the owner's go-ahead for each step. The steps are written, not run.
- The secret and personal-data check (Task 7) runs before a release.
- The first publish from a terminal, by the owner, and the trusted publisher on npmjs.com, are the owner's steps.

- [ ] **Step 1: Write the failing test** `src/test/versions.test.ts`: the four fields are equal. Run `npm test`. Expected: it passes if the four match now, and fails if one differs (check by changing a copy in a temporary folder, not the repository).
- [ ] **Step 2: Write `RELEASING.md`.**
- [ ] **Step 3: Run `npm test` and `npm run typecheck`.** Expected: all pass.

## Task 7: The personal-data and secret check, as a test

**Files:**
- Create: `src/test/shipped-files.test.ts`

**Rules.** The test walks the files that `npm pack` ships (the `files` list in `package.json`: `dist/` without `dist/test/`, `.claude-plugin/`, `plugins/`, `skills/`, `README.md`, `LICENSE`, `NOTICE`) and the repository's documents (`docs/` without `docs/research/` and `docs/superpowers/`, and `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`). It fails on:
- a token-shaped string: `sbp_` followed by letters or digits;
- a personal path: `C:\Users\`, `/Users/`, `/home/`, `\\Users\\` followed by a name;
- an email address (a word, an `@`, a domain with a dot), except `FiredMosquito831` in a URL and the owner's public author name in `package.json` and the plugin manifests, which are allowed by name;
- a machine name: the Windows computer name is not known to the repository, so this rule is not tested; it is in `RELEASING.md` as a manual check.

The test prints the file and line for each match, and never the match's full text beyond the first 20 characters.

- [ ] **Step 1: Write the failing test.** Run `npm test` on the repository as it stands. Expected: it passes if the repository is clean; if a match is found, fix the file and record the fix.
- [ ] **Step 2: Fix any match found** (a path in a document, for example, is replaced by a placeholder such as `<your folder>`).
- [ ] **Step 3: Run `npm test` and `npm run typecheck`.** Expected: all pass.

## Task 8: The CHANGELOG and the completion check

**Files:**
- Modify: `CHANGELOG.md` (the Unreleased section, one entry per change in Plans 1 to 4, each with its mark where needed).
- Read: `README.md`, `docs/*.md`.

- [ ] **Step 1:** Read the CHANGELOG Unreleased section and check each entry against the commit log (`git log --oneline`), read-only. Add an entry for each user-visible change that is missing.
- [ ] **Step 2:** Run `npm test` and `npm run typecheck`. Expected: all pass.

## Task 9: Whole-branch review and the release check (lead, then reviewers)

- [ ] Run `npm test`, `npm run typecheck`, `npm run build`, and `npm pack --dry-run`. Read the file list: it includes the shipped files and no `docs/research`, no `docs/superpowers`, no test source, and no personal path.
- [ ] Run two read-only Haiku reviewers in parallel: one on the workflows and the versions (Tasks 3, 4 and 6); one on the documents and the runbook (Tasks 1, 2, 5 and 8). Fix what they find. Re-run the tests.
- [ ] Stop. The release is the owner's: the repository, the push, the tag, the release, the trusted publisher, and the publish each need the owner's named go-ahead, one at a time.

## Commit

Each task is committed by the lead after its review passes, with `git commit -F` and a message file. The message ends with `by FiredMosquito831`.

## Open items (each needs the owner's go-ahead or a live check)

- Create the GitHub repository (private first; public only on a separate go-ahead, after the secret check).
- Push, tag and release.
- Create the trusted publisher on npmjs.com, and the first publish from a terminal.
- Every live check in `docs/TESTING.md`.

## Self-review

- Spec coverage: 6.9 (Tasks 3, 4, 6, 7; the rest is the owner's); 6.10 (Tasks 1, 2, 8); 6.11 (Task 5 and the existing suite).
- Names: the file names in Task 1 match the reproduction map. The test files do not share names with other tasks.
- Conflicts: Tasks 3 and 4 share `src/test/workflows.test.ts`; they run in order, one at a time.
