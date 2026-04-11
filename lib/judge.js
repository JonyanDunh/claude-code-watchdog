'use strict';

// Classifier subprocess. Given a JSON array of tool invocations from one
// agent turn, spawn a short-lived `claude -p --model haiku` process and ask
// it whether any invocation directly modified a project file. The output is
// a single distinctive marker token: FILE_CHANGES or NO_FILE_CHANGES.
//
// ----------------------------------------------------------------------
// Flag cocktail (context purity + speed):
// ----------------------------------------------------------------------
//   -p / --print                  Headless print mode.
//   --model haiku                 Cheapest / fastest model; binary
//                                 classification doesn't need reasoning.
//   --effort low                  Minimize reasoning budget — classifier
//                                 should resolve in one shot.
//   --no-session-persistence      Don't save the session to disk.
//   --system-prompt-file <path>   REPLACE the default system prompt with
//                                 the file's contents. This also skips
//                                 CLAUDE.md auto-discovery, per-machine
//                                 sections, memory paths, git status
//                                 injection, etc. — all the things that
//                                 would otherwise contaminate the
//                                 classifier's context with project-
//                                 specific noise.
//
//                                 The prompt text is bundled with the
//                                 plugin at lib/classifier-system-prompt.txt.
//                                 We pass the PATH, not the text, because
//                                 Node's spawnSync with shell:true on
//                                 Windows (required for .cmd shim lookup)
//                                 passes argv elements through cmd.exe,
//                                 which splits multi-word strings on
//                                 spaces. A short space-free file path
//                                 survives; a 400-character sentence does
//                                 not. (Diagnosed from a real Haiku log:
//                                 "The text 'are' followed by what looks
//                                 like a Bash tool invocation..." — cmd.exe
//                                 had cut "You are a binary..." at the
//                                 first space.)
//   --tools ""                    Disable every BUILT-IN tool. Classifier
//                                 reads a JSON blob and returns one token;
//                                 it has no business touching files, the
//                                 network, or a shell. Note: this does
//                                 NOT disable MCP servers, which are
//                                 separate — we use the two flags below
//                                 for those.
//   --mcp-config <empty.json>     Override the merged MCP configuration
//   --strict-mcp-config           with a bundled empty file
//                                 (lib/empty-mcp-config.json) and refuse
//                                 all other sources. Without this, Haiku
//                                 inherits whatever MCP servers the user
//                                 has globally enabled (Datadog, Postgres,
//                                 Playwright, etc.) and starts responding
//                                 as a project assistant instead of a
//                                 binary classifier. File-based because
//                                 an inline `{"mcpServers":{}}` string
//                                 got its double quotes stripped by
//                                 cmd.exe on Windows shell:true and then
//                                 mis-parsed as a filename.
//   --disable-slash-commands      Disable all skills and commands. Blocks
//                                 every skill from superpowers, watchdog
//                                 itself, and any other plugin the user
//                                 happens to have enabled.
//   --output-format json          Emit a structured response envelope
//                                 on stdout instead of a bare text
//                                 response. Gives us the final result
//                                 text, cost, duration, num_turns, and
//                                 any other metadata in one parseable
//                                 object — extremely useful for the
//                                 diagnostic logs. The parser below
//                                 handles both shapes (JSON envelope
//                                 and bare text) so tests that mock
//                                 the CLI can still emit plain tokens.
//
// (Note on --max-turns: we used to pass --max-turns 1, but observed real
// classifier calls exit 1 on turns with only one tool_use — Haiku would
// try to take a second turn to reason about the sparse input and the cap
// caused a hard failure. The other flags above already constrain the
// subprocess enough; --max-turns was overkill belt-and-suspenders.)
//
// ----------------------------------------------------------------------
// Prompt delivery:
// ----------------------------------------------------------------------
//   - System prompt goes via --system-prompt-file as a path to the
//     bundled `lib/classifier-system-prompt.txt`.
//   - The tool_uses JSON (the "user message") goes via stdin. JSON arrays
//     contain braces, quotes, and potentially CJK characters — exactly
//     the kind of payload cmd.exe chokes on — so we keep it out of argv
//     entirely.
//
// ----------------------------------------------------------------------
// Performance notes:
// ----------------------------------------------------------------------
//   - No pre-flight `claude --version` probe. On Windows it took an extra
//     ~2-3 s (PowerShell cold-start through shell:true) for zero value:
//     if the CLI is missing, the real call below will fail with ENOENT
//     and we just classify that as CLI_MISSING.
//   - 30-second timeout on the real call. If the Claude CLI ever hangs —
//     network stall, auth refresh, etc. — the hook aborts cleanly instead
//     of running past Claude Code's internal hook timeout and leaving the
//     user with a stuck loop.

