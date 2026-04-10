#!/bin/bash
#
# Watchdog Cancel Script
# Removes the per-session state file so the Stop hook stops re-feeding the
# prompt. Idempotent: if no active loop exists for this session, exits
# cleanly with an informational message.
#
# Originally derived from the ralph-loop plugin's cancel-ralph command:
#   https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop
# Copyright Anthropic, PBC. Licensed under the Apache License, Version 2.0.
#
# Modified for Watchdog by Jonyan Dunh, 2026: converted from a
# Claude-driven instructions markdown into a standalone shell script and
# switched to a per-session state file keyed by TERM_SESSION_ID.
# See the NOTICE file for the full change list.

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
