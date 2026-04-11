'use strict';

// Find the Claude Code process ID by walking up the process ancestry.
// Every subprocess Claude Code spawns (slash commands, Stop hooks, etc.)
// sits somewhere under a `claude` process in the pid tree. We walk up
// from our own ppid until we find one whose process name is `claude`,
// and use that pid as the per-session key.
//
// Why this instead of TERM_SESSION_ID: most terminals do NOT export
// TERM_SESSION_ID (only JetBrains, iTerm2, WezTerm). Claude Code PID
// is always available and 100% unique per session.
//
// Why this instead of session_id from HOOK_INPUT: HOOK_INPUT is only
// available to hooks, not to setup slash commands. Claude Code PID is
// accessible to both via process.ppid walking.
//
// Haiku-subprocess isolation falls out naturally: the headless
// `claude -p --model haiku ...` subprocess we spawn from stop-hook.js
// gets its own fresh Claude Code process with a fresh PID, and its
// own Stop hook's ancestry walk terminates at THAT fresh PID, not the
// main session's PID. No explicit recursion guard needed.

const fs = require('fs');
const cp = require('child_process');

const MAX_WALK_DEPTH = 10;

function readProcComm(pid) {
  const platform = process.platform;
  try {
    if (platform === 'linux') {
      // Fast path — zero subprocess spawn.
      return fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    }
    if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') {
      const out = cp.execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      // macOS returns the full executable path in `comm`. Take the basename.
      return out.trim().split('/').pop();
    }
    if (platform === 'win32') {
      // Use PowerShell CIM — more reliable than the deprecated wmic.
      const out = cp.execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").Name`,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      return out.trim();
    }
  } catch {
    return null;
  }
  return null;
}

function readProcPpid(pid) {
  const platform = process.platform;
  try {
    if (platform === 'linux') {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      const m = status.match(/^PPid:\s*(\d+)/m);
      return m ? parseInt(m[1], 10) : null;
    }
    if (platform === 'darwin' || platform === 'freebsd' || platform === 'openbsd') {
      const out = cp.execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    if (platform === 'win32') {
      const out = cp.execFileSync(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").ParentProcessId`,
        ],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
  } catch {
    return null;
  }
  return null;
}

// Does this process name identify the Claude Code CLI? Comm names differ
// across platforms and install methods:
//   Linux / WSL     — "claude"
//   macOS (Homebrew)— "claude"
//   Windows         — "claude.exe" (or "claude.cmd" if launched via shim)
// We also tolerate "Claude Code" in case of app bundle installs.
function isClaudeProcessName(name) {
  if (!name) return false;
  const lower = String(name).toLowerCase().trim();
  if (lower === 'claude') return true;
  if (lower === 'claude.exe') return true;
  if (lower === 'claude.cmd') return true;
  if (lower === 'claude code') return true;
  return false;
}

// Find the Claude Code process ID by walking ancestors upward from
// `process.ppid`. Returns an integer pid on success, null on failure.
//
// Test override: WATCHDOG_CLAUDE_PID env var short-circuits the walk.
// This is the ONLY way unit tests running outside a real Claude Code
// session can drive this module — the tests set this to an arbitrary
// integer that serves as the synthetic session key.
function findClaudePid() {
  const override = process.env.WATCHDOG_CLAUDE_PID;
  if (override && /^[1-9]\d*$/.test(override)) {
    return parseInt(override, 10);
  }

  let pid = process.ppid;
  for (let depth = 0; depth < MAX_WALK_DEPTH && pid && pid > 1; depth++) {
    const comm = readProcComm(pid);
    if (isClaudeProcessName(comm)) {
      return pid;
    }
    const nextPid = readProcPpid(pid);
    if (!nextPid || nextPid === pid) break;
    pid = nextPid;
  }

  return null;
}

module.exports = {
  findClaudePid,
  // Exposed for unit tests.
  _isClaudeProcessName: isClaudeProcessName,
  _readProcComm: readProcComm,
  _readProcPpid: readProcPpid,
};
