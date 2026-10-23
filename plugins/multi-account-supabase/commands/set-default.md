---
description: Make one Supabase account the default, for the calls that name no account.
---

A read that names no account uses the default account. A change must always name its account.

Ask the owner which account to make the default, and use the name they give you. If they do not know the names, point them to `/multi-account-supabase:accounts`.

Then give the owner this line to run in a terminal window of their own, with the name in place of `<name>`:

npx -y multi-account-supabase-mcp@0.1.0 default <name>

Do not run the line yourself.
