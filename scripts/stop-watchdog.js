#!/usr/bin/env node
'use strict';

// Watchdog cancel script (Node.js). Removes the per-session state file so
// the Stop hook stops re-feeding the prompt. Idempotent: exits cleanly
// with an informational message if no active loop exists.
//
// Originally derived from the ralph-loop plugin's cancel-ralph command.
// Copyright Anthropic, PBC. Licensed under the Apache License, Version 2.0.
// Node.js rewrite by Jonyan Dunh, 2026.

const { error } = require('../lib/log');
const { getStateFilePath, exists, read, remove } = require('../lib/state');

function main() {
  const termSessionId = process.env.TERM_SESSION_ID;
  if (!termSessionId) {
    error('TERM_SESSION_ID is not set in the environment');
    process.stderr.write('   Cannot locate the per-session state file without a terminal UUID.\n');
    process.exit(1);
  }

  const filePath = getStateFilePath(process.cwd(), termSessionId);

  if (!exists(filePath)) {
    process.stdout.write('No active watchdog for this session.\n');
    process.exit(0);
  }

  // Best-effort iteration read for a friendlier message.
  const state = read(filePath);
  const iter = state && Number.isInteger(state.iteration) ? state.iteration : '?';

  remove(filePath);
  process.stdout.write(`Cancelled watchdog (was at iteration ${iter}).\n`);
  process.exit(0);
}

main();
