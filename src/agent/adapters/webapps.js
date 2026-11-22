'use strict';

// Web-app adapters built on the browser layer.
//
// Scope is intentionally narrow and honest:
//   YouTube  — search, play, pause, seek, volume
//   Gmail    — read inbox, search, create a draft (never sends)
//   LinkedIn — search people, jobs and posts (never connects or messages)
//
// Everything scraped from a page is untrusted content. These adapters return it
// as data only; they never follow instructions found on the page.

const browser = require('./browser');

function oneLine(value, limit = 200) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function youtubeUrl(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(String(query || '').trim())}`;
}

async function waitForSelector(selector, ctx, onStatus, timeoutMs = 20_000) {
  const until = Date.now() + Math.max(1_000, timeoutMs);
  const expression = `document.querySelectorAll(${JSON.stringify(selector)}).length`;
  while (Date.now() < until) {
    try {
      const { value } = await browser.evaluateOnPage(expression, ctx, onStatus, { timeoutMs: 5_000 });
      if (Number(value) > 0) return Number(value);
    } catch {
      // navigation in progress
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return 0;
}

async function pageSnapshot(ctx, onStatus) {
  try {
    const { value } = await browser.evaluateOnPage('({ url: location.href, title: document.title || "", login: /accounts\\.google\\.com|\\/login|authwall|checkpoint|signin/i.test(location.href) })', ctx, onStatus, { timeoutMs: 6_000 });
    return value || {};
  } catch {
    return {};
  }
}

// ---- YouTube ---------------------------------------------------------------

const YOUTUBE_RESULTS_SCRIPT = `(() => {
  const clean = (value) => (value == null ? '' : String(value)).replace(/\\s+/g, ' ').trim();
  const items = [...document.querySelectorAll('ytd-video-renderer')].slice(0, 12);
  return items.map((item, index) => {
    const link = item.querySelector('a#video-title, a#thumbnail');
    const title = item.querySelector('#video-title');
    const channel = item.querySelector('ytd-channel-name a, #channel-name a');
    const duration = item.querySelector('#text.ytd-thumbnail-overlay-time-status-renderer, ytd-thumbnail-overlay-time-status-renderer #text');
    return {
      index,
      title: clean(title ? title.innerText : item.innerText).slice(0, 180),
      channel: clean(channel ? channel.innerText : '').slice(0, 120),
      duration: clean(duration ? duration.innerText : '').slice(0, 20),
      url: link ? String(link.href || '').slice(0, 300) : ''
    };
  }).filter((item) => item.title);
})()`;

async function youtubeSearch({ query = '' } = {}, ctx = {}, onStatus) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Tell me what to search for on YouTube.');
  const opened = await browser.navigate({ url: youtubeUrl(text) }, ctx, onStatus);
  if (opened.needsLogin) return { searched: false, needsLogin: true, message: 'YouTube is asking for a sign-in. Please sign in yourself, then ask again.' };
  await waitForSelector('ytd-video-renderer', ctx, onStatus, 22_000);
  const { value } = await browser.evaluateOnPage(YOUTUBE_RESULTS_SCRIPT, ctx, onStatus);
  const results = Array.isArray(value) ? value : [];
  return {
    searched: true,
    query: text,
    url: opened.url || '',
    count: results.length,
    results: results.slice(0, 8),
  };
}

const YOUTUBE_NOW_SCRIPT = `(() => {
  const video = document.querySelector('video');
  if (!video) return { playing: false, found: false };
  const title = document.querySelector('h1.ytd-watch-metadata yt-formatted-string, h1.title yt-formatted-string');
  const channel = document.querySelector('ytd-channel-name a, #owner #channel-name a');
  return {
    found: true,
    playing: !video.paused && !video.ended,
    muted: Boolean(video.muted),
    title: title ? String(title.innerText || '').trim().slice(0, 200) : (document.title || '').replace(/ - YouTube$/, ''),
    channel: channel ? String(channel.innerText || '').trim().slice(0, 120) : '',
    currentTime: Math.round(video.currentTime || 0),
    duration: Math.round(Number.isFinite(video.duration) ? video.duration : 0),
    volume: Math.round((video.volume || 0) * 100),
    url: location.href
  };
})()`;

async function youtubeNowPlaying(ctx = {}, onStatus) {
  const state = await pageSnapshot(ctx, onStatus);
  if (!/youtube\.com/i.test(String(state.url || ''))) {
    const tabs = await browser.tabs({ action: 'list' }, ctx, onStatus);
    const tab = Array.isArray(tabs.tabs) ? tabs.tabs.find((item) => /youtube\.com/i.test(item.url || '')) : null;
    if (!tab) return { found: false, message: 'No YouTube tab is open.' };
    await browser.tabs({ action: 'select', targetId: tab.id }, ctx, onStatus);
  }
  const { value } = await browser.evaluateOnPage(YOUTUBE_NOW_SCRIPT, ctx, onStatus);
  return value || { found: false };
}

async function youtubePlay({ query = '', index = 0 } = {}, ctx = {}, onStatus) {
  const text = String(query || '').trim();
  if (text) {
    const search = await youtubeSearch({ query: text }, ctx, onStatus);
    if (search.needsLogin) return search;
    if (!search.count) return { played: false, message: `I found no YouTube results for “${text}”.` };
  } else {
    const state = await pageSnapshot(ctx, onStatus);
    if (!/youtube\.com/i.test(String(state.url || ''))) throw new Error('Open YouTube or give me a video to search for first.');
  }
  const result = await browser.click({ selector: 'ytd-video-renderer a#video-title', index }, ctx, onStatus);
  if (!result.clicked) return { played: false, message: result.message || 'I could not click a video result.' };
  await waitForSelector('video', ctx, onStatus, 20_000);
  // Give the player a moment to start, then report the real state.
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const state = await youtubeNowPlaying(ctx, onStatus);
  return { played: state.playing === true, opened: true, ...state };
}

async function youtubeControl({ action = 'pause', value = 0 } = {}, ctx = {}, onStatus) {
  const wanted = String(action || '').toLowerCase();
  if (!['play', 'pause', 'mute', 'unmute', 'seek', 'volume'].includes(wanted)) {
    throw new Error('YouTube action must be play, pause, mute, unmute, seek or volume.');
  }
  const amount = Number(value) || 0;
  const script = `(() => {
    const video = document.querySelector('video');
    if (!video) return { found: false, message: 'No video player on this page.' };
    const action = ${JSON.stringify(wanted)};
    if (action === 'play') video.play().catch(() => {});
    if (action === 'pause') video.pause();
    if (action === 'mute') video.muted = true;
    if (action === 'unmute') video.muted = false;
    if (action === 'seek') video.currentTime = Math.max(0, Math.min(Number.isFinite(video.duration) ? video.duration : ${Math.max(0, amount)}, ${Math.max(0, amount)}));
    if (action === 'volume') video.volume = Math.max(0, Math.min(1, ${Math.max(0, Math.min(100, amount))} / 100));
    return { found: true, action, paused: video.paused, muted: video.muted, currentTime: Math.round(video.currentTime || 0), volume: Math.round((video.volume || 0) * 100) };
  })()`;
  const { value: result } = await browser.evaluateOnPage(script, ctx, onStatus);
  if (!result || result.found !== true) return { controlled: false, message: (result && result.message) || 'No video player on this page.' };
  return { controlled: true, ...result };
}

// ---- Gmail -----------------------------------------------------------------

async function gmailOpen(ctx = {}, onStatus) {
  const opened = await browser.navigate({ url: 'https://mail.google.com/mail/u/0/#inbox' }, ctx, onStatus);
  const state = await pageSnapshot(ctx, onStatus);
  if (state.login || opened.needsLogin) {
    return {
      opened: false,
      needsLogin: true,
      message: 'Gmail is asking me to sign in. Please sign in in the BRO browser window yourself; I will not enter credentials.',
    };
  }
  return { opened: true, url: state.url || opened.url || '', title: state.title || '' };
}

const GMAIL_LIST_SCRIPT = (limit) => `(() => {
  const clean = (value) => (value == null ? '' : String(value)).replace(/\\s+/g, ' ').trim();
  const rows = [...document.querySelectorAll('tr.zA')].slice(0, ${Math.max(1, Math.min(50, Number(limit) || 10))});
  return rows.map((row) => {
    const sender = row.querySelector('.yX.xY .yP, .yW span[email], .zF, .bx');
    const subject = row.querySelector('.y6 span[id], .y6 .bog, .bog');
    const snippet = row.querySelector('.y2');
    const time = row.querySelector('.xW span');
    return {
      unread: row.classList.contains('zE'),
      from: clean(sender ? (sender.getAttribute('name') || sender.getAttribute('email') || sender.innerText) : '').slice(0, 160),
      subject: clean(subject ? subject.innerText : '').slice(0, 200),
      snippet: clean(snippet ? snippet.innerText : '').slice(0, 240),
      when: clean(time ? (time.getAttribute('title') || time.innerText) : '').slice(0, 60)
    };
  }).filter((item) => item.subject || item.from);
})()`;

async function readInbox({ limit = 10 } = {}, ctx = {}, onStatus) {
  const state = await pageSnapshot(ctx, onStatus);
  if (!/mail\.google\.com/i.test(String(state.url || ''))) {
    const opened = await gmailOpen(ctx, onStatus);
    if (opened.needsLogin) return opened;
  }
  const login = await pageSnapshot(ctx, onStatus);
  if (login.login) {
    return { needsLogin: true, message: 'Gmail needs you to sign in yourself before I can read the inbox.' };
  }
  const found = await waitForSelector('tr.zA', ctx, onStatus, 20_000);
  if (!found) {
    return { read: false, messages: [], message: 'The inbox has no visible message rows yet. Open Gmail and let it finish loading, then ask again.' };
  }
  const { value } = await browser.evaluateOnPage(GMAIL_LIST_SCRIPT(limit), ctx, onStatus);
  const messages = Array.isArray(value) ? value : [];
  return { read: true, count: messages.length, messages };
}

async function searchInbox({ query = '', limit = 10 } = {}, ctx = {}, onStatus) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Tell me what to search for in Gmail.');
  const opened = await browser.navigate({ url: `https://mail.google.com/mail/u/0/#search/${encodeURIComponent(text)}` }, ctx, onStatus);
  if (opened.needsLogin) return { needsLogin: true, message: 'Gmail needs you to sign in yourself before I can search it.' };
  const found = await waitForSelector('tr.zA', ctx, onStatus, 20_000);
  if (!found) return { searched: true, count: 0, messages: [], message: `I found no visible messages for “${text}”.` };
  const { value } = await browser.evaluateOnPage(GMAIL_LIST_SCRIPT(limit), ctx, onStatus);
  const messages = Array.isArray(value) ? value : [];
  return { searched: true, query: text, count: messages.length, messages };
}