const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
const {
  JUDGMENT_SYSTEM_PROMPT_FILE,
  EMPTY_MCP_CONFIG_FILE,
  MARKER_FILE_CHANGES,
  MARKER_NO_FILE_CHANGES,
} = require('./constants');
const { debug } = require('./log');

const CLASSIFIER_TIMEOUT_MS = 30000;

const VERDICT = Object.freeze({
  FILE_CHANGES: 'FILE_CHANGES',
  NO_FILE_CHANGES: 'NO_FILE_CHANGES',
  AMBIGUOUS: 'AMBIGUOUS',
  CLI_MISSING: 'CLI_MISSING',
  CLI_FAILED: 'CLI_FAILED',
});

// Parse the classifier output into a verdict. FILE_CHANGES is a substring of
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

// Ask the classifier subprocess. Returns one of the VERDICT constants plus
// (for the normal cases) the raw output string for logging / ambiguous
// fallback diagnostics.
function askHaiku(toolUses) {
  const toolUsesJson = JSON.stringify(toolUses);
  const isWindows = process.platform === 'win32';

  // Sanity check: if the bundled config files are missing (broken plugin
  // install, shallow copy that dropped non-.js files, etc.), we refuse
  // to launch the subprocess. Better to fail the hook loudly than to
  // silently fall back to the default system prompt or the user's real
  // MCP config and have Haiku contaminated again.
  if (!fs.existsSync(JUDGMENT_SYSTEM_PROMPT_FILE)) {
    debug(
      `askHaiku: bundled system prompt file missing at ${JUDGMENT_SYSTEM_PROMPT_FILE} — refusing to launch classifier`
    );
    return {
      verdict: VERDICT.CLI_FAILED,
      error: `classifier system prompt file not found: ${JUDGMENT_SYSTEM_PROMPT_FILE}`,
      raw: null,
    };
  }
  if (!fs.existsSync(EMPTY_MCP_CONFIG_FILE)) {
    debug(
      `askHaiku: bundled empty MCP config file missing at ${EMPTY_MCP_CONFIG_FILE} — refusing to launch classifier`
    );
    return {
      verdict: VERDICT.CLI_FAILED,
      error: `classifier empty MCP config file not found: ${EMPTY_MCP_CONFIG_FILE}`,
      raw: null,
    };
  }

  const args = [
    '-p',
    '--model', 'haiku',
    '--effort', 'low',
    '--no-session-persistence',
    '--system-prompt-file', JUDGMENT_SYSTEM_PROMPT_FILE,
    '--mcp-config', EMPTY_MCP_CONFIG_FILE,
    '--strict-mcp-config',
    '--tools', '',
    '--disable-slash-commands',
    '--output-format', 'json',
  ];

  // Force a non-UNC cwd for the subprocess. On Windows, cmd.exe (spawned
  // here because of `shell: true`) cannot cd to UNC paths like
  // `\\wsl.localhost\Ubuntu-24.04\...`, so it silently falls back to
  // `C:\Windows\` and any RELATIVE file paths in our argv start getting
  // resolved from there (which is how an early version of this code
  // ended up looking for `C:\Windows\{mcpServers:{}}`). We pass every
  // flag value as an absolute path now, but we also set cwd explicitly
  // to os.tmpdir() as belt-and-suspenders. Bonus: os.tmpdir() is outside
  // any project directory, so Claude Code definitely won't auto-discover
  // a project-level CLAUDE.md or settings.json from it.
  const subprocessCwd = os.tmpdir();

  debug(
    `askHaiku: starting classifier subprocess (timeout=${CLASSIFIER_TIMEOUT_MS}ms, tools=${toolUses.length}, subprocessCwd=${subprocessCwd}, args=${JSON.stringify(args)})`
  );
  debug(`askHaiku: stdin (tool_uses JSON sent to classifier): ${toolUsesJson}`);
  const start = Date.now();

  const result = spawnSync('claude', args, {
    cwd: subprocessCwd, // non-UNC path; cmd.exe can actually cd here
    input: toolUsesJson, // only the data goes via stdin; instructions live in --system-prompt-file
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: isWindows,
    maxBuffer: 1024 * 1024,
    timeout: CLASSIFIER_TIMEOUT_MS,
  });

  const elapsed = Date.now() - start;
  debug(
    `askHaiku classifier finished in ${elapsed}ms (exit=${result.status}, signal=${
      result.signal || 'none'
    })`
  );

  // Log the complete subprocess output regardless of exit code — this is
  // the whole point of the log file: you turn it on when things are weird
  // and read back the exact bytes Haiku emitted. No truncation.
  debug(`askHaiku: full stdout (${(result.stdout || '').length} bytes): ${result.stdout || ''}`);
  if (result.stderr) {
    debug(`askHaiku: full stderr (${result.stderr.length} bytes): ${result.stderr}`);
  }

  if (result.error) {
    // ENOENT = `claude` not in PATH
    if (result.error.code === 'ENOENT') {
      debug('askHaiku: claude CLI not found in PATH (ENOENT)');
      return { verdict: VERDICT.CLI_MISSING, raw: null };
    }
    // ETIMEDOUT = hit our CLASSIFIER_TIMEOUT_MS guard
    debug(`askHaiku: spawn error ${result.error.code || '?'}: ${result.error.message}`);
    return {
      verdict: VERDICT.CLI_FAILED,
      exitCode: result.status,
      error: result.error.message,
      raw: result.stdout,
    };
  }

  if (result.status !== 0) {
    debug(`askHaiku: subprocess exited with non-zero status ${result.status}`);
    return {
      verdict: VERDICT.CLI_FAILED,
      exitCode: result.status,
      raw: result.stdout,
    };
  }

  // Try to parse the stdout as a JSON envelope (the expected shape when
  // --output-format json is passed). On success, extract the `result`
  // field and feed that to parseVerdict. On failure (e.g., the mock CLI
  // in test/stop-hook-haiku.test.js emits a bare token, not JSON), fall
  // back to the raw stdout — parseVerdict treats both shapes equivalently
  // because the marker tokens are distinctive substrings either way.
  let verdictText = result.stdout || '';
  let envelope = null;
  try {
    const parsed = JSON.parse(result.stdout);
    if (parsed && typeof parsed === 'object') {
      envelope = parsed;
      if (typeof parsed.result === 'string') {
        verdictText = parsed.result;
      }
    }
  } catch {
    // Not JSON — verdictText stays as the raw stdout. Expected for tests.
  }

  if (envelope) {
    debug(`askHaiku: parsed JSON envelope: ${JSON.stringify(envelope)}`);
    debug(`askHaiku: envelope.result (used for verdict parsing): ${verdictText}`);
  } else {
    debug('askHaiku: stdout was not valid JSON — using raw stdout for verdict parsing');
  }

  const verdict = parseVerdict(verdictText);
  debug(`askHaiku: parsed verdict = ${verdict}`);
  return { verdict, raw: result.stdout };
}

module.exports = {
  VERDICT,
  parseVerdict,
  askHaiku,
};
