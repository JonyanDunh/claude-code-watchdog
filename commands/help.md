---
description: "Explain Watchdog plugin and available commands"
argument-hint: ""
disable-model-invocation: true
---

# Watchdog Plugin Help

Please explain the following to the user in clear, friendly language. Do not dump the markdown verbatim — synthesize and present it.

## What is Watchdog?

Watchdog is a self-referential loop for Claude Code. You give it a prompt once, and it re-feeds that same prompt to Claude after every turn until the task genuinely stops producing file edits. The agent is not told a loop is running, so it cannot fake a completion signal to escape early.

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

### `/watchdog:start "<PROMPT>" [--max-iterations N] [--exit-confirmations N] [--prompt-file <path>] [--watch-prompt-file] [--no-classifier]`

Start a Watchdog in the current session.

**Usage:**

```
/watchdog:start "Refactor services/cache.ts to use the new API. Iterate until pnpm test:cache passes." --max-iterations 20
/watchdog:start "Add tests for auth.ts until coverage hits 80%."
/watchdog:start --prompt-file ./tmp/my-big-prompt.txt --max-iterations 20
/watchdog:start "Refactor cache.ts" --exit-confirmations 3 --max-iterations 20
/watchdog:start --prompt-file ./tmp/task.md --watch-prompt-file --max-iterations 20
/watchdog:start "Build until I /watchdog:stop" --no-classifier
```

**Options:**

- `--max-iterations <n>` — **optional safety cap**. If passed, the loop exits after N iterations no matter what. **If you don't pass it, the loop is unlimited** — it will only exit via convergence (Haiku verdict + `--exit-confirmations`) or `/watchdog:stop` (or, under `--no-classifier`, only via `/watchdog:stop`). Recommended for most tasks: `--max-iterations 20`. You no longer need to pass `--max-iterations 0` to mean "unlimited" — just omit the flag entirely (the `0` form is still accepted for backward compatibility).
- `--exit-confirmations <n>` — require **N consecutive** `NO_FILE_CHANGES` verdicts from the Haiku classifier before allowing the loop to exit. Default `1` (exit on the first clean verdict, identical to pre-1.3.0 behavior). Use a higher value when you want belt-and-suspenders confirmation that the work is really done — for example `--exit-confirmations 3` means the agent must finish three turns in a row without modifying any project file.

  **Strict reset semantics:** the streak counter is reset to `0` whenever the Haiku classifier returns anything other than a clean `NO_FILE_CHANGES` verdict — that includes `FILE_CHANGES`, `AMBIGUOUS`, `CLI_MISSING`, `CLI_FAILED`, or a pure-text turn (no tool invocations). Convergence has to be **unbroken** to count.

  Mutually exclusive with `--no-classifier` (the streak counter is never read in that mode).
- `--prompt-file <path>` — read the prompt from a file instead of passing it inline. Use this when your prompt contains newlines, quotes, backticks, `$`, or other characters that would break shell-argument parsing in the slash command's `!` block. Mutually exclusive with an inline positional prompt.

  **Path handling:**

  - **Linux / macOS / WSL:** POSIX absolute (`/home/you/prompts/task.txt`) or relative (`./tmp/task.txt`, `../notes.txt`) paths. Bare filenames resolve against the Claude Code session's current working directory.
  - **Windows (native `cmd.exe` / PowerShell):** absolute (`C:\Users\you\prompts\task.txt` or `C:/Users/you/prompts/task.txt`), relative, and UNC (`\\server\share\task.txt`) paths all work through Node's `fs` APIs. Note: WSL files can be reached from native Windows via `\\wsl.localhost\<distro>\home\you\...` but this path is untested in CI — prefer running Claude Code *inside* WSL and using the POSIX path (`/home/you/...`).
  - **Paths with spaces:** you must quote them yourself, just like any other shell argument: `--prompt-file "./my prompts/task.txt"`.
  - **`~` is NOT expanded by Watchdog** — it relies on the shell. bash/zsh expand `~` to `$HOME` before Watchdog sees the arg, so `--prompt-file ~/task.txt` works there. `cmd.exe` does not expand `~`; Windows users should pass an absolute path or `%USERPROFILE%\task.txt`.
  - **BOM is stripped automatically.** If you save your prompt with Windows Notepad or PowerShell's default `Set-Content`, the leading UTF-8 BOM is quietly removed so Claude doesn't see an invisible zero-width marker as the first character.
  - **Line endings are preserved byte-for-byte.** CRLF files are not rewritten to LF — Claude handles both.
  - **Encoding:** the file is read as UTF-8. Non-UTF-8 encodings (GBK, Shift-JIS, etc.) are not supported — convert to UTF-8 first.
  - **Leading/trailing whitespace is trimmed;** interior whitespace and blank lines are preserved exactly.