async function pressKey(connection, key) {
  const codes = { Enter: 13, Tab: 9, Escape: 27 };
  const code = codes[key] || 13;
  await connection.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
  await connection.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code });
}

async function createDraft({ to = '', subject = '', body = '' } = {}, ctx = {}, onStatus) {
  const recipient = String(to || '').trim();
  if (!recipient) throw new Error('Tell me who the draft is for.');
  const state = await pageSnapshot(ctx, onStatus);
  if (!/mail\.google\.com/i.test(String(state.url || ''))) {
    const opened = await gmailOpen(ctx, onStatus);
    if (opened.needsLogin) return opened;
  }
  const compose = await browser.click({ text: 'Compose' }, ctx, onStatus);
  if (!compose.clicked) return { drafted: false, message: 'I could not find the Compose button. Gmail may still be loading.' };
  const toField = await browser.fill({ selector: 'textarea[name="to"], input[name="to"]', value: recipient }, ctx, onStatus);
  if (!toField.filled) return { drafted: false, message: toField.message || 'I could not fill the recipient field.' };
  const { connection } = await browser.withPage(ctx, onStatus);
  await pressKey(connection, 'Enter');
  if (subject) await browser.fill({ selector: 'input[name="subjectbox"]', value: String(subject) }, ctx, onStatus);
  if (body) await browser.fill({ selector: 'div[aria-label="Message Body"], div[role="textbox"][contenteditable="true"]', value: String(body) }, ctx, onStatus);
  return {
    drafted: true,
    sent: false,
    to: recipient,
    subject: String(subject || ''),
    characters: String(body || '').length,
    message: 'The draft is ready in Gmail. I did not send it; review it and press Send yourself.',
  };
}

