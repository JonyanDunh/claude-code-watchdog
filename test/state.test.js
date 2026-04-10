'use strict';

// State file lifecycle tests.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  getStateFilePath,
  exists,
  read,
  writeAtomic,
  update,
  remove,
  isValid,
  create,
} = require('../lib/state');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-state-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getStateFilePath returns null without TERM_SESSION_ID', () => {
  assert.equal(getStateFilePath(tmpDir, null), null);
  assert.equal(getStateFilePath(tmpDir, undefined), null);
  assert.equal(getStateFilePath(tmpDir, ''), null);
});

test('getStateFilePath joins cwd + .claude + per-session filename', () => {
  const p = getStateFilePath(tmpDir, 'abc-123');
  assert.equal(p, path.join(tmpDir, '.claude', 'watchdog.abc-123.local.json'));
});

test('create writes a valid state file with the expected shape', () => {
  const { filePath, state } = create({
    cwd: tmpDir,
    termSessionId: 'create-test-session',
    prompt: 'do the thing',
    maxIterations: 20,
  });
  assert.equal(exists(filePath), true);
  assert.equal(state.active, true);
  assert.equal(state.iteration, 1);
  assert.equal(state.max_iterations, 20);
  assert.equal(state.term_session_id, 'create-test-session');
  assert.equal(state.prompt, 'do the thing');
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(state.started_at));
  const onDisk = read(filePath);
  assert.deepEqual(onDisk, state);
  remove(filePath);
});

test('create throws if termSessionId is falsy', () => {
  assert.throws(
    () => create({ cwd: tmpDir, termSessionId: null, prompt: 'x', maxIterations: 0 }),
    /TERM_SESSION_ID/
  );
});

test('update merges the patch and persists atomically', () => {
  const { filePath } = create({
    cwd: tmpDir,
    termSessionId: 'update-test-session',
    prompt: 'do the thing',
    maxIterations: 5,
  });
  const merged = update(filePath, { iteration: 3, owner_session_id: 'sess-xyz' });
  assert.equal(merged.iteration, 3);
  assert.equal(merged.owner_session_id, 'sess-xyz');
  assert.equal(merged.prompt, 'do the thing');

  const onDisk = read(filePath);
  assert.equal(onDisk.iteration, 3);
  assert.equal(onDisk.owner_session_id, 'sess-xyz');
  remove(filePath);
});

test('update returns null if the state file does not exist', () => {
  const ghost = path.join(tmpDir, 'nope', 'ghost.json');
  assert.equal(update(ghost, { iteration: 99 }), null);
});

test('remove is idempotent — returns false if nothing to delete', () => {
  const ghost = path.join(tmpDir, 'never-existed.json');
  assert.equal(remove(ghost), false);
});

test('writeAtomic creates parent dir if missing', () => {
  const nested = path.join(tmpDir, 'deep', 'nest', 'state.json');
  writeAtomic(nested, { iteration: 1, max_iterations: 10, prompt: 'x', active: true });
  assert.equal(exists(nested), true);
});

test('isValid rejects bad shapes', () => {
  assert.equal(isValid(null), false);
  assert.equal(isValid({}), false);
  assert.equal(isValid({ iteration: 1 }), false);
  assert.equal(isValid({ iteration: 'x', max_iterations: 0, prompt: 'p' }), false);
  assert.equal(isValid({ iteration: 1, max_iterations: 0, prompt: '' }), false);
  assert.equal(isValid({ iteration: 1, max_iterations: 0, prompt: 'hi' }), true);
});

test('read returns null for missing or malformed files', () => {
  assert.equal(read(path.join(tmpDir, 'nope.json')), null);
  const corrupt = path.join(tmpDir, 'corrupt.json');
  fs.writeFileSync(corrupt, 'not json');
  assert.equal(read(corrupt), null);
  fs.unlinkSync(corrupt);
});
