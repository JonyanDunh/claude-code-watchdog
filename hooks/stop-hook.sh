#!/bin/bash
#
# Watchdog Stop Hook
# Prevents session exit when a watchdog is active.
# Feeds Claude's output back as input to continue the loop.
#
# Originally derived from the ralph-loop plugin:
#   https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop
# Copyright Anthropic, PBC. Licensed under the Apache License, Version 2.0.
#
# Significantly modified for Watchdog by Jonyan Dunh, 2026:
# replaced the <promise> XML-tag exit protocol with a headless Haiku
# classifier, added a "must have called tools" exit precondition,
# hid the loop from the agent (no systemMessage, stderr-only diagnostics),
# switched state file to per-session JSON keyed by TERM_SESSION_ID,
# fixed a transcript turn-boundary bug involving tool_result entries,
# and added an owner_session_id recursion guard so the headless Haiku
# classifier's own Stop hook does not clobber the main session's state.
# See the NOTICE file at the repo root for a full summary of changes.

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

# Recursion guard. The headless Haiku classifier we invoke below is itself a
# full Claude Code session, so when it ends its own Stop hook fires. The
# state file path is keyed by TERM_SESSION_ID — which is a terminal-emulator
# env var and IS inherited by subprocesses — so the recursive invocation
# would find and clobber the main session's state file.
#
# Fix: the per-invocation Claude `session_id` (from the hook's stdin JSON) is
# NOT inherited — every Claude Code process gets its own. On the first fire
# we stamp it into the state file as owner_session_id; subsequent fires
# compare and bail out if they're from a different session.
HOOK_SESSION_ID=$(echo "$HOOK_INPUT" | jq -r '.session_id // empty')
OWNER_SESSION_ID=$(jq -r '.owner_session_id // empty' "$WATCHDOG_STATE_FILE" 2>/dev/null)

if [[ -z "$OWNER_SESSION_ID" ]]; then
  # First fire — claim ownership atomically (tmp file + rename).
  TEMP_FILE="${WATCHDOG_STATE_FILE}.tmp.$$"
  jq --arg sid "$HOOK_SESSION_ID" '.owner_session_id = $sid' "$WATCHDOG_STATE_FILE" > "$TEMP_FILE"
  mv "$TEMP_FILE" "$WATCHDOG_STATE_FILE"
elif [[ "$OWNER_SESSION_ID" != "$HOOK_SESSION_ID" ]]; then
  # Recursive invocation from a subprocess (e.g. the headless Haiku
  # classifier we spawn below). Do nothing so we don't touch the main
  # session's state.
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

# Exit the loop if this turn did not modify any project files. Instead of
# hard-coding which tool names count as mutations, we ask a headless Haiku
# instance to judge semantically whether a file the developer would consider
# part of the project was modified. Side effects that don't touch project
# files — running containers, remote DB writes, network calls, system
# daemon state — are correctly ignored because Haiku understands them.
#
# Recursion protection is handled by the owner_session_id check near the top
# of this script — the headless Haiku session's recursive Stop hook sees a
# mismatched owner_session_id and bails before ever reaching this point.
#
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

# Collect this turn's tool invocations as a compact JSON array. Every tool
# gets BOTH its name AND its full input exposed to the classifier — Bash
# (where command is inside input), MCP tools (where SQL / query / request
# body lives in input), file tools (where file_path is in input), etc.
# Without this, Haiku would see a bare "mcp__postgres__execute_sql" and
# have no way to distinguish SELECT from INSERT. Empty CURRENT_TURN_LINES
# is safe: jq -s on empty input yields "[]", which flows through to Haiku
# unchanged.
set +e
TOOL_USES=$(echo "$CURRENT_TURN_LINES" | jq -s -c '
  [.[] | .message.content[]? | select(.type == "tool_use") |
    {tool: .name, input: .input}
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

# Ask a headless Haiku instance whether any of these invocations directly
# modified a project file. Haiku sees every tool's full input — Bash
# command text, MCP tool arguments (SQL queries, API request bodies,
# etc.), Edit/Write file paths and content, everything — and decides
# semantically. No hard-coded rubric, no tool-name whitelist, no bash
# pattern matcher: the LLM's understanding of "what counts as a project
# file" is the entire decision. Distinctive marker tokens
# (FILE_CHANGES / NO_FILE_CHANGES) make the output unambiguous and avoid
# false positives from natural-language prose.
#
# Falls through (continues the loop) on any failure as a safety default:
# better to over-iterate than to drop in-progress work.
JUDGMENT_PROMPT=$(cat <<PROMPT_EOF
You are a binary classifier. Below is a JSON array of tool invocations from a single agent turn. Did any of them directly modify any project file?

A "project file" is any file a developer would consider part of their project: source code, tests, configuration, documentation, dotfiles, .git/* metadata, lock files, package manifests, etc. — essentially anything that belongs under version control, plus the .git internals that track it.

When in doubt, err on FILE_CHANGES.

Output exactly one uppercase token with no other text:
- FILE_CHANGES    if at least one invocation directly modified a project file
- NO_FILE_CHANGES if no project file was modified

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
