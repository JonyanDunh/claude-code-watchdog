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

test('setup --prompt-file reads file content as the prompt', () => {
  const pid = 200010;
  const promptText = '# Task\n\nDo the thing with `code` and "quotes" and $vars.';
  const promptFile = path.join(tmpDir, 'prompt-basic.txt');
  fs.writeFileSync(promptFile, promptText);

  const result = runSetup(['--prompt-file', promptFile], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, `${promptText}\n`);
  assert.equal(result.stderr, '');

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.prompt, promptText);
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(promptFile);
});

test('setup --prompt-file preserves multi-line content with shell metacharacters', () => {
  const pid = 200011;
  // Exactly the kind of content that breaks `$ARGUMENTS` substitution:
  // unescaped quotes, backticks, dollar signs, literal newlines, and a
  // Markdown code fence. The file path bypasses shell entirely.
  const promptText = [
    '# 任务: 为 PallasAI 构建知识库',
    '',
    '## 使命',
    '',
    '把所有 "业务逻辑" 和 `API` 调用关系梳理进 $KB_DIR',
    '',
    '```bash',
    'echo "hello" && cat file.txt | jq .name',
    '```',
    '',
    '最终消费者是 AI agent。',
  ].join('\n');
  const promptFile = path.join(tmpDir, 'prompt-multiline.txt');
  fs.writeFileSync(promptFile, promptText);

  const result = runSetup(
    ['--prompt-file', promptFile, '--max-iterations', '15'],
    { WATCHDOG_CLAUDE_PID: String(pid) }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, `${promptText}\n`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.prompt, promptText);
  assert.equal(state.max_iterations, 15);
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(promptFile);
});

test('setup --prompt-file trims surrounding whitespace but keeps interior newlines', () => {
  const pid = 200012;
  const core = 'Line 1\nLine 2\nLine 3';
  const promptFile = path.join(tmpDir, 'prompt-whitespace.txt');
  fs.writeFileSync(promptFile, `\n\n  ${core}  \n\n\n`);

  const result = runSetup(['--prompt-file', promptFile], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.prompt, core);
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(promptFile);
});

