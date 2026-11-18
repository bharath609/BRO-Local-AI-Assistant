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
  pictures: Object.freeze({ key: 'pictures', label: 'Pictures', command: 'explorer.exe', folder: 'Pictures' }),
  device_manager: Object.freeze({ key: 'device_manager', label: 'Device Manager', command: 'devmgmt.msc', args: [] }),
  programs_and_features: Object.freeze({ key: 'programs_and_features', label: 'Programs and Features', command: 'appwiz.cpl', args: [] }),
  network_connections: Object.freeze({ key: 'network_connections', label: 'Network Connections', command: 'ncpa.cpl', args: [] }),
  power_options: Object.freeze({ key: 'power_options', label: 'Power Options', command: 'powercfg.cpl', args: [] }),
  sound_settings: Object.freeze({ key: 'sound_settings', label: 'Sound Settings', command: 'mmsys.cpl', args: [] }),
  mouse_settings: Object.freeze({ key: 'mouse_settings', label: 'Mouse Settings', command: 'main.cpl', args: [] }),
  date_time: Object.freeze({ key: 'date_time', label: 'Date and Time', command: 'timedate.cpl', args: [] }),
  region: Object.freeze({ key: 'region', label: 'Region', command: 'intl.cpl', args: [] }),
  internet_options: Object.freeze({ key: 'internet_options', label: 'Internet Options', command: 'inetcpl.cpl', args: [] }),
  system_information: Object.freeze({ key: 'system_information', label: 'System Information', command: 'msinfo32.exe', args: [] }),
  event_viewer: Object.freeze({ key: 'event_viewer', label: 'Event Viewer', command: 'eventvwr.msc', args: [] }),
  disk_management: Object.freeze({ key: 'disk_management', label: 'Disk Management', command: 'diskmgmt.msc', args: [] }),
  services: Object.freeze({ key: 'services', label: 'Services', command: 'services.msc', args: [] }),
  printers: Object.freeze({ key: 'printers', label: 'Printers and Devices', command: 'control.exe', args: ['printers'] })
});

const WINDOWS_DESKTOP_ALIASES = Object.freeze({
  'recycle bin': 'recycle_bin', 'recyclebin': 'recycle_bin',
  'this pc': 'this_pc', 'my computer': 'this_pc', computer: 'this_pc',
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
  pictures: 'pictures', 'pictures folder': 'pictures', 'my pictures': 'pictures',
  'device manager': 'device_manager',
  'programs and features': 'programs_and_features', 'add or remove programs': 'programs_and_features',
  'uninstall programs': 'programs_and_features',
  'network connections': 'network_connections', 'network adapters': 'network_connections',
  'power options': 'power_options',
  'sound settings': 'sound_settings', 'sound control panel': 'sound_settings',
  'mouse settings': 'mouse_settings', 'mouse properties': 'mouse_settings',
  'date and time': 'date_time', 'date time': 'date_time', 'time and date': 'date_time',
  region: 'region', 'region and language': 'region',
  'internet options': 'internet_options',
  'system information': 'system_information',
  'event viewer': 'event_viewer',
  'disk management': 'disk_management',
  services: 'services',
  printers: 'printers', 'devices and printers': 'printers', 'printer settings': 'printers'
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
// Always-on-top helper widgets (dictation bars, input panels) are not pages and
// never receive scrolling.
const OVERLAY_PROCESSES = new Set([
  'wispr flow.exe', 'textinputhost.exe', 'searchhost.exe', 'shellexperiencehost.exe',
  'startmenuexperiencehost.exe', 'applicationframehost.exe',
]);
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
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);
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
$front = [BroWindowsNative]::GetForegroundWindow()
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
        $rect = New-Object BroWindowsNative+RECT
        [void][BroWindowsNative]::GetWindowRect($hWnd, [ref]$rect)
        [void]$found.Add([pscustomobject]@{ hwnd = $hWnd.ToInt64(); pid = [int]$owner; process = [string]$owners[[int]$owner]; title = $title; width = [int]($rect.Right - $rect.Left); height = [int]($rect.Bottom - $rect.Top); foreground = ($hWnd -eq $front); minimized = [BroWindowsNative]::IsIconic($hWnd) })
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

function runPowerShell(script, timeout = 8_000, extraEnv = null) {
  return spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    shell: false,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    maxBuffer: 4 * 1024 * 1024,
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
      width: Number(item.width) || 0,
      height: Number(item.height) || 0,
      foreground: Boolean(item.foreground),
      minimized: Boolean(item.minimized),
    }));
}

let windowSnapshot = { at: 0, windows: [] };

// The app or page window BRO opened most recently. Spoken follow-ups such as
// “scroll down” act on it, because while BRO talks its own popup owns the
// foreground and the browser is not technically “active”.
let lastOpenedWindow = { hwnd: 0, at: 0, title: '', process: '' };

function rememberOpenedWindow(win) {
  if (!win || !win.hwnd) return;
  lastOpenedWindow = { hwnd: Number(win.hwnd), at: Date.now(), title: win.title || '', process: win.process || '' };
}

// Watches for the window a launch just created. Uses the foreground flag and
// then the newest handle, so a page opened in an already-running browser is
// still found without snapshotting every window before the launch.
function trackOpenedWindow({ browsersOnly = false } = {}) {
  let attempt = 0;
  const tick = () => {
    attempt += 1;
    let list = [];
    try { list = listWindows({ force: true }); } catch { return; }
    const candidates = browsersOnly ? list.filter((win) => BROWSER_PROCESSES.has(win.process)) : list;
    if (!candidates.length) {
      if (attempt < 6) setTimeout(tick, 500);
      return;
    }
    const front = candidates.find((win) => win.foreground && !win.minimized);
    const newest = candidates.reduce((best, win) => (win.hwnd > (best ? best.hwnd : 0) ? win : best), null);
    rememberOpenedWindow(front || newest);
  };
  setTimeout(tick, 500);
}

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
    if (!options.includeShell && SHELL_WINDOW_TITLES.has(normalizeWindowText(win.title))) return false;
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

// Chromium browsers accept --start-maximized, which creates the window already
// full screen. Opening the URL through `start` first made the browser paint a
// small window and only then grow it, which looked like a “mini tab”.
const CHROMIUM_BROWSERS = new Set(['chrome.exe', 'msedge.exe', 'brave.exe', 'vivaldi.exe', 'opera.exe', 'chromium.exe', 'arc.exe', 'librewolf.exe']);
let defaultBrowserCache = { at: 0, info: null };

