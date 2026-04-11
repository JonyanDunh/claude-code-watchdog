---
description: "Start Watchdog in current session"
argument-hint: "PROMPT [--max-iterations N]"
allowed-tools: ["Bash(node:*)"]
hide-from-slash-command-tool: "true"
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-watchdog.js" $ARGUMENTS
```
