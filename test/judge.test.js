'use strict';

// Judgment verdict parser tests. The classifier subprocess is NOT called
// here — we only test the pure verdict parsing logic.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVerdict, VERDICT } = require('../lib/judge');

test('parseVerdict: bare FILE_CHANGES => FILE_CHANGES', () => {
  assert.equal(parseVerdict('FILE_CHANGES'), VERDICT.FILE_CHANGES);
});

test('parseVerdict: bare NO_FILE_CHANGES => NO_FILE_CHANGES', () => {
  assert.equal(parseVerdict('NO_FILE_CHANGES'), VERDICT.NO_FILE_CHANGES);
});

test('parseVerdict: FILE_CHANGES with trailing whitespace', () => {
  assert.equal(parseVerdict('FILE_CHANGES\n'), VERDICT.FILE_CHANGES);
});

test('parseVerdict: NO_FILE_CHANGES with prose before it', () => {
  assert.equal(parseVerdict('The verdict is NO_FILE_CHANGES because ...'), VERDICT.NO_FILE_CHANGES);
});

test('parseVerdict: FILE_CHANGES is NOT a false positive inside NO_FILE_CHANGES', () => {
  // If we grepped naively, "NO_FILE_CHANGES" contains "FILE_CHANGES" and we
  // would wrongly flag FILE_CHANGES. Verify we strip first.
  assert.equal(parseVerdict('NO_FILE_CHANGES'), VERDICT.NO_FILE_CHANGES);
});

test('parseVerdict: both tokens present => AMBIGUOUS', () => {
  assert.equal(
    parseVerdict('First I thought NO_FILE_CHANGES then I changed my mind to FILE_CHANGES'),
    VERDICT.AMBIGUOUS
  );
});

test('parseVerdict: neither token present => AMBIGUOUS', () => {
  assert.equal(parseVerdict('I think yes maybe no'), VERDICT.AMBIGUOUS);
});

test('parseVerdict: empty string => AMBIGUOUS', () => {
  assert.equal(parseVerdict(''), VERDICT.AMBIGUOUS);
});

test('parseVerdict: null / non-string => AMBIGUOUS', () => {
  assert.equal(parseVerdict(null), VERDICT.AMBIGUOUS);
  assert.equal(parseVerdict(undefined), VERDICT.AMBIGUOUS);
  assert.equal(parseVerdict(42), VERDICT.AMBIGUOUS);
});

test('parseVerdict: multiple NO_FILE_CHANGES stripped, leaves bare FILE_CHANGES', () => {
  // Weird edge case: NO_FILE_CHANGES NO_FILE_CHANGES FILE_CHANGES -> should
  // be ambiguous because both tokens appear in original; stripping only
  // removes NO_*, leaving FILE_CHANGES, but hasNo remains true.
  assert.equal(
    parseVerdict('NO_FILE_CHANGES NO_FILE_CHANGES FILE_CHANGES'),
    VERDICT.AMBIGUOUS
  );
});

test('parseVerdict: repeated FILE_CHANGES only => FILE_CHANGES', () => {
  assert.equal(parseVerdict('FILE_CHANGES FILE_CHANGES'), VERDICT.FILE_CHANGES);
});
