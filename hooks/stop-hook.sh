#!/bin/bash

# Watchdog Stop Hook
# Prevents session exit when a watchdog is active
# Feeds Claude's output back as input to continue the loop

set -euo pipefail

# Read hook input from stdin (advanced stop hook API)
HOOK_INPUT=$(cat)

# Per-session state file keyed by TERM_SESSION_ID. The same variable is
# used by setup-watchdog.sh when creating the state file, so the hook
# and the setup script naturally target the same path as long as they run
# inside the same terminal tab. Both hook and setup inherit this variable
# from the terminal emulator via the Claude Code parent process.
#
# If TERM_SESSION_ID is missing, we cannot locate a per-session state file
# and must allow the stop (no-op). The parallel setup-watchdog.sh would
# have failed earlier with a clearer error.
if [[ -z "${TERM_SESSION_ID:-}" ]]; then
  exit 0
fi

WATCHDOG_STATE_FILE=".claude/watchdog.${TERM_SESSION_ID}.local.json"

if [[ ! -f "$WATCHDOG_STATE_FILE" ]]; then
  # No active loop for this session - allow exit.
  exit 0
fi

# Read state fields from the JSON file. jq failures (corrupt JSON) or missing
# required fields are treated as unrecoverable: log and allow the stop. All
# rm calls use `-f` so that concurrent cleanups (e.g. a racing hook instance
# or a manual /stop) never abort the script under set -e.
set +e
ITERATION=$(jq -r '.iteration // empty' "$WATCHDOG_STATE_FILE" 2>&1)
ITER_EXIT=$?
set -e
if [[ $ITER_EXIT -ne 0 ]] || [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "⚠️  Watchdog: State file corrupted (iteration missing or non-numeric, got: '$ITERATION')" >&2
  rm -f "$WATCHDOG_STATE_FILE"
  exit 0
fi

set +e
MAX_ITERATIONS=$(jq -r '.max_iterations // 0' "$WATCHDOG_STATE_FILE" 2>&1)
MAX_EXIT=$?
set -e
if [[ $MAX_EXIT -ne 0 ]] || [[ ! "$MAX_ITERATIONS" =~ ^[0-9]+$ ]]; then
  echo "⚠️  Watchdog: State file corrupted (max_iterations missing or non-numeric, got: '$MAX_ITERATIONS')" >&2
  rm -f "$WATCHDOG_STATE_FILE"
  exit 0
fi

# Check if max iterations reached
if [[ $MAX_ITERATIONS -gt 0 ]] && [[ $ITERATION -ge $MAX_ITERATIONS ]]; then
  echo "🛑 Watchdog: Max iterations ($MAX_ITERATIONS) reached." >&2
  rm -f "$WATCHDOG_STATE_FILE"
  exit 0
fi

# Get transcript path from hook input
TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path')

if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
  echo "⚠️  Watchdog: Transcript file not found" >&2
  echo "   Expected: $TRANSCRIPT_PATH" >&2
  echo "   This is unusual and may indicate a Claude Code internal issue." >&2
  echo "   Watchdog is stopping." >&2
  rm -f "$WATCHDOG_STATE_FILE"
  exit 0
fi

# Exit the loop if this turn did not modify any files. Instead of hard-coding
# which tool names count as mutations, we ask a headless Haiku instance to
# judge whether any of the turn's tool invocations actually touched the
# filesystem. This catches bash-based file writes (sed -i, >, mv, rm, etc.)
# that a tool-name filter would miss.
#
# Per-session correct: the classifier only sees this session's transcript
# lines (everything after the most recent user message line), so concurrent
# sessions in the same working tree do not cross-contaminate each other.
#
# Recursion protection: Haiku's own Stop hook will still fire at the end of
# the judge call, but the session_id isolation check near the top of this
# script short-circuits it (the judge session's id will not match the state
# file's session_id), so there is no infinite loop.
# Find the line number of the most recent *real* user message (a user-initiated
# turn boundary), ignoring tool_result entries. Claude Code writes tool
# results back to the transcript with role="user", so a naive
# grep '"role":"user"' matches both real user messages AND tool_results.
# We filter tool_results out so "current turn" correctly starts at the most
# recent real user turn (either the initial prompt or the Stop hook re-feed).
set +e
LAST_USER_LINE=$(grep -n '"role":"user"' "$TRANSCRIPT_PATH" | grep -v '"type":"tool_result"' | tail -n1 | cut -d: -f1)
set -e
LAST_USER_LINE=${LAST_USER_LINE:-0}

set +e
CURRENT_TURN_LINES=$(tail -n +$((LAST_USER_LINE + 1)) "$TRANSCRIPT_PATH" | grep '"role":"assistant"')
set -e

# Collect this turn's tool invocations as a compact JSON array. For Bash,
# include the command string so the classifier can judge whether it writes
# to the filesystem. For other tools, the tool name alone is enough. Empty
# CURRENT_TURN_LINES is safe: jq -s on empty input yields "[]", which then
# flows through to Haiku unchanged (Haiku will answer NO_FILE_CHANGES for
# an empty invocation list).
set +e
TOOL_USES=$(echo "$CURRENT_TURN_LINES" | jq -s -c '
  [.[] | .message.content[]? | select(.type == "tool_use") |
    if .name == "Bash" then {tool: "Bash", command: .input.command}
    else {tool: .name}
    end
  ]
' 2>&1)
JQ_EXIT=$?
set -e

if [[ $JQ_EXIT -ne 0 ]]; then
  echo "⚠️  Watchdog: Failed to extract tool invocations from transcript" >&2
  echo "   Error: $TOOL_USES" >&2
  echo "   Watchdog is stopping." >&2
  rm -f "$WATCHDOG_STATE_FILE"
  exit 0
fi

# Ask a headless Haiku instance whether any of these invocations modified
# files on disk. Falls through (continues the loop) on any failure as a
# safety default: better to over-iterate than to drop in-progress work.
#
# We use distinctive markers (FILE_CHANGES / NO_FILE_CHANGES) instead of
# plain YES/NO to make the classifier's output unambiguous: the tokens are
# unlikely to appear in Haiku's prose by accident, and only-matching these
# specific strings avoids false positives from natural-language answers.
JUDGMENT_PROMPT=$(cat <<PROMPT_EOF
You are a binary classifier. Below is a JSON array of tool invocations made by an agent in a single turn. Decide whether any of them modified files on the filesystem.

An invocation "modifies files" if it creates, overwrites, appends to, deletes, renames, moves, or edits any file.

Classification rules:
- Edit, Write, NotebookEdit, MultiEdit -> FILE_CHANGES.
- Bash commands that write/create/delete/rename/edit files (for example: sed -i, awk -i inplace, perl -i, output redirection with > or >>, mv, cp, rm, rmdir, touch, tee writing to a file, dd with of=, ln, git add, git commit, git reset --hard, and any command whose effect is to change the filesystem) -> FILE_CHANGES.
- Read-only Bash commands (grep, cat, ls, find without -delete, wc, head, tail, ps, git status, git log, git diff, etc.) -> NO_FILE_CHANGES for that invocation alone.
- Read, Grep, Glob, WebFetch, WebSearch, Task -> NO_FILE_CHANGES.
- If the turn contains BOTH modifying and non-modifying invocations, answer FILE_CHANGES.

Output exactly one of these two tokens, with no punctuation and no other text:
FILE_CHANGES
NO_FILE_CHANGES

Tool invocations:
$TOOL_USES
PROMPT_EOF
)

# Exit precondition: the agent must have invoked at least one tool this turn.
# A pure-text response never exits the loop — this prevents the agent from
# falsely claiming completion from memory without doing real verification
# work. If no tools were called, skip the Haiku judgment entirely and fall
# through to re-feed the prompt, forcing another iteration.
if [[ "$TOOL_USES" == "[]" ]]; then
  echo "ℹ️  Watchdog: no tool invocations this turn, continuing loop to force real verification" >&2
elif ! command -v claude >/dev/null 2>&1; then
  echo "⚠️  Watchdog: 'claude' CLI not found in PATH, continuing loop as safety" >&2
else
  # `< /dev/null` is important: without it the claude CLI waits 3 seconds
  # for stdin input before proceeding ("no stdin data received in 3s"
  # warning). Explicitly closing stdin shaves ~3s off every judgment call.
  set +e
  JUDGMENT=$(claude -p --model haiku --no-session-persistence "$JUDGMENT_PROMPT" < /dev/null 2>/dev/null)
  CLAUDE_EXIT=$?
  set -e

  if [[ $CLAUDE_EXIT -ne 0 ]]; then
    echo "⚠️  Watchdog: Haiku judgment call failed (exit $CLAUDE_EXIT), continuing loop as safety" >&2
  else
    # FILE_CHANGES is a substring of NO_FILE_CHANGES, so naively grep-ing
    # for FILE_CHANGES would false-positive on NO_FILE_CHANGES. Strip every
    # NO_FILE_CHANGES token first, then test whether any bare FILE_CHANGES
    # remains. Also check the original for NO_FILE_CHANGES separately.
    # Each grep/pipeline is wrapped in set +e so that "no match" (exit 1)
    # doesn't abort the script under set -e + pipefail.
    set +e
    STRIPPED_JUDGMENT=$(echo "$JUDGMENT" | sed 's/NO_FILE_CHANGES//g')
    HAS_YES=$(echo "$STRIPPED_JUDGMENT" | grep -c 'FILE_CHANGES')
    HAS_NO=$(echo "$JUDGMENT" | grep -c 'NO_FILE_CHANGES')
    set -e
    # grep -c on empty input returns 0 lines matched, exit code 1 under
    # pipefail would be ignored by set +e above. HAS_YES/HAS_NO are now
    # safe integers representing "lines containing the token".

    if [[ "$HAS_YES" -eq 0 ]] && [[ "$HAS_NO" -gt 0 ]]; then
      echo "✅ Watchdog: Haiku judged no file modifications - exiting loop." >&2
      rm -f "$WATCHDOG_STATE_FILE"
      exit 0
    elif [[ "$HAS_YES" -gt 0 ]] && [[ "$HAS_NO" -eq 0 ]]; then
      # Clean FILE_CHANGES verdict. Fall through to re-feed and continue.
      :
    else
      # Either both tokens present, or neither. Ambiguous -> safety continue.
      echo "⚠️  Watchdog: Haiku returned ambiguous answer ('${JUDGMENT:0:200}'), continuing loop as safety" >&2
    fi
  fi
fi

# Not complete - continue loop with SAME PROMPT
NEXT_ITERATION=$((ITERATION + 1))

# Read the original prompt from the JSON state file.
set +e
PROMPT_TEXT=$(jq -r '.prompt // empty' "$WATCHDOG_STATE_FILE" 2>&1)
PROMPT_EXIT=$?
set -e
if [[ $PROMPT_EXIT -ne 0 ]] || [[ -z "$PROMPT_TEXT" ]]; then
  echo "⚠️  Watchdog: State file corrupted (prompt missing or unreadable)" >&2
  rm -f "$WATCHDOG_STATE_FILE"
  exit 0
fi

# Update iteration in the JSON state file. jq writes to a temp file and we
# atomically rename into place so a racing reader never sees a half-written
# file.
TEMP_FILE="${WATCHDOG_STATE_FILE}.tmp.$$"
jq ".iteration = $NEXT_ITERATION" "$WATCHDOG_STATE_FILE" > "$TEMP_FILE"
mv "$TEMP_FILE" "$WATCHDOG_STATE_FILE"

# Build the message fed back to the agent as the next user turn: original
# prompt followed by an English verification reminder that forces actual tool
# calls instead of claiming completion from memory.
#
# IMPORTANT: this message must NOT reveal that the agent is running inside a
# loop. No "iteration N", no "loop", no status banners — the agent must be
# unable to tell that its turn was re-fed by a stop hook. The systemMessage
# field is intentionally omitted for the same reason.
VERIFICATION_REMINDER="Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete."

FULL_MESSAGE="${PROMPT_TEXT}

${VERIFICATION_REMINDER}"

# Output JSON to block the stop and feed the message back as the next user turn.
jq -n \
  --arg prompt "$FULL_MESSAGE" \
  '{
    "decision": "block",
    "reason": $prompt
  }'

# Exit 0 for successful hook execution
exit 0
