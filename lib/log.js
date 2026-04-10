'use strict';

// Diagnostic logging. Every message goes to stderr so it never leaks into
// the agent's context (Claude Code captures slash command stdout as the
// user turn, stderr is shown to the user as local command output only).

function info(message) {
  process.stderr.write(`ℹ️  Watchdog: ${message}\n`);
}

function warn(message) {
  process.stderr.write(`⚠️  Watchdog: ${message}\n`);
}

function success(message) {
  process.stderr.write(`✅ Watchdog: ${message}\n`);
}

function stop(message) {
  process.stderr.write(`🛑 Watchdog: ${message}\n`);
}

function error(message) {
  process.stderr.write(`❌ Error: ${message}\n`);
}

module.exports = { info, warn, success, stop, error };
