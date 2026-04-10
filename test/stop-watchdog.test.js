'use strict';

// Integration tests for stop-watchdog.js.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const STOP = path.resolve(__dirname, '..', 'scripts', 'stop-watchdog.js');
const SETUP = path.resolve(__dirname, '..', 'scripts', 'setup-watchdog.js');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-stop-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function run(script, args = [], env = {}) {
  return spawnSync('node', [script, ...args], {
    cwd: tmpDir,
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
  });
}

test('stop-watchdog without TERM_SESSION_ID => exit 1', () => {
  const env = Object.assign({}, process.env);
  delete env.TERM_SESSION_ID;
  const result = spawnSync('node', [STOP], {
    cwd: tmpDir,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TERM_SESSION_ID/);
});

test('stop-watchdog with no active watchdog => exit 0 + informational stdout', () => {
  const result = run(STOP, [], { TERM_SESSION_ID: 'nobody' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No active watchdog/);
});

test('stop-watchdog removes state file and reports iteration', () => {
  const sessionId = 'stop-happy-path';
  const setupResult = run(SETUP, ['do stuff'], { TERM_SESSION_ID: sessionId });
  assert.equal(setupResult.status, 0);

  const stateFile = path.join(tmpDir, '.claude', `watchdog.${sessionId}.local.json`);
  assert.equal(fs.existsSync(stateFile), true);

  const stopResult = run(STOP, [], { TERM_SESSION_ID: sessionId });
  assert.equal(stopResult.status, 0);
  assert.match(stopResult.stdout, /Cancelled watchdog/);
  assert.match(stopResult.stdout, /iteration 1/);
  assert.equal(fs.existsSync(stateFile), false);
});
