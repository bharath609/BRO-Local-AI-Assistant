const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleChat } = require('../src/assistant');
const tools = require('../src/tools');

const emptyContext = { projects: [], settings: {}, user: { displayName: 'Bharath' } };
const isWindows = process.platform === 'win32';

test('open telegram resolves to an app or its website, never a project error', async () => {
  const result = await handleChat({ ...emptyContext, message: 'Open Telegram' });
  assert.equal(result.actions.length, 1);
  const action = result.actions[0];
  if (action.type === 'open_app') {
    assert.equal(action.args.id, 'telegram');
    assert.match(result.reply, /Opening Telegram/);
  } else {
    assert.equal(action.type, 'open_url');
    assert.match(action.args.url, /web\.telegram\.org/);
  }
  assert.doesNotMatch(result.reply, /registered project/i);
});

test('asking for the website explicitly prefers the web app', async () => {
  const result = await handleChat({ ...emptyContext, message: 'open the telegram website' });
  assert.equal(result.actions[0].type, 'open_url');
  assert.equal(result.actions[0].args.url, 'https://web.telegram.org/');
});

test('spoken app phrasing is normalised before resolution', async () => {
  for (const message of [
    'open telegram app',
    'launch telegram',
    'please launch telegram on my pc',
    'take me to telegram',
    'show me telegram',
  ]) {
    const result = await handleChat({ ...emptyContext, message });
    assert.equal(result.actions.length, 1, message);
    assert.ok(['open_app', 'open_url'].includes(result.actions[0].type), message);
    assert.doesNotMatch(result.reply, /registered project/i, message);
  }
});

test('known sites still resolve to URLs', async () => {
  const gmail = await handleChat({ ...emptyContext, message: 'check my gmail' });
  assert.equal(gmail.actions[0].type, 'open_url');
  assert.equal(gmail.actions[0].args.url, 'https://mail.google.com/');

  const youtube = await handleChat({ ...emptyContext, message: 'open youtube' });
  assert.equal(youtube.actions[0].args.url, 'https://www.youtube.com/');
});

test('an unknown name produces a helpful reply instead of a project error', async () => {
  const result = await handleChat({ ...emptyContext, message: 'open quantum banana' });
  assert.deepEqual(result.actions, []);
  assert.match(result.reply, /installed apps/i);
  assert.doesNotMatch(result.reply, /registered project named/i);
});

test('the same request is understood in many phrasings', async () => {
  const forms = [
    'open telegram',
    'open up telegram',
    'launch telegram',
    'fire up telegram',
    'boot up telegram',
    'bro open telegram application in my pc',
    'could you please open telegram for me',
    'I want to open telegram app',
    'I need to open telegram right now',
    'take me to telegram',
    'show me telegram',
    'bring up telegram on my computer',
    'go ahead and open the telegram app',
  ];
  for (const message of forms) {
    const result = await handleChat({ ...emptyContext, message });
    assert.equal(result.actions.length, 1, message);
    assert.ok(['open_app', 'open_start_menu_app', 'open_url'].includes(result.actions[0].type), message);
    assert.doesNotMatch(result.reply, /don’t know/i, message);
  }
});

test('an installed Store app beats the website', { skip: !isWindows }, async () => {
  const installed = tools.findInstalledApp(['ChatGPT']);
  if (!installed) return;
  const result = await handleChat({ ...emptyContext, message: 'open chatgpt' });
  assert.equal(result.actions[0].type, 'open_app');
  assert.equal(result.actions[0].args.id, 'chatgpt');
  assert.match(installed.path, /^shell:AppsFolder\\/);
});

test('the app catalog covers the common desktop and web targets', () => {
  const catalog = require('../src/app-catalog.json');
  const ids = new Set(catalog.apps.map((app) => app.id));
  for (const id of ['telegram', 'whatsapp', 'discord', 'slack', 'spotify', 'zoom', 'teams', 'vscode', 'chrome', 'steam']) {
    assert.ok(ids.has(id), id);
  }
  for (const app of catalog.apps) {
    assert.equal(typeof app.label, 'string');
    assert.ok(Array.isArray(app.aliases) && app.aliases.length > 0, app.id);
    assert.ok(app.url === null || /^https:\/\//.test(app.url), app.id);
  }
});

test('start menu scanning ignores uninstall and documentation shortcuts', { skip: !isWindows }, () => {
  const apps = tools.scanStartMenu(true);
  assert.ok(apps.length > 0);
  for (const app of apps) {
    assert.doesNotMatch(app.name, /uninstall|readme|release notes|documentation/i, app.name);
  }
});

test('start menu matching prefers an exact application name', { skip: !isWindows }, () => {
  const apps = tools.scanStartMenu();
  const sample = apps.find((app) => app.name === 'Telegram');
  if (!sample) return;
  const found = tools.findInstalledApp(['Telegram']);
  assert.equal(found.name, 'Telegram');
  assert.equal(found.score, 100);
});

test('application name normalisation is stable', () => {
  assert.equal(tools.normalizeAppName('Telegram Desktop.lnk'), 'telegram desktop');
  assert.equal(tools.normalizeAppName('VS  Code'), 'vs code');
  assert.equal(tools.normalizeAppName('  '), '');
});

test('the catalog is the only source of launchable desktop apps', () => {
  const source = fs.readFileSync(require.resolve('../src/tools.js'), 'utf8');
  assert.match(source, /APP_BLOCKLIST/);
  assert.match(source, /scanStartMenu/);
  assert.doesNotMatch(source, /child_process.*exec\(/, 'no shell execution helper');
});
