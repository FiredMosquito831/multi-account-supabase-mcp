---
description: Check the recorded paths, the agents, and each account's stored token. Shows no token.
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/bin/launch.mjs" doctor`

Show the result above to the owner. Then explain each line in plain words: what was checked, and whether it is fine or needs a fix.

Say that this output never shows a token value. If a line names a fix, give the owner that fix as the line to run in a terminal window of their own. Do not run a fix yourself.
