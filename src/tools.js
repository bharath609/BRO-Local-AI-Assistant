const path = require('node:path');
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const MAX_OUTPUT = 20 * 1024;
const COMMAND_TIMEOUT = 30_000;

// These are deliberately descriptors rather than command strings. Desktop targets
// never accept a path or executable supplied by the model or by a chat message.
const WINDOWS_DESKTOP_TARGETS = Object.freeze({
  recycle_bin: Object.freeze({ key: 'recycle_bin', label: 'Recycle Bin', command: 'explorer.exe', args: ['shell:RecycleBinFolder'] }),
  this_pc: Object.freeze({ key: 'this_pc', label: 'This PC', command: 'explorer.exe', args: ['shell:MyComputerFolder'] }),
  downloads: Object.freeze({ key: 'downloads', label: 'Downloads', command: 'explorer.exe', folder: 'Downloads' }),
  documents: Object.freeze({ key: 'documents', label: 'Documents', command: 'explorer.exe', folder: 'Documents' }),
  desktop: Object.freeze({ key: 'desktop', label: 'Desktop', command: 'explorer.exe', folder: 'Desktop' }),
  control_panel: Object.freeze({ key: 'control_panel', label: 'Control Panel', command: 'control.exe', args: [] }),
  task_manager: Object.freeze({ key: 'task_manager', label: 'Task Manager', command: 'taskmgr.exe', args: [] }),
  notepad: Object.freeze({ key: 'notepad', label: 'Notepad', command: 'notepad.exe', args: [] }),
  calculator: Object.freeze({ key: 'calculator', label: 'Calculator', command: 'calc.exe', args: [] }),
  settings: Object.freeze({ key: 'settings', label: 'Windows Settings', command: 'explorer.exe', args: ['ms-settings:'] }),
  word: Object.freeze({ key: 'word', label: 'Microsoft Word', command: 'winword.exe', args: [] }),
  excel: Object.freeze({ key: 'excel', label: 'Microsoft Excel', command: 'excel.exe', args: [] }),
  powerpoint: Object.freeze({ key: 'powerpoint', label: 'Microsoft PowerPoint', command: 'powerpnt.exe', args: [] }),
  file_explorer: Object.freeze({ key: 'file_explorer', label: 'File Explorer', command: 'explorer.exe', args: [] }),
  pictures: Object.freeze({ key: 'pictures', label: 'Pictures', command: 'explorer.exe', folder: 'Pictures' })
});

const WINDOWS_DESKTOP_ALIASES = Object.freeze({
  'recycle bin': 'recycle_bin', 'recyclebin': 'recycle_bin',
  'this pc': 'this_pc', 'my computer': 'this_pc', 'computer': 'this_pc',
  downloads: 'downloads',
  documents: 'documents', 'my documents': 'documents',
  desktop: 'desktop',
  'control panel': 'control_panel',
  'task manager': 'task_manager', taskmgr: 'task_manager',
  notepad: 'notepad',
  calculator: 'calculator', calc: 'calculator',
  settings: 'settings', 'windows settings': 'settings', 'system settings': 'settings',
  word: 'word', 'microsoft word': 'word',
  excel: 'excel', 'microsoft excel': 'excel',
  powerpoint: 'powerpoint', 'microsoft powerpoint': 'powerpoint', 'power point': 'powerpoint',
  'file explorer': 'file_explorer', explorer: 'file_explorer',
  pictures: 'pictures', 'pictures folder': 'pictures', 'my pictures': 'pictures'
});

const ACTIVATE_BRO_WINDOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BroWindow {
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string className, string windowName);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr handle, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);
}
"@
$process = Get-Process -Name 'electron' -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -in @('BRO voice', 'BRO overlay') } |
  Select-Object -First 1
