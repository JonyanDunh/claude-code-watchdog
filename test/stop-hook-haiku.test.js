'use strict';

// End-to-end integration tests for the Haiku subprocess path of
// hooks/stop-hook.js. The regular stop-hook tests in stop-hook.test.js
// deliberately avoid the askHaiku() code path by taking the "no tool
// uses" / "corrupt state" / "recursion guard" / "max iterations" /
// "missing transcript" branches. Those tests are fast and deterministic
// but they leave the actual spawnSync('claude', ...) code path
// un-exercised — which is the one place where Windows cmd.exe quoting,
// PATH resolution, and subprocess stdio handling could go wrong.
//
// This file fills that gap by spawning the real stop-hook.js subprocess
// with a *mock* `claude` binary on its PATH. The mock is a tiny Node.js
// script that echoes a verdict controlled by an environment variable.
// The test creates cross-platform wrappers (a shell script `claude` for
// POSIX and a `claude.cmd` batch file for Windows) so the hook finds
// and invokes the mock regardless of the host OS.

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'stop-hook.js');

let tmpRoot;
let mockBinDir;

const isWindows = process.platform === 'win32';

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'watchdog-haiku-e2e-'));
  mockBinDir = path.join(tmpRoot, 'bin');
  fs.mkdirSync(mockBinDir, { recursive: true });

  // Shared fake-Claude implementation. Reads WATCHDOG_FAKE_HAIKU_VERDICT
  // from the environment and emits an output shaped to drive the hook
  // down the branch we want to test.
  const fakeClaudeJs = path.join(mockBinDir, 'fake-claude.js');
  fs.writeFileSync(
    fakeClaudeJs,
    `#!/usr/bin/env node
'use strict';
// Mock Claude CLI for watchdog integration tests. Behavior depends on
// WHICH subcommand the hook is running:
//   \`claude --version\`    → always succeed (used by the pre-flight check
//                             in claudeCliAvailable()). If this path ever
//                             starts honoring the verdict env var, the
//                             CLI_FAILED branch test will mis-classify as
//                             CLI_MISSING instead.
//   \`claude -p ...\`       → emit a verdict controlled by
//                             WATCHDOG_FAKE_HAIKU_VERDICT (FILE_CHANGES,
//                             NO_FILE_CHANGES, AMBIGUOUS_BOTH,
//                             AMBIGUOUS_NEITHER, or FAIL).
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('mock-claude 0.0.0\\n');
  process.exit(0);
}
const verdict = process.env.WATCHDOG_FAKE_HAIKU_VERDICT || 'FILE_CHANGES';
if (verdict === 'FAIL') {
  process.stderr.write('simulated claude CLI failure\\n');
  process.exit(1);
}
if (verdict === 'AMBIGUOUS_BOTH') {
  process.stdout.write('The verdict is FILE_CHANGES or maybe NO_FILE_CHANGES.');
  process.exit(0);
}
if (verdict === 'AMBIGUOUS_NEITHER') {
  process.stdout.write('I am not sure either way.');
  process.exit(0);
}
// Default case: emit the literal marker token.
process.stdout.write(verdict);
process.exit(0);
`
  );
  fs.chmodSync(fakeClaudeJs, 0o755);

  // POSIX wrapper — filename 'claude' (no extension). Node's spawnSync
  // without shell:true looks for an executable file with this exact name
  // on Linux/macOS.
  const posixWrapper = path.join(mockBinDir, 'claude');
  fs.writeFileSync(
    posixWrapper,
    `#!/bin/sh\nexec node "${fakeClaudeJs}" "$@"\n`
  );
  fs.chmodSync(posixWrapper, 0o755);

  // Windows wrapper — filename 'claude.cmd'. Node's spawnSync with
  // shell:true on Windows goes through cmd.exe, which uses PATHEXT to
  // resolve 'claude' → 'claude.cmd'.
  const winWrapper = path.join(mockBinDir, 'claude.cmd');
  fs.writeFileSync(winWrapper, `@node "${fakeClaudeJs}" %*\r\n`);
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

