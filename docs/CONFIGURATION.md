# Configuration

The tool has no configuration file. Its settings are a few environment variables, and the data folder that they name. The data folder holds the accounts file, the lock files and the agent records.

## Environment variables

| Variable | Used for | Notes |
| --- | --- | --- |
| `MULTI_ACCOUNT_SUPABASE_HOME` | Names the data folder. | When it is set to a folder, that folder is used. A value of empty text counts as not set (`src/paths.ts`). |
| `LOCALAPPDATA` | The data folder on Windows. | When it is empty or not set, the folder `AppData\Local` in your home folder is used (`src/paths.ts`). |
| `XDG_DATA_HOME` | The data folder on macOS, Linux and other systems. | When it is empty or not set, `~/.local/share` is used (`src/paths.ts`). Not verified on macOS or Linux: the rule is tested with fake values only. |
| `SUPABASE_ACCESS_TOKEN` | Read by the official server in each account's child process. | You do not set it. The tool sets it only in the environment of a child process, with that account's token (`src/mux/children.ts`). |

The home folder comes from the operating system when the variables above are empty. On Windows it is the user profile folder (`os.homedir()`).

### How the variable is read

- The commands read `MULTI_ACCOUNT_SUPABASE_HOME` from the environment of the command you run. That includes `install`, `update`, `uninstall` and `doctor` (`src/cli.ts`, `src/install/flow.ts`).
- The server reads it from its own environment when it starts (`src/cli.ts`). The agent starts the server, so the server's environment comes from the agent (ASSUMED, not verified).
- The entries that `install` writes do not set this variable. [SECURITY.md](../SECURITY.md), section 7, describes what an entry holds.
- Whether each agent passes your shell's variables to the server is ASSUMED, not verified. If the variable is set only for the installer, the server uses the default folder. In that case it may find no accounts. See [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Child process environment

Each account's official server runs as a child process. The child's environment is an allowlist (`src/mux/children.ts`):

- Only these names are copied from the tool's environment, and only when they are set: `PATH`, `Path`, `PATHEXT`, `SYSTEMROOT`, `SystemRoot`, `TEMP` and `TMP`.
- The other default names of the SDK are removed.
- The child gets `SUPABASE_ACCESS_TOKEN`, with the token of its own account.
- On Windows, the process start adds eight more names when they are missing (not verified in a live run: whether a child on Windows receives these names). None of them is a credential. See [SECURITY.md](../SECURITY.md), section 3.

## Files and folders

The data folder is the folder named by the rule above. By default it is `%LOCALAPPDATA%\multi-account-supabase-mcp` on Windows (`src/paths.ts`, line 13), and `$XDG_DATA_HOME/multi-account-supabase-mcp` on other systems (`src/paths.ts`, line 17). Not verified on a real system: the rule is tested with fake values only. Each file is listed with what it holds.

| File | What it holds | Source |
| --- | --- | --- |
| `accounts.json` in the data folder | The default name and the account records. No token. | `src/cli.ts` (line 39), `src/install/flow.ts` (line 632) |
| `accounts.json.lock` | The lock held while the accounts change. See the lock section below. | `src/accounts/lock.ts` |
| `accounts.json.<process id>.<random id>.tmp` | A temporary file during a save. It is renamed over `accounts.json`, or removed when the save fails. | `src/accounts/registry.ts` |
| `state/claude.json`, `state/codex.json`, `state/opencode.json`, `state/antigravity.json` | What install wrote, for each agent and each scope. No token. | `src/agents/state.ts` |
| `state/<agent>.json.lock` | The lock held while that record changes. | `src/agents/state.ts`, `src/accounts/lock.ts` |
| The credential store | One token for each account. The service name is `multi-account-supabase-mcp`, and the key is the account name. | `src/secrets/token-store.ts` |

The credential store has not been run on any system. Not verified. The automated tests use a fake store.

Agent configuration files are changed by the installers. Their locations and backups are in [AGENTS.md](AGENTS.md).

## The lock file

The lock file is the accounts file's path with `.lock` added. A change to the accounts takes the lock (`src/accounts/lock.ts`).

- The lock is created only when it does not exist. A second command sees that it exists, and waits.
- The lock file holds one line: a random id and the time. It holds no secret.
- A command that finds the lock held tries again every 100 milliseconds, for up to 60 seconds. After that it stops with `Error: Another multi-account-supabase-mcp command is changing accounts.json. Try again in a moment.`
- A lock file older than 120 seconds is taken over. A command that stopped before it removed the lock leaves one like this.
- When the change ends, the lock is removed. If the lock cannot be removed, the command prints `The lock file could not be removed. It expires two minutes after it was written, and a change waits for it until then.` The change's own result is still shown.
- The state files use the same kind of lock, one for each file.
- The server reads the accounts file without the lock. A save writes a new file and renames it over the old one, so a read sees the old file or the new one.

A save retries a rename that Windows refuses for a moment. It tries 10 times in all, 100 milliseconds apart, when the error is `EPERM`, `EBUSY` or `EACCES`. Other errors are not retried (`src/accounts/registry.ts`).

## Runtime and network

- The package needs Node 22 or newer (`engines` in `package.json`).
- The local runtime used so far is Node 24.6.0 (checked on this machine). Not verified: Node 22.
- The tool itself calls Supabase in one place: the add command asks `https://api.supabase.com` for the profile of the token (`src/supabase/api.ts`).
- The official server, which the tool starts for each account, calls the Supabase Management API for each call (not verified in a live run, and the exact calls are not verified).
- The official server reads the tool list, and the documentation for `search_docs`, from Supabase's docs service. This was read in the official code. Not verified in a live run, and it needs network access.

## Constants in the code

These limits are fixed in the code. There is no setting for them.

- Four accounts run at the same time for a fan-out (`src/mux/fanout.ts`).
- A tool call has a limit of 15 minutes (`src/mux/children.ts`).
- The add command's profile check has a limit of 30 seconds (`src/cli.ts`).
- The official server runs with all nine feature groups (`src/mux/children.ts`).
