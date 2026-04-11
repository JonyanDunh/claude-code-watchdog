#!/usr/bin/env node
'use strict';

// Watchdog cancel script (Node.js). Removes the per-session state file so
// the Stop hook stops re-feeding the prompt. Idempotent: exits cleanly
// with an informational message if no active loop exists.
//
// Originally derived from the ralph-loop plugin's cancel-ralph command.
// Copyright Anthropic, PBC. Licensed under the Apache License, Version 2.0.
// Node.js rewrite by Jonyan Dunh, 2026.

const { error, debug } = require('../lib/log');
const { getStateFilePath, exists, read, remove } = require('../lib/state');
const { findClaudePid } = require('../lib/claude-pid');

function main() {
  // Same ancestry walk as setup — finds THIS session's Claude Code PID so we
  // target exactly the right state file. Concurrent sessions in the same
  // project directory are cleanly isolated: /watchdog:stop in one session
  // never touches another session's state file.
  const claudePid = findClaudePid();
  if (!claudePid) {
    error('Could not find the Claude Code process in this script\'s ancestry');
    process.stderr.write('   Cannot locate this session\'s state file without its Claude Code PID.\n');
    process.exit(1);
  }

  const filePath = getStateFilePath(process.cwd(), claudePid);
  debug(`stop-watchdog.js: targeting state file ${filePath} (claudePid=${claudePid})`);

  if (!exists(filePath)) {
    debug('stop-watchdog.js: state file does not exist');
    process.stdout.write('No active watchdog for this session.\n');
    process.exit(0);
  }

  // Best-effort iteration read for a friendlier message.
  const state = read(filePath);
  const iter = state && Number.isInteger(state.iteration) ? state.iteration : '?';

  remove(filePath);
  debug(`stop-watchdog.js: removed state file at iteration ${iter}`);
  process.stdout.write(`Cancelled watchdog (was at iteration ${iter}).\n`);
  process.exit(0);
}

main();
