---
description: "Explain Watchdog plugin and available commands"
---

# Watchdog Plugin Help

Please explain the following to the user:

## What is the Watchdog?

The watchdog is an iterative development methodology based on continuous AI loops.

**Core concept:**
```bash
while :; do
  cat PROMPT.md | claude-code --continue
done
```

The same prompt is fed to Claude repeatedly. The "self-referential" aspect comes from Claude seeing its own previous work in the files and git history, not from feeding output back as input.

**Each iteration:**
1. Claude receives the SAME prompt
2. Works on the task, modifying files
3. Tries to exit
4. Stop hook intercepts and feeds the same prompt again
5. Claude sees its previous work in the files
6. Iteratively improves until convergence

Failures across iterations are predictable, enabling systematic improvement through prompt tuning.

## Available Commands

### /start <PROMPT> [OPTIONS]

Start a watchdog in your current session.

**Usage:**
```
/start "Refactor the cache layer" --max-iterations 20
/start "Add tests"
```

**Options:**
- `--max-iterations <n>` - Max iterations before auto-stop

**How it works:**
1. Creates `.claude/watchdog.<SESSION_ID>.local.json` state file (per-session, JSON)
2. You work on the task
3. When you try to exit, the stop hook intercepts
4. Same prompt is fed back
5. You see your previous work
6. Continues until convergence or `--max-iterations`

---

### /stop

Cancel an active watchdog (removes the loop state file).

**Usage:**
```
/stop
```

**How it works:**
- Checks for active loop state file
- Removes `.claude/watchdog.<SESSION_ID>.local.json` for the current session
- Reports cancellation with iteration count

---

## Key Concepts

### Convergence Detection

The stop hook exits the loop automatically when a turn completes **without any file-mutating tool calls** (`Edit` / `Write` / `NotebookEdit`). The idea: if Claude is no longer changing files, the task has converged.

Exit conditions (any one triggers):
- Turn finishes with zero Edit/Write/NotebookEdit calls
- `--max-iterations` is reached
- `/stop` is invoked

### Self-Reference Mechanism

The "loop" doesn't mean Claude talks to itself. It means:
- Same prompt repeated
- Claude's work persists in files
- Each iteration sees previous attempts
- Builds incrementally toward the goal

## Example

### Interactive Bug Fix

```
/start "Fix the token refresh logic in auth.ts. Keep iterating until all tests pass." --max-iterations 10
```

You'll see the loop:
- Attempt fixes (calling Edit/Write)
- Run tests
- See failures
- Iterate on solutions
- Exit automatically once Claude stops making further edits

## When to Use the Watchdog

**Good for:**
- Well-defined tasks with clear success criteria
- Tasks requiring iteration and refinement
- Iterative development with self-correction
- Greenfield projects

**Not good for:**
- Tasks requiring human judgment or design decisions
- One-shot operations
- Tasks with unclear success criteria
- Debugging production issues (use targeted debugging instead)
