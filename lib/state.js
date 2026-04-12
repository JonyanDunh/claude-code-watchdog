'use strict';

// State file management. The state file is a small JSON document keyed by
// the Claude Code process ID (see lib/claude-pid.js). Every Claude Code
// session has a distinct PID, so concurrent sessions in the same project
// directory never collide — each gets its own .claude/watchdog.claudepid.<PID>.local.json.
// Atomic writes via temp file + rename so a racing reader (e.g. a second
// Stop hook invocation) never sees a half-written file.

const fs = require('fs');
const path = require('path');
const { stateFilePath, stateFileDir, STATE_FILE_GLOB } = require('./constants');

function getStateFilePath(cwd, claudePid) {
  if (!claudePid || !Number.isInteger(claudePid) || claudePid <= 0) return null;
  return stateFilePath(cwd, claudePid);
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function read(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeAtomic(filePath, state) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, filePath);
}

function update(filePath, patch) {
  const current = read(filePath);
  if (!current) return null;
  const next = Object.assign({}, current, patch);
  writeAtomic(filePath, next);
  return next;
}

function remove(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function isValid(state) {
  if (!state || typeof state !== 'object') return false;
  if (typeof state.iteration !== 'number' || !Number.isInteger(state.iteration)) return false;
  if (typeof state.max_iterations !== 'number' || !Number.isInteger(state.max_iterations)) return false;
  if (typeof state.prompt !== 'string' || state.prompt.length === 0) return false;
  return true;
}

function create({
  cwd,
  claudePid,
  prompt,
  maxIterations,
  exitConfirmations = 1,
  promptFile = null,
  watchPromptFile = false,
  noClassifier = false,
}) {
  const filePath = getStateFilePath(cwd, claudePid);
  if (!filePath) {
    throw new Error('A positive integer claudePid is required to create a state file');
  }
  const state = {
    active: true,
    iteration: 1,
    max_iterations: maxIterations,
    claude_pid: claudePid,
    started_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    prompt,
    // v1.3.0 — convergence streak. The stop hook only allows the loop to
    // exit after `exit_confirmations` consecutive NO_FILE_CHANGES verdicts
    // from the Haiku classifier. Any other verdict, plus pure-text turns
    // and prompt hot-reloads, reset `no_change_streak` to 0. Default 1
    // preserves the pre-1.3.0 behavior bit-for-bit.
    exit_confirmations: exitConfirmations,
    no_change_streak: 0,
    // v1.3.0 — prompt hot-reload. When the user passes both --prompt-file
    // and --watch-prompt-file, the stop hook re-reads `prompt_file` on
    // every iteration and updates `prompt` if the content changed. If the
    // file is missing or unreadable at hot-reload time, the cached prompt
    // is preserved silently — the loop never crashes on a vanished file.
    // `prompt_file` is the resolved absolute path captured at create-time,
    // not the raw user-typed string, so a relative path keeps working even
    // if the loop's cwd changes between iterations.
    prompt_file: promptFile,
    watch_prompt_file: watchPromptFile,
    // v1.3.0 — disable the Haiku classifier entirely. The loop only exits
    // via --max-iterations or /watchdog:stop. Mutually exclusive with
    // --exit-confirmations at the CLI parse level (the streak counter is
    // never read in this mode).
    no_classifier: noClassifier,
  };
  writeAtomic(filePath, state);
  return { filePath, state };
}

// List every watchdog state file under `<cwd>/.claude/`. Used by
// stop-watchdog.js only in the fallback path where we can't discover
// the current session's Claude PID (should never happen in practice).
function listAll(cwd) {
  const dir = stateFileDir(cwd);
  try {
    const entries = fs.readdirSync(dir);
    const prefix = 'watchdog.claudepid.';
    const suffix = '.local.json';
    return entries
      .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

module.exports = {
  getStateFilePath,
  exists,
  read,
  writeAtomic,
  update,
  remove,
  isValid,
  create,
  listAll,
  STATE_FILE_GLOB,
};
