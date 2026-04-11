'use strict';

// Shared constants for all watchdog entry points. Keeping them in one place
// avoids drift between setup-watchdog.js, stop-watchdog.js, and stop-hook.js.

const path = require('path');

const STATE_DIR = '.claude';
// State files are keyed by Claude Code's process ID — see lib/claude-pid.js
// for how that PID is discovered. The `claudepid.` segment makes the file
// name unambiguous and grep-friendly.
const STATE_FILE_PREFIX = 'watchdog.claudepid.';
const STATE_FILE_SUFFIX = '.local.json';
const STATE_FILE_GLOB = 'watchdog.claudepid.*.local.json';

// Distinctive marker tokens the classifier subprocess must emit.
// FILE_CHANGES is a substring of NO_FILE_CHANGES, so the parser must strip
// NO_FILE_CHANGES before searching for a bare FILE_CHANGES.
const MARKER_FILE_CHANGES = 'FILE_CHANGES';
const MARKER_NO_FILE_CHANGES = 'NO_FILE_CHANGES';

// Classifier system prompt — passed to the classifier subprocess via
// `claude --system-prompt-file <path>`, which replaces the default system
// prompt entirely and therefore skips CLAUDE.md auto-discovery, per-machine
// sections, memory paths, git status injection, etc.
//
// The prompt text itself lives in `lib/classifier-system-prompt.txt` and is
// shipped with the plugin. We pass the *file path* (not the prompt text) to
// the subprocess for two reasons:
//
//   1. Windows cmd.exe quoting. Node's spawnSync with shell:true (required
//      on Windows to find the claude.cmd shim via PATHEXT) forwards the
//      command line through cmd.exe, whose argv parsing splits on spaces.
//      A multi-word `--system-prompt "You are a binary classifier..."` gets
//      chopped into `--system-prompt You are a binary ...` and the tail
//      words become stray positional args. A file path is a single token
//      with no interior spaces (or at worst one, inside a well-known
//      AppData\Local\Temp shape) and survives the trip intact.
//
//   2. The prompt is static at install time — bundling it as a text file
//      means zero runtime file I/O to create it, no temp-dir cleanup, and
//      no race conditions between concurrent watchdog invocations.
//
// Anything that wants to read the actual prompt string can do so via
// fs.readFileSync(JUDGMENT_SYSTEM_PROMPT_FILE, 'utf8').
const JUDGMENT_SYSTEM_PROMPT_FILE = path.resolve(
  __dirname,
  'classifier-system-prompt.txt'
);

// A strict MCP config file that disables every MCP server. Passed via
// `claude --mcp-config <path> --strict-mcp-config` to guarantee the
// classifier subprocess does NOT load Datadog, Postgres, Playwright, or
// any other MCP servers the user happens to have configured globally.
//
// Originally this was an inline JSON string ('{"mcpServers":{}}') but
// empirically on Windows, cmd.exe stripped the embedded double quotes
// when Node forwarded the spawn through `shell: true`, leaving Claude
// Code to see the malformed `{mcpServers:{}}` string. It then fell back
// to treating the value as a file path, prepended it with the subprocess
// cwd (which, because of the UNC-path cwd issue below, was `C:\Windows`),
// and tried to open `C:\Windows\{mcpServers:{}}`. Hilarity ensued.
//
// File-based avoids both landmines: cmd.exe happily preserves a short
// space-free ASCII path, and Claude Code reads the file as honest JSON.
const EMPTY_MCP_CONFIG_FILE = path.resolve(__dirname, 'empty-mcp-config.json');

// Verification reminder appended to the re-fed prompt. Plain English, no
// mention of "loop" or "iteration" — the agent must not know it is inside
// a watchdog.
const VERIFICATION_REMINDER = 'Please re-run the verification by actually invoking tools. Do not, without performing any real tool calls, base your answer on prior context and tell me the check is complete.';

function stateFilePath(cwd, claudePid) {
  return path.join(cwd, STATE_DIR, `${STATE_FILE_PREFIX}${claudePid}${STATE_FILE_SUFFIX}`);
}

function stateFileDir(cwd) {
  return path.join(cwd, STATE_DIR);
}

// STATE_DIR / STATE_FILE_PREFIX / STATE_FILE_SUFFIX are intentionally NOT
// exported — they are implementation details of stateFilePath(), and the
// public surface should only expose the helper functions. STATE_FILE_GLOB
// IS exported so stop-watchdog.js can list all per-session state files
// when cancelling.
module.exports = {
  MARKER_FILE_CHANGES,
  MARKER_NO_FILE_CHANGES,
  JUDGMENT_SYSTEM_PROMPT_FILE,
  EMPTY_MCP_CONFIG_FILE,
  VERIFICATION_REMINDER,
  STATE_FILE_GLOB,
  stateFilePath,
  stateFileDir,
};
