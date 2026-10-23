# Testing

This page covers two things. The first is the offline tests, which `npm test` runs. The second is the live checks. A live check uses a real Supabase account, a real agent or a real client. No live check runs until you give the go-ahead for that step, by name.

## Offline tests

- `npm test` builds the package, then runs the test files in `dist/test/`. It takes no argument.
- `npm run typecheck` runs the strict type check. It prints nothing when it passes.
- `npm run build` removes `dist/` and compiles the package. The command line program is `dist/cli.js`.

The test files use fakes and temporary folders. They are meant to stay offline, and to leave your accounts, your agent settings and your credential store alone. This has not been checked for every test file line by line.

## The test files

The test files are in `src/test/`. The lists below come from the test names in each file. Each line says what the file covers. `src/test/isolation.ts` is a helper that the tests share. It is not a test file. There are 38 test files.

### Server and tool list

- `server.test.ts`: how a call is routed. It covers an unknown tool, a change with no account, `account_list` with no accounts, and a read with no account, which uses the default account.
- `serve.test.ts`: the protocol code writes nothing to stdout. It also covers the tool list over an in-memory transport, and the refusal of a change that names several accounts or all of them, and of a tool the policy does not name, when a list or `all` is given.
- `catalog.test.ts`: the `account` argument added to each tool, and the note that ends each tool description, by mode.
- `policy.test.ts`: the mode of each of the 34 official tools, and that the read-only query tool is named and not exposed.
- `coverage.test.ts`: the policy table has the tool names of the saved list. Every tool that the saved list marks as able to change data is in mode `one`. The two cost tools are the only read-only tools in that mode.
- `routing.test.ts`: how the `account` argument is read. It covers a missing or blank value, a value that is not text, an unknown name, and no default account.
- `fanout.test.ts`: a read to several accounts. It covers the limit of four at a time, the order of the results, a failed call that does not stop the others, and a limit that is not a whole number.
- `children.test.ts`: the official child processes. It covers start, reuse, close and restart, the read-only and writable children, the placeholder child, and an account whose stored value is the placeholder.
- `integration.test.ts`: the official server, started over stdio with a placeholder value. It covers a list of writable and read-only tools, and the refusal of a write when the server is read-only.

### Accounts and tokens

- `registry.test.ts`: the default account after adds and removes.
- `names.test.ts`: the refusal of the reserved account name `all`.
- `add-account.test.ts`: the add flow. The token and the record are stored. A failed check stores nothing. A taken name, or a Supabase user already added under another name, is refused.
- `api.test.ts`: the profile call. It covers the request, the three fields of the reply, a rejected token, and a changed base address.
- `token-store.test.ts`: the in-memory token store that the tests use. It covers set, get and delete.
- `secret-input.test.ts`: the hidden token input. Arrow keys do not enter the token, and Backspace removes one character each time.
- `lock.test.ts`: the lock file. The work runs and the lock is removed. A second call waits for the first. A call that waits too long stops with the busy message.

### Commands and launcher

- `cli.test.ts`: the `add`, `list`, `default` and `remove` commands. It covers the refusal of piped input to `add`, and that no command output holds the typed token.
- `flow.test.ts`: install dry runs and their exit codes. It also covers an install with no terminal and no `--yes`, which writes nothing.
- `command.test.ts`: how a program is started. It covers quoting for the Windows command shell, the PATH lookup, relative PATH entries, and a NUL character in an argument.
- `launcher.test.ts`: the plugin launcher. With no argument it runs `serve`. With arguments it runs them, with no shell. It also reads the plugin version, and refuses a version that is not a semantic version.

### Installers and agents

- `claude.test.ts`: the Claude Code adapter. It covers the marketplace add and the plugin install for each scope, the records it keeps, and a failed marketplace add.
- `codex.test.ts`: the Codex adapter. It covers the global add after the listing, the messages for a failed add, and the records.
- `opencode.test.ts`: the opencode adapter. It covers a file that is not valid JSON, which is refused, an entry for another server, which is kept, and the records.
- `antigravity.test.ts`: the Antigravity adapter. It covers the global scope only, the listing before the add, and a refusal when the name is already listed.
- `plan.test.ts`: the plan. A named agent without the scope is refused. A dry run changes no file and runs no command.
- `scopes.test.ts`: the scopes that each agent supports.
- `state.test.ts`: the record file for each agent, and the key for each scope.
- `paths.test.ts`: where the data folder is, on Windows and on other systems.
- `folders.test.ts`: the folders the installers create. It covers that only the folders the tool made are reported as made.
- `skill.test.ts`: writing and removing the skill file. A folder that holds a file this tool did not write is kept.