function readRegistryValue(key, valueName) {
  try {
    const args = valueName ? ['query', key, '/v', valueName] : ['query', key, '/ve'];
    const probe = spawnSync('reg.exe', args, { encoding: 'utf8', timeout: 4_000, windowsHide: true });
    if (probe.status !== 0) return '';
    const match = String(probe.stdout || '').match(/REG_SZ\s+(.+?)\s*$/m);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

// Finds the user's default browser executable so BRO can launch it maximized.
function defaultBrowser() {
  if (process.platform !== 'win32') return null;
  if (defaultBrowserCache.info && Date.now() - defaultBrowserCache.at < 60_000) return defaultBrowserCache.info;
  let info = null;
  const progId = readRegistryValue('HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', 'ProgId');
  if (progId) {
    const command = readRegistryValue(`HKCU\\Software\\Classes\\${progId}\\shell\\open\\command`, '');
    const quoted = command.match(/"([^"]+\.exe)"/i);
    const bare = command.match(/^([^\s]+\.exe)/i);
    const exe = (quoted && quoted[1]) || (bare && bare[1]) || '';
    if (exe && fs.existsSync(exe)) info = { exe, progId };
  }
  defaultBrowserCache = { at: Date.now(), info };
  return info;
}

// Opens a URL directly in the default browser, already maximized, when the
// browser supports it. Returns the browser name, or '' when the plain shell
// route should be used instead.
function launchBrowserMaximized(url) {
  if (process.platform !== 'win32') return '';
  const browser = defaultBrowser();
  if (!browser) return '';
  const name = path.basename(browser.exe).toLowerCase();
  const args = CHROMIUM_BROWSERS.has(name) ? ['--start-maximized', '--new-window', url] : null;
  if (!args) return '';
  try {
    const child = spawn(browser.exe, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
    child.once('error', () => {});
    child.unref();
    return name;
  } catch {
    return '';
  }
}

function openUrl(url) {
  const target = validateHttpUrl(url);
  recordOpenedSite(target);
  const browser = launchBrowserMaximized(target);
  trackOpenedWindow({ browsersOnly: true });
  if (browser) return { opened: true, kind: 'url', target, browser, maximized: true };
  return openTarget(target, 'url');
}

function openPath(root, requestedPath = root) {
  return openTarget(validateProjectPath(root, requestedPath), 'path');
}

// ---- YouTube playback ------------------------------------------------------
// “play <video name>” should actually play the top result instead of leaving
// you on a search page. YouTube's own result page is fetched and the first
// real video is opened directly. Any network problem falls back to search.

const YOUTUBE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

async function findYouTubeVideo(query, { timeoutMs = 6000 } = {}) {
  const text = String(query || '').trim();
  if (!text || typeof fetch !== 'function') return null;
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(text)}`;
  const lookupUrl = `${searchUrl}&sp=EgIQAQ%253D%253D&hl=en`;
  let html;
  try {
    const response = await fetch(lookupUrl, {
      headers: {
        'user-agent': YOUTUBE_UA,
        'accept-language': 'en-US,en;q=0.9',
        cookie: 'CONSENT=YES+1',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  }
  const match = html.match(/"videoRenderer"\s*:\s*\{\s*"videoId"\s*:\s*"([A-Za-z0-9_-]{11})"/);
  if (!match) return null;
  const id = match[1];
  let title = '';
  const at = html.indexOf(`"videoId":"${id}"`);
  if (at >= 0) {
    const around = html.slice(at, at + 4000);
    const titleMatch = around.match(/"title"\s*:\s*\{\s*"runs"\s*:\s*\[\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (titleMatch) {
      try { title = JSON.parse(`"${titleMatch[1]}"`); } catch { title = titleMatch[1]; }
    }
  }
  return {
    id,
    title,
    url: `https://www.youtube.com/watch?v=${id}`,
    searchUrl,
  };
}

// ---- User file search ------------------------------------------------------
// “open report.pdf” or, while a folder is open, “open my resume”: BRO looks in
// the user's own folders only. Paths supplied by the model or by the caller
// are never trusted; openUserFile re-validates every path against these roots.

const USER_FILE_FOLDERS = ['Desktop', 'Downloads', 'Documents', 'Pictures', 'Videos', 'Music'];

function userFileRoots(preferredFolder = '') {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (!home) return [];
  const bases = [home, path.join(home, 'OneDrive')];
  const roots = [];
  const push = (dir) => {
    if (!dir || roots.includes(dir)) return;
    try { if (fs.existsSync(dir)) roots.push(dir); } catch { /* ignore */ }
  };
  const wanted = String(preferredFolder || '').trim();
  if (wanted) for (const base of bases) push(path.join(base, wanted));
  for (const folder of USER_FILE_FOLDERS) for (const base of bases) push(path.join(base, folder));
  return roots;
}

