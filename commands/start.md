---
description: "Start Watchdog in current session"
argument-hint: "PROMPT [--max-iterations N]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup-watchdog.sh:*)"]
hide-from-slash-command-tool: "true"
---

```!
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-watchdog.sh" $ARGUMENTS
```
