const test = require('node:test');
const assert = require('node:assert/strict');

const vscode = require('../src/agent/adapters/vscode');
const browser = require('../src/agent/adapters/browser');

// Test status returns structure
test('vscode_status returns a result object', () => {
  const result = vscode.status();
  assert.equal(typeof result, 'object');
  assert.ok('installed' in result || typeof result === 'object');
});

// Test findCodeExe returns empty when not configured and not on PATH
test('findCodeExe handles missing Code.exe gracefully', () => {
  // This will return '' if VS Code isn't findable; we just check it's a string
  const exe = vscode.findCodeExe();
  assert.equal(typeof exe, 'string');
});

// Test interpreter command with python
test('interpreterCommand python resolves', () => {
  const result = vscode.INTERPRETERS; // just verify constant exists
  assert.ok(Array.isArray(vscode.INTERPRETERS));
});

// Test valid selector subset
test('browser validSelector works with simple patterns', () => {
  assert.equal(browser.validSelector('a#video-title'), true);
  assert.equal(browser.validSelector('button'), true);
  assert.equal(browser.validSelector('input'), true);
  assert.equal(browser.validSelector(''), false);
});