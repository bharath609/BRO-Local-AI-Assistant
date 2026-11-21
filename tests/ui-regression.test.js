const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const styles = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');

test('the typing indicator is hidden by CSS even though it is a flex row', () => {
  // The stuck indicator was caused by `display:flex` overriding the HTML `hidden`
  // attribute. This rule makes the hidden state authoritative.
  assert.match(styles, /\.typing-indicator\[hidden\]\s*\{\s*display\s*:\s*none\s*;?\s*\}/);
});

test('busy state always toggles the indicator together with aria-hidden', () => {
  const setBusy = app.match(/function setBusy\([\s\S]*?\n  \}/);
  assert.ok(setBusy, 'setBusy must exist');
  assert.match(setBusy[0], /els\.typing\.hidden\s*=\s*!showThinking/);
  assert.match(setBusy[0], /setAttribute\('aria-hidden'/);
});

test('a chat turn is abortable and always resets the interface in finally', () => {
  assert.match(app, /streamChat\(/);
  assert.match(app, /new AbortController\(\)/);
  const sendMessage = app.match(/async function sendMessage\([\s\S]*?\n  \}/);
  assert.ok(sendMessage, 'sendMessage must exist');
  assert.match(sendMessage[0], /finally\s*\{/);
  assert.match(sendMessage[0], /setBusy\(false\)/);
});

test('the UI starts in a clean, idle state', () => {
  assert.match(app, /setBusy\(false,\s*false\)/);
});
