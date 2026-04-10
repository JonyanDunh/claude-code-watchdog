'use strict';

// Headless Haiku classifier. Given a JSON array of tool invocations, ask a
// short-lived `claude -p --model haiku --no-session-persistence` subprocess
// whether any of them directly modified a project file. The output is a
// single distinctive marker token: FILE_CHANGES or NO_FILE_CHANGES.

const { spawnSync } = require('child_process');
const {
  JUDGMENT_PROMPT_TEMPLATE,
  MARKER_FILE_CHANGES,
  MARKER_NO_FILE_CHANGES,
} = require('./constants');

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

function claudeCliAvailable() {
  // Cheapest cross-platform probe: try to run `claude --version`. On Windows
  // we need shell:true so .cmd shims resolve.
  const isWindows = process.platform === 'win32';
  const result = spawnSync('claude', ['--version'], {
    stdio: 'ignore',
    shell: isWindows,
  });
  return result.status === 0;
}

// Ask Haiku. Returns one of the VERDICT constants plus (for the normal cases)
// the raw output string for logging/ambiguous fallback diagnostics.
function askHaiku(toolUses) {
  if (!claudeCliAvailable()) {
    return { verdict: VERDICT.CLI_MISSING, raw: null };
  }

  const promptText = JUDGMENT_PROMPT_TEMPLATE(JSON.stringify(toolUses));
  const isWindows = process.platform === 'win32';

  const result = spawnSync(
    'claude',
    ['-p', '--model', 'haiku', '--no-session-persistence', promptText],
    {
      input: '', // close stdin — avoids the 3-second "no stdin data" warning
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: isWindows,
      maxBuffer: 1024 * 1024,
    }
  );

  if (result.error || result.status !== 0) {
    return {
      verdict: VERDICT.CLI_FAILED,
      exitCode: result.status,
      error: result.error && result.error.message,
      raw: result.stdout,
    };
  }

  return { verdict: parseVerdict(result.stdout), raw: result.stdout };
}

// claudeCliAvailable() is intentionally NOT exported — it is an internal
// pre-flight check used by askHaiku() and has no other consumers.
module.exports = {
  VERDICT,
  parseVerdict,
  askHaiku,
};
