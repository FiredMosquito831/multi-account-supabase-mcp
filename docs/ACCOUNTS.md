# Accounts

An account is one Supabase user with one personal access token. You add each account with its own token. A call that names an account uses that account's token. A read with no name uses the default account.

The account list is kept in the accounts file. The tokens are kept in the operating system's credential store (not verified on a real system: the tests use a fake store). No token is kept in the accounts file.

## Account names

A name has 1 to 32 characters. Use lowercase letters, digits and hyphens. The first character must be a letter or a digit.

Names that work: `work`, `client-2`.

Names that are refused:

- `Work`, because it has a capital letter. The message is `Invalid account name "Work". Use 1-32 lowercase letters, digits or hyphens, starting with a letter or digit.`
- `all`, because it is reserved for the account argument. The message is `"all" is reserved. Pick another account name.`
- A name with an underscore, or one that starts with a hyphen.
- A name that already exists. The message is `An account named "<name>" already exists. Remove it first to replace it.` The tool checks this before it asks for a token.
- A name that contains the token prefix, in any letter case. The tool prints a short note and does not repeat the name.

Source: `src/accounts/names.ts`, `src/run.ts`.

## Tokens

Each account has one token.

- The tool does not check what kind of token it is. It accepts a scoped token or a classic token (not verified). It checks the token by asking Supabase for the profile (`src/supabase/api.ts`). It does not read the token's scopes.
- Not verified: whether Supabase accepts a scoped token on that profile call.
- A classic token has all the rights of its user (ASSUMED, not verified).
- Use one token for each account. Use a scoped token when the dashboard offers one, so that the token can do less (ASSUMED, not verified). Not verified: which scopes the dashboard offers.
- The steps to create a token are not verified. The page is expected under the account settings of the Supabase dashboard (ASSUMED, not verified: the path `/dashboard/account/tokens`). Check the steps before you rely on them.

## Adding an account

Run this in a terminal window:

```
multi-account-supabase-mcp add work --pat
```

The command shows a prompt, and you type the token. Nothing you type is shown (not verified: hidden input in a real terminal window). Press Enter when you are done. The reader is tested with fake input only.

The command does these steps, in this order:

1. It checks the name, and it checks that the name is free. Both happen before the prompt.
2. It reads the token from the prompt. Spaces at the start and end are removed.
3. It asks Supabase for the profile of the token (`GET /v1/profile`). The request has a 30-second limit (`src/cli.ts`, `src/supabase/api.ts`).
4. It refuses the account if the same Supabase user is already added under another name.
5. It stores the token in the credential store, and then it saves the record.
6. If the save fails, it removes the stored token again.

Piped input is refused. Run the command in a terminal. Source: `src/run.ts` (`addCommand`), `src/accounts/add-account.ts`.

Never paste a token into a chat. Type it in your own terminal.

### The profile check

The check expects three fields in the reply: the Supabase user id (`gotrue_id`), the email (`primary_email`) and the username. A reply with another shape is refused with `Unexpected response from Supabase /v1/profile.` (`src/supabase/api.ts`).

The field names were read from the official package's schema. No live call has been made. The real reply is not verified.

## The default account

- The first account you add becomes the default. A later add keeps the default as it is (`src/accounts/registry.ts`).
- `default <name>` changes the default.
- Removing the default account leaves no default. The tool does not pick another account for you.
- A read with no `account` value uses the default account. A change with no `account` value is refused. A change always needs a name.
- With no default, `list` says so, and a read with no name is refused (`src/mux/routing.ts`).

## The accounts file

The file holds the default name and, for each account, these fields:

- `name`
- `email`
- `gotrueId`, the Supabase user id
- `added`, which is `pat` for now
- `addedAt`, the time the account was added

It holds no token. The shape looks like this. The values are placeholders:

```json
{
  "default": "work",
  "accounts": [
    {
      "name": "work",
      "email": "<email address>",
      "gotrueId": "<Supabase user id>",
      "added": "pat",
      "addedAt": "<time>"
    }
  ]
}
```

The file's location is in [CONFIGURATION.md](CONFIGURATION.md).

When the file is read, these checks apply (`src/accounts/registry.ts`):

- Each name follows the name rule.
- No two accounts share a name, and no two share a Supabase user id.
- The default must name an account, or be empty.
- A file that cannot be read, is not valid JSON, or has another shape is refused. The error names the file and the reason only, such as `EACCES`, `not valid JSON` or `unexpected contents`. It never shows the file's content.
- A file that does not exist counts as an empty list.

If you edit the file by hand, keep to this shape. The server reads the file before each call, so a change takes effect at the next call (`src/cli.ts`).

## Removing an account

`remove <name>` deletes the account record and the token stored on this machine. In a terminal it asks first. See [USAGE.md](USAGE.md).

- The Supabase token still works after `remove` (not verified). It stays valid until you revoke it in your Supabase account settings (not verified). Not verified against Supabase. The tool has no command that revokes a token.
- A running server stops using the account at its next call. The server closes the account's child process when the list of accounts changes (`src/mux/server.ts`).
- If the stored token cannot be deleted, `remove` says so and prints the command to run again.
- A name with no record but with a stored token can still be removed. This covers an add that could not remove its own token (`src/run.ts`, `removeCommand`).

## What the tool does not show

- A token is never printed. It is never written to the accounts file or to a log.
- `list` and `account_list` show the name, the email and the kind of token. They never show a token.
- Each account's child process gets only that account's token. See [SECURITY.md](../SECURITY.md), section 3.
