---
description: "Start Watchdog in current session"
argument-hint: "\"<PROMPT>\" [--max-iterations N]"
allowed-tools: ["Bash(node:*)"]
disable-model-invocation: true
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-watchdog.js" $ARGUMENTS
```
