# Security

This file says what multi-account-supabase-mcp protects, how it handles tokens, what the official server receives, what the agent can see, and what it does not protect.

## 1. Scope

The tool protects two things: the Supabase personal access token of each account, and the accounts file.

It is for one person on one machine. It protects the tokens in these ways:

- A token is never printed.
- A token is never written to the accounts file.
- A token is never sent to a child process other than the one for its own account.
- A token is never put in a reply to the agent.

It does not protect against a program that runs as the same user. See section 6.

## 2. How the token is handled

- The token is typed into a terminal window, with hidden input. The prompt is written to stderr. The tests read the typed input through a fake, so the hidden input has not been checked in a real terminal window.
- The token is never printed. If the add command fails, the typed token is removed from the message and from the cause of the error before anything is shown.
- The token is never written to the accounts file. The file holds five fields for each account: the name, the email, the Supabase user id, how the account was added, and the time it was added.
- The token is stored in the operating system's credential store, through the `@napi-rs/keyring` package. Each account has one entry, under the service name `multi-account-supabase-mcp`, with the account name as the key. The real credential store has not been run on any system. The automated tests use a fake store.
- A command line that has text containing `sbp_` in any letter case is refused with exit code 2. The text is never printed. The tool treats text with `sbp_` as the shape of a token. This applies to every command, and to every argument.
- When the accounts file cannot be read, or does not have the expected shape, the error names the file and the reason only. The reason is a system error code, such as `EACCES`, or one of three fixed phrases: `read failed`, `not valid JSON` or `unexpected contents`. The error never shows the file's content.

## 3. What the child processes receive

Each account has an official server running as a child process. Each child gets only the token of its own account. The token is given in the environment variable that the official server reads, `SUPABASE_ACCESS_TOKEN`.

The child environment is an allowlist. Only these names are copied from the parent, and only when the parent has them: `PATH`, `Path`, `PATHEXT`, `SYSTEMROOT`, `SystemRoot`, `TEMP` and `TMP`. Every other name in the SDK's default list is not passed to the child, except the Windows names in the next part. On macOS and Linux, that list includes `HOME`, `LOGNAME`, `SHELL`, `TERM` and `USER`. Those names are not passed on macOS and Linux. This was read in the code. It was not run there.

The placeholder child, which serves `search_docs`, and the catalog child, which lists the tools, get a fixed placeholder value. The placeholder is not a real token. An account child never gets the placeholder. With no account registered, neither child starts, because every call except `account_list` is refused first.

On Windows, the process start adds eight system variables back when they are missing from the environment given to a child:

- `HOMEDRIVE`
- `HOMEPATH`
- `LOGONSERVER`
- `SYSTEMDRIVE`
- `USERDOMAIN`
- `USERNAME`
- `USERPROFILE`
- `WINDIR`

None of them is a credential. This was checked on Windows by running a child process with the environment that the code builds. Only the variable names were read.

The token of an account is also in the environment of its child process while that process runs. The official server reads it from there. Whether another program running as the same user can read a process's environment has not been tested.

## 4. What the agent can see

- The agent receives every reply from Supabase, as the official server returns it. This tool does not filter or redact those replies. A reply can contain any data that Supabase returns, for example the result of a SQL query.
- The tool never puts an account token in a reply.
- The agent sees the account names and emails in `account_list`. With accounts, the description of the `account` argument lists the known names.
- The tool refuses a call that names no account for a change. It refuses a change that names several accounts. A read that names several accounts runs on each of them, and the replies come back together in one document.

## 5. Removing an account and revocation

`remove <name>` deletes the account record and the token stored on this machine. It does not revoke the token at Supabase. The Supabase token still works until you revoke it in your Supabase account settings. Not verified against Supabase. The tool has no command that revokes a token.

See the README section "Removing an account".

## 6. Known limits

- A program that runs as the same user may be able to read the credential store, and the environment of a child process. This is how operating systems normally work. It has not been tested here.
- A token that Supabase has revoked is found only when a call uses it. Not verified: what Supabase returns for a revoked token. The add command checks the token once, when the account is added.
- In the official build that this tool uses, destructive SQL and `apply_migration` run without a confirmation step. This tool adds no gate of its own. This was read in the official build's code. It was not checked with a live call.
- An accounts file that is edited by hand can name accounts. The tool still needs a stored token for each one. An account with no stored token is refused, and no child is started for it.
- A change that times out may still have run at Supabase. The reply says so.
- The continuous integration on Ubuntu is not set up yet.

## 7. Reporting a problem

The project is not published yet. To report a suspected security problem, contact the maintainer of this copy directly. Do not send a token, or a file that holds a token, in any message.
