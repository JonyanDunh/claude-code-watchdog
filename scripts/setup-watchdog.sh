#!/bin/bash

# Watchdog Setup Script
# Creates state file for in-session Watchdog

set -euo pipefail

# Parse arguments
PROMPT_PARTS=()
MAX_ITERATIONS=0

# Parse options and positional arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    -h|--help)
      cat << 'HELP_EOF'
Watchdog - Interactive self-referential development loop

USAGE:
  /start [PROMPT...] [OPTIONS]

ARGUMENTS:
  PROMPT...    Initial prompt to start the loop (can be multiple words without quotes)

OPTIONS:
  --max-iterations <n>  Maximum iterations before auto-stop (default: unlimited)
  -h, --help            Show this help message

DESCRIPTION:
  Starts a Watchdog in your CURRENT session. The stop hook prevents
  exit and feeds the SAME PROMPT back to Claude until one of these
  conditions is met:
    • Claude finishes a turn without any file-mutating tool calls
      (Edit / Write / NotebookEdit) — considered converged
    • --max-iterations is reached
    • /stop removes the state file

  Use this for:
  - Interactive iteration where you want to see progress
  - Tasks requiring self-correction and refinement
  - Learning how the watchdog works

EXAMPLES:
  /start Build a todo API --max-iterations 20
  /start --max-iterations 10 Fix the auth bug
  /start Refactor cache layer  (runs until Claude stops changing files)

STOPPING:
  - Exits when a turn finishes with no Edit/Write/NotebookEdit tool calls
  - Exits when --max-iterations is reached
  - Exits when /stop is run

MONITORING:
  # List all active per-session state files:
  ls .claude/watchdog.*.local.json

  # View current iteration for a specific session:
  jq .iteration .claude/watchdog.<SESSION_ID>.local.json

  # View full state:
  jq . .claude/watchdog.<SESSION_ID>.local.json
HELP_EOF
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
  echo "     /start Build a REST API for todos" >&2
  echo "     /start Fix the auth bug --max-iterations 20" >&2
  echo "     /start Refactor code --max-iterations 20" >&2
  echo "" >&2
  echo "   For all options: /start --help" >&2
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
