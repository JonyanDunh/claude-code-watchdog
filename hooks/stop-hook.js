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
// Significantly rewritten for Watchdog by Jonyan Dunh, 2026:
//   - Cross-platform Node.js (no bash, no jq, no POSIX coreutils)
//   - All shared logic extracted into ../lib/ modules for code reuse
//   - v1.2.0: state file key switched from TERM_SESSION_ID (which most
//     terminals do NOT export) to the parent Claude Code process's PID,
//     discovered by walking the process ancestry. See lib/claude-pid.js.
//     This also removes the need for the `owner_session_id` recursion
//     guard — the headless Haiku subprocess has its own distinct Claude
//     Code PID, so its recursive Stop hook naturally looks up a
//     different state file path and never clobbers the main session's.
// See the NOTICE file at the repo root for a full summary of changes.

const { readStdinSync } = require('../lib/stdin');
const { info, warn, success, stop, debug } = require('../lib/log');
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
const { findClaudePid } = require('../lib/claude-pid');

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
  const t0 = Date.now();
  debug(`stop-hook.js entry — pid=${process.pid}, ppid=${process.ppid}, cwd=${process.cwd()}`);

  // 0. Find THIS session's Claude Code PID by walking process ancestry.
  //    This is our state-file naming key. If we can't find it (extremely
  //    unusual — should only happen outside a real Claude Code session),
  //    there is nothing we can safely act on, so allow the stop.
  const claudePid = findClaudePid();
  if (!claudePid) {
    debug('stop-hook.js: findClaudePid returned null, allowing stop');
    allowStop();
  }

  const stateFile = getStateFilePath(process.cwd(), claudePid);
  debug(`stop-hook.js: stateFile=${stateFile}`);

  // 1. No state file => no active watchdog for this Claude Code session
  //    => allow. This is also the natural recursion guard: when our
  //    headless `claude -p --model haiku ...` subprocess's own Stop hook
  //    fires, its findClaudePid() returns the HAIKU subprocess's PID
  //    (not the main session's), so the lookup below misses and the
  //    recursive hook exits silently without touching anything.
  if (!exists(stateFile)) {
    debug('stop-hook.js: no state file for this claudePid, allowing stop (likely Haiku recursion)');
    allowStop();
  }

  const state = read(stateFile);
  if (!isValid(state)) {
    warn('State file corrupted (missing iteration / max_iterations / prompt)');
    remove(stateFile);
    allowStop();
  }
  debug(
    `stop-hook.js: state loaded — iteration=${state.iteration}, max=${state.max_iterations}, prompt_head='${(state.prompt || '').slice(0, 60)}'`
  );

  // 2. Read hook input (JSON piped in on stdin by Claude Code).
  let hookInput;
  try {
    hookInput = JSON.parse(readStdinSync());
  } catch (err) {
    warn(`Failed to parse hook input JSON: ${err.message}`);
    remove(stateFile);
    allowStop();
  }

  // 3. Max iterations hard stop.
  if (state.max_iterations > 0 && state.iteration >= state.max_iterations) {
    stop(`Max iterations (${state.max_iterations}) reached.`);
    remove(stateFile);
    allowStop();
  }

  // 4. Transcript must exist for us to inspect tool invocations.
  const transcriptPath = hookInput.transcript_path;
  if (!transcriptPath || typeof transcriptPath !== 'string') {
    warn('Hook input missing transcript_path');
    remove(stateFile);
    allowStop();
  }

  let toolUses;
  try {
    toolUses = currentTurnToolUses(transcriptPath);
    debug(
      `stop-hook.js: extracted ${toolUses.length} tool_use entries from transcript — ${toolUses.map((t) => t.tool).join(', ')}`
    );
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

  // 5. Exit precondition: the agent must have invoked at least one tool.
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

  // 6. Bump iteration and re-feed the original prompt as the next user turn.
  const next = update(stateFile, { iteration: state.iteration + 1 });
  if (!next) {
    warn('Lost race updating state file iteration — exiting');
    remove(stateFile);
    allowStop();
  }

  debug(`stop-hook.js: total hook latency ${Date.now() - t0}ms, decision=block (continue loop)`);
  blockAndRefeed(state.prompt);
}

main();
