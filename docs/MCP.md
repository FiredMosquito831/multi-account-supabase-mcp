# MCP server

The server speaks MCP over stdio. An agent starts it with `multi-account-supabase-mcp serve`, or with no command when no terminal is attached. Stdout carries the protocol. Every log line goes to stderr (`src/cli.ts`, `src/serve.ts`).

The server offers the official tools, with their official names and parameters. It adds one argument, `account`, and one tool, `account_list`. The list of official tools is the saved list described below.

## Tools

With no account, the server lists one tool: `account_list`. Its description says that no Supabase accounts are set up, and how to add one. No official child starts in this case (`src/mux/server.ts`).

With at least one account, the list has 35 entries:

- The 34 official tools. The saved list in `test/fixtures/official-tools.json` holds 34 tools. It was captured from the official package on 2026-10-20 with `scripts/capture-official-tools.mjs`.
- `account_list`.

Each official tool has the `account` argument, except `search_docs`. Each description ends with one paragraph that says how the account argument works for that tool. The paragraph depends on the tool's mode (`src/mux/catalog.ts`).

The read-only query tool is not listed. The code has it switched off (`src/mux/policy.ts`, `src/mux/server.ts`). It is listed only after a live check shows that the API refuses a write sent through it. Not verified: whether the API enforces read-only for this call. The planned name is `execute_sql_readonly`. The name may change before the tool ships.

## The account argument

The `account` argument takes one of three forms:

- One name, such as `work`.
- A comma-separated list of names, such as `work,client-2`.
- `all`, which means every account.

If the argument is missing or blank, a read uses the default account. A change is refused (see below). The rules are in `src/mux/routing.ts`.

Errors from the argument:

- An unknown name: `Unknown account: <name>. Known accounts: <names>.` A list with several unknown names gives `Unknown accounts: <names>. Known accounts: <names>.`
- An empty item in a list: `account has an empty name in its list.`
- A value that is not text: `account must be a string: one name, comma-separated names, or "all".`
- No default account, and no name given for a read: `No default account is set. Pass account as one of: <names>, or "all".`

`search_docs` runs on its own child process and takes no account. An `account` value sent with it is removed before the call, and it is not checked (`src/mux/server.ts`). The call is still refused when no account exists.

## Modes

Each official tool has a mode. The table is in `src/mux/policy.ts`. The table has one entry per tool name. A tool that the table does not name is mode `one`.

| Mode | Tools | What the server does |
| --- | --- | --- |
| `none` | `search_docs` | Runs on a placeholder child process. It uses no account. |
| `all` | `list_organizations`, `list_projects` | Reads on each named account. A blank argument uses the default account. The result has one entry for each account. |
| `locate` | `get_organization`, `get_project`, `list_branches`, `list_tables`, `list_extensions`, `list_migrations`, `query_logs`, `get_advisors`, `get_project_url`, `get_publishable_keys`, `generate_typescript_types`, `list_edge_functions`, `get_edge_function`, `list_notebooks`, `get_notebook`, `list_storage_buckets`, `get_storage_config` | Reads by id. Each named account is asked. Only the account that owns the id answers. The others are listed in `notFoundIn`. |
| `one` | `create_project`, `pause_project`, `restore_project`, `create_branch`, `delete_branch`, `merge_branch`, `reset_branch`, `rebase_branch`, `apply_migration`, `deploy_edge_function`, `update_storage_config`, `execute_sql`, `get_cost`, `confirm_cost` | A change. It needs one named account, and a list or `all` is refused. `execute_sql` can change data, so it has this mode. `get_cost` and `confirm_cost` are in this mode too. |

The counts are 1, 2, 17 and 14, which is 34.

A tool in mode `one` runs on the writable child process of one account. The modes `all` and `locate` run on the read-only child process of each account. The mode `none` runs on the placeholder child process (`src/mux/children.ts`, `src/mux/official-child.ts`). Not verified in a live run: that the official `--read-only` flag makes the child read-only.

## Results

One account:

- The official result is returned unchanged, including its error flag.

Several accounts, read tools only:

- The result is one JSON text. It has two keys, `accounts` and `notFoundIn`.
- `accounts` has one entry for each account that answered. An entry is `{ "ok": true, "result": ... }` or `{ "ok": false, "error": "..." }`.
- `notFoundIn` lists the accounts that do not have the id. It is always an empty list for the tools of mode `all`.
- The result is marked as an error only when every account failed. A missing id is not a failure.

A lookup where no account owns the id returns one line, marked as an error: `Not found in any account: <names>.` A miss is told apart from a failure by the error flag and the not-found text together (`src/mux/server.ts`).

A failed account does not hide the others. Up to four accounts run at the same time (`src/mux/fanout.ts`).

## Refusals

These refusals happen before any official child process starts:

- A change with no `account` value. The text is `"<tool>" runs on one account only, because it can change data or is not classified yet. Name one account, for example account: "<name>".` The example is the default account, or the first account when there is no default.
- A change with a list, or with `all`. The text is the same.
- A tool name that the server does not know, when an account is named. The text is `Unknown tool "<name>".`
- Any call when no account exists, except `account_list`. The text is `No Supabase accounts are set up yet. Run in a terminal: multi-account-supabase-mcp add <name> --pat`. A change with no `account` value also gets the sentence above, before this text. A change that names an account, a list or `all` gets this text alone.

A call to an account with no stored token is refused with `No token is stored for the account "<name>". Run multi-account-supabase-mcp remove <name>, then add the account again with --pat in a terminal.` (`src/serve.ts`).

## Limits

- A tool call has a limit of 15 minutes. The text is `Supabase did not answer in time (limit: 15 minutes).`
- A change that hits the limit gets one more sentence: `The change may still have happened. Check before you retry.` The official call may have run after the server stopped waiting.
- If an official child process does not start, the text is `The server for account "<name>" did not start. Check that its token is still valid and that the network is reachable.` (`src/mux/children.ts`).

## Child processes

- Each account has a read-only child process, for reads, and a writable child process, for changes. They start on the first call that needs them, and they are restarted if they stop (`src/mux/children.ts`).
- The tool list comes from a catalog child process. It starts, lists the tools and stops. The server keeps the list for its whole life. A failed read is tried again at the next call (`src/mux/server.ts`).
- The catalog child and the `search_docs` child start with a placeholder value in place of a token. The placeholder is not a real token. Not verified in a live run: that the official server lists its tools with the placeholder value.
- Each child is started with all nine feature groups (`src/mux/official-child.ts`).

## Changes while the server runs

The server reads the accounts file before each call. When the list of accounts changes, it does two things (`src/mux/server.ts`):

- It closes the account child processes. A removed account stops at the next call. A re-added account starts with its new token.
- It tells the client that the tool list changed. A client that supports this notice reads the list again (not verified: no real client was run). Another client may need a new session to see the new list (not verified: no real client was run).

A change of the default account alone sends no notice.

## Not verified

- The MCP protocol version that a client uses. The SDK chooses the version from the first message. Not verified with a real client.
- The behaviour of the tools in a real client. None was run.
- The official server's behaviour in a live run. No live call has been made. Each point about the official server that this file marks as not verified is still open.

Related pages: [ACCOUNTS.md](ACCOUNTS.md) for the accounts, [SAFETY.md](SAFETY.md) for what each tool can change, and [USAGE.md](USAGE.md) for the commands.
