'use strict';

// Integration tests for stop-hook.js — we simulate a complete hook
// invocation by piping a realistic HOOK_INPUT JSON to stdin and asserting
// on stdout/stderr/exit code + state file side effects.
//
// The Haiku subprocess path is NOT exercised here — every test either
// takes a branch that exits before calling Haiku, or uses an assistant
// turn with zero tool_use entries so the hook skips Haiku by the
// "no tool invocations" precondition. The real subprocess spawn path is
// covered by stop-hook-haiku.test.js via a mock Claude CLI on PATH.
//
// Tests inject WATCHDOG_CLAUDE_PID to bypass the process ancestry walk
// in the hook (which would otherwise return null outside a real Claude
// Code session).

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'stop-hook.js');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-hook-test-'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeStateFile(cwd, claudePid, state) {
  const dir = path.join(cwd, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `watchdog.claudepid.${claudePid}.local.json`);
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

function writeTranscript(cwd, lines) {
  const p = path.join(cwd, 'transcript.jsonl');
  fs.writeFileSync(p, lines.map((obj) => JSON.stringify(obj)).join('\n') + '\n');
  return p;
}

function runHook(hookInput, env = {}) {
  return spawnSync('node', [HOOK], {
    cwd: tmpDir,
    env: Object.assign({}, process.env, env),
    encoding: 'utf8',
    input: JSON.stringify(hookInput),
  });
}

describe('stop-hook.js', () => {
  test('no discoverable Claude Code PID => allow stop (exit 0, no stdout)', () => {
    // With no override AND no real Claude Code ancestry, findClaudePid()
    // returns null and the hook exits silently. This is the safe default.
    const env = Object.assign({}, process.env);
    delete env.WATCHDOG_CLAUDE_PID;
    const result = spawnSync('node', [HOOK], {
      cwd: tmpDir,
      env,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 's', transcript_path: '/tmp/x' }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  test('no state file for our claudePid => allow stop', () => {
    const result = runHook(
      { session_id: 's1', transcript_path: '/tmp/nope' },
      { WATCHDOG_CLAUDE_PID: '500001' }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  test('corrupt state file => rm + allow stop', () => {
    const pid = 500002;
    const stateFile = writeStateFile(tmpDir, pid, { lol: 'nope' });
    const result = runHook(
      { session_id: 's', transcript_path: '/tmp/x' },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('recursive Haiku subprocess (different claudePid) => no-op, state preserved', () => {
    // The main session's state file lives under claudePid 500003. A recursive
    // Haiku subprocess would have its own distinct PID, so its findClaudePid()
    // returns something different (here we simulate by passing a different
    // WATCHDOG_CLAUDE_PID to a second hook invocation).
    const mainPid = 500003;
    const stateFile = writeStateFile(tmpDir, mainPid, {
      active: true,
      iteration: 1,
      max_iterations: 10,
      claude_pid: mainPid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'do the refactor',
    });

    // Simulate recursive hook fire from the Haiku subprocess — different PID.
    const haikuPid = 500004;
    const result = runHook(
      { session_id: 'HAIKU-SESSION', transcript_path: '/tmp/none' },
      { WATCHDOG_CLAUDE_PID: String(haikuPid) }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');

    // Main session's state file is UNTOUCHED because the recursive hook
    // looked up watchdog.claudepid.500004.local.json (which doesn't exist)
    // and never touched watchdog.claudepid.500003.local.json.
    assert.equal(fs.existsSync(stateFile), true);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 1);
    assert.equal(state.claude_pid, mainPid);
    fs.unlinkSync(stateFile);
  });

  test('pure-text turn (no tool uses) => continues loop via block', () => {
    const pid = 500005;
    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } },
    ]);
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 2,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'do the refactor',
    });

    const result = runHook(
      { session_id: 's', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /do the refactor/);
    assert.match(result.stderr, /no tool invocations/);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 3);

    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
  });

  test('max iterations reached => rm + allow stop', () => {
    const pid = 500006;
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 10,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'do the refactor',
    });

    const result = runHook(
      { session_id: 's', transcript_path: '/tmp/none' },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Max iterations/);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('missing transcript file => rm + allow stop', () => {
    const pid = 500007;
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 1,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'do the refactor',
    });

    const result = runHook(
      { session_id: 's', transcript_path: '/tmp/this-does-not-exist.jsonl' },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Transcript file not found/);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('concurrent sessions: 3 state files, each hook only touches its own', () => {
    // Simulate three Claude Code sessions in the same project. Each has its
    // own state file keyed by its own claudePid. When hook fires for session
    // B, sessions A and C must remain untouched.
    const pidA = 500101;
    const pidB = 500102;
    const pidC = 500103;

    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } },
    ]);

    const fileA = writeStateFile(tmpDir, pidA, {
      active: true, iteration: 1, max_iterations: 10, claude_pid: pidA,
      started_at: '2026-04-11T00:00:00Z', prompt: 'session A prompt',
    });
    const fileB = writeStateFile(tmpDir, pidB, {
      active: true, iteration: 1, max_iterations: 10, claude_pid: pidB,
      started_at: '2026-04-11T00:00:00Z', prompt: 'session B prompt',
    });
    const fileC = writeStateFile(tmpDir, pidC, {
      active: true, iteration: 1, max_iterations: 10, claude_pid: pidC,
      started_at: '2026-04-11T00:00:00Z', prompt: 'session C prompt',
    });

    // Fire the hook as session B.
    const result = runHook(
      { session_id: 'B', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(pidB) }
    );
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    // Only session B's prompt should be re-fed.
    assert.match(decision.reason, /session B prompt/);

    // Session A and C state files are UNTOUCHED (same iteration).
    const stateA = JSON.parse(fs.readFileSync(fileA, 'utf8'));
    const stateC = JSON.parse(fs.readFileSync(fileC, 'utf8'));
    assert.equal(stateA.iteration, 1);
    assert.equal(stateC.iteration, 1);

    // Session B's iteration bumped to 2.
    const stateB = JSON.parse(fs.readFileSync(fileB, 'utf8'));
    assert.equal(stateB.iteration, 2);

    fs.unlinkSync(fileA);
    fs.unlinkSync(fileB);
    fs.unlinkSync(fileC);
    fs.unlinkSync(transcript);
  });
});
