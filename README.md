English | [中文](./README.zh.md) | [한국어](./README.ko.md) | [日本語](./README.ja.md) | [Español](./README.es.md) | [Tiếng Việt](./README.vi.md) | [Português](./README.pt.md)

# Watchdog

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-2.1%2B-7C4DFF.svg)](https://docs.anthropic.com/claude-code)
[![Version](https://img.shields.io/badge/version-1.2.0-green.svg)](./.claude-plugin/plugin.json)
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
- **LLM-judged, project-aware file-change detection** — On every hook fire, watchdog spawns a short-lived **Claude Code subprocess** (`claude -p --model haiku`) and asks it the single question: "did this turn modify any project file?". The subprocess sees every tool invocation's full input and decides semantically. Haiku is the model — the important part is that it's an **isolated, stateless Claude Code process**, not a custom API client, so your existing `claude` authentication is reused as-is.
- **Per-session isolation** — State file is keyed by the parent Claude Code process ID, discovered by walking the process ancestry. 100 concurrent watchdogs in the same project directory never collide.
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

The loop happens **inside your current session** — no external `while true`, no orchestrator process. The Stop hook in `hooks/stop-hook.js` blocks normal session exit and re-injects the prompt as a new user turn using Claude Code's native `{"decision": "block", "reason": ...}` protocol.

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
| **Classifier subprocess verdict** | A short-lived Claude Code subprocess (`claude -p --model haiku`) returns `NO_FILE_CHANGES`. The subprocess reads every tool invocation's full input and decides semantically whether the turn directly modified any project file. |

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

### Long prompts from a file

If your prompt contains newlines, quotes, backticks, `$`, or other characters that would break shell-argument parsing inside the slash command's `!` block — for example a multi-paragraph Markdown task spec — pass it as a file instead:

```bash
/watchdog:start --prompt-file ./tmp/my-task.md --max-iterations 20
```

The file is read directly by Node (`fs.readFileSync`), bypassing shell escaping entirely. Relative paths resolve against the Claude Code session's current working directory. UTF-8 BOM is stripped automatically (so Windows Notepad files are safe), CRLF content is preserved byte-for-byte, and leading/trailing whitespace is trimmed. Mutually exclusive with an inline `<PROMPT>` — pick one or the other.

Works with Linux/macOS/WSL POSIX paths (`/home/you/…`, `./tmp/…`), Windows absolute paths (`C:\Users\you\…`, `C:/Users/you/…`), and UNC paths (`\\server\share\…`). `~` is expanded by your shell (bash/zsh), not by Watchdog — on `cmd.exe` use `%USERPROFILE%\…` or an absolute path. Paths with spaces must be quoted as usual: `--prompt-file "./my prompts/task.md"`. See `/watchdog:help` for the full path-handling reference.

### Stricter convergence with `--exit-confirmations`

By default the loop exits the moment the Haiku classifier returns its first `NO_FILE_CHANGES` verdict. For high-stakes work where you want belt-and-suspenders confirmation that the agent has really converged, raise the bar:

```bash
/watchdog:start "Refactor services/cache.ts. Iterate until pnpm test:cache passes." --exit-confirmations 3 --max-iterations 20
```

The loop will now require **three consecutive** clean turns before exiting. The streak counter is reset to `0` the moment the classifier returns anything other than `NO_FILE_CHANGES` — including `FILE_CHANGES`, `AMBIGUOUS`, classifier failures (`CLI_MISSING` / `CLI_FAILED`), or a pure-text turn (no tool invocations). Convergence has to be **unbroken** to count.

Default is `1`, identical to pre-1.3.0 behavior. Mutually exclusive with `--no-classifier`.

### Hot-reload the prompt mid-loop with `--watch-prompt-file`

If you started the loop with `--prompt-file` and want to refine the task while it runs, add `--watch-prompt-file`:

```bash
/watchdog:start --prompt-file ./tmp/task.md --watch-prompt-file --max-iterations 30
```

The Stop hook now re-reads the prompt file at the start of every iteration. If the content has changed since the previous turn, the new version becomes the next user turn **and** the `--exit-confirmations` streak counter is reset to `0` (a redefined task should not inherit convergence from the old task).

Hot-reload **never crashes the loop**: if the file is missing, empty, or unreadable when the hook fires, the cached prompt is silently kept and the loop continues. You can edit, rename, or temporarily move the file mid-loop without breaking anything — the next iteration picks up whatever the file looks like at that moment.

Requires `--prompt-file`. Passing `--watch-prompt-file` alone is an error.

### Disable the classifier entirely with `--no-classifier`

For ralph-loop-style runs where you don't want any LLM judging convergence — you'll stop the loop manually or via `--max-iterations`:

```bash
/watchdog:start "Keep iterating until I /watchdog:stop." --no-classifier
```

The Stop hook skips the Haiku call entirely. The only ways to exit become `--max-iterations` and `/watchdog:stop`. **`--max-iterations` is optional** — if you omit it (as in the example above), the loop is truly unbounded and only stops when you say so.

The `claude` CLI is not even required in this mode (the Haiku subprocess is never spawned). Compatible with `--prompt-file` and `--watch-prompt-file`. Mutually exclusive with `--exit-confirmations` — the streak counter is meaningless when there is no classifier returning verdicts.

---

## State File

Per-session state lives at `.claude/watchdog.claudepid.<PID>.local.json`, where `<PID>` is the parent Claude Code process ID discovered by walking the process ancestry. Example:

```json
{
  "active": true,
  "iteration": 3,
  "max_iterations": 20,
  "claude_pid": 1119548,
  "started_at": "2026-04-11T12:00:00Z",
  "prompt": "Fix the flaky auth tests..."
}
```

Every Claude Code session has a distinct PID, so **100 concurrent watchdogs in the same project directory never collide** — each gets its own state file, and `/watchdog:stop` in any one of them only cancels that specific session's loop.

**Monitor active watchdogs:**

```bash
# List all active per-session state files in this project
ls .claude/watchdog.claudepid.*.local.json

# Inspect one via jq or node
node -e "console.log(JSON.parse(require('fs').readFileSync('.claude/watchdog.claudepid.<PID>.local.json','utf8')))"
```

**Manually kill everything in this project:**

```bash
rm -f .claude/watchdog.claudepid.*.local.json
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

### 4. Set `--max-iterations` for most tasks

The classifier subprocess is not infallible. A stuck agent that keeps making meaningless edits, or one that gets confused and stops editing prematurely, should fall through to a hard stop. `--max-iterations 20` is a reasonable default for most work.

**The flag is optional, though.** If you genuinely want an unlimited loop (e.g., a long-running maintenance loop you intend to stop manually with `/watchdog:stop`, or a `--no-classifier` run where convergence is judged by you, not Haiku), **just omit the flag entirely**.

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

Watchdog needs **both `claude` and `node` in your `PATH`** — `node` runs the plugin's hook and setup scripts, and `claude` is what watchdog spawns (`claude -p --model haiku`) to judge whether each turn modified any project file.

| Requirement | Why |
| --- | --- |
| **Claude Code 2.1+** | Uses the Stop hook system and marketplace plugin format |
| **`node`** 18+ in `PATH` | Runtime for the plugin's hook and setup scripts |
| **`claude` CLI** in `PATH` | Watchdog spawns a short-lived `claude -p --model haiku` subprocess on every hook fire to classify the turn. Must be authenticated (OAuth or `ANTHROPIC_API_KEY`) — the subprocess reuses your existing session credentials. |

### Install dependencies

If you installed Claude Code via `npm install -g @anthropic-ai/claude-code`, you get **both** `claude` and `node` as a package deal — the npm install adds `claude` to your `PATH`, and Node.js is npm's own runtime so it's already there. Nothing else to install.

If you installed Claude Code some other way (standalone binary, Homebrew, Windows installer), `claude` is already in your `PATH` but you may need to install Node.js 18+ separately:

**macOS (Homebrew):**

```bash
brew install node
# claude CLI: see https://docs.anthropic.com/claude-code
```

**Debian / Ubuntu / WSL2:**

```bash
# Option 1: distro package (may be older than 18)
sudo apt update && sudo apt install -y nodejs

# Option 2: NodeSource (current LTS)
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install -y nodejs
```

**Fedora / RHEL:**

```bash
sudo dnf install -y nodejs
```

**Arch / Manjaro:**

```bash
sudo pacman -S --needed nodejs
```

**Windows (native PowerShell / cmd):**

```powershell
# winget
winget install OpenJS.NodeJS.LTS

# or scoop
scoop install nodejs-lts

# or download the installer from https://nodejs.org
```

### Platform support

| Platform | Status |
| --- | --- |
| Linux (Node 18 / 20 / 22) | ✅ Tested in CI |
| macOS (Node 18 / 20 / 22) | ✅ Tested in CI |
| Windows (Node 18 / 20 / 22) | ✅ Tested in CI |

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
│   ├── hooks.json           # registers the Stop hook (invokes node)
│   └── stop-hook.js         # the core loop logic
├── scripts/
│   ├── setup-watchdog.js    # creates the state file
│   └── stop-watchdog.js     # removes the state file
├── lib/                     # shared modules (reused by all entry points)
│   ├── constants.js         # state path pattern, marker tokens, prompt templates
│   ├── log.js               # stderr diagnostics
│   ├── stdin.js             # sync stdin reader
│   ├── state.js             # atomic state file lifecycle
│   ├── transcript.js        # JSONL parser + current-turn tool extraction
│   ├── judge.js             # Claude Code classifier subprocess + verdict parser
│   └── claude-pid.js        # process ancestry walk
├── test/                    # node:test unit + integration tests
│   ├── fixtures/            # transcript JSONL fixtures
│   ├── transcript.test.js
│   ├── state.test.js
│   ├── judge.test.js
│   ├── claude-pid.test.js
│   ├── setup.test.js
│   ├── stop-watchdog.test.js
│   ├── stop-hook.test.js
│   └── stop-hook-haiku.test.js
├── .github/                 # CI workflow (node --test matrix, jsonlint, markdownlint) + issue/PR templates
├── .gitattributes           # forces LF line endings
├── LICENSE                  # Apache License 2.0
├── NOTICE                   # attribution to ralph-loop
├── README.md                # this file
└── README.{zh,ja,ko,es,vi,pt}.md  # translations
```

## Inspired By

Watchdog is a derivative work of Anthropic's [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) plugin (Apache License 2.0, © Anthropic, PBC). The original `ralph-loop` used a `<promise>COMPLETE</promise>` XML-tag protocol where the agent explicitly declared completion.

Watchdog keeps the core mechanic — a Stop hook that re-feeds the prompt — and changes these things on top:

| | Watchdog | ralph-loop |
| --- | --- | --- |
| **Exit trigger** | A short-lived Claude Code subprocess (`claude -p --model haiku`) is the **sole** judge. It reads every tool invocation's full input and decides semantically whether any project file was directly modified. | The agent must emit a `<promise>…</promise>` XML tag in its final text. The phrase inside the tags is configurable via `--completion-promise "…"` (e.g. `COMPLETE`, `DONE`). A Stop hook grep matches the exact string. |
| **Exit precondition** | Tools must have been called **AND** the classifier subprocess says `NO_FILE_CHANGES` | Just the `<promise>` text match. The agent can cheat by emitting the tag prematurely; ralph-loop's only defense is a prompt that asks the agent not to lie. |
| **Agent visibility** | Completely hidden (no systemMessage, no banner, stderr-only diagnostics) | Agent is told about the loop and the promise protocol |
| **State scoping** | One state file per Claude Code session — unlimited concurrent watchdogs in the same project | One state file per project — only ONE ralph-loop can run per project at a time |
| **State file format** | JSON (parsed with native `JSON.parse`) | Markdown with YAML frontmatter (parsed with sed/awk/grep) |
| **Runtime** | Node.js 18+ | Bash + jq + POSIX coreutils |
| **Prompt input** | Inline via `$ARGUMENTS`, **or** `--prompt-file <path>` — reads the file directly with Node's `fs.readFileSync`, bypassing shell argument parsing entirely. Safe for multi-paragraph Markdown containing newlines, quotes, backticks, `$`, etc. UTF-8 BOM is stripped automatically; CRLF is preserved byte-for-byte. | Inline via `$ARGUMENTS` in the slash command's `!` shell block only. Any unescaped `"`, `` ` ``, `$`, or newline in the prompt breaks `bash` parsing with `unexpected EOF`. No file or stdin fallback — multi-paragraph Markdown task specs must be mangled into a single-line, shell-safe string first. |
| **Convergence flexibility** | `--exit-confirmations N` requires N **consecutive** clean `NO_FILE_CHANGES` verdicts before exit (default 1). `--no-classifier` skips Haiku entirely for ralph-loop-style runs that exit only via `--max-iterations` or `/watchdog:stop`. | A single `<promise>…</promise>` tag-emit-then-grep mechanism with no tunable strictness — either the agent emits the configured promise phrase or it doesn't. |
| **Prompt evolution** | `--watch-prompt-file` hot-reloads `--prompt-file` on every iteration. You can edit the task spec mid-loop and the next turn picks it up (and resets the convergence streak, since the task changed). Missing/empty/unreadable file silently keeps the cached prompt — hot-reload never crashes the loop. | Prompt is fixed at `/ralph-loop "..."` time and cannot be changed without canceling and restarting the loop. |

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
