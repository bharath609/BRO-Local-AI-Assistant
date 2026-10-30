const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');

const appSource = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');

test('chat voice and Wispr text can auto-submit the activate BRO wake command', () => {
  assert.match(appSource, /function isActivateBroCommand/);
  assert.match(appSource, /function scheduleActivateBro/);
  assert.match(appSource, /scheduleActivateBro\(transcript\)/);
  assert.match(appSource, /scheduleActivateBro\(els\.input\.value\)/);
});
