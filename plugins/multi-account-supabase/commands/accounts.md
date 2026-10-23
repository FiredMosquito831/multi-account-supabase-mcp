---
description: List the Supabase accounts this tool knows, and which one is the default.
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs" list`

Show the list above to the person who uses the plugin. For each account it shows the name, the default mark, the email, and how the account was added (the token kind, pat). No token is shown. Mark the default account in your answer.

If the list says no accounts, say that no account has been added yet. Then tell the person who uses the plugin to add one in a terminal window of their own, with `/multi-account-supabase:add-account` as the guide. Do not ask for a token.