const SEARCH_USER_FILES_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$query = [string]$env:BRO_FILE_QUERY
if (-not $query) { [Console]::WriteLine('[]'); exit 0 }
$roots = @($env:BRO_FILE_ROOTS | ConvertFrom-Json)
$pattern = '*' + [System.Management.Automation.WildcardPattern]::Escape($query) + '*'
$results = New-Object System.Collections.ArrayList
foreach ($root in $roots) {
  if ($results.Count -ge 30) { break }
  if (-not (Test-Path -LiteralPath $root)) { continue }
  $take = 30 - $results.Count
  Get-ChildItem -LiteralPath $root -Recurse -Depth 3 -File -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like $pattern } |
    Select-Object -First $take |
    ForEach-Object {
      [void]$results.Add([pscustomobject]@{
        path = $_.FullName
        name = $_.Name
        dir = $_.DirectoryName
        size = $_.Length
        modified = $_.LastWriteTimeUtc.ToString('o')
      })
    }
}
$results | ConvertTo-Json -Compress
`;

function normalizeFileQuery(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function scoreUserFile(file, query, preferredFolder = '') {
  const q = normalizeFileQuery(query);
  const name = normalizeFileQuery(file.name);
  const stem = name.replace(/\.[^.]+$/, '');
  let score;
  if (name === q) score = 100;
  else if (stem === q) score = 96;
  else if (name.startsWith(q)) score = 86;
  else if (stem.startsWith(q)) score = 83;
  else if (name.includes(q)) score = 66;
  else score = 40;
  if (preferredFolder && normalizeFileQuery(file.dir).includes(normalizeFileQuery(preferredFolder))) score += 12;
  if (file.modified) {
    const ageDays = (Date.now() - Date.parse(file.modified)) / 86_400_000;
    if (Number.isFinite(ageDays) && ageDays < 30) score += 3;
  }
  return score;
}

// Returns the best matching file (or null) from the user's folders.
function findUserFile(query, { folder = '' } = {}) {
  if (process.platform !== 'win32') return null;
  const wanted = String(query || '').trim();
  if (!wanted) return null;
  const roots = userFileRoots(folder);
  if (!roots.length) return null;
  const probe = runPowerShell(SEARCH_USER_FILES_SCRIPT, 15_000, {
    BRO_FILE_QUERY: wanted,
    BRO_FILE_ROOTS: JSON.stringify(roots),
  });
  let parsed;
  try { parsed = JSON.parse(String(probe.stdout || '').trim() || '[]'); } catch { return null; }
  const items = (Array.isArray(parsed) ? parsed : parsed ? [parsed] : [])
    .filter((item) => item && item.path && item.name)
    .map((item) => ({ path: String(item.path), name: String(item.name), dir: String(item.dir || ''), size: Number(item.size) || 0, modified: String(item.modified || '') }));
  if (!items.length) return null;
  items.sort((a, b) => {
    const byScore = scoreUserFile(b, wanted, folder) - scoreUserFile(a, wanted, folder);
    if (byScore !== 0) return byScore;
    return Date.parse(b.modified || 0) - Date.parse(a.modified || 0);
  });
  return items[0];
}

// Opens a file that was found by findUserFile. The path is re-checked so a
// stale or crafted value cannot open something outside the user's folders.
function openUserFile(filePath) {
  const absolute = path.resolve(String(filePath || ''));
  if (!fs.existsSync(absolute)) throw new ToolError('That file is no longer there.');
  let canonical;
  try { canonical = fs.realpathSync(absolute); } catch { throw new ToolError('That file is no longer there.'); }
  const allowed = userFileRoots().some((root) => {
    try { return isWithinRoot(fs.realpathSync(root), canonical); } catch { return false; }
  });
  if (!allowed) throw new ToolError('BRO only opens files inside your Desktop, Downloads, Documents, Pictures, Videos, or Music folders.');
  return openTarget(canonical, 'file');
}

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/, '')
    .trim();
}

// Creates a folder inside one of the user's own folders (Downloads by default
// when the caller does not name one). Never accepts a path from speech.
function createUserFolder(name, folder = '') {
  const safe = sanitizeFileName(name);
  if (!safe) throw new ToolError('Tell me what to name the folder.');
  const wanted = String(folder || '').trim();
  const roots = userFileRoots(wanted);
  const base = roots.find((root) => !wanted || path.basename(root).toLowerCase() === wanted.toLowerCase()) || roots[0];
  if (!base) throw new ToolError('I could not find that folder in your user folders.');
  const target = path.join(base, safe);
  if (!isWithinRoot(base, target) || target === base) throw new ToolError('That folder name is not allowed.');
  if (fs.existsSync(target)) throw new ToolError(`“${safe}” already exists in ${path.basename(base)}.`);
  fs.mkdirSync(target, { recursive: false });
  return { created: true, name: safe, path: target, folder: path.basename(base) };
}

// Renames a file BRO already opened. The new name is sanitized and the path is
// re-validated against the user's folders.
function renameUserFile(filePath, newName) {
  const safe = sanitizeFileName(newName);
  if (!safe) throw new ToolError('Tell me the new file name.');
  const absolute = path.resolve(String(filePath || ''));
  if (!fs.existsSync(absolute)) throw new ToolError('That file is no longer there.');
  let canonical;
  try { canonical = fs.realpathSync(absolute); } catch { throw new ToolError('That file is no longer there.'); }
  const allowed = userFileRoots().some((root) => {
    try { return isWithinRoot(fs.realpathSync(root), canonical); } catch { return false; }
  });
  if (!allowed) throw new ToolError('BRO only renames files inside your own folders.');
  const directory = path.dirname(canonical);
  const hasExtension = path.extname(safe) !== '';
  const finalName = hasExtension ? safe : `${safe}${path.extname(canonical)}`;
  const target = path.join(directory, finalName);
  if (target === canonical) throw new ToolError('That is already the file name.');
  if (fs.existsSync(target)) throw new ToolError(`“${finalName}” already exists in that folder.`);
  fs.renameSync(canonical, target);
  return { renamed: true, from: canonical, path: target, name: finalName };
}

// Opens a specific Windows Settings page. Only ms-settings URIs are accepted so
// a spoken sentence can never supply an arbitrary command or path.
function openSettings(uri) {
  if (process.platform !== 'win32') throw new ToolError('Windows Settings is only available on Windows.');
  const target = String(uri || 'ms-settings:').trim();
  if (!/^ms-settings:[a-z0-9-]*$/i.test(target)) throw new ToolError('That settings page is not supported.');
  const child = spawn('cmd.exe', ['/c', 'start', '', target], { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
  child.once('error', () => {});
  child.unref();
  return { opened: true, uri: target };
}

// Moves a file BRO opened into the Recycle Bin (recoverable) instead of
// deleting it outright. The path is re-validated against the user folders.
function recycleFile(filePath) {
  if (process.platform !== 'win32') throw new ToolError('Deleting files is only available on Windows.');
  const absolute = path.resolve(String(filePath || ''));
  if (!fs.existsSync(absolute)) throw new ToolError('That file is no longer there.');
  let canonical;
  try { canonical = fs.realpathSync(absolute); } catch { throw new ToolError('That file is no longer there.'); }
  const allowed = userFileRoots().some((root) => {
    try { return isWithinRoot(fs.realpathSync(root), canonical); } catch { return false; }
  });
  if (!allowed) throw new ToolError('BRO only moves files from your own folders to the Recycle Bin.');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile(
  $env:BRO_FILE_PATH,
  [Microsoft.VisualBasic.FileIO.UIOption]::OnlyErrorDialogs,
  [Microsoft.VisualBasic.FileIO.RecycleOption]::SendToRecycleBin
)
[Console]::WriteLine('BRO_RECYCLE_OK')
`;
  const probe = runPowerShell(script, 15_000, { BRO_FILE_PATH: canonical });
  if (!String(probe.stdout || '').includes('BRO_RECYCLE_OK')) {
    throw new ToolError(`Windows could not move “${path.basename(canonical)}” to the Recycle Bin.`);
  }
  return { recycled: true, name: path.basename(canonical), path: canonical };
}

