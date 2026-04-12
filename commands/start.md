---
description: "Start Watchdog in current session"
argument-hint: "\"<PROMPT>\" | --prompt-file <path> [--watch-prompt-file] [--exit-confirmations N] [--no-classifier] [--max-iterations N]"
allowed-tools: ["Bash(node:*)"]
disable-model-invocation: true
---

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-watchdog.js" $ARGUMENTS
```
