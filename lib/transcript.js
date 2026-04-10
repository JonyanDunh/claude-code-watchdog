'use strict';

// Transcript parsing. Claude Code stores session history as newline-delimited
// JSON (JSONL). Each line is one message. We need to find the most recent
// real user turn (a turn initiated by the user, NOT a tool_result entry that
// also happens to have role="user") and extract every tool_use invocation
// the assistant made since then.

const fs = require('fs');

function safeParse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Is this a real user-initiated turn boundary? Claude Code writes tool
// results back with role="user", so we filter those out. The heuristic:
// a real user turn has a content array containing no tool_result entries,
// OR a plain string content.
function isRealUserTurn(entry) {
  if (!entry) return false;
  const msg = entry.message;
  if (!msg || msg.role !== 'user') return false;
  const content = msg.content;
  if (typeof content === 'string') return true;
  if (Array.isArray(content)) {
    // If every content item is a tool_result, this is not a real user turn.
    const hasNonToolResult = content.some((c) => c && c.type !== 'tool_result');
    return hasNonToolResult;
  }
  // Unknown shape — err on the side of "yes, real user turn", matches the
  // bash version's line-substring behavior.
  return true;
}

function isAssistantTurn(entry) {
  return !!(entry && entry.message && entry.message.role === 'assistant');
}

// Extract every tool_use invocation from an assistant message's content array.
function extractToolUses(entry) {
  const content = entry && entry.message && entry.message.content;
  if (!Array.isArray(content)) return [];
  const uses = [];
  for (const item of content) {
    if (item && item.type === 'tool_use') {
      uses.push({ tool: item.name, input: item.input });
    }
  }
  return uses;
}

// Main API: given a transcript path, return the array of tool invocations
// from the current (most recent) assistant turn. Returns [] if no tools
// were called, or if the transcript is empty / malformed.
function currentTurnToolUses(transcriptPath) {
  if (!fs.existsSync(transcriptPath)) {
    const err = new Error(`Transcript file not found at ${transcriptPath}`);
    err.code = 'TRANSCRIPT_NOT_FOUND';
    throw err;
  }

  const raw = fs.readFileSync(transcriptPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.length > 0);

  // Find the index of the most recent real user turn. If none, the whole
  // file is "current turn" — unusual but not fatal.
  let lastUserIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = safeParse(lines[i]);
    if (isRealUserTurn(entry)) {
      lastUserIdx = i;
      break;
    }
  }

  const toolUses = [];
  for (let i = lastUserIdx + 1; i < lines.length; i++) {
    const entry = safeParse(lines[i]);
    if (!isAssistantTurn(entry)) continue;
    for (const use of extractToolUses(entry)) {
      toolUses.push(use);
    }
  }

  return toolUses;
}

module.exports = {
  currentTurnToolUses,
  // Exposed for unit tests.
  _safeParse: safeParse,
  _isRealUserTurn: isRealUserTurn,
  _isAssistantTurn: isAssistantTurn,
  _extractToolUses: extractToolUses,
};
