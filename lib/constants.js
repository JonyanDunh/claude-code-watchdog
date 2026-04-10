'use strict';

// Shared constants for all watchdog entry points. Keeping them in one place
// avoids drift between setup-watchdog.js, stop-watchdog.js, and stop-hook.js.

const path = require('path');

const STATE_DIR = '.claude';
const STATE_FILE_PREFIX = 'watchdog.';
const STATE_FILE_SUFFIX = '.local.json';

// Distinctive marker tokens the headless Haiku classifier must emit.
// FILE_CHANGES is a substring of NO_FILE_CHANGES, so the parser must strip
// NO_FILE_CHANGES before searching for a bare FILE_CHANGES.
const MARKER_FILE_CHANGES = 'FILE_CHANGES';
const MARKER_NO_FILE_CHANGES = 'NO_FILE_CHANGES';

// Judgment prompt. Intentionally short: the whole decision is "does this JSON
// of tool invocations represent a project-file mutation?". The classifier sees
// every tool's full input so it can catch Bash sed -i, MCP SQL writes, etc.
const JUDGMENT_PROMPT_TEMPLATE = (toolUsesJson) => `You are a binary classifier. Below is a JSON array of tool invocations from a single agent turn. Did any of them directly modify any project file?

A "project file" is any file a developer would consider part of their project: source code, tests, configuration, documentation, dotfiles, .git/* metadata, lock files, package manifests, etc. — essentially anything that belongs under version control, plus the .git internals that track it.

When in doubt, err on ${MARKER_FILE_CHANGES}.

Output exactly one uppercase token with no other text:
- ${MARKER_FILE_CHANGES}    if at least one invocation directly modified a project file
- ${MARKER_NO_FILE_CHANGES} if no project file was modified

Tool invocations:
${toolUsesJson}`;

// Verification reminder appended to the re-fed prompt. Plain English, no
// mention of "loop" or "iteration" — the agent must not know it is inside
// a watchdog.
const VERIFICATION_REMINDER = 'Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.';

function stateFilePath(cwd, termSessionId) {
  return path.join(cwd, STATE_DIR, `${STATE_FILE_PREFIX}${termSessionId}${STATE_FILE_SUFFIX}`);
}

module.exports = {
  STATE_DIR,
  STATE_FILE_PREFIX,
  STATE_FILE_SUFFIX,
  MARKER_FILE_CHANGES,
  MARKER_NO_FILE_CHANGES,
  JUDGMENT_PROMPT_TEMPLATE,
  VERIFICATION_REMINDER,
  stateFilePath,
};