// ---- LinkedIn --------------------------------------------------------------

function linkedinUrl(kind, query) {
  const q = encodeURIComponent(String(query || '').trim());
  if (kind === 'jobs') return `https://www.linkedin.com/jobs/search/?keywords=${q}`;
  if (kind === 'posts') return `https://www.linkedin.com/search/results/content/?keywords=${q}`;
  return `https://www.linkedin.com/search/results/people/?keywords=${q}`;
}

const LINKEDIN_PEOPLE_SCRIPT = `(() => {
  const clean = (value) => (value == null ? '' : String(value)).replace(/\\s+/g, ' ').trim();
  return [...document.querySelectorAll('li.reusable-search__result-container')].slice(0, 10).map((item) => {
    const name = item.querySelector('.entity-result__title-text a span[aria-hidden="true"], .entity-result__title-text a');
    const headline = item.querySelector('.entity-result__primary-subtitle');
    const location = item.querySelector('.entity-result__secondary-subtitle');
    const link = item.querySelector('a[href*="/in/"]');
    return {
      name: clean(name ? name.innerText : '').slice(0, 120),
      headline: clean(headline ? headline.innerText : '').slice(0, 200),
      location: clean(location ? location.innerText : '').slice(0, 120),
      url: link ? String(link.href || '').split('?')[0].slice(0, 240) : ''
    };
  }).filter((item) => item.name);
})()`;

