const test = require('node:test');
const assert = require('node:assert/strict');
const { handleChat } = require('../src/assistant');

const emptyContext = { projects: [], settings: {}, user: { displayName: 'Bharath' } };

async function openSite(message) {
  return handleChat({ ...emptyContext, message });
}

test('after opening YouTube, “find/look for” searches YouTube instead of failing', async () => {
  const opened = await openSite('open youtube');
  assert.equal(opened.actions[0].type, 'open_url');

  for (const message of ['find lo-fi beats', 'look for python tutorial for beginners', 'look up lofi hip hop']) {
    const result = await handleChat({ ...emptyContext, message, context: opened.context });
    assert.equal(result.actions[0].type, 'open_url', message);
    assert.match(result.actions[0].args.url, /^https:\/\/www\.youtube\.com\/results\?search_query=/, message);
    assert.match(result.reply, /Searching YouTube/i, message);
    assert.equal(result.context.lastTarget.kind, 'site');
  }
});

test('site search follows other sites BRO opened last', async () => {
  const netflix = await openSite('open netflix');
  const movie = await handleChat({ ...emptyContext, message: 'watch strangers things', context: netflix.context });
  assert.equal(movie.actions[0].type, 'open_url');
  assert.match(movie.actions[0].args.url, /^https:\/\/www\.netflix\.com\/search\?q=strangers%20things$/);
  assert.match(movie.reply, /Searching Netflix/i);

  const prime = await openSite('open prime video');
  const show = await handleChat({ ...emptyContext, message: 'play the boys', context: prime.context });
  assert.match(show.actions[0].args.url, /primevideo\.com\/search/);
});

test('site search never hijacks a real app, folder, or site', async () => {
  const opened = await openSite('open youtube');

  const notepad = await handleChat({ ...emptyContext, message: 'open notepad', context: opened.context });
  assert.equal(notepad.actions[0].type, 'open_desktop_target');

  const downloads = await handleChat({ ...emptyContext, message: 'open downloads', context: opened.context });
  assert.equal(downloads.actions[0].type, 'open_desktop_target');

  const github = await handleChat({ ...emptyContext, message: 'open github website', context: opened.context });
  assert.equal(github.actions[0].type, 'open_url');
  assert.equal(github.actions[0].args.url, 'https://github.com/');
});

test('“play <video>” plays the top YouTube result instead of searching', async () => {
  const originalFetch = global.fetch;
  let requested = '';
  global.fetch = async (url) => {
    requested = String(url);
    return {
      ok: true,
      text: async () => 'var ytInitialData = {"contents":{"videoRenderer":{"videoId":"abc123DEF45","title":{"runs":[{"text":"Test Video"}]},"x":1}}}',
    };
  };
  try {
    const opened = await openSite('open youtube');
    const result = await handleChat({ ...emptyContext, message: 'play lofi beats', context: opened.context });
    assert.equal(result.actions[0].type, 'open_url');
    assert.equal(result.actions[0].args.url, 'https://www.youtube.com/watch?v=abc123DEF45&autoplay=1');
    assert.match(result.reply, /Playing “Test Video” on YouTube/);
    assert.match(requested, /youtube\.com\/results\?search_query=lofi%20beats/);
    assert.equal(result.context.lastTarget.kind, 'site');
    assert.match(result.context.lastTarget.url, /watch\?v=abc123DEF45/);

    const standalone = await handleChat({ ...emptyContext, message: 'play lofi beats on youtube' });
    assert.equal(standalone.actions[0].args.url, 'https://www.youtube.com/watch?v=abc123DEF45&autoplay=1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('YouTube playback falls back to a search page when the lookup fails', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    const result = await handleChat({ ...emptyContext, message: 'play lofi beats' });
    assert.equal(result.actions[0].type, 'open_url');
    assert.match(result.actions[0].args.url, /^https:\/\/www\.youtube\.com\/results\?search_query=lofi%20beats$/);
    assert.match(result.reply, /opening YouTube results/i);
  } finally {
    global.fetch = originalFetch;
  }
});

test('“find” and “look for” still show YouTube results without fetching', async () => {
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('should not fetch'); };
  try {
    const opened = await openSite('open youtube');
    for (const message of ['find lofi hip hop', 'look for python tutorial']) {
      const result = await handleChat({ ...emptyContext, message, context: opened.context });
      assert.equal(result.actions[0].type, 'open_url', message);
      assert.match(result.actions[0].args.url, /^https:\/\/www\.youtube\.com\/results\?search_query=/, message);
      assert.match(result.reply, /Searching YouTube/i, message);
    }
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('“play that video” focuses the browser instead of searching for text', async () => {
  const opened = await openSite('open youtube');
  const result = await handleChat({ ...emptyContext, message: 'play that video', context: opened.context });
  assert.equal(result.actions[0].type, 'focus_window');
  assert.match(result.reply, /YouTube/);
});

test('an opened file becomes the last target so BRO can control it', async () => {
  // Synthetic context: the file has already been found and opened.
  const context = { lastTarget: { kind: 'file', path: 'C:\\Users\\me\\Downloads\\report.pdf', label: 'report.pdf' } };

  const focus = await handleChat({ ...emptyContext, message: 'check it once', context });
  assert.equal(focus.actions[0].type, 'focus_window');
  assert.equal(focus.actions[0].args.target.label, 'report.pdf');

  const close = await handleChat({ ...emptyContext, message: 'close that', context });
  assert.equal(close.actions[0].type, 'close_window');
  assert.match(close.reply, /report\.pdf/);
});
