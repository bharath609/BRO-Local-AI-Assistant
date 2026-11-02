const { app, BrowserWindow, globalShortcut, ipcMain, session, shell, screen } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

// Guard against the very common mistake of starting this file with plain
// `node desktop/main.js`. Under plain Node the Electron APIs are undefined and
// the app dies with a confusing TypeError. Fail clearly and point at the right
// launch command instead.
if (!app || typeof app.requestSingleInstanceLock !== 'function') {
  console.error('BRO must be started with Electron, not plain Node.');
  console.error('Run:  npm.cmd run desktop');
  console.error('Or double-click start-bro-overlay.cmd in the project folder.');
  process.exit(1);
}

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4280;
const requestedPort = Number(process.env.BRO_PORT || DEFAULT_PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : DEFAULT_PORT;
const ORIGIN = `http://${HOST}:${PORT}`;
const appRoot = path.resolve(__dirname, '..');

let backendProcess;
let overlayWindow;
let nativeHotkeyProcess;
let hotkeyRetryTimer;
let windowMaximizerProcess;
let lastHotkeyAt = 0;
let electronHotkeyRegistered = false;
const HOTKEY = process.env.BRO_HOTKEY || 'Control+Alt+B';
const backgroundLaunch = process.argv.includes('--background');
const hasSingleInstanceLock = app.requestSingleInstanceLock();

const WINDOWS_HOTKEY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class BroNativeHotkey {
  [StructLayout(LayoutKind.Sequential)] private struct Point { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] private struct Msg { public IntPtr HWnd; public uint Message; public UIntPtr WParam; public IntPtr LParam; public uint Time; public Point Pt; }
  [DllImport("user32.dll", SetLastError = true)] private static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint key);
  [DllImport("user32.dll")] private static extern bool UnregisterHotKey(IntPtr hWnd, int id);
  [DllImport("user32.dll")] private static extern int GetMessage(out Msg message, IntPtr hWnd, uint min, uint max);
  [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);

  private static bool Down(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }

  public static void Run() {
    const int hotkeyId = 0x4252;
    const uint modAlt = 0x0001;
    const uint modControl = 0x0002;
    const uint modNoRepeat = 0x4000;
    const uint vkB = 0x42;
    if (RegisterHotKey(IntPtr.Zero, hotkeyId, modControl | modAlt | modNoRepeat, vkB)) {
      Console.WriteLine("BRO_NATIVE_HOTKEY_REGISTERED");
      Console.Out.Flush();
      Msg message;
      while (GetMessage(out message, IntPtr.Zero, 0, 0) > 0) {
        if (message.Message == 0x0312 && message.WParam.ToUInt32() == hotkeyId) {
          Console.WriteLine("BRO_NATIVE_HOTKEY_TRIGGERED");
          Console.Out.Flush();
        }
      }
      UnregisterHotKey(IntPtr.Zero, hotkeyId);
      return;
    }

    Console.WriteLine("BRO_NATIVE_HOTKEY_REGISTER_FAILED:" + Marshal.GetLastWin32Error());
    Console.Out.Flush();
    bool wasDown = false;
    while (true) {
      bool isDown = Down(0x11) && Down(0x12) && Down(0x42);
      if (isDown && !wasDown) {
        Console.WriteLine("BRO_NATIVE_HOTKEY_TRIGGERED");
        Console.Out.Flush();
      }
      wasDown = isDown;
      Thread.Sleep(25);
    }
  }
}
"@
  [BroNativeHotkey]::Run()
} catch {
  [Console]::Error.WriteLine(('BRO_NATIVE_HOTKEY_ERROR:' + $_.Exception.Message))
  exit 1
}
`;

// The renderer creates short-lived AudioContexts for microphone capture when
// the hotkey fires, which is not a DOM user gesture. Without this switch
// Chromium can leave those contexts suspended.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function backendReady() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: HOST, port: PORT, path: '/api/bootstrap', timeout: 700 }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => request.destroy());
  });
}

async function startBackendIfNeeded() {
  if (await backendReady()) return true;

  backendProcess = spawn(process.env.BRO_NODE_PATH || 'node', [path.join(appRoot, 'server.js')], {
    cwd: appRoot,
    env: { ...process.env, BRO_PORT: String(PORT) },
    stdio: 'ignore',
    windowsHide: true,
  });
  backendProcess.on('error', (error) => console.error(`BRO backend process could not start: ${error.message}`));

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await backendReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function getCompactOverlaySize() {
  // Compact popup pinned to the top-center of the screen, still large enough
  // to show the full status + transcript + reply without clipping.
  return { width: 320, height: 158 };
}

function createOverlayWindow(showWhenReady = !backgroundLaunch) {
  // Calculate top-center position for a compact popup. The display metrics come
  // from Electron's `screen` module — never from the window, which does not
  // exist yet at this point.
  const { width: winWidth, height: winHeight } = getCompactOverlaySize();
  let area = { x: 0, y: 0, width: 1920, height: 1080 };
  try {
    const display = screen.getPrimaryDisplay();
    area = (display && (display.workArea || display.bounds)) || area;
  } catch {
    // Fall back to sane defaults if the display is not queryable yet.
  }
  const screenWidth = area.width || 1920;
  const x = Math.max(0, Math.min(screenWidth - winWidth, Math.round((screenWidth - winWidth) / 2)));
  const y = Math.max(0, area.y || 0); // top of the usable screen area

  overlayWindow = new BrowserWindow({
    width: winWidth,
    height: winHeight,
    minWidth: winWidth,
    minHeight: winHeight,
    maxWidth: winWidth + 40,
    maxHeight: winHeight + 40,
    resizable: false,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    title: 'BRO overlay',
    x: x,
    y: y,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.webContents.on('console-message', (event, ...args) => {
    const message = event && typeof event.message === 'string' ? event.message : args[1];
    console.log(`BRO renderer: ${message}`);
  });
  overlayWindow.webContents.on('render-process-gone', (_event, details) => console.error(`BRO renderer stopped: ${details.reason}`));
  overlayWindow.webContents.on('unresponsive', () => console.warn('BRO renderer is not responding'));
  overlayWindow.webContents.on('preload-error', (_event, preloadPath, error) => console.error(`BRO preload error (${preloadPath}): ${error}`));
  overlayWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === `${ORIGIN}/` || url.startsWith(`${ORIGIN}/?`)) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  overlayWindow.loadURL(`${ORIGIN}/overlay.html`);
  overlayWindow.once('ready-to-show', () => {
    if (showWhenReady && overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.show();
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      if (typeof overlayWindow.moveTop === 'function') overlayWindow.moveTop();
    }
  });
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function activateOverlay() {
  const now = Date.now();
  if (now - lastHotkeyAt < 600) return;
  lastHotkeyAt = now;
  console.log('BRO hotkey triggered');
  if (!overlayWindow) {
    createOverlayWindow(true);
    signalHotkeyWhenReady();
    return;
  }
  overlayHidden = false;
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.setOpacity(1);
  if (overlayWindow.isMinimized()) overlayWindow.restore();
  overlayWindow.show();
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  if (typeof overlayWindow.moveTop === 'function') overlayWindow.moveTop();
  overlayWindow.focus();
  overlayWindow.webContents.focus();
  signalHotkeyWhenReady();
}

function signalHotkeyWhenReady() {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  const send = () => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send('bro-hotkey');
      console.log('BRO hotkey sent to voice popup');
    }
  };
  if (overlayWindow.webContents.isLoading()) overlayWindow.webContents.once('did-finish-load', send);
  else send();
}

function registerHotkeys() {
  // Electron's global shortcut is the primary path. The PowerShell helper is a
  // fallback for Windows environments where Electron cannot register the key.
  if (registerElectronHotkey()) return;
  if (process.platform === 'win32' && !process.env.BRO_HOTKEY) {
    startWindowsHotkey();
    scheduleHotkeyRetry();
  }
}

function registerElectronHotkey() {
  if (electronHotkeyRegistered) return true;
  electronHotkeyRegistered = globalShortcut.register(HOTKEY, activateOverlay);
  console.log(electronHotkeyRegistered ? `BRO hotkey registered: ${HOTKEY}` : `BRO hotkey unavailable: ${HOTKEY}`);
  return electronHotkeyRegistered;
}

function scheduleHotkeyRetry() {
  if (hotkeyRetryTimer || electronHotkeyRegistered) return;
  hotkeyRetryTimer = setInterval(() => {
    if (registerElectronHotkey()) {
      clearInterval(hotkeyRetryTimer);
      hotkeyRetryTimer = null;
      if (nativeHotkeyProcess) stopWindowsHotkey();
    }
  }, 3_000);
}

function startWindowsHotkey() {
  if (nativeHotkeyProcess) return;
  nativeHotkeyProcess = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_HOTKEY_SCRIPT], {
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  nativeHotkeyProcess.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || '';
    for (const line of lines) {
      if (line === 'BRO_NATIVE_HOTKEY_REGISTERED') console.log('BRO hotkey registered: Ctrl+Alt+B (native Windows)');
      if (line.startsWith('BRO_NATIVE_HOTKEY_REGISTER_FAILED:')) console.warn(`BRO native hotkey registration failed; using key-state fallback (${line.slice('BRO_NATIVE_HOTKEY_REGISTER_FAILED:'.length)})`);
      if (line === 'BRO_NATIVE_HOTKEY_TRIGGERED') activateOverlay();
    }
  });
  nativeHotkeyProcess.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  nativeHotkeyProcess.once('error', (error) => {
    if (nativeHotkeyProcess) nativeHotkeyProcess = null;
    console.error(`BRO native hotkey could not start: ${error.message}`);
    registerElectronHotkey();
    if (!electronHotkeyRegistered) scheduleHotkeyRetry();
  });
  nativeHotkeyProcess.once('close', (code) => {
    if (!nativeHotkeyProcess) return;
    nativeHotkeyProcess = null;
    if (code !== 0) {
      console.error(`BRO native hotkey stopped (${code}): ${stderr.trim() || 'unknown error'}`);
      registerElectronHotkey();
      if (!electronHotkeyRegistered) scheduleHotkeyRetry();
    }
  });
}

function stopWindowsHotkey() {
  if (!nativeHotkeyProcess) return;
  const child = nativeHotkeyProcess;
  nativeHotkeyProcess = null;
  child.kill();
}

// Windows restores each app at its previous size. This tiny watcher maximizes
// new normal windows system-wide (whether BRO opened them or the user did),
// while leaving dialogs, shell UI, the BRO popup, and already-open windows
// alone. It runs only while BRO is running.
function startWindowMaximizer() {
  if (process.platform !== 'win32' || process.env.BRO_AUTO_MAXIMIZE_WINDOWS === '0') return;
  if (windowMaximizerProcess) return;
  const scriptPath = path.join(appRoot, 'scripts', 'maximize-new-windows.ps1');
  if (!fs.existsSync(scriptPath)) {
    console.warn('BRO window maximizer script is missing; windows will keep their own size.');
    return;
  }
  windowMaximizerProcess = spawn('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-WindowStyle', 'Hidden', '-File', scriptPath,
  ], {
    cwd: appRoot,
    stdio: 'ignore',
    windowsHide: true,
    shell: false,
  });
  windowMaximizerProcess.once('error', (error) => {
    windowMaximizerProcess = null;
    console.error(`BRO window maximizer could not start: ${error.message}`);
  });
  windowMaximizerProcess.once('close', (code) => {
    windowMaximizerProcess = null;
    if (code !== 0) console.error(`BRO window maximizer stopped (${code}).`);
  });
  console.log('BRO window maximizer: new windows will open maximized');
}

function stopWindowMaximizer() {
  if (!windowMaximizerProcess) return;
  const child = windowMaximizerProcess;
  windowMaximizerProcess = null;
  try { child.kill(); } catch { /* already gone */ }
}

function configureAutoLaunch() {
  if (process.platform !== 'win32' || typeof app.setLoginItemSettings !== 'function') return;
  const entryScript = process.defaultApp ? path.resolve(process.argv[1]) : '';
  const settings = {
    openAtLogin: true,
    // Windows Run values need paths with spaces quoted explicitly in args.
    args: process.defaultApp ? [`"${entryScript}"`, '--background'] : ['--background'],
  };
  if (process.defaultApp) settings.path = process.execPath;
  app.setLoginItemSettings(settings);
  const status = app.getLoginItemSettings({ path: settings.path || process.execPath, args: settings.args });
  console.log(`BRO auto-start enabled for Windows login: ${status.openAtLogin ? 'on' : 'off'}`);
}

ipcMain.on('bro-close-overlay', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
});

// The popup "hides" by fading to zero opacity instead of calling hide().
// A hidden BrowserWindow makes Chromium stop feeding the wake-word audio graph,
// which is why the wake word appeared dead after the popup disappeared. Keeping
// the window visible-but-transparent keeps microphone capture alive.
let overlayHidden = false;
ipcMain.on('bro-hide-overlay', () => {
  if (!overlayWindow || overlayWindow.isDestroyed() || overlayHidden) return;
  overlayHidden = true;
  overlayWindow.setIgnoreMouseEvents(true, { forward: true });
  overlayWindow.setOpacity(0);
  console.log('BRO popup hidden until next activation');
});
ipcMain.on('bro-show-overlay', () => {
  if (!overlayWindow || overlayWindow.isDestroyed()) return;
  console.log('BRO popup shown');
  overlayHidden = false;
  if (overlayWindow.isMinimized()) overlayWindow.restore();
  if (!overlayWindow.isVisible()) overlayWindow.show();
  overlayWindow.setIgnoreMouseEvents(false);
  overlayWindow.setOpacity(1);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  if (typeof overlayWindow.moveTop === 'function') overlayWindow.moveTop();
  overlayWindow.focus();
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => activateOverlay());
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  configureAutoLaunch();
  // Microphone access for the always-on-top popup. Nothing else is granted.
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media');
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'media');
  try {
    const ready = await startBackendIfNeeded();
    if (!ready) console.error('BRO backend did not become ready; the overlay will remain available for retrying.');
  } catch (error) {
    console.error(`BRO backend could not start: ${error.message}`);
  }
  try {
    const voice = require(path.join(appRoot, 'src', 'voice.js'));
    const info = voice.status();
    console.log(info.available ? `BRO voice engine: ${info.engine} (${info.model})` : `BRO voice engine unavailable: ${info.reason}`);
  } catch (error) {
    console.error(`BRO voice engine check failed: ${error.message}`);
  }
  createOverlayWindow();
  registerHotkeys();
  startWindowMaximizer();
});

app.on('window-all-closed', () => { if (!backgroundLaunch) app.quit(); });
app.on('will-quit', () => {
  if (hotkeyRetryTimer) clearInterval(hotkeyRetryTimer);
  hotkeyRetryTimer = null;
  globalShortcut.unregisterAll();
});
app.on('before-quit', () => {
  stopWindowsHotkey();
  stopWindowMaximizer();
  if (backendProcess && !backendProcess.killed) backendProcess.kill();
});
