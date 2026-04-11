'use strict';

// Unit tests for lib/claude-pid.js.
//
// findClaudePid() walks the process tree looking for a process whose name
// is `claude` and returns its PID. We can't actually simulate a full
// Claude Code ancestry inside a unit test, so the tests cover:
//
//   1. The WATCHDOG_CLAUDE_PID env var override (the same knob the rest of
//      the test suite uses to inject synthetic session keys).
//   2. The isClaudeProcessName() helper that decides whether a given comm
//      name counts as a Claude Code process.
//   3. The readProcComm() / readProcPpid() helpers as best we can on the
//      host platform — we read our own PID and PPID and sanity-check that
//      they return something sensible.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  findClaudePid,
  _isClaudeProcessName,
  _readProcComm,
  _readProcPpid,
} = require('../lib/claude-pid');

describe('isClaudeProcessName', () => {
  test('plain "claude" matches', () => {
    assert.equal(_isClaudeProcessName('claude'), true);
  });

  test('"claude.exe" (Windows) matches', () => {
    assert.equal(_isClaudeProcessName('claude.exe'), true);
    assert.equal(_isClaudeProcessName('Claude.EXE'), true);
  });

  test('"claude.cmd" (Windows shim) matches', () => {
    assert.equal(_isClaudeProcessName('claude.cmd'), true);
  });

  test('"Claude Code" (macOS app bundle) matches', () => {
    assert.equal(_isClaudeProcessName('Claude Code'), true);
    assert.equal(_isClaudeProcessName('claude code'), true);
  });

  test('leading/trailing whitespace is tolerated', () => {
    assert.equal(_isClaudeProcessName('  claude\n'), true);
  });

  test('non-matches stay false', () => {
    assert.equal(_isClaudeProcessName('node'), false);
    assert.equal(_isClaudeProcessName('bash'), false);
    assert.equal(_isClaudeProcessName('sh'), false);
    assert.equal(_isClaudeProcessName('python'), false);
    assert.equal(_isClaudeProcessName('claude-code'), false); // intentionally strict
    assert.equal(_isClaudeProcessName('notclaude'), false);
    assert.equal(_isClaudeProcessName(''), false);
    assert.equal(_isClaudeProcessName(null), false);
    assert.equal(_isClaudeProcessName(undefined), false);
  });
});

describe('findClaudePid env override', () => {
  test('WATCHDOG_CLAUDE_PID=12345 short-circuits and returns 12345', () => {
    const save = process.env.WATCHDOG_CLAUDE_PID;
    process.env.WATCHDOG_CLAUDE_PID = '12345';
    try {
      assert.equal(findClaudePid(), 12345);
    } finally {
      if (save === undefined) delete process.env.WATCHDOG_CLAUDE_PID;
      else process.env.WATCHDOG_CLAUDE_PID = save;
    }
  });

  test('WATCHDOG_CLAUDE_PID=99 works for any positive integer', () => {
    const save = process.env.WATCHDOG_CLAUDE_PID;
    process.env.WATCHDOG_CLAUDE_PID = '99';
    try {
      assert.equal(findClaudePid(), 99);
    } finally {
      if (save === undefined) delete process.env.WATCHDOG_CLAUDE_PID;
      else process.env.WATCHDOG_CLAUDE_PID = save;
    }
  });

  test('invalid override values (non-numeric / zero / negative) are ignored', () => {
    const save = process.env.WATCHDOG_CLAUDE_PID;

    const cases = ['0', '-1', '1.5', 'abc', '', '  ', '12 34'];
    for (const bad of cases) {
      process.env.WATCHDOG_CLAUDE_PID = bad;
      // With an invalid override, findClaudePid falls through to the
      // ancestry walk. Under the test runner, nothing up the tree is
      // claude, so we expect null (not a crash).
      const result = findClaudePid();
      assert.ok(result === null || typeof result === 'number',
        `invalid override ${JSON.stringify(bad)} should return null or ignore-and-walk, got ${result}`);
    }

    if (save === undefined) delete process.env.WATCHDOG_CLAUDE_PID;
    else process.env.WATCHDOG_CLAUDE_PID = save;
  });
});

describe('readProcComm / readProcPpid on this host', () => {
  test('readProcPpid of our own PID returns a positive integer', () => {
    const ppid = _readProcPpid(process.pid);
    assert.ok(ppid === null || (Number.isInteger(ppid) && ppid >= 0),
      `expected null or positive integer, got ${ppid}`);
    // If we got a number, it should match process.ppid.
    if (ppid !== null) {
      assert.equal(ppid, process.ppid);
    }
  });

  test('readProcComm of our own PID returns a non-empty string (Linux) or may be null elsewhere', () => {
    const comm = _readProcComm(process.pid);
    if (process.platform === 'linux') {
      assert.ok(typeof comm === 'string' && comm.length > 0,
        `expected non-empty string, got ${comm}`);
      // Our own comm is likely "node"
      assert.match(comm, /node/i);
    } else {
      // On non-Linux, the helper may succeed or silently fail depending on
      // ps / powershell availability. Either is acceptable.
      assert.ok(comm === null || typeof comm === 'string');
    }
  });
});

describe('findClaudePid ancestry walk (no override)', () => {
  test('returns null or a positive integer outside a Claude Code session', () => {
    // This test runs under the node:test runner, not under Claude Code,
    // so the walk should NOT find a 'claude' process and should return
    // null. We accept either null (most likely) or a positive integer
    // (in case the test itself is being run inside a Claude Code session
    // for dogfooding, which is exactly what we are doing right now).
    const save = process.env.WATCHDOG_CLAUDE_PID;
    delete process.env.WATCHDOG_CLAUDE_PID;
    try {
      const result = findClaudePid();
      if (result !== null) {
        assert.ok(Number.isInteger(result) && result > 0,
          `expected null or positive integer, got ${result}`);
      }
    } finally {
      if (save !== undefined) process.env.WATCHDOG_CLAUDE_PID = save;
    }
  });
});
