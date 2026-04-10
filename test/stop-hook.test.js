'use strict';

// Integration tests for stop-hook.js — we simulate a complete hook
// invocation by piping a realistic HOOK_INPUT JSON to stdin and asserting
// on stdout/stderr/exit code + state file side effects.
//
// Haiku is stubbed out: we either make the CLI missing, or we force the
// "tool uses empty" branch which skips Haiku entirely. Either way we don't
// spawn a real classifier here.

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

function writeStateFile(cwd, termSessionId, state) {
  const dir = path.join(cwd, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `watchdog.${termSessionId}.local.json`);
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
  test('no TERM_SESSION_ID => allow stop (exit 0, no stdout)', () => {
    const env = Object.assign({}, process.env);
    delete env.TERM_SESSION_ID;
    const result = spawnSync('node', [HOOK], {
      cwd: tmpDir,
      env,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 's', transcript_path: '/tmp/x' }),
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  test('no state file => allow stop', () => {
    const result = runHook(
      { session_id: 's1', transcript_path: '/tmp/nope' },
      { TERM_SESSION_ID: 'not-active' }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });

  test('corrupt state file => rm + allow stop', () => {
    const sessionId = 'hook-corrupt';
    const stateFile = writeStateFile(tmpDir, sessionId, { lol: 'nope' });
    const result = runHook(
      { session_id: 's', transcript_path: '/tmp/x' },
      { TERM_SESSION_ID: sessionId }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('recursive Haiku subprocess call => no-op (state preserved)', () => {
    const sessionId = 'hook-recursion';
    const stateFile = writeStateFile(tmpDir, sessionId, {
      active: true,
      iteration: 1,
      max_iterations: 10,
      term_session_id: sessionId,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'do the refactor',
      owner_session_id: 'OWNER-SESSION',
    });

    // Different session_id simulates the recursive Haiku subprocess.
    const result = runHook(
      { session_id: 'DIFFERENT-SESSION', transcript_path: '/tmp/none' },
      { TERM_SESSION_ID: sessionId }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    // State file is preserved because we bailed early.
    assert.equal(fs.existsSync(stateFile), true);
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 1);
    assert.equal(state.owner_session_id, 'OWNER-SESSION');
    fs.unlinkSync(stateFile);
  });

  test('first fire claims ownership', () => {
    const sessionId = 'hook-first-fire';
    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [] }, // no tool uses => skip Haiku
      },
    ]);
    const stateFile = writeStateFile(tmpDir, sessionId, {
      active: true,
      iteration: 1,
      max_iterations: 10,
      term_session_id: sessionId,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'do the refactor',
    });

    const result = runHook(
      { session_id: 'CLAIMING-SESSION', transcript_path: transcript },
      { TERM_SESSION_ID: sessionId }
    );
    // No tool uses => skip Haiku => fall through to block + re-feed
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /do the refactor/);
    assert.match(decision.reason, /verification/i);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.owner_session_id, 'CLAIMING-SESSION');
    assert.equal(state.iteration, 2);

    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
  });

  test('max iterations reached => rm + allow stop', () => {
    const sessionId = 'hook-max';
    const stateFile = writeStateFile(tmpDir, sessionId, {
      active: true,
      iteration: 10,
      max_iterations: 10,
      term_session_id: sessionId,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'do the refactor',
      owner_session_id: 'OWNER',
    });

    const result = runHook(
      { session_id: 'OWNER', transcript_path: '/tmp/none' },
      { TERM_SESSION_ID: sessionId }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Max iterations/);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('missing transcript file => rm + allow stop', () => {
    const sessionId = 'hook-missing-transcript';
    const stateFile = writeStateFile(tmpDir, sessionId, {
      active: true,
      iteration: 1,
      max_iterations: 10,
      term_session_id: sessionId,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'do the refactor',
      owner_session_id: 'OWNER',
    });

    const result = runHook(
      { session_id: 'OWNER', transcript_path: '/tmp/this-does-not-exist.jsonl' },
      { TERM_SESSION_ID: sessionId }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /Transcript file not found/);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('pure-text turn (no tool uses) => continues loop via block', () => {
    const sessionId = 'hook-text-only';
    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'all done' }] } },
    ]);
    const stateFile = writeStateFile(tmpDir, sessionId, {
      active: true,
      iteration: 2,
      max_iterations: 10,
      term_session_id: sessionId,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'do the refactor',
      owner_session_id: 'OWNER',
    });

    const result = runHook(
      { session_id: 'OWNER', transcript_path: transcript },
      { TERM_SESSION_ID: sessionId }
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
});
