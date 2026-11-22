'use strict';

// Observation: what is on screen, what is running, and what a window exposes.
//
// Vision here is deliberately cheap and local: the foreground window, a bounded
// UI Automation control tree, and an optional screenshot + OCR. No screenshot is
// taken unless a tool or the planner asks for one, so an ordinary command stays
// fast.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const tools = require('../tools');
const { runPowerShellAsync, parseJsonLines } = require('./win');

const MAX_TREE_NODES = 400;
const MAX_TREE_DEPTH = 4;

const UI_TREE_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$handle = [IntPtr][long]$env:BRO_UI_HWND
$limit = [int]$env:BRO_UI_LIMIT
$depth = [int]$env:BRO_UI_DEPTH
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if (-not $root) { [Console]::WriteLine('[]'); exit 0 }

$script:nodes = New-Object System.Collections.ArrayList
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

function Get-Node($element, $level) {
  if ($script:nodes.Count -ge $limit) { return }
  $c = $element.Current
  $name = ''
  $type = ''
  $id = ''
  $class = ''
  $value = ''
  $enabled = $false
  $offscreen = $true
  $x = 0; $y = 0; $w = 0; $h = 0
  try { $name = [string]$c.Name } catch { }
  try { $type = [string]$c.ControlType.ProgrammaticName } catch { }
  try { $id = [string]$c.AutomationId } catch { }
  try { $class = [string]$c.ClassName } catch { }
  try { $enabled = [bool]$c.IsEnabled } catch { }
  try { $offscreen = [bool]$c.IsOffscreen } catch { }
  try {
    $rect = $c.BoundingRectangle
    if (-not $rect.IsEmpty) {
      $x = [int]$rect.X; $y = [int]$rect.Y; $w = [int]$rect.Width; $h = [int]$rect.Height
    }
  } catch { }
  try {
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      $value = [string]$pattern.Current.Value
    }
  } catch { }
  [void]$script:nodes.Add([pscustomobject]@{
    level = [int]$level
    name = $name
    type = ($type -replace '^ControlType\.', '')
    id = $id
    className = $class
    value = $value
    enabled = $enabled
    offscreen = $offscreen
    x = $x; y = $y; width = $w; height = $h
  })
  if ($level -ge $depth -or $script:nodes.Count -ge $limit) { return }
  $child = $walker.GetFirstChild($element)
  while ($child -ne $null -and $script:nodes.Count -lt $limit) {
    Get-Node $child ($level + 1)
    $child = $walker.GetNextSibling($child)
  }
}

