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

function makeSession() {
  const cwd = fs.mkdtempSync(path.join(tmpRoot, 'session-'));
  const termSessionId = `e2e-${path.basename(cwd)}`;
  return { cwd, termSessionId };
}

function writeStateFile(cwd, termSessionId, overrides = {}) {
  const dir = path.join(cwd, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `watchdog.${termSessionId}.local.json`);
  const state = Object.assign(
    {
      active: true,
      iteration: 1,
      max_iterations: 10,
      term_session_id: termSessionId,
      started_at: '2026-04-11T00:00:00Z',
      prompt: 'my test prompt',
      owner_session_id: 'OWNER',
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
    const { cwd, termSessionId } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, termSessionId, { iteration: 1 });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { TERM_SESSION_ID: termSessionId, WATCHDOG_FAKE_HAIKU_VERDICT: 'FILE_CHANGES' }
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
    const { cwd, termSessionId } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, termSessionId, { iteration: 5 });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { TERM_SESSION_ID: termSessionId, WATCHDOG_FAKE_HAIKU_VERDICT: 'NO_FILE_CHANGES' }
    );

    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /no file modifications/i);
    assert.equal(fs.existsSync(stateFile), false);
  });

  test('ambiguous (neither marker) => continue loop as safety', () => {
    const { cwd, termSessionId } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, termSessionId, { iteration: 3 });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { TERM_SESSION_ID: termSessionId, WATCHDOG_FAKE_HAIKU_VERDICT: 'AMBIGUOUS_NEITHER' }
    );

    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(result.stderr, /ambiguous/i);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 4);
  });

  test('ambiguous (both markers) => continue loop as safety', () => {
    const { cwd, termSessionId } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    writeStateFile(cwd, termSessionId, { iteration: 2 });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { TERM_SESSION_ID: termSessionId, WATCHDOG_FAKE_HAIKU_VERDICT: 'AMBIGUOUS_BOTH' }
    );

    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(result.stderr, /ambiguous/i);
  });

  test('CLI failure (exit 1) => continue loop as safety', () => {
    const { cwd, termSessionId } = makeSession();
    const transcript = writeTranscriptWithToolUse(cwd);
    const stateFile = writeStateFile(cwd, termSessionId, { iteration: 1 });

    const result = runHook(
      cwd,
      { session_id: 'OWNER', transcript_path: transcript },
      { TERM_SESSION_ID: termSessionId, WATCHDOG_FAKE_HAIKU_VERDICT: 'FAIL' }
    );

    assert.equal(result.status, 0);
    const decision = JSON.parse(result.stdout);
    assert.equal(decision.decision, 'block');
    assert.match(result.stderr, /judgment call failed/i);

    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(state.iteration, 2);
  });
});
