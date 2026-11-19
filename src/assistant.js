const { validateHttpUrl, normalizeDesktopTarget, resolveWindowsTarget, findInstalledApp, findUserFile, USER_FILE_FOLDERS, findYouTubeVideo } = require('./tools');
const { providerInfo, chatCompletion, isLocalBaseUrl } = require('./provider');
const { matchApplicationSkill } = require('./skills/application-control');
const { DEFAULT_MODE, normalizeMode } = require('./guardrails');
const COMMAND_CATALOG = require('./command-catalog.json');
const APP_CATALOG = require('./app-catalog.json');

const DEFAULT_USER_NAME = String(process.env.BRO_USER_NAME || 'Bharath').trim() || 'Bharath';

function cleanTarget(value) { return value.replace(/[),.!?]+$/, ''); }

function projectByName(projects, name) {
  const wanted = name.trim().toLowerCase();
  return projects.find((project) => project.name.toLowerCase() === wanted) || projects.find((project) => project.name.toLowerCase().includes(wanted));
}

function normalizeProfileName(value) {
  const requested = value.trim().toLowerCase().replace(/^the\s+/, '');
  const aliases = { tests: 'test', testing: 'test', development: 'dev', start: 'dev', 'dev server': 'dev', production: 'build', check: 'lint', checks: 'lint' };
  return aliases[requested] || requested;
}

function catalogSiteAliases() {
  const aliases = {};
  for (const resource of COMMAND_CATALOG.resources || []) {
    if (resource.action_type !== 'open_url' || typeof resource.target !== 'string') continue;
    const add = (value) => {
      const normalized = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (normalized) aliases[normalized] = resource.target.endsWith('/') ? resource.target : `${resource.target}/`;
    };
    add(resource.id);
    for (const phrase of resource.phrases || []) {
      add(String(phrase).replace(/^(?:open|go\s+to|check\s+my)\s+/i, ''));
    }
  }
  return aliases;
}

const SITE_ALIASES = Object.freeze({
  ...catalogSiteAliases(),
  youtube: 'https://www.youtube.com/',
  'you tube': 'https://www.youtube.com/',
  'u tube': 'https://www.youtube.com/',
  'youtube.com': 'https://www.youtube.com/',
  linkedin: 'https://www.linkedin.com/',
  'linked in': 'https://www.linkedin.com/',
  link: 'https://www.linkedin.com/',
  'linkedin.com': 'https://www.linkedin.com/',
  whatsapp: 'https://web.whatsapp.com/',
  'whats app': 'https://web.whatsapp.com/',
  'whatsapp web': 'https://web.whatsapp.com/',
  github: 'https://github.com/',
  'git hub': 'https://github.com/',
  'github.com': 'https://github.com/',
  google: 'https://www.google.com/',
  gmail: 'https://mail.google.com/',
  'g mail': 'https://mail.google.com/'
});

function normalizeRequestedName(value) {
  return cleanTarget(String(value || '')).trim().toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
}

const APP_ALIASES = (() => {
  const aliases = {};
  for (const app of APP_CATALOG.apps || []) {
    const add = (value) => {
      const key = String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
      if (key && !Object.prototype.hasOwnProperty.call(aliases, key)) aliases[key] = app;
    };
    add(app.id);
    add(app.label);
    for (const alias of app.aliases || []) add(alias);
  }
  return aliases;
})();

function resolveAppEntry(value) {
  const normalized = normalizeRequestedName(value);
  return Object.prototype.hasOwnProperty.call(APP_ALIASES, normalized) ? APP_ALIASES[normalized] : null;
}

function resolveSiteUrl(value) {
  const candidate = cleanTarget(value).trim();
  const normalized = candidate.toLowerCase().replace(/^the\s+/, '').replace(/\s+/g, ' ');
  if (Object.prototype.hasOwnProperty.call(SITE_ALIASES, normalized)) return SITE_ALIASES[normalized];
  if (/^https?:\/\//i.test(candidate)) return validateHttpUrl(candidate);
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(candidate)) return validateHttpUrl(`https://${candidate}`);
  return null;
}

function isSiteReference(value) {
  try { return Boolean(resolveSiteUrl(value)) || Boolean(resolveAppEntry(value)); } catch { return false; }
}

// A friendly name for a website URL, so replies say “Closing the Gmail tab.”
function siteLabel(url) {
  try {
    const normalized = String(url || '').replace(/\/+$/, '');
    let best = '';
    for (const [alias, target] of Object.entries(SITE_ALIASES)) {
      if (String(target).replace(/\/+$/, '') !== normalized) continue;
      if (!best || alias.length < best.length) best = alias;
    }
    if (best) return best;
  } catch { /* fall through to the host name */ }
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.');
    if (parts.length > 1) parts.pop();
    return parts.join('.') || host;
  } catch {
    return String(url || '');
  }
}

function displayNameFor(user) {
  const name = user && user.displayName;
  return typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_USER_NAME;
}

function isGreeting(text) {
  const hasGreeting = /\b(?:hey|hi|hello|welcome|good\s+(?:morning|afternoon|evening))\b/i.test(text);
  const hasActionCue = /https?:\/\/|\b(?:open|visit|go\s+to|run|execute|list|show|search|find|google|status|health|help|activate|wake\s+up|type|write|dictate|enter|press|click|tap|scroll|save|print)\b/i.test(text);
  return hasGreeting && !hasActionCue;
}

function stripGreetingPrefix(text) {
  return text.replace(/^(?:hey|hi|hello)\s+(?:bro|brother|there)?[\s,!:;-]*/i, '').trim() || text;
}

function stripCommandPoliteness(text) {
  return text
    .replace(/^(?:please|bro|brother|buddy|yo)\s+/i, '')
    .replace(/^(?:could|can|would|will)\s+you\s+(?:please\s+)?/i, '')
    .replace(/^(?:i\s+(?:want|need|would\s+like)\s+to|i'?d\s+like\s+to|i\s+wanna|let'?s)\s+/i, '')
    .replace(/^(?:please\s+)?(?:go\s+ahead\s+and\s+)?/i, '')
    .replace(/\s+please[.!?]*$/i, '')
    .trim() || text;
}

// Removes the polite extras people say around an app or site name:
// “open chatgpt application in my pc for me” → “chatgpt”.
function stripActionFillers(value) {
  return String(value || '')
    .replace(/\b(?:for\s+me|please|right\s+now|now|asap|thanks|thank\s+you)\b[.!?]*$/gi, '')
    .replace(/\s+(?:app|application|program|software|window|page|tab|website|web\s+site|site)\b/gi, '')
    .replace(/\s+(?:on|in)\s+(?:the\s+|my\s+)?(?:pc|computer|laptop|mac|desktop|browser|chrome|edge|windows)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Phrases that point back at whatever BRO opened last: “it”, “that window”,
// “the video”, “the last tab”. This is what makes follow-ups like
// “check it once”, “bring that back”, “open that video”, or “minimize it”
// act on the window BRO itself opened.
const WINDOW_REFERENCE = (() => {
  const noun = '(?:window|app|application|program|page|tab|video|site|website|browser|thing)';
  return `(?:it|that|this|the\\s+${noun}|that\\s+(?:\\w+\\s+)?${noun}|this\\s+(?:\\w+\\s+)?${noun}|the\\s+last\\s+${noun})`;
})();

function lastTargetLabel(target) {
  if (!target) return 'the window';
  if (target.kind === 'site') return siteDisplayName(target.url);
  if (target.kind === 'terminal') return 'the terminal';
  return target.label || target.id || 'the window';
}

// A friendly, correctly-capitalised name for a URL, so replies say “YouTube”
// rather than the shortest spoken alias (“u tube”) or a bare host name.
function siteDisplayName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const known = {
      'youtube.com': 'YouTube', 'm.youtube.com': 'YouTube', 'mail.google.com': 'Gmail',
      'google.com': 'Google', 'github.com': 'GitHub', 'chatgpt.com': 'ChatGPT',
      'chat.openai.com': 'ChatGPT', 'linkedin.com': 'LinkedIn', 'x.com': 'X',
      'twitter.com': 'Twitter', 'facebook.com': 'Facebook', 'instagram.com': 'Instagram',
      'amazon.com': 'Amazon', 'amazon.in': 'Amazon', 'netflix.com': 'Netflix',
      'spotify.com': 'Spotify', 'web.whatsapp.com': 'WhatsApp', 'reddit.com': 'Reddit',
      'stackoverflow.com': 'Stack Overflow',
    };
    if (known[host]) return known[host];
    const parts = host.split('.');
    const base = parts.length > 1 ? parts[parts.length - 2] : host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return siteLabel(url);
  }
}

