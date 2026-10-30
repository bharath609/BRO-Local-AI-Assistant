const test = require('node:test');
const assert = require('node:assert/strict');
const { handleChat } = require('../src/assistant');

const emptyContext = { projects: [], settings: {}, user: { displayName: 'Bharath' } };

test('greets Bharath without creating an action', async () => {
  const result = await handleChat({ ...emptyContext, message: 'Hey bro, I welcome it bro, hey bro' });
  assert.match(result.reply, /Hey Bharath/);
  assert.match(result.reply, /local assistant/);
  assert.deepEqual(result.actions, []);
});

test('recognizes common greetings deterministically', async () => {
  for (const message of ['Hi', 'Hello BRO', 'hey bro!!!', 'Welcome, bro', 'Good morning']) {
    const result = await handleChat({ ...emptyContext, message });
    assert.match(result.reply, /Bharath/);
    assert.deepEqual(result.actions, [], message);
  }
});

test('greetings bypass a configured provider', async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    throw new Error('provider should not be called for a greeting');
  };
  try {
    const result = await handleChat({
      ...emptyContext,
      message: 'Hey BRO',
      settings: { baseUrl: 'https://provider.invalid/v1', model: 'test-model', apiKey: 'test-key' }
    });
    assert.match(result.reply, /Bharath/);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('a greeting prefix does not block an explicit URL request', async () => {
  const result = await handleChat({ ...emptyContext, message: 'Hey bro, open https://example.com' });
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].type, 'open_url');
  assert.equal(result.actions[0].args.url, 'https://example.com/');
});

test('recognizes activate BRO as a deterministic voice-popup action', async () => {
  for (const message of ['activate BRO', 'Please activate bro command', 'Hey bro, activate BRO']) {
    const result = await handleChat({ ...emptyContext, message });
    assert.deepEqual(result.actions, [{ id: 'activate_bro', type: 'activate_bro', args: {}, label: 'Activate BRO voice popup' }], message);
    assert.match(result.reply, /Press Ctrl \+ Alt \+ B/);
  }
});

test('resolves common site names into explicit URL actions', async () => {
  const linkedin = await handleChat({ ...emptyContext, message: 'Open LinkedIn' });
  assert.equal(linkedin.actions[0].type, 'open_url');
  assert.equal(linkedin.actions[0].args.url, 'https://www.linkedin.com/');

  const youtube = await handleChat({ ...emptyContext, message: 'Go to YouTube' });
  assert.equal(youtube.actions[0].args.url, 'https://www.youtube.com/');

  const spokenYoutube = await handleChat({ ...emptyContext, message: 'Open you tube' });
  assert.equal(spokenYoutube.actions[0].args.url, 'https://www.youtube.com/');

  const spokenLinkedIn = await handleChat({ ...emptyContext, message: 'Open linked in' });
  assert.equal(spokenLinkedIn.actions[0].args.url, 'https://www.linkedin.com/');

  for (const message of ['Please open YouTube', 'Bro open YouTube', 'Could you open YouTube please']) {
    const result = await handleChat({ ...emptyContext, message });
    assert.equal(result.actions[0].args.url, 'https://www.youtube.com/', message);
  }

  const link = await handleChat({ ...emptyContext, message: 'Open link' });
  assert.equal(link.actions[0].args.url, 'https://www.linkedin.com/');
});

test('does not treat unrelated speech as an open command', async () => {
  for (const message of ['All you do', 'all you do', 'open all you do']) {
    const result = await handleChat({ ...emptyContext, message });
    assert.deepEqual(result.actions, [], message);
  }
});

test('recognizes explicit terminal and YouTube-search requests', async () => {
  const terminal = await handleChat({ ...emptyContext, message: 'Open terminal' });
  assert.equal(terminal.actions[0].type, 'open_terminal');

  const search = await handleChat({ ...emptyContext, message: 'Search YouTube for local AI assistants' });
  assert.equal(search.actions[0].type, 'open_url');
  assert.match(search.actions[0].args.url, /youtube\.com\/results\?search_query=local%20AI%20assistants/);
});

