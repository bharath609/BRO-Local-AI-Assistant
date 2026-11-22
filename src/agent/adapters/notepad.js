'use strict';

// Notepad adapter.
//
// Notepad has almost no automation surface, so BRO writes the file with the
// validated file tools and then opens that exact path in Notepad. Typing into an
// already-open Notepad window is supported for interactive edits.

const { spawn } = require('node:child_process');
const tools = require('../../tools');
const files = require('./files');

function oneLine(value, limit = 160) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function findNotepadWindow() {
  try {
    const matches = await tools.findWindowsAsync('Notepad', {});
    return matches && matches.length ? matches[0] : null;
  } catch {
    return null;
  }
}

async function start(args = []) {
  const child = spawn('notepad.exe', args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
  child.once('error', () => {});
  child.unref();
  const until = Date.now() + 8_000;
  while (Date.now() < until) {
    const win = await findNotepadWindow();
    if (win) return win;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function status() {
  const win = await findNotepadWindow();
  return {
    running: Boolean(win),
    window: win ? oneLine(win.title) : '',
  };
}

async function open({ path: requested = '' } = {}, ctx = {}) {
  if (!requested) {
    const win = await start([]);
    return { opened: true, file: '', window: win ? oneLine(win.title) : '', verified: Boolean(win) };
  }
  const target = files.resolveSafe(requested, ctx, { allowMissing: false });
  // Refuse binary files: Notepad would show mojibake and the user would think
  // BRO corrupted the file.
  files.readFile({ path: target, maxBytes: 64 }, ctx);
  const win = await start([target]);
  return { opened: true, file: target, window: win ? oneLine(win.title) : '', verified: Boolean(win) };
}

async function focus() {
  try {
    const result = await tools.controlWindowAsync({ label: 'Notepad' }, 'focus');
    return { focused: true, window: oneLine(result.window) };
  } catch (error) {
    throw new Error(`I could not focus Notepad. ${oneLine(error.message)}`);
  }
}

async function typeText({ text = '', pressEnter = false } = {}) {
  const value = String(text ?? '');
  if (!value.trim()) throw new Error('Tell me what to type into Notepad.');
  const focused = await focus();
  tools.typeText(value);
  if (pressEnter) tools.sendKeys('{ENTER}');
  return { typed: true, characters: value.length, window: focused.window };
}

async function writeAndOpen({ path: requested = '', content = '', overwrite = false } = {}, ctx = {}) {
  const result = overwrite === true
    ? files.writeFile({ path: requested, content, overwrite: true }, ctx)
    : files.createFile({ path: requested, content }, ctx);
  if (result && result.created === false) return result;
  const win = await start([result.path]);
  return { ...result, opened: Boolean(win), window: win ? oneLine(win.title) : '' };
}

function notepadTools() {
  return [
    {
      name: 'notepad_status',
      description: 'Check whether Notepad is open.',
      risk: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => status(),
    },
    {
      name: 'notepad_open',
      description: 'Open Notepad, optionally with an existing text file.',
      risk: 'launch',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: [],
      },
      handler: open,
    },
    {
      name: 'notepad_focus',
      description: 'Bring Notepad to the front.',
      risk: 'input',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => focus(),
    },
    {
      name: 'notepad_type',
      description: 'Type text into the open Notepad window at the cursor.',
      risk: 'input',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', maxLength: 4_000 },
          pressEnter: { type: 'boolean' },
        },
        required: ['text'],
      },
      handler: typeText,
    },
    {
      name: 'notepad_write',
      description: 'Create a text file and open it in Notepad. Overwriting needs overwrite=true and confirmation.',
      risk: 'file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string', maxLength: 200_000 },
          overwrite: { type: 'boolean' },
        },
        required: ['path', 'content'],
      },
      handler: writeAndOpen,
      confirm: (args) => (args.overwrite === true ? 'That would overwrite an existing text file. Confirm the exact target first.' : ''),
    },
    {
      name: 'notepad_read',
      description: 'Read a text file that Notepad can display.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: 200_000 } },
        required: ['path'],
      },
      handler: files.readFile,
    },
  ];
}

module.exports = { status, open, focus, typeText, writeAndOpen, notepadTools };
