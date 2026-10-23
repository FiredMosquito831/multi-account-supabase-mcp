---
description: Remove one Supabase account and its stored token, after the person who uses the plugin confirms the name in this chat.
---

Before you give any command, ask the person who uses the plugin, in this chat, to confirm the name of the account to remove. Repeat the name back to that person, and say that its stored token will be deleted from this computer.

Only after that person confirms that exact name, give that person this line to run in a terminal window of their own, with the name in place of `<name>`:

npx -y multi-account-supabase-mcp@0.1.0 remove <name>

The CLI asks in the terminal before it removes the account, and the person who uses the plugin types y there. Without a terminal, the command needs `--yes` after the name.

Say that the Supabase token still works until the person who uses the plugin revokes it in the Supabase dashboard (not verified against Supabase). Do not run the line yourself.