const LINKEDIN_JOBS_SCRIPT = `(() => {
  const clean = (value) => (value == null ? '' : String(value)).replace(/\\s+/g, ' ').trim();
  return [...document.querySelectorAll('li.jobs-search-results__list-item, li.scaffold-layout__list-item')].slice(0, 12).map((item) => {
    const title = item.querySelector('.job-card-list__title, .job-card-container__link');
    const company = item.querySelector('.job-card-container__primary-description, .artdeco-entity-lockup__subtitle');
    const location = item.querySelector('.job-card-container__metadata-item, .artdeco-entity-lockup__caption');
    const link = item.querySelector('a[href*="/jobs/view/"]');
    return {
      title: clean(title ? title.innerText : '').slice(0, 160),
      company: clean(company ? company.innerText : '').slice(0, 120),
      location: clean(location ? location.innerText : '').slice(0, 120),
      url: link ? String(link.href || '').split('?')[0].slice(0, 240) : ''
    };
  }).filter((item) => item.title);
})()`;

const LINKEDIN_POSTS_SCRIPT = `(() => {
  const clean = (value) => (value == null ? '' : String(value)).replace(/\\s+/g, ' ').trim();
  return [...document.querySelectorAll('div.feed-shared-update-v2, li.reusable-search__result-container')].slice(0, 12).map((item) => {
    const author = item.querySelector('.update-components-actor__title, .entity-result__title-text');
    const text = item.querySelector('.feed-shared-update-v2__description, .update-components-text, .entity-result__summary');
    return {
      author: clean(author ? author.innerText : '').slice(0, 120),
      text: clean(text ? text.innerText : item.innerText).slice(0, 300)
    };
  }).filter((item) => item.author || item.text);
})()`;

