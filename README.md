English | [中文](./README_CN.md)

# Watchdog Plugin

A Claude Code plugin that runs the current agent in a self-referential loop inside the same session, repeatedly re-feeding the user's original prompt until the task converges (no more file modifications) or a safety limit is reached.

## What is Watchdog?

Watchdog is the "Ralph" technique adapted for Claude Code's plugin system. You give Claude a prompt once; a Stop hook then intercepts every natural end of turn and feeds the same prompt back, pushing Claude to iterate on the same task until it genuinely stops producing file changes.

The "loop" is not external — no bash `while true`, no outer orchestrator. The plugin installs a Stop hook that blocks the session from exiting and re-injects the prompt as a new user turn.

### Core Concept

```text
1. /start "<task>"              — user runs this once
2. Claude works on the task          — reads, edits, writes, tests
3. Claude's turn ends                — assistant stops
4. Stop hook fires                   — checks if any file was modified this turn
5a. Files were modified              → re-feed the prompt + verification reminder → back to step 2
5b. No files modified this turn      → remove state file → session exits normally
```

## Quick Start

```bash
/start "Fix the flaky auth tests in tests/auth/*.ts. Keep iterating until the whole suite passes." --max-iterations 20
```

Claude will:
- Read the test files, diagnose failures
- Edit the failing code
- Run the tests again
- Iterate on fixes
- Stop automatically once it finishes a turn without changing any file

## Commands

### `/start <PROMPT> [--max-iterations N]`

Starts a watchdog in the current Claude Code session. Writes a per-session state file at `.claude/watchdog.<TERM_SESSION_ID>.local.json` and echoes the prompt as the first turn's input.

**Options:**
- `--max-iterations <n>` — Hard cap on iterations. Default: unlimited. **Strongly recommended.**

**Requirements:**
- The environment must have `TERM_SESSION_ID` set (populated by most modern terminal emulators: iTerm2, WezTerm, Windows Terminal, modern Linux terminals). Without it the setup script refuses to run — the plugin uses this UUID as the per-session state file key.

### `/stop`

Removes the current session's state file so the next Stop hook firing allows the session to exit normally. Idempotent — running it when no loop is active just prints a message.

### `/help`

Shows the full command reference and a concept summary.

## How the Stop Hook Decides

The Stop hook makes the loop exit when **both** of these are true for the latest assistant turn:

1. **Tools were actually called.** A pure-text turn (agent says "I've verified, all good" without any tool use) never exits the loop — it re-feeds the prompt with a verification reminder to force the agent to actually run tools next turn.
2. **A headless Haiku classifier judges no files were modified this turn.** The hook extracts the turn's `tool_use` invocations as compact JSON (tool name + bash command when applicable), hands them to `claude -p --model haiku`, and asks it to return either `FILE_CHANGES` or `NO_FILE_CHANGES`. Only `NO_FILE_CHANGES` triggers loop exit.

Why an LLM classifier instead of a hardcoded tool-name filter:
- Bash commands like `sed -i`, `awk -i inplace`, `> file`, `mv`, `rm`, `git add`, etc. all modify files but would be missed by a naive `Edit|Write|NotebookEdit` filter.
- The classifier reads the actual command text and decides semantically.
- Per-session correct: only the current session's transcript is inspected, so concurrent watchdogs don't cross-contaminate.

### What triggers the loop to keep going

- Any `Edit`, `Write`, `NotebookEdit`, or file-mutating `Bash` command in the turn
- A pure-text turn (zero tool calls) — forces another iteration so the agent has to actually verify
- An ambiguous or failing Haiku response (fail-safe: continue rather than drop in-progress work)
- `--max-iterations` has not been reached yet

### What triggers the loop to exit

- The turn has at least one tool call **and** Haiku returns `NO_FILE_CHANGES`
- `--max-iterations` reached
- `/stop` run manually
- The state file was removed from disk (e.g. another session cleaned it up)

## State File

Location: `.claude/watchdog.<TERM_SESSION_ID>.local.json`

Example:
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

Each session has its own file keyed by `TERM_SESSION_ID`, so running multiple watchdogs in different terminal tabs works without conflict.

**Monitor an active loop:**
```bash
# Show all active per-session state files
ls .claude/watchdog.*.local.json

# Current iteration of a specific session
jq .iteration .claude/watchdog.<SESSION_ID>.local.json

# Full state
jq . .claude/watchdog.<SESSION_ID>.local.json
```

**Manually kill all loops in this project:**
```bash
rm -f .claude/watchdog.*.local.json
```

## Hiding the Loop From the Agent

By design, the agent **must not know it is inside a loop**. If it knew, it would be tempted to short-circuit by claiming completion after the first turn or by producing a completion signal from memory without verifying.