function emptyRecycleBin() {
  if (process.platform !== 'win32') throw new ToolError('The Recycle Bin is only available on Windows.');
  const probe = runPowerShell('Clear-RecycleBin -Force -ErrorAction Stop; [Console]::WriteLine("BRO_RECYCLE_EMPTY")', 20_000);
  if (!String(probe.stdout || '').includes('BRO_RECYCLE_EMPTY')) throw new ToolError('Windows could not empty the Recycle Bin.');
  return { emptied: true };
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
  // .msc and .cpl tools (Device Manager, Services, …) are documents, not
  // executables, so hand them to the shell with `start` instead of spawning
  // them directly (spawning a .msc fails with EFTYPE).
  const spawnArgs = ['/d', '/c', 'start', '', descriptor.command, ...descriptor.args];
  let child;
  try {
    child = spawn('cmd.exe', spawnArgs, { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
  } catch (error) {
    throw new ToolError(`Windows could not open ${descriptor.label}: ${error.message}`);
  }
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
// Shortcuts and executables the user keeps on the Desktop, plus apps installed
// per-user (VS Code, Zoom, Teams, …) that may not appear in the Start Menu.
const DESKTOP_APP_ROOTS = [
  path.join(process.env.USERPROFILE || '', 'Desktop'),
  path.join(process.env.OneDrive || '', 'Desktop'),
  path.join(process.env.OneDriveConsumer || '', 'Desktop'),
  path.join(process.env.OneDriveCommercial || '', 'Desktop'),
  path.join(process.env.PUBLIC || '', 'Desktop'),
];
const USER_PROGRAM_ROOTS = [
  path.join(process.env.LOCALAPPDATA || '', 'Programs'),
];
const APP_BLOCKLIST = /(uninstall|unins\d|readme|release notes|documentation|license|website|home page|help|manual|setup|repair|check for|tools for|samples for|diagnostic)/i;
const EXE_BLOCKLIST = /^(?:unins\d*|setup|install|update|updater|helper|crashpad|crashreporter|elevate|vc_?redist|x86_?redist|dxsetup|python|pythonw|node|npm|npx|7z|7za|ffmpeg|ffplay)(?:\.exe)?$/i;
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
  const seen = new Set();
  const addApp = (name, fullPath) => {
    const clean = String(name || '').trim();
    if (!clean || APP_BLOCKLIST.test(clean)) return;
    const normalized = normalizeAppName(clean);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    apps.push({ name: clean, path: fullPath, normalized });
  };
  const walkShortcuts = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkShortcuts(full, depth + 1);
      else if (/\.lnk$/i.test(entry.name)) addApp(entry.name.replace(/\.lnk$/i, ''), full);
    }
  };
  const walkExecutables = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!/^(?:uninstall|update|updater|crash|logs?|resources|locales?|plugins?|extensions?|node_modules|\.git)$/i.test(entry.name)) {
          walkExecutables(full, depth + 1);
        }
      } else if (/\.exe$/i.test(entry.name) && !EXE_BLOCKLIST.test(entry.name)) {
        addApp(entry.name.replace(/\.exe$/i, ''), full);
      }
    }
  };
  for (const root of START_MENU_ROOTS) if (root) walkShortcuts(root, 0);
  for (const root of DESKTOP_APP_ROOTS) if (root) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (entry.isDirectory()) continue;
      const full = path.join(root, entry.name);
      if (/\.lnk$/i.test(entry.name)) addApp(entry.name.replace(/\.lnk$/i, ''), full);
      else if (/\.exe$/i.test(entry.name) && !EXE_BLOCKLIST.test(entry.name)) addApp(entry.name.replace(/\.exe$/i, ''), full);
    }
  }
  for (const root of USER_PROGRAM_ROOTS) if (root) walkExecutables(root, 0);
  // Add Store/MSIX apps that do not have a .lnk shortcut.
  for (const app of scanStartApps(force)) {
    if (seen.has(app.normalized)) continue;
    seen.add(app.normalized);
    apps.push(app);
  }
  startMenuCache = { at: Date.now(), apps };
  return apps;
}

// Spoken short names that differ from the installed app's name.
const APP_QUERY_ALIASES = Object.freeze({
  'vs code': 'visual studio code',
  vscode: 'visual studio code',
  'vs': 'visual studio',
  'ms teams': 'microsoft teams',
  teams: 'microsoft teams',
  chrome: 'google chrome',
  edge: 'microsoft edge',
  word: 'microsoft word',
  excel: 'microsoft excel',
  powerpoint: 'microsoft powerpoint',
  outlook: 'microsoft outlook',
  onenote: 'microsoft onenote',
  photoshop: 'adobe photoshop',
  'acrobat reader': 'adobe acrobat reader',
  'after effects': 'adobe after effects',
});

function normalizeAppQuery(value) {
  const base = normalizeAppName(value);
  if (!base) return [];
  const alias = APP_QUERY_ALIASES[base];
  return alias && alias !== base ? [base, alias] : [base];
}