let pidCounter = 600000;
function makeSession() {
  const cwd = fs.mkdtempSync(path.join(tmpRoot, 'session-'));
  const claudePid = ++pidCounter;
  return { cwd, claudePid };
}

function writeStateFile(cwd, claudePid, overrides = {}) {
  const dir = path.join(cwd, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `watchdog.claudepid.${claudePid}.local.json`);
  const state = Object.assign(
    {
      active: true,
      iteration: 1,
      max_iterations: 10,
      claude_pid: claudePid,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'my test prompt',
    },
    overrides
  );
  fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
  return filePath;
}

function writeTranscriptWithToolUse(cwd) {
  const p = path.join(cwd, 'transcript.jsonl');
  const lines = [
    { type: 'user', message: { role: 'user', content: 'fix something' } },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tu_1',
            name: 'Write',
            input: { file_path: '/tmp/x', content: 'y' },
          },
        ],
      },
    },
  ];
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

function runHook(cwd, hookInput, extraEnv) {
  // Prepend the mock bin directory to PATH so the hook's
  // spawnSync('claude', ...) finds our fake instead of any real install.
  const env = Object.assign({}, process.env, extraEnv, {
    PATH: mockBinDir + path.delimiter + (process.env.PATH || ''),
    // Windows also honors the lowercase 'Path' variable. Set both to be
    // safe — Node normalizes this but cmd.exe may not if shell:true
    // propagates a cloned env.
    Path: mockBinDir + path.delimiter + (process.env.Path || process.env.PATH || ''),
  });
  return spawnSync('node', [HOOK], {
    cwd,
    env,
    encoding: 'utf8',
    input: JSON.stringify(hookInput),
  });
}