To enforce this the plugin:
- Emits **no** `systemMessage` field from the Stop hook (no iteration counter, no status banner).
- The setup script writes **only the user's prompt** to stdout — no "Loop activated, iteration 1" header.
- The re-fed prompt contains the original text plus a single English verification reminder:
  > Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.
- All hook diagnostic output goes to stderr (`>&2`), not stdout, so Claude Code's transcript doesn't pick it up as agent context.

The agent sees what looks like the same user asking the same question over and over, occasionally adding "please actually re-run the checks". It has no reason to believe there's a Stop hook driving the repetition.

## Prompt Writing Best Practices

### 1. Clear completion criteria

Write the prompt as something that can genuinely be answered by "no more edits needed".

❌ Bad: "Build a todo API and make it good."
✅ Good: "Build a REST API for todos in `src/api/todos.ts`. Requirements: CRUD endpoints, input validation, 80%+ test coverage in `tests/todos.test.ts`. Iterate until all tests pass and coverage is met."

### 2. Incremental, verifiable goals

The loop exits on "no files modified". If your task has no verifiable end state, it will just spin.

✅ Good: "Refactor `services/cache.ts` to remove the legacy LRU implementation. Update all callers in `src/`. Run `pnpm typecheck && pnpm test:cache` after each change. Iterate until both pass without warnings."

### 3. Self-correcting structure

Tell the agent how to notice failure and adapt.

```markdown
Implement feature X using TDD:
1. Write failing tests in tests/feature-x.test.ts
2. Implement minimum code to pass
3. Run `pnpm test:feature-x`
4. If any test fails, read the failure, fix, re-run
5. Refactor for clarity once green
```

### 4. Always set `--max-iterations`

The Haiku classifier is not infallible. A stuck agent that keeps making meaningless edits, or one that gets confused and stops editing prematurely, should fall through to a hard stop. `--max-iterations 20` is a reasonable default.

## When to Use the Watchdog

**Good for:**
- Tasks with clear, automated success criteria (tests, lints, typechecks)
- Iterative refinement: fix → test → fix → test
- Greenfield implementations you can walk away from
- Reviewing existing code and fixing issues

**Not good for:**
- Tasks requiring human judgment or design decisions
- One-shot operations (a single command, a single file edit)
- Anything where "done" is subjective
- Production debugging that needs external context

## Limitations and Known Issues

- **`TERM_SESSION_ID` not exported**: Some terminal emulators don't set this. Workaround: `export TERM_SESSION_ID=$(uuidgen)` before launching `claude`.
- **Two `claude` in the same terminal tab**: They share `TERM_SESSION_ID` and will stomp on each other's state file. Use separate tabs.
- **Haiku cost per iteration**: Each Stop hook firing spends ~10 seconds and a small amount of tokens on a headless `claude -p --model haiku` classification call. This is the main latency cost of the loop.
- **Haiku requires `claude` CLI in PATH**: The hook relies on the `claude` CLI being available and authenticated (OAuth or `ANTHROPIC_API_KEY`). If unavailable the hook falls through to "continue loop" as a safety default rather than dropping work.
- **The Stop hook only fires when Claude naturally stops**: If a tool call crashes the hook, the state file may linger. `/stop` cleans it up.

## Plugin Layout

```
watchdog/
├── .claude-plugin/
│   └── plugin.json          # name, version, description
├── commands/
│   ├── start.md             # /watchdog:start
│   ├── stop.md              # /watchdog:stop
│   └── help.md              # /watchdog:help
├── hooks/
│   ├── hooks.json           # registers the Stop hook
│   └── stop-hook.sh         # the core loop logic (stays named stop-hook)
└── scripts/
    ├── setup-watchdog.sh    # creates the state file
    └── stop-watchdog.sh     # removes the state file
```

## For Help

Run `/help` in Claude Code for the full command reference.

## Inspired By

This plugin is inspired by the [**ralph-loop**](https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop) plugin in Anthropic's official claude-plugins repository. The original used a `<promise>` XML-tag protocol where the agent explicitly declared completion.

Watchdog keeps the same core mechanic (a Stop hook that re-feeds the prompt) and changes a few things on top:

- **Headless Haiku classifier instead of a hard-coded tool filter** — catches Bash-driven file mutations like `sed -i`, `mv`, `> file` that a naive `Edit|Write|NotebookEdit` whitelist would miss.
- **Exit precondition: the turn must have called at least one tool** — prevents the agent from cheating by claiming "done" in plain text without actually verifying.
- **Hidden loop** — no `systemMessage`, no setup-script banner, diagnostics go to stderr. The agent has no way to tell it's inside a loop, so it can't short-circuit by emitting a fake completion signal.
- **Per-session state file keyed by `TERM_SESSION_ID`** — multiple watchdogs in different terminal tabs don't clobber each other's state.
- **Re-fed prompt carries an English verification reminder** — pushes the agent to re-run tool calls instead of answering from memory.

Thanks to the ralph-loop authors for the foundational idea.