function windowControlIntent(commandText, lastTarget) {
  if (!lastTarget) return null;
  const cleaned = String(commandText || '')
    .toLowerCase()
    .replace(/[.!?]+$/, '')
    .replace(/\b(?:please|now|right\s+now|for\s+me|once|again|real\s+quick|thanks|thank\s+you)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const ref = WINDOW_REFERENCE;
  const rules = [
    // “check it once”, “show me that”, “bring the window up”, “open that video”
    { mode: 'focus', re: new RegExp(`^(?:focus|show(?:\\s+me)?|switch\\s+to|bring(?:\\s+back|\\s+up|\\s+forward)?|come\\s+back\\s+to|go\\s+back\\s+to|open|check(?:\\s+on)?|look\\s+at|see|peek\\s+at|view|display|restore|unminimize|play|resume)\\s+(?:on\\s+|at\\s+)?${ref}(?:\\s+(?:out|up|back))?$`) },
    { mode: 'focus', re: new RegExp(`^(?:bring|get|put)\\s+${ref}\\s+back$`) },
    // “minimize it”, “hide that window”, “put it away”
    { mode: 'minimize', re: new RegExp(`^(?:minimize|hide|shrink|collapse|put\\s+away|put\\s+down|tuck\\s+away)\\s+${ref}$`) },
    // “maximize it”, “make it full screen”, “expand the window”
    { mode: 'maximize', re: new RegExp(`^(?:maximize|expand|enlarge|full\\s*screen|go\\s+full\\s*screen)\\s+${ref}$`) },
    { mode: 'maximize', re: new RegExp(`^make\\s+${ref}\\s+(?:full\\s*screen|bigger|maximized|larger)$`) },
  ];
  for (const rule of rules) {
    if (!rule.re.test(cleaned)) continue;
    const label = lastTargetLabel(lastTarget);
    const verb = rule.mode === 'focus' ? 'Bring' : rule.mode === 'minimize' ? 'Minimize' : 'Maximize';
    const replies = {
      focus: `Bringing ${label} back to the front.`,
      minimize: `Minimizing ${label}.`,
      maximize: `Maximizing ${label}.`,
    };
    return {
      action: {
        id: `${rule.mode}_window`,
        type: `${rule.mode}_window`,
        args: { target: { label, kind: lastTarget.kind } },
        label: `${verb} ${label}`,
      },
      reply: replies[rule.mode],
    };
  }
  return null;
}


// Known sites that accept a search query, so “open YouTube” followed by
// “play lo-fi beats” stays inside YouTube instead of guessing at an app.
const SITE_SEARCH_TEMPLATES = [
  { host: /(^|\.)youtube\.com$/, name: 'YouTube', play: true, build: (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}` },
  { host: /(^|\.)google\.[a-z.]+$/, name: 'Google', build: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
  { host: /(^|\.)github\.com$/, name: 'GitHub', build: (q) => `https://github.com/search?q=${encodeURIComponent(q)}` },
  { host: /(^|\.)amazon\.[a-z.]+$/, name: 'Amazon', build: (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}` },
  { host: /(^|\.)netflix\.com$/, name: 'Netflix', build: (q) => `https://www.netflix.com/search?q=${encodeURIComponent(q)}` },
  { host: /(^|\.)primevideo\.com$/, name: 'Prime Video', build: (q) => `https://www.primevideo.com/search/ref=atv_nb_sr?phrase=${encodeURIComponent(q)}` },
  { host: /(^|\.)spotify\.com$/, name: 'Spotify', build: (q) => `https://open.spotify.com/search/${encodeURIComponent(q)}` },
  { host: /(^|\.)reddit\.com$/, name: 'Reddit', build: (q) => `https://www.reddit.com/search/?q=${encodeURIComponent(q)}` },
  { host: /(^|\.)wikipedia\.org$/, name: 'Wikipedia', build: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}` },
];

function isKnownSite(value) {
  try { return Boolean(resolveSiteUrl(value)); } catch { return false; }
}

// “open YouTube” then “play <video name>” → search that site. Only runs when
// the previous target was a website that supports search and the phrase is not
// already a real app, folder, project, or site.
// A bare app or site name ("notepad", "chrome", "youtube") is a command, not a
// question. Recognising it here keeps the instant path and, more importantly,
// stops the model from announcing an action it is not able to perform.
function isBareOpenName(value, projects) {
  const text = String(value || '').trim();
  if (!text || text.length > 40) return false;
  if (text.split(/\s+/).length > 3) return false;
  if (/\b(?:and|or|but|because|if|when|what|why|how|who|where|which|is|are|was|were|can|could|should|would|do|did|does)\b/i.test(text)) return false;
  if (/\.[a-z0-9]{1,6}$/i.test(text)) return false; // a file name, not a command
  if (COMMAND_VERB.test(text)) return false;
  if (normalizeDesktopTarget(text)) return true;
  if (isKnownSite(text)) return true;
  if (projectByName(projects, text)) return true;
  if (resolveAppEntry(text)) return true;
  const installed = findInstalledApp(text, { cachedOnly: true });
  return Boolean(installed && installed.score >= 92);
}

// A small model likes to answer "Opening Notepad for you now." even though it
// cannot touch the desktop. If nothing actually ran, that sentence is a lie, so
// replace it with the command the user can say instead.
const COMMAND_VERB = /^(?:open|close|launch|start|play|pause|scroll|click|type|search|find|show|tell|set|take|make|send|call|stop|mute|unmute|lock|minimize|maximize|restore|switch|go|bring|hide|activate|wake|restart|shutdown|sleep)\b/i;

const ACTION_CLAIM = /^(?:opening|open(?:ed|ing)?\s+(?:it|that|notepad|chrome|youtube)|i(?:'| a)?m opening|i(?:'| ha)?ve opened|i opened|done\b|sure[,!.]\s*(?:i(?:'| ha)?ve|i(?:'| a)?m)|closing|i(?:'| ha)?ve closed|clicking|i clicked|scrolling|i scrolled|i(?:'| ha)?ve scrolled|typing|i typed|taking a screenshot|i took a screenshot|playing|i(?:'| ha)?ve started)/i;

const UNPERFORMED_ACTION_REPLY = 'I can’t run that from here on my own. Say it as a command — for example “open Notepad” — and I’ll do it right away.';

// Imperative PC actions. If a spoken sentence starts like one of these but no
// local rule matched, the local model cannot help: it has no access to the PC.
// Asking it costs seconds (and a model load after idle) and ends with an
// apology, so BRO answers instantly instead.
const PC_ACTION_START = /^(?:open|close|quit|exit|kill|launch|scroll|maximi[sz]e|minimi[sz]e|restore|fullscreen|captions?|subtitles?|zoom|refresh|reload|press|click|tap|save|print|screenshot|switch|skip|rewind|mute|unmute|volume|delete|remove|trash|rename|copy|cut|paste|undo|redo|empty|record|lock|shut|restart|sign)\b/i;
const QUESTION_START = /^(?:how|what|why|when|where|who|which|whose|can|could|would|should|is|are|was|were|do|does|did|have|has|tell|explain|describe|write|define|give|name|suggest|recommend)\b/i;

function looksLikePcAction(value) {
  const text = String(value || '').trim();
  if (!text || QUESTION_START.test(text)) return false;
  return PC_ACTION_START.test(text);
}

function deniesUnperformedAction(reply) {
  return ACTION_CLAIM.test(String(reply || '').trim());
}



// "what's the time", "what day is it" — answered locally and instantly, because
// a small model guessing at the clock is both slow and wrong.
function clockAnswer(value) {
  const text = String(value || '').toLowerCase().replace(/[?.!,\s]+$/, '').trim();
  const wantsTime = /^(?:what(?:'?s| is)? (?:the )?time(?: is it| now)?|what time is it|the time|current time|tell me the time|time now|time please|what time do you have)$/.test(text);
  const wantsDate = /^(?:what(?:'?s| is)? (?:the )?date(?: today| is it| now)?|what date is it(?: today)?|what day is it(?: today)?|today'?s date|todays date|what(?:'?s| is) today(?:'?s date)?|current date)$/.test(text);
  if (!wantsTime && !wantsDate) return '';
  const now = new Date();
  const time = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const date = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  if (wantsTime && wantsDate) return `It's ${time} on ${date}.`;
  return wantsTime ? `It's ${time}.` : `Today is ${date}.`;
}

// "open youtube and search lofi beats" — a site plus a query in one breath. The
// site's own search URL is built directly, so the whole command stays local.
function compoundSiteSearch(commandText) {
  const match = commandText.match(/^(?:open(?:\s+up)?|go\s+to|visit|take\s+me\s+to)\s+(?:the\s+)?(.+?)\s+(?:and|then)\s+(search(?:\s+for)?|look\s+up|find|play|watch)\s+(.+)$/i);
  if (!match) return null;
  let url = '';
  try { url = resolveSiteUrl(stripActionFillers(cleanTarget(match[1]))); } catch { return null; }
  if (!url) return null;
  const query = stripActionFillers(cleanTarget(match[3])).replace(/^for\s+/i, '').trim();
  if (!query || query.length < 2 || query.length > 120) return null;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const template = SITE_SEARCH_TEMPLATES.find((item) => item.host.test(host));
  if (!template) return null;
  const wantsPlayback = /^(?:play|watch)$/i.test(match[2]);
  return { site: template.name, query, play: Boolean(template.play && wantsPlayback), build: template.build };
}

function siteSearchIntent(commandText, lastTarget, projects) {
  if (!lastTarget || lastTarget.kind !== 'site') return null;
  const match = commandText.match(/^(open|play|watch|find|look\s+(?:for|up)|put\s+on|show\s+me)\s+(.+)$/i);
  if (!match) return null;
  const query = stripActionFillers(cleanTarget(match[2])).replace(/\s+/g, ' ').trim();
  if (!query || query.length < 2 || query.length > 120) return null;
  if (isBareMediaReference(query)) return null;
  if (/\.[a-z0-9]{1,6}$/i.test(query)) return null; // a file name, not a video
  if (/\b(?:file|document|pdf|resume|cv|spreadsheet|presentation)\b/i.test(query)) return null; // a local file request
  if (normalizeDesktopTarget(query) || resolveAppEntry(query) || isKnownSite(query) || projectByName(projects, query)) return null;
  let host = '';
  try { host = new URL(lastTarget.url).hostname.toLowerCase(); } catch { return null; }
  const template = SITE_SEARCH_TEMPLATES.find((item) => item.host.test(host));
  if (!template) return null;
  // “play”, “watch”, and “open <name>” actually play the top YouTube result;
  // “find”/“look for” stay on the results page.
  const wantsPlayback = /^(?:open|play|watch|put\s+on|show\s+me)$/i.test(match[1]);
  return { url: template.build(query), site: template.name, query, play: Boolean(template.play && wantsPlayback) };
}

// Plays the top YouTube result for a query. Falls back to the results page when
// the lookup fails, so the command never leaves the user with nothing.
async function playOnYouTube(query, site = 'YouTube') {
  const video = await findYouTubeVideo(query);
  if (video && video.url) {
    return {
      action: {
        id: 'open_url',
        type: 'open_url',
        args: { url: `${video.url}&autoplay=1` },
        label: video.title ? `Play ${video.title}` : `Play ${query}`,
      },
      reply: video.title ? `Playing “${video.title}” on ${site}.` : `Playing the top ${site} result for “${query}”.`,
    };
  }
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  return {
    action: { id: 'open_url', type: 'open_url', args: { url }, label: `Search ${site} for ${query}` },
    reply: `I could not start the first result automatically, so I am opening ${site} results for “${query}”.`,
  };
}

// “play that video”, “watch the song” — these point at the open window, not at
// a search query.
function isBareMediaReference(value) {
  return /^(?:(?:it|that|this|the|my|the\s+last|that\s+same)\s+)?(?:video|song|movie|music|clip|track|thing)$/i.test(String(value || '').trim())
    || /^(?:it|that|this|the\s+last)$/i.test(String(value || '').trim());
}

// Document, media, and archive extensions that are clearly files, never sites.
// “open report.pdf” must find the file, not visit https://report.pdf.
const FILE_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|pptx?|txt|rtf|md|csv|json|xml|html?|png|jpe?g|gif|webp|bmp|svg|mp4|mkv|mov|avi|webm|mp3|wav|flac|m4a|zip|rar|7z|exe|msi|iso|apk)$/i;

// “open report.pdf”, “find my resume”, or a file request while a folder is
// open. The query is matched against the user's own folders only.
function fileRequestIntent(commandText, lastTarget, projects) {
  const match = commandText.match(/^(?:open|find|locate|show(?:\s+me)?)\s+(?:the\s+|my\s+)?(?:file\s+|document\s+)?(?:named\s+|called\s+)?(.+)$/i);
  if (!match) return null;
  let candidate = stripActionFillers(cleanTarget(match[1])).replace(/\s+/g, ' ').trim();
  let folder = '';
  const where = candidate.match(/\s+in\s+(?:the\s+)?(downloads|documents|desktop|pictures|videos|music)\s*$/i);
  if (where) {
    folder = where[1].charAt(0).toUpperCase() + where[1].slice(1).toLowerCase();
    candidate = candidate.slice(0, where.index).trim();
  }
  candidate = candidate.replace(/\s+(?:file|document)\s*$/i, '').trim();
  if (!candidate || candidate.length < 2 || candidate.length > 120) return null;

  const hasFileExtension = FILE_EXTENSIONS.test(candidate);
  const looksLikeFile = hasFileExtension
    || /\b(?:file|document|pdf|photo|picture|video|song|spreadsheet|presentation|resume|cv)\b/i.test(commandText);
  const folderContext = Boolean(lastTarget && lastTarget.kind === 'desktop');
  if (!looksLikeFile && !folderContext && !folder) return null;

  // A real file extension wins over every app/site guess.
  if (hasFileExtension) {
    if (!folder && lastTarget && lastTarget.kind === 'desktop') {
      const byKey = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', pictures: 'Pictures' };
      folder = byKey[lastTarget.key] || '';
    }
    return { query: candidate, folder };
  }

  // Never hijack a real app, folder, site, or project name.
  if (normalizeDesktopTarget(candidate) || resolveAppEntry(candidate) || isKnownSite(candidate)) return null;
  if (projectByName(projects, candidate)) return null;
  const installed = findInstalledApp(candidate);
  if (installed && installed.score >= 90) return null;

  if (!folder && lastTarget && lastTarget.kind === 'desktop') {
    const byKey = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', pictures: 'Pictures' };
    folder = byKey[lastTarget.key] || '';
  }
  return { query: candidate, folder };
}

// Where a found file lives, in user-friendly terms: “Desktop” rather than the
// full path, and “dist” only when it is not inside one of the user folders.
function describeUserFolder(dir) {
  const normalized = String(dir || '').toLowerCase();
  if (!normalized) return '';
  const order = ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Videos', 'Music'];
  for (const folder of order) {
    const lower = folder.toLowerCase();
    if (normalized.endsWith(`\\${lower}`) || normalized.includes(`\\${lower}\\`)) return folder;
  }
  return String(dir || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function canonicalContextTarget(target, projects) {
  if (!target || typeof target !== 'object') return null;
  const kind = typeof target.kind === 'string' ? target.kind.toLowerCase() : (typeof target.type === 'string' ? target.type.toLowerCase() : '');
  if (kind === 'desktop' || kind === 'windows') {
    const key = normalizeDesktopTarget(target.key || target.target || target.name);
    if (!key) return null;
    const descriptor = resolveWindowsTarget(key);
    return { kind: 'desktop', key: descriptor.key, label: descriptor.label };
  }
  if (kind === 'site' || kind === 'url') {
    try {
      const url = resolveSiteUrl(target.url || target.value || target.key || target.name || '');
      return url ? { kind: 'site', url } : null;
    } catch {
      return null;
    }
  }
  if (kind === 'app') {
    const entry = resolveAppEntry(target.id || target.key || target.name || '');
    return entry ? { kind: 'app', id: entry.id, label: entry.label } : null;
  }
  if (kind === 'terminal') return { kind: 'terminal', label: 'terminal' };
  if (kind === 'file') {
    const filePath = String(target.path || target.key || '');
    if (!filePath) return null;
    return { kind: 'file', path: filePath, label: String(target.label || target.name || filePath.split(/[\\/]/).filter(Boolean).pop() || 'file') };
  }
  if (kind === 'project') {
    const project = projects.find((item) => item.id === target.projectId);
    return project ? { kind: 'project', projectId: project.id, label: project.name } : null;
  }
  return null;
}

function contextForAction(action, projects) {
  if (action.type === 'open_desktop_target') {
    const descriptor = resolveWindowsTarget(action.args && action.args.target);
    return { kind: 'desktop', key: descriptor.key, label: descriptor.label };
  }
  if (action.type === 'open_url') return { kind: 'site', url: action.args.url };
  if (action.type === 'open_app') {
    const entry = resolveAppEntry(action.args && action.args.id);
    return entry ? { kind: 'app', id: entry.id, label: entry.label } : null;
  }
  if (action.type === 'open_start_menu_app' && action.args && typeof action.args.name === 'string') {
    return { kind: 'app', id: action.args.name, label: action.args.name };
  }
  if (action.type === 'open_terminal') return { kind: 'terminal', label: 'terminal' };
  if (action.type === 'open_user_file' && action.args) {
    return { kind: 'file', path: action.args.path, label: action.args.name || String(action.args.path || '').split(/[\\/]/).filter(Boolean).pop() || 'file' };
  }
  if (action.type === 'open_project') {
    const project = projects.find((item) => item.id === action.args.projectId);
    return project ? { kind: 'project', projectId: project.id, label: project.name } : null;
  }
  return null;
}

function contextAction(target, projects) {
  if (!target) return null;
  if (target.kind === 'desktop') return { id: 'open_desktop_target', type: 'open_desktop_target', args: { target: target.key }, label: `Open ${target.label}` };
  if (target.kind === 'site') return { id: 'open_url', type: 'open_url', args: { url: target.url }, label: `Open ${target.url}` };
  if (target.kind === 'app') {
    const entry = resolveAppEntry(target.id);
    return entry
      ? { id: 'open_app', type: 'open_app', args: { id: entry.id }, label: `Open ${entry.label}` }
      : { id: 'open_start_menu_app', type: 'open_start_menu_app', args: { name: target.id }, label: `Open ${target.label}` };
  }
  if (target.kind === 'terminal') return { id: 'open_terminal', type: 'open_terminal', args: {}, label: 'Open a terminal' };
  if (target.kind === 'file') return { id: 'open_user_file', type: 'open_user_file', args: { path: target.path, name: target.label }, label: `Open ${target.label}` };
  if (target.kind === 'project') {
    const project = projects.find((item) => item.id === target.projectId);
    return project ? { id: 'open_project', type: 'open_project', args: { projectId: project.id }, label: `Open ${project.name}` } : null;
  }
  return null;
}

function baseResult(settings, context, extra = {}) {
  const preserved = {};
  for (const key of ['mediaState', 'pending', 'lastFileQuery']) {
    if (extra && extra[key]) preserved[key] = extra[key];
  }
  return { actions: [], provider: providerInfo(settings), context: { ...preserved, lastTarget: context } };
}

// Only these actions may be replayed from a stored spoken confirmation. The
// rest of the pending object comes from the browser's localStorage, so it is
// never trusted as-is.
const CONFIRMABLE_ACTIONS = new Set(['system_power', 'empty_recycle_bin', 'recycle_file']);

function confirmedAction(pending) {
  const action = pending && pending.action;
  if (!action || typeof action !== 'object' || !CONFIRMABLE_ACTIONS.has(action.type)) return null;
  const args = action.args || {};
  if (action.type === 'system_power') {
    if (args.mode !== 'shutdown' && args.mode !== 'restart') return null;
    return { id: 'system_power', type: 'system_power', args: { mode: args.mode }, confirmedByUser: true, label: args.mode === 'restart' ? 'Restart the PC' : 'Shut down the PC' };
  }
  if (action.type === 'empty_recycle_bin') {
    return { id: 'empty_recycle_bin', type: 'empty_recycle_bin', args: {}, confirmedByUser: true, label: 'Empty the Recycle Bin' };
  }
  if (typeof args.path !== 'string' || !args.path) return null;
  return { id: 'recycle_file', type: 'recycle_file', args: { path: args.path }, confirmedByUser: true, label: action.label || 'Move the file to the Recycle Bin' };
}

// Plain-language explanation of each guardrail level, used by the spoken
// status reply and by the full app.
const GUARDRAIL_SUMMARY = {
  strict: 'Strict: every action that touches your PC waits for your yes.',
  guarded: 'Guarded: opening, typing, playback, and scrolling run; file changes, closing apps, and power actions wait for your yes.',
  trusted: 'Trusted: only destructive actions wait for your yes.',
};

function guardrailModeReply(mode) {
  return `Guardrails are now ${mode}. ${GUARDRAIL_SUMMARY[mode] || GUARDRAIL_SUMMARY[DEFAULT_MODE]}`;
}

function guardrailStatusReply(state, pendingCount) {
  const mode = normalizeMode(state && state.mode) || DEFAULT_MODE;
  const locked = Boolean(state && state.locked);
  const waiting = pendingCount > 0 ? ` ${pendingCount} action${pendingCount === 1 ? ' is' : 's are'} waiting for your approval.` : '';
  return `Guardrails: ${mode}${locked ? ', master lock ON' : ''}. ${GUARDRAIL_SUMMARY[mode]}${locked ? ' Nothing that changes your PC will run until you say “unlock controls”.' : ''}${waiting}`;
}

function auditReply(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return 'No actions have been recorded yet.';
  const lines = entries.slice(0, 5).map((entry) => {
    const time = entry.at ? new Date(entry.at).toLocaleTimeString() : '';
    return `${time} ${entry.decision}: ${entry.label}`;
  });
  return `Here is the recent activity log.\n${lines.join('\n')}`;
}

async function handleChat({ message, history = [], projects = [], settings, user, context, requestContext, lastTarget: directLastTarget, guardrails, audit = [], pendingApprovals = 0 }) {
  const incomingContext = context || requestContext || (directLastTarget ? { lastTarget: directLastTarget } : {});
  const lastTarget = canonicalContextTarget(incomingContext.lastTarget, projects);
  const result = baseResult(settings, lastTarget, incomingContext);
  if (typeof message !== 'string' || !message.trim()) {
    result.reply = 'Tell me what you would like to do. Try “list projects” or “open https://example.com”.';
    return result;
  }
  const text = message.trim();
  const userName = displayNameFor(user);
  if (isGreeting(text)) {
    result.reply = `Hey ${userName}! I’m BRO, your local assistant. I’m here and ready whenever you are. I’ll only take action when you explicitly ask me to.`;
    return result;
  }
  let commandText = stripCommandPoliteness(stripGreetingPrefix(text));

  if (/^(?:activate|start|wake(?:\s+up)?)\s+bro(?:\s+command)?$/i.test(commandText)) {
    result.actions.push({ id: 'activate_bro', type: 'activate_bro', args: {}, label: 'Activate BRO voice popup' });
    result.reply = 'BRO is activated. Press Ctrl + Alt + B once to listen through Wispr Flow; BRO stops after one command.';
    return result;
  }

  if (/^(?:stop\s+listening|(?:go\s+(?:to\s+)?)?sleep(?:\s+mode)?|sleeping|go\s+quiet|go\s+away|disappear|hide(?:\s+yourself)?|good\s?bye|bye(?:\s+bro)?|that'?s\s+all|thats\s+all)[.!]?$/i.test(commandText)) {
    result.reply = 'Okay, I’ll stop listening. Press Ctrl + Alt + B whenever you want to talk again.';
    return result;
  }

  const clock = clockAnswer(commandText);
  if (clock) {
    result.reply = clock;
    return result;
  }

  // "notepad", "chrome", "youtube" — say the name alone and BRO opens it, at the
  // same speed as "open notepad".
  if (isBareOpenName(commandText, projects)) commandText = `open ${commandText}`;
  const lower = commandText.toLowerCase();

  // A previous sentence asked for something risky (shut down, empty the
  // Recycle Bin, delete a file). It only runs after a clear spoken "yes".
  if (result.context.pending) {
    if (/^(?:yes|yeah|yep|yup|sure|okay|ok|do\s+it|go\s+ahead|confirm(?:ed)?|proceed)[.!]?$/i.test(commandText)) {
      const action = confirmedAction(result.context.pending);
      delete result.context.pending;
      if (!action) {
        result.reply = 'That confirmation is no longer valid. Please ask me again.';
        return result;
      }
      result.actions.push(action);
      result.reply = `${action.type === 'system_power' ? 'Confirmed.' : 'Confirmed.'} ${action.label}.`;
      return result;
    }
    if (/^(?:no|nope|nah|cancel|stop|abort|never\s*mind|do\s+not|don'?t)[.!]?$/i.test(commandText)) {
      delete result.context.pending;
      result.reply = 'Okay, I cancelled that.';
      return result;
    }
    // Any other command replaces the pending request.
    delete result.context.pending;
  }

  // Guardrail controls belong to the user only. These are handled before any
  // ordinary action so a gate can never be bypassed by a sentence.
  const guardrailMode = commandText.match(/^(?:set\s+|switch\s+|change\s+|use\s+)?(?:guardrails?|guard\s*rails?|safety|security)\s+(?:to\s+|mode\s+)?(strict|guarded|trusted)$/i);
  if (guardrailMode) {
    const mode = guardrailMode[1].toLowerCase();
    result.actions.push({ id: 'set_guardrails', type: 'set_guardrails', args: { mode }, label: `Set guardrails to ${mode}` });
    result.reply = guardrailModeReply(mode);
    return result;
  }
  if (/^(?:lock|freeze|disable|pause|stop)\s+(?:all\s+)?(?:the\s+)?(?:controls?|commands?|actions?|everything|bro|pc)$/i.test(commandText)
    || /^(?:master\s+lock|lock\s+everything|lock\s+it\s+down)$/i.test(commandText)) {
    result.actions.push({ id: 'lock_controls', type: 'lock_controls', args: {}, label: 'Turn the master lock on' });
    result.reply = 'Master lock is on. Nothing that changes your PC will run until you say “unlock controls”.';
    return result;
  }
  if (/^(?:unlock|enable|resume|release|unfreeze)\s+(?:all\s+)?(?:the\s+)?(?:controls?|commands?|actions?|everything|bro|pc)$/i.test(commandText)
    || /^(?:master\s+unlock|unlock\s+it)$/i.test(commandText)) {
    result.actions.push({ id: 'unlock_controls', type: 'unlock_controls', args: {}, label: 'Turn the master lock off' });
    result.reply = 'Master lock is off. Guardrails are back on.';
    return result;
  }
  if (/^(?:guardrails?|safety|security)\s+(?:status|state|settings?)\??$/i.test(commandText)
    || /^what(?:'?s| is) (?:my )?(?:guardrails?|safety|security)(?: status)?\??$/i.test(commandText)
    || /^(?:am i|are we) locked\??$/i.test(commandText)) {
    result.reply = guardrailStatusReply(guardrails, pendingApprovals);
    return result;
  }
  if (/^(?:show|read|open|list)\s+(?:me\s+)?(?:the\s+)?(?:audit|activity|action)\s+(?:log|history|trail)$/i.test(commandText)
    || /^what (?:did you do|have you done)(?: last)?\??$/i.test(commandText)) {
    result.reply = auditReply(audit);
    return result;
  }

  if (/^(help|what can you do|commands?)\??$/i.test(commandText)) {
    result.reply = 'Everything I do is under your guardrails. Say “guardrails status”, “guardrails strict”, “guardrails guarded”, “guardrails trusted”, “lock everything”, “unlock controls”, or “show the audit log”. I can greet you, activate the BRO voice popup, open any app installed on this PC ("open Telegram", "open Chrome"), open known sites ("open Gmail", "open YouTube"), open Windows folders and tools ("open Downloads", "open Task Manager"), search the web or YouTube, open a terminal, list or open registered projects, and run a named project profile after approval. Desktop apps are checked before websites; say "open GitHub website" if you want the page instead of the app. Opened windows come to the front and are enlarged to fill the screen. After I open a site, name a video or search and I stay on that site: "play lo-fi beats" plays the top YouTube video, "find lo-fi beats" shows results. I can also find and open your files by name ("open report.pdf", "open my resume"). I control the window I opened last: "check it once", "bring that back", "open that video", "minimize it", "maximize it". I can close things: "close Telegram", "close Gmail" (that tab), "close this window", "close the tab in front", "close that", "close everything" or "close all windows". I also control playback and apps: "pause", "stop", "play", "forward" or "backward" (10 seconds each), "skip forward 30 seconds", "play the next video", "volume up", "mute", "captions on", "fullscreen", "next tab", "zoom in", "scroll down" or "scroll up" (works in Gmail, YouTube, and other long lists), "type hello", "click first result", "save", "print", Gmail and Outlook searches, WhatsApp chats, Google Drive, Office and VS Code shortcuts, "take a screenshot", Windows Settings pages, "create a folder called Reports", and power actions. I also have local PC controls: "open start menu", "show task view", "open quick settings", "open run dialog", "show clipboard", "refresh", "refresh the desktop", "switch window", "open control panel", "open device manager", "open programs and features", "open network connections", "open system information", "open event viewer", "open disk management", "open services", "open printers", "open recycle bin", and "open this pc". Shutdown, restart, deleting a file, and emptying the Recycle Bin ask for a spoken "yes" first, and I never send messages or share your screen automatically. Say "sleep" or "go to sleep mode" and I disappear until you say "BRO" or press Ctrl + Alt + B.';
    return result;
  }
  if (/^(status|health|provider status)\??$/i.test(commandText)) {
    result.reply = result.provider.configured ? `Provider ${result.provider.model} is configured.` : 'No AI provider is configured. Local project actions are still available.';
    return result;
  }
  if (/^(list|show)(?:\s+me)?\s+(?:my\s+)?projects\??$/i.test(commandText) || lower === 'projects') {
    result.reply = projects.length ? projects.map((project) => `${project.name} (${project.root})`).join('\n') : 'No projects are registered yet.';
    return result;
  }

  if (/^(?:open|launch|start)\s+(?:the\s+)?(?:terminal|command prompt|cmd|powershell|windows terminal)\s*$/i.test(commandText)) {
    const action = { id: 'open_terminal', type: 'open_terminal', args: {}, label: 'Open a terminal' };
    result.actions.push(action);
    result.context.lastTarget = contextForAction(action, projects);
    result.reply = 'Opening a terminal for you.';
    return result;
  }

  // Application-control skill: playback, browsers, mail, office apps, settings,
  // screenshots, keyboard, scrolling, clicking, folders, and power actions.
  const skill = matchApplicationSkill(commandText, {
    lastTarget,
    mediaState: result.context.mediaState,
    lastFileQuery: result.context.lastFileQuery,
  });
  if (skill) {
    if (skill.action) {
      result.actions.push(skill.action);
      if (skill.action.type === 'open_url' || skill.action.type === 'open_desktop_target') {
        result.context.lastTarget = contextForAction(skill.action, projects) || lastTarget;
      }
    }
    if (skill.reply) result.reply = skill.reply;
    if (skill.mediaState) result.context.mediaState = skill.mediaState;
    if (skill.pending) result.context.pending = skill.pending;
    return result;
  }

  // "Open that" is intentionally handled before the general open parser. It
  // can only replay a target that the assistant previously recognized.
  if (/^(?:open|launch|start)\s+(?:that|it|this)(?:\s+again)?\s*$/i.test(commandText)) {
    const action = contextAction(lastTarget, projects);
    if (!action) {
      result.reply = 'Which item should I open? Please name a site, Windows target, or registered project.';
      return result;
    }
    result.actions.push(action);
    result.context.lastTarget = contextForAction(action, projects);
    result.reply = `Opening ${action.label.replace(/^Open\s+/i, '')}.`;
    return result;
  }

  const youtubeSearch = commandText.match(/^(?:search|find)\s+(?:on\s+)?youtube(?:\s+for)?\s+(.+)$/i);
  if (youtubeSearch) {
    const query = youtubeSearch[1].trim();
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const action = { id: 'open_url', type: 'open_url', args: { url }, label: `Search YouTube for ${query}` };
    result.actions.push(action);
    result.context.lastTarget = contextForAction(action, projects);
    result.reply = `Opening YouTube results for “${query}”. I won’t claim playback started unless a connected browser-control session reports it.`;
    return result;
  }

  const youtubeFind = commandText.match(/^find\s+(.+?)\s+on\s+youtube$/i);
  if (youtubeFind) {
    const query = youtubeFind[1].trim();
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const action = { id: 'open_url', type: 'open_url', args: { url }, label: `Search YouTube for ${query}` };
    result.actions.push(action);
    result.context.lastTarget = contextForAction(action, projects);
    result.reply = `Opening YouTube results for “${query}”.`;
    return result;
  }

  const webSearch = commandText.match(/^(?:search(?:\s+for)?|google)\s+(.+)$/i);
  if (webSearch) {
    const query = webSearch[1].trim();
    const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const action = { id: 'open_url', type: 'open_url', args: { url }, label: `Search the web for ${query}` };
    result.actions.push(action);
    result.context.lastTarget = contextForAction(action, projects);
    result.reply = `Opening web results for “${query}”.`;
    return result;
  }

  // Closing works for apps, web pages (browser tabs) and whatever window is in
  // front, so “close it” always has a meaning on this PC.
  const closeRequest = commandText.match(/^(?:close|quit|exit|shut(?:\s+down)?|kill|terminate|end)\s*(.*)$/i);
  if (closeRequest) {
    const spokenTarget = stripActionFillers(cleanTarget(closeRequest[1] || '')).replace(/\s+/g, ' ').trim();
    const closeCandidate = spokenTarget
      .replace(/^(?:the\s+)?(?:app|application|program|software|window|page|tab)\s+/i, '')
      .replace(/^the$/i, '')
      .trim();
    const wantsTab = /\b(?:tab|page)\b/i.test(spokenTarget);

    if (/^(?:everything|all|all\s+apps|all\s+applications|all\s+programs|everything\s+(?:you|i)\s+opened|what\s+(?:you|i)\s+opened|my\s+apps)$/i.test(closeCandidate)) {
      result.actions.push({ id: 'close_opened_apps', type: 'close_opened_apps', args: {}, label: 'Close the apps BRO opened' });
      result.closeTargets = ['the apps I opened'];
      result.reply = 'Closing the apps and tabs I opened.';
      return result;
    }
    if (/^(?:all\s+(?:the\s+)?(?:windows|tabs|pages)|every\s+(?:window|tab|page)|everything\s+on\s+(?:the\s+)?screen|whatever\s+is\s+on\s+(?:the\s+)?screen)$/i.test(closeCandidate)) {
      result.actions.push({ id: 'close_all_windows', type: 'close_all_windows', args: {}, label: 'Close every open window' });
      result.closeTargets = ['all open windows'];
      result.reply = 'Closing every window that is open.';
      return result;
    }

    const refersToLast = /^(?:that|it|that\s+(?:app|application|window|program|page|tab|site)|the\s+last\s+(?:app|thing|one))$/i.test(closeCandidate);
    const bareApp = /^(?:app|application|program|software)$/i.test(closeCandidate);
    const refersToFront = !closeCandidate || bareApp
      || /^(?:this|this\s+(?:app|application|window|program|page|tab)|window|tab|page|current\s+(?:window|app|tab)|active\s+(?:window|app|tab)|focused\s+(?:window|app)|foreground\s+(?:window|app)|thing\s+(?:in|on)\s+(?:the\s+)?(?:front|screen))$/i.test(closeCandidate);

    if (refersToLast || (bareApp && lastTarget)) {
      if (!lastTarget) {
        result.actions.push({ id: 'close_window', type: 'close_window', args: { tab: wantsTab }, label: 'Close the window in front' });
        result.closeTargets = ['the window in front'];
        result.reply = 'Closing the window in front.';
        return result;
      }
      if (lastTarget.kind === 'app') {
        const entry = resolveAppEntry(lastTarget.id);
        if (!entry) {
          result.actions.push({ id: 'close_start_menu_app', type: 'close_start_menu_app', args: { name: lastTarget.id }, label: `Close ${lastTarget.label}` });
          result.closeTargets = [lastTarget.label];
          result.reply = `Closing ${lastTarget.label}.`;
          return result;
        }
        result.actions.push({ id: 'close_app', type: 'close_app', args: { id: entry.id }, label: `Close ${entry.label}` });
        result.closeTargets = [entry.label];
        result.reply = `Closing ${entry.label}.`;
        return result;
      }
      if (lastTarget.kind === 'site') {
        const label = siteLabel(lastTarget.url);
        result.actions.push({ id: 'close_website', type: 'close_website', args: { name: label, label, url: lastTarget.url }, label: `Close the ${label} tab` });
        result.closeTargets = [label];
        result.reply = `Closing the ${label} tab.`;
        return result;
      }
      if (lastTarget.kind === 'file') {
        result.actions.push({ id: 'close_window', type: 'close_window', args: { tab: false }, label: `Close ${lastTarget.label}` });
        result.closeTargets = [lastTarget.label];
        result.reply = `Closing “${lastTarget.label}”.`;
        return result;
      }
      if (lastTarget.kind === 'desktop') {
        // Folders and Windows tools (Notepad, Calculator, Downloads, …) are
        // closed by their window title, which is what the user just opened.
        result.actions.push({ id: 'close_named_app', type: 'close_named_app', args: { name: lastTarget.label }, label: `Close ${lastTarget.label}` });
        result.closeTargets = [lastTarget.label];
        result.reply = `Closing ${lastTarget.label}.`;
        return result;
      }
      result.reply = 'The last thing I opened was not an app or a web page, so there is nothing for me to close.';
      return result;
    }

    if (refersToFront) {
      result.actions.push({ id: 'close_window', type: 'close_window', args: { tab: wantsTab }, label: wantsTab ? 'Close the tab in front' : 'Close the window in front' });
      result.closeTargets = [wantsTab ? 'the tab in front' : 'the window in front'];
      result.reply = wantsTab ? 'Closing the tab in front.' : 'Closing the window in front.';
      return result;
    }

    const names = closeCandidate.split(/\s*(?:,|and)\s*/).map((name) => name.trim()).filter(Boolean);
    const labels = [];
    const unresolved = [];
    for (const name of names) {
      const entry = resolveAppEntry(name);
      if (entry && !entry.protected) {
        result.actions.push({ id: 'close_app', type: 'close_app', args: { id: entry.id }, label: `Close ${entry.label}` });
        labels.push(entry.label);
        continue;
      }
      if (entry && entry.protected) {
        unresolved.push(`${entry.label} is part of Windows`);
        continue;
      }
      const siteUrl = (() => { try { return resolveSiteUrl(name); } catch { return null; } })();
      if (siteUrl) {
        const label = name || siteLabel(siteUrl);
        result.actions.push({ id: 'close_website', type: 'close_website', args: { name, label, url: siteUrl }, label: `Close the ${label} tab` });
        labels.push(label);
        continue;
      }
      const installed = findInstalledApp(name);
      if (installed && installed.score >= 70) {
        result.actions.push({ id: 'close_start_menu_app', type: 'close_start_menu_app', args: { name }, label: `Close ${installed.name}` });
        labels.push(installed.name);
        continue;
      }
      // Anything else: try BRO's tracked launches, the process name, and any
      // matching window title at execution time, so “close <whatever I opened>”
      // always does something useful.
      if (name.length >= 3) {
        result.actions.push({ id: 'close_named_app', type: 'close_named_app', args: { name }, label: `Close ${name}` });
        labels.push(name);
        continue;
      }
      unresolved.push(`I don’t know “${name}”`);
    }
    if (labels.length) {
      result.closeTargets = labels;
      result.reply = `Closing ${labels.join(', ')}.`;
      if (unresolved.length) result.reply += ` (${unresolved.join('; ')}.)`;
      return result;
    }
    result.reply = `I could not close that: ${unresolved.join('; ') || 'no app was named'}. Try “close Telegram”, “close Gmail”, or “close everything”.`;
    return result;
  }

  // Follow-ups that point back at the window BRO opened last, e.g.
  // “check it once”, “bring that back”, “open that video”, “minimize it”.
  const control = windowControlIntent(commandText, lastTarget);
  if (control) {
    result.actions.push(control.action);
    result.context.lastTarget = lastTarget;
    result.reply = control.reply;
    return result;
  }

  // “open YouTube” → “play lo-fi beats”: keep the new request inside the site
  // BRO opened, instead of looking for an app called “lo-fi beats”.
  const siteSearch = siteSearchIntent(commandText, lastTarget, projects);
  if (siteSearch) {
    if (siteSearch.play) {
      const played = await playOnYouTube(siteSearch.query, siteSearch.site);
      result.actions.push(played.action);
      result.context.lastTarget = contextForAction(played.action, projects);
      if (String(played.action.args && played.action.args.url || '').includes('watch?v=')) result.context.mediaState = 'playing';
      result.reply = played.reply;
      return result;
    }
    const action = { id: 'open_url', type: 'open_url', args: { url: siteSearch.url }, label: `Search ${siteSearch.site} for ${siteSearch.query}` };
    result.actions.push(action);
    result.context.lastTarget = { kind: 'site', url: siteSearch.url };
    result.reply = `Searching ${siteSearch.site} for “${siteSearch.query}”.`;
    return result;
  }

  // “play <video name>”, or “play <video name> on YouTube”, even when YouTube
  // is not open yet. This plays the top result instead of searching.
  const playRequest = commandText.match(/^(?:play|watch|put\s+on)\s+(?:the\s+)?(?:video\s+)?(.+?)(?:\s+(?:on|in)\s+youtube)?$/i);
  if (playRequest) {
    const query = stripActionFillers(cleanTarget(playRequest[1])).replace(/\s+/g, ' ').trim();
    if (query && query.length >= 2 && query.length <= 120 && !isBareMediaReference(query)
      && !normalizeDesktopTarget(query) && !resolveAppEntry(query) && !isKnownSite(query) && !projectByName(projects, query)) {
      const played = await playOnYouTube(query, 'YouTube');
      result.actions.push(played.action);
      result.context.lastTarget = contextForAction(played.action, projects);
      if (String(played.action.args && played.action.args.url || '').includes('watch?v=')) result.context.mediaState = 'playing';
      result.reply = played.reply;
      return result;
    }
  }

  // “open report.pdf”, or “open my resume” right after opening a folder.
  // The file is looked up in the user's own folders and opened directly.
  const fileRequest = fileRequestIntent(commandText, lastTarget, projects);
  if (fileRequest) {
    result.context.lastFileQuery = fileRequest.query;
    const file = findUserFile(fileRequest.query, { folder: fileRequest.folder });
    if (file) {
      const action = { id: 'open_user_file', type: 'open_user_file', args: { path: file.path, name: file.name }, label: `Open ${file.name}` };
      result.actions.push(action);
      result.context.lastTarget = contextForAction(action, projects);
      const where = describeUserFolder(file.dir);
      result.reply = `Opening “${file.name}”${where ? ` from ${where}` : ''}.`;
      return result;
    }
    result.reply = `I could not find a file called “${fileRequest.query}”. I looked in ${USER_FILE_FOLDERS.join(', ')}.`;
    return result;
  }

  const multi = compoundSiteSearch(commandText);
  if (multi) {
    if (multi.play && /youtube/i.test(multi.site)) {
      const played = await playOnYouTube(multi.query, multi.site);
      result.actions.push(played.action);
      result.context.lastTarget = contextForAction(played.action, projects);
      result.reply = played.reply;
      return result;
    }
    const url = multi.build(multi.query);
    const action = { id: 'open_url', type: 'open_url', args: { url }, label: `Search ${multi.site} for ${multi.query}` };
    result.actions.push(action);
    result.context.lastTarget = contextForAction(action, projects);
    result.reply = `Searching ${multi.site} for “${multi.query}”.`;
    return result;
  }

  const openRequest = commandText.match(/^(?:open(?:\s+up)?|launch|start|visit|go\s+to|take\s+me\s+to|bring\s+up|pull\s+up|fire\s+up|boot\s+up|load|show\s+me|check(?:\s+my)?)\s+(?:the\s+)?(?:url|site|website|web\s+site|app|application|page)?\s*(.+)$/i);
  if (openRequest) {
    const rawTarget = openRequest[1].trim();
    const wantsWebsite = /\b(website|web site|site|web|online|in the browser|in chrome)\b/i.test(rawTarget);
    const candidate = stripActionFillers(cleanTarget(rawTarget));
    if (!candidate) {
      result.reply = 'What should I open? Try “open Telegram”, “open Gmail”, or “open Downloads”.';
      return result;
    }

    const desktopKey = normalizeDesktopTarget(candidate);
    if (desktopKey) {
      const descriptor = resolveWindowsTarget(desktopKey);
      const action = { id: 'open_desktop_target', type: 'open_desktop_target', args: { target: descriptor.key }, label: `Open ${descriptor.label}` };
      result.actions.push(action);
      result.context.lastTarget = contextForAction(action, projects);
      result.reply = `Opening ${descriptor.label}.`;
      return result;
    }

    // 1. A known desktop app that is actually installed on this PC.
    const appEntry = resolveAppEntry(candidate);
    if (appEntry && !wantsWebsite) {
      const installed = findInstalledApp(Array.isArray(appEntry.desktop) && appEntry.desktop.length ? appEntry.desktop : [appEntry.label]);
      if (installed) {
        const action = { id: 'open_app', type: 'open_app', args: { id: appEntry.id }, label: `Open ${appEntry.label}` };
        result.actions.push(action);
        result.context.lastTarget = contextForAction(action, projects);
        result.reply = `Opening ${appEntry.label}.`;
        return result;
      }
    }

    // 2. Any app installed on this PC. A strong desktop-app match wins over a
    //    website with the same name; a weak partial match (for example “link”
    //    matching Phone Link) never hijacks a known site.
    const installed = !wantsWebsite && candidate.length >= 2 && candidate.length <= 60 ? findInstalledApp(candidate) : null;
    let knownUrl = null;
    try {
      knownUrl = resolveSiteUrl(candidate) || (appEntry && appEntry.url) || null;
    } catch (error) {
      result.reply = error.message;
      return result;
    }
    if (installed && (installed.score >= 85 || !knownUrl)) {
      const action = { id: 'open_start_menu_app', type: 'open_start_menu_app', args: { name: candidate }, label: `Open ${installed.name}` };
      result.actions.push(action);
      result.context.lastTarget = contextForAction(action, projects);
      result.reply = `Opening ${installed.name}.`;
      return result;
    }

    // 3. A known website, only when no strong desktop app matched.
    if (knownUrl) {
      const action = { id: 'open_url', type: 'open_url', args: { url: knownUrl }, label: `Open ${knownUrl}` };
      result.actions.push(action);
      result.context.lastTarget = contextForAction(action, projects);
      const typedDomain = /^https?:\/\//i.test(candidate) || /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(candidate);
      result.reply = typedDomain ? `Opening ${knownUrl}.` : `Opening ${siteDisplayName(knownUrl)}.`;
      return result;
    }

    // 4. A registered project folder.
    const project = projectByName(projects, candidate.replace(/^project\s+/i, '').trim());
    if (project) {
      const action = { id: 'open_project', type: 'open_project', args: { projectId: project.id }, label: `Open ${project.name}` };
      result.actions.push(action);
      result.context.lastTarget = contextForAction(action, projects);
      result.reply = `Opening ${project.name}.`;
      return result;
    }

    result.reply = `I don’t know “${candidate}” yet. I can open installed apps (“open Telegram”), known sites (“open Gmail”), Windows folders (“open Downloads”), or a registered project from the Workspace tab.`;
    return result;
  }

  const openProject = commandText.match(/^show\s+(?:me\s+)?(?:project\s+)?(.+)$/i);
  if (openProject && !isSiteReference(openProject[1].trim())) {
    const project = projectByName(projects, openProject[1]);
    if (!project) { result.reply = `I could not find a registered project named “${openProject[1].trim()}”.`; return result; }
    const action = { id: 'open_project', type: 'open_project', args: { projectId: project.id }, label: `Open ${project.name}` };
    result.actions.push(action);
    result.context.lastTarget = contextForAction(action, projects);
    result.reply = `Opening ${project.name}.`;
    return result;
  }

  const runMatch = commandText.match(/^(?:run|execute)\s+(.+?)\s+(?:in|on|for)\s+(?:project\s+)?(.+)$/i);
  if (runMatch) {
    const profile = normalizeProfileName(runMatch[1]);
    const project = projectByName(projects, runMatch[2]);
    if (!project) { result.reply = `I could not find a registered project named “${runMatch[2].trim()}”.`; return result; }
    if (!Object.prototype.hasOwnProperty.call(project.commands || {}, profile)) { result.reply = `Project ${project.name} has no configured profile named “${profile}”.`; return result; }
    result.actions.push({ id: 'run_project_command', type: 'run_project_command', requiresApproval: true, args: { projectId: project.id, profile }, label: `Run ${profile} in ${project.name}` });
    result.reply = `This will run the configured “${profile}” profile in ${project.name}. Approve it to continue.`;
    return result;
  }

  const mediaRequest = commandText.match(/^(play|pause|stop|resume)(?:\s+.*)?$/i);
  if (mediaRequest) {
    result.reply = `I heard “${mediaRequest[1].toLowerCase()}”. BRO is not connected to a browser-control session yet, so I have not changed playback.`;
    return result;
  }

  if (/^(?:send|message|text)\b/i.test(commandText) && /\bwhatsapp\b/i.test(commandText)) {
    result.reply = 'I can open WhatsApp Web, but I will not send a message until a browser-control session is connected and you approve the exact recipient and message.';
    return result;
  }

  // A PC action BRO could not map. The local model has no access to the
  // computer, so sending this to it only adds a slow, useless round-trip.
  if (looksLikePcAction(commandText)) {
    result.reply = `I heard “${commandText}”, but I don’t know how to do that yet. Try “open <app>”, “scroll down”, or say “help” for the full list.`;
    return result;
  }

  if (result.provider.configured) {
    const projectSummary = projects.length ? projects.map((project) => `${project.name}: ${Object.keys(project.commands || {}).join(', ') || 'no profiles'}`).join('; ') : 'none';
    // Short prompt on purpose: a small local model pays for every prompt token in prefill time.
    const system = `You are BRO, a concise voice assistant for ${userName} on Windows. Projects: ${projectSummary}. Answer in one to three short spoken sentences; no lists, no markdown. You cannot run commands or touch the computer: the app does that. Never say you opened, closed, clicked, scrolled, typed, or changed anything. If asked for the time, date, battery, or a file on this PC, say you cannot read it rather than guessing.`;
    const local = isLocalBaseUrl(settings && settings.baseUrl);
    const turns = local ? 6 : 10;
    const completion = await chatCompletion(settings, [{ role: 'system', content: system }, ...history.slice(-turns), { role: 'user', content: text }]);
    if (completion.ok) {
      result.reply = deniesUnperformedAction(completion.reply) ? UNPERFORMED_ACTION_REPLY : completion.reply;
      return result;
    }
    result.reply = completion.reason === 'provider timed out'
      ? 'The configured AI provider took too long to answer. The local model may still be starting; please try again.'
      : completion.reason === 'model not installed'
        ? `The local model “${settings.model}” is not installed yet. Run “ollama pull ${settings.model}” once, then ask me again.`
        : 'My local model is not answering, so I can still run direct commands such as “open YouTube”, “open Notepad”, or “scroll down”. Start Ollama for open conversation.';
    return result;
  }
  result.reply = 'I did not recognize that request. Try “help”, “list projects”, “open https://example.com”, or “run PROFILE in PROJECT”.';
  return result;
}

module.exports = { handleChat, projectByName, DEFAULT_USER_NAME, displayNameFor, isGreeting, stripGreetingPrefix, resolveSiteUrl, canonicalContextTarget, contextAction, siteLabel };