$handle = if ($process) { [IntPtr]$process.MainWindowHandle } else { [BroWindow]::FindWindow($null, 'BRO voice') }
if ($handle -eq [IntPtr]::Zero) { $handle = [BroWindow]::FindWindow($null, 'BRO overlay') }
if ($handle -eq [IntPtr]::Zero) {
  [Console]::WriteLine('BRO_WINDOW_MISSING')
  exit 1
}
[BroWindow]::ShowWindowAsync($handle, 9) | Out-Null
[BroWindow]::SetForegroundWindow($handle) | Out-Null
[Console]::WriteLine('BRO_WINDOW_ACTIVATED')
`;

// Windows that belong to BRO itself are never listed, matched, or closed.
const BRO_PROCESSES = new Set(['electron.exe']);
const BRO_WINDOW_TITLES = new Set(['bro voice', 'bro overlay', 'bro']);
// Browser windows are closed tab-by-tab (Ctrl+W) and never force-killed, so a
// spoken “close gmail” cannot take the whole browser and its other tabs with it.
const BROWSER_PROCESSES = new Set([
  'chrome.exe', 'msedge.exe', 'firefox.exe', 'brave.exe', 'opera.exe', 'vivaldi.exe',
  'chromium.exe', 'arc.exe', 'waterfox.exe', 'librewolf.exe',
]);
// Windows owned by the operating system. Closing them would take the shell down.
const SHELL_WINDOW_TITLES = new Set([
  'program manager', 'taskbar', 'start', 'search', 'cortana', 'notification center',
  'action center', 'windows input experience', 'settings', 'desktop',
]);
const WINDOW_STOPWORDS = new Set([
  'the', 'a', 'an', 'bro', 'please', 'window', 'windows', 'app', 'application', 'program',
  'software', 'page', 'tab', 'website', 'site', 'this', 'that', 'it', 'my', 'current',
  'active', 'focused', 'foreground', 'open', 'opened', 'close', 'closed', 'screen', 'front',
]);

const WINDOW_NATIVE = String.raw`
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class BroWindowsNative {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
}
"@
`;

// Enumerates every visible top-level window with its owning process, so BRO can
// close “anything that appears on screen” by title instead of guessing.
const LIST_WINDOWS_SCRIPT = `${WINDOW_NATIVE}
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$owners = @{}
Get-Process | ForEach-Object { $owners[[int]$_.Id] = $_.ProcessName }
$found = New-Object System.Collections.ArrayList
$callback = [BroWindowsNative+EnumWindowsProc]{
  param([IntPtr]$hWnd, [IntPtr]$lParam)
  if ([BroWindowsNative]::IsWindowVisible($hWnd)) {
    $length = [BroWindowsNative]::GetWindowTextLength($hWnd)
    if ($length -gt 0) {
      $builder = New-Object System.Text.StringBuilder ($length + 2)
      [void][BroWindowsNative]::GetWindowText($hWnd, $builder, $builder.Capacity)
      $title = $builder.ToString().Trim()
      if ($title) {
        $owner = 0
        [void][BroWindowsNative]::GetWindowThreadProcessId($hWnd, [ref]$owner)
        [void]$found.Add([pscustomobject]@{ hwnd = $hWnd.ToInt64(); pid = [int]$owner; process = [string]$owners[[int]$owner]; title = $title })
      }
    }
  }
  return $true
}
[void][BroWindowsNative]::EnumWindows($callback, [IntPtr]::Zero)
$found | ConvertTo-Json -Compress
`;

const FOREGROUND_WINDOW_SCRIPT = `${WINDOW_NATIVE}
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$handle = [BroWindowsNative]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { [Console]::WriteLine('BRO_NO_FOREGROUND'); exit 0 }
$length = [BroWindowsNative]::GetWindowTextLength($handle)
$builder = New-Object System.Text.StringBuilder ([Math]::Max($length, 1) + 2)
[void][BroWindowsNative]::GetWindowText($handle, $builder, $builder.Capacity)
$owner = 0
[void][BroWindowsNative]::GetWindowThreadProcessId($handle, [ref]$owner)
$proc = (Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName
[pscustomobject]@{ hwnd = $handle.ToInt64(); pid = [int]$owner; process = [string]$proc; title = $builder.ToString().Trim() } | ConvertTo-Json -Compress
`;

function runPowerShell(script, timeout = 8_000) {
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: false,
  });
}

function normalizeWindowText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/\+/g, ' plus ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBroWindow(win) {
  if (!win) return false;
  return BRO_PROCESSES.has(normalizeProcessName(win.process)) || BRO_WINDOW_TITLES.has(normalizeWindowText(win.title));
}

function parseWindowJson(output) {
  let parsed;
  try { parsed = JSON.parse(String(output || '').trim() || '[]'); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  return list
    .filter((item) => item && Number(item.hwnd) && typeof item.title === 'string' && item.title.trim())
    .map((item) => ({
      hwnd: Number(item.hwnd),
      pid: Number(item.pid) || 0,
      process: normalizeProcessName(item.process),
      title: item.title.trim(),
    }));
}

let windowSnapshot = { at: 0, windows: [] };

function listWindows({ force = false, includeBro = false } = {}) {
  if (process.platform !== 'win32') return [];
  const cached = !force && windowSnapshot.windows.length && Date.now() - windowSnapshot.at < 700;
  let windows = windowSnapshot.windows;
  if (!cached) {
    windows = parseWindowJson(runPowerShell(LIST_WINDOWS_SCRIPT, 9_000).stdout);
    windowSnapshot = { at: Date.now(), windows };
  }
  return includeBro ? windows : windows.filter((win) => !isBroWindow(win));
}

// True when a spoken name describes this window: either the whole phrase
// appears in the title, or every meaningful word does.
function windowMatchesText(title, query) {
  const wanted = normalizeWindowText(query);
  if (!wanted) return false;
  const actual = normalizeWindowText(title);
  if (!actual) return false;
  if (actual.includes(wanted)) return true;
  const tokens = wanted.split(' ').filter((token) => token.length >= 3 && !WINDOW_STOPWORDS.has(token));
  if (!tokens.length) return false;
  return tokens.every((token) => actual.includes(token));
}

function findWindows(query, options = {}) {
  if (!String(query || '').trim()) return [];
  return listWindows({ force: true }).filter((win) => {
    if (options.browsersOnly && !BROWSER_PROCESSES.has(win.process)) return false;
    if (SHELL_WINDOW_TITLES.has(normalizeWindowText(win.title))) return false;
    if (windowMatchesText(win.title, query)) return true;
    return Boolean(win.process) && windowMatchesText(win.process.replace(/\.exe$/, ''), query);
  });
}

function postCloseWindows(handles) {
  const list = [...new Set(handles.map((handle) => Number(handle)).filter(Boolean))];
  if (!list.length || process.platform !== 'win32') return;
  const script = `${WINDOW_NATIVE}
$ErrorActionPreference = 'SilentlyContinue'
foreach ($handle in @(${list.join(',')})) {
  [void][BroWindowsNative]::PostMessage([IntPtr]$handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
}
[Console]::WriteLine('BRO_CLOSE_SENT')`;
  runPowerShell(script, 8_000);
}

// Presses Ctrl+W inside one browser window so only that page's tab closes. The
// key is sent only after Windows confirms the target window owns the foreground;
// otherwise the window itself is asked to close.
function closeBrowserTab(hwnd) {
  if (!hwnd || process.platform !== 'win32') return 'none';
  const script = `${WINDOW_NATIVE}
$ErrorActionPreference = 'SilentlyContinue'
$handle = [IntPtr]${Number(hwnd)}
[void][BroWindowsNative]::ShowWindowAsync($handle, 9)
[void][BroWindowsNative]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 180
if ([BroWindowsNative]::GetForegroundWindow() -eq $handle) {
  $shell = New-Object -ComObject WScript.Shell
  $shell.SendKeys('^w')
  [Console]::WriteLine('BRO_TAB_CLOSED')
} else {
  [void][BroWindowsNative]::PostMessage($handle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  [Console]::WriteLine('BRO_WINDOW_CLOSED')
}`;
  const probe = runPowerShell(script, 8_000);
  return /BRO_TAB_CLOSED/.test(probe.stdout || '') ? 'tab' : 'window';
}

// One close routine for a set of windows: ask politely with WM_CLOSE, then
// force only processes that can be replaced without losing user work.
async function closeWindowSet(targets, { force = false } = {}) {
  const unique = [];
  const seen = new Set();
  for (const win of targets || []) {
    if (!win || !win.hwnd || seen.has(win.hwnd)) continue;
    seen.add(win.hwnd);
    unique.push(win);
  }
  if (!unique.length) return { closedWindows: [], remainingWindows: [], closedPids: [] };
  postCloseWindows(unique.map((win) => win.hwnd));
  await delay(900);
  let live = listWindows({ force: true, includeBro: true });
  let remaining = unique.filter((target) => live.some((win) => win.hwnd === target.hwnd));
  const closedPids = [];
  if (remaining.length && force) {
    const killable = remaining.filter((win) => !NO_FORCE_PROCESSES.has(win.process) && !PROMPTABLE_PROCESSES.has(win.process));
    const pids = [...new Set(killable.map((win) => win.pid).filter(Boolean))];
    if (pids.length) {
      for (const pid of pids) spawnSync('taskkill', ['/F', '/PID', String(pid), '/T'], { timeout: 4_000, windowsHide: true });
      closedPids.push(...pids);
      await delay(500);
      live = listWindows({ force: true, includeBro: true });
      remaining = remaining.filter((target) => live.some((win) => win.hwnd === target.hwnd));
    }
  }
  const remainingHandles = new Set(remaining.map((win) => win.hwnd));
  return {
    closedWindows: unique.filter((win) => !remainingHandles.has(win.hwnd)),
    remainingWindows: remaining,
    closedPids,
  };
}

class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
    this.statusCode = 400;
  }
}

function validateHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) throw new ToolError('A URL is required.');
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw new ToolError('That is not a valid URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ToolError('Only http:// and https:// URLs can be opened.');
  }
  return parsed.toString();
}

function normalizeDesktopTarget(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[._-]+/g, ' ').replace(/\s+/g, ' ');
  return WINDOWS_DESKTOP_ALIASES[normalized] || null;
}

function resolveWindowsTarget(value) {
  const key = normalizeDesktopTarget(value) || (typeof value === 'string' && Object.hasOwn(WINDOWS_DESKTOP_TARGETS, value.trim().toLowerCase()) ? value.trim().toLowerCase() : null);
  if (!key) throw new ToolError('That Windows desktop target is not allowlisted.');
  const descriptor = WINDOWS_DESKTOP_TARGETS[key];
  const args = descriptor.folder
    ? [path.join(process.env.USERPROFILE || process.env.HOME || '', descriptor.folder)]
    : [...descriptor.args];
  return { key: descriptor.key, label: descriptor.label, command: descriptor.command, args };
}

function isWithinRoot(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateProjectPath(root, candidate = root) {
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(root); } catch { throw new ToolError('The registered project root no longer exists.'); }
  const absoluteCandidate = path.resolve(candidate);
  if (!fs.existsSync(absoluteCandidate)) throw new ToolError('The requested project path does not exist.');
  let canonicalCandidate;
  try { canonicalCandidate = fs.realpathSync(absoluteCandidate); } catch { throw new ToolError('The requested project path does not exist.'); }
  if (!isWithinRoot(canonicalRoot, canonicalCandidate)) throw new ToolError('The requested path is outside the registered project root.');
  return canonicalCandidate;
}

function openTarget(target, kind) {
  const command = process.platform === 'win32' ? 'cmd.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  // Windows `start` is a cmd built-in; shell:false prevents the target from being parsed by this process.
  const args = process.platform === 'win32' ? ['/d', '/c', 'start', '', target] : [target];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
  child.once('error', () => {});
  child.unref();
  return { opened: true, kind, target };
}

function openUrl(url) {
  const target = validateHttpUrl(url);
  recordOpenedSite(target);
  return openTarget(target, 'url');
}

function openPath(root, requestedPath = root) {
  return openTarget(validateProjectPath(root, requestedPath), 'path');
}

function openTerminal() {
  let command;
  let args;
  if (process.platform === 'win32') {
    command = 'cmd.exe';
    args = [];
  } else if (process.platform === 'darwin') {
    command = 'open';
    args = ['-a', 'Terminal'];
  } else {
    command = 'x-terminal-emulator';
    args = [];
  }
  const child = spawn(command, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
  child.once('error', () => {});
  child.unref();
  return { opened: true, kind: 'terminal', target: process.platform === 'win32' ? 'cmd.exe' : command };
}

function activateBro() {
  if (process.platform !== 'win32') throw new ToolError('The BRO voice overlay activation command is only available on Windows.');
  const probe = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ACTIVATE_BRO_WINDOW_SCRIPT], {
    encoding: 'utf8',
    timeout: 1_500,
    windowsHide: true,
    shell: false,
  });
  if (probe.error) throw new ToolError(`BRO could not be activated: ${probe.error.message}`);
  if (probe.status === 0 && /BRO_WINDOW_ACTIVATED/.test(probe.stdout || '')) {
    return { activated: true, kind: 'bro_voice', target: 'BRO voice', mode: 'shown' };
  }
  const electronPath = process.env.BRO_ELECTRON_PATH || path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
  if (!fs.existsSync(electronPath)) throw new ToolError('BRO voice is not running and the local Electron launcher was not found.');
  const child = spawn(electronPath, ['desktop/main.js'], { cwd: path.join(__dirname, '..'), detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  child.unref();
  return { activated: true, kind: 'bro_voice', target: 'BRO voice', mode: 'started' };
}

function openWindowsTarget(target) {
  if (process.platform !== 'win32') throw new ToolError('Windows desktop targets are only available on Windows.');
  const descriptor = resolveWindowsTarget(target);
  const child = spawn(descriptor.command, descriptor.args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
  child.once('error', () => {});
  child.unref();
  return { opened: true, kind: 'desktop', target: descriptor.key, label: descriptor.label };
}

// Friendly desktop-oriented names are part of the backend integration surface;
// keep the Windows-specific aliases for callers that want to be explicit.
const resolveDesktopTarget = resolveWindowsTarget;
const openDesktopTarget = openWindowsTarget;

// Installed applications are discovered from the Start Menu. BRO only ever
// launches a shortcut it found itself; a spoken name never becomes a path or a
// command line.
const APP_CATALOG = require('./app-catalog.json');
const START_MENU_ROOTS = [
  path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
  path.join(process.env.PROGRAMDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
];
const APP_BLOCKLIST = /(uninstall|unins\d|readme|release notes|documentation|license|website|home page|help|manual|setup|repair|check for|tools for|samples for|diagnostic)/i;
let startMenuCache = { at: 0, apps: [] };
let startAppsCache = { at: 0, apps: [] };

// Store/MSIX apps (ChatGPT, Claude, WhatsApp, …) have no Start Menu .lnk file.
// Get-StartApps lists every Start-visible app with the AppID needed to launch it.
function scanStartApps(force = false) {
  if (process.platform !== 'win32') return [];
  if (!force && startAppsCache.apps.length && Date.now() - startAppsCache.at < 10 * 60_000) return startAppsCache.apps;
  const probe = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress',
  ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
  let parsed = [];
  try { parsed = JSON.parse(String(probe.stdout || '').trim() || '[]'); } catch { parsed = []; }
  if (!Array.isArray(parsed)) parsed = parsed ? [parsed] : [];
  const apps = parsed
    .filter((item) => item && typeof item.Name === 'string' && typeof item.AppID === 'string' && item.AppID.trim())
    .filter((item) => !APP_BLOCKLIST.test(item.Name))
    .map((item) => ({
      name: item.Name.trim(),
      aumid: item.AppID.trim(),
      path: `shell:AppsFolder\\${item.AppID.trim()}`,
      normalized: normalizeAppName(item.Name),
    }))
    .filter((item) => item.normalized);
  startAppsCache = { at: Date.now(), apps };
  return apps;
}

function normalizeAppName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\.lnk$/i, '')
    // Keep “Notepad++” distinct from “Notepad” (and “VS Code” from “VSCode”).
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scanStartMenu(force = false) {
  if (process.platform !== 'win32') return [];
  if (!force && startMenuCache.apps.length && Date.now() - startMenuCache.at < 5 * 60_000) return startMenuCache.apps;
  const apps = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (/\.lnk$/i.test(entry.name) && !APP_BLOCKLIST.test(entry.name)) {
        apps.push({ name: entry.name.replace(/\.lnk$/i, ''), path: full, normalized: normalizeAppName(entry.name) });
      }
    }
  };
  for (const root of START_MENU_ROOTS) if (root) walk(root, 0);
  // Add Store/MSIX apps that do not have a .lnk shortcut.
  const seen = new Set(apps.map((app) => app.normalized));
  for (const app of scanStartApps(force)) {
    if (seen.has(app.normalized)) continue;
    seen.add(app.normalized);
    apps.push(app);
  }
  startMenuCache = { at: Date.now(), apps };
  return apps;
}

function scoreAppName(app, wanted) {
  const query = normalizeAppName(wanted);
  if (!query) return 0;
  if (app.normalized === query) return 100;
  if (app.normalized.startsWith(`${query} `)) return 85;
  if (app.normalized.includes(query)) return 70;
  const tokens = query.split(' ').filter(Boolean);
  const appTokens = new Set(app.normalized.split(' '));
  return tokens.length && tokens.every((token) => appTokens.has(token)) ? 60 : 0;
}

function findInstalledApp(names) {
  if (process.platform !== 'win32') return null;
  const apps = scanStartMenu();
  const wanted = (Array.isArray(names) ? names : [names]).filter(Boolean);
  let best = null;
  let bestScore = 0;
  outer: for (const name of wanted) {
    for (const app of apps) {
      const score = scoreAppName(app, name);
      if (score > bestScore) { best = app; bestScore = score; }
    }
    if (bestScore === 100) break outer;
  }
  return best ? { name: best.name, path: best.path, score: bestScore } : null;
}

function catalogApp(id) {
  return (APP_CATALOG.apps || []).find((app) => app.id === id) || null;
}

function findCatalogApp(id) {
  const entry = catalogApp(id);
  if (!entry) return null;
  const installed = findInstalledApp(Array.isArray(entry.desktop) && entry.desktop.length ? entry.desktop : [entry.label]);
  return { entry, installed };
}

// Processes BRO refuses to terminate, even if a name were spoken.
const PROTECTED_PROCESSES = new Set([
  'explorer.exe', 'powershell.exe', 'pwsh.exe', 'cmd.exe', 'conhost.exe', 'node.exe', 'electron.exe',
  'svchost.exe', 'winlogon.exe', 'csrss.exe', 'wininit.exe', 'lsass.exe', 'services.exe', 'smss.exe',
  'dwm.exe', 'sihost.exe', 'taskhostw.exe', 'fontdrvhost.exe', 'searchhost.exe', 'runtimebroker.exe',
  'startmenuexperiencehost.exe', 'textinputhost.exe', 'shellexperiencehost.exe', 'ctfmon.exe',
  'audiodg.exe', 'spoolsv.exe', 'registry.exe', 'msmpeng.exe', 'securityhealthservice.exe',
]);

// Processes that only exist because BRO is doing something (snapshots, helper
// shells). They must never be mistaken for an app the user opened.
const TRACKING_IGNORE = new Set([
  'tasklist.exe', 'conhost.exe', 'cmd.exe', 'powershell.exe', 'pwsh.exe', 'wscript.exe',
  'cscript.exe', 'dllhost.exe', 'runtimebroker.exe', 'sihost.exe', 'searchhost.exe',
]);

// Apps BRO launched in this session. Each entry remembers the image names, the
// real PIDs, and the actual window handles, so “close” stays precise even for
// Store apps whose process name is not in the catalog.
const OPENED_APPS = new Map();
// Web pages BRO opened in a browser. “close everything” closes these tabs too.
const OPENED_SITES = [];
const shortcutTargetCache = new Map();

// Processes that must never be force-killed: the shell, BRO itself, browsers
// (a forced browser kill loses every tab) and the UWP frame host (shared).
const NO_FORCE_PROCESSES = new Set([
  ...PROTECTED_PROCESSES,
  ...BROWSER_PROCESSES,
  'applicationframehost.exe',
  'searchapp.exe',
  'shellhost.exe',
]);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeProcessName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!name) return '';
  return name.endsWith('.exe') ? name : `${name}.exe`;
}

function shortcutTargetName(lnkPath) {
  if (shortcutTargetCache.has(lnkPath)) return shortcutTargetCache.get(lnkPath);
  if (process.platform !== 'win32' || /^shell:/i.test(String(lnkPath))) return '';
  const script = `$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${String(lnkPath).replace(/'/g, "''")}'); if ($s.TargetPath) { [Console]::WriteLine($s.TargetPath) }`;
  const probe = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 6_000, windowsHide: true });
  const target = (probe.stdout || '').trim();
  const name = target ? normalizeProcessName(path.basename(target)) : '';
  shortcutTargetCache.set(lnkPath, name);
  return name;
}

function processRunning(name) {
  if (process.platform !== 'win32' || !name) return false;
  const probe = spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', timeout: 4_000, windowsHide: true });
  return (probe.stdout || '').toLowerCase().includes(name.toLowerCase());
}

function processAlive(pid) {
  if (process.platform !== 'win32' || !pid) return false;
  const probe = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8', timeout: 4_000, windowsHide: true });
  return new RegExp(`,"${pid}",`).test(probe.stdout || '');
}

function snapshotProcesses() {
  if (process.platform !== 'win32') return new Map();
  const probe = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8_000, windowsHide: true });
  const map = new Map();
  for (const line of String(probe.stdout || '').split(/\r?\n/)) {
    const parts = line.match(/"[^"]*"/g);
    if (!parts || parts.length < 2) continue;
    const name = parts[0].replace(/"/g, '').toLowerCase();
    const pid = Number(parts[1].replace(/"/g, ''));
    if (pid) map.set(pid, name);
  }
  return map;
}

// Watches for the window and processes a launch actually created, so “close”
// stays precise even when the window belongs to a differently named process.
async function trackLaunched(entry, processName, before, beforeWindows) {
  const wanted = normalizeProcessName(processName);
  const collect = (windows) => {
    let found = false;
    for (const win of windows) {
      if (beforeWindows.has(win.hwnd)) continue;
      if (wanted && win.process !== wanted) continue;
      if (!entry.windows.has(win.hwnd)) { entry.windows.set(win.hwnd, win); found = true; }
      if (win.pid) entry.pids.add(win.pid);
      if (win.process) entry.names.add(win.process);
    }
    return found;
  };
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await delay(500);
    const windowFound = collect(listWindows({ force: true }));
    let processFound = false;
    // Without a known image name, only the window owner is attributed to this
    // launch. Scanning every new process could blame an unrelated app.
    if (wanted) {
      const after = snapshotProcesses();
      for (const [pid, name] of after) {
        if (before.has(pid) || TRACKING_IGNORE.has(name) || PROTECTED_PROCESSES.has(name)) continue;
        if (name !== wanted) continue;
        if (!entry.pids.has(pid)) { entry.pids.add(pid); processFound = true; }
        entry.names.add(name);
      }
    }
    // One extra pass catches splash screens that hand off to the real window.
    if ((windowFound || processFound) && attempt >= 1) collect(listWindows({ force: true }));
    if (windowFound || processFound) return entry;
  }
  return entry;
}

function registerOpenApp(key, label) {
  const entry = OPENED_APPS.get(key) || { label, pids: new Set(), names: new Set(), windows: new Map(), openedAt: Date.now() };
  entry.label = label;
  entry.openedAt = Date.now();
  OPENED_APPS.set(key, entry);
  return entry;
}

function launchShortcut(appPath, label, processName = '') {
  if (process.platform !== 'win32') throw new ToolError('Opening desktop applications is only available on Windows.');
  const before = snapshotProcesses();
  const beforeWindows = new Set(listWindows({ force: true }).map((win) => win.hwnd));
  // Store apps are launched through the shell's AppsFolder namespace, not by
  // path, so `start` is the wrong tool for them.
  const child = /^shell:/i.test(appPath)
    ? spawn('explorer.exe', [appPath], { detached: true, stdio: 'ignore', shell: false, windowsHide: true })
    : spawn('cmd.exe', ['/d', '/c', 'start', '', appPath], { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
  child.once('error', () => {});
  child.unref();

  // Register the app immediately (by name) so “close everything” knows about it
  // even before the window watcher has matched anything.
  const primary = normalizeProcessName(processName) || shortcutTargetName(appPath);
  const key = primary || normalizeAppName(label);
  const entry = registerOpenApp(key, label);
  if (primary) entry.names.add(primary);
  trackLaunched(entry, primary, before, beforeWindows).catch(() => {});

  return { opened: true, kind: 'app', target: appPath, label };
}

function openCatalogApp(id) {
  const match = findCatalogApp(id);
  if (!match) throw new ToolError('That application is not in the BRO catalog.');
  if (!match.installed) throw new ToolError(`${match.entry.label} is not installed on this PC.`);
  const primary = Array.isArray(match.entry.processes) && match.entry.processes.length ? match.entry.processes[0] : '';
  return launchShortcut(match.installed.path, match.entry.label, primary);
}

function openStartMenuApp(name) {
  const installed = findInstalledApp(name);
  if (!installed) throw new ToolError(`I could not find an installed app named “${name}”.`);
  return launchShortcut(installed.path, installed.name);
}

// Apps that can hold unsaved documents. They are closed politely and never
// force-terminated, so a pending save prompt is never thrown away.
const PROMPTABLE_PROCESSES = new Set([
  'winword.exe', 'excel.exe', 'powerpnt.exe', 'outlook.exe', 'devenv.exe', 'notepad.exe',
  'notepad++.exe', 'sublime_text.exe', 'code.exe', 'obsidian.exe', 'studio64.exe', 'eclipse.exe',
  'mysqlworkbench.exe', 'blender.exe', 'gimp-2.10.exe', 'gimp-2.8.exe', 'figma.exe',
]);

async function killPids(pids) {
  const alive = [...pids].filter(processAlive);
  if (!alive.length) return { closed: [], remaining: [] };
  for (const pid of alive) spawnSync('taskkill', ['/PID', String(pid), '/T'], { timeout: 4_000, windowsHide: true });
  await delay(900);
  let remaining = alive.filter(processAlive);
  if (remaining.length) {
    for (const pid of remaining) spawnSync('taskkill', ['/F', '/PID', String(pid), '/T'], { timeout: 4_000, windowsHide: true });
    await delay(500);
    remaining = alive.filter(processAlive);
  }
  return { closed: alive.filter((pid) => !remaining.includes(pid)), remaining };
}

// Spoken site names that browser window titles spell differently.
const SITE_HINT_OVERRIDES = Object.freeze({
  gmail: ['gmail'], 'g mail': ['gmail'], 'google mail': ['gmail'],
  youtube: ['youtube'], 'you tube': ['youtube'], 'u tube': ['youtube'],
  whatsapp: ['whatsapp'], 'whats app': ['whatsapp'], 'whatsapp web': ['whatsapp'],
  chatgpt: ['chatgpt'], 'chat gpt': ['chatgpt'], claude: ['claude'],
  github: ['github'], 'git hub': ['github'], linkedin: ['linkedin'], 'linked in': ['linkedin'],
  'google drive': ['google drive'], drive: ['google drive'],
  google: ['google'], notion: ['notion'], figma: ['figma'], spotify: ['spotify'],
  discord: ['discord'], telegram: ['telegram'], 'telegram web': ['telegram'],
});

function siteHints(name, url = '') {
  const hints = new Set();
  const spoken = normalizeWindowText(name);
  if (spoken) hints.add(spoken);
  for (const hint of SITE_HINT_OVERRIDES[spoken] || []) hints.add(hint);
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const parts = host.split('.').filter(Boolean);
    if (parts.length > 1) {
      hints.add(parts.slice(0, -1).join(' '));
      for (const part of parts.slice(0, -1)) if (part.length >= 3) hints.add(part);
    } else if (host) {
      hints.add(host);
    }
  } catch { /* the spoken name is enough */ }
  return [...hints].filter(Boolean);
}

function findBrowserTabs(hints) {
  const windows = listWindows({ force: true });
  return windows.filter((win) => {
    if (!BROWSER_PROCESSES.has(win.process)) return false;
    return hints.some((hint) => windowMatchesText(win.title, hint));
  });
}

// Closes the browser tab that shows a website. “close gmail” closes the Gmail
// tab, not the whole browser; if the tab cannot be targeted, its window is
// asked to close instead.
async function closeWebsite(name, options = {}) {
  if (process.platform !== 'win32') throw new ToolError('Closing browser tabs is only available on Windows.');
  const label = String(options.label || name || 'the web page').trim() || 'the web page';
  const hints = siteHints(name, options.url || '');
  const tabs = findBrowserTabs(hints);
  const result = {
    label,
    kind: 'site',
    closed: false,
    closedProcesses: [],
    closedWindows: [],
    stillRunning: [],
    remainingWindows: [],
    notRunning: [],
    protectedNames: [],
  };
  if (!tabs.length) return result;

  for (const win of tabs) closeBrowserTab(win.hwnd);
  await delay(900);

  const live = listWindows({ force: true });
  let remaining = tabs.filter((win) => {
    const current = live.find((item) => item.hwnd === win.hwnd);
    // A window that survived but shows a different page means the tab closed.
    return Boolean(current) && hints.some((hint) => windowMatchesText(current.title, hint));
  });
  if (remaining.length) {
    const fallback = await closeWindowSet(remaining, { force: false });
    remaining = fallback.remainingWindows;
  }

  const remainingHandles = new Set(remaining.map((win) => win.hwnd));
  result.closedWindows = tabs.filter((win) => !remainingHandles.has(win.hwnd)).map((win) => win.title);
  result.remainingWindows = remaining.map((win) => win.title);
  result.closed = result.closedWindows.length > 0;
  if (result.closed) {
    for (let index = OPENED_SITES.length - 1; index >= 0; index -= 1) {
      if (OPENED_SITES[index].label === label) OPENED_SITES.splice(index, 1);
    }
  }
  return result;
}

// “close this tab”: the foreground browser window loses its active tab.
async function closeForegroundTab(win) {
  const mode = closeBrowserTab(win.hwnd);
  await delay(700);
  const live = listWindows({ force: true, includeBro: true });
  const windowStillOpen = live.some((item) => item.hwnd === win.hwnd);
  const closed = mode === 'tab' || !windowStillOpen;
  return { closedWindows: closed ? [win] : [], remainingWindows: closed ? [] : [win], closedPids: [] };
}

// “close this window” / “close the window” / plain “close”.
async function closeForegroundWindow(options = {}) {
  if (process.platform !== 'win32') throw new ToolError('Closing the active window is only available on Windows.');
  const probe = runPowerShell(FOREGROUND_WINDOW_SCRIPT, 6_000);
  const [win] = parseWindowJson(probe.stdout);
  if (!win) throw new ToolError('I could not find a window in front to close.');
  if (isBroWindow(win)) throw new ToolError('That is my own popup, so I will not close it.');
  if (PROTECTED_PROCESSES.has(win.process) || SHELL_WINDOW_TITLES.has(normalizeWindowText(win.title))) {
    throw new ToolError(`${win.title || win.process} is part of Windows, so BRO will not close it.`);
  }
  const outcome = options.tab && BROWSER_PROCESSES.has(win.process)
    ? await closeForegroundTab(win)
    : await closeWindowSet([win], { force: true });
  return {
    label: win.title || win.process.replace(/\.exe$/, '') || 'the active window',
    kind: 'window',
    closed: outcome.closedWindows.length > 0,
    closedProcesses: outcome.closedPids.map(String),
    closedWindows: outcome.closedWindows.map((item) => item.title),
    stillRunning: [],
    remainingWindows: outcome.remainingWindows.map((item) => item.title),
    notRunning: [],
    protectedNames: [],
  };
}

// “close all windows”: every visible window except Windows itself and BRO.
async function closeAllWindows() {
  if (process.platform !== 'win32') throw new ToolError('Closing windows is only available on Windows.');
  const windows = listWindows({ force: true }).filter((win) => (
    !PROTECTED_PROCESSES.has(win.process) && !SHELL_WINDOW_TITLES.has(normalizeWindowText(win.title))
  ));
  const result = {
    label: 'all open windows',
    kind: 'windows',
    closed: false,
    closedProcesses: [],
    closedWindows: [],
    stillRunning: [],
    remainingWindows: [],
    notRunning: [],
    protectedNames: [],
  };
  if (!windows.length) return result;
  const outcome = await closeWindowSet(windows, { force: true });
  result.closedProcesses = outcome.closedPids.map(String);
  result.closedWindows = outcome.closedWindows.map((win) => win.title);
  result.remainingWindows = outcome.remainingWindows.map((win) => win.title);
  result.closed = result.closedWindows.length > 0;
  return result;
}

// One close routine used by every close command:
//   1. the exact windows and PIDs BRO itself launched (precise, works for Store apps)
//   2. image names from the catalog or the shortcut target
//   3. window titles as a last resort
async function closeApp({ label = 'the app', names = [], pids = [], title = '', kind = 'app', windows = [] } = {}) {
  if (process.platform !== 'win32') throw new ToolError('Closing applications is only available on Windows.');
  const wanted = [...new Set(names.map(normalizeProcessName).filter(Boolean))];
  const protectedNames = wanted.filter((name) => PROTECTED_PROCESSES.has(name));
  const allowedNames = wanted.filter((name) => !PROTECTED_PROCESSES.has(name));
  const labelKey = normalizeAppName(label);

  const trackedPids = new Set(pids);
  const trackedWindows = new Map();
  for (const win of windows) if (win && win.hwnd) trackedWindows.set(win.hwnd, win);
  const isRelated = (entry) => (Boolean(labelKey) && normalizeAppName(entry.label) === labelKey)
    || allowedNames.some((name) => entry.names.has(name));
  for (const entry of OPENED_APPS.values()) {
    if (!isRelated(entry)) continue;
    for (const pid of entry.pids) trackedPids.add(pid);
    for (const [hwnd, win] of entry.windows) trackedWindows.set(hwnd, win);
  }

  const windowResult = trackedWindows.size
    ? await closeWindowSet([...trackedWindows.values()], { force: false })
    : { closedWindows: [], remainingWindows: [] };
  const pidResult = await killPids(trackedPids);

  const running = allowedNames.filter(processRunning);
  const notRunning = allowedNames.filter((name) => !running.includes(name));
  let closedNames = [];
  let stillRunning = [];
  if (running.length) {
    // First pass: ask the app to close so it can save and exit cleanly.
    for (const name of running) spawnSync('taskkill', ['/IM', name, '/T'], { timeout: 5_000, windowsHide: true });
    await delay(1_100);
    let pending = running.filter(processRunning);
    // Tray-only apps (Telegram, Discord, …) are force-closed; document editors
    // are left alone so nothing unsaved is lost.
    const forceable = pending.filter((name) => !PROMPTABLE_PROCESSES.has(name));
    for (const name of forceable) spawnSync('taskkill', ['/F', '/IM', name, '/T'], { timeout: 5_000, windowsHide: true });
    if (forceable.length) await delay(700);
    pending = pending.filter(processRunning);
    // Windows can take a moment to reap a process after the kill request; give
    // it a second look before reporting that the app is still open.
    if (pending.length) {
      await delay(1_500);
      pending = pending.filter(processRunning);
    }
    closedNames = running.filter((name) => !pending.includes(name));
    stillRunning = pending;
  }

  let titleResult = { closedWindows: [], remainingWindows: [] };
  const nothingClosedYet = !windowResult.closedWindows.length && !pidResult.closed.length && !closedNames.length;
  if (title && nothingClosedYet && !stillRunning.length) {
    const matches = findWindows(title).filter((win) => !trackedWindows.has(win.hwnd));
    if (matches.length) titleResult = await closeWindowSet(matches, { force: true });
  }

  const closedWindows = [...windowResult.closedWindows, ...titleResult.closedWindows];
  const remainingWindows = [...windowResult.remainingWindows, ...titleResult.remainingWindows];
  const closed = closedWindows.length > 0 || pidResult.closed.length > 0 || closedNames.length > 0;
  if (closed) {
    for (const [key, entry] of [...OPENED_APPS.entries()]) if (isRelated(entry)) OPENED_APPS.delete(key);
  }

  return {
    label,
    kind,
    closed,
    closedProcesses: [...new Set([...closedNames, ...pidResult.closed.map(String)])],
    closedWindows: closedWindows.map((win) => win.title),
    stillRunning: [...new Set(stillRunning)],
    remainingWindows: remainingWindows.map((win) => win.title),
    notRunning,
    protectedNames,
  };
}

async function closeProcesses(names, options = {}) {
  return closeApp({ label: options.label || 'the app', names, pids: options.pids || [] });
}

async function closeCatalogApp(id) {
  const entry = catalogApp(id);
  if (!entry) throw new ToolError('That application is not in the BRO catalog.');
  if (entry.protected) throw new ToolError(`${entry.label} is part of Windows, so BRO will not close it.`);
  const processes = Array.isArray(entry.processes) ? [...entry.processes] : [];
  if (!processes.length) {
    const match = findCatalogApp(id);
    const resolved = match && match.installed ? shortcutTargetName(match.installed.path) : '';
    if (resolved) processes.push(resolved);
  }
  return closeApp({ label: entry.label, names: processes, title: entry.label });
}

async function closeStartMenuApp(name) {
  const installed = findInstalledApp(name);
  if (!installed) throw new ToolError(`I could not find an installed app named “${name}”.`);
  const processName = shortcutTargetName(installed.path);
  // Even when the shortcut has no readable target (Store apps), the window title
  // gives us a reliable way to close the app.
  return closeApp({ label: installed.name, names: processName ? [processName] : [], title: installed.name });
}

// Last resort: close something that is not in the catalog or the Start Menu, by
// matching a tracked launch, its process name, or any visible window title.
async function closeNamedApp(name) {
  const cleaned = String(name || '').trim();
  if (!cleaned) throw new ToolError('Which app should I close?');
  const labelKey = normalizeAppName(cleaned);
  const tracked = [...OPENED_APPS.values()].find((entry) => normalizeAppName(entry.label) === labelKey);
  if (tracked) {
    return closeApp({
      label: tracked.label,
      names: [...tracked.names],
      pids: [...tracked.pids],
      title: tracked.label,
      windows: [...tracked.windows.values()],
    });
  }
  const exe = normalizeProcessName(cleaned.replace(/\s+/g, ''));
  if (processRunning(exe)) return closeApp({ label: cleaned, names: [exe], title: cleaned });

  const matches = findWindows(cleaned);
  if (matches.length) {
    const outcome = await closeWindowSet(matches, { force: true });
    return {
      label: cleaned,
      kind: 'window',
      closed: outcome.closedWindows.length > 0,
      closedProcesses: outcome.closedPids.map(String),
      closedWindows: outcome.closedWindows.map((win) => win.title),
      stillRunning: [],
      remainingWindows: outcome.remainingWindows.map((win) => win.title),
      notRunning: [],
      protectedNames: [],
    };
  }
  return closeApp({ label: cleaned, names: [exe], title: cleaned });
}

async function closeOpenedApps() {
  const entries = [...OPENED_APPS.values()];
  const sites = [...OPENED_SITES];
  if (!entries.length && !sites.length) {
    return {
      label: 'the apps I opened',
      kind: 'apps',
      closed: false,
      closedProcesses: [],
      closedWindows: [],
      stillRunning: [],
      remainingWindows: [],
      notRunning: [],
      protectedNames: [],
      tracked: [],
    };
  }
  const labels = [...new Set([...entries.map((entry) => entry.label), ...sites.map((site) => site.label)])];
  const merged = {
    closed: false,
    closedProcesses: [],
    closedWindows: [],
    stillRunning: [],
    remainingWindows: [],
    protectedNames: [],
  };
  for (const entry of entries) {
    const result = await closeApp({
      label: entry.label,
      names: [...entry.names],
      pids: [...entry.pids],
      title: entry.label,
      windows: [...entry.windows.values()],
    });
    merged.closed = merged.closed || result.closed;
    merged.closedProcesses.push(...result.closedProcesses);
    merged.closedWindows.push(...result.closedWindows);
    merged.stillRunning.push(...result.stillRunning);
    merged.remainingWindows.push(...result.remainingWindows);
    merged.protectedNames.push(...result.protectedNames);
  }
  for (const site of sites) {
    const result = await closeWebsite(site.label, { label: site.label, url: site.url });
    merged.closed = merged.closed || result.closed;
    merged.closedWindows.push(...result.closedWindows);
    merged.remainingWindows.push(...result.remainingWindows);
  }
  return {
    label: labels.join(', ') || 'the apps I opened',
    kind: 'apps',
    ...merged,
    closedProcesses: [...new Set(merged.closedProcesses)],
    closedWindows: [...new Set(merged.closedWindows)],
    stillRunning: [...new Set(merged.stillRunning)],
    remainingWindows: [...new Set(merged.remainingWindows)],
    tracked: labels,
  };
}

// Remembers a web page BRO opened so “close everything” can close its tab.
function recordOpenedSite(url) {
  let host = '';
  try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { host = ''; }
  const label = host || String(url || '').trim();
  if (!label) return;
  if (OPENED_SITES.some((site) => site.label === label && site.url === url)) return;
  OPENED_SITES.push({ label, url, openedAt: Date.now() });
  while (OPENED_SITES.length > 25) OPENED_SITES.shift();
}

function sanitizedEnvironment() {
  const allowed = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'PATHEXT', 'ComSpec'];
  const env = {};
  for (const key of allowed) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

function runStoredCommand(command, cwd) {
  if (typeof command !== 'string' || !command.trim()) throw new ToolError('Command profile is not configured.');
  validateProjectPath(cwd, cwd);
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      env: sanitizedEnvironment(),
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    const collect = (stream, limit, setter) => {
      stream.on('data', (chunk) => {
        const text = chunk.toString();
        const current = setter === 'stdout' ? stdout : stderr;
        const next = current + text;
        if (next.length > limit) {
          if (setter === 'stdout') { stdout = next.slice(0, limit); stdoutTruncated = true; }
          else { stderr = next.slice(0, limit); stderrTruncated = true; }
        } else if (setter === 'stdout') stdout = next;
        else stderr = next;
      });
    };
    collect(child.stdout, MAX_OUTPUT, 'stdout');
    collect(child.stderr, MAX_OUTPUT, 'stderr');
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, COMMAND_TIMEOUT);
    child.once('error', (error) => { clearTimeout(timer); reject(new ToolError(`Could not start the project profile: ${error.message}`)); });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout, stderr, stdoutTruncated, stderrTruncated });
    });
  });
}

module.exports = {
  findInstalledApp,
  findCatalogApp,
  openCatalogApp,
  openStartMenuApp,
  closeCatalogApp,
  closeStartMenuApp,
  closeNamedApp,
  closeOpenedApps,
  closeProcesses,
  closeWebsite,
  closeForegroundWindow,
  closeAllWindows,
  listWindows,
  findWindows,
  windowMatchesText,
  siteHints,
  scanStartMenu,
  normalizeAppName,
  normalizeWindowText,
  MAX_OUTPUT,
  COMMAND_TIMEOUT,
  ToolError,
  WINDOWS_DESKTOP_TARGETS,
  WINDOWS_DESKTOP_ALIASES,
  resolveDesktopTarget,
  validateHttpUrl,
  normalizeDesktopTarget,
  resolveWindowsTarget,
  isWithinRoot,
  validateProjectPath,
  openUrl,
  openPath,
  openTerminal,
  activateBro,
  openDesktopTarget,
  openWindowsTarget,
  runStoredCommand,
  sanitizedEnvironment
};
