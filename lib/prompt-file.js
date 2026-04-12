'use strict';

// Shared prompt-file reader. Used by:
//   - scripts/setup-watchdog.js when the user passes --prompt-file at start
//   - hooks/stop-hook.js when --watch-prompt-file enables hot-reload, so the
//     prompt can be edited mid-loop and the next iteration sees the new text
//
// The reader bypasses shell argument escaping entirely (the whole reason
// --prompt-file exists in the first place — see commit history for v1.2.4).
// It strips a leading UTF-8 BOM, trims surrounding whitespace, and reports
// clean error messages for the common failure modes.
//
// Returns `{ prompt, resolvedPath }` on success or `{ error }` on failure.
// Callers handle the error their own way: setup-watchdog prints to stderr and
// exits, stop-hook silently keeps the cached prompt and logs to debug only.

const fs = require('fs');
const path = require('path');

function readPromptFile(promptFile, baseCwd = process.cwd()) {
  const resolved = path.resolve(baseCwd, promptFile);
  let contents;
  try {
    contents = fs.readFileSync(resolved, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { error: `prompt file not found: ${resolved}` };
    }
    if (e.code === 'EISDIR') {
      return { error: `--prompt-file expects a file, got a directory: ${resolved}` };
    }
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      return { error: `permission denied reading prompt file: ${resolved}` };
    }
    return { error: `failed to read prompt file ${resolved}: ${e.message}` };
  }
  // Strip UTF-8 BOM. Windows tools (Notepad, PowerShell's `Set-Content`
  // without `-Encoding utf8NoBOM`) frequently add U+FEFF at the start of
  // UTF-8 files. `.trim()` does not remove it (BOM is not whitespace), so
  // without this line the first char of the prompt Claude sees would be
  // an invisible zero-width marker.
  if (contents.charCodeAt(0) === 0xfeff) {
    contents = contents.slice(1);
  }
  const prompt = contents.trim();
  if (!prompt) {
    return { error: `prompt file is empty: ${resolved}` };
  }
  return { prompt, resolvedPath: resolved };
}

module.exports = { readPromptFile };