function scoreAppName(app, wanted) {
  const queries = normalizeAppQuery(wanted);
  if (!queries.length) return 0;
  let best = 0;
  for (const query of queries) {
    if (app.normalized === query) return 100;
    if (app.normalized.startsWith(`${query} `)) best = Math.max(best, 85);
    else if (app.normalized.includes(query)) best = Math.max(best, 70);
    else {
      const tokens = query.split(' ').filter(Boolean);
      const appTokens = new Set(app.normalized.split(' '));
      if (tokens.length && tokens.every((token) => appTokens.has(token))) best = Math.max(best, 60);
      // “SQLiteStudio” spoken as “sqlite studio”, or “OpenCode” as “open code”.
      const compactQuery = query.replace(/\s+/g, '');
      const compactApp = app.normalized.replace(/\s+/g, '');
      if (compactQuery && compactQuery === compactApp) best = Math.max(best, 95);
      else if (compactQuery && compactApp.includes(compactQuery)) best = Math.max(best, 75);
    }
  }
  return best;
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
  if (/\.exe$/i.test(String(lnkPath))) {
    const name = normalizeProcessName(path.basename(lnkPath));
    shortcutTargetCache.set(lnkPath, name);
    return name;
  }
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
      if (!entry.windows.has(win.hwnd)) {
        entry.windows.set(win.hwnd, win);
        found = true;
        rememberOpenedWindow(win);
      }
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
    : spawn('cmd.exe', ['/d', '/c', 'start', '/MAX', '', appPath], { detached: true, stdio: 'ignore', shell: false, windowsHide: true });
  child.once('error', () => {});
  child.unref();

  // Register the app immediately (by name) so "close everything" knows about it
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

// Brings back, minimizes, maximizes, or restores a window by name (or — for a
// website BRO opened — the topmost browser window). This is what powers
// references like “check it once”, “bring that back”, or “minimize it”.
const WINDOW_CONTROL_COMMANDS = Object.freeze({ restore: 9, minimize: 6, maximize: 3 });

function controlWindow(target, mode = 'focus') {
  if (process.platform !== 'win32') throw new ToolError('Window control is only available on Windows.');
  const wanted = typeof target === 'string' ? { label: target } : (target || {});
  const label = String(wanted.label || wanted.name || wanted.id || '').trim();
  const wantedMode = String(mode || 'focus').toLowerCase();
  const command = WINDOW_CONTROL_COMMANDS[wantedMode] || 9;

  let matches = label ? findWindows(label, { includeShell: Boolean(wanted.includeShell) }) : [];
  if (!matches.length && (wanted.kind === 'site' || wanted.kind === 'website')) {
    // The page title changes once the user clicks into it, so fall back to the
    // browser window that is currently in front.
    matches = listWindows({ force: true }).filter((win) => BROWSER_PROCESSES.has(win.process));
  }
  const win = matches[0];
  if (!win) {
    throw new ToolError(`I could not find the window for “${label || 'that'}”. It may already be closed.`);
  }

  // “focus” must never resize: SW_RESTORE (9) un-maximizes a maximized window,
  // which is what made “scroll down” shrink the page before scrolling it. Only
  // a minimized window is restored; everything else keeps its current size.
  const focus = wantedMode === 'focus' || wantedMode === 'restore' || wantedMode === 'maximize';
  const showWindow = wantedMode === 'focus'
    ? `if ([BroWindowControl]::IsIconic($handle)) { [void][BroWindowControl]::ShowWindowAsync($handle, 9) }
else { [void][BroWindowControl]::ShowWindowAsync($handle, 5) }`
    : `[void][BroWindowControl]::ShowWindowAsync($handle, ${command})`;
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BroWindowControl {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr processId);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
}
"@
$handle = [IntPtr]${Number(win.hwnd)}
${showWindow}
${focus ? `
$foreground = [BroWindowControl]::GetForegroundWindow()
$foregroundThread = [BroWindowControl]::GetWindowThreadProcessId($foreground, [IntPtr]::Zero)
$targetThread = [BroWindowControl]::GetWindowThreadProcessId($handle, [IntPtr]::Zero)
[void][BroWindowControl]::AttachThreadInput($foregroundThread, $targetThread, $true)
[void][BroWindowControl]::SetForegroundWindow($handle)
[void][BroWindowControl]::BringWindowToTop($handle)
[void][BroWindowControl]::AttachThreadInput($foregroundThread, $targetThread, $false)
Start-Sleep -Milliseconds 120` : ''}
[Console]::WriteLine('BRO_WINDOW_CONTROL_OK')
`;
  runPowerShell(script, 8_000);
  if (wantedMode === 'focus' || wantedMode === 'maximize') rememberOpenedWindow(win);
  return {
    label: win.title || win.process.replace(/\.exe$/, ''),
    window: win.title,
    process: win.process,
    hwnd: win.hwnd,
    mode: wantedMode,
    controlled: true,
  };
}

// Windows that apps restore at their old (often small) size look like they
// opened "minimized". After BRO opens something, grow the window to the
// monitor's work area unless it is already nearly full size. The decision is
// made in PowerShell from the real window and monitor rectangles so dialogs
// and genuinely small windows are left alone when they already fill the screen.
const MAXIMIZE_NATIVE = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BroMaximize {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, ref uint processId);
}
"@
`;

function maximizeWindowByHwnd(hwnd, { threshold = 0.95 } = {}) {
  const handle = Number(hwnd);
  if (!handle || process.platform !== 'win32') return { maximized: false };
  const script = `${MAXIMIZE_NATIVE}
$handle = [IntPtr]${handle}
if ([BroMaximize]::IsZoomed($handle)) { [Console]::WriteLine('BRO_ALREADY_MAXIMIZED'); exit 0 }
$rect = New-Object BroMaximize+RECT
[void][BroMaximize]::GetWindowRect($handle, [ref]$rect)
$monitor = [BroMaximize]::MonitorFromWindow($handle, 2)
$info = New-Object BroMaximize+MONITORINFO
$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
[void][BroMaximize]::GetMonitorInfo($monitor, [ref]$info)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$workWidth = $info.rcWork.Right - $info.rcWork.Left
$workHeight = $info.rcWork.Bottom - $info.rcWork.Top
if ($width -le 0 -or $height -le 0 -or $workWidth -le 0 -or $workHeight -le 0) { [Console]::WriteLine('BRO_MAXIMIZE_SKIPPED'); exit 0 }
if (($width -lt ($workWidth * ${Number(threshold)})) -or ($height -lt ($workHeight * ${Number(threshold)}))) {
  [void][BroMaximize]::ShowWindowAsync($handle, 3)
  [Console]::WriteLine('BRO_MAXIMIZED')
} else {
  [Console]::WriteLine('BRO_ALREADY_LARGE')
}`;
  let stdout = '';
  try { stdout = runPowerShell(script, 8_000).stdout || ''; } catch { /* best effort */ }
  return {
    maximized: /BRO_MAXIMIZED/.test(stdout),
    alreadyMaximized: /BRO_ALREADY_MAXIMIZED/.test(stdout),
    alreadyLarge: /BRO_ALREADY_LARGE/.test(stdout),
  };
}

// Maximizes whichever window currently owns the foreground, unless that window
// belongs to BRO itself. Used after a website opens in the browser.
function maximizeForegroundWindow({ threshold = 0.95 } = {}) {
  if (process.platform !== 'win32') return { maximized: false };
  const script = `${MAXIMIZE_NATIVE}
$handle = [BroMaximize]::GetForegroundWindow()
if ($handle -eq [IntPtr]::Zero) { [Console]::WriteLine('BRO_MAXIMIZE_SKIPPED'); exit 0 }
[uint32]$owner = 0
[void][BroMaximize]::GetWindowThreadProcessId($handle, [ref]$owner)
$proc = Get-Process -Id $owner -ErrorAction SilentlyContinue
if ($proc -and $proc.ProcessName -eq 'electron') { [Console]::WriteLine('BRO_MAXIMIZE_SKIPPED'); exit 0 }
if ([BroMaximize]::IsZoomed($handle)) { [Console]::WriteLine('BRO_ALREADY_MAXIMIZED'); exit 0 }
$rect = New-Object BroMaximize+RECT
[void][BroMaximize]::GetWindowRect($handle, [ref]$rect)
$monitor = [BroMaximize]::MonitorFromWindow($handle, 2)
$info = New-Object BroMaximize+MONITORINFO
$info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
[void][BroMaximize]::GetMonitorInfo($monitor, [ref]$info)
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$workWidth = $info.rcWork.Right - $info.rcWork.Left
$workHeight = $info.rcWork.Bottom - $info.rcWork.Top
if ($width -le 0 -or $height -le 0 -or $workWidth -le 0 -or $workHeight -le 0) { [Console]::WriteLine('BRO_MAXIMIZE_SKIPPED'); exit 0 }
if (($width -lt ($workWidth * ${Number(threshold)})) -or ($height -lt ($workHeight * ${Number(threshold)}))) {
  [void][BroMaximize]::ShowWindowAsync($handle, 3)
  [Console]::WriteLine('BRO_MAXIMIZED')
} else {
  [Console]::WriteLine('BRO_ALREADY_LARGE')
}`;
  let stdout = '';
  try { stdout = runPowerShell(script, 8_000).stdout || ''; } catch { /* best effort */ }
  return {
    maximized: /BRO_MAXIMIZED/.test(stdout),
    alreadyMaximized: /BRO_ALREADY_MAXIMIZED/.test(stdout),
    alreadyLarge: /BRO_ALREADY_LARGE/.test(stdout),
  };
}

// ---- Bringing opened windows forward --------------------------------------
// Launching through `start` can leave the new window behind the current one.
// These helpers wait briefly for the window to appear, focus it, and then keep
// the BRO overlay above it without stealing keyboard focus back from the app.

async function focusOpenedWindow(labels, {
  attempts = 8,
  delayMs = 500,
  maximize = process.env.BRO_MAXIMIZE_OPENS !== '0',
} = {}) {
  if (process.platform !== 'win32') return { focused: false };
  const candidates = (Array.isArray(labels) ? labels : [labels])
    .map((label) => String(label || '').trim())
    .filter(Boolean);
  if (!candidates.length) return { focused: false };
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const label of candidates) {
      let matches = [];
      try { matches = findWindows(label, { includeShell: true }); } catch { matches = []; }
      if (!matches.length) continue;
      try {
        const focused = controlWindow({ label: matches[0].title, includeShell: true }, 'focus');
        const sized = maximize ? maximizeWindowByHwnd(matches[0].hwnd) : { maximized: false };
        return { focused: true, label: matches[0].title, maximized: Boolean(sized.maximized), hwnd: matches[0].hwnd };
      } catch { /* try the next candidate or retry */ }
    }
    if (attempt < attempts - 1) await delay(delayMs);
  }
  return { focused: false };
}

