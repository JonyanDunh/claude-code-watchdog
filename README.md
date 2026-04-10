English | [中文](./README.zh.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [Tiếng Việt](./README.vi.md) | [Português](./README.pt.md)

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.0.0-green.svg)](./.claude-plugin/plugin.json)
[![GitHub stars](https://img.shields.io/github/stars/JonyanDunh/claude-code-watchdog?style=flat&color=yellow)](https://github.com/JonyanDunh/claude-code-watchdog/stargazers)
[![Inspired by ralph-loop](https://img.shields.io/badge/Inspired%20by-ralph--loop-orange.svg)](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop)

> **Watch the agent. Catch the lies. Stop only when the work is actually done.**

_A Claude Code plugin that keeps the current agent in a self-referential loop inside a single session and refuses to let it quit until the task genuinely stops producing file edits — no "completion flag", no way for the agent to cheat its way out._

[Quick Start](#quick-start) • [Why Watchdog?](#why-watchdog) • [How It Works](#how-it-works) • [Commands](#commands) • [Installation](#installation) • [Inspired By](#inspired-by)

---

## Core Maintainer

| Role | Name | GitHub |
| --- | --- | --- |
| Creator & Maintainer | Jonyan Dunh | [@JonyanDunh](https://github.com/JonyanDunh) |

---

## Quick Start

**Step 1: Install**

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

**Step 2: Verify**

```bash
/watchdog:help
```

**Step 3: Start a watchdog**

```bash
/watchdog:start "Fix the flaky auth tests in tests/auth/*.ts. Keep iterating until the whole suite passes." --max-iterations 20
```

That's it. Watchdog re-feeds your prompt after every turn until Claude either:

- finishes a turn without modifying any file, **or**
- hits the `--max-iterations` safety cap, **or**
- you manually run `/watchdog:stop`.

Everything else is automatic. The agent never knows a loop is running.

---

## Why Watchdog?

- **Zero agent cheating** — The agent is never told it is inside a loop. No `systemMessage`, no iteration counter, no setup banner. It cannot short-circuit by emitting a fake completion signal.
- **Forced tool verification** — A pure-text turn ("I've checked, all good") never ends the loop. The agent **must** actually invoke a tool before exit is even considered.
- **LLM-judged, project-aware file-change detection** — A headless `claude -p --model haiku` call is the **sole** judge of "did this turn modify any project file". It sees every tool invocation's full input and decides semantically.
- **Per-session isolation** — State file keyed by `TERM_SESSION_ID`, so running multiple watchdogs in different terminal tabs never collide.
- **Hidden by design** — All diagnostic output goes to stderr. The JSONL transcript never leaks loop metadata into the agent's context.
- **Apache 2.0** — Cleanly derived from Anthropic's own `ralph-loop` plugin, with full attribution in [NOTICE](./NOTICE).

---

## How It Works

You run the command **once**, then Claude Code handles the rest:

```bash
# You run ONCE:
/watchdog:start "Your task description" --max-iterations 20

# Then Claude Code automatically:
# 1. Works on the task
# 2. Tries to exit
# 3. Stop hook blocks the exit and re-feeds the SAME prompt
# 4. Claude iterates on the same task, seeing its own previous edits
# 5. Repeat until a turn finishes without modifying any project file
#    (or --max-iterations is reached)
```

The loop happens **inside your current session** — no external `while true`, no orchestrator process. The Stop hook in `hooks/stop-hook.sh` blocks normal session exit and re-injects the prompt as a new user turn using Claude Code's native `{"decision": "block", "reason": ...}` protocol.

This creates a **self-referential feedback loop** where:
- The prompt never changes between iterations
- Claude's previous work persists in files
- Each iteration sees modified files and git history
- Claude autonomously improves by reading its own past work

### Exit Conditions

The loop exits when **both** of these are true for the latest assistant turn:

| Check | Requirement |
| --- | --- |
| **Tool usage precondition** | The turn must have invoked at least one tool. Pure-text turns never exit. |
| **Haiku classifier verdict** | A headless `claude -p --model haiku` call returns `NO_FILE_CHANGES`. The classifier reads every tool invocation's full input and decides semantically whether the turn directly modified any project file. |

If either check fails, the loop continues. Additional exit paths:

- `--max-iterations` reached (hard cap, always respected)
- User runs `/watchdog:stop` (removes the state file)
- State file manually removed from disk

---

## Commands

| Command | Effect | Example |
| --- | --- | --- |
| `/watchdog:start <PROMPT> [--max-iterations N]` | Start a watchdog in the current session | `/watchdog:start "Refactor services/cache.ts. Iterate until pnpm test:cache passes." --max-iterations 20` |
| `/watchdog:stop` | Cancel the watchdog in the current session | `/watchdog:stop` |
| `/watchdog:help` | Print the full reference inside Claude Code | `/watchdog:help` |

---

## State File

Per-session state lives at `.claude/watchdog.<TERM_SESSION_ID>.local.json`:

```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 20,
  "term_session_id": "c387e44a-afcd-4c0d-95da-5dc7cd2d8b22",
  "started_at": "2026-04-10T12:00:00Z",
  "prompt": "Fix the flaky auth tests..."
}
```

Each session has its own file, keyed by `TERM_SESSION_ID`. Running multiple watchdogs in different terminal tabs works without conflict.

**Monitor active watchdogs:**

```bash
# List all active per-session state files in this project
ls .claude/watchdog.*.local.json

# Current iteration of a specific session
jq .iteration .claude/watchdog.<SESSION_ID>.local.json

# Full state
jq . .claude/watchdog.<SESSION_ID>.local.json
```

**Manually kill everything in this project:**

```bash
rm -f .claude/watchdog.*.local.json
```

---

## Installation

### Primary: marketplace install (recommended)

```bash
/plugin marketplace add https://github.com/JonyanDunh/claude-code-watchdog
/plugin install watchdog
/reload-plugins
```

Verify with `/watchdog:help`.

### Alternative: single-session local load

To try Watchdog without touching your global config, load it for one session only:

```bash
claude --plugin-dir /absolute/path/to/claude-code-watchdog
```

### Alternative: manual install via `settings.json`

For CI/CD, corporate deployments, or offline use, clone the repo and wire it up manually in `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "claude-code-watchdog": {
      "source": {
        "source": "directory",
        "path": "/absolute/path/to/claude-code-watchdog"
      }
    }
  },
  "enabledPlugins": {
    "watchdog@claude-code-watchdog": true
  }
}
```

Then run `/reload-plugins` inside Claude Code.

---

## Hiding the Loop From the Agent

By design, **the agent must not know it is inside a loop**. If it knew, it would be tempted to short-circuit by claiming completion from memory on the first turn. Watchdog enforces this by:

- **No `systemMessage`** emitted from the Stop hook — no iteration counter, no status banner.
- **Setup script writes only the user's prompt to stdout** — no "Loop activated, iteration 1" header, no initialization output the agent would see.
- **Re-fed prompt is the original text + a single verification reminder**, in plain English:

  > Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.

- **All diagnostics go to stderr (`>&2`)** — Claude Code's transcript does not capture them as agent context.

From the agent's point of view, the same user is asking the same question over and over, occasionally adding "please actually re-run the checks". There is no visible Stop hook, no iteration counter, no loop metadata. The agent cannot cheat what it does not know exists.

---

## Prompt Writing Best Practices

### 1. Clear Completion Criteria

Write the prompt so "no more edits needed" is a genuine, verifiable answer.

❌ Bad: "Build a todo API and make it good."

✅ Good:

```markdown
Build a REST API for todos in `src/api/todos.ts`.

Requirements:
- All CRUD endpoints working
- Input validation in place
- 80%+ test coverage in `tests/todos.test.ts`
- All tests pass with `pnpm test`
```

### 2. Incremental, verifiable goals

The loop exits on "no files modified". If your task has no verifiable end state, it will just spin.

✅ Good:

```markdown
Refactor `services/cache.ts` to remove the legacy LRU implementation.

Steps:
1. Delete the old LRU class and its tests
2. Update all callers in `src/` to use the new cache API
3. Run `pnpm typecheck && pnpm test:cache` after each change
4. Iterate until both pass without warnings
```

### 3. Self-correcting structure

Tell the agent how to notice failure and adapt.

```markdown
Implement feature X using TDD:
1. Write failing tests in tests/feature-x.test.ts
2. Write minimum code to pass
3. Run `pnpm test:feature-x`
4. If any test fails, read the failure, fix, re-run
5. Refactor only after all tests are green
```

### 4. Always set `--max-iterations`

The Haiku classifier is not infallible. A stuck agent that keeps making meaningless edits, or one that gets confused and stops editing prematurely, should fall through to a hard stop. `--max-iterations 20` is a reasonable default.

---

## When to Use Watchdog

**Good for:**

- Tasks with clear, automated success criteria (tests, lints, typechecks)
- Iterative refinement: fix → test → fix → test
- Greenfield implementations you can walk away from
- Systematic code review with fixes

**Not good for:**

- Tasks requiring human judgment or design decisions
- One-shot operations (a single command, a single file edit)
- Anything where "done" is subjective
- Production debugging that needs external context

---

## Requirements

| Requirement | Why |
| --- | --- |
| **Claude Code 2.1+** | Uses the Stop hook system and marketplace plugin format |
| **`bash`** in `PATH` | All hook and setup logic is written in POSIX bash. Native Windows (PowerShell / cmd) is **not supported** — use WSL2 or Git Bash |
| **`jq`** in `PATH` | Used by the Stop hook to parse transcript JSONL and state file JSON |
| **`claude` CLI** in `PATH` | Used for the headless Haiku classification call. Must be authenticated (OAuth or `ANTHROPIC_API_KEY`) |
| **`TERM_SESSION_ID`** env var | Keys the per-session state file. Set by most terminal emulators (iTerm2, WezTerm, modern Linux terminals). Workaround if unset: `export TERM_SESSION_ID=$(uuidgen)` before launching `claude`. |

### Install dependencies

**macOS (Homebrew):**

```bash
brew install jq
# bash is already present; for newer bash 5.x: brew install bash
# claude CLI: see https://docs.anthropic.com/claude-code
```

**Debian / Ubuntu / WSL2:**

```bash
sudo apt update
sudo apt install -y bash jq uuid-runtime
# claude CLI: see https://docs.anthropic.com/claude-code
```

**Fedora / RHEL:**

```bash
sudo dnf install -y bash jq util-linux
```

**Arch / Manjaro:**

```bash
sudo pacman -S --needed bash jq util-linux
```

**Windows:**

Native Windows (PowerShell / cmd) is **not supported** — the plugin is entirely bash scripts and the Stop hook registration assumes a POSIX shell in `PATH`. Your two options:

- **WSL2 (recommended)** — run Claude Code inside a WSL2 distro. Everything Just Works.
- **Git Bash (experimental)** — install [Git for Windows](https://git-scm.com/download/win) which bundles bash, then install `jq` separately (e.g., via [scoop](https://scoop.sh): `scoop install jq`). You will also need to manually export `TERM_SESSION_ID` before launching `claude`:
  ```bash
  export TERM_SESSION_ID=$(cat /proc/sys/kernel/random/uuid)
  claude
  ```

### Platform support

| Platform | Status |
| --- | --- |
| Linux | ✅ Tested |
| macOS | ✅ Expected to work (same POSIX primitives) |
| WSL2 on Windows | ✅ Tested |
| Git Bash on Windows | ⚠️ Experimental, requires manual `TERM_SESSION_ID` setup |
| Native Windows (PowerShell / cmd) | ❌ Not supported |

---

## Plugin Layout

This repo is both the marketplace and the plugin — `marketplace.json` points to `./`.

```
claude-code-watchdog/
├── .claude-plugin/
│   ├── marketplace.json     # marketplace manifest
│   └── plugin.json          # plugin manifest
├── commands/
│   ├── start.md             # /watchdog:start
│   ├── stop.md              # /watchdog:stop
│   └── help.md              # /watchdog:help
├── hooks/
│   ├── hooks.json           # registers the Stop hook
│   └── stop-hook.sh         # the core loop logic
├── scripts/
│   ├── setup-watchdog.sh    # creates the state file
│   └── stop-watchdog.sh     # removes the state file
├── .gitattributes           # forces LF line endings (critical for shell scripts)
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # attribution to ralph-loop
├── README.md                # this file
└── README.zh.md             # Chinese translation
```

---

## Inspired By

Watchdog is a derivative work of Anthropic's [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) plugin (Apache License 2.0, © Anthropic, PBC). The original `ralph-loop` used a `<promise>COMPLETE</promise>` XML-tag protocol where the agent explicitly declared completion.

Watchdog keeps the core mechanic — a Stop hook that re-feeds the prompt — and changes these things on top:

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **Exit trigger** | Headless Haiku classifier is the **sole** judge. It reads every tool invocation's full input and decides semantically whether any project file was directly modified. | The agent must emit a `<promise>…</promise>` XML tag in its final text. The phrase inside the tags is configurable via `--completion-promise "…"` (e.g. `COMPLETE`, `DONE`). A Stop hook grep matches the exact string. |
| **Exit precondition** | Tools must have been called **AND** Haiku says `NO_FILE_CHANGES` | Just the `<promise>` text match. The agent can cheat by emitting the tag prematurely; ralph-loop's only defense is a prompt that asks the agent not to lie. |
| **Agent visibility** | Completely hidden (no systemMessage, no banner, stderr-only diagnostics) | Agent is told about the loop and the promise protocol |
| **State scoping** | Per-session file keyed by `TERM_SESSION_ID` | Project-scoped single state file |
| **State file format** | JSON (parsed with jq) | Markdown with YAML frontmatter (parsed with sed/awk/grep) |

See [`NOTICE`](./NOTICE) for the full attribution and the complete list of modifications.

---

## License

Apache License 2.0. See [`LICENSE`](./LICENSE) and [`NOTICE`](./NOTICE).

Watchdog is a derivative work of `ralph-loop` (© Anthropic, PBC, Apache 2.0). This project is **not affiliated with or endorsed by Anthropic**.

---

<div align="center">

**Inspired by:** [ralph-loop](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) (Anthropic, PBC)

**Watch the agent. Catch the lies. Stop only when the work is truly done.**

</div>
