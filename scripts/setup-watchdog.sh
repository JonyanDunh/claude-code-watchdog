#!/bin/bash
#
# Watchdog Setup Script
# Creates the per-session state file for an in-session Watchdog loop.
#
# Originally derived from the ralph-loop plugin's setup-ralph-loop.sh:
#   https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop
# Copyright Anthropic, PBC. Licensed under the Apache License, Version 2.0.
#
# Modified for Watchdog by Jonyan Dunh, 2026: dropped the
# --completion-promise option, switched state file from markdown-with-YAML
# to JSON keyed by TERM_SESSION_ID, removed all status banners from stdout
# so the agent cannot tell it is inside a loop, and now requires
# TERM_SESSION_ID to be set. See the NOTICE file for the full change list.

set -euo pipefail

# Parse arguments
PROMPT_PARTS=()
MAX_ITERATIONS=0

# Parse options and positional arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      # Help is intentionally short and routed to stderr so the slash
      # command's stdout stays empty — empty stdout means Claude Code
      # does not feed a user turn to the agent, and the agent won't
      # respond with a noisy "this is informational" acknowledgement.
      # Full reference lives in commands/help.md, surfaced via
      # /watchdog:help inside Claude Code.
      {
        echo "Watchdog — for the full reference, run inside Claude Code:"
        echo ""
        echo "    /watchdog:help"
        echo ""
        echo "Quick usage:"
        echo "    /watchdog:start \"<your prompt>\" [--max-iterations N]"
        echo "    /watchdog:stop"
      } >&2
      exit 0
      ;;
    --max-iterations)
      if [[ -z "${2:-}" ]]; then
        echo "❌ Error: --max-iterations requires a number argument" >&2
        echo "" >&2
        echo "   Valid examples:" >&2
        echo "     --max-iterations 10" >&2
        echo "     --max-iterations 50" >&2
        echo "     --max-iterations 0  (unlimited)" >&2
        echo "" >&2
        echo "   You provided: --max-iterations (with no number)" >&2
        exit 1
      fi
      if ! [[ "$2" =~ ^[0-9]+$ ]]; then
        echo "❌ Error: --max-iterations must be a positive integer or 0, got: $2" >&2
        echo "" >&2
        echo "   Valid examples:" >&2
        echo "     --max-iterations 10" >&2
        echo "     --max-iterations 50" >&2
        echo "     --max-iterations 0  (unlimited)" >&2
        echo "" >&2
        echo "   Invalid: decimals (10.5), negative numbers (-5), text" >&2
        exit 1
      fi
      MAX_ITERATIONS="$2"
      shift 2
      ;;
    *)
      # Non-option argument - collect all as prompt parts
      PROMPT_PARTS+=("$1")
      shift
      ;;
  esac
done

# Join all prompt parts with spaces
PROMPT="${PROMPT_PARTS[*]:-}"

# Validate prompt is non-empty
if [[ -z "$PROMPT" ]]; then
  echo "❌ Error: No prompt provided" >&2
  echo "" >&2
  echo "   Watchdog needs a task description to work on." >&2
  echo "" >&2
  echo "   Examples:" >&2
  echo '     /watchdog:start "Build a REST API for todos"' >&2
  echo '     /watchdog:start "Fix the auth bug" --max-iterations 20' >&2
  echo '     /watchdog:start "Refactor the cache layer" --max-iterations 20' >&2
  echo "" >&2
  echo "   For the full reference: /watchdog:help" >&2
  exit 1
fi

# Per-session state file keyed by TERM_SESSION_ID. This is the UUID set by
# the terminal emulator (iTerm2, WezTerm, Windows Terminal, etc.) for the
# current terminal tab. Two Claude Code sessions started in different tabs
# get different TERM_SESSION_ID values, so their state files don't collide.
#
# Caveats:
#   - Not every terminal sets TERM_SESSION_ID. Fall back to a fatal error
#     rather than silently sharing a state file across sessions.
#   - Two `claude` processes launched in the SAME terminal tab will share
#     one TERM_SESSION_ID and will step on each other — acceptable edge
#     case since it requires deliberate effort.
if [[ -z "${TERM_SESSION_ID:-}" ]]; then
  echo "❌ Error: TERM_SESSION_ID is not set in the environment" >&2
  echo "   watchdog uses TERM_SESSION_ID to isolate per-session state" >&2
  echo "   files. Your terminal emulator doesn't seem to export one." >&2
  echo "   Workarounds:" >&2
  echo "     • Use a terminal that sets TERM_SESSION_ID (iTerm2, WezTerm," >&2
  echo "       Windows Terminal, most modern emulators)" >&2
  echo "     • Or export TERM_SESSION_ID=\$(uuidgen) manually before running" >&2
  echo "       'claude'" >&2
  exit 1
fi

mkdir -p .claude

STATE_FILE=".claude/watchdog.${TERM_SESSION_ID}.local.json"

jq -n \
  --arg term_session_id "$TERM_SESSION_ID" \
  --argjson max_iterations "$MAX_ITERATIONS" \
  --arg started_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg prompt "$PROMPT" \
  '{
    active: true,
    iteration: 1,
    max_iterations: $max_iterations,
    term_session_id: $term_session_id,
    started_at: $started_at,
    prompt: $prompt
  }' > "$STATE_FILE"

# Output ONLY the user's prompt to stdout. Everything the slash command writes
# to stdout becomes visible to the agent, and the agent must never learn it is
# running inside a watchdog. No banners, no iteration counters, no status
# messages — the first turn should look identical to a normal user prompt.
echo "$PROMPT"