function raiseBroOverlay() {
  if (process.platform !== 'win32') return { raised: false };
  const windows = listWindows({ force: true, includeBro: true })
    .filter((win) => /electron/i.test(win.process || '') && /^(?:bro\s*(?:voice|overlay).*)$/i.test(win.title || ''));
  if (!windows.length) return { raised: false };
  for (const win of windows) {
    const script = `${WINDOW_NATIVE}
$handle = [IntPtr]${Number(win.hwnd)}
[void][BroWindowsNative]::SetWindowPos($handle, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010)
[Console]::WriteLine('BRO_TOPMOST_OK')`;
    try { runPowerShell(script, 5_000); } catch { /* best effort */ }
  }
  return { raised: true, count: windows.length };
}

// ---- Universal desktop controls -------------------------------------------
// These power the application-control skill: keyboard shortcuts, media keys,
// scrolling, screenshots, UI Automation clicks, folders, and system actions.

const SEND_KEYS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($env:BRO_KEYS)
[Console]::WriteLine('BRO_KEYS_OK')
`;

// Characters SendKeys treats as commands must be wrapped in braces.
function escapeSendKeys(value) {
  return String(value == null ? '' : value)
    .replace(/[+^%~()[\]{}]/g, (ch) => `{${ch}}`)
    .replace(/\r?\n/g, '{ENTER}');
}

function sendKeys(sequence) {
  if (process.platform !== 'win32') throw new ToolError('Sending keys is only available on Windows.');
  const keys = String(sequence || '');
  if (!keys) throw new ToolError('There are no keys to send.');
  const probe = runPowerShell(SEND_KEYS_SCRIPT, 6_000, { BRO_KEYS: keys });
  if (!String(probe.stdout || '').includes('BRO_KEYS_OK')) {
    throw new ToolError(`Windows did not accept the key command (${String(probe.stderr || '').trim() || 'unknown error'}).`);
  }
  return { sent: keys };
}

function typeText(value) {
  const text = String(value == null ? '' : value);
  if (!text.trim()) throw new ToolError('There is no text to type.');
  return sendKeys(escapeSendKeys(text));
}

const KEY_NAMES = {
  enter: '{ENTER}', return: '{ENTER}', escape: '{ESC}', esc: '{ESC}', tab: '{TAB}',
  space: ' ', backspace: '{BACKSPACE}', delete: '{DELETE}', insert: '{INSERT}',
  up: '{UP}', down: '{DOWN}', left: '{LEFT}', right: '{RIGHT}',
  home: '{HOME}', end: '{END}', 'page up': '{PGUP}', pgup: '{PGUP}',
  'page down': '{PGDN}', pgdn: '{PGDN}', 'caps lock': '{CAPSLOCK}',
};

const MODIFIER_NAMES = { control: '^', ctrl: '^', alt: '%', shift: '+', windows: '', win: '', meta: '' };

function keySequenceFor(words) {
  const parts = String(words || '').toLowerCase().trim().split(/[\s+-]+/).filter(Boolean);
  let prefix = '';
  let key = null;
  for (const part of parts) {
    if (Object.hasOwn(MODIFIER_NAMES, part)) {
      prefix += MODIFIER_NAMES[part];
      continue;
    }
    if (Object.hasOwn(KEY_NAMES, part)) { key = KEY_NAMES[part]; continue; }
    if (/^f(?:[1-9]|1\d|2[0-4])$/.test(part)) { key = `{${part.toUpperCase()}}`; continue; }
    if (part.length === 1) { key = part; continue; }
    key = `{${part.toUpperCase()}}`;
  }
  if (!key) throw new ToolError('I did not recognise that key.');
  return `${prefix}${key}`;
}

const MEDIA_KEYS = {
  play_pause: 0xB3, play: 0xB3, pause: 0xB3, stop: 0xB2,
  next: 0xB0, previous: 0xB1, mute: 0xAD, volume_up: 0xAF, volume_down: 0xAE,
};

const MEDIA_KEY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BroMediaKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
$code = [byte][int]$env:BRO_MEDIA_VK
[BroMediaKeys]::keybd_event($code, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 70
[BroMediaKeys]::keybd_event($code, 0, 2, [UIntPtr]::Zero)
[Console]::WriteLine('BRO_MEDIA_OK')
`;

function mediaKey(name) {
  if (process.platform !== 'win32') throw new ToolError('Media keys are only available on Windows.');
  const key = String(name || '').toLowerCase();
  const code = MEDIA_KEYS[key];
  if (!code) throw new ToolError('That media key is not supported.');
  const probe = runPowerShell(MEDIA_KEY_SCRIPT, 6_000, { BRO_MEDIA_VK: String(code) });
  if (!String(probe.stdout || '').includes('BRO_MEDIA_OK')) throw new ToolError('Windows did not accept the media key.');
  return { key, sent: true };
}

// Windows-key shortcuts (Start, Task View, Run, Quick Settings, clipboard,
// emoji picker, …) cannot be typed through SendKeys, so they are sent as real
// virtual-key events. An empty combo taps the Windows key on its own.
const WIN_KEY_CODES = {
  tab: 0x09, escape: 0x1B, esc: 0x1B, space: 0x20, enter: 0x0D,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28, home: 0x24, end: 0x23,
  insert: 0x2D, delete: 0x2E, backspace: 0x08, period: 0xBE, dot: 0xBE,
  comma: 0xBC, plus: 0xBB, minus: 0xBD, printscreen: 0x2C, 'print screen': 0x2C,
};

