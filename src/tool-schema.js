// Tool definitions for the AI brain.
//
// The model may only choose from this fixed list. Every argument is validated
// against the schema below before it becomes a desktop action, so generated text
// can never turn into an arbitrary shell command. Destructive actions (power,
// delete, guardrail changes) are deliberately absent: those stay on the existing
// spoken-confirmation path in `assistant.js`.

const TOOLS = [
  {
    name: 'open_app',
    description: 'Open an application installed on this PC, for example Chrome, Notepad, Telegram, or VS Code.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Application name the user said.' } },
      required: ['name'],
    },
  },
  {
    name: 'open_website',
    description: 'Open a website or a URL in the default browser. Use for known sites such as YouTube or Gmail, or a full URL.',
    parameters: {
      type: 'object',
      properties: { target: { type: 'string', description: 'Site name or full URL.' } },
      required: ['target'],
    },
  },
  {
    name: 'search_web',
    description: 'Run a web search in the browser.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search terms.' } },
      required: ['query'],
    },
  },
  {
    name: 'search_youtube',
    description: 'Open YouTube search results for a query.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search terms.' } },
      required: ['query'],
    },
  },
  {
    name: 'open_windows_item',
    description: 'Open a Windows folder or built-in tool, for example Downloads, Documents, Task Manager, Control Panel, Device Manager, Services, or Event Viewer.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Windows folder or tool name.' } },
      required: ['name'],
    },
  },
  {
    name: 'close_app',
    description: 'Close an application, a browser tab for a site, or the window named by the user.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Application, site, or window name.' } },
      required: ['name'],
    },
  },
  {
    name: 'control_window',
    description: 'Focus, minimize, maximize, or restore the window BRO opened last. Use when the user says "it", "that", or "the window".',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['focus', 'minimize', 'maximize', 'restore'] },
      },
      required: ['mode'],
    },
  },
  {
    name: 'media_control',
    description: 'Control media playback on the PC.',
    parameters: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: ['playpause', 'play', 'pause', 'next', 'previous', 'stop', 'mute', 'volumeup', 'volumedown'] },
      },
      required: ['key'],
    },
  },
  {
    name: 'scroll_page',
    description: 'Scroll the page or window that BRO opened last.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', minimum: 1, maximum: 20, description: 'Number of wheel steps; default 3.' },
      },
      required: ['direction'],
    },
  },
  {
    name: 'take_screenshot',
    description: 'Capture a screenshot and save it to the Pictures folder.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'type_text',
    description: 'Type text into the window BRO opened last.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to type literally.' } },
      required: ['text'],
    },
  },
  {
    name: 'press_keys',
    description: 'Send a keyboard shortcut to the window BRO opened last, for example {CTRL}s to save or {ENTER}.',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string', description: 'SendKeys sequence.' } },
      required: ['keys'],
    },
  },
  {
    name: 'press_windows_key',
    description: 'Press a Windows key combination: start, taskview, quick_settings, run, clipboard, settings, explorer, lock.',
    parameters: {
      type: 'object',
      properties: {
        keys: {
          type: 'string',
          enum: ['start', 'taskview', 'quick_settings', 'run', 'clipboard', 'settings', 'explorer', 'lock', 'show_desktop'],
        },
      },
      required: ['keys'],
    },
  },
  {
    name: 'create_folder',
    description: 'Create a folder in the user profile (Desktop by default).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Folder name.' },
        folder: { type: 'string', description: 'Optional parent folder such as Desktop, Documents, or Downloads.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'open_windows_settings',
    description: 'Open a Windows Settings page, for example display, bluetooth, wifi, sound, privacy, or updates.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Settings page name.' } },
      required: ['name'],
    },
  },
  {
    name: 'open_terminal',
    description: 'Open a terminal window.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list_projects',
    description: 'List the projects registered in BRO.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'open_project',
    description: 'Open one of the projects registered in BRO by name.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Registered project name.' } },
      required: ['name'],
    },
  },
  {
    name: 'click_first_result',
    description: 'Click the first result in the page BRO opened last, for example the first YouTube video or the first unread email.',
    parameters: {
      type: 'object',
      properties: { unread: { type: 'boolean', description: 'Prefer the first unread item.' } },
      required: [],
    },
  },
  {
    name: 'show_desktop',
    description: 'Show the Windows desktop.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
];

const BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

function openAiTools() {
  return TOOLS.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function toolByName(name) {
  return BY_NAME.get(String(name || '').trim()) || null;
}

function checkType(value, property) {
  if (property.type === 'string') return typeof value === 'string';
  if (property.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (property.type === 'boolean') return typeof value === 'boolean';
  return true;
}

function validateToolArguments(name, rawArguments) {
  const tool = toolByName(name);
  if (!tool) return { ok: false, error: `unknown tool: ${name}` };

  let args = rawArguments;
  if (typeof args === 'string') {
    try { args = args.trim() ? JSON.parse(args) : {}; } catch { return { ok: false, error: 'arguments are not valid JSON' }; }
  }
  if (args == null) args = {};
  if (typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'arguments must be an object' };

  const properties = tool.parameters.properties || {};
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      return { ok: false, error: `unexpected argument: ${key}` };
    }
  }

  const cleaned = {};
  for (const [key, property] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    if (!checkType(value, property)) return { ok: false, error: `${key} must be a ${property.type}` };

    if (property.type === 'string') {
      const trimmed = value.trim();
      if (!trimmed) continue;
      const max = property.maxLength || (key === 'text' || key === 'keys' ? 500 : 200);
      if (trimmed.length > max) return { ok: false, error: `${key} is too long` };
      if (property.enum && !property.enum.includes(trimmed)) return { ok: false, error: `${key} must be one of ${property.enum.join(', ')}` };
      cleaned[key] = trimmed;
    } else if (property.type === 'number') {
      if (property.minimum != null && value < property.minimum) return { ok: false, error: `${key} is too small` };
      if (property.maximum != null && value > property.maximum) return { ok: false, error: `${key} is too large` };
      cleaned[key] = value;
    } else {
      cleaned[key] = value;
    }
  }

  for (const required of tool.parameters.required || []) {
    if (cleaned[required] === undefined) return { ok: false, error: `missing argument: ${required}` };
  }

  return { ok: true, args: cleaned, tool };
}

module.exports = { TOOLS, openAiTools, toolByName, validateToolArguments };