### Plugin

- `plugin-manifest.test.ts`: the marketplace and plugin manifests. It covers the names, the one plugin entry, and that the marketplace declares no commands, hooks or servers.
- `plugin-files.test.ts`: the plugin's server file, the plugin skill (a copy of the root skill), and the version lines in the skill.
- `plugin-commands.test.ts`: the command files. Each has a description. The shell lines are limited to the approved ones, and no command file takes user text.

### Documents, workflows and versions

- `docs-links.test.ts`: the relative links in the documents resolve. The README uses absolute links only.
- `workflows.test.ts`: the CI and publish workflow files. It covers the triggers, the Windows and Ubuntu matrix on Node 22, the checks each job runs, the permissions, and the action pins. It also checks that this page has one go-ahead line for each live check.
- `version.test.ts`: reading the version from a `package.json` file.

### Safety and isolation

- `isolation.test.ts`: the seven environment names that every test points into a temporary folder.
- `no-real-config.test.ts`: the seven names are checked before each plan. No installer writes outside the temporary folders.

## Live checks

Live checks use a real account, a real agent or a real client. Each live check is one block below. You run each command yourself, in your own terminal, and paste back the output.

Rules for every live check:

- Type the token in your own terminal, run from the checkout. Paste the output here. The chat does not receive the token. If a token is pasted into the chat, the assistant does not use it, and you revoke it in the Supabase dashboard.
- Make an empty folder under your own temporary folder. Use it as the throwaway folder.
- Before any command that reads or writes accounts, set `MULTI_ACCOUNT_SUPABASE_HOME` to the throwaway folder. The variable names the data folder, which holds the accounts file (`docs/CONFIGURATION.md`). The credential store is not in that folder (ASSUMED, not verified on a real system). Remove each test account when its check ends. After each check that adds an account, revoke its token in the Supabase dashboard: remove does not revoke it (Not verified: the dashboard path).
- Paste only output that holds no token. Remove anything that looks like a secret before you paste.
- A go-ahead covers only the step it names.
- The commands use the program in this repository, `node dist/cli.js`, run from the checkout after `npm run build`, as `docs/USAGE.md` says.

The shell lines below use PowerShell.

### Read-only query tool refusal

- Goal: check that the Supabase API refuses a write sent through the read-only query tool. The tool is not built yet, so this check waits for it. Not verified: that the API enforces the read-only flag on that call.
- Throwaway folder: none. Use a throwaway Supabase project that holds no data you need.
- Command: this block gives no command. The tool is not in the server yet. Not verified: the command is to be confirmed when the tool is built. If the step needs a token then, type it in your own terminal. The chat does not receive the token.
- Output to paste back: the text that the server returns for the write, and the result of a read of the same table afterwards. No token.
- Expected result: Not verified: the write is refused, and the table does not change.

Needs your go-ahead for this step: Read-only query tool refusal.

### Catalog placeholder check

- Goal: check that the official server lists its tools when it is given the placeholder value in place of a token. The placeholder is not a real token. This step needs no token.
- Throwaway folder: an empty folder under your own temporary folder. The output file goes there. The checkout is not changed.
- Command: run from the checkout. This step needs no token.

  ```powershell
  node scripts/capture-official-tools.mjs > "<your throwaway folder>\official-tools.json"
  $LASTEXITCODE
  ```

  The script starts the official package with the placeholder value and lists its tools. The file gets the list. The count goes to the terminal.
- Output to paste back: the line that starts with `tools:`, and the exit code. Do not paste the file.
- Expected result: exit code 0, and a count of 34 (not verified in a live run). The saved list in the repository also has 34 tools (`docs/MCP.md`). Not verified in a live run: that the official server lists its tools with the placeholder value. The list call may need network access (ASSUMED, not verified). After the run, `git status` in the checkout shows no change under `test/fixtures`.

Needs your go-ahead for this step: Catalog placeholder check.

### First real child start

