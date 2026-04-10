'use strict';

// State file management. The state file is a small JSON document keyed by
// TERM_SESSION_ID (so multiple terminal tabs never collide). All writes are
// atomic (temp file + rename) so a racing reader — for example a second
// Stop hook invocation — never sees a half-written file.

const fs = require('fs');
const path = require('path');
const { stateFilePath } = require('./constants');

function getStateFilePath(cwd, termSessionId) {
  if (!termSessionId) return null;
  return stateFilePath(cwd, termSessionId);
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

function create({ cwd, termSessionId, prompt, maxIterations }) {
  const filePath = getStateFilePath(cwd, termSessionId);
  if (!filePath) {
    throw new Error('TERM_SESSION_ID is required to create a state file');
  }
  const state = {
    active: true,
    iteration: 1,
    max_iterations: maxIterations,
    term_session_id: termSessionId,
    started_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    prompt,
  };
  writeAtomic(filePath, state);
  return { filePath, state };
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
};