test('setup --prompt-file with missing path => exit 1 with clear error', () => {
  const missing = path.join(tmpDir, 'does-not-exist.txt');
  const result = runSetup(['--prompt-file', missing], { WATCHDOG_CLAUDE_PID: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /prompt file not found/i);
  assert.match(result.stderr, /does-not-exist\.txt/);
});

test('setup --prompt-file pointing at a directory => exit 1', () => {
  const result = runSetup(['--prompt-file', tmpDir], { WATCHDOG_CLAUDE_PID: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /directory/i);
});

test('setup --prompt-file with empty file => exit 1', () => {
  const emptyFile = path.join(tmpDir, 'empty.txt');
  fs.writeFileSync(emptyFile, '   \n\n  ');
  const result = runSetup(['--prompt-file', emptyFile], { WATCHDOG_CLAUDE_PID: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /empty/i);
  fs.unlinkSync(emptyFile);
});

test('setup --prompt-file without a path argument => exit 1', () => {
  const result = runSetup(['--prompt-file'], { WATCHDOG_CLAUDE_PID: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--prompt-file requires/);
});

test('setup rejects --prompt-file combined with an inline positional prompt', () => {
  const promptFile = path.join(tmpDir, 'prompt-conflict.txt');
  fs.writeFileSync(promptFile, 'from file');
  const result = runSetup(
    ['inline prompt', '--prompt-file', promptFile],
    { WATCHDOG_CLAUDE_PID: '1' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be combined/i);
  // State file must NOT have been created on the conflict path.
  assert.equal(fs.existsSync(stateFileFor(1)), false);
  fs.unlinkSync(promptFile);
});

test('setup --help lists the --prompt-file usage form', () => {
  const result = runSetup(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /--prompt-file/);
});

test('setup --prompt-file strips a UTF-8 BOM (Windows Notepad scenario)', () => {
  const pid = 200013;
  const promptText = '# 中文任务\n\n做某件事';
  const promptFile = path.join(tmpDir, 'prompt-bom.txt');
  // Write literal UTF-8 BOM bytes (EF BB BF) + the text. Using a Buffer
  // avoids accidentally stripping the BOM via fs's internal decoding.
  fs.writeFileSync(
    promptFile,
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(promptText, 'utf8')])
  );

  const result = runSetup(['--prompt-file', promptFile], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  // stdout must NOT start with U+FEFF — otherwise Claude sees an invisible
  // marker as the first char of the prompt.
  assert.equal(result.stdout.charCodeAt(0), '#'.charCodeAt(0));
  assert.equal(result.stdout, `${promptText}\n`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.prompt, promptText);
  assert.equal(state.prompt.charCodeAt(0), '#'.charCodeAt(0));
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(promptFile);
});

test('setup --prompt-file accepts a relative path (resolved against cwd)', () => {
  const pid = 200014;
  const promptText = 'relative path prompt';
  // Write the file inside tmpDir, then pass just the basename — setup runs
  // with cwd: tmpDir (see runSetup()), so a bare filename must resolve.
  const basename = 'prompt-relative.txt';
  const promptFile = path.join(tmpDir, basename);
  fs.writeFileSync(promptFile, promptText);

  const result = runSetup(['--prompt-file', basename], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stdout, `${promptText}\n`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.prompt, promptText);
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(promptFile);
});

test('setup --prompt-file accepts "./name" style relative path', () => {
  const pid = 200015;
  const promptText = 'dot-slash prompt';
  const basename = 'prompt-dotslash.txt';
  const promptFile = path.join(tmpDir, basename);
  fs.writeFileSync(promptFile, promptText);

  const result = runSetup(['--prompt-file', `./${basename}`], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.prompt, promptText);
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(promptFile);
});

test('setup --prompt-file preserves CRLF line endings inside content', () => {
  const pid = 200016;
  // Windows-style line endings. We do NOT convert these — the user's
  // prompt should reach Claude byte-for-byte (minus BOM and surrounding
  // whitespace). Claude handles CRLF fine in practice.
  const promptText = 'line one\r\nline two\r\nline three';
  const promptFile = path.join(tmpDir, 'prompt-crlf.txt');
  fs.writeFileSync(promptFile, promptText);

  const result = runSetup(['--prompt-file', promptFile], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.prompt, promptText);
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(promptFile);
});

test('setup --prompt-file accepts a filename with non-ASCII chars', () => {
  const pid = 200017;
  const promptText = 'unicode filename test';
  const promptFile = path.join(tmpDir, '提示词-测试.txt');
  fs.writeFileSync(promptFile, promptText);

  const result = runSetup(['--prompt-file', promptFile], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.prompt, promptText);
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(promptFile);
});

test('setup --prompt-file follows a symlink to the real file', { skip: process.platform === 'win32' }, () => {
  // Symlink creation on Windows requires elevated privileges or developer
  // mode, so skip there. On Linux/Mac fs.readFileSync follows symlinks
  // transparently — this test guards against someone "fixing" that by
  // switching to lstat/readlink.
  const pid = 200018;
  const promptText = 'via symlink';
  const realFile = path.join(tmpDir, 'prompt-real.txt');
  const linkFile = path.join(tmpDir, 'prompt-link.txt');
  fs.writeFileSync(realFile, promptText);
  fs.symlinkSync(realFile, linkFile);

  const result = runSetup(['--prompt-file', linkFile], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.prompt, promptText);
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(linkFile);
  fs.unlinkSync(realFile);
});

test('setup --prompt-file on unreadable file => exit 1 with permission error', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  // POSIX-only: chmod 0 the file so even the owner can't read it. Root
  // ignores file mode, so skip when running as root (common in CI
  // containers).
  const promptFile = path.join(tmpDir, 'prompt-unreadable.txt');
  fs.writeFileSync(promptFile, 'secret');
  fs.chmodSync(promptFile, 0o000);
  try {
    const result = runSetup(['--prompt-file', promptFile], { WATCHDOG_CLAUDE_PID: '1' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /permission denied/i);
  } finally {
    fs.chmodSync(promptFile, 0o600);
    fs.unlinkSync(promptFile);
  }
});

test('setup --exit-confirmations N persists in state file', () => {
  const pid = 200020;
  const result = runSetup(
    ['build the api', '--exit-confirmations', '3'],
    { WATCHDOG_CLAUDE_PID: String(pid) }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.exit_confirmations, 3);
  assert.equal(state.no_change_streak, 0);
  assert.equal(state.no_classifier, false);
  assert.equal(state.watch_prompt_file, false);
  assert.equal(state.prompt_file, null);
  fs.unlinkSync(stateFileFor(pid));
});

test('setup default (no --exit-confirmations) writes exit_confirmations=1', () => {
  const pid = 200021;
  const result = runSetup(['build the api'], { WATCHDOG_CLAUDE_PID: String(pid) });
  assert.equal(result.status, 0);
  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.exit_confirmations, 1);
  assert.equal(state.no_change_streak, 0);
  fs.unlinkSync(stateFileFor(pid));
});

test('setup --exit-confirmations rejects 0', () => {
  const result = runSetup(['build', '--exit-confirmations', '0'], { WATCHDOG_CLAUDE_PID: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--exit-confirmations must be >= 1/);
});

test('setup --exit-confirmations rejects negative integers', () => {
  const result = runSetup(['build', '--exit-confirmations', '-2'], { WATCHDOG_CLAUDE_PID: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--exit-confirmations must be a positive integer/);
});

test('setup --exit-confirmations rejects non-integer', () => {
  const result = runSetup(['build', '--exit-confirmations', '2.5'], { WATCHDOG_CLAUDE_PID: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--exit-confirmations must be a positive integer/);
});

test('setup --exit-confirmations without an argument => exit 1', () => {
  const result = runSetup(['build', '--exit-confirmations'], { WATCHDOG_CLAUDE_PID: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--exit-confirmations requires/);
});

test('setup --watch-prompt-file with a --prompt-file persists watch flag and resolved path', () => {
  const pid = 200022;
  const promptFile = path.join(tmpDir, 'watchable.txt');
  fs.writeFileSync(promptFile, 'live task');

  const result = runSetup(
    ['--prompt-file', promptFile, '--watch-prompt-file'],
    { WATCHDOG_CLAUDE_PID: String(pid) }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.watch_prompt_file, true);
  assert.equal(state.prompt_file, promptFile);
  assert.equal(state.prompt, 'live task');
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(promptFile);
});

test('setup --watch-prompt-file without --prompt-file => exit 1', () => {
  const result = runSetup(
    ['inline prompt', '--watch-prompt-file'],
    { WATCHDOG_CLAUDE_PID: '1' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--watch-prompt-file requires --prompt-file/);
});

test('setup --no-classifier persists in state file and defaults exit_confirmations to 1', () => {
  const pid = 200023;
  const result = runSetup(
    ['build the api', '--no-classifier'],
    { WATCHDOG_CLAUDE_PID: String(pid) }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.no_classifier, true);
  // exit_confirmations is still defaulted (1) but the hook will never read it
  // because it short-circuits on no_classifier first.
  assert.equal(state.exit_confirmations, 1);
  fs.unlinkSync(stateFileFor(pid));
});

test('setup --no-classifier + --exit-confirmations => exit 1 (mutually exclusive)', () => {
  const result = runSetup(
    ['build', '--no-classifier', '--exit-confirmations', '3'],
    { WATCHDOG_CLAUDE_PID: '1' }
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--no-classifier cannot be combined with --exit-confirmations/);
});

test('setup --no-classifier + --max-iterations 0 is allowed (infinite loop, manual stop only)', () => {
  const pid = 200024;
  const result = runSetup(
    ['build', '--no-classifier', '--max-iterations', '0'],
    { WATCHDOG_CLAUDE_PID: String(pid) }
  );
  assert.equal(result.status, 0);
  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.no_classifier, true);
  assert.equal(state.max_iterations, 0);
  fs.unlinkSync(stateFileFor(pid));
});

test('setup --prompt-file + --watch-prompt-file + --exit-confirmations + --max-iterations all combine', () => {
  const pid = 200025;
  const promptFile = path.join(tmpDir, 'combo.txt');
  fs.writeFileSync(promptFile, 'combo task');

  const result = runSetup(
    [
      '--prompt-file', promptFile,
      '--watch-prompt-file',
      '--exit-confirmations', '5',
      '--max-iterations', '30',
    ],
    { WATCHDOG_CLAUDE_PID: String(pid) }
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);

  const state = JSON.parse(fs.readFileSync(stateFileFor(pid), 'utf8'));
  assert.equal(state.prompt_file, promptFile);
  assert.equal(state.watch_prompt_file, true);
  assert.equal(state.exit_confirmations, 5);
  assert.equal(state.max_iterations, 30);
  assert.equal(state.no_classifier, false);
  fs.unlinkSync(stateFileFor(pid));
  fs.unlinkSync(promptFile);
});

test('setup --help mentions --exit-confirmations, --watch-prompt-file, and --no-classifier', () => {
  const result = runSetup(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /--exit-confirmations/);
  assert.match(result.stderr, /--watch-prompt-file/);
  assert.match(result.stderr, /--no-classifier/);
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
