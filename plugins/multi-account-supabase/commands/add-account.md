---
description: Guide the person who uses the plugin through adding a Supabase account. The token is typed in a terminal, never in this chat.
---

Explain these steps to the person who uses the plugin, in plain words:

1. In the Supabase dashboard, create an access token for this account. Use one token per account, and scope it if the dashboard offers scopes. The exact dashboard steps are not verified yet, so say so, and point to the README.
2. Choose a name for the account. The name is for that person to choose.
3. Open a terminal window of your own, not this chat, and run this line, with the name in place of `<name>`:

   npx -y multi-account-supabase-mcp@0.1.0 add <name> --pat

4. The command asks for the token. The typing is hidden (not verified: the hidden input has not been checked in a real terminal). Enter the token there, then press Enter.

The token is typed in that terminal, hidden (not verified: the hidden input has not been checked in a real terminal), and never in this chat. Do not ask the person who uses the plugin for a token, and do not read one.

If the person who uses the plugin pastes a token into this chat anyway, do not use it and do not repeat it. Tell that person to revoke that token in the Supabase dashboard, and to add the account again in a terminal window.
