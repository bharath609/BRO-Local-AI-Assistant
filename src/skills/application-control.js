'use strict';

// Application-control skill for BRO.
//
// This module turns the voice commands from the BRO Application Control Skills
// catalog into safe, concrete actions. It is intentionally data-driven: each
// rule is a small regex plus a function that returns one action (or a pending
// confirmation). Anything that touches the UI is executed by the server through
// Windows APIs (SendKeys, media keys, UI Automation) rather than guessed
// coordinates.
//
// Safety rules that are enforced here:
//  * system power, deleting a file, and emptying the Recycle Bin need a spoken
//    confirmation before an action is returned;
//  * typing, clicking, and key presses target the window BRO opened last, so
//    they never go to the BRO popup itself;
//  * screen sharing and sending messages are never started automatically.

const HOME = 'https://mail.google.com/mail/u/0/';
const GMAIL_VIEWS = {
  inbox: '#inbox', sent: '#sent', 'sent mail': '#sent', starred: '#starred',
  drafts: '#drafts', draft: '#drafts', snoozed: '#snoozed', spam: '#spam',
  trash: '#trash', bin: '#trash',
};
const OUTLOOK_VIEWS = {
  inbox: 'https://outlook.live.com/mail/0/inbox',
  sent: 'https://outlook.live.com/mail/0/sentitems',
  'sent items': 'https://outlook.live.com/mail/0/sentitems',
  drafts: 'https://outlook.live.com/mail/0/drafts',
  archive: 'https://outlook.live.com/mail/0/archive',
  deleted: 'https://outlook.live.com/mail/0/deleteditems',
  'deleted items': 'https://outlook.live.com/mail/0/deleteditems',
};
const SETTINGS_VIEWS = {
  'wi-fi': 'ms-settings:network-wifi', wifi: 'ms-settings:network-wifi',
  bluetooth: 'ms-settings:bluetooth', display: 'ms-settings:display',
  sound: 'ms-settings:sound', audio: 'ms-settings:sound',
  privacy: 'ms-settings:privacy', power: 'ms-settings:powersleep',
  'do not disturb': 'ms-settings:quiethours', focus: 'ms-settings:quiethours',
  'focus assist': 'ms-settings:quiethours', network: 'ms-settings:network',
  'default apps': 'ms-settings:defaultapps', apps: 'ms-settings:appsfeatures',
  updates: 'ms-settings:windowsupdate', 'windows update': 'ms-settings:windowsupdate',
  accounts: 'ms-settings:yourinfo', 'date and time': 'ms-settings:dateandtime',
  time: 'ms-settings:dateandtime', language: 'ms-settings:regionlanguage',
  taskbar: 'ms-settings:taskbar', mouse: 'ms-settings:mousetouchpad',
  printers: 'ms-settings:printers', storage: 'ms-settings:storagesense',
  multitasking: 'ms-settings:multitasking', about: 'ms-settings:about',
  clipboard: 'ms-settings:clipboard',
};

