const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleChat } = require('../src/assistant');
const { matchWake, looksLikeCommand } = require('../src/voice');
const tools = require('../src/tools');

const overlaySource = fs.readFileSync(require.resolve('../public/overlay.js'), 'utf8');
const recorderSource = fs.readFileSync(require.resolve('../public/recorder.js'), 'utf8');
const serverSource = fs.readFileSync(require.resolve('../server.js'), 'utf8');
const emptyContext = { projects: [], settings: {}, user: { displayName: 'Bharath' } };

test('the wake matcher accepts the spoken name and keeps the rest of the sentence', () => {
  assert.deepEqual(matchWake('Bro.'), { wake: true, sleep: false, remainder: '', commandText: '' });
  assert.deepEqual(matchWake('Hey BRO'), { wake: true, sleep: false, remainder: '', commandText: '' });
  assert.deepEqual(matchWake('Brother'), { wake: true, sleep: false, remainder: '', commandText: '' });

  const combined = matchWake('Hey BRO, open Telegram.');
  assert.equal(combined.wake, true);
  assert.equal(combined.remainder, 'open telegram');
  assert.equal(combined.commandText, 'open telegram');
});

test('ordinary speech does not wake BRO', () => {
  for (const text of ['brown', 'brotherhood', 'open telegram', 'what is the weather', '']) {
    assert.equal(matchWake(text).wake, false, text);
  }
});

test('sleep phrases put the microphone away', () => {
  for (const text of ['Sleep', 'stop listening', 'Go to sleep', 'goodbye', "that's all"]) {
    assert.equal(matchWake(text).sleep, true, text);
  }
});

test('only command-shaped remainders run immediately', () => {
  assert.equal(looksLikeCommand('open telegram'), true);
  assert.equal(looksLikeCommand('close chrome'), true);
  assert.equal(looksLikeCommand('what time is it'), false);
  assert.equal(matchWake('bro what time is it').commandText, '');
});

test('the popup listens for the wake word between commands', () => {
  assert.match(overlaySource, /api\('\/api\/voice\/wake'/);
  assert.match(overlaySource, /result\.commandText/);
  assert.match(overlaySource, /result\.sleep/);
  assert.match(overlaySource, /startWakeMode/);
  assert.match(overlaySource, /Say “BRO”/);
  assert.match(overlaySource, /state\.phase === 'awake'/);
  assert.match(overlaySource, /mic\.startWatch/);
  assert.match(overlaySource, /stopWatch/);
  assert.match(recorderSource, /startWatch/);
  assert.match(recorderSource, /stopCapture/);
  assert.match(serverSource, /pathname === '\/api\/voice\/wake'/);
});

test('the wake endpoint rejects a clip that is not audio', async () => {
  const { server } = require('../server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/voice/wake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: Buffer.alloc(120, 1).toString('base64') }),
    });
    assert.equal(response.status, 400);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('close commands resolve apps, everything, and the last target', async () => {
  const telegram = await handleChat({ ...emptyContext, message: 'close telegram' });
  assert.equal(telegram.actions[0].type, 'close_app');
  assert.equal(telegram.actions[0].args.id, 'telegram');

  const quit = await handleChat({ ...emptyContext, message: 'quit chrome' });
  assert.equal(quit.actions[0].type, 'close_app');
  assert.equal(quit.actions[0].args.id, 'chrome');

  const everything = await handleChat({ ...emptyContext, message: 'close everything' });
  assert.equal(everything.actions[0].type, 'close_opened_apps');

  const multiple = await handleChat({ ...emptyContext, message: 'close telegram and chrome' });
  assert.deepEqual(multiple.actions.map((action) => action.args.id), ['telegram', 'chrome']);
});

test('“close that” replays the last opened app but not a website', async () => {
  const lastTarget = { kind: 'app', id: 'telegram', label: 'Telegram' };
  const result = await handleChat({ ...emptyContext, message: 'close that', context: { lastTarget } });
  assert.equal(result.actions[0].type, 'close_app');
  assert.equal(result.actions[0].args.id, 'telegram');

  const site = await handleChat({ ...emptyContext, message: 'close that', context: { lastTarget: { kind: 'site', url: 'https://www.youtube.com/' } } });
  assert.deepEqual(site.actions, []);
  assert.match(site.reply, /browser tabs/i);
});

test('closing a website explains, and an uncatalogued name still gets a close attempt', async () => {
  const site = await handleChat({ ...emptyContext, message: 'close gmail' });
  assert.deepEqual(site.actions, []);
  assert.match(site.reply, /web page/i);

  // Anything else is still attempted by process name and window title, so
  // “close <whatever I opened>” always does something.
  const unknown = await handleChat({ ...emptyContext, message: 'close quantum banana' });
  assert.equal(unknown.actions[0].type, 'close_named_app');
  assert.equal(unknown.actions[0].args.name, 'quantum banana');
});

test('the popup hides itself after 20 seconds and comes back on “BRO”', () => {
  assert.match(overlaySource, /AUTO_HIDE_MS = .*20000/);
  assert.match(overlaySource, /scheduleAutoHide/);
  assert.match(overlaySource, /hideOverlay\(\)/);
  assert.match(overlaySource, /showOverlay\(\)/);
  assert.match(overlaySource, /hideTimer/);
  const mainSource = fs.readFileSync(require.resolve('../desktop/main.js'), 'utf8');
  assert.match(mainSource, /bro-hide-overlay/);
  assert.match(mainSource, /bro-show-overlay/);
  const preload = fs.readFileSync(require.resolve('../desktop/preload.js'), 'utf8');
  assert.match(preload, /hideOverlay\(\)/);
  assert.match(preload, /showOverlay\(\)/);
});

test('Windows shell processes are never closed', { skip: process.platform !== 'win32' }, async () => {
  const result = await tools.closeProcesses(['explorer.exe']);
  assert.equal(result.closed, false);
  assert.deepEqual(result.protectedNames, ['explorer.exe']);
});

test('the catalog protects File Explorer and lists closeable processes', () => {
  const catalog = require('../src/app-catalog.json');
  const explorer = catalog.apps.find((app) => app.id === 'file_explorer');
  assert.equal(explorer.protected, true);
  const telegram = catalog.apps.find((app) => app.id === 'telegram');
  assert.deepEqual(telegram.processes, ['Telegram.exe']);
  for (const app of catalog.apps) {
    if (app.webOnly) {
      assert.ok(app.url, app.id);
      continue;
    }
    assert.ok(Array.isArray(app.processes) && app.processes.length > 0, app.id);
  }
});