const WIN_KEY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BroWinKeyNative {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[BroWinKeyNative]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
$vk = [int]$env:BRO_WIN_VK
if ($vk -gt 0) {
  [BroWinKeyNative]::keybd_event([byte]$vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 60
  [BroWinKeyNative]::keybd_event([byte]$vk, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
}
[BroWinKeyNative]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
[Console]::WriteLine('BRO_WINKEY_OK')
`;

function pressWindowsKey(combo = '') {
  if (process.platform !== 'win32') throw new ToolError('Windows shortcuts are only available on Windows.');
  const key = String(combo || '').toLowerCase().trim();
  let vk = 0;
  if (key) {
    if (/^[a-z]$/.test(key)) vk = key.toUpperCase().charCodeAt(0);
    else if (/^[0-9]$/.test(key)) vk = key.charCodeAt(0);
    else if (Object.hasOwn(WIN_KEY_CODES, key)) vk = WIN_KEY_CODES[key];
    else throw new ToolError('That Windows shortcut is not supported.');
  }
  const probe = runPowerShell(WIN_KEY_SCRIPT, 6_000, { BRO_WIN_VK: String(vk) });
  if (!String(probe.stdout || '').includes('BRO_WINKEY_OK')) throw new ToolError('Windows did not accept the shortcut.');
  return { keys: key || 'windows', sent: true };
}

const SCROLL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BroScrollNative {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
}
"@
# Prefer the window BRO resolved for the command. Falling back to the foreground
# window would scroll BRO's own popup, because BRO is in front while it talks.
$handle = [IntPtr]::Zero
if ($env:BRO_SCROLL_HWND) { $handle = [IntPtr][long]$env:BRO_SCROLL_HWND }
if ($handle -eq [IntPtr]::Zero) { $handle = [BroScrollNative]::GetForegroundWindow() }
if ($handle -eq [IntPtr]::Zero) { [Console]::WriteLine('BRO_SCROLL_NO_WINDOW'); exit 0 }
# Restoring is only for a window the user really minimized; a maximized window
# stays maximized, so scrolling never shrinks the page.
if ([BroScrollNative]::IsIconic($handle)) {
  [void][BroScrollNative]::ShowWindowAsync($handle, 9)
  Start-Sleep -Milliseconds 250
}
$rect = New-Object BroScrollNative+RECT
[void][BroScrollNative]::GetWindowRect($handle, [ref]$rect)
$origin = New-Object BroScrollNative+POINT
[void][BroScrollNative]::GetCursorPos([ref]$origin)
# Aim at the middle of the content area (below the title bar and toolbar) so
# lists such as Gmail and YouTube scroll no matter where the pointer was.
$x = [int](($rect.Left + $rect.Right) / 2)
$y = [int]($rect.Top + (($rect.Bottom - $rect.Top) * 0.55))
[void][BroScrollNative]::SetCursorPos($x, $y)
$flags = [uint32]$env:BRO_SCROLL_FLAGS
$delta = [int]$env:BRO_SCROLL_DELTA
$notches = [int]$env:BRO_SCROLL_NOTCHES
for ($i = 0; $i -lt $notches; $i++) {
  [BroScrollNative]::mouse_event($flags, 0, 0, $delta, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 18
}
# Put the pointer back where the user left it.
[void][BroScrollNative]::SetCursorPos($origin.X, $origin.Y)
[Console]::WriteLine('BRO_SCROLL_OK')
`;

// Picks the window the user means when they say “scroll down”. Ranked: the real
// window in front (BRO's popup and always-on-top helper widgets are ignored),
// then the page or app BRO just opened, then the front-most ordinary window.
function scrollTargetWindow() {
  if (process.platform !== 'win32') return null;
  let windows = [];
  try { windows = listWindows({ force: true }); } catch { return null; }
  const usable = windows.filter((win) => {
    if (SHELL_WINDOW_TITLES.has(normalizeWindowText(win.title))) return false;
    if (OVERLAY_PROCESSES.has(win.process)) return false;
    return (win.width || 0) >= 320 && (win.height || 0) >= 240;
  });
  const front = usable.find((win) => win.foreground && !win.minimized);
  if (front) return front;
  const remembered = usable.find((win) => win.hwnd === lastOpenedWindow.hwnd);
  if (remembered) return remembered;
  return usable[0] || null;
}

// One wheel notch is 120 units. A positive vertical delta scrolls up (the
// content moves down), so "down" must be negative — the earlier implementation
// had this backwards. Horizontal scrolling uses MOUSEEVENTF_HWHEEL.
function scrollActiveWindow(direction = 'down', amount = 0) {
  if (process.platform !== 'win32') throw new ToolError('Scrolling is only available on Windows.');
  const dir = String(direction || 'down').toLowerCase();
  const fallback = dir === 'left' || dir === 'right' ? 4 : 5;
  const notches = Math.max(1, Math.min(30, Math.round(Number(amount) || fallback)));
  const horizontal = dir === 'left' || dir === 'right';
  const forward = dir === 'up' || dir === 'right';
  const target = scrollTargetWindow();
  const probe = runPowerShell(SCROLL_SCRIPT, 12_000, {
    BRO_SCROLL_FLAGS: horizontal ? '4096' : '2048',
    BRO_SCROLL_DELTA: String(forward ? 120 : -120),
    BRO_SCROLL_NOTCHES: String(notches),
    BRO_SCROLL_HWND: target ? String(target.hwnd) : '',
  });
  const stdout = String(probe.stdout || '');
  if (stdout.includes('BRO_SCROLL_NO_WINDOW')) throw new ToolError('I could not find a window to scroll.');
  if (!stdout.includes('BRO_SCROLL_OK')) throw new ToolError('Windows did not scroll the active window.');
  return { direction: dir, notches, window: target ? target.title : '' };
}

const SCREENSHOT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$dir = Join-Path ([Environment]::GetFolderPath('MyPictures')) 'BRO Screenshots'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bitmap.Size)
$name = 'BRO ' + (Get-Date -Format 'yyyy-MM-dd HH-mm-ss') + '.png'
$file = Join-Path $dir $name
$bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
[Console]::WriteLine($file)
`;

function takeScreenshot() {
  if (process.platform !== 'win32') throw new ToolError('Screenshots are only available on Windows.');
  const probe = runPowerShell(SCREENSHOT_SCRIPT, 15_000);
  const file = String(probe.stdout || '').trim().split(/\r?\n/).pop();
  if (!file || !fs.existsSync(file)) throw new ToolError('Windows could not save the screenshot.');
  return { saved: true, path: file, name: path.basename(file) };
}

const SHOW_DESKTOP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BroShowDesktop {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
[BroShowDesktop]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
[BroShowDesktop]::keybd_event(0x44, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 80
[BroShowDesktop]::keybd_event(0x44, 0, 2, [UIntPtr]::Zero)
[BroShowDesktop]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)
[Console]::WriteLine('BRO_DESKTOP_OK')
`;

function showDesktop() {
  if (process.platform !== 'win32') throw new ToolError('Showing the desktop is only available on Windows.');
  const probe = runPowerShell(SHOW_DESKTOP_SCRIPT, 6_000);
  if (!String(probe.stdout || '').includes('BRO_DESKTOP_OK')) throw new ToolError('Windows did not show the desktop.');
  return { shown: true };
}

const UI_CLICK_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class BroUiClickNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
}
"@
$handle = [BroUiClickNative]::GetForegroundWindow()
if (-not $handle) { [Console]::WriteLine('NOT_FOUND'); exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
if (-not $root) { [Console]::WriteLine('NOT_FOUND'); exit 0 }

function Invoke-Element($element) {
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return $true
  } catch { }
  try {
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
    $pattern.Select()
    return $true
  } catch { }
  try {
    $point = $element.GetClickablePoint()
    [void][BroUiClickNative]::SetCursorPos([int]$point.X, [int]$point.Y)
    $flags = 0x0002 -bor 0x0004
    if ($env:BRO_UI_BUTTON -eq 'right') { $flags = 0x0008 -bor 0x0010 }
    [BroUiClickNative]::mouse_event($flags, 0, 0, 0, [UIntPtr]::Zero)
    if ($env:BRO_UI_DOUBLE -eq '1') { [BroUiClickNative]::mouse_event($flags, 0, 0, 0, [UIntPtr]::Zero) }
    return $true
  } catch { return $false }
}

$element = $null
if ($env:BRO_UI_FIRST -eq '1') {
  $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $candidates = New-Object System.Collections.ArrayList
  $unread = New-Object System.Collections.ArrayList
  foreach ($item in $all) {
    try {
      $type = $item.Current.ControlType.ProgrammaticName
      $name = [string]$item.Current.Name
      if (-not $name -or $name.Length -lt 3) { continue }
      if (-not $item.Current.IsEnabled -or $item.Current.IsOffscreen) { continue }
      if ($type -notmatch 'ListItem|DataItem|Hyperlink') { continue }
      if ($name -match '^(inbox|sent|starred|drafts|spam|trash|compose|search|settings|help|more|menu|back|forward|reload|home|notifications|messaging|jobs|my network)$') { continue }
      $rect = $item.Current.BoundingRectangle
      if ($rect.Width -lt 60 -or $rect.Height -lt 12) { continue }
      [void]$candidates.Add([pscustomobject]@{ Element = $item; Top = $rect.Top; Left = $rect.Left })
      if ($name -match 'unread') { [void]$unread.Add([pscustomobject]@{ Element = $item; Top = $rect.Top; Left = $rect.Left }) }
    } catch { }
  }
  if ($env:BRO_UI_UNREAD -eq '1') {
    if ($unread.Count -eq 0) { [Console]::WriteLine('NOT_FOUND'); exit 0 }
    $candidates = $unread
  }
  $ordered = $candidates | Sort-Object Top, Left
  if ($ordered.Count -gt 0) { $element = $ordered[0].Element }
} else {
  $name = [string]$env:BRO_UI_NAME
  $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)
  $element = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
  if (-not $element) {
    $all = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($item in $all) {
      try {
        if ([string]$item.Current.Name -like "*$name*" -and $item.Current.IsEnabled -and -not $item.Current.IsOffscreen) { $element = $item; break }
      } catch { }
    }
  }
}

