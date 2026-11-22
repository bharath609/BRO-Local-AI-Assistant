const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonLines } = require('../src/agent/win');

test('parseJsonLines handles valid JSON array', () => {
  const result = parseJsonLines('[{"a":1},{"b":2}]');
  assert.deepStrictEqual(result, [{ a: 1 }, { b: 2 }]);
});

test('parseJsonLines handles valid JSON object', () => {
  const result = parseJsonLines('{"a":1}');
  // The function always returns an array (even for a single object)
  assert.deepStrictEqual(result, [{ a: 1 }]);
});

test('parseJsonLines handles plain text when no JSON', () => {
  const result = parseJsonLines('hello world');
  // No JSON found returns empty array
  assert.deepStrictEqual(result, []);
});

test('parseJsonLines handles empty string', () => {
  const result = parseJsonLines('');
  assert.deepStrictEqual(result, []);
});

test('parseJsonLines reverse search finds first valid JSON', () => {
  const result = parseJsonLines('garbage\n{"a":1}\nmore');
  assert.deepStrictEqual(result, [{ a: 1 }]);
});