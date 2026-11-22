'use strict';

// VS Code adapter.
//
// Only fixed, argument-based launches are allowed: Code.exe with a validated
// folder or file path. No shell, no generated command line. Running a file uses
// one of two fixed interpreters and always requires the agent confirmation gate.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFile } = require('node:child_process');
const tools = require('../../tools');
const files = require('./files');

const INTERPRETERS = Object.freeze(['python', 'node']);
const MAX_OUTPUT = 120_000;
const RUN_TIMEOUT_MS = 120_000;

function oneLine(value, limit = 200) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function codeCandidates() {
  const home = process.env.USERPROFILE || '';
  const local = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    process.env.BRO_VSCODE_PATH || '',
    local ? path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe') : '',
    programFiles ? path.join(programFiles, 'Microsoft VS Code', 'Code.exe') : '',
    programFilesX86 ? path.join(programFilesX86, 'Microsoft VS Code', 'Code.exe') : '',
  ].filter(Boolean);
}

function findCodeExe() {
  for (const candidate of codeCandidates()) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  // The Start Menu installs a `code.cmd` shim on PATH; its sibling Code.exe is
  // the real executable, which is safe to spawn without a shell.
  try {
    const probe = spawnSync('where.exe', ['code.cmd'], { encoding: 'utf8', timeout: 3_000, windowsHide: true });
    const shim = String(probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (shim) {
      const exe = path.join(path.dirname(path.dirname(shim)), 'Code.exe');
      if (fs.existsSync(exe)) return exe;
    }
  } catch { /* not on PATH */ }
  try {
    const probe = spawnSync('where.exe', ['code.exe'], { encoding: 'utf8', timeout: 3_000, windowsHide: true });
    const exe = String(probe.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (exe && fs.existsSync(exe)) return exe;
  } catch { /* not on PATH */ }
  return '';
}

async function windowsForCode(extraText = '') {
  try {
    const wanted = extraText ? `${extraText} Visual Studio Code` : 'Visual Studio Code';
    const matches = await tools.findWindowsAsync(wanted, {});
    if (matches && matches.length) return matches;
    const loose = await tools.findWindowsAsync('Visual Studio Code', {});
    return loose || [];
  } catch {
    return [];
  }
}

async function status() {
  const exe = findCodeExe();
  const windows = await windowsForCode();
  return {
    installed: Boolean(exe),
    exe,
    running: windows.length > 0,
    window: windows.length ? oneLine(windows[0].title, 160) : '',
  };
}

function requireCode() {
  const exe = findCodeExe();
  if (!exe) throw new Error('Visual Studio Code is not installed, or BRO cannot find Code.exe.');
  return exe;
}

function launch(args) {
  const exe = requireCode();
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
  child.once('error', () => {});
  child.unref();
}

async function waitForWindow(text, timeoutMs = 12_000) {
  const until = Date.now() + Math.max(1_000, timeoutMs);
  while (Date.now() < until) {
    const windows = await windowsForCode(text);
    if (windows.length) return windows[0];
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return null;
}

async function openFolder({ path: requested = '' } = {}, ctx = {}) {
  const folder = files.resolveSafe(requested, ctx, { allowMissing: false });
  if (!fs.statSync(folder).isDirectory()) throw new Error('That is a file, not a folder.');
  launch([folder]);
  const win = await waitForWindow(path.basename(folder));
  return {
    opened: true,
    folder,
    window: win ? oneLine(win.title, 160) : '',
    verified: Boolean(win),
  };
}

async function openFile({ path: requested = '' } = {}, ctx = {}) {
  const target = files.resolveSafe(requested, ctx, { allowMissing: false });
  if (!fs.statSync(target).isFile()) throw new Error('That is a folder, not a file.');
  launch(['--reuse-window', target]);
  const win = await waitForWindow(path.basename(target));
  return {
    opened: true,
    path: target,
    window: win ? oneLine(win.title, 160) : '',
    verified: Boolean(win),
  };
}

async function focus() {
  try {
    const result = await tools.controlWindowAsync({ label: 'Visual Studio Code' }, 'focus');
    return { focused: true, window: oneLine(result.window, 160), process: result.process };
  } catch (error) {
    throw new Error(`I could not focus Visual Studio Code. ${oneLine(error.message, 160)}`);
  }
}

async function save() {
  const focused = await focus();
  tools.sendKeys('^s');
  return { saved: true, window: focused.window, note: 'Sent the save shortcut to Visual Studio Code.' };
}

function interpreterCommand(interpreter) {
  const wanted = String(interpreter || 'python').toLowerCase();
  if (!INTERPRETERS.includes(wanted)) throw new Error('Choose either python or node.');
  if (wanted === 'node') return { command: process.execPath, argsPrefix: [] };
  const configured = process.env.BRO_PYTHON_PATH || '';
  if (configured && fs.existsSync(configured)) return { command: configured, argsPrefix: [] };
  return { command: 'python', argsPrefix: [] };
}

async function runFile({ path: requested = '', interpreter = 'python', args = [] } = {}, ctx = {}) {
  const target = files.resolveSafe(requested, ctx, { allowMissing: false });
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('I can only run a file, not a folder.');
  const ext = path.extname(target).toLowerCase();
  const wanted = String(interpreter || 'python').toLowerCase();
  if (wanted === 'python' && !['.py', '.pyw'].includes(ext)) throw new Error('That file is not a Python file.');
  if (wanted === 'node' && !['.js', '.mjs', '.cjs'].includes(ext)) throw new Error('That file is not a JavaScript file.');
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.length > 300)) throw new Error('Script arguments must be short text values.');
  const { command, argsPrefix } = interpreterCommand(wanted);

  const result = await new Promise((resolve) => {
    execFile(command, [...argsPrefix, target, ...args], {
      cwd: path.dirname(target),
      timeout: RUN_TIMEOUT_MS,
      windowsHide: true,
      shell: false,
      maxBuffer: MAX_OUTPUT,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
    }, (error, stdout, stderr) => {
      resolve({
        exitCode: error && Number.isInteger(error.code) ? error.code : (error ? 1 : 0),
        timedOut: Boolean(error && error.killed),
        stdout: String(stdout || '').slice(0, MAX_OUTPUT),
        stderr: String(stderr || '').slice(0, 8_000),
        command: `${wanted} ${path.basename(target)}`,
      });
    });
  });
  return { ran: true, path: target, ...result };
}

function vscodeTools() {
  return [
    {
      name: 'vscode_status',
      description: 'Check whether Visual Studio Code is installed and open.',
      risk: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => status(),
    },
    {
      name: 'vscode_open_folder',
      description: 'Open a folder as a workspace in Visual Studio Code.',
      risk: 'launch',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      handler: openFolder,
    },
    {
      name: 'vscode_open_file',
      description: 'Open a file in Visual Studio Code.',
      risk: 'launch',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      handler: openFile,
    },
    {
      name: 'vscode_create_file',
      description: 'Create a new file inside the user folders or a registered project. Fails instead of overwriting.',
      risk: 'file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path or containing folder.' },
          name: { type: 'string', maxLength: 120 },
          content: { type: 'string', maxLength: 200_000 },
        },
        required: [],
      },
      handler: files.createFile,
    },
    {
      name: 'vscode_write_file',
      description: 'Replace a file’s text. Overwriting needs overwrite=true and the user’s confirmation.',
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
      handler: files.writeFile,
      confirm: (args) => (args.overwrite === true ? 'That would overwrite an existing file in Visual Studio Code. Confirm the exact target first.' : ''),
    },
    {
      name: 'vscode_read_file',
      description: 'Read a text or code file.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, maxBytes: { type: 'integer', minimum: 1, maximum: 200_000 } },
        required: ['path'],
      },
      handler: files.readFile,
    },
    {
      name: 'vscode_focus',
      description: 'Bring the Visual Studio Code window to the front.',
      risk: 'input',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => focus(),
    },
    {
      name: 'vscode_save',
      description: 'Focus Visual Studio Code and send the save shortcut.',
      risk: 'input',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => save(),
    },
    {
      name: 'vscode_run_file',
      description: 'Run one Python or JavaScript file with the fixed interpreter and return its output. This runs code, so the user must confirm it.',
      risk: 'execute',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          interpreter: { type: 'string', enum: INTERPRETERS },
          args: { type: 'array', maxItems: 10, items: { type: 'string', maxLength: 300 } },
        },
        required: ['path'],
      },
      handler: runFile,
    },
  ];
}

module.exports = {
  findCodeExe,
  status,
  openFolder,
  openFile,
  focus,
  save,
  runFile,
  vscodeTools,
  INTERPRETERS,
};
