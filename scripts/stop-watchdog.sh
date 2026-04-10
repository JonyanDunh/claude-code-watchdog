#!/bin/bash

# Watchdog Cancel Script
# Removes the per-session state file so the Stop hook stops re-feeding the
# prompt. Idempotent: if no active loop exists for this session, exits
# cleanly with an informational message.

set -euo pipefail

if [[ -z "${TERM_SESSION_ID:-}" ]]; then
  echo "❌ Error: TERM_SESSION_ID is not set in the environment" >&2
  echo "   Cannot locate the per-session state file without a terminal UUID." >&2
  exit 1
fi

STATE_FILE=".claude/watchdog.${TERM_SESSION_ID}.local.json"

if [[ ! -f "$STATE_FILE" ]]; then
  echo "No active watchdog for this session."
  exit 0
fi

# Best-effort read of the current iteration for a friendlier message.
ITER=$(jq -r '.iteration // "?"' "$STATE_FILE" 2>/dev/null || echo "?")

rm -f "$STATE_FILE"
echo "Cancelled watchdog (was at iteration $ITER)."
