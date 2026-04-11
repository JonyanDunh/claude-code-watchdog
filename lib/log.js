'use strict';

// Diagnostic logging. Every user-visible message goes to stderr so it
// never leaks into the agent's context (Claude Code captures slash
// command stdout as the user turn, stderr is shown to the user as local
// command output only).
//
// Optional file logging: set CLAUDE_CODE_WATCHDOG_LOG_ENABLED=1 to mirror
// every log line to a file at `os.tmpdir() + '/claude-code-watchdog.log'`
// (override via CLAUDE_CODE_WATCHDOG_LOG_FILE). The file is shared across
// all concurrent watchdog invocations; each line is prefixed with the
// current script's PID so you can grep by session.
//
// The debug() level is file-only — it never touches stderr — so we can
// sprinkle it liberally through hot paths without polluting the user's
// terminal when logging is disabled.

const fs = require('fs');
const os = require('os');
const path = require('path');

const LOG_ENABLED = process.env.CLAUDE_CODE_WATCHDOG_LOG_ENABLED === '1';
const LOG_FILE =
  process.env.CLAUDE_CODE_WATCHDOG_LOG_FILE ||
  path.join(os.tmpdir(), 'claude-code-watchdog.log');

function writeFileLog(level, message) {
  if (!LOG_ENABLED) return;
  try {
    const ts = new Date().toISOString();
    const line = `${ts} [pid=${process.pid}] ${level.padEnd(5)} ${message}\n`;
    fs.appendFileSync(LOG_FILE, line);
  } catch {
    // Never break the real hook path on log-write failure.
  }
}

function info(message) {
  process.stderr.write(`ℹ️  Watchdog: ${message}\n`);
  writeFileLog('info', message);
}

function warn(message) {
  process.stderr.write(`⚠️  Watchdog: ${message}\n`);
  writeFileLog('warn', message);
}

function success(message) {
  process.stderr.write(`✅ Watchdog: ${message}\n`);
  writeFileLog('ok', message);
}

function stop(message) {
  process.stderr.write(`🛑 Watchdog: ${message}\n`);
  writeFileLog('stop', message);
}

function error(message) {
  process.stderr.write(`❌ Error: ${message}\n`);
  writeFileLog('error', message);
}

// File-only verbose trace. Use freely in hot paths — zero overhead when
// logging is disabled (short-circuits on the LOG_ENABLED constant).
function debug(message) {
  writeFileLog('debug', message);
}

module.exports = {
  info,
  warn,
  success,
  stop,
  error,
  debug,
  // Exposed for tests.
  _LOG_ENABLED: LOG_ENABLED,
  _LOG_FILE: LOG_FILE,
};
