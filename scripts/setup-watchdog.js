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
const { readPromptFile } = require('../lib/prompt-file');

function parseArgs(argv) {
  const promptParts = [];
  let maxIterations = 0;
  let promptFile = null;
  // exitConfirmations stays undefined when the user did NOT pass the flag.
  // The distinction matters because `--no-classifier` + `--exit-confirmations`
  // is a hard error: if we defaulted to 1 here we couldn't tell whether the
  // user explicitly typed `--exit-confirmations 1` (which should error) or
  // just left the flag off (which should be silently allowed).
  let exitConfirmations;
  let watchPromptFile = false;
  let noClassifier = false;
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
    if (token === '--prompt-file') {
      const next = argv[i + 1];
      if (next === undefined) {
        return { error: '--prompt-file requires a path argument' };
      }
      promptFile = next;
      i += 1;
      continue;
    }
    if (token === '--exit-confirmations') {
      const next = argv[i + 1];
      if (next === undefined) {
        return { error: '--exit-confirmations requires a positive integer argument' };
      }
      if (!/^\d+$/.test(next)) {
        return { error: `--exit-confirmations must be a positive integer, got: ${next}` };
      }
      const n = Number(next);
      if (n < 1) {
        // Zero would mean "exit before Haiku ever judges anything", which
        // is functionally equivalent to disabling the loop — pointless and
        // almost certainly a typo. Force >= 1.
        return { error: `--exit-confirmations must be >= 1, got: ${next}` };
      }
      exitConfirmations = n;
      i += 1;
      continue;
    }
    if (token === '--watch-prompt-file') {
      // Boolean flag; no value follows. Validity (must be paired with
      // --prompt-file) is checked in main() after the full parse, so the
      // error message can mention the missing companion flag explicitly.
      watchPromptFile = true;
      continue;
    }
    if (token === '--no-classifier') {
      // Boolean flag; no value follows. Mutual exclusion with
      // --exit-confirmations is checked in main().
      noClassifier = true;
      continue;
    }
    promptParts.push(token);
  }

  return {
    promptParts,
    maxIterations,
    promptFile,
    exitConfirmations,
    watchPromptFile,
    noClassifier,
    help,
  };
}

// readPromptFile() lives in lib/prompt-file.js so the stop hook can reuse
// the exact same BOM strip / trim / error mapping when --watch-prompt-file
// hot-reloads the prompt mid-loop. See that file for the full path-handling
// commentary.

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
    '    /watchdog:start --prompt-file <path> [--watch-prompt-file] [--max-iterations N]',
    '    /watchdog:start "..." --exit-confirmations 3 --max-iterations 20',
    '    /watchdog:start "..." --no-classifier            # no --max-iterations = unlimited',
    '    /watchdog:stop',
    '',
    '  --max-iterations is optional. Omit it for an unlimited loop',
    '  (only convergence or /watchdog:stop will exit).',
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

  // --prompt-file and inline positional prompt are mutually exclusive.
  // Supporting both would force us to invent a merge policy (prepend?
  // append? error?) and every choice is surprising. Require exactly one.
  if (parsed.promptFile && parsed.promptParts.length > 0) {
    error('--prompt-file cannot be combined with a positional prompt');
    process.stderr.write('   Pick one: either pass the prompt inline, or use --prompt-file <path>.\n');
    process.exit(1);
  }

  // --watch-prompt-file is meaningless without --prompt-file (there is no
  // file to watch). The hot-reload code in stop-hook.js keys off both
  // fields together, so this combination would silently do nothing —
  // surface it as an error so the user gets immediate feedback.
  if (parsed.watchPromptFile && !parsed.promptFile) {
    error('--watch-prompt-file requires --prompt-file');
    process.stderr.write('   Hot-reload only makes sense when the prompt comes from a file.\n');
    process.stderr.write('   Add --prompt-file <path> or drop --watch-prompt-file.\n');
    process.exit(1);
  }

  // --no-classifier disables the Haiku judgment loop entirely; the streak
  // counter is never read in that mode. Combining the two is almost
  // certainly user confusion — fail loudly so they pick one consciously.
  if (parsed.noClassifier && parsed.exitConfirmations !== undefined) {
    error('--no-classifier cannot be combined with --exit-confirmations');
    process.stderr.write('   --no-classifier disables Haiku entirely, so the convergence streak\n');
    process.stderr.write('   counted by --exit-confirmations is never incremented. The loop will\n');
    process.stderr.write('   only exit via --max-iterations or /watchdog:stop.\n');
    process.stderr.write('   Pick one: either drop --no-classifier or drop --exit-confirmations.\n');
    process.exit(1);
  }

  let prompt;
  let resolvedPromptFile = null;
  if (parsed.promptFile) {
    const result = readPromptFile(parsed.promptFile);
    if (result.error) {
      error(result.error);
      process.exit(1);
    }
    prompt = result.prompt;
    // Capture the resolved absolute path so the stop hook's hot-reload
    // path doesn't have to re-resolve a relative path against a possibly-
    // different cwd later.
    resolvedPromptFile = result.resolvedPath;
  } else {
    prompt = parsed.promptParts.join(' ').trim();
  }

  if (!prompt) {
    error('No prompt provided');
    process.stderr.write('\n');
    process.stderr.write('   Watchdog needs a task description to work on.\n');
    process.stderr.write('\n');
    process.stderr.write('   Examples:\n');
    process.stderr.write('     /watchdog:start "Build a REST API for todos"\n');
    process.stderr.write('     /watchdog:start "Fix the auth bug" --max-iterations 20\n');
    process.stderr.write('     /watchdog:start --prompt-file ./tmp/my-prompt.txt --max-iterations 20\n');
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
    // exit_confirmations defaults to 1 inside create() when undefined,
    // which preserves the pre-1.3.0 single-confirmation exit semantics.
    exitConfirmations: parsed.exitConfirmations,
    promptFile: resolvedPromptFile,
    watchPromptFile: parsed.watchPromptFile,
    noClassifier: parsed.noClassifier,
  });
  debug(
    `setup-watchdog.js: created state file ${filePath} — claudePid=${claudePid}, max=${parsed.maxIterations}, exit_confirmations=${parsed.exitConfirmations || 1}, watch=${parsed.watchPromptFile}, no_classifier=${parsed.noClassifier}, prompt_file=${resolvedPromptFile || 'none'}, prompt_head='${prompt.slice(0, 60)}'`
  );

  // Output ONLY the user's prompt to stdout. Everything Claude Code captures
  // from stdout becomes the first user turn of the loop, and the agent must
  // never know it is running inside a watchdog. No banners, no iteration
  // counters, no status messages.
  process.stdout.write(`${prompt}\n`);
  process.exit(0);
}

main();
