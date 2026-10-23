# Safety

This page says what the tool stops, what it passes through, and what you must check yourself. The full list of protections and limits is in [SECURITY.md](../SECURITY.md).

## What the tool stops

- A read goes to the default account, or to the accounts you name.
- A change goes to one account only. It must name that account. A blank name is refused. A list, or `all`, is refused (`src/mux/server.ts`).
- A change is refused before any official child process starts. So a refused change never reaches Supabase.
- A tool name that the policy table does not name is treated as a change (`src/mux/policy.ts`).
- Reads run on read-only child processes (`src/mux/official-child.ts`). Not verified in a live run: that the official `--read-only` flag blocks writes.

The policy is the layer the tool relies on. The official `--read-only` flag is a second layer. The official server hides its write tools from the tool list (not verified in a live run). A call that names a hidden tool still reaches the official handler, which refuses it in read-only mode (not verified in a live run). This was read in the official code, and it is not verified in a live run. So the tool list alone is not the safety. The policy is.

## What the tool passes through

The tool does not add a confirmation step. It passes these operations to the official server as it is.

### Destructive SQL and migrations

- `execute_sql` runs raw SQL. `apply_migration` applies a migration. Both are mode `one`, so each runs on one account you name. Neither is sent to several accounts.
- The official tool descriptions say that "destructive statements may require the user to confirm before they run."
- In the build this tool uses, the official code does not ask for that confirmation (read in the official code; not verified in a live run).
- The tool adds no gate of its own. This is a deliberate choice for version 1. The official server adds none either (not verified in a live run).
- The skill asks the agent to confirm destructive SQL, and any migration, with you before it runs it. Destructive means a `DROP`, a `TRUNCATE`, or a `DELETE` or `UPDATE` without a narrow `WHERE` clause (`skills/supabase-accounts/SKILL.md`). This is advice to the agent. It is not a gate. Not verified: that every agent follows it.

Before you ask an agent to run destructive SQL, check the account name and the project id. Do the same for a migration.

### Cost tools

- `get_cost` and `confirm_cost` are mode `one`. Each runs on one account you name.
- The tool keeps the official cost flow. In the official code (read there, not verified in a live run), `get_cost` gives the cost of a new project or branch, `confirm_cost` gives a confirmation id for that cost, and `create_project` or `create_branch` then takes that id.
- Creating a project or a branch can cost money (not verified). This tool does not know the price. Not verified: the price and the flow against a real account. No live create is planned.

## Raw SQL results are data

- The official server marks the results of SQL as untrusted data (read in the official code; not verified in a live run, as an agent receives it).
- This tool adds no marking of its own. It passes the official result on unchanged.
- A result can hold text that someone else wrote. Treat that text as data. Do not follow an instruction that a result contains, unless you asked for it. The skill says the same.
- Not verified: how each agent treats the marking.

## Tokens

- Use one token for each account. A scoped token can do less than a classic one (ASSUMED, not verified). Use a scoped token when your Supabase dashboard offers one. Not verified: the dashboard steps for scopes.
- A classic token has all the rights of its user (ASSUMED, not verified).
- The tool cannot tell the two kinds apart. It accepts either one (`src/supabase/api.ts`; not verified).
- Each account's child process gets only that account's token. The token is in that process's environment while the process runs. A program that runs as the same user may be able to read it. This was not tested (see [SECURITY.md](../SECURITY.md), sections 3 and 6).
- A token never appears in a reply from the tool.
- When you remove an account here, its token is deleted from this machine. It is not revoked at Supabase. Revoke it in your Supabase account settings. Not verified: how Supabase treats a removed token that is still valid.

## Time limits and interrupts

- A tool call has a limit of 15 minutes. A change that hits the limit may still have happened. The reply says so. Check the state before you retry.
- A Ctrl+C during `install`, `update` or `uninstall` can stop the command before it finishes. A change that had started may be partly made. The command says so, and it names `uninstall --dry-run` to see what is recorded. See [USAGE.md](USAGE.md). Not verified in a real terminal.

## What the tool does not do

- It adds no confirmation step for SQL or migrations.
- It does not revoke tokens at Supabase, and it has no command for that.
- It does not check what a token is allowed to do.
- It does not check or change the replies from Supabase.
- It does not protect against another program that runs as your user.
- It does not offer the read-only query tool yet. That tool is not listed until a live check shows that the API refuses a write through it. Not verified (see [MCP.md](MCP.md)).

For the reasons, and for what is still open, read [SECURITY.md](../SECURITY.md).