async function linkedinSearch({ query = '', kind = 'people' } = {}, ctx = {}, onStatus) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Tell me who or what to search for on LinkedIn.');
  const wanted = ['people', 'jobs', 'posts'].includes(kind) ? kind : 'people';
  const opened = await browser.navigate({ url: linkedinUrl(wanted, text) }, ctx, onStatus);
  const state = await pageSnapshot(ctx, onStatus);
  if (state.login || opened.needsLogin) {
    return {
      searched: false,
      needsLogin: true,
      message: 'LinkedIn is showing its sign-in or auth wall. Please sign in yourself; BRO will not enter credentials.',
    };
  }
  const selector = wanted === 'jobs' ? 'li.jobs-search-results__list-item, li.scaffold-layout__list-item'
    : wanted === 'posts' ? 'div.feed-shared-update-v2, li.reusable-search__result-container'
      : 'li.reusable-search__result-container';
  await waitForSelector(selector, ctx, onStatus, 18_000);
  const { value } = await browser.evaluateOnPage(
    wanted === 'jobs' ? LINKEDIN_JOBS_SCRIPT : wanted === 'posts' ? LINKEDIN_POSTS_SCRIPT : LINKEDIN_PEOPLE_SCRIPT,
    ctx, onStatus
  );
  const results = Array.isArray(value) ? value : [];
  return {
    searched: true,
    kind: wanted,
    query: text,
    count: results.length,
    results,
    note: 'Read-only search. BRO does not send connection requests or messages.',
  };
}

function webAppTools() {
  return [
    {
      name: 'youtube_search',
      description: 'Search YouTube and return the top video titles, channels and links.',
      risk: 'launch',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', maxLength: 300 } },
        required: ['query'],
      },
      handler: youtubeSearch,
    },
    {
      name: 'youtube_play',
      description: 'Play a YouTube video: search for a query first, or play the first result on the current YouTube page. Optionally choose a result index.',
      risk: 'input',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 300 },
          index: { type: 'integer', minimum: 0, maximum: 20 },
        },
        required: [],
      },
      handler: youtubePlay,
    },
    {
      name: 'youtube_control',
      description: 'Control the current YouTube video: play, pause, mute, unmute, seek to a second, or set volume 0-100.',
      risk: 'input',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['play', 'pause', 'mute', 'unmute', 'seek', 'volume'] },
          value: { type: 'integer', minimum: 0, maximum: 100_000 },
        },
        required: ['action'],
      },
      handler: youtubeControl,
    },
    {
      name: 'youtube_now_playing',
      description: 'Report the current YouTube video, play state and position.',
      risk: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: youtubeNowPlaying,
    },
    {
      name: 'gmail_read_inbox',
      description: 'Read the visible rows of the signed-in Gmail inbox (sender, subject, snippet, unread). Never sends anything.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } },
        required: [],
      },
      handler: readInbox,
    },
    {
      name: 'gmail_search',
      description: 'Search the signed-in Gmail account and read the visible matching rows. Never sends anything.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 300 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        required: ['query'],
      },
      handler: searchInbox,
    },
    {
      name: 'gmail_create_draft',
      description: 'Create an email draft in Gmail with a recipient, subject and body. Never sends; the user must review and send it.',
      risk: 'input',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', maxLength: 320 },
          subject: { type: 'string', maxLength: 300 },
          body: { type: 'string', maxLength: 5_000 },
        },
        required: ['to'],
      },
      handler: createDraft,
    },
    {
      name: 'linkedin_search',
      description: 'Search LinkedIn for people, jobs or posts and return the visible results. Read-only: never connects, follows or messages.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', maxLength: 300 },
          kind: { type: 'string', enum: ['people', 'jobs', 'posts'] },
        },
        required: ['query'],
      },
      handler: linkedinSearch,
    },
  ];
}

module.exports = {
  youtubeSearch,
  youtubePlay,
  youtubeControl,
  youtubeNowPlaying,
  gmailOpen,
  readInbox,
  searchInbox,
  createDraft,
  linkedinSearch,
  webAppTools,
  waitForSelector,
  youtubeUrl,
  linkedinUrl,
};
