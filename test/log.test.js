'use strict';

// Unit tests for lib/log.js — specifically the optional file-logging
// path gated by CLAUDE_CODE_WATCHDOG_LOG_ENABLED=1.
//
// We can't import lib/log.js directly and then flip the env var, because
// the module captures LOG_ENABLED at load time. So each test spawns a
// throwaway node subprocess with the env var set, runs a one-liner that
// calls each log level, and then reads back the log file.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-log-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runChildWithLogging(snippet, extraEnv = {}) {
  return spawnSync('node', ['-e', snippet], {
    env: Object.assign({}, process.env, extraEnv),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('with logging DISABLED (default) the log file is NOT created', () => {
  const logFile = path.join(tmpDir, 'default-disabled.log');
  // Explicitly ensure the env var is unset in the child.
  const env = Object.assign({}, process.env);
  delete env.CLAUDE_CODE_WATCHDOG_LOG_ENABLED;
  env.CLAUDE_CODE_WATCHDOG_LOG_FILE = logFile;
  const result = spawnSync(
    'node',
    ['-e', `const l=require('./lib/log'); l.info('x'); l.debug('y');`],
    { env, encoding: 'utf8', cwd: path.resolve(__dirname, '..') }
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Watchdog: x/);
  // Debug should be silent when disabled.
  assert.doesNotMatch(result.stderr, /y/);
  assert.equal(fs.existsSync(logFile), false);
});

test('with logging ENABLED, info/warn/success/stop/error all mirror to the log file', () => {
  const logFile = path.join(tmpDir, 'enabled-mirror.log');
  const snippet = `
    const l = require('./lib/log');
    l.info('info msg');
    l.warn('warn msg');
    l.success('ok msg');
    l.stop('stop msg');
    l.error('err msg');
  `;
  const result = runChildWithLogging(snippet, {
    CLAUDE_CODE_WATCHDOG_LOG_ENABLED: '1',
    CLAUDE_CODE_WATCHDOG_LOG_FILE: logFile,
  });
  assert.equal(result.status, 0, result.stderr);

  assert.equal(fs.existsSync(logFile), true);
  const contents = fs.readFileSync(logFile, 'utf8');
  assert.match(contents, /info msg/);
  assert.match(contents, /warn msg/);
  assert.match(contents, /ok msg/);
  assert.match(contents, /stop msg/);
  assert.match(contents, /err msg/);
  // Every line should have the structured prefix.
  const lines = contents.trim().split('\n');
  assert.equal(lines.length, 5);
  for (const line of lines) {
    assert.match(line, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[pid=\d+\] \w+\s+/);
  }
});

test('debug() is FILE-ONLY — never touches stderr even when enabled', () => {
  const logFile = path.join(tmpDir, 'debug-silent.log');
  const snippet = `
    const l = require('./lib/log');
    l.debug('secret trace');
  `;
  const result = runChildWithLogging(snippet, {
    CLAUDE_CODE_WATCHDOG_LOG_ENABLED: '1',
    CLAUDE_CODE_WATCHDOG_LOG_FILE: logFile,
  });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /secret trace/);
  // But it IS in the file.
  assert.match(fs.readFileSync(logFile, 'utf8'), /secret trace/);
});

test('log file is appended-to, not overwritten (multi-process safety)', () => {
  const logFile = path.join(tmpDir, 'append.log');
  const snippet = (msg) => `require('./lib/log').info('${msg}');`;
  runChildWithLogging(snippet('first'), {
    CLAUDE_CODE_WATCHDOG_LOG_ENABLED: '1',
    CLAUDE_CODE_WATCHDOG_LOG_FILE: logFile,
  });
  runChildWithLogging(snippet('second'), {
    CLAUDE_CODE_WATCHDOG_LOG_ENABLED: '1',
    CLAUDE_CODE_WATCHDOG_LOG_FILE: logFile,
  });
  runChildWithLogging(snippet('third'), {
    CLAUDE_CODE_WATCHDOG_LOG_ENABLED: '1',
    CLAUDE_CODE_WATCHDOG_LOG_FILE: logFile,
  });
  const contents = fs.readFileSync(logFile, 'utf8');
  const lines = contents.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /first/);
  assert.match(lines[1], /second/);
  assert.match(lines[2], /third/);
});

test('log-write failures do not crash the caller', () => {
  // Point the log file at an unwritable location (a path inside a file)
  // and confirm info() still completes cleanly.
  const blocker = path.join(tmpDir, 'blocker');
  fs.writeFileSync(blocker, 'x');
  const unwritable = path.join(blocker, 'cannot-write.log');
  const snippet = `
    const l = require('./lib/log');
    l.info('this should still work');
    console.log('after info');
  `;
  const result = runChildWithLogging(snippet, {
    CLAUDE_CODE_WATCHDOG_LOG_ENABLED: '1',
    CLAUDE_CODE_WATCHDOG_LOG_FILE: unwritable,
  });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /after info/);
  assert.match(result.stderr, /this should still work/);
});
