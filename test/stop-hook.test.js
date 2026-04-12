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

  test('v1.2.4 state file (no new fields) loads via legacy defaults', () => {
    // Backward compat: a state file written by v1.2.4 has no exit_confirmations,
    // no_change_streak, no_classifier, watch_prompt_file, or prompt_file fields.
    // The hook must treat them as defaults and behave exactly like v1.2.4 did.
    const pid = 500200;
    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking out loud' }] } },
    ]);
    const stateFile = writeStateFile(tmpDir, pid, {
      // Exact v1.2.4 shape — no v1.3.0 fields.
      active: true,
      iteration: 1,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'do the refactor',
    });

    const result = runHook(
      { session_id: 's', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /do the refactor/);

    // The hook now persists no_change_streak even when starting from a
    // v1.2.4 state file. Iteration bumped to 2.
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 2);
    assert.equal(state.no_change_streak, 0);
    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
  });

  test('pure-text turn resets no_change_streak to 0 even when streak was non-zero', () => {
    const pid = 500201;
    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'no tools, just words' }] } },
    ]);
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 4,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'task',
      exit_confirmations: 3,
      no_change_streak: 2, // pretend we already had 2 in a row
    });

    const result = runHook(
      { session_id: 's', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 5);
    assert.equal(state.no_change_streak, 0); // reset by pure-text turn
    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
  });

  test('--no-classifier short-circuits Haiku entirely (works with no claude on PATH)', () => {
    // Remove `claude` from PATH so any attempt to spawn Haiku would fail
    // with ENOENT. With no_classifier=true the hook must NEVER try.
    const pid = 500202;
    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: '/tmp/x', content: 'y' } },
          ],
        },
      },
    ]);
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 1,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'no-classifier task',
      no_classifier: true,
      no_change_streak: 99, // intentionally absurd; should be reset to 0
    });

    // Strip claude from PATH so any spawn attempt to invoke `claude` would
    // ENOENT. We use process.execPath (absolute path to the test runner's
    // own node binary) so the hook subprocess itself doesn't need PATH to
    // resolve `node`.
    const env = Object.assign({}, process.env, {
      WATCHDOG_CLAUDE_PID: String(pid),
      PATH: '/nonexistent/bin',
      Path: '/nonexistent/bin', // Windows
    });
    const result = spawnSync(process.execPath, [HOOK], {
      cwd: tmpDir,
      env,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 's', transcript_path: transcript }),
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /no-classifier task/);
    assert.match(result.stderr, /no-classifier mode/);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 2);
    assert.equal(state.no_change_streak, 0); // defensively reset
    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
  });

  test('--no-classifier still respects --max-iterations as the only escape hatch', () => {
    const pid = 500203;
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 10,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'task',
      no_classifier: true,
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

  test('hot-reload: prompt file content unchanged => no streak reset, no prompt update', () => {
    const pid = 500204;
    const promptFile = path.join(tmpDir, `prompt-${pid}.md`);
    fs.writeFileSync(promptFile, 'stable task');

    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] } },
    ]);
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 1,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'stable task',
      prompt_file: promptFile,
      watch_prompt_file: true,
      exit_confirmations: 3,
      no_change_streak: 1, // pretend a previous turn already counted once
    });

    const result = runHook(
      { session_id: 's', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /stable task/);
    // Even though we re-read the file, content hadn't changed -> no info log
    assert.doesNotMatch(result.stderr, /hot-reloading/);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.prompt, 'stable task');
    // Pure-text turn still resets streak (independent of hot-reload)
    assert.equal(state.no_change_streak, 0);
    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
    fs.unlinkSync(promptFile);
  });

  test('hot-reload: prompt file content changed => prompt updated, streak reset, info log emitted', () => {
    const pid = 500205;
    const promptFile = path.join(tmpDir, `prompt-${pid}.md`);
    // The file on disk now has DIFFERENT content from what's in state.prompt.
    fs.writeFileSync(promptFile, 'NEW task spec');

    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'still thinking' }] } },
    ]);
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 5,
      max_iterations: 20,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'OLD task spec',
      prompt_file: promptFile,
      watch_prompt_file: true,
      exit_confirmations: 3,
      no_change_streak: 2, // significant streak that should be wiped
    });

    const result = runHook(
      { session_id: 's', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    // The decision payload re-feeds the NEW prompt, not the old cached one.
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /NEW task spec/);
    assert.doesNotMatch(decision.reason, /OLD task spec/);
    assert.match(result.stderr, /hot-reloading/);
    assert.match(result.stderr, /resetting convergence streak/);

    // Persisted state shows the new prompt + streak reset to 0.
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.prompt, 'NEW task spec');
    assert.equal(state.no_change_streak, 0);
    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
    fs.unlinkSync(promptFile);
  });

  test('hot-reload: prompt file deleted => silently keep cached prompt, no error', () => {
    const pid = 500206;
    const promptFile = path.join(tmpDir, `prompt-${pid}-deleted.md`);
    // We do NOT create the file. State references a path that doesn't exist.

    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] } },
    ]);
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 2,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'cached prompt that survives deletion',
      prompt_file: promptFile,
      watch_prompt_file: true,
    });

    const result = runHook(
      { session_id: 's', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /cached prompt that survives deletion/);
    // Crucially: NO user-facing error about the missing file. Hot-reload
    // failures are silent so the agent never sees them.
    assert.doesNotMatch(result.stderr, /prompt file not found/);
    assert.doesNotMatch(result.stderr, /Error/);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.prompt, 'cached prompt that survives deletion');
    assert.equal(state.iteration, 3);
    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
  });

  test('hot-reload: file becomes empty => silently keep cached prompt', () => {
    const pid = 500207;
    const promptFile = path.join(tmpDir, `prompt-${pid}-empty.md`);
    fs.writeFileSync(promptFile, '   \n\n   '); // whitespace only -> trimmed to empty

    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] } },
    ]);
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 1,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'cached survives empty file',
      prompt_file: promptFile,
      watch_prompt_file: true,
    });

    const result = runHook(
      { session_id: 's', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.match(decision.reason, /cached survives empty file/);

    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
    fs.unlinkSync(promptFile);
  });

  test('hot-reload + --no-classifier together: prompt updates, classifier still skipped', () => {
    // Two orthogonal features composed in one iteration. The hot-reload
    // path runs first (step 2 of the hook) and may update effectivePrompt
    // and reset the streak. Then the no-classifier short-circuit (step 6)
    // prevents askHaiku() from being called at all. Both must work
    // together: the new prompt is re-fed AND no `claude` subprocess is
    // ever spawned.
    const pid = 500220;
    const promptFile = path.join(tmpDir, `prompt-${pid}-combo.md`);
    fs.writeFileSync(promptFile, 'NEW combined task');

    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'Write', input: { file_path: '/tmp/x', content: 'y' } },
          ],
        },
      },
    ]);
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 3,
      max_iterations: 20,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'OLD combined task',
      prompt_file: promptFile,
      watch_prompt_file: true,
      no_classifier: true,
    });

    // Strip claude from PATH so any spawn attempt would ENOENT — proves
    // the no-classifier branch really did short-circuit before askHaiku().
    const env = Object.assign({}, process.env, {
      WATCHDOG_CLAUDE_PID: String(pid),
      PATH: '/nonexistent/bin',
      Path: '/nonexistent/bin',
    });
    const result = spawnSync(process.execPath, [HOOK], {
      cwd: tmpDir,
      env,
      encoding: 'utf8',
      input: JSON.stringify({ session_id: 's', transcript_path: transcript }),
    });

    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    // Re-fed prompt is the NEW one from the file, not the OLD cached one.
    assert.match(decision.reason, /NEW combined task/);
    assert.doesNotMatch(decision.reason, /OLD combined task/);
    // Both feature paths logged their info messages.
    assert.match(result.stderr, /hot-reloading/);
    assert.match(result.stderr, /no-classifier mode/);
    // No Haiku attempt — if the hook had tried to spawn `claude`, the
    // ENOENT would have surfaced as one of the askHaiku() failure
    // messages. Assert their absence specifically (the no-classifier
    // info log itself contains the word "classifier", so we can't just
    // grep for that).
    assert.doesNotMatch(result.stderr, /CLI not found/);
    assert.doesNotMatch(result.stderr, /judgment call failed/);
    assert.doesNotMatch(result.stderr, /ambiguous/i);
    // And no success message either — the loop continues, doesn't exit.
    assert.doesNotMatch(result.stderr, /no file modifications/i);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.prompt, 'NEW combined task');
    assert.equal(state.iteration, 4);
    assert.equal(state.no_change_streak, 0);
    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
    fs.unlinkSync(promptFile);
  });

  test('hot-reload not enabled (watch_prompt_file=false) => file is NOT re-read', () => {
    const pid = 500208;
    const promptFile = path.join(tmpDir, `prompt-${pid}-noread.md`);
    fs.writeFileSync(promptFile, 'NEW content but not watched');

    const transcript = writeTranscript(tmpDir, [
      { type: 'user', message: { role: 'user', content: 'prompt' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] } },
    ]);
    const stateFile = writeStateFile(tmpDir, pid, {
      active: true,
      iteration: 1,
      max_iterations: 10,
      claude_pid: pid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'OLD cached content',
      prompt_file: promptFile,
      watch_prompt_file: false, // not watching
    });

    const result = runHook(
      { session_id: 's', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(pid) }
    );
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    // Old cached content is re-fed, not the new file content
    assert.match(decision.reason, /OLD cached content/);
    assert.doesNotMatch(decision.reason, /NEW content/);
    fs.unlinkSync(stateFile);
    fs.unlinkSync(transcript);
    fs.unlinkSync(promptFile);
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
