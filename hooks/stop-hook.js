#!/usr/bin/env node
'use strict';

// Watchdog Stop hook (Node.js cross-platform implementation).
//
// Prevents session exit when a watchdog is active. When Claude ends a turn,
// this hook fires, inspects the turn's tool invocations, asks a headless
// Haiku classifier whether any project file was modified, and either
//   (a) emits a {"decision":"block","reason":...} JSON to re-feed the
//       original prompt as a new user turn, or
//   (b) exits cleanly to allow the session to end.
//
// Originally derived from the ralph-loop plugin:
//   https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop
// Copyright Anthropic, PBC. Licensed under the Apache License, Version 2.0.
//
// Significantly rewritten for Watchdog 1.1.0 by Jonyan Dunh, 2026:
//   - Cross-platform Node.js (no bash, no jq, no POSIX coreutils)
//   - All shared logic extracted into ../lib/ modules for code reuse
//   - Same semantics as the 1.0.x bash version: Haiku-classifier convergence
//     detection, tool-call exit precondition, owner_session_id recursion
//     guard, per-session state keyed by TERM_SESSION_ID
// See the NOTICE file at the repo root for a full summary of changes.

const { readStdinSync } = require('../lib/stdin');
const { info, warn, success, stop } = require('../lib/log');
const {
  getStateFilePath,
  exists,
  read,
  update,
  remove,
  isValid,
} = require('../lib/state');
const { currentTurnToolUses } = require('../lib/transcript');
const { askHaiku, VERDICT } = require('../lib/judge');
const { VERIFICATION_REMINDER } = require('../lib/constants');

// Allow the stop and exit 0. Never print anything to stdout here — Claude
// Code interprets any stdout from a Stop hook as the JSON decision.
function allowStop() {
  process.exit(0);
}

// Block the stop, re-feed the prompt as the next user turn, exit 0.
function blockAndRefeed(prompt) {
  const fullMessage = `${prompt}\n\n${VERIFICATION_REMINDER}`;
  const decision = { decision: 'block', reason: fullMessage };
  process.stdout.write(JSON.stringify(decision));
  process.stdout.write('\n');
  process.exit(0);
}

function main() {
  // 0. TERM_SESSION_ID is our state-file naming key. Missing => no-op allow.
  const termSessionId = process.env.TERM_SESSION_ID;
  if (!termSessionId) allowStop();

  const stateFile = getStateFilePath(process.cwd(), termSessionId);

  // 1. No state file => no active watchdog in this terminal tab => allow.
  if (!exists(stateFile)) allowStop();

  const state = read(stateFile);
  if (!isValid(state)) {
    warn('State file corrupted (missing iteration / max_iterations / prompt)');
    remove(stateFile);
    allowStop();
  }

  // 2. Read hook input (JSON piped in on stdin by Claude Code).
  let hookInput;
  try {
    hookInput = JSON.parse(readStdinSync());
  } catch (err) {
    warn(`Failed to parse hook input JSON: ${err.message}`);
    remove(stateFile);
    allowStop();
  }

  // 3. Recursion guard. The headless Haiku classifier we invoke below is
  //    itself a full Claude Code session, so when it ends, its own Stop hook
  //    fires. That recursive invocation inherits TERM_SESSION_ID from the
  //    parent process (env vars are inherited by subprocesses), so it would
  //    find and clobber the main session's state file.
  //
  //    Fix: the per-invocation Claude `session_id` (from the hook's stdin
  //    JSON) is NOT inherited — every Claude Code process gets its own.
  //    On the first fire we stamp it into the state file as
  //    `owner_session_id`; subsequent fires compare and bail out if they
  //    are from a different session.
  const hookSessionId = hookInput && hookInput.session_id;
  const ownerSessionId = state.owner_session_id || null;

  if (!ownerSessionId) {
    update(stateFile, { owner_session_id: hookSessionId });
    // Refresh our local copy so downstream logic sees the claim.
    state.owner_session_id = hookSessionId;
  } else if (ownerSessionId !== hookSessionId) {
    // Recursive subprocess (or a session from a different tab that somehow
    // shares our TERM_SESSION_ID). Do nothing — don't touch state.
    allowStop();
  }

  // 4. Max iterations hard stop.
  if (state.max_iterations > 0 && state.iteration >= state.max_iterations) {
    stop(`Max iterations (${state.max_iterations}) reached.`);
    remove(stateFile);
    allowStop();
  }

  // 5. Transcript must exist for us to inspect tool invocations.
  const transcriptPath = hookInput.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    warn('Hook input missing transcript_path');
    remove(stateFile);
    allowStop();
  }

  let toolUses;
  try {
    toolUses = currentTurnToolUses(transcriptPath);
  } catch (err) {
    if (err.code === 'TRANSCRIPT_NOT_FOUND') {
      warn('Transcript file not found');
      process.stderr.write(`   Expected: ${transcriptPath}\n`);
      process.stderr.write('   This is unusual and may indicate a Claude Code internal issue.\n');
      process.stderr.write('   Watchdog is stopping.\n');
      remove(stateFile);
      allowStop();
    }
    warn(`Failed to extract tool invocations from transcript: ${err.message}`);
    remove(stateFile);
    allowStop();
  }

  // 6. Exit precondition: the agent must have invoked at least one tool.
  //    A pure-text turn never exits the loop — this prevents the agent from
  //    falsely claiming completion from memory without doing real work.
  if (toolUses.length === 0) {
    info('no tool invocations this turn, continuing loop to force real verification');
    // Fall through to re-feed — skip the Haiku call entirely.
  } else {
    const judgement = askHaiku(toolUses);
    switch (judgement.verdict) {
      case VERDICT.NO_FILE_CHANGES: {
        success('Haiku judged no file modifications - exiting loop.');
        remove(stateFile);
        allowStop();
        break; // unreachable after process.exit
      }
      case VERDICT.FILE_CHANGES: {
        // Clean verdict — fall through to re-feed.
        break;
      }
      case VERDICT.AMBIGUOUS: {
        const snippet = (judgement.raw || '').slice(0, 200);
        warn(`Haiku returned ambiguous answer ('${snippet}'), continuing loop as safety`);
        break;
      }
      case VERDICT.CLI_MISSING: {
        warn("'claude' CLI not found in PATH, continuing loop as safety");
        break;
      }
      case VERDICT.CLI_FAILED: {
        warn(`Haiku judgment call failed (exit ${judgement.exitCode}), continuing loop as safety`);
        break;
      }
      default: {
        warn(`Unexpected verdict type (${judgement.verdict}), continuing loop as safety`);
      }
    }
  }

  // 7. Bump iteration and re-feed the original prompt as the next user turn.
  const next = update(stateFile, { iteration: state.iteration + 1 });
  if (!next) {
    warn('Lost race updating state file iteration — exiting');
    remove(stateFile);
    allowStop();
  }

  blockAndRefeed(state.prompt);
}

main();
