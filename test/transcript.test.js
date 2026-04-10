'use strict';

// Transcript parser unit tests — uses Node's built-in test runner (Node 18+).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const {
  currentTurnToolUses,
  _isRealUserTurn,
  _isAssistantTurn,
  _extractToolUses,
  _safeParse,
} = require('../lib/transcript');

const FIXTURES = path.join(__dirname, 'fixtures');

test('currentTurnToolUses returns only the most recent assistant turn', () => {
  const toolUses = currentTurnToolUses(path.join(FIXTURES, 'transcript-basic.jsonl'));
  // The most recent real user turn is "Now add one more line", and the
  // assistant made two tool calls after it: Edit and Bash.
  assert.equal(toolUses.length, 2);
  assert.equal(toolUses[0].tool, 'Edit');
  assert.equal(toolUses[0].input.file_path, '/tmp/foo.md');
  assert.equal(toolUses[1].tool, 'Bash');
  assert.equal(toolUses[1].input.command, 'ls /tmp/foo.md');
});

test('currentTurnToolUses returns [] when turn had only text', () => {
  const toolUses = currentTurnToolUses(path.join(FIXTURES, 'transcript-no-tools.jsonl'));
  assert.deepEqual(toolUses, []);
});

test('currentTurnToolUses returns read-only tools too (judge decides later)', () => {
  const toolUses = currentTurnToolUses(path.join(FIXTURES, 'transcript-read-only.jsonl'));
  assert.equal(toolUses.length, 2);
  assert.equal(toolUses[0].tool, 'Read');
  assert.equal(toolUses[1].tool, 'Grep');
});

test('currentTurnToolUses throws TRANSCRIPT_NOT_FOUND for missing file', () => {
  assert.throws(
    () => currentTurnToolUses('/tmp/nonexistent-watchdog-test.jsonl'),
    (err) => err.code === 'TRANSCRIPT_NOT_FOUND'
  );
});

test('_isRealUserTurn: real string-content user turn => true', () => {
  const entry = _safeParse('{"type":"user","message":{"role":"user","content":"hi"}}');
  assert.equal(_isRealUserTurn(entry), true);
});

test('_isRealUserTurn: tool_result-only user turn => false', () => {
  const entry = _safeParse('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"}]}}');
  assert.equal(_isRealUserTurn(entry), false);
});

test('_isRealUserTurn: mixed content with a tool_result AND text => true', () => {
  const entry = _safeParse('{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"ok"},{"type":"text","text":"also here is a follow-up"}]}}');
  assert.equal(_isRealUserTurn(entry), true);
});

test('_isRealUserTurn: assistant entry => false', () => {
  const entry = _safeParse('{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}');
  assert.equal(_isRealUserTurn(entry), false);
});

test('_isAssistantTurn: assistant entry => true', () => {
  const entry = _safeParse('{"type":"assistant","message":{"role":"assistant","content":[]}}');
  assert.equal(_isAssistantTurn(entry), true);
});

test('_extractToolUses picks only tool_use items, preserving name+input', () => {
  const entry = {
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: 'prelude' },
        { type: 'tool_use', id: 'a', name: 'Write', input: { file_path: '/x', content: 'y' } },
        { type: 'text', text: 'middle' },
        { type: 'tool_use', id: 'b', name: 'Bash', input: { command: 'ls', description: 'd' } },
      ],
    },
  };
  const uses = _extractToolUses(entry);
  assert.equal(uses.length, 2);
  assert.deepEqual(uses[0], { tool: 'Write', input: { file_path: '/x', content: 'y' } });
  assert.deepEqual(uses[1], { tool: 'Bash', input: { command: 'ls', description: 'd' } });
});

test('_safeParse returns null on malformed JSON instead of throwing', () => {
  assert.equal(_safeParse('{not json}'), null);
  assert.equal(_safeParse(''), null);
});
