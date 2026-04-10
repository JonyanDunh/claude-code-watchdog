---
description: "Explain Watchdog plugin and available commands"
---

# Watchdog Plugin Help

Please explain the following to the user in clear, friendly language. Do not dump the markdown verbatim — synthesize and present it.

## What is Watchdog?

Watchdog is a self-referential loop for Claude Code. You give it a prompt once, and it re-feeds that same prompt to Claude after every turn until the task genuinely stops producing file edits. The agent is not told a loop is running, so it cannot fake a completion signal to escape early.

**This is the 1.1.0 Node.js rewrite** — no bash, no jq, no POSIX dependencies. Runs natively on Linux, macOS, and Windows, with `node` as the only runtime requirement.

**Core mechanic:**

1. You run `/watchdog:start "<prompt>" [--max-iterations N]`
2. Claude works on the task, modifying files
3. Claude's turn ends — the Stop hook intercepts
4. A headless Claude Haiku classifier inspects every tool invocation from that turn and decides: did any of them directly modify a project file?
5. If yes → re-feed the original prompt as a new user turn, loop continues
6. If no (or `--max-iterations` reached, or `/watchdog:stop` invoked) → exit cleanly

The "self-reference" means each iteration sees the previous iteration's file edits and git state, so Claude builds on its own prior work without any external orchestrator.

## Why the Haiku classifier?

Instead of a hard-coded tool-name whitelist (which misses `Bash(sed -i …)`, MCP SQL writes, and other indirect mutations), Watchdog asks a headless Haiku instance to read every tool invocation's full input and judge semantically whether a project file was modified. The verdict is a single token: `FILE_CHANGES` or `NO_FILE_CHANGES`. Side effects that don't touch project files — running containers, remote DB writes, network calls — are correctly ignored.

## Available commands

### `/watchdog:start "<PROMPT>" [--max-iterations N]`

Start a Watchdog in the current session.

**Usage:**

```
/watchdog:start "Refactor services/cache.ts to use the new API. Iterate until pnpm test:cache passes." --max-iterations 20
/watchdog:start "Add tests for auth.ts until coverage hits 80%."
```

**Options:**

- `--max-iterations <n>` — safety cap, loop exits after N iterations no matter what. Recommended: 20.

**Behavior:**

1. Creates `.claude/watchdog.<TERM_SESSION_ID>.local.json` as the per-session state file
2. Claude works on the task
3. On turn end, the Stop hook runs the Haiku classifier
4. If files were modified, the original prompt is re-fed as a new user turn
5. Loop continues until convergence, max iterations, or `/watchdog:stop`

### `/watchdog:stop`

Cancel an active Watchdog in the current session. Removes the state file so the Stop hook stops re-feeding the prompt.

### `/watchdog:help`

Show this reference.

## Exit conditions

The loop exits when **any** of these is true:

- The Haiku classifier judges a turn made no project-file changes (convergence)
- `--max-iterations` is reached
- `/watchdog:stop` is invoked
- The state file is manually removed

A pure-text turn (no tool calls at all) never exits the loop — the agent must actually invoke tools, so it cannot claim completion from memory without doing real verification work.

## Per-session isolation

The state file is keyed by `TERM_SESSION_ID` (the UUID your terminal emulator exports), so two Watchdogs running in two terminal tabs of the same repo do not collide.

## Requirements (1.1.0)

| Requirement | Why |
| --- | --- |
| **Claude Code 2.1+** | Uses the Stop hook system and marketplace plugin format |
| **`node`** in `PATH` | All hook and setup logic is JavaScript, runs on Node 18+. Built-in `--test` runner is used for the test suite. |
| **`claude` CLI** in `PATH` | Used for the headless Haiku classification call. Must be authenticated. |
| **`TERM_SESSION_ID`** env var | Keys the per-session state file. If your terminal doesn't export one, run `export TERM_SESSION_ID=$(node -e "console.log(require('crypto').randomUUID())")` before launching `claude`. |

**No bash. No jq.** This version runs natively on Windows PowerShell / cmd.

## Prompt writing tips

- **Clear completion criteria** — "no more edits needed" must be a verifiable answer, not subjective. Tie it to passing tests, a clean typecheck, zero lint errors, etc.
- **Incremental verifiable goals** — if there's no verifiable end state, the loop will just spin.
- **Self-correcting structure** — tell Claude how to notice failure and adapt.
- **Always set `--max-iterations`** — even if the Haiku classifier is reliable, a stuck agent should fall through to a hard stop.

## Learn more

Full documentation and translations in 7 languages: https://github.com/JonyanDunh/claude-code-watchdog
