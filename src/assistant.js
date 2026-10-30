const { validateHttpUrl, normalizeDesktopTarget, resolveWindowsTarget, findInstalledApp } = require('./tools');
const { providerInfo, chatCompletion } = require('./provider');
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
  const hasActionCue = /https?:\/\/|\b(?:open|visit|go\s+to|run|execute|list|show|search|find|google|status|health|help|activate|wake\s+up)\b/i.test(text);
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
  if (target.kind === 'project') {
    const project = projects.find((item) => item.id === target.projectId);
    return project ? { id: 'open_project', type: 'open_project', args: { projectId: project.id }, label: `Open ${project.name}` } : null;
  }
  return null;
}

function baseResult(settings, context) { return { actions: [], provider: providerInfo(settings), context: { lastTarget: context } }; }

async function handleChat({ message, history = [], projects = [], settings, user, context, requestContext, lastTarget: directLastTarget }) {
  const incomingContext = context || requestContext || (directLastTarget ? { lastTarget: directLastTarget } : {});
  const lastTarget = canonicalContextTarget(incomingContext.lastTarget, projects);
  const result = baseResult(settings, lastTarget);
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
  const commandText = stripCommandPoliteness(stripGreetingPrefix(text));
  const lower = commandText.toLowerCase();

  if (/^(?:activate|start|wake(?:\s+up)?)\s+bro(?:\s+command)?$/i.test(commandText)) {
    result.actions.push({ id: 'activate_bro', type: 'activate_bro', args: {}, label: 'Activate BRO voice popup' });
    result.reply = 'BRO is activated. Press Ctrl + Alt + B once to listen through Wispr Flow; BRO stops after one command.';
    return result;
  }

  if (/^(?:stop\s+listening|sleep|go\s+to\s+sleep|go\s+quiet|goodbye|bye(?:\s+bro)?|that'?s\s+all)[.!]?$/i.test(commandText)) {
    result.reply = 'Okay, I’ll stop listening. Press Ctrl + Alt + B whenever you want to talk again.';
    return result;
  }

  if (/^(help|what can you do|commands?)\??$/i.test(commandText)) {
    result.reply = 'I can greet you, activate the BRO voice popup, open any app installed on this PC (“open Telegram”, “open Chrome”), open known sites (“open Gmail”, “open YouTube”), open Windows folders and tools (“open Downloads”, “open Task Manager”), search the web or YouTube, open a terminal, list or open registered projects, and run a named project profile after approval. I can also close things: “close Telegram”, “close Gmail” (that tab), “close this window”, “close the tab in front”, “close that” (whatever I opened last), “close everything” (what I opened) or “close all windows”. Browser playback and sending messages remain unchanged until the matching browser-control session is connected and approved.';
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

    // 2. Any app installed on this PC with an exact name. A local application
    //    always beats a website when both could match.
    const installed = !wantsWebsite && candidate.length >= 2 && candidate.length <= 60 ? findInstalledApp(candidate) : null;
    if (installed && installed.score === 100) {
      const action = { id: 'open_start_menu_app', type: 'open_start_menu_app', args: { name: candidate }, label: `Open ${installed.name}` };
      result.actions.push(action);
      result.context.lastTarget = contextForAction(action, projects);
      result.reply = `Opening ${installed.name}.`;
      return result;
    }

    // 3. A known website.
    try {
      const url = resolveSiteUrl(candidate) || (appEntry && appEntry.url) || null;
      if (url) {
        const action = { id: 'open_url', type: 'open_url', args: { url }, label: `Open ${url}` };
        result.actions.push(action);
        result.context.lastTarget = contextForAction(action, projects);
        result.reply = `Opening ${url}.`;
        return result;
      }
    } catch (error) {
      result.reply = error.message;
      return result;
    }

    // 4. A near match in the installed apps, when no website claimed the name.
    if (installed && installed.score >= 70) {
      const action = { id: 'open_start_menu_app', type: 'open_start_menu_app', args: { name: candidate }, label: `Open ${installed.name}` };
      result.actions.push(action);
      result.context.lastTarget = contextForAction(action, projects);
      result.reply = `Opening ${installed.name}.`;
      return result;
    }

    // 5. A registered project folder.
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

  if (result.provider.configured) {
    const projectSummary = projects.length ? projects.map((project) => `${project.name}: ${Object.keys(project.commands || {}).join(', ') || 'no profiles'}`).join('; ') : 'none';
    const system = `You are BRO, a warm but concise local personal assistant for ${userName}. Registered projects: ${projectSummary}. You may discuss safe actions only: open http(s) URLs, open allowlisted Windows targets by name, list projects, open a registered project, or request a named profile run. Never invent shell commands or desktop paths; profile runs require explicit frontend approval. Do not claim to have taken an action unless the local app reports it completed. Casual greetings should receive a friendly greeting, not an action.`;
    const completion = await chatCompletion(settings, [{ role: 'system', content: system }, ...history.slice(-10), { role: 'user', content: text }]);
    if (completion.ok) { result.reply = completion.reply; return result; }
    result.reply = completion.reason === 'provider timed out'
      ? 'The configured AI provider took too long to answer. The local model may still be starting; please try again.'
      : 'I could not reach the configured AI provider. You can still use local commands such as “list projects” or “open project NAME”.';
    return result;
  }
  result.reply = 'I did not recognize that request. Try “help”, “list projects”, “open https://example.com”, or “run PROFILE in PROJECT”.';
  return result;
}

module.exports = { handleChat, projectByName, DEFAULT_USER_NAME, displayNameFor, isGreeting, stripGreetingPrefix, resolveSiteUrl, canonicalContextTarget, contextAction, siteLabel };
