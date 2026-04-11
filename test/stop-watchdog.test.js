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

function stateFileFor(pid) {
  return path.join(tmpDir, '.claude', `watchdog.claudepid.${pid}.local.json`);
}

test('stop-watchdog with no discoverable Claude Code PID => exit 1', { skip: !!process.env.CLAUDECODE }, () => {
  // Only meaningful when the test runner isn't itself running inside a
  // Claude Code session — otherwise the ancestry walk succeeds.
  const env = Object.assign({}, process.env);
  delete env.WATCHDOG_CLAUDE_PID;
  delete env.CLAUDECODE;
  const result = spawnSync('node', [STOP], {
    cwd: tmpDir,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Claude Code process/i);
});

test('stop-watchdog with no active watchdog for this PID => exit 0 + informational stdout', () => {
  const result = run(STOP, [], { WATCHDOG_CLAUDE_PID: '400001' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /No active watchdog/);
});

test('stop-watchdog removes state file and reports iteration', () => {
  const pid = 400002;
  const setupResult = run(SETUP, ['do stuff'], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(setupResult.status, 0);

  const stateFile = stateFileFor(pid);
  assert.equal(fs.existsSync(stateFile), true);

  const stopResult = run(STOP, [], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(stopResult.status, 0);
  assert.match(stopResult.stdout, /Cancelled watchdog/);
  assert.match(stopResult.stdout, /iteration 1/);
  assert.equal(fs.existsSync(stateFile), false);
});

test('stop-watchdog only removes the targeted session state file, not others', () => {
  // Create three concurrent session state files.
  run(SETUP, ['task A'], { WATCHDOG_CLAUDE_PID: '400101' });
  run(SETUP, ['task B'], { WATCHDOG_CLAUDE_PID: '400102' });
  run(SETUP, ['task C'], { WATCHDOG_CLAUDE_PID: '400103' });

  const fileA = stateFileFor(400101);
  const fileB = stateFileFor(400102);
  const fileC = stateFileFor(400103);
  assert.equal(fs.existsSync(fileA), true);
  assert.equal(fs.existsSync(fileB), true);
  assert.equal(fs.existsSync(fileC), true);

  // Stop ONLY session B.
  const stopResult = run(STOP, [], { WATCHDOG_CLAUDE_PID: '400102' });
  assert.equal(stopResult.status, 0);
  assert.match(stopResult.stdout, /Cancelled watchdog/);

  // Sessions A and C should still be alive.
  assert.equal(fs.existsSync(fileA), true);
  assert.equal(fs.existsSync(fileB), false);
  assert.equal(fs.existsSync(fileC), true);

  // Clean up the survivors.
  fs.unlinkSync(fileA);
  fs.unlinkSync(fileC);
});
