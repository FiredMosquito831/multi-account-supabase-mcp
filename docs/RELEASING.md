# Releasing

This page describes how a release is made. Several steps reach GitHub or npm. Each of those steps needs your go-ahead, given for that step by name. Nothing on this page has been run against GitHub or npm. The two workflows have never run. Every statement here about how GitHub or npm behave is Not verified.

## Before the first release

- Check that the names are free before you create anything. `npm view multi-account-supabase-mcp name` should fail with E404 while the npm name is free. `gh repo view FiredMosquito831/multi-account-supabase-mcp` should say that it cannot resolve the repository. Not verified in this change.
- Confirm the licence before the first publish. The package is under Apache-2.0 (`LICENSE`). The `NOTICE` file says: "Supabase is a trademark of its owner."
- Create the GitHub repository as private. Needs your go-ahead for this step: create the private repository `FiredMosquito831/multi-account-supabase-mcp`. Command: `gh repo create FiredMosquito831/multi-account-supabase-mcp --private`. Not verified: this command has not been run.
- Keep the repository private until the checks in step 3 pass. Making it public needs a separate go-ahead.
- Not verified: confirm each SHA in the workflow files against the tag it names, on GitHub, before the first run.
- The first version follows this order:
  1. The maintainer publishes the first version once, from a terminal (step 7).
  2. The maintainer creates the trusted publisher on npmjs.com (step 8).
  3. Releases after that are for new versions only.
- Do not create a release for a version that is already on npm. The release starts npm publish, which fails for a version that exists (Not verified: npm's behaviour for a version that exists).

## The version fields

Five values in four files must hold the same version. Change all five in the same commit.

| File | Field |
| --- | --- |
| `package.json` | `version` |
| `package-lock.json` | `version` (the top level) |
| `package-lock.json` | `packages[""].version` |
| `plugins/multi-account-supabase/.claude-plugin/plugin.json` | `version` |
| `.claude-plugin/marketplace.json` | `metadata.version` |

`npm test` reads the five values and fails when any one of them differs (`src/test/versions.test.ts`).

## The steps

### 1. Bump the version

1. Set the five values to the new version.
2. Move the Unreleased entries in `CHANGELOG.md` under a heading for the new version.
3. Run `npm test`. The version check passes only when the five values match.
4. Commit the bump on its own. End the commit message with `[skip ci]`. A local commit needs no go-ahead.

The bump commit carries `[skip ci]`, and that is intended. The publish workflow has no push trigger, so a push of the bump does not publish. A version bump is followed by a release, and the release is the only trigger for publishing (Not verified: GitHub's handling of `[skip ci]`). With `[skip ci]`, `ci.yml` does not run on the bump commit (Not verified). The publish workflow's test job is then the only run on Windows and Ubuntu before the publish.

### 2. Check the release candidate

Run these in the repository folder:

- `npm run typecheck`. It prints nothing when it passes.
- `npm test`. It builds the package, then runs the offline tests. The link check, the version check and the shipped-files check are among them.
- `npm pack --dry-run`. It lists the files that a package would hold. It does not upload anything (Not verified in this change).

Read the file list. It should hold the entries of the `files` list in `package.json`: `dist/`, `.claude-plugin/`, `plugins/`, `skills/`, `README.md`, `LICENSE` and `NOTICE`. It should not hold `dist/test/`, `docs/`, or any personal path. npm adds `package.json` itself (ASSUMED, not verified in this change).

### 3. Check the shipped files for personal data and secrets

Run this check before a push and before a release.

- Automatic: the shipped-files test, `src/test/shipped-files.test.ts`, runs in `npm test`. It reads the files in the `files` list of `package.json`, the public documents, and `docs/` except `docs/research` and `docs/superpowers`. It looks for a personal path, token-shaped text, an email address and a long run of letters and digits. An email address passes only at `example.com`. The long-run rule skips URLs, so a commit hash in a link is not flagged. The other rules still read URLs.
- Manual: search for the name of the computer that built the package, and for the name of your Windows user folder. The repository does not hold these names, so no test can check them.

If a check finds a match, change the file. Do not add an exception without a note here.

### 4. Push the bump (needs your go-ahead)

Needs your go-ahead for this step: push the version bump to `main`.

Command: `git push origin main`, once the remote `origin` points at the repository. Not verified: the remote has not been set up.

### 5. Create the release, with a tag equal to the version (needs your go-ahead)

Needs your go-ahead for this step: create the GitHub release and its tag.

- Creating the release also starts npm publish through the workflow (Not verified: GitHub's trigger behaviour). That publish needs a go-ahead of its own, named: "The maintainer's go-ahead for the publish that this release starts."
- The tag must equal the version exactly, with no `v` prefix. For version `0.1.1`, the tag is `0.1.1`. The publish workflow compares the tag with `package.json` and does not publish when they differ.
- Create the release as published, not as a draft. The publish workflow listens for a published release (Not verified: how GitHub reports a draft).
- Command: `gh release create 0.1.1 --target main --title 0.1.1 --notes-file <notes file>`. Keep the notes file outside the repository. Not verified: this command has not been run, and `gh` may create the tag differently.

### 6. The publish workflow (`.github/workflows/npm.yml`)

The workflow is written and has never run. Every statement in this section about its behaviour on GitHub or npm is Not verified.

It starts only on a published release. It has no push trigger, because the bump commit carries `[skip ci]`. It does three things:

1. The test job runs on `windows-latest` and `ubuntu-latest`, with Node 22. It runs `npm ci`, `npm run typecheck`, `npm test` and `npm pack --dry-run`.
2. The check job publishes only when the release tag equals the version in `package.json`. Otherwise it does not publish, and it says why.
3. The publish job runs only in `FiredMosquito831/multi-account-supabase-mcp`, and only after the test job and the check job both pass. It installs npm 11.5.1, then runs `npm publish --provenance`. It uses trusted publishing, with `id-token: write` as its only write permission. It has no npm token. Each checkout sets `persist-credentials: false`, so the token is not kept in the git config (Not verified: the checkout action's behaviour).

The workflow does not create the repository, the tag or the release. It does not create the trusted publisher on npmjs.com. It does not make the first publish.

### 7. The first publish, from a terminal (needs your go-ahead; you run it)

Needs your go-ahead for this step: run the first `npm publish` from a terminal.

The first publish is yours. Run it from a terminal, logged in to your npm account, from a clean checkout of the version commit: `npm publish`. It comes before the trusted publisher and before any release, in the order given under Before the first release. Not verified: this has not been run. Not verified: an unscoped name is public by default.

### 8. The trusted publisher on npmjs.com (needs your go-ahead; a console step)

Needs your go-ahead for this step: set the trusted publisher on npmjs.com.

This step is yours, in the npmjs.com settings of the package, after the first publish. The values are: provider GitHub Actions, repository `FiredMosquito831/multi-account-supabase-mcp`, and workflow file `npm.yml`. Not verified: the npmjs.com page and its field names have not been checked.

### 9. After the publish

- Read the version back with `npm view multi-account-supabase-mcp version`. It should print the new version. Not verified: this has not been run against npm.
- Each later release needs its own go-ahead, named. So does each deprecation of a version.
- Making the repository public needs a separate go-ahead, after the checks in step 3 pass.

## Related pages

- [TESTING.md](TESTING.md): the offline tests and the live checks. Each live check needs its own go-ahead.
- [DEVELOPMENT.md](DEVELOPMENT.md): the commands and the code layout.