- `--watch-prompt-file` — hot-reload the prompt file on every iteration. The Stop hook re-reads `--prompt-file` before deciding whether to re-feed; if the content has changed since the previous turn, the new version is used as the next user turn AND the `--exit-confirmations` streak counter is reset to `0` (a redefined task should not inherit convergence from the old task). If the file has been deleted, become empty, or otherwise can't be read, the cached prompt is silently kept and the loop continues — hot-reload **never** crashes the loop. Requires `--prompt-file`; passing it alone is an error.
- `--no-classifier` — disable the Haiku classifier entirely. The loop will never call `claude -p --model haiku`; the only ways to exit become `--max-iterations` and `/watchdog:stop`. **Just omit `--max-iterations`** for an unbounded ralph-loop-style run that only stops when you say so. Mutually exclusive with `--exit-confirmations`. Compatible with `--prompt-file` and `--watch-prompt-file`.

**Behavior:**

1. Creates `.claude/watchdog.claudepid.<PID>.local.json` as the per-session state file (keyed by the parent Claude Code process ID, discovered automatically)
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

- The Haiku classifier returns `NO_FILE_CHANGES` for **`--exit-confirmations` consecutive turns** (default `1`, so the legacy "exit on first clean verdict" behavior is preserved unless you raise it). Skipped entirely under `--no-classifier`.
- `--max-iterations` is reached
- `/watchdog:stop` is invoked
- The state file is manually removed

A pure-text turn (no tool calls at all) never exits the loop — the agent must actually invoke tools, so it cannot claim completion from memory without doing real verification work. A pure-text turn also resets the `--exit-confirmations` streak counter back to `0`.

## Per-session isolation

The state file is keyed by the **parent Claude Code process ID**, which Watchdog discovers by walking up the process ancestry from its own `process.ppid`. Every Claude Code session has a distinct PID, so concurrent Watchdogs in the same project directory never collide — even if you run 100 of them at once. No `TERM_SESSION_ID` required: this works on every terminal (Windows Terminal, macOS Terminal.app, GNOME Terminal, Alacritty, tmux, JetBrains, iTerm2, WezTerm, plain ttys, etc.).

## Requirements (1.3.0)

| Requirement | Why |
| --- | --- |
| **Claude Code 2.1+** | Uses the Stop hook system and marketplace plugin format |
| **`node`** in `PATH` | All hook and setup logic is JavaScript, runs on Node 18+. Built-in `--test` runner is used for the test suite. |
| **`claude` CLI** in `PATH` | Used for the headless Haiku classification call. Must be authenticated. **Not required when running with `--no-classifier`.** |

## Prompt writing tips

- **Clear completion criteria** — "no more edits needed" must be a verifiable answer, not subjective. Tie it to passing tests, a clean typecheck, zero lint errors, etc.
- **Incremental verifiable goals** — if there's no verifiable end state, the loop will just spin.
- **Self-correcting structure** — tell Claude how to notice failure and adapt.
- **Set `--max-iterations` for most tasks** — even if the Haiku classifier is reliable, a stuck agent should fall through to a hard stop. `--max-iterations 20` is a reasonable default. **Omit the flag entirely** if you genuinely want unlimited iterations (e.g., a long-running maintenance loop you intend to stop manually with `/watchdog:stop`); you do **not** need to pass `--max-iterations 0`.

## Learn more

Full documentation and translations in 7 languages: https://github.com/JonyanDunh/claude-code-watchdog
