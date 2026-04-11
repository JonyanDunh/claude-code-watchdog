#!/usr/bin/env node
'use strict';

// Watchdog setup script (Node.js). Parses args, creates the per-session
// state file, and prints the prompt to stdout so Claude Code injects it
// as the first user turn of the loop. Every diagnostic goes to stderr so
// the agent never sees loop metadata.
//
// Originally derived from the ralph-loop plugin's setup-ralph-loop.sh.
// Copyright Anthropic, PBC. Licensed under the Apache License, Version 2.0.
// Node.js rewrite by Jonyan Dunh, 2026 — replaces bash, jq, and POSIX
// coreutils with a single cross-platform Node file. See NOTICE at the
// repo root for the full change list.

const { error, debug } = require('../lib/log');
const { create } = require('../lib/state');
const { findClaudePid } = require('../lib/claude-pid');

function parseArgs(argv) {
  const promptParts = [];
  let maxIterations = 0;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      help = true;
      continue;
    }
    if (token === '--max-iterations') {
      const next = argv[i + 1];
      if (next === undefined) {
        return { error: '--max-iterations requires a number argument' };
      }
      if (!/^\d+$/.test(next)) {
        return { error: `--max-iterations must be a non-negative integer, got: ${next}` };
      }
      maxIterations = Number(next);
      i += 1;
      continue;
    }
    promptParts.push(token);
  }

  return { promptParts, maxIterations, help };
}

function printHelp() {
  // Help is intentionally short and routed to stderr so the slash command's
  // stdout stays empty — empty stdout means Claude Code does not feed a user
  // turn to the agent, and the agent won't respond with a noisy
  // "this is informational" acknowledgement. Full reference lives in
  // commands/help.md, surfaced via /watchdog:help inside Claude Code.
  const lines = [
    'Watchdog — for the full reference, run inside Claude Code:',
    '',
    '    /watchdog:help',
    '',
    'Quick usage:',
    '    /watchdog:start "<your prompt>" [--max-iterations N]',
    '    /watchdog:stop',
  ];
  for (const line of lines) process.stderr.write(`${line}\n`);
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.error) {
    error(parsed.error);
    process.exit(1);
  }

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const prompt = parsed.promptParts.join(' ').trim();
  if (!prompt) {
    error('No prompt provided');
    process.stderr.write('\n');
    process.stderr.write('   Watchdog needs a task description to work on.\n');
    process.stderr.write('\n');
    process.stderr.write('   Examples:\n');
    process.stderr.write('     /watchdog:start "Build a REST API for todos"\n');
    process.stderr.write('     /watchdog:start "Fix the auth bug" --max-iterations 20\n');
    process.stderr.write('     /watchdog:start "Refactor the cache layer" --max-iterations 20\n');
    process.stderr.write('\n');
    process.stderr.write('   For the full reference: /watchdog:help\n');
    process.exit(1);
  }

  // Key the state file by Claude Code's own PID, discovered by walking the
  // process ancestry. Works on any terminal / any platform without needing
  // the user to export TERM_SESSION_ID. See lib/claude-pid.js.
  const claudePid = findClaudePid();
  if (!claudePid) {
    error('Could not find the Claude Code process in this script\'s ancestry');
    process.stderr.write('   Watchdog uses the parent Claude Code process ID as its per-session key.\n');
    process.stderr.write('   This is extremely unusual — Watchdog expects to run inside a Claude Code\n');
    process.stderr.write('   slash command, which is always a descendant of a `claude` process.\n');
    process.stderr.write('\n');
    process.stderr.write('   If you are running this script manually for testing, set the\n');
    process.stderr.write('   WATCHDOG_CLAUDE_PID env var to any positive integer to override the\n');
    process.stderr.write('   ancestry walk.\n');
    process.exit(1);
  }

  const { filePath } = create({
    cwd: process.cwd(),
    claudePid,
    prompt,
    maxIterations: parsed.maxIterations,
  });
  debug(
    `setup-watchdog.js: created state file ${filePath} — claudePid=${claudePid}, max=${parsed.maxIterations}, prompt_head='${prompt.slice(0, 60)}'`
  );

  // Output ONLY the user's prompt to stdout. Everything Claude Code captures
  // from stdout becomes the first user turn of the loop, and the agent must
  // never know it is running inside a watchdog. No banners, no iteration
  // counters, no status messages.
  process.stdout.write(`${prompt}\n`);
  process.exit(0);
}

main();
