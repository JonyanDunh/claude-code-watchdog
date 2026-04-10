'use strict';

// Integration tests for setup-watchdog.js — run it as a real subprocess with
// various arg combinations and verify stdout/stderr/exit code + state file.

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
  const result = runSetup([], { TERM_SESSION_ID: 'any' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No prompt provided/);
  assert.match(result.stderr, /\/watchdog:help/);
});

test('setup without TERM_SESSION_ID => exit 1 with clear error', () => {
  const env = Object.assign({}, process.env);
  delete env.TERM_SESSION_ID;
  const result = spawnSync('node', [SETUP, 'do something'], {
    cwd: tmpDir,
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TERM_SESSION_ID/);
});

test('setup with prompt creates state file, echoes prompt to stdout', () => {
  const sessionId = 'setup-happy-path';
  const result = runSetup(['do the refactor'], { TERM_SESSION_ID: sessionId });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), 'do the refactor');
  // stderr should be empty — the agent never sees loop metadata
  assert.equal(result.stderr, '');

  const stateFile = path.join(tmpDir, '.claude', `watchdog.${sessionId}.local.json`);
  assert.equal(fs.existsSync(stateFile), true);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.prompt, 'do the refactor');
  assert.equal(state.iteration, 1);
  assert.equal(state.max_iterations, 0);
  assert.equal(state.term_session_id, sessionId);
  fs.unlinkSync(stateFile);
});

test('setup with --max-iterations 20 stores the cap', () => {
  const sessionId = 'setup-with-max';
  const result = runSetup(
    ['refactor cache', '--max-iterations', '20'],
    { TERM_SESSION_ID: sessionId }
  );
  assert.equal(result.status, 0);
  const stateFile = path.join(tmpDir, '.claude', `watchdog.${sessionId}.local.json`);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.max_iterations, 20);
  assert.equal(state.prompt, 'refactor cache');
  fs.unlinkSync(stateFile);
});

test('setup rejects --max-iterations without a number', () => {
  const result = runSetup(['--max-iterations'], { TERM_SESSION_ID: 'x' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--max-iterations requires/);
});

test('setup rejects non-integer --max-iterations', () => {
  const result = runSetup(['--max-iterations', '3.5', 'prompt'], { TERM_SESSION_ID: 'x' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /non-negative integer/);
});

test('setup accepts --max-iterations before positional prompt', () => {
  const sessionId = 'setup-order-ind';
  const result = runSetup(['--max-iterations', '5', 'fix bug'], { TERM_SESSION_ID: sessionId });
  assert.equal(result.status, 0);
  const stateFile = path.join(tmpDir, '.claude', `watchdog.${sessionId}.local.json`);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.max_iterations, 5);
  assert.equal(state.prompt, 'fix bug');
  fs.unlinkSync(stateFile);
});

test('setup joins multi-word positional args with spaces', () => {
  const sessionId = 'setup-multiword';
  const result = runSetup(
    ['fix', 'the', 'auth', 'bug', '--max-iterations', '10'],
    { TERM_SESSION_ID: sessionId }
  );
  assert.equal(result.status, 0);
  const stateFile = path.join(tmpDir, '.claude', `watchdog.${sessionId}.local.json`);
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.prompt, 'fix the auth bug');
  fs.unlinkSync(stateFile);
});