- Goal: start one official child process for a real account, and get one result through the server. This step needs a real token.
- Throwaway folder: an empty folder under your own temporary folder. Set `MULTI_ACCOUNT_SUPABASE_HOME` to it, as shown below.
- Command: run from the checkout. Type the token in your own terminal. Paste the output here. The chat does not receive the token. The throwaway folder is only the value of `MULTI_ACCOUNT_SUPABASE_HOME`.

  ```powershell
  # Run from the checkout. The throwaway folder is only the value of MULTI_ACCOUNT_SUPABASE_HOME.
  $env:MULTI_ACCOUNT_SUPABASE_HOME = "<your throwaway folder>"
  node dist/cli.js add check-1 --pat
  node dist/cli.js list
  ```

  Type the token when `add` asks for it. The input is hidden (not verified in a real terminal window).

  Then start the server through an MCP client, with the same `MULTI_ACCOUNT_SUPABASE_HOME` value in the client's environment. The client runs `node dist/cli.js serve`. Send one read: `list_projects` with `account` set to `check-1`. Not verified: which MCP client to use, how it passes the environment, and how it sends the call. Confirm these before you run the step.

  When you finish, run `node dist/cli.js remove check-1 --yes`, with the same variable set. After this step, revoke the token in the Supabase dashboard: remove does not revoke it (Not verified: the dashboard path).
- Output to paste back: the line from `add`, the lines from `list`, and the first lines of the read's result. No token.
- Expected result: `add` prints one line that starts with `Added "check-1"` (not verified in a live run). `list` shows `check-1` with an asterisk (not verified in a live run). The read returns the official result for that account, with no error flag (not verified against a real Supabase account).

Needs your go-ahead for this step: First real child start.

### Ctrl+C check on Windows

- Goal: check that Ctrl+C ends the server on Windows, and that no child process started by the check is left running. The open question is whether Ctrl+C reaches the server, or only `cmd.exe`, when the server runs through a `.cmd` shim. Not verified. This check runs the server with `node` directly, so it does not test the shim.
- Throwaway folder: the same empty folder, with `MULTI_ACCOUNT_SUPABASE_HOME` set to it. With no account in it, no child starts. The code shows this: the tool list and the reads return before any child is used (`src/mux/server.ts`, lines 159 to 161 and 220 to 224). Run this check after the first real child start check to see a child stop too (not verified on Windows).
- Command: This step needs no token.

  ```powershell
  $env:MULTI_ACCOUNT_SUPABASE_HOME = "<your throwaway folder>"
  node dist/cli.js serve
  ```

  Press Ctrl+C in the same terminal window. Then run `$LASTEXITCODE`.
- Output to paste back: what the terminal printed after Ctrl+C, and the value of `$LASTEXITCODE`. Also say whether a `node` process from this check is still running in Task Manager. Not verified: the process names to look for.
- Expected result: the server stops at once and prints nothing more to stdout, and no `node` process from this check is left (not verified on Windows).

Needs your go-ahead for this step: Ctrl+C check on Windows.

### Protocol version check

- Goal: check which MCP protocol version the server and a client agree on. ASSUMED: the version is the current one for the 2026 era. Not verified: the version string.
- Throwaway folder: the same empty folder. This step needs no token.
- Command: Not verified: the client, and the way to read its protocol version, are to be confirmed before the step runs. The client starts the server with `node dist/cli.js serve`.
- Output to paste back: the protocol version that the client shows. No token and no tool data.
- Expected result: the server and the client agree on one version (ASSUMED, not verified: that it is the current version for the 2026 era).

Needs your go-ahead for this step: Protocol version check.

### Tool-list change notice

- Goal: see what a real client does when the list of accounts changes while the server runs. Not verified: no real client has been run.
- Throwaway folder: the same empty folder. Set `MULTI_ACCOUNT_SUPABASE_HOME` in both terminals.
- Command: run from the checkout. Type the token in your own terminal. Paste the output here. The chat does not receive the token. The throwaway folder is only the value of `MULTI_ACCOUNT_SUPABASE_HOME`.

  Start the server through an MCP client, as in the first real child start check. Not verified: which client to use. Then, in a second terminal:

  ```powershell
  # Run from the checkout. The throwaway folder is only the value of MULTI_ACCOUNT_SUPABASE_HOME.
  $env:MULTI_ACCOUNT_SUPABASE_HOME = "<your throwaway folder>"
  node dist/cli.js add check-2 --pat
  ```

  Then look at the client's tool list. Not verified: how the client shows the list. When you finish, run `node dist/cli.js remove check-2 --yes`. After this step, revoke the token in the Supabase dashboard: remove does not revoke it (Not verified: the dashboard path).
- Output to paste back: the number of tools the client shows before the add and after it. No tool data and no token.
- Expected result: the client gets the change notice and shows the new list, or the client needs a new session to see it (not verified: no real client was run).

Needs your go-ahead for this step: Tool-list change notice.

### Codex, opencode and Antigravity listings

