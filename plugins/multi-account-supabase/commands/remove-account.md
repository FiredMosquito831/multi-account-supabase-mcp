---
description: Remove one Supabase account and its stored token, after the owner confirms the name in this chat.
---

Before you give any command, ask the owner in this chat to confirm the name of the account to remove. Repeat the name back to them, and say that its stored token will be deleted from this computer.

Only after the owner confirms that exact name, give them this line to run in a terminal window of their own, with the name in place of `<name>`:

npx -y multi-account-supabase-mcp@0.1.0 remove <name>

The CLI asks in the terminal before it removes the account, and the owner types y there. Without a terminal, the command needs `--yes` after the name.

Say that the Supabase token still works until the owner revokes it in the Supabase dashboard. Do not run the line yourself.
