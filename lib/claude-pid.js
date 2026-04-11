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
//
// ======================================================================
// Performance note (the Windows fast path):
// ======================================================================
// On Linux, every step of the walk is two file reads from /proc — near
// free. On macOS/BSD each step spawns `ps` twice, which is ~10-30 ms
// per level and still fast enough.
//
// Windows is different. A PowerShell cold start is 1-2 seconds. If we
// did the naïve "spawn a PowerShell per level for comm, then another
// for ppid" walk, a 5-level ancestry would need ten PowerShell spawns
// and cost 10-20 seconds *per hook invocation*, blowing past Claude
// Code's internal hook timeout.
//
// So on Windows we do ONE PowerShell spawn that walks the full
// ancestry in-process (via WMI) and prints a tab-separated table of
// `(pid, name, ppid)` tuples. We parse that in JS. ~1-2 seconds total.

const fs = require('fs');
const cp = require('child_process');
const { debug } = require('./log');

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
        timeout: 5000,
      });
      // macOS returns the full executable path in `comm`. Take the basename.
      return out.trim().split('/').pop();
    }
    // Windows: callers should NOT hit this path — use readAncestryWindows
    // instead for batch efficiency. Kept here only as a safety fallback.
    if (platform === 'win32') {
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
          timeout: 10000,
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
        timeout: 5000,
      });
      const n = parseInt(out.trim(), 10);
      return Number.isFinite(n) ? n : null;
    }
    if (platform === 'win32') {
      // See readProcComm comment — not the primary Windows path.
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
          timeout: 10000,
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

// Windows batch path: walk the full ancestry in ONE PowerShell process.
// Returns an array of {pid, name, ppid} tuples ordered child → parent,
// or null on failure. Used by findClaudePid() on Windows to avoid
// spawning PowerShell per ancestry level.
function readAncestryWindows(startPid) {
  const script = `$ErrorActionPreference='SilentlyContinue'
$curr = ${startPid}
$out = @()
for ($i = 0; $i -lt ${MAX_WALK_DEPTH}; $i++) {
  if ($curr -le 1) { break }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$curr"
  if (-not $p) { break }
  $out += "$curr\`t$($p.Name)\`t$($p.ParentProcessId)"
  $next = [int]$p.ParentProcessId
  if ($next -eq $curr) { break }
  $curr = $next
}
$out -join "\`n"`;

  try {
    const out = cp.execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 15000,
      }
    );
    return out
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [pidStr, name, ppidStr] = line.split('\t');
        return {
          pid: parseInt(pidStr, 10),
          name: (name || '').trim(),
          ppid: parseInt(ppidStr, 10),
        };
      });
  } catch (err) {
    debug(`readAncestryWindows failed: ${err && err.message}`);
    return null;
  }
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
    const pid = parseInt(override, 10);
    debug(`findClaudePid: WATCHDOG_CLAUDE_PID override = ${pid}`);
    return pid;
  }

  const start = Date.now();
  let result = null;

  if (process.platform === 'win32') {
    // Windows fast path — one PowerShell process for the whole walk.
    const ancestors = readAncestryWindows(process.ppid);
    debug(
      `findClaudePid[win32]: readAncestryWindows returned ${
        ancestors ? ancestors.length + ' entries' : 'null'
      }`
    );
    if (ancestors) {
      for (const entry of ancestors) {
        if (isClaudeProcessName(entry.name)) {
          result = entry.pid;
          break;
        }
      }
    }
  } else {
    // POSIX — per-level walk (fast on Linux via /proc, acceptable on macOS).
    let pid = process.ppid;
    for (let depth = 0; depth < MAX_WALK_DEPTH && pid && pid > 1; depth++) {
      const comm = readProcComm(pid);
      if (isClaudeProcessName(comm)) {
        result = pid;
        break;
      }
      const nextPid = readProcPpid(pid);
      if (!nextPid || nextPid === pid) break;
      pid = nextPid;
    }
  }

  const elapsed = Date.now() - start;
  debug(
    `findClaudePid took ${elapsed}ms on ${process.platform}, returned ${
      result === null ? 'null' : result
    }`
  );

  return result;
}

module.exports = {
  findClaudePid,
  // Exposed for unit tests.
  _isClaudeProcessName: isClaudeProcessName,
  _readProcComm: readProcComm,
  _readProcPpid: readProcPpid,
  _readAncestryWindows: readAncestryWindows,
};