- Goal: check the real output and exit code of the two listing commands that the installers read. The installers assume their layouts. Also find where opencode keeps its server list. ASSUMED: the file and the layout.
- Throwaway folder: an empty folder under your own temporary folder. These commands only read, so no project folder is needed.
- Command: This step needs no token. Read only. Not verified: the command forms `codex mcp list` and `agy mcp list`, which come from `docs/INSTALL.md`.

  ```powershell
  codex mcp list
  $LASTEXITCODE
  agy mcp list
  $LASTEXITCODE
  ```

  No command for listing opencode's servers is known from the code. Open opencode's configuration file, and read it without editing it. The file location is ASSUMED, not verified.
- Output to paste back: the first five lines of each listing, and each exit code. Paste server names only. If a line shows a token, do not paste it.
- Expected result: Not verified: each command prints its list and exits with 0. The output shows whether the installers read the layout correctly.

Needs your go-ahead for this step: Codex, opencode and Antigravity listings.

### Windows child environment check

- Goal: check which environment names an official child process gets on Windows. The expected names are in `docs/CONFIGURATION.md`, under "Child process environment". Not verified: that Windows adds the eight extra names, as the code says.
- Throwaway folder: the same empty folder, with `check-1` added in the first real child start check.
- Command: Not verified: the command is to be confirmed before the step runs. The code has no command for this check, so none is written here. The child starts only on a call, so the call is sent through an MCP client, as in the first real child start check. This step needs no token typed here.
- Output to paste back: the environment names only. Never paste a value.
- Expected result: Not verified: the child gets only the names in `docs/CONFIGURATION.md`, plus the account's own token under its variable name.

Needs your go-ahead for this step: Windows child environment check.

### Claude Code marketplace and plugin install

- Goal: check the marketplace add and the plugin install in Claude Code, and one plugin command. Not verified: every command form below.
- Blocker: the marketplace repository does not exist yet (Not verified: checked on 2026-10-20 only). This check cannot pass until you create it. Creating it is an outward step, with its own go-ahead.
- Throwaway folder: an empty folder under your own temporary folder. Use it as the project folder for the project scope. ASSUMED, not verified: that the project scope writes only in that folder.
- Command: This step needs no token typed here. The commands come from `docs/INSTALL.md` (not verified: the command form). The `claude` command must be on PATH.

  ```powershell
  claude plugin marketplace add FiredMosquito831/multi-account-supabase-mcp --scope project
  claude plugin install multi-account-supabase@multi-account-supabase-mcp --scope project -y
  ```

  Then open Claude Code in the same folder, and run (not verified: the command form):

  ```
  /plugin marketplace add FiredMosquito831/multi-account-supabase-mcp
  /plugin install multi-account-supabase@multi-account-supabase-mcp
  ```

  Not verified: these forms, and whether `-y` is accepted. Then run one plugin command. Not verified: the name you type for it. The plugin's command files are `accounts`, `add-account`, `doctor`, `remove-account` and `set-default`. Do not run `add-account` in this check. It asks for a token, which you type in a terminal, not in Claude Code.
- Output to paste back: the first line of each command's output, and the name of the plugin command you ran, with its first lines of output.
- Expected result: each command succeeds once the marketplace repository exists, and the plugin command runs and shows its result (not verified for either).

Needs your go-ahead for this step: Claude Code marketplace and plugin install.

### Marketplace ref in Claude Code

- Goal: check whether Claude Code accepts a release ref when you add the marketplace. Not verified: that Claude Code accepts a ref.
- Blocker: this check needs the marketplace repository and a release. Both are outward steps, and each has its own go-ahead.
- Throwaway folder: an empty folder under your own temporary folder, used as the project folder.
- Command: Not verified: the command form for a ref is to be confirmed before the step runs. This step needs no token.
- Output to paste back: the first line of the output.
- Expected result: Not verified: the command adds the marketplace at the ref you named.

Needs your go-ahead for this step: Marketplace ref in Claude Code.

### Scoped token dashboard steps

- Goal: read the Supabase dashboard steps for a scoped token again, before a release. The steps in `docs/ACCOUNTS.md` are not verified. This step needs no token.
- Throwaway folder: not needed. This is a dashboard step, with no command.
- Command: none. In the Supabase dashboard, open the page for account tokens. The path is ASSUMED, not verified. Note each scope option that the page shows. Do not create or copy a token in this step.
- Output to paste back: the page title, the names of the scope options, and whether the page has a scope option at all. No token value.
- Expected result: Not verified: the page shows scope options that match `docs/ACCOUNTS.md`. If they differ, the page is updated before the next release.

Needs your go-ahead for this step: Scoped token dashboard steps.

## Log

Record each live check you run in this table, with the date. Write the command and the output, without any token. Paste only short output.

| Date | Step | Command | Output (short) | Result |
| --- | --- | --- | --- | --- |

No live check has been run as of 2026-10-23.