if (-not $element) { [Console]::WriteLine('NOT_FOUND'); exit 0 }
if (Invoke-Element $element) { [Console]::WriteLine('BRO_CLICK_OK') } else { [Console]::WriteLine('NOT_FOUND') }
`;

function clickElement(name, { button = 'left', double = false } = {}) {
  if (process.platform !== 'win32') throw new ToolError('Clicking UI elements is only available on Windows.');
  const label = String(name || '').trim();
  if (!label) throw new ToolError('Which visible label should I click?');
  const probe = runPowerShell(UI_CLICK_SCRIPT, 20_000, { BRO_UI_NAME: label, BRO_UI_BUTTON: button, BRO_UI_FIRST: '0', BRO_UI_DOUBLE: double ? '1' : '0' });
  if (!String(probe.stdout || '').includes('BRO_CLICK_OK')) throw new ToolError(`I could not find a visible “${label}” to click.`);
  return { clicked: true, name: label, button, double };
}

function clickFirstResult({ unread = false } = {}) {
  if (process.platform !== 'win32') throw new ToolError('Clicking UI elements is only available on Windows.');
  const probe = runPowerShell(UI_CLICK_SCRIPT, 20_000, { BRO_UI_NAME: '', BRO_UI_BUTTON: 'left', BRO_UI_FIRST: '1', BRO_UI_DOUBLE: '0', BRO_UI_UNREAD: unread ? '1' : '0' });
  if (!String(probe.stdout || '').includes('BRO_CLICK_OK')) {
    throw new ToolError(unread
      ? 'I could not identify an unread item on screen. Open the inbox first, then try again.'
      : 'I could not identify the first result on screen. Try “click …” with the exact visible label.');
  }
  return { clicked: true, first: true, unread: Boolean(unread) };
}

function lockWorkstation() {
  if (process.platform !== 'win32') throw new ToolError('Locking the PC is only available on Windows.');
  const probe = runPowerShell("rundll32.exe user32.dll,LockWorkStation", 5_000);
  if (probe.error) throw new ToolError('Windows did not lock the session.');
  return { locked: true };
}

function systemPower(mode) {
  if (process.platform !== 'win32') throw new ToolError('Power control is only available on Windows.');
  const wanted = String(mode || '').toLowerCase();
  if (wanted !== 'shutdown' && wanted !== 'restart') throw new ToolError('Only shutdown and restart are supported.');
  const flag = wanted === 'restart' ? '/r' : '/s';
  const probe = spawnSync('shutdown.exe', [flag, '/t', '0'], { encoding: 'utf8', timeout: 5_000, windowsHide: true });
  if (probe.error) throw new ToolError(`Windows did not accept the ${wanted} request.`);
  return { mode: wanted, requested: true };
}

// ---- One close routine used by every close command:
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
  controlWindow,
  findUserFile,
  openUserFile,
  userFileRoots,
  USER_FILE_FOLDERS,
  findYouTubeVideo,
  createUserFolder,
  renameUserFile,
  openSettings,
  recycleFile,
  emptyRecycleBin,
  focusOpenedWindow,
  maximizeWindowByHwnd,
  maximizeForegroundWindow,
  raiseBroOverlay,
  sendKeys,
  typeText,
  keySequenceFor,
  mediaKey,
  pressWindowsKey,
  scrollActiveWindow,
  takeScreenshot,
  showDesktop,
  clickElement,
  clickFirstResult,
  lockWorkstation,
  systemPower,
  escapeSendKeys,
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