function norm(text) {
  // Wake words and courtesies are stripped only at the edges of the sentence,
  // so a spoken value such as “BRO Test Folder” keeps its words.
  let out = String(text || '')
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  for (let guard = 0; guard < 3; guard += 1) {
    const next = out
      .replace(/^(?:(?:hey|hi|okay|ok)\s+)?(?:there\s+)?(?:bro|bros|broh|brah)[,\s]+/i, '')
      .replace(/^(?:please|for\s+me)[,\s]+/i, '')
      .replace(/[,\s]+(?:please|bro|bros|for\s+me)$/i, '')
      .trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

function siteName(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    const known = {
      'youtube.com': 'YouTube', 'm.youtube.com': 'YouTube', 'mail.google.com': 'Gmail',
      'google.com': 'Google', 'github.com': 'GitHub', 'chatgpt.com': 'ChatGPT',
      'linkedin.com': 'LinkedIn', 'x.com': 'X', 'twitter.com': 'Twitter',
      'facebook.com': 'Facebook', 'instagram.com': 'Instagram', 'amazon.com': 'Amazon',
      'netflix.com': 'Netflix', 'spotify.com': 'Spotify', 'web.whatsapp.com': 'WhatsApp',
      'reddit.com': 'Reddit', 'drive.google.com': 'Google Drive',
      'docs.google.com': 'Google Docs', 'sheets.google.com': 'Google Sheets',
      'calendar.google.com': 'Google Calendar', 'outlook.live.com': 'Outlook',
      'outlook.office.com': 'Outlook',
    };
    if (known[host]) return known[host];
    const parts = host.split('.');
    const base = parts.length > 1 ? parts[parts.length - 2] : host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return 'the page';
  }
}

function isSite(lastTarget, hostPart) {
  if (!lastTarget || lastTarget.kind !== 'site' || !lastTarget.url) return false;
  try { return new URL(lastTarget.url).hostname.toLowerCase().includes(hostPart); } catch { return false; }
}

function targetOf(lastTarget) {
  if (!lastTarget) return null;
  if (lastTarget.kind === 'site') return { kind: 'site', url: lastTarget.url, label: siteName(lastTarget.url) };
  if (lastTarget.kind === 'file') return { kind: 'file', label: lastTarget.label || lastTarget.path, path: lastTarget.path };
  return { kind: lastTarget.kind || 'app', label: lastTarget.label || lastTarget.id || '' };
}

function urlResult(url, reply, lastTarget) {
  return {
    action: { id: 'open_url', type: 'open_url', args: { url }, label: reply },
    reply,
    lastTarget: { kind: 'site', url },
  };
}

function keyAction(sequence, reply, lastTarget, options = {}) {
  const target = targetOf(lastTarget);
  if (!target && options.focus !== false) {
    return { reply: 'Open the app or page first, then ask me to use its controls.' };
  }
  return {
    action: {
      id: 'send_keys',
      type: 'send_keys',
      args: { keys: sequence, target: options.focus === false ? null : target, delayMs: options.delayMs || 0 },
      label: reply,
    },
    reply,
    mediaState: options.mediaState,
  };
}

function mediaAction(key, reply, mediaState) {
  return {
    action: { id: 'media_key', type: 'media_key', args: { key }, label: reply },
    reply,
    mediaState,
  };
}

function scrollAction(direction, amount, reply, lastTarget) {
  const target = targetOf(lastTarget);
  return {
    action: {
      id: 'scroll',
      type: 'scroll',
      args: { direction, amount, ...(target ? { target } : {}) },
      label: reply,
    },
    reply,
  };
}

function sequenceAction(steps, reply, lastTarget) {
  const target = targetOf(lastTarget);
  return {
    action: { id: 'sequence', type: 'sequence', args: { steps, target }, label: reply },
    reply,
  };
}

function clickResult(reply, lastTarget, options = {}) {
  const target = targetOf(lastTarget);
  if (!target) return { reply: 'Open the page first, then ask me to open the first result.' };
  const type = options.first ? 'click_first_result' : 'click_element';
  return {
    action: {
      id: type,
      type,
      args: options.first ? { target, unread: Boolean(options.unread) } : { name: options.name, button: options.button || 'left', double: Boolean(options.double), target },
      label: reply,
    },
    reply,
  };
}

function folderKeyField(lastTarget) {
  if (!lastTarget || lastTarget.kind !== 'desktop') return '';
  const map = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', pictures: 'Pictures' };
  return map[lastTarget.key] || '';
}

const FOLDER_LOCATIONS = { downloads: 'Downloads', documents: 'Documents', desktop: 'Desktop', pictures: 'Pictures' };

// Windows-key shortcuts (Start menu, Task View, Run, clipboard, emoji, …).
function windowsKeyResult(keys, reply) {
  return {
    action: { id: 'windows_key', type: 'windows_key', args: { keys }, label: reply },
    reply,
  };
}

// Classic Control Panel applets and Windows tools that live outside Settings.
const LOCAL_PANELS = {
  'control panel': 'control_panel',
  'device manager': 'device_manager',
  'programs and features': 'programs_and_features',
  'add or remove programs': 'programs_and_features',
  'uninstall programs': 'programs_and_features',
  'network connections': 'network_connections',
  'network adapters': 'network_connections',
  'power options': 'power_options',
  'sound settings': 'sound_settings',
  'mouse settings': 'mouse_settings',
  'date and time': 'date_time',
  'region': 'region',
  'region and language': 'region',
  'internet options': 'internet_options',
  'system information': 'system_information',
  'event viewer': 'event_viewer',
  'disk management': 'disk_management',
  'services': 'services',
  'printers': 'printers',
  'devices and printers': 'printers',
  'task manager': 'task_manager',
};

function pendingResult(type, args, prompt, label) {
  return {
    reply: prompt,
    pending: { action: { id: type, type, args, label: label || prompt }, prompt },
  };
}

// ---- Rules ----------------------------------------------------------------
// Each rule is tried in order. Returning null lets the next rule (or the normal
// chat parser) handle the sentence.

const RULES = [
  // System power and safety ------------------------------------------------
  {
    id: 'shutdown',
    re: /^(?:shut\s*down|power\s+off|turn\s+off)\s+(?:the\s+|my\s+)?(?:pc|computer|laptop|system|windows)(?:\s+now)?$/,
    run: () => pendingResult('system_power', { mode: 'shutdown' }, 'Shut down the PC now? Say “yes” to confirm or “cancel”.', 'Shut down the PC'),
  },
  {
    id: 'restart',
    re: /^(?:restart|reboot)\s+(?:the\s+|my\s+)?(?:pc|computer|laptop|system|windows)(?:\s+now)?$/,
    run: () => pendingResult('system_power', { mode: 'restart' }, 'Restart the PC now? Say “yes” to confirm or “cancel”.', 'Restart the PC'),
  },
  {
    id: 'lock',
    re: /^(?:lock)\s+(?:the\s+|my\s+)?(?:pc|computer|laptop|system|windows|session)$/,
    run: () => ({
      action: { id: 'lock_pc', type: 'lock_pc', args: {}, label: 'Lock the PC' },
      reply: 'Locking the PC.',
    }),
  },
  {
    id: 'empty-recycle-bin',
    re: /^(?:empty|clear)\s+(?:the\s+)?recycle\s*bin$/,
    run: () => pendingResult('empty_recycle_bin', {}, 'Empty the Recycle Bin? This cannot be undone. Say “yes” to confirm.', 'Empty the Recycle Bin'),
  },
  {
    id: 'delete-file',
    re: /^(?:delete|remove|trash)\s+(?:this\s+file|the\s+open\s+file|this\s+document)$/,
    run: (_m, ctx) => {
      if (!ctx.lastTarget || ctx.lastTarget.kind !== 'file' || !ctx.lastTarget.path) {
        return { reply: 'Open the file first, then say “delete this file” so I know exactly which one.' };
      }
      const label = ctx.lastTarget.label || ctx.lastTarget.path;
      return pendingResult('recycle_file', { path: ctx.lastTarget.path }, `Move “${label}” to the Recycle Bin? Say “yes” to confirm.`, `Delete ${label}`);
    },
  },

  // Settings ---------------------------------------------------------------
  {
    id: 'settings-page',
    re: /^(?:open|show|go\s+to)\s+(?:the\s+)?(wi-fi|wifi|bluetooth|display|sound|audio|privacy|power|do\s+not\s+disturb|focus(?:\s+assist)?|network|default\s+apps|apps|updates|windows\s+update|accounts|date\s+and\s+time|time|language|taskbar|mouse|printers|storage|multitasking|about|clipboard)\s+(?:settings|page)$/,
    run: (m) => {
      const key = m[1].toLowerCase().replace(/\s+/g, ' ');
      const uri = SETTINGS_VIEWS[key] || 'ms-settings:';
      return {
        action: { id: 'open_settings', type: 'open_settings', args: { uri }, label: `Open ${key} settings` },
        reply: `Opening ${m[1]} settings.`,
      };
    },
  },

  // Screenshots and desktop -------------------------------------------------
  {
    id: 'screenshot',
    re: /^(?:take|capture|grab|save)\s+(?:a\s+|the\s+)?(?:screenshot|screen\s*shot)(?:\s+now)?$/,
    run: () => ({
      action: { id: 'screenshot', type: 'screenshot', args: {}, label: 'Take a screenshot' },
      reply: 'Taking a screenshot.',
    }),
  },
  {
    id: 'show-desktop',
    re: /^(?:show|go\s+to|minimize\s+everything|hide\s+everything|clear)\s+(?:the\s+|my\s+)?desktop$/,
    run: () => ({
      action: { id: 'show_desktop', type: 'show_desktop', args: {}, label: 'Show the desktop' },
      reply: 'Showing the desktop.',
    }),
  },

  // Local PC controls -------------------------------------------------------
  // Start menu, Task View, Run, clipboard, and the classic Windows tools.
  {
    id: 'start-menu',
    re: /^(?:open|show|bring\s+up|press)\s+(?:the\s+)?start\s+menu$|^start\s+menu$/,
    run: () => windowsKeyResult('', 'Opening the Start menu.'),
  },
  {
    id: 'task-view',
    re: /^(?:open|show)\s+(?:the\s+)?task\s+view$|^task\s+view$/,
    run: () => windowsKeyResult('tab', 'Opening Task View.'),
  },
  {
    id: 'quick-settings',
    re: /^(?:open|show)\s+(?:the\s+)?(?:quick\s+settings|action\s+center)$|^quick\s+settings$/,
    run: () => windowsKeyResult('a', 'Opening quick settings.'),
  },
  {
    id: 'notifications',
    re: /^(?:open|show)\s+(?:the\s+)?(?:notifications?|notification\s+(?:center|panel))$/,
    run: () => windowsKeyResult('n', 'Opening notifications.'),
  },
  {
    id: 'windows-search',
    re: /^(?:open|show)\s+(?:the\s+)?(?:windows\s+search|search\s+box|search\s+menu)$/,
    run: () => windowsKeyResult('s', 'Opening Windows search.'),
  },
  {
    id: 'run-dialog',
    re: /^(?:open|show)\s+(?:the\s+)?run(?:\s+(?:dialog|box|window))?$|^run\s+dialog$/,
    run: () => windowsKeyResult('r', 'Opening the Run dialog.'),
  },
  {
    id: 'emoji-picker',
    re: /^(?:open|show)\s+(?:the\s+)?emoji(?:\s+(?:picker|panel|keyboard))?$/,
    run: () => windowsKeyResult('.', 'Opening the emoji picker.'),
  },
  {
    id: 'clipboard-history',
    re: /^(?:open|show)\s+(?:the\s+)?clipboard(?:\s+history)?$/,
    run: () => windowsKeyResult('v', 'Opening clipboard history.'),
  },
  {
    id: 'switch-window',
    re: /^(?:switch|next)\s+(?:to\s+)?(?:the\s+)?(?:next\s+)?(?:window|app|application)$/,
    run: (_m, ctx) => keyAction('%{TAB}', 'Switching windows.', ctx.lastTarget, { focus: false }),
  },
  {
    id: 'control-panel-pages',
    re: /^(?:open|show|go\s+to)\s+(?:the\s+)?(control\s+panel|device\s+manager|programs\s+and\s+features|add\s+or\s+remove\s+programs|uninstall\s+programs|network\s+connections|network\s+adapters|power\s+options|sound\s+settings|mouse\s+settings|date\s+and\s+time|region(?:\s+and\s+language)?|internet\s+options|system\s+information|event\s+viewer|disk\s+management|services|printers|devices\s+and\s+printers|task\s+manager)$/,
    run: (m) => {
      const spoken = m[1].toLowerCase().replace(/\s+/g, ' ');
      const target = LOCAL_PANELS[spoken];
      return {
        action: { id: 'open_desktop_target', type: 'open_desktop_target', args: { target }, label: `Open ${m[1]}` },
        reply: `Opening ${m[1]}.`,
        lastTarget: { kind: 'desktop', key: target, label: m[1] },
      };
    },
  },
  {
    id: 'refresh-desktop',
    re: /^(?:refresh|reload)\s+(?:the\s+)?desktop$/,
    run: () => ({
      action: { id: 'refresh_desktop', type: 'refresh_desktop', args: {}, label: 'Refresh the desktop' },
      reply: 'Refreshing the desktop.',
    }),
  },

  // Playback: play, pause, stop, seek, mute, volume, fullscreen, captions ---
  {
    id: 'playback-play',
    re: /^(?:play|resume|continue|unpause)(?:\s+(?:the\s+)?(?:video|song|music|media|playback|movie))?$/,
    run: (_m, ctx) => playbackResult(ctx, 'play'),
  },
  {
    id: 'playback-pause',
    re: /^(?:pause|hold)(?:\s+(?:the\s+)?(?:video|song|music|media|playback|movie))?$/,
    run: (_m, ctx) => playbackResult(ctx, 'pause'),
  },
  {
    id: 'playback-stop',
    re: /^(?:stop|stop\s+playing|stop\s+(?:the\s+)?(?:video|song|music|media|playback|movie))$/,
    run: (_m, ctx) => playbackResult(ctx, 'stop'),
  },
  {
    id: 'playback-next-video',
    re: /^(?:play|start)\s+(?:the\s+)?next\s+(?:video|one|track|song|item)$/,
    run: (_m, ctx) => nextItemResult(ctx, 'next'),
  },
  {
    id: 'playback-previous-video',
    re: /^(?:play|start)\s+(?:the\s+)?(?:previous|last)\s+(?:video|one|track|song|item)$/,
    run: (_m, ctx) => nextItemResult(ctx, 'previous'),
  },
  {
    id: 'playback-next',
    re: /^(?:next|skip)\s+(?:video|track|song|item)$/,
    run: (_m, ctx) => nextItemResult(ctx, 'next'),
  },
  {
    id: 'playback-previous',
    re: /^(?:previous|last|go\s+back\s+one)\s+(?:video|track|song|item)$/,
    run: (_m, ctx) => nextItemResult(ctx, 'previous'),
  },
  {
    id: 'playback-seek-forward',
    re: /^(?:skip|seek|jump|go)\s+(?:forward|ahead)(?:\s+(\d{1,3})\s*(?:seconds?|secs?|s))?$/,
    run: (m, ctx) => seekResult(ctx, m[1] ? Number(m[1]) : 10, 'forward'),
  },
  {
    id: 'playback-seek-back',
    re: /^(?:skip|seek|jump|go)\s+(?:back|backward|backwards|behind)(?:\s+(\d{1,3})\s*(?:seconds?|secs?|s))?$/,
    run: (m, ctx) => seekResult(ctx, m[1] ? Number(m[1]) : 10, 'back'),
  },
  {
    id: 'playback-forward-10',
    re: /^(?:go\s+)?(?:forward|ahead)(?:\s+(\d{1,3})\s*(?:seconds?|secs?|s))?$/,
    run: (m, ctx) => {
      // "forward" means browser navigation unless a video is playing.
      const media = isYouTube(ctx.lastTarget) || Boolean(ctx.mediaState);
      if (!media && !m[1]) return null;
      return seekResult(ctx, m[1] ? Number(m[1]) : 10, 'forward');
    },
  },
  {
    id: 'playback-backward-10',
    re: /^(?:go\s+)?(?:backward|backwards|rewind)(?:\s+(\d{1,3})\s*(?:seconds?|secs?|s))?$/,
    run: (m, ctx) => seekResult(ctx, m[1] ? Number(m[1]) : 10, 'back'),
  },
  {
    id: 'volume-up',
    re: /^(?:volume\s+up|turn\s+(?:the\s+)?volume\s+up|louder|increase\s+(?:the\s+)?volume)$/,
    run: () => mediaAction('volume_up', 'Turning the volume up.', undefined),
  },
  {
    id: 'volume-down',
    re: /^(?:volume\s+down|turn\s+(?:the\s+)?volume\s+down|quieter|decrease\s+(?:the\s+)?volume|lower\s+(?:the\s+)?volume)$/,
    run: () => mediaAction('volume_down', 'Turning the volume down.', undefined),
  },
  {
    id: 'mute',
    re: /^(?:mute|mute\s+(?:the\s+)?(?:video|audio|sound|volume)|silence)$/,
    run: () => mediaAction('mute', 'Muting the audio.', undefined),
  },
  {
    id: 'unmute',
    re: /^(?:unmute|un-mute|restore\s+(?:the\s+)?sound)$/,
    run: () => mediaAction('mute', 'Unmuting the audio.', undefined),
  },
  {
    id: 'fullscreen',
    re: /^(?:enter|go|switch\s+to|toggle)\s+(?:full\s*screen|fullscreen)$/,
    run: (_m, ctx) => (isSite(ctx.lastTarget, 'youtube.com')
      ? keyAction('f', 'Entering full screen.', ctx.lastTarget)
      : keyAction('{F11}', 'Entering full screen.', ctx.lastTarget)),
  },
  {
    id: 'exit-fullscreen',
    re: /^(?:exit|leave|stop)\s+(?:full\s*screen|fullscreen)$/,
    run: (_m, ctx) => (isSite(ctx.lastTarget, 'youtube.com')
      ? keyAction('{ESC}', 'Leaving full screen.', ctx.lastTarget)
      : keyAction('{F11}', 'Leaving full screen.', ctx.lastTarget)),
  },
  {
    id: 'captions-on',
    re: /^(?:turn\s+)?(?:captions?|subtitles?)\s+on$|^enable\s+(?:captions?|subtitles?)$/,
    run: (_m, ctx) => keyAction('c', 'Turning captions on.', ctx.lastTarget),
  },
  {
    id: 'captions-off',
    re: /^(?:turn\s+)?(?:captions?|subtitles?)\s+off$|^disable\s+(?:captions?|subtitles?)$/,
    run: (_m, ctx) => keyAction('c', 'Turning captions off.', ctx.lastTarget),
  },
  {
    id: 'captions-toggle',
    re: /^(?:toggle|show)\s+(?:captions?|subtitles?)$/,
    run: (_m, ctx) => keyAction('c', 'Toggling captions.', ctx.lastTarget),
  },

  // YouTube sections and first result --------------------------------------
  {
    id: 'youtube-subscriptions',
    re: /^(?:open|show|go\s+to)\s+(?:my\s+)?(?:youtube\s+)?subscriptions$/,
    run: () => urlResult('https://www.youtube.com/feed/subscriptions', 'Opening your YouTube subscriptions.'),
  },
  {
    id: 'youtube-library',
    re: /^(?:open|show|go\s+to)\s+(?:my\s+)?(?:youtube\s+)?(?:library|watch\s+later|liked\s+videos)$/,
    run: () => urlResult('https://www.youtube.com/feed/library', 'Opening your YouTube library.'),
  },
  {
    id: 'youtube-first-video',
    re: /^(?:play|open|start)\s+(?:the\s+)?first\s+(?:video|result)$/,
    run: (_m, ctx) => clickResult('Opening the first video on the page.', ctx.lastTarget, { first: true }),
  },

  // Gmail ------------------------------------------------------------------
  {
    id: 'gmail-view',
    re: /^(?:open|show|go\s+to|switch\s+to)\s+(?:my\s+)?(?:gmail\s+)?(inbox|sent(?: mail)?|starred|drafts?|snoozed|spam|trash|bin)$/,
    run: (m) => urlResult(`${HOME}${GMAIL_VIEWS[m[1].toLowerCase()] || '#inbox'}`, `Opening ${m[1]} in Gmail.`),
  },
  {
    id: 'gmail-search',
    re: /^search\s+(?:my\s+)?gmail\s+for\s+(.+)$/,
    run: (m) => urlResult(`${HOME}#search/${encodeURIComponent(m[1])}`, `Searching Gmail for “${m[1]}”.`),
  },
  {
    id: 'gmail-from',
    re: /^find\s+(?:emails?|messages?)\s+from\s+(.+)$/,
    run: (m) => urlResult(`${HOME}#search/from%3A${encodeURIComponent(m[1])}`, `Finding Gmail messages from ${m[1]}.`),
  },
  {
    id: 'gmail-subject',
    re: /^find\s+(?:emails?|messages?)\s+(?:with\s+)?subject\s+(.+)$/,
    run: (m) => urlResult(`${HOME}#search/subject%3A${encodeURIComponent(m[1])}`, `Finding Gmail messages with subject “${m[1]}”.`),
  },
  {
    id: 'gmail-first-email',
    re: /^(?:open|read)\s+(?:the\s+)?(?:first|top|newest|latest)\s+(?:email|message|conversation)$/,
    run: (_m, ctx) => clickResult('Opening the first email.', ctx.lastTarget, { first: true }),
  },
  {
    id: 'gmail-first-unread',
    re: /^(?:open|read)\s+(?:the\s+)?first\s+unread\s+(?:email|message|conversation)$/,
    run: (_m, ctx) => clickResult('Opening the first unread email.', ctx.lastTarget, { first: true, unread: true }),
  },
  {
    id: 'gmail-next-email',
    re: /^(?:open|show|go\s+to)\s+(?:the\s+)?next\s+(?:email|message|conversation)$/,
    run: (_m, ctx) => keyAction('j', 'Opening the next email. (Gmail keyboard shortcuts must be on.)', ctx.lastTarget),
  },
  {
    id: 'gmail-previous-email',
    re: /^(?:open|show|go\s+to)\s+(?:the\s+)?previous\s+(?:email|message|conversation)$/,
    run: (_m, ctx) => keyAction('k', 'Opening the previous email. (Gmail keyboard shortcuts must be on.)', ctx.lastTarget),
  },
  {
    id: 'gmail-reply',
    re: /^reply\s+(?:to\s+)?(?:this|the)\s+(?:email|message)$/,
    run: (_m, ctx) => keyAction('r', 'Opened Reply in Gmail. Review the draft before sending.', ctx.lastTarget),
  },
  {
    id: 'gmail-forward',
    re: /^forward\s+(?:this|the)\s+(?:email|message)$/,
    run: (_m, ctx) => keyAction('f', 'Opened Forward in Gmail. Review the recipients before sending.', ctx.lastTarget),
  },
  {
    id: 'gmail-archive',
    re: /^archive\s+(?:this|the)\s+(?:email|message)$/,
    run: (_m, ctx) => keyAction('e', 'Archiving the open email.', ctx.lastTarget),
  },
  {
    id: 'gmail-mark-unread',
    re: /^mark\s+(?:this|the)\s+(?:email|message)\s+(?:as\s+)?unread$/,
    run: (_m, ctx) => keyAction('+u', 'Marking the email unread.', ctx.lastTarget),
  },
  {
    id: 'gmail-star',
    re: /^star\s+(?:this|the)\s+(?:email|message)$/,
    run: (_m, ctx) => keyAction('s', 'Starring the open email.', ctx.lastTarget),
  },
  {
    id: 'gmail-back-list',
    re: /^go\s+back\s+to\s+(?:the\s+)?(?:email\s+list|inbox|results)$/,
    run: (_m, ctx) => keyAction('u', 'Going back to the email list.', ctx.lastTarget),
  },

  // Outlook ----------------------------------------------------------------
  {
    id: 'outlook-view',
    re: /^(?:open|show|go\s+to|switch\s+to)\s+(?:my\s+)?(?:outlook\s+)?(inbox|sent(?: items)?|drafts|archive|deleted(?: items)?)$/,
    run: (m) => urlResult(OUTLOOK_VIEWS[m[1].toLowerCase()] || OUTLOOK_VIEWS.inbox, `Opening ${m[1]} in Outlook.`),
  },
  {
    id: 'outlook-search',
    re: /^search\s+(?:my\s+)?outlook\s+for\s+(.+)$/,
    run: (m) => urlResult(`https://outlook.live.com/mail/0/search?q=${encodeURIComponent(m[1])}`, `Searching Outlook for “${m[1]}”.`),
  },
  {
    id: 'outlook-first-email',
    re: /^(?:open|read)\s+(?:the\s+)?(?:first|top|newest|latest)\s+(?:outlook\s+)?(?:email|message)$/,
    run: (_m, ctx) => clickResult('Opening the first Outlook email.', ctx.lastTarget, { first: true }),
  },

  // LinkedIn ---------------------------------------------------------------
  {
    id: 'linkedin-feed',
    re: /^(?:open|show|go\s+to)\s+(?:my\s+)?(?:linkedin\s+)?(?:feed|home)$/,
    run: () => urlResult('https://www.linkedin.com/feed/', 'Opening your LinkedIn feed.'),
  },
  {
    id: 'linkedin-profile',
    re: /^(?:open|show)\s+(?:my\s+)?linkedin\s+profile$|^open\s+my\s+profile$/,
    run: () => urlResult('https://www.linkedin.com/in/me/', 'Opening your LinkedIn profile.'),
  },
  {
    id: 'linkedin-search',
    re: /^search\s+linkedin\s+for\s+(.+)$/,
    run: (m) => urlResult(`https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(m[1])}`, `Searching LinkedIn for “${m[1]}”.`),
  },
  {
    id: 'linkedin-jobs',
    re: /^find\s+jobs?\s+(?:for|as)\s+(.+)$/,
    run: (m) => urlResult(`https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(m[1])}`, `Searching LinkedIn jobs for “${m[1]}”.`),
  },
  {
    id: 'linkedin-applications',
    re: /^(?:open|show)\s+(?:my\s+)?(?:linkedin\s+)?job\s+applications$/,
    run: () => urlResult('https://www.linkedin.com/my-items/saved-jobs/', 'Opening your LinkedIn saved jobs and applications.'),
  },
  {
    id: 'linkedin-notifications',
    re: /^(?:open|show)\s+(?:my\s+)?linkedin\s+notifications$/,
    run: () => urlResult('https://www.linkedin.com/notifications/', 'Opening LinkedIn notifications.'),
  },
  {
    id: 'linkedin-messages',
    re: /^(?:open|show)\s+(?:my\s+)?linkedin\s+(?:messages|messaging)$/,
    run: () => urlResult('https://www.linkedin.com/messaging/', 'Opening LinkedIn messages.'),
  },
  {
    id: 'linkedin-connect',
    re: /^connect\s+with\s+(.+)$/,
    run: (m) => urlResult(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(m[1])}`, `Opening LinkedIn results for ${m[1]}. I will not send a request without your approval.`),
  },
  {
    id: 'linkedin-apply',
    re: /^apply\s+to\s+this\s+job$/,
    run: () => ({ reply: 'Open the job and review the application. I will not submit an application without an explicit confirmation.' }),
  },

  // WhatsApp Web -----------------------------------------------------------
  {
    id: 'whatsapp-open',
    re: /^(?:open|show|go\s+to)\s+(?:whatsapp(?:\s+web)?|whats\s+app(?:\s+web)?)$/,
    run: () => urlResult('https://web.whatsapp.com/', 'Opening WhatsApp Web.'),
  },
  {
    id: 'whatsapp-search',
    re: /^search\s+(?:my\s+)?(?:whatsapp\s+)?chats?\s+for\s+(.+)$/,
    run: (m, ctx) => sequenceAction([
      { focus: targetOf(ctx.lastTarget) },
      { keys: '^%/' },
      { wait: 450 },
      { type: m[1] },
    ], `Searching WhatsApp chats for “${m[1]}”.`, ctx.lastTarget),
  },
  {
    id: 'whatsapp-open-chat',
    re: /^(?:open|show)\s+(?:the\s+)?chat\s+with\s+(.+)$/,
    run: (m, ctx) => sequenceAction([
      { focus: targetOf(ctx.lastTarget) },
      { keys: '^%/' },
      { wait: 450 },
      { type: m[1] },
      { wait: 900 },
      { first: true },
    ], `Opening the chat with ${m[1]}. I will not send anything without your confirmation.`, ctx.lastTarget),
  },
  {
    id: 'whatsapp-latest',
    re: /^(?:go\s+to|show)\s+(?:the\s+)?(?:latest|last|newest)\s+(?:whatsapp\s+)?messages?$/,
    run: (_m, ctx) => keyAction('^{END}', 'Jumping to the latest messages.', ctx.lastTarget),
  },
  {
    id: 'whatsapp-send',
    re: /^send\s+(.+?)\s+to\s+(.+)$/,
    run: () => ({ reply: 'I will not send a message automatically. I can open the chat so you can review the exact text and send it yourself.' }),
  },
  {
    id: 'whatsapp-mute',
    re: /^mute\s+this\s+chat$/,
    run: () => ({ reply: 'Open the chat options and choose Mute. I will not change notification settings without confirming the chat.' }),
  },

  // Google Drive / Docs / Sheets / Calendar --------------------------------
  {
    id: 'drive-view',
    re: /^(?:open|show|go\s+to)\s+(?:my\s+)?google\s+drive(?:\s+(my\s+drive|recent|starred|trash|shared(?:\s+with\s+me)?))?$/,
    run: (m) => {
      const view = (m[1] || '').toLowerCase().replace(/\s+/g, '-');
      const urls = {
        'my-drive': 'https://drive.google.com/drive/my-drive',
        recent: 'https://drive.google.com/drive/recent',
        starred: 'https://drive.google.com/drive/starred',
        trash: 'https://drive.google.com/drive/trash',
        shared: 'https://drive.google.com/drive/shared-with-me',
        'shared-with-me': 'https://drive.google.com/drive/shared-with-me',
      };
      return urlResult(urls[view] || 'https://drive.google.com/', 'Opening Google Drive.');
    },
  },
  {
    id: 'drive-search',
    re: /^search\s+(?:google\s+)?drive\s+for\s+(.+)$/,
    run: (m) => urlResult(`https://drive.google.com/drive/search?q=${encodeURIComponent(m[1])}`, `Searching Google Drive for “${m[1]}”.`),
  },
  {
    id: 'drive-first-result',
    re: /^(?:open|show)\s+(?:the\s+)?first\s+(?:drive\s+)?result$/,
    run: (_m, ctx) => clickResult('Opening the first Google Drive result.', ctx.lastTarget, { first: true }),
  },
  {
    id: 'docs-new',
    re: /^(?:create|make|start)\s+(?:a\s+)?(?:new\s+)?(?:google\s+)?(?:doc|document)$/,
    run: () => urlResult('https://docs.new', 'Creating a new Google Doc.'),
  },
  {
    id: 'docs-recent',
    re: /^(?:open|show)\s+(?:my\s+)?(?:recent\s+)?google\s+docs?$/,
    run: () => urlResult('https://docs.google.com/document/u/0/', 'Opening your Google Docs.'),
  },
  {
    id: 'sheets-new',
    re: /^(?:create|make|start)\s+(?:a\s+)?(?:new\s+)?(?:google\s+)?(?:sheet|spreadsheet)$/,
    run: () => urlResult('https://sheets.new', 'Creating a new Google Sheet.'),
  },
  {
    id: 'calendar-today',
    re: /^(?:open|show)\s+(?:google\s+)?calendar$/,
    run: () => urlResult('https://calendar.google.com/', 'Opening Google Calendar.'),
  },
  {
    id: 'calendar-schedule',
    re: /^show\s+(?:me\s+)?today'?s?\s+(?:schedule|agenda)$/,
    run: () => urlResult('https://calendar.google.com/calendar/u/0/r/day', 'Opening today’s calendar.'),
  },
  {
    id: 'calendar-week',
    re: /^show\s+(?:me\s+)?(?:the\s+)?(?:next\s+week|this\s+week|week)$/,
    run: () => urlResult('https://calendar.google.com/calendar/u/0/r/week', 'Showing this week.'),
  },
  {
    id: 'calendar-tomorrow',
    re: /^show\s+(?:me\s+)?tomorrow(?:'?s?\s+schedule)?$/,
    run: () => ({ reply: 'Tomorrow is one day ahead in Google Calendar. Open the calendar and I can switch the view; creating events still needs the date and time.' }),
  },
  {
    id: 'calendar-create',
    re: /^(?:create|make|add|schedule)\s+(?:an?\s+)?(?:event|meeting)\s+(?:called|named|for|about)\s+(.+)$/,
    run: (m) => urlResult(`https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(m[1])}`, `Opening a new calendar event called “${m[1]}”. Add the date and time, then save.`),
  },
  {
    id: 'calendar-view',
    re: /^(?:switch\s+to|show|open)\s+(?:the\s+)?(day|week|month)\s+(?:view|calendar)$/,
    run: (m) => urlResult(`https://calendar.google.com/calendar/u/0/r/${m[1].toLowerCase()}`, `Switching to the ${m[1]} view.`),
  },

  // Word / Excel / PowerPoint / VS Code / PDF ------------------------------
  {
    id: 'office-save',
    re: /^save(?:\s+(?:the\s+)?(?:file|document|workbook|presentation))?$/,
    run: (_m, ctx) => keyAction('^s', 'Saving.', ctx.lastTarget),
  },
  {
    id: 'office-save-as',
    re: /^save\s+(?:it\s+)?as(?:\s+(.+))?$/,
    run: (_m, ctx) => keyAction('{F12}', 'Opening Save As.', ctx.lastTarget),
  },
  {
    id: 'office-print',
    re: /^print(?:\s+(?:this|the)\s+(?:document|file|page|pdf|presentation|workbook))?$/,
    run: (_m, ctx) => keyAction('^p', 'Opening the print dialog.', ctx.lastTarget),
  },
  {
    id: 'office-bold',
    re: /^(?:make\s+this\s+bold|bold(?:\s+this)?)$/,
    run: (_m, ctx) => keyAction('^b', 'Applying bold.', ctx.lastTarget),
  },
  {
    id: 'office-italic',
    re: /^(?:italicize\s+this|make\s+this\s+italic|italic(?:\s+this)?)$/,
    run: (_m, ctx) => keyAction('^i', 'Applying italics.', ctx.lastTarget),
  },
  {
    id: 'office-underline',
    re: /^(?:underline\s+this|make\s+this\s+underlined|underline(?:\s+this)?)$/,
    run: (_m, ctx) => keyAction('^u', 'Applying underline.', ctx.lastTarget),
  },
  {
    id: 'office-heading1',
    re: /^make\s+this\s+heading\s*(?:1|one)$/,
    run: (_m, ctx) => keyAction('^%1', 'Applying Heading 1.', ctx.lastTarget),
  },
  {
    id: 'office-find',
    re: /^find\s+(?:the\s+)?text\s+(.+)$/,
    run: (m, ctx) => sequenceAction([
      { focus: targetOf(ctx.lastTarget) },
      { keys: '^f' },
      { wait: 250 },
      { type: m[1] },
      { keys: '{ENTER}' },
    ], `Finding “${m[1]}”.`, ctx.lastTarget),
  },
  {
    id: 'office-replace',
    re: /^replace\s+(.+?)\s+with\s+(.+)$/,
    run: (m, ctx) => sequenceAction([
      { focus: targetOf(ctx.lastTarget) },
      { keys: '^h' },
      { wait: 300 },
      { type: m[1] },
      { keys: '{TAB}' },
      { type: m[2] },
    ], `Opening replace for “${m[1]}” → “${m[2]}”. Review before replacing all.`, ctx.lastTarget),
  },
  {
    id: 'powerpoint-add-slide',
    re: /^(?:add|insert)\s+(?:a\s+)?(?:new\s+)?slide$|^new\s+slide$/,
    run: (_m, ctx) => keyAction('^m', 'Adding a new slide.', ctx.lastTarget),
  },
  {
    id: 'powerpoint-next-slide',
    re: /^next\s+slide$/,
    run: (_m, ctx) => keyAction('{PGDN}', 'Moving to the next slide.', ctx.lastTarget),
  },
  {
    id: 'powerpoint-previous-slide',
    re: /^previous\s+slide$/,
    run: (_m, ctx) => keyAction('{PGUP}', 'Moving to the previous slide.', ctx.lastTarget),
  },
  {
    id: 'powerpoint-help',
    re: /^(?:start|begin|play)\s+(?:the\s+)?(?:slideshow|presentation)(?:\s+from\s+(?:the\s+)?(?:current|beginning|start|first\s+slide))?$/,
    run: (_m, ctx) => keyAction('{F5}', 'Starting the slideshow.', ctx.lastTarget),
  },
  {
    id: 'powerpoint-exit',
    re: /^(?:exit|end|stop)\s+(?:the\s+)?(?:slideshow|presentation)$/,
    run: (_m, ctx) => keyAction('{ESC}', 'Leaving the slideshow.', ctx.lastTarget),
  },
  {
    id: 'vscode-terminal',
    re: /^(?:open|show|toggle)\s+(?:the\s+)?(?:integrated\s+|vs\s*code\s+)?terminal$/,
    run: (_m, ctx) => keyAction('^`', 'Toggling the integrated terminal.', ctx.lastTarget),
  },
  {
    id: 'vscode-search',
    re: /^(?:search|find)\s+(?:the\s+)?(?:project|workspace|folder)\s+for\s+(.+)$/,
    run: (m, ctx) => sequenceAction([
      { focus: targetOf(ctx.lastTarget) },
      { keys: '^+f' },
      { wait: 300 },
      { type: m[1] },
    ], `Searching the project for “${m[1]}”.`, ctx.lastTarget),
  },
  {
    id: 'vscode-source-control',
    re: /^(?:open|show)\s+(?:the\s+)?source\s+control$/,
    run: (_m, ctx) => keyAction('^+g', 'Opening Source Control.', ctx.lastTarget),
  },
  {
    id: 'vscode-problems',
    re: /^(?:open|show)\s+(?:the\s+)?problems$/,
    run: (_m, ctx) => keyAction('^+m', 'Opening the Problems panel.', ctx.lastTarget),
  },
  {
    id: 'vscode-split',
    re: /^split\s+(?:the\s+)?editor$/,
    run: (_m, ctx) => keyAction('^\\', 'Splitting the editor.', ctx.lastTarget),
  },
  {
    id: 'pdf-next-page',
    re: /^(?:next|go\s+to\s+the\s+next)\s+page$/,
    run: (_m, ctx) => keyAction('{PGDN}', 'Going to the next page.', ctx.lastTarget),
  },
  {
    id: 'pdf-previous-page',
    re: /^(?:previous|go\s+to\s+the\s+previous|last)\s+page$/,
    run: (_m, ctx) => keyAction('{PGUP}', 'Going to the previous page.', ctx.lastTarget),
  },
  {
    id: 'pdf-save-copy',
    re: /^save\s+(?:a\s+)?copy$/,
    run: (_m, ctx) => keyAction('^+s', 'Opening Save a Copy.', ctx.lastTarget),
  },
  {
    id: 'pdf-zoom-in',
    re: /^zoom\s+in$/,
    run: (_m, ctx) => keyAction('^=', 'Zooming in.', ctx.lastTarget),
  },
  {
    id: 'pdf-zoom-out',
    re: /^zoom\s+out$/,
    run: (_m, ctx) => keyAction('^-', 'Zooming out.', ctx.lastTarget),
  },
  {
    id: 'pdf-fit',
    re: /^fit\s+(?:to\s+)?page$/,
    run: (_m, ctx) => keyAction('^0', 'Fitting the page to the window.', ctx.lastTarget),
  },

  // File Explorer ----------------------------------------------------------
  {
    id: 'folder-new',
    re: /^(?:create|make|add)\s+(?:a\s+)?new\s+folder$|^new\s+folder$/,
    run: (_m, ctx) => {
      const folder = folderKeyField(ctx.lastTarget);
      return {
        action: {
          id: 'create_folder',
          type: 'create_folder',
          args: { name: 'New folder', folder },
          label: 'Create a new folder',
        },
        reply: `Creating a new folder${folder ? ` in ${folder}` : ' on the Desktop'}.`,
      };
    },
  },
  {
    id: 'folder-create',
    re: /^(?:create|make|add|new)\s+(?:a\s+)?(?:new\s+)?folder(?:\s+(?:named|called))?\s+(.+?)(?:\s+(?:in|inside|on)\s+(?:my\s+|the\s+)?(downloads|documents|desktop|pictures))?$/,
    run: (m, ctx) => {
      const name = m[1].trim();
      const folder = m[2] ? FOLDER_LOCATIONS[m[2].toLowerCase()] : folderKeyField(ctx.lastTarget);
      return {
        action: {
          id: 'create_folder',
          type: 'create_folder',
          args: { name, folder },
          label: `Create folder ${name}`,
        },
        reply: `Creating a folder called “${name}”${folder ? ` in ${folder}` : ' on the Desktop'}.`,
      };
    },
  },
  {
    id: 'file-rename',
    re: /^rename\s+(?:this\s+file|the\s+open\s+file|this\s+document)\s+to\s+(.+)$/,
    run: (m, ctx) => {
      if (!ctx.lastTarget || ctx.lastTarget.kind !== 'file' || !ctx.lastTarget.path) {
        return { reply: 'Open the file first, then say “rename this file to …” so I rename the right one.' };
      }
      return {
        action: { id: 'rename_file', type: 'rename_file', args: { path: ctx.lastTarget.path, name: m[1] }, label: `Rename ${ctx.lastTarget.label}` },
        reply: `Renaming “${ctx.lastTarget.label}” to “${m[1]}”.`,
      };
    },
  },
  {
    id: 'file-properties',
    re: /^(?:show|open)\s+(?:the\s+)?(?:file\s+)?properties$/,
    run: (_m, ctx) => keyAction('%{ENTER}', 'Opening file properties.', ctx.lastTarget),
  },
  {
    id: 'file-copy',
    re: /^(?:copy|cut)\s+(?:the\s+)?(?:selected\s+)?file$/,
    run: (_m, ctx) => {
      const cut = _m[0].toLowerCase().startsWith('cut');
      return keyAction(cut ? '^x' : '^c', cut ? 'Cutting the selected file.' : 'Copying the selected file.', ctx.lastTarget);
    },
  },
  {
    id: 'file-paste',
    re: /^paste\s+(?:the\s+)?file$/,
    run: (_m, ctx) => keyAction('^v', 'Pasting the file.', ctx.lastTarget),
  },
  {
    id: 'explorer-search',
    re: /^search\s+(?:this\s+folder|the\s+current\s+folder|here)\s+for\s+(.+)$/,
    run: (m, ctx) => sequenceAction([
      { focus: targetOf(ctx.lastTarget) },
      { keys: '^f' },
      { wait: 250 },
      { type: m[1] },
      { keys: '{ENTER}' },
    ], `Searching this folder for “${m[1]}”.`, ctx.lastTarget),
  },

  // Browser tabs and navigation -------------------------------------------
  {
    id: 'new-tab',
    re: /^(?:open|create|make)\s+(?:a\s+)?new\s+tab$/,
    run: (_m, ctx) => keyAction('^t', 'Opening a new tab.', ctx.lastTarget),
  },
  {
    id: 'close-tab',
    re: /^close\s+(?:this|the\s+current|the\s+active)\s+tab$/,
    run: (_m, ctx) => keyAction('^w', 'Closing this tab.', ctx.lastTarget),
  },
  {
    id: 'next-tab',
    re: /^(?:switch\s+to\s+the\s+)?next\s+tab$/,
    run: (_m, ctx) => keyAction('^{TAB}', 'Switching to the next tab.', ctx.lastTarget),
  },
  {
    id: 'previous-tab',
    re: /^(?:switch\s+to\s+the\s+)?(?:previous|last)\s+tab$/,
    run: (_m, ctx) => keyAction('^+{TAB}', 'Switching to the previous tab.', ctx.lastTarget),
  },
  {
    id: 'reopen-tab',
    re: /^reopen\s+(?:the\s+)?(?:last\s+)?closed\s+tab$/,
    run: (_m, ctx) => keyAction('^+t', 'Reopening the last closed tab.', ctx.lastTarget),
  },
  {
    id: 'tab-number',
    re: /^(?:switch\s+to|go\s+to)\s+tab\s+(\d)$/,
    run: (m, ctx) => (Number(m[1]) >= 1 && Number(m[1]) <= 8
      ? keyAction(`^${m[1]}`, `Switching to tab ${m[1]}.`, ctx.lastTarget)
      : { reply: 'I can switch to tabs 1 through 8.' }),
  },
  {
    id: 'all-tabs',
    re: /^(?:show|search)\s+(?:all\s+)?tabs(?:\s+for\s+(.+))?$/,
    run: (_m, ctx) => keyAction('^+a', 'Opening tab search.', ctx.lastTarget),
  },
  {
    id: 'private-window',
    re: /^(?:open|start)\s+(?:a\s+)?(?:new\s+)?(?:private|incognito)\s+(?:window|browsing)$/,
    run: (_m, ctx) => keyAction('^+n', 'Opening a private window.', ctx.lastTarget),
  },
  {
    id: 'browser-back',
    re: /^(?:go\s+)?back$/,
    run: (_m, ctx) => keyAction('%{LEFT}', 'Going back.', ctx.lastTarget),
  },
  {
    id: 'browser-forward',
    re: /^(?:go\s+)?forward$/,
    run: (_m, ctx) => keyAction('%{RIGHT}', 'Going forward.', ctx.lastTarget),
  },
  {
    id: 'refresh',
    re: /^(?:refresh|reload)(?:\s+(?:this|the)\s+(?:page|tab|window|folder|list|feed|app))?$/,
    run: (_m, ctx) => {
      if (ctx.lastTarget) return keyAction('{F5}', 'Refreshing.', ctx.lastTarget);
      // No page opened through BRO yet: refresh whichever window is in front.
      return {
        action: { id: 'send_keys', type: 'send_keys', args: { keys: '{F5}' }, label: 'Refresh' },
        reply: 'Refreshing.',
      };
    },
  },
  {
    id: 'browser-downloads',
    re: /^(?:open|show)\s+(?:my\s+|the\s+)?(?:(browser)\s+)?downloads$/,
    run: (m, ctx) => {
      // “open downloads” on its own means the Downloads folder.
      if (!m[1]) return null;
      return keyAction('^j', 'Opening browser downloads.', ctx.lastTarget);
    },
  },
  {
    id: 'browser-history',
    re: /^(?:open|show)\s+(?:my\s+|the\s+)?(?:browser\s+)?(?:history|browsing\s+history)$/,
    run: (_m, ctx) => keyAction('^h', 'Opening browsing history.', ctx.lastTarget),
  },
  {
    id: 'browser-bookmark',
    re: /^(?:add|bookmark)\s+(?:this|the)\s+(?:page|site)\s+(?:to\s+)?bookmarks?$|^bookmark\s+this\s+page$/,
    run: (_m, ctx) => keyAction('^d', 'Bookmarking this page.', ctx.lastTarget),
  },
  {
    id: 'zoom-reset',
    re: /^(?:reset|normal)\s+zoom$/,
    run: (_m, ctx) => keyAction('^0', 'Resetting zoom.', ctx.lastTarget),
  },
  {
    id: 'page-find',
    re: /^(?:find|search)\s+(?:for\s+)?(.+?)\s+(?:on|in)\s+(?:this|the)\s+page$/,
    run: (m, ctx) => sequenceAction([
      { focus: targetOf(ctx.lastTarget) },
      { keys: '^f' },
      { wait: 250 },
      { type: m[1] },
      { keys: '{ENTER}' },
    ], `Finding “${m[1]}” on the page.`, ctx.lastTarget),
  },

  // Editing and typing ------------------------------------------------------
  {
    id: 'select-all',
    re: /^select\s+all$/,
    run: (_m, ctx) => keyAction('^a', 'Selecting everything.', ctx.lastTarget),
  },
  {
    id: 'copy',
    re: /^copy(?:\s+(?:that|this|the\s+selected\s+text))?$/,
    run: (_m, ctx) => keyAction('^c', 'Copying the selection.', ctx.lastTarget),
  },
  {
    id: 'cut',
    re: /^cut(?:\s+(?:that|this|the\s+selected\s+text))?$/,
    run: (_m, ctx) => keyAction('^x', 'Cutting the selection.', ctx.lastTarget),
  },
  {
    id: 'paste',
    re: /^paste$/,
    run: (_m, ctx) => keyAction('^v', 'Pasting.', ctx.lastTarget),
  },
  {
    id: 'undo',
    re: /^undo$/,
    run: (_m, ctx) => keyAction('^z', 'Undoing.', ctx.lastTarget),
  },
  {
    id: 'redo',
    re: /^redo$/,
    run: (_m, ctx) => keyAction('^y', 'Redoing.', ctx.lastTarget),
  },

  // Scroll and simple keys --------------------------------------------------
  {
    id: 'scroll-top',
    re: /^(?:scroll|go|jump|take\s+me)\s+to\s+(?:the\s+)?(?:top|start)(?:\s+of\s+(?:the\s+)?(?:page|document|list|feed|window))?$/,
    run: (_m, ctx) => keyAction('^{HOME}', 'Scrolling to the top.', ctx.lastTarget),
  },
  {
    id: 'scroll-bottom',
    re: /^(?:scroll|go|jump|take\s+me)\s+to\s+(?:the\s+)?(?:bottom|end)(?:\s+of\s+(?:the\s+)?(?:page|document|list|feed|window))?$/,
    run: (_m, ctx) => keyAction('^{END}', 'Scrolling to the bottom.', ctx.lastTarget),
  },
  {
    id: 'scroll-page',
    re: /^(?:scroll\s+)?page\s+(down|up)$/,
    run: (m, ctx) => scrollAction(m[1].toLowerCase(), 8, `Scrolling ${m[1].toLowerCase()} one page.`, ctx.lastTarget),
  },
  {
    id: 'scroll-more',
    re: /^(?:keep\s+scrolling|scroll\s+(?:some\s+)?more|scroll\s+down\s+more|scroll\s+up\s+more)$/,
    run: (m, ctx) => {
      const direction = /up/.test(m[0]) ? 'up' : 'down';
      return scrollAction(direction, 10, `Scrolling ${direction}.`, ctx.lastTarget);
    },
  },
  {
    id: 'scroll',
    re: /^scroll(?:\s+(down|up|left|right))?(?:\s+(a\s+little\s+bit|a\s+little|a\s+bit|a\s+lot|lots|more|one\s+page|a\s+page|one\s+screen|a\s+screen|\d{1,2}\s+(?:times?|notches?)))?(?:\s+(?:in|on|through)\s+(?:the\s+)?(?:page|tab|window|list|feed|site|website|gmail|youtube|app|document)|\s+(?:the\s+)?(?:page|list|feed))?$/,
    run: (m, ctx) => {
      const direction = m[1] ? m[1].toLowerCase() : 'down';
      const detail = (m[2] || '').toLowerCase();
      let amount = 5;
      if (/little|bit/.test(detail)) amount = 2;
      else if (/lot/.test(detail)) amount = 10;
      else if (/more/.test(detail)) amount = 8;
      else if (/page|screen/.test(detail)) amount = 8;
      else {
        const repeat = detail.match(/^(\d{1,2})\s+(?:times?|notches?)$/);
        if (repeat) amount = Math.max(1, Math.min(30, Number(repeat[1]) * 5));
      }
      return scrollAction(
        direction,
        amount,
        `Scrolling ${direction}${detail ? ` ${detail}` : ''}.`,
        ctx.lastTarget,
      );
    },
  },
  {
    id: 'press-key',
    re: /^(?:press|hit|send)\s+(?:the\s+)?([a-z0-9+\s-]+?)(?:\s+key)?$/,
    run: (m, ctx) => {
      const words = m[1].trim();
      // Do not swallow app commands such as “press the button”.
      if (/\b(?:button|link|tab|item|option|menu)\b/.test(words)) return null;
      try {
        return keyAction(keySequence(words), `Pressing ${words}.`, ctx.lastTarget);
      } catch {
        return null;
      }
    },
  },
  {
    id: 'type-text',
    re: /^(?:type|write|dictate|enter)\s+(?:this\s*:?\s*)?(.+)$/,
    run: (m, ctx) => {
      const raw = String(m[1]).trim();
      const text = raw.replace(/^["“]|["”]$/g, '').trim();
      if (!text) return null;
      // “write a long story” or “type an email to my boss” is a request for the
      // assistant, not literal dictation. Only short, literal text is typed —
      // otherwise a content request is sprayed into whatever window has focus.
      const words = text.split(/\s+/).filter(Boolean);
      if (text.length > 80 || words.length > 12) return null;
      if (!/^["“]/.test(raw) && /^(?:a|an|the|me|my|about|something|anything|some|this|that|it|everything)\b/i.test(text)) return null;
      return {
        action: {
          id: 'type_text',
          type: 'type_text',
          args: { text, target: targetOf(ctx.lastTarget) },
          label: `Type ${text.slice(0, 60)}`,
        },
        reply: `Typing “${text.length > 80 ? `${text.slice(0, 77)}…` : text}”.`,
      };
    },
  },

  // Clicking ---------------------------------------------------------------
  {
    id: 'click-first-result',
    re: /^(?:click|open|select)\s+(?:the\s+)?first\s+(?:result|item|option)$/,
    run: (_m, ctx) => clickResult('Opening the first result.', ctx.lastTarget, { first: true }),
  },
  {
    id: 'right-click',
    re: /^right[-\s]?click\s+(?:on\s+)?(?:the\s+)?(.+)$/,
    run: (m, ctx) => clickResult(`Right-clicking “${m[1]}”.`, ctx.lastTarget, { name: m[1], button: 'right' }),
  },
  {
    id: 'double-click',
    re: /^double[-\s]?click\s+(?:on\s+)?(?:the\s+)?(.+)$/,
    run: (m, ctx) => clickResult(`Double-clicking “${m[1]}”.`, ctx.lastTarget, { name: m[1], double: true }),
  },
  {
    id: 'click',
    re: /^(?:click|select|tap)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+(?:button|link|tab|item|option))?$/,
    run: (m, ctx) => clickResult(`Clicking “${m[1]}”.`, ctx.lastTarget, { name: m[1] }),
  },

  // Window switching -------------------------------------------------------
  {
    id: 'previous-window',
    re: /^(?:go\s+to\s+the\s+)?previous\s+window$|^(?:switch|alt)\s+windows?$/,
    run: () => keyAction('%{TAB}', 'Switching to the previous window.', null, { focus: false }),
  },
  {
    id: 'show-window',
    re: /^(?:switch\s+to|focus|activate)\s+(.+)$/,
    run: (m) => {
      const label = m[1].replace(/\s+/g, ' ').trim();
      if (!label) return null;
      return {
        action: { id: 'focus_window', type: 'focus_window', args: { target: { label } }, label: `Focus ${label}` },
        reply: `Switching to ${label}.`,
      };
    },
  },
];

function keySequence(words) {
  // Local mapping kept in sync with tools.keySequenceFor, without importing the
  // whole tools module at rule-evaluation time.
  const names = {
    enter: '{ENTER}', return: '{ENTER}', escape: '{ESC}', esc: '{ESC}', tab: '{TAB}',
    space: ' ', backspace: '{BACKSPACE}', delete: '{DELETE}', insert: '{INSERT}',
    up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}', home: '{HOME}',
    end: '{END}', 'page up': '{PGUP}', pgup: '{PGUP}', 'page down': '{PGDN}', pgdn: '{PGDN}',
  };
  const mods = { control: '^', ctrl: '^', alt: '%', shift: '+', windows: '', win: '', meta: '' };
  const parts = String(words || '').toLowerCase().trim().split(/[\s+-]+/).filter(Boolean);
  let prefix = '';
  let key = null;
  for (const part of parts) {
    if (Object.hasOwn(mods, part)) { prefix += mods[part]; continue; }
    if (Object.hasOwn(names, part)) { key = names[part]; continue; }
    if (/^f(?:[1-9]|1\d|2[0-4])$/.test(part)) { key = `{${part.toUpperCase()}}`; continue; }
    if (part.length === 1) { key = part; continue; }
    key = `{${part.toUpperCase()}}`;
  }
  if (!key) throw new Error('unknown key');
  return `${prefix}${key}`;
}

function isYouTube(lastTarget) {
  return isSite(lastTarget, 'youtube.com');
}

function playbackResult(ctx, mode) {
  const state = ctx.mediaState || '';
  const target = ctx.lastTarget;
  if (mode === 'stop') {
    if (state === 'paused' || state === 'stopped') return { reply: 'It is already stopped.', mediaState: 'stopped' };
    if (isYouTube(target)) return keyAction('k', 'Stopped the video.', target, { mediaState: 'stopped' });
    return mediaAction('stop', 'Stopped playback.', 'stopped');
  }
  if (mode === 'pause') {
    if (state === 'paused') return { reply: 'It is already paused.', mediaState: 'paused' };
    if (isYouTube(target)) return keyAction('k', 'Paused the video.', target, { mediaState: 'paused' });
    return mediaAction('play_pause', 'Paused playback.', 'paused');
  }
  if (state === 'playing') return { reply: 'It is already playing.', mediaState: 'playing' };
  if (isYouTube(target)) return keyAction('k', 'Playing the video.', target, { mediaState: 'playing' });
  return mediaAction('play_pause', 'Playing.', 'playing');
}

function nextItemResult(ctx, direction) {
  const target = ctx.lastTarget;
  if (isYouTube(target)) {
    // YouTube: Shift+N plays the next queued video, Shift+P the previous one.
    return keyAction(
      direction === 'next' ? '+n' : '+p',
      direction === 'next' ? 'Playing the next video in the queue.' : 'Playing the previous video.',
      target,
      { mediaState: 'playing' },
    );
  }
  return direction === 'next'
    ? mediaAction('next', 'Skipping to the next item.', 'playing')
    : mediaAction('previous', 'Going back to the previous item.', 'playing');
}

function seekResult(ctx, seconds, direction) {
  const target = ctx.lastTarget;
  const amount = Math.max(1, Math.min(120, Math.round(seconds)));
  if (isYouTube(target)) {
    // YouTube's L / J shortcuts move ten seconds at a time.
    const presses = Math.max(1, Math.round(amount / 10));
    const key = direction === 'forward' ? 'l' : 'j';
    return keyAction(key.repeat(presses), `${direction === 'forward' ? 'Skipping forward' : 'Going back'} ${presses * 10} seconds.`, target);
  }
  const key = direction === 'forward' ? '%{RIGHT}' : '%{LEFT}';
  return keyAction(key, `${direction === 'forward' ? 'Skipping forward' : 'Going back'} ${amount} seconds.`, target);
}

function matchApplicationSkill(commandText, context = {}) {
  const text = norm(commandText);
  if (!text) return null;
  const ctx = {
    lastTarget: context.lastTarget || null,
    mediaState: context.mediaState || '',
    lastFileQuery: context.lastFileQuery || '',
  };
  for (const rule of RULES) {
    if (!rule._re) rule._re = new RegExp(rule.re.source, `${rule.re.flags.replace(/[gy]/g, '')}i`);
    const match = text.match(rule._re);
    if (!match) continue;
    const outcome = rule.run(match, ctx);
    if (outcome) return { ...outcome, rule: rule.id };
  }
  return null;
}

module.exports = { matchApplicationSkill, SITE_NAMES: { siteName } };
