'use strict';

// Headless Haiku classifier. Given a JSON array of tool invocations, ask a
// short-lived `claude -p --model haiku --no-session-persistence` subprocess
// whether any of them directly modified a project file. The output is a
// single distinctive marker token: FILE_CHANGES or NO_FILE_CHANGES.
//
// Prompt delivery:
//   Prompt is passed via **stdin**, not as a positional argv arg. On
//   Windows, spawnSync with `shell: true` (required to find claude.cmd
//   through PATHEXT) forwards the whole command line through cmd.exe,
//   whose quoting rules destroy complex strings containing newlines,
//   CJK characters, double quotes, or JSON braces. The prompt text is
//   exactly that kind of payload — a templated classifier prompt with
//   a JSON-serialized tool_use array embedded in it. Passing it via
//   stdin sidesteps cmd.exe entirely: the shell never sees the text.
//   On Linux/macOS (shell: false), stdin works identically and we get
//   a single code path across OSes. The `claude -p` CLI reads stdin
//   when no positional prompt arg is provided.
//
// Performance notes:
//   - No pre-flight `claude --version` probe. On Windows it took an extra
//     ~2-3 s (PowerShell cold-start through shell:true) for zero value:
//     if the CLI is missing, the real call below will fail with ENOENT
//     and we just classify that as CLI_MISSING.
//   - 30-second timeout on the real Haiku call. If the Claude CLI ever
//     hangs — network stall, auth refresh, etc. — the hook aborts cleanly
//     instead of running past Claude Code's internal hook timeout and
//     leaving the user with a stuck loop.

const { spawnSync } = require('child_process');
const {
  JUDGMENT_PROMPT_TEMPLATE,
  MARKER_FILE_CHANGES,
  MARKER_NO_FILE_CHANGES,
} = require('./constants');
const { debug } = require('./log');

const HAIKU_TIMEOUT_MS = 30000;

const VERDICT = Object.freeze({
  FILE_CHANGES: 'FILE_CHANGES',
  NO_FILE_CHANGES: 'NO_FILE_CHANGES',
  AMBIGUOUS: 'AMBIGUOUS',
  CLI_MISSING: 'CLI_MISSING',
  CLI_FAILED: 'CLI_FAILED',
});

// Parse the raw Haiku output into a verdict. FILE_CHANGES is a substring of
// NO_FILE_CHANGES, so we strip NO_FILE_CHANGES first and then look for a bare
// FILE_CHANGES in what remains. Both-present or neither-present => ambiguous.
function parseVerdict(rawOutput) {
  if (typeof rawOutput !== 'string' || rawOutput.length === 0) {
    return VERDICT.AMBIGUOUS;
  }
  const stripped = rawOutput.split(MARKER_NO_FILE_CHANGES).join('');
  const hasYes = stripped.includes(MARKER_FILE_CHANGES);
  const hasNo = rawOutput.includes(MARKER_NO_FILE_CHANGES);
  if (!hasYes && hasNo) return VERDICT.NO_FILE_CHANGES;
  if (hasYes && !hasNo) return VERDICT.FILE_CHANGES;
  return VERDICT.AMBIGUOUS;
}

// Ask Haiku. Returns one of the VERDICT constants plus (for the normal cases)
// the raw output string for logging/ambiguous fallback diagnostics.
function askHaiku(toolUses) {
  const promptText = JUDGMENT_PROMPT_TEMPLATE(JSON.stringify(toolUses));
  const isWindows = process.platform === 'win32';

  debug(`askHaiku: starting subprocess (timeout=${HAIKU_TIMEOUT_MS}ms, tools=${toolUses.length})`);
  const start = Date.now();

  const result = spawnSync(
    'claude',
    ['-p', '--model', 'haiku', '--no-session-persistence'],
    {
      input: promptText, // prompt via stdin — avoids cmd.exe quoting on Windows
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows,
      maxBuffer: 1024 * 1024,
      timeout: HAIKU_TIMEOUT_MS,
    }
  );

  const elapsed = Date.now() - start;
  debug(
    `askHaiku subprocess finished in ${elapsed}ms (exit=${result.status}, signal=${
      result.signal || 'none'
    })`
  );

  if (result.error) {
    // ENOENT = `claude` not in PATH
    if (result.error.code === 'ENOENT') {
      debug('askHaiku: claude CLI not found in PATH (ENOENT)');
      return { verdict: VERDICT.CLI_MISSING, raw: null };
    }
    // ETIMEDOUT = hit our HAIKU_TIMEOUT_MS guard
    debug(`askHaiku: spawn error ${result.error.code || '?'}: ${result.error.message}`);
    return {
      verdict: VERDICT.CLI_FAILED,
      exitCode: result.status,
      error: result.error.message,
      raw: result.stdout,
    };
  }

  if (result.status !== 0) {
    debug(
      `askHaiku: subprocess exited ${result.status} (stderr: ${(result.stderr || '').slice(0, 200)})`
    );
    return {
      verdict: VERDICT.CLI_FAILED,
      exitCode: result.status,
      raw: result.stdout,
    };
  }

  const verdict = parseVerdict(result.stdout);
  debug(
    `askHaiku verdict: ${verdict} (raw head: ${(result.stdout || '').slice(0, 80).replace(/\n/g, ' ')})`
  );
  return { verdict, raw: result.stdout };
}

// claudeCliAvailable() is intentionally NOT exported — it is an internal
// pre-flight check used by askHaiku() and has no other consumers.
module.exports = {
  VERDICT,
  parseVerdict,
  askHaiku,
};
