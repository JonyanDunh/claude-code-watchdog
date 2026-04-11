'use strict';

// Integration tests for setup-watchdog.js — run it as a real subprocess with
// various arg combinations and verify stdout/stderr/exit code + state file.
//
// Tests inject WATCHDOG_CLAUDE_PID to bypass the process ancestry walk
// (which would otherwise return null outside a real Claude Code session).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const SETUP = path.resolve(__dirname, '..', 'scripts', 'setup-watchdog.js');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-setup-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runSetup(args, env = {}) {
  return spawnSync('node', [SETUP, ...args], {
    cwd: tmpDir,
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function stateFileFor(pid) {
  return path.join(tmpDir, '.claude', `watchdog.claudepid.${pid}.local.json`);
}

test('setup --help prints stderr pointer and empty stdout', () => {
  const result = runSetup(['--help']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /\/watchdog:help/);
  assert.match(result.stderr, /Quick usage/);
});

test('setup -h behaves the same as --help', () => {
  const result = runSetup(['-h']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('setup with empty args => exit 1 + helpful stderr', () => {
  const result = runSetup([], { WATCHDOG_CLAUDE_PID: '111' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No prompt provided/);
  assert.match(result.stderr, /\/watchdog:help/);
});

test('setup without a discoverable Claude Code PID => exit 1 with clear error', { skip: !!process.env.CLAUDECODE }, () => {
  // This test only makes sense when the test runner itself is NOT inside
  // a Claude Code session. If CLAUDECODE=1 is set, the process ancestry
  // walk WILL succeed (it finds the parent Claude Code), and setup will
  // not fail — so we skip the assertion.
  const env = Object.assign({}, process.env);
  delete env.WATCHDOG_CLAUDE_PID;
  delete env.CLAUDECODE;
  const result = spawnSync('node', [SETUP, 'do something'], {
    cwd: tmpDir,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Claude Code process/i);
  assert.match(result.stderr, /WATCHDOG_CLAUDE_PID/);
});

test('setup with prompt creates state file, echoes prompt to stdout', () => {
  const pid = 200001;
  const result = runSetup(['do the refactor'], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout.trim(), 'do the refactor');
  // stderr should be empty — the agent never sees loop metadata
  assert.equal(result.stderr, '');

  const stateFile = stateFileFor(pid);
  assert.equal(fs.existsSync(stateFile), true);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.prompt, 'do the refactor');
  assert.equal(state.iteration, 1);
  assert.equal(state.max_iterations, 0);
  assert.equal(state.claude_pid, pid);
  fs.unlinkSync(stateFile);
});

test('setup with --max-iterations 20 stores the cap', () => {
  const pid = 200002;
  const result = runSetup(
    ['refactor cache', '--max-iterations', '20'],
    { WATCHDOG_CLAUDE_PID: String(pid) }
  );
  assert.equal(result.status, 0);
  const stateFile = stateFileFor(pid);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.max_iterations, 20);
  assert.equal(state.prompt, 'refactor cache');
  fs.unlinkSync(stateFile);
});

test('setup rejects --max-iterations without a number', () => {
  const result = runSetup(['--max-iterations'], { WATCHDOG_CLAUDE_PID: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--max-iterations requires/);
});

test('setup rejects non-integer --max-iterations', () => {
  const result = runSetup(['--max-iterations', '3.5', 'prompt'], { WATCHDOG_CLAUDE_PID: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-negative integer/);
});

test('setup accepts --max-iterations before positional prompt', () => {
  const pid = 200003;
  const result = runSetup(['--max-iterations', '5', 'fix bug'], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0);
  const stateFile = stateFileFor(pid);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.max_iterations, 5);
  assert.equal(state.prompt, 'fix bug');
  fs.unlinkSync(stateFile);
});

test('setup joins multi-word positional args with spaces', () => {
  const pid = 200004;
  const result = runSetup(
    ['fix', 'the', 'auth', 'bug', '--max-iterations', '10'],
    { WATCHDOG_CLAUDE_PID: String(pid) }
  );
  assert.equal(result.status, 0);
  const stateFile = stateFileFor(pid);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.prompt, 'fix the auth bug');
  fs.unlinkSync(stateFile);
});

test('concurrent setups with different claudePids produce independent state files', () => {
  // Simulate two concurrent Claude Code sessions in the same repo.
  runSetup(['session A task'], { WATCHDOG_CLAUDE_PID: '300001' });
  runSetup(['session B task'], { WATCHDOG_CLAUDE_PID: '300002' });

  const fileA = stateFileFor(300001);
  const fileB = stateFileFor(300002);
  assert.equal(fs.existsSync(fileA), true);
  assert.equal(fs.existsSync(fileB), true);

  const stateA = JSON.parse(fs.readFileSync(fileA, 'utf8'));
  const stateB = JSON.parse(fs.readFileSync(fileB, 'utf8'));
  assert.equal(stateA.prompt, 'session A task');
  assert.equal(stateB.prompt, 'session B task');
  assert.equal(stateA.claude_pid, 300001);
  assert.equal(stateB.claude_pid, 300002);

  fs.unlinkSync(fileA);
  fs.unlinkSync(fileB);
});
