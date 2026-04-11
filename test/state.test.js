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
  listAll,
} = require('../lib/state');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-state-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getStateFilePath returns null for invalid claudePid', () => {
  assert.equal(getStateFilePath(tmpDir, null), null);
  assert.equal(getStateFilePath(tmpDir, undefined), null);
  assert.equal(getStateFilePath(tmpDir, 0), null);
  assert.equal(getStateFilePath(tmpDir, -5), null);
  assert.equal(getStateFilePath(tmpDir, 1.5), null);
  assert.equal(getStateFilePath(tmpDir, '42'), null); // must be number, not string
});

test('getStateFilePath joins cwd + .claude + watchdog.claudepid.<PID>.local.json', () => {
  const p = getStateFilePath(tmpDir, 12345);
  assert.equal(p, path.join(tmpDir, '.claude', 'watchdog.claudepid.12345.local.json'));
});

test('create writes a valid state file with the expected shape', () => {
  const { filePath, state } = create({
    cwd: tmpDir,
    claudePid: 100001,
    prompt: 'do the thing',
    maxIterations: 20,
  });
  assert.equal(exists(filePath), true);
  assert.equal(state.active, true);
  assert.equal(state.iteration, 1);
  assert.equal(state.max_iterations, 20);
  assert.equal(state.claude_pid, 100001);
  assert.equal(state.prompt, 'do the thing');
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(state.started_at));
  const onDisk = read(filePath);
  assert.deepEqual(onDisk, state);
  remove(filePath);
});

test('create throws if claudePid is invalid', () => {
  assert.throws(
    () => create({ cwd: tmpDir, claudePid: null, prompt: 'x', maxIterations: 0 }),
    /claudePid/
  );
  assert.throws(
    () => create({ cwd: tmpDir, claudePid: 0, prompt: 'x', maxIterations: 0 }),
    /claudePid/
  );
  assert.throws(
    () => create({ cwd: tmpDir, claudePid: -1, prompt: 'x', maxIterations: 0 }),
    /claudePid/
  );
});

test('update merges the patch and persists atomically', () => {
  const { filePath } = create({
    cwd: tmpDir,
    claudePid: 100002,
    prompt: 'do the thing',
    maxIterations: 5,
  });
  const merged = update(filePath, { iteration: 3, some_extra_field: 'hello' });
  assert.equal(merged.iteration, 3);
  assert.equal(merged.some_extra_field, 'hello');
  assert.equal(merged.prompt, 'do the thing');
  assert.equal(merged.claude_pid, 100002);

  const onDisk = read(filePath);
  assert.equal(onDisk.iteration, 3);
  assert.equal(onDisk.some_extra_field, 'hello');
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

test('listAll enumerates all watchdog state files in .claude/', () => {
  // Create three separate watchdog state files with different claude pids
  const listDir = fs.mkdtempSync(path.join(tmpDir, 'list-test-'));
  create({ cwd: listDir, claudePid: 1001, prompt: 'p1', maxIterations: 0 });
  create({ cwd: listDir, claudePid: 1002, prompt: 'p2', maxIterations: 0 });
  create({ cwd: listDir, claudePid: 1003, prompt: 'p3', maxIterations: 0 });

  // Also drop a non-watchdog file in the same dir to confirm it's filtered out
  fs.writeFileSync(path.join(listDir, '.claude', 'unrelated.json'), '{}');

  const files = listAll(listDir).sort();
  assert.equal(files.length, 3);
  assert.ok(files[0].endsWith('watchdog.claudepid.1001.local.json'));
  assert.ok(files[1].endsWith('watchdog.claudepid.1002.local.json'));
  assert.ok(files[2].endsWith('watchdog.claudepid.1003.local.json'));
});

test('listAll returns [] when .claude/ does not exist', () => {
  const emptyDir = fs.mkdtempSync(path.join(tmpDir, 'empty-'));
  assert.deepEqual(listAll(emptyDir), []);
});