test('uses the attached command catalog for additional sites and searches', async () => {
  for (const [message, url] of [
    ['Open ChatGPT', 'https://chatgpt.com/'],
    ['Check my Gmail', 'https://mail.google.com/'],
    ['Open Google Drive', 'https://drive.google.com/'],
    ['Open Google Calendar', 'https://calendar.google.com/'],
    ['Open Stack Overflow', 'https://stackoverflow.com/'],
    ['Open Spotify', 'https://open.spotify.com/'],
    ['Open Twitter', 'https://x.com/']
  ]) {
    const result = await handleChat({ ...emptyContext, message });
    const action = result.actions[0];
    // A desktop app installed on this PC takes precedence over the website.
    assert.ok(['open_url', 'open_app', 'open_start_menu_app'].includes(action.type), message);
    if (action.type === 'open_url') assert.equal(action.args.url, url, message);
  }

  const web = await handleChat({ ...emptyContext, message: 'Search for local AI assistants' });
  assert.equal(web.actions[0].args.url, 'https://www.google.com/search?q=local%20AI%20assistants');

  const youtube = await handleChat({ ...emptyContext, message: 'Find keyboard shortcuts on YouTube' });
  assert.equal(youtube.actions[0].args.url, 'https://www.youtube.com/results?search_query=keyboard%20shortcuts');
});

test('resolves allowlisted Windows desktop targets without accepting raw paths', async () => {
  for (const [message, target] of [
    ['Open Recycle Bin', 'recycle_bin'],
    ['open This PC', 'this_pc'],
    ['launch Downloads', 'downloads'],
    ['open Documents', 'documents'],
    ['open Desktop', 'desktop'],
    ['open Control Panel', 'control_panel'],
    ['open Task Manager', 'task_manager'],
    ['open Notepad', 'notepad'],
    ['open Calculator', 'calculator'],
    ['open Windows Settings', 'settings'],
    ['open Word', 'word'],
    ['open Excel', 'excel'],
    ['open PowerPoint', 'powerpoint'],
    ['open File Explorer', 'file_explorer'],
    ['open Pictures', 'pictures']
  ]) {
    const result = await handleChat({ ...emptyContext, message });
    assert.equal(result.actions[0].type, 'open_desktop_target', message);
    assert.equal(result.actions[0].args.target, target, message);
    assert.deepEqual(result.context.lastTarget, { kind: 'desktop', key: target, label: result.actions[0].label.replace(/^Open /, '') });
  }

  const rawPath = await handleChat({ ...emptyContext, message: 'open C:\\Users\\Bharath\\secret.txt' });
  assert.deepEqual(rawPath.actions, []);
});

test('open that replays only an unambiguous recognized last target', async () => {
  const first = await handleChat({ ...emptyContext, message: 'Open Downloads' });
  const replay = await handleChat({ ...emptyContext, message: 'open that', context: first.context });
  assert.deepEqual(replay.actions, [{ id: 'open_desktop_target', type: 'open_desktop_target', args: { target: 'downloads' }, label: 'Open Downloads' }]);

  const site = await handleChat({ ...emptyContext, message: 'Open GitHub' });
  const siteReplay = await handleChat({ ...emptyContext, message: 'open it', context: site.context });
  assert.equal(siteReplay.actions[0].type, 'open_url');
  assert.equal(siteReplay.actions[0].args.url, 'https://github.com/');

  const ambiguous = await handleChat({ ...emptyContext, message: 'open that' });
  assert.deepEqual(ambiguous.actions, []);
  assert.match(ambiguous.reply, /Which item should I open/);
});

test('does not claim unsupported browser playback or WhatsApp sending', async () => {
  const playback = await handleChat({ ...emptyContext, message: 'Pause the YouTube video' });
  assert.deepEqual(playback.actions, []);
  assert.match(playback.reply, /not connected to a browser-control session/i);

  const message = await handleChat({ ...emptyContext, message: 'Send message to Arun in WhatsApp' });
  assert.deepEqual(message.actions, []);
  assert.match(message.reply, /will not send a message/i);
});