describe('stop-hook.js: Haiku subprocess integration (mock CLI)', () => {
  test('mock claude is actually resolvable on the test PATH', () => {
    // Sanity check: run the mock directly to confirm the wrappers are
    // found via PATH and the pre-flight --version probe succeeds before
    // we start blaming the hook for anything.
    const versionResult = spawnSync('claude', ['--version'], {
      env: Object.assign({}, process.env, {
        PATH: mockBinDir + path.delimiter + (process.env.PATH || ''),
        Path: mockBinDir + path.delimiter + (process.env.Path || process.env.PATH || ''),
      }),
      encoding: 'utf8',
      shell: isWindows,
    });
    assert.equal(versionResult.status, 0, `fake claude --version exit ${versionResult.status}: ${versionResult.stderr}`);
    assert.match(versionResult.stdout, /mock-claude/);

    // Now run with a verdict env var set to confirm the -p / verdict
    // code path works too.
    const verdictResult = spawnSync(
      'claude',
      ['-p', '--model', 'haiku', '--no-session-persistence', 'dummy'],
      {
        env: Object.assign({}, process.env, {
          PATH: mockBinDir + path.delimiter + (process.env.PATH || ''),
          Path: mockBinDir + path.delimiter + (process.env.Path || process.env.PATH || ''),
          WATCHDOG_FAKE_HAIKU_VERDICT: 'FILE_CHANGES',
        }),
        encoding: 'utf8',
        shell: isWindows,
      }
    );
    assert.equal(verdictResult.status, 0, `fake claude -p exit ${verdictResult.status}: ${verdictResult.stderr}`);
    assert.equal(verdictResult.stdout, 'FILE_CHANGES');
  });

  test('FILE_CHANGES verdict => block and re-feed', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, { iteration: 1 });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'FILE_CHANGES' }
    );

    assert.equal(result.status, 0, `hook stderr: ${result.stderr}`);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /my test prompt/);
    assert.match(decision.reason, /verification/i);

    // State file preserved, iteration bumped to 2
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 2);
  });

  test('NO_FILE_CHANGES verdict => remove state file, allow stop', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, { iteration: 5 });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no file modifications/i);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('ambiguous (neither marker) => continue loop as safety', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, { iteration: 3 });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'AMBIGUOUS_NEITHER' }
    );

    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(result.stderr, /ambiguous/i);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 4);
  });

  test('ambiguous (both markers) => continue loop as safety', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    writeStateFile(cwd, claudePid, { iteration: 2 });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'AMBIGUOUS_BOTH' }
    );

    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(result.stderr, /ambiguous/i);
  });

  test('CLI failure (exit 1) => continue loop as safety', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, { iteration: 1 });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'FAIL' }
    );

    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(result.stderr, /judgment call failed/i);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 2);
  });

  test('exit_confirmations=3: NO_FILE_CHANGES streak builds 1->2->3 then exits at 3', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    // Start the loop with exit_confirmations=3 and streak=0.
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 1,
      exit_confirmations: 3,
      no_change_streak: 0,
    });

    // Iteration 1 -> NO_FILE_CHANGES, streak goes 0 -> 1, loop continues.
    let result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0, `iter1 stderr: ${result.stderr}`);
    let decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(result.stderr, /1\/3/);
    assert.match(result.stderr, /need 2 more/);
    let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.no_change_streak, 1);
    assert.equal(state.iteration, 2);

    // Iteration 2 -> NO_FILE_CHANGES, streak goes 1 -> 2, loop continues.
    result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0, `iter2 stderr: ${result.stderr}`);
    decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(result.stderr, /2\/3/);
    assert.match(result.stderr, /need 1 more/);
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.no_change_streak, 2);
    assert.equal(state.iteration, 3);

    // Iteration 3 -> NO_FILE_CHANGES, streak hits 3 == exit_confirmations, EXIT.
    result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0, `iter3 stderr: ${result.stderr}`);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /3\/3/);
    assert.match(result.stderr, /exiting loop/i);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('exit_confirmations=3: FILE_CHANGES mid-streak resets back to 0', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 1,
      exit_confirmations: 3,
      no_change_streak: 2, // already had two NO_FILE_CHANGES in a row
    });

    // FILE_CHANGES verdict -> streak reset to 0, loop continues.
    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'FILE_CHANGES' }
    );
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.no_change_streak, 0);
    assert.equal(state.iteration, 2);
  });

  test('exit_confirmations=3: AMBIGUOUS verdict mid-streak resets back to 0', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 5,
      exit_confirmations: 3,
      no_change_streak: 2,
    });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'AMBIGUOUS_NEITHER' }
    );
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(result.stderr, /ambiguous/i);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.no_change_streak, 0);
  });

  test('exit_confirmations=3: CLI_FAILED mid-streak resets back to 0', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 5,
      exit_confirmations: 3,
      no_change_streak: 2,
    });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'FAIL' }
    );
    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(result.stderr, /judgment call failed/i);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.no_change_streak, 0);
  });

  test('hot-reload + NO_FILE_CHANGES in the same iteration: streak resets first then increments to 1', () => {
    // Exact ordering check: state has streak=2 (2 of 3 needed). The
    // prompt file on disk has been edited to differ from the cached
    // prompt. This iteration's events:
    //
    //   1. Hook reads state file, effectiveStreak = 2.
    //   2. Hot-reload reads file -> content changed -> effectiveStreak
    //      reset to 0, effectivePrompt = new content, promptChanged = true.
    //   3. Haiku verdict = NO_FILE_CHANGES -> newStreak = 0 + 1 = 1.
    //      That is < exit_confirmations (3), so the hook does NOT exit;
    //      it persists no_change_streak = 1 and re-feeds the NEW prompt.
    //
    // The bug this guards against: if hot-reload's streak reset happened
    // *after* the Haiku branch instead of before, this iteration would
    // see streak=2 -> Haiku -> newStreak=3 -> exit, even though the task
    // was just redefined and zero turns of the new task have been
    // verified.
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const promptFile = path.join(cwd, 'live-prompt.md');
    fs.writeFileSync(promptFile, 'BRAND NEW redefined task');
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 7,
      exit_confirmations: 3,
      no_change_streak: 2,
      prompt: 'OLD task that almost converged',
      prompt_file: promptFile,
      watch_prompt_file: true,
    });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    // Loop did NOT exit — block decision with the new prompt.
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(decision.reason, /BRAND NEW redefined task/);
    assert.doesNotMatch(decision.reason, /OLD task that almost converged/);

    // The convergence log says 1/3, NOT 3/3. This is the bug-guard
    // assertion: if the streak hadn't been reset before Haiku, we would
    // see 3/3 and an exit instead.
    assert.match(result.stderr, /hot-reloading/);
    assert.match(result.stderr, /resetting convergence streak/);
    assert.match(result.stderr, /1\/3/);
    assert.doesNotMatch(result.stderr, /3\/3/);
    assert.doesNotMatch(result.stderr, /exiting loop/i);

    // Persisted state: new prompt, streak = 1.
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.prompt, 'BRAND NEW redefined task');
    assert.equal(state.no_change_streak, 1);
    assert.equal(state.iteration, 8);
  });

  test('corrupted exit_confirmations field: string "3" defaults safely to 1 (no crash)', () => {
    // Hand-edited state files might contain wrong types. The defensive
    // default in stop-hook.js (`typeof state.exit_confirmations === 'number'
    // && state.exit_confirmations >= 1 ? state.exit_confirmations : 1`)
    // must catch every weird shape and fall back to 1 instead of throwing
    // or producing garbage streak math.
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 1,
      exit_confirmations: '3', // string, not number
      no_change_streak: 0,
    });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // Defaulted to 1 → first NO_FILE_CHANGES exits the loop.
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no file modifications/i);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('corrupted exit_confirmations field: 0 defaults safely to 1', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 1,
      exit_confirmations: 0, // number but < 1
      no_change_streak: 0,
    });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no file modifications/i);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('corrupted exit_confirmations field: negative number defaults safely to 1', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 1,
      exit_confirmations: -5,
      no_change_streak: 0,
    });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('corrupted exit_confirmations field: null defaults safely to 1', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 1,
      exit_confirmations: null,
      no_change_streak: 0,
    });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('exit_confirmations=3.5 (float, valid number >=1) is honored with integer streak math', () => {
    // The CLI parser rejects non-integer --exit-confirmations, but a
    // hand-edited state file could contain a float. The defensive check
    // (`typeof === 'number' && >= 1`) accepts it. Streak arithmetic is
    // integer (newStreak = effectiveStreak + 1) so the comparison
    // `newStreak >= 3.5` first fires when newStreak == 4, not 3.
    //
    // This is documented quirky behavior, not a bug — but lock it in so
    // a refactor doesn't accidentally start parsing 3.5 as 3 or crashing.
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 1,
      exit_confirmations: 3.5,
      no_change_streak: 0,
    });

    // Iteration 1: streak 0 -> 1, 1 < 3.5, continue.
    let result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).decision, 'block');
    let state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.no_change_streak, 1);

    // Iteration 2: 1 -> 2, continue.
    result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.no_change_streak, 2);

    // Iteration 3: 2 -> 3, 3 >= 3.5 is FALSE, continue.
    result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(JSON.parse(result.stdout).decision, 'block');
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.no_change_streak, 3);

    // Iteration 4: 3 -> 4, 4 >= 3.5 is TRUE, EXIT.
    result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /exiting loop/i);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('exit_confirmations=1 (default) still exits on first NO_FILE_CHANGES — regression check', () => {
    const { cwd, claudePid } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, claudePid, {
      iteration: 1,
      // No exit_confirmations field at all (simulates v1.2.4 state file
      // upgraded to v1.3.0 hook). Hook should treat as 1.
      no_change_streak: 0,
    });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { WATCHDOG_CLAUDE_PID: String(claudePid), WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no file modifications/i);
    // The legacy single-confirm exit message has no x/y fraction.
    assert.doesNotMatch(result.stderr, /1\/1/);
    assert.equal(fs.existsSync(stateFile), false);
  });
});