try { Get-Node $root 0 } catch { }
if ($script:nodes.Count -eq 0) { [Console]::WriteLine('[]'); exit 0 }
[Console]::WriteLine((ConvertTo-Json -InputObject @($script:nodes) -Compress -Depth 4))
`;

function requireWindows() {
  if (process.platform !== 'win32') throw new Error('Computer observation is only available on Windows.');
}

function oneLine(value, limit = 300) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function listWindows(options = {}) {
  requireWindows();
  return tools.listWindowsAsync({ force: true, includeBro: false, ...options });
}

async function activeWindow() {
  requireWindows();
  let windows = [];
  try { windows = await tools.listWindowsAsync({ force: true, includeBro: false }); } catch { windows = []; }
  let front = windows.find((win) => win.foreground);
  if (!front) {
    try {
      const all = await tools.listWindowsAsync({ force: true, includeBro: true });
      front = all.find((win) => win.foreground);
    } catch { /* no windows */ }
  }
  if (!front) return { found: false, title: '', process: '', hwnd: 0 };
  return {
    found: true,
    title: oneLine(front.title, 200),
    process: String(front.process || '').replace(/\.exe$/i, ''),
    pid: front.pid,
    hwnd: front.hwnd,
    minimized: Boolean(front.minimized),
    bounds: { x: front.x, y: front.y, width: front.width, height: front.height },
  };
}

async function runningApps({ limit = 20 } = {}) {
  requireWindows();
  const windows = await tools.listWindowsAsync({ force: true, includeBro: false });
  const seen = new Map();
  for (const win of windows) {
    const process = String(win.process || '').replace(/\.exe$/i, '');
    if (!process) continue;
    const entry = seen.get(process) || { process, windows: [] };
    if (entry.windows.length < 3 && win.title) entry.windows.push(oneLine(win.title, 120));
    seen.set(process, entry);
  }
  return [...seen.values()].slice(0, Math.max(1, Math.min(60, Number(limit) || 20)));
}

async function findWindow(query) {
  requireWindows();
  const text = String(query || '').trim();
  if (!text) throw new Error('Tell me which window to inspect.');
  const matches = await tools.findWindowsAsync(text, {});
  if (!matches || !matches.length) return null;
  const front = matches.find((win) => win.foreground) || matches[0];
  return { hwnd: front.hwnd, title: oneLine(front.title, 200), process: front.process, pid: front.pid };
}

async function uiTree({ window = '', maxNodes = MAX_TREE_NODES, maxDepth = MAX_TREE_DEPTH } = {}) {
  requireWindows();
  let target = null;
  if (window) {
    target = await findWindow(window);
    if (!target) throw new Error(`I could not find a window matching “${window}”.`);
  } else {
    const front = await activeWindow();
    if (!front.found) throw new Error('There is no foreground window to inspect.');
    target = { hwnd: front.hwnd, title: front.title, process: front.process, pid: front.pid };
  }
  const limit = Math.max(1, Math.min(800, Number(maxNodes) || MAX_TREE_NODES));
  const depth = Math.max(0, Math.min(8, Number(maxDepth) || MAX_TREE_DEPTH));
  const probe = await runPowerShellAsync(UI_TREE_SCRIPT, {
    timeoutMs: 20_000,
    env: { BRO_UI_HWND: String(target.hwnd), BRO_UI_LIMIT: String(limit), BRO_UI_DEPTH: String(depth) },
  });
  const nodes = parseJsonLines(probe.stdout).filter((node) => node && typeof node === 'object');
  if (!nodes.length && Number(probe.code) !== 0) {
    throw new Error(`Windows could not read that window: ${oneLine(probe.stderr || 'UI Automation returned no data', 240)}`);
  }
  const controls = nodes.map((node) => ({
    level: Number(node.level) || 0,
    type: oneLine(node.type, 60),
    name: oneLine(node.name, 160),
    id: oneLine(node.id, 120),
    className: oneLine(node.className, 80),
    value: oneLine(node.value, 160),
    enabled: Boolean(node.enabled),
    offscreen: Boolean(node.offscreen),
    bounds: { x: Number(node.x) || 0, y: Number(node.y) || 0, width: Number(node.width) || 0, height: Number(node.height) || 0 },
  })).filter((node) => node.name || node.id || node.type);
  return { window: target, count: controls.length, controls };
}

function describeState() {
  return activeWindow().then(async (front) => {
    const apps = await runningApps({ limit: 15 });
    return { active: front, apps };
  });
}

function takeScreenshot() {
  requireWindows();
  const shot = tools.takeScreenshot();
  return { ...shot, note: 'Screenshot saved locally. No password or secret fields should be captured.' };
}

function findTesseract() {
  const candidates = [
    process.env.BRO_TESSERACT_PATH,
    process.env.ProgramFiles ? path.join(process.env.ProgramFiles, 'Tesseract-OCR', 'tesseract.exe') : '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Tesseract-OCR', 'tesseract.exe') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return '';
}

function ocrImage({ path: imagePath = '' } = {}) {
  requireWindows();
  const exe = findTesseract();
  if (!exe) {
    return Promise.resolve({
      available: false,
      text: '',
      message: 'OCR is not installed. Install Tesseract OCR, or read the page text through the browser tools instead.',
    });
  }
  const target = String(imagePath || '').trim();
  if (!target || !fs.existsSync(target)) throw new Error('That screenshot file does not exist.');
  return new Promise((resolve, reject) => {
    execFile(exe, [target, 'stdout', '-l', 'eng'], { timeout: 30_000, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`OCR failed: ${oneLine(stderr || error.message, 200)}`));
        return;
      }
      resolve({ available: true, path: target, text: String(stdout || '').trim().slice(0, 12_000) });
    });
  });
}

async function verify({ window = '', text = '' } = {}) {
  requireWindows();
  const wantedText = String(text || '').trim().toLowerCase();
  if (window) {
    const found = await findWindow(window);
    const front = await activeWindow();
    if (!found) return { verified: false, reason: `No window matching “${window}” is open.` };
    const focused = Boolean(front.found && front.hwnd === found.hwnd);
    if (wantedText) {
      let tree = null;
      try { tree = await uiTree({ window, maxNodes: 500 }); } catch { /* fall through */ }
      const visible = tree && tree.controls.some((control) => `${control.name} ${control.value}`.toLowerCase().includes(wantedText));
      return { verified: visible || focused, focused, window: found, textVisible: Boolean(visible) };
    }
    return { verified: true, focused, window: found };
  }
  if (wantedText) {
    const front = await activeWindow();
    if (!front.found) return { verified: false, reason: 'There is no foreground window.' };
    let tree = null;
    try { tree = await uiTree({ maxNodes: 500 }); } catch { /* fall through */ }
    const visible = tree && tree.controls.some((control) => `${control.name} ${control.value}`.toLowerCase().includes(wantedText));
    if (!visible) {
      let screenshot = null;
      try { screenshot = takeScreenshot(); } catch { /* ignore */ }
      const ocr = screenshot ? await ocrImage({ path: screenshot.path }).catch(() => null) : null;
      const textVisible = Boolean(ocr && ocr.available && ocr.text.toLowerCase().includes(wantedText));
      return { verified: textVisible, textVisible, window: front, screenshot: screenshot ? screenshot.path : '', ocrUsed: Boolean(ocr && ocr.available) };
    }
    return { verified: true, textVisible: true, window: front };
  }
  return { verified: false, reason: 'Ask me which window or which text to verify.' };
}

function watchOnce({ window = '', text = '', screenshot = false } = {}) {
  return verify({ window, text, screenshot }).then((result) => ({ ...result, at: new Date().toISOString() }));
}

function observationTools() {
  return [
    {
      name: 'observe_state',
      description: 'See the foreground window and the apps currently running. Use this before acting on an app, and after an action to confirm what changed.',
      risk: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => describeState(),
    },
    {
      name: 'list_windows',
      description: 'List the visible windows with their title and process.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', minimum: 1, maximum: 60 } },
        required: [],
      },
      handler: async ({ limit = 30 } = {}) => {
        const windows = await listWindows();
        return {
          windows: windows.slice(0, Math.max(1, Math.min(60, Number(limit) || 30))).map((win) => ({
            title: oneLine(win.title, 160),
            process: String(win.process || '').replace(/\.exe$/i, ''),
            hwnd: win.hwnd,
            foreground: Boolean(win.foreground),
            minimized: Boolean(win.minimized),
          })),
        };
      },
    },
    {
      name: 'inspect_window',
      description: 'Read the accessible controls (buttons, fields, labels) inside a window. Use the names it returns to click or fill by label. Give a window title or leave it empty for the foreground window.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: {
          window: { type: 'string', maxLength: 200 },
          maxNodes: { type: 'integer', minimum: 1, maximum: 800 },
          maxDepth: { type: 'integer', minimum: 0, maximum: 8 },
        },
        required: [],
      },
      handler: uiTree,
    },
    {
      name: 'take_screenshot',
      description: 'Save a screenshot of the primary screen and return its local file path. Use only when the accessible controls are not enough.',
      risk: 'input',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => takeScreenshot(),
    },
    {
      name: 'read_screenshot_text',
      description: 'Run local OCR on a screenshot file to read the visible text. Returns available=false when OCR is not installed.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
      handler: ocrImage,
    },
    {
      name: 'verify_state',
      description: 'Check that a window is open and/or that a piece of text is visible before claiming an action worked.',
      risk: 'read',
      parameters: {
        type: 'object',
        properties: { window: { type: 'string', maxLength: 200 }, text: { type: 'string', maxLength: 300 } },
        required: [],
      },
      handler: verify,
    },
  ];
}

module.exports = {
  activeWindow,
  runningApps,
  listWindows,
  findWindow,
  uiTree,
  describeState,
  takeScreenshot,
  ocrImage,
  verify,
  watchOnce,
  observationTools,
  MAX_TREE_NODES,
  MAX_TREE_DEPTH,
};
