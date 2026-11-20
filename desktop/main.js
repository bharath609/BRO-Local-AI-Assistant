const { app, BrowserWindow, globalShortcut, ipcMain, session, shell, screen, utilityProcess, Menu, Tray, nativeImage, dialog, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { migrateLegacyData } = require('../src/paths');
const { createLogger } = require('../src/logger');

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

// Keep user data out of the installation directory and stable across upgrades.
// This must happen before anything reads app.getPath('userData').
const APP_NAME = 'BRO Assistant';
app.setName(APP_NAME);
const USER_DATA_DIR = path.join(app.getPath('appData'), APP_NAME);
try { app.setPath('userData', USER_DATA_DIR); } catch { /* keep Electron's default */ }
app.setAppUserModelId('com.bro.assistant');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 4280;
const requestedPort = Number(process.env.BRO_PORT || DEFAULT_PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : DEFAULT_PORT;
const ORIGIN = `http://${HOST}:${PORT}`;
const appRoot = path.resolve(__dirname, '..');
const resourcesRoot = app.isPackaged ? process.resourcesPath : appRoot;
const iconPath = app.isPackaged
  ? path.join(resourcesRoot, 'assets', 'icon.png')
  : path.join(appRoot, 'assets', 'icon.png');
const SMOKE_TEST = process.argv.includes('--smoke-test');
const backgroundLaunch = process.argv.includes('--background');

let backendProcess;
let mainWindow;
let overlayWindow;
let tray;
let nativeHotkeyProcess;
let hotkeyRetryTimer;
let windowMaximizerProcess;
let lastHotkeyAt = 0;
let electronHotkeyRegistered = false;
let quitting = false;
let backendFailureShown = false;
const HOTKEY = process.env.BRO_HOTKEY || 'Control+Alt+B';
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const desktopStateFile = path.join(USER_DATA_DIR, 'desktop.json');
const logsDir = path.join(USER_DATA_DIR, 'logs');
const masterKeyFile = path.join(USER_DATA_DIR, 'secret.key');
const logger = createLogger(logsDir);
// Random per launch. Only the Electron shell knows it, and only its own
// requests get the header injected. A stray web page cannot use the API.
const apiToken = crypto.randomBytes(32).toString('hex');
let masterKey = '';

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

// ---------------------------------------------------------------------------
// Backend process
// ---------------------------------------------------------------------------

function backendEnv() {
  const env = { ...process.env, BRO_PORT: String(PORT), BRO_HOST: HOST, BRO_API_TOKEN: apiToken };
  if (app.isPackaged) {
    env.BRO_PACKAGED = '1';
    env.BRO_RESOURCES_DIR = process.resourcesPath;
    env.BRO_DATA_DIR = env.BRO_DATA_DIR || USER_DATA_DIR;
    env.BRO_LOGS_DIR = env.BRO_LOGS_DIR || logsDir;
    env.BRO_WHISPER_HOME = env.BRO_WHISPER_HOME || path.join(process.resourcesPath, 'whisper');
    env.BRO_SCRIPTS_DIR = env.BRO_SCRIPTS_DIR || path.join(process.resourcesPath, 'scripts');
    env.BRO_APP_EXE = env.BRO_APP_EXE || process.execPath;
    if (masterKey) env.BRO_SECRET_KEY = masterKey;
  } else {
    env.BRO_APP_EXE = '';
  }
  return env;
}

// The OS protects this key, so a copied settings file is useless on another
// account. Development keeps the old plaintext format so a source checkout
// still works if the Windows profile is reset.
async function loadMasterKey() {
  if (!app.isPackaged) return '';
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      logger.warn('OS credential storage is unavailable; provider keys stay unencrypted.');
      return '';
    }
    if (fs.existsSync(masterKeyFile)) {
      const saved = await safeStorage.decryptStringAsync(fs.readFileSync(masterKeyFile));
      if (/^[0-9a-f]{64}$/i.test(saved)) return saved;
      logger.warn('Stored master key was unreadable; generating a new one.');
    }
    const key = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(USER_DATA_DIR, { recursive: true });
    fs.writeFileSync(masterKeyFile, await safeStorage.encryptStringAsync(key), { mode: 0o600 });
    logger.info('Generated a new encryption key protected by Windows.');
    return key;
  } catch (error) {
    logger.error(`Could not prepare credential encryption: ${error.message}`);
    return '';
  }
}

function backendReady() {
  return new Promise((resolve) => {
    const request = http.get({ hostname: HOST, port: PORT, path: '/api/bootstrap', timeout: 700, headers: { 'x-bro-token': apiToken } }, (response) => {
      response.resume();
      resolve(response.statusCode >= 200 && response.statusCode < 500);
    });
    request.on('error', () => resolve(false));
    request.on('timeout', () => request.destroy());
  });
}

// Reads a small JSON endpoint from the local backend using the launch token.
function backendJson(pathname) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: HOST, port: PORT, path: pathname, timeout: 4_000, headers: { 'x-bro-token': apiToken } }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode !== 200) return reject(new Error(`HTTP ${response.statusCode}`));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => { request.destroy(new Error('timed out')); });
  });
}

async function startBackendIfNeeded() {
  if (await backendReady()) return true;

  // utilityProcess uses Electron's bundled Node runtime, so an installed copy
  // never needs node.exe on PATH.
  backendProcess = utilityProcess.fork(path.join(appRoot, 'server.js'), [], {
    cwd: appRoot,
    env: backendEnv(),
    stdio: 'pipe',
    serviceName: 'BRO local backend',
  });
  const prefix = (stream, label, level) => {
    if (!stream) return;
    stream.on('data', (chunk) => {
      const text = chunk.toString().trimEnd();
      if (!text) return;
      console.log(`[${label}] ${text}`);
      logger.write(level, `${label}: ${text}`);
    });
  };
  prefix(backendProcess.stdout, 'backend', 'info');
  prefix(backendProcess.stderr, 'backend', 'error');

  backendProcess.on('error', (error) => {
    console.error(`BRO backend process could not start: ${error.message}`);
    logger.error(`Backend process could not start: ${error.message}`);
  });
  backendProcess.on('spawn', () => console.log('BRO backend process spawned.'));
  backendProcess.on('exit', (code) => {
    backendProcess = null;
    if (quitting) return;
    console.error(`BRO backend stopped (${code}).`);
    logger.error(`Backend stopped with exit code ${code}.`);
    if (!backendFailureShown) showBackendFailure(`The local BRO service stopped unexpectedly (exit code ${code}).`);
  });

  // 15 seconds, not 5: a cold disk or a busy machine can take a while to load
  // Electron's Node runtime and the Whisper paths.
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await backendReady()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function stopBackend() {
  if (!backendProcess) return;
  const child = backendProcess;
  backendProcess = null;
  try { child.kill(); } catch { /* already gone */ }
}

function showBackendFailure(detail) {
  backendFailureShown = true;
  logger.error(`Backend failure: ${detail}`);
  showMainWindow();
  const options = {
    type: 'error',
    title: 'BRO could not start',
    message: 'The local BRO service is not responding.',
    detail: `${detail}\n\nTry: close BRO completely from the tray and start it again. If it keeps failing, reinstall BRO Assistant.`,
  };
  const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  if (target) dialog.showMessageBox(target, options).catch(() => {});
  else dialog.showMessageBox(options).catch(() => {});
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const overlaySize = { width: 320, height: 158 };

function hardenWindow(win) {
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(ORIGIN)) return;
    event.preventDefault();
    if (/^https?:/i.test(url)) shell.openExternal(url).catch(() => {});
  });
}

function createMainWindow({ show = false } = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (show) showMainWindow();
    return mainWindow;
  }
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: APP_NAME,
    backgroundColor: '#0b0d12',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'main-preload.js'),
    },
  });

  hardenWindow(mainWindow);
  mainWindow.once('ready-to-show', () => {
    if (show && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
  });
  // The main window hides instead of closing; BRO keeps listening in the tray.
  mainWindow.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.loadURL(`${ORIGIN}/index.html`);
  return mainWindow;
}

function showMainWindow(view) {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createMainWindow({ show: true });
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (view && !win.webContents.isLoading()) win.webContents.send('bro-navigate', view);
}

function createOverlayWindow(showWhenReady = false) {
  if (overlayWindow && !overlayWindow.isDestroyed()) return overlayWindow;
  const { width: winWidth, height: winHeight } = overlaySize;
  let area = { x: 0, y: 0, width: 1920, height: 1080 };
  try {
    const display = screen.getPrimaryDisplay();
    area = (display && (display.workArea || display.bounds)) || area;
  } catch {
    // Fall back to sane defaults if the display is not queryable yet.
  }
  const screenWidth = area.width || 1920;
  const x = Math.max(0, Math.min(screenWidth - winWidth, Math.round((screenWidth - winWidth) / 2)));
  const y = Math.max(0, area.y || 0);

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
  overlayWindow.webContents.on('preload-error', (_event, preloadPath, error) => console.error(`BRO preload error (${preloadPath}): ${error.message || error}`));
  overlayWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === `${ORIGIN}/` || url.startsWith(`${ORIGIN}/?`)) {
      shell.openExternal(url).catch(() => {});
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
  return overlayWindow;
}

function activateOverlay() {
  const now = Date.now();
  if (now - lastHotkeyAt < 600) return;
  lastHotkeyAt = now;
  console.log('BRO hotkey triggered');
  if (!overlayWindow || overlayWindow.isDestroyed()) {
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

// The popup "hides" by fading to zero opacity instead of calling hide().
// A hidden BrowserWindow makes Chromium stop feeding the wake-word audio graph,
// which is why the wake word appeared dead after the popup disappeared.
let overlayHidden = false;
ipcMain.on('bro-close-overlay', () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close();
});
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
ipcMain.on('bro-open-main', (_event, view) => showMainWindow(typeof view === 'string' ? view : undefined));

// ---------------------------------------------------------------------------
// Tray, startup and hotkeys
// ---------------------------------------------------------------------------

function readDesktopState() {
  try {
    const value = JSON.parse(fs.readFileSync(desktopStateFile, 'utf8'));
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

function writeDesktopState(patch) {
  try {
    const next = { ...readDesktopState(), ...patch, updatedAt: new Date().toISOString() };
    fs.mkdirSync(path.dirname(desktopStateFile), { recursive: true });
    fs.writeFileSync(desktopStateFile, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  } catch (error) {
    console.warn(`BRO could not save desktop settings: ${error.message}`);
    return {};
  }
}

function autoStartEnabled() {
  if (process.platform !== 'win32') return false;
  try { return Boolean(app.getLoginItemSettings().openAtLogin); } catch { return false; }
}

function applyAutoStart(enabled) {
  if (process.platform !== 'win32' || !app.isPackaged) return false;
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: process.execPath, args: ['--background'] });
    writeDesktopState({ autoStart: Boolean(enabled) });
    return Boolean(enabled);
  } catch (error) {
    console.warn(`BRO could not change start-at-login: ${error.message}`);
    return false;
  }
}

function configureFirstRun() {
  if (!app.isPackaged) return;
  const state = readDesktopState();
  if (state.autoStart === undefined) applyAutoStart(false);
  else applyAutoStart(Boolean(state.autoStart));
}

function createTray() {
  if (tray) return tray;
  if (!fs.existsSync(iconPath)) {
    console.warn('BRO tray icon is missing; the app will quit when all windows close.');
    return null;
  }
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return null;
  image = image.resize({ width: 16, height: 16 });
  tray = new Tray(image);
  tray.setToolTip(APP_NAME);
  const rebuild = () => {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open BRO', click: () => showMainWindow() },
      { label: 'Provider settings', click: () => showMainWindow('settings') },
      { label: 'Voice popup (Ctrl+Alt+B)', click: () => activateOverlay() },
      { type: 'separator' },
      ...(app.isPackaged && process.platform === 'win32' ? [{
        label: 'Start with Windows',
        type: 'checkbox',
        checked: autoStartEnabled(),
        click: (item) => { applyAutoStart(item.checked); rebuild(); },
      }, { type: 'separator' }] : []),
      { label: 'Quit BRO', click: () => { quitting = true; app.quit(); } },
    ]));
  };
  rebuild();
  tray.on('click', () => showMainWindow());
  tray.on('double-click', () => showMainWindow());
  return tray;
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
  const scriptPath = path.join(
    app.isPackaged ? path.join(process.resourcesPath, 'scripts') : path.join(appRoot, 'scripts'),
    'maximize-new-windows.ps1',
  );
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

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

function configureSession() {
  // Microphone access for BRO's own local pages. Nothing else is granted.
  const appOrigin = new URL(ORIGIN).origin;
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const requesting = String((details && details.requestingUrl) || '');
    callback(permission === 'media' && requesting.startsWith(appOrigin));
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    return permission === 'media' && String(requestingOrigin || '').startsWith(appOrigin);
  });
  // The backend requires this per-launch token. Adding it here means the page
  // code never has to know about it and no token is written to disk.
  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${ORIGIN}/*`] }, (details, callback) => {
    callback({ requestHeaders: { ...details.requestHeaders, 'x-bro-token': apiToken } });
  });
}

async function runSmokeTest() {
  try {
    const ready = await startBackendIfNeeded();
    if (!ready) {
      console.error('SMOKE_FAIL backend-not-ready');
      return false;
    }
    const response = await fetch(`${ORIGIN}/api/bootstrap`, { headers: { 'x-bro-token': apiToken } });
    const body = await response.json();
    if (!response.ok || !body || typeof body.appName !== 'string') {
      console.error(`SMOKE_FAIL bootstrap-${response.status}`);
      return false;
    }
    // Prove the token is actually enforced: the same request without it must
    // be rejected. A silently disabled guard would otherwise look healthy.
    const unauthenticated = await fetch(`${ORIGIN}/api/bootstrap`);
    if (unauthenticated.status !== 401) {
      console.error(`SMOKE_FAIL auth-not-enforced-${unauthenticated.status}`);
      return false;
    }
    console.log(`SMOKE_OK ${body.appName} capabilities=${Array.isArray(body.capabilities) ? body.capabilities.length : 0}`);
    return true;
  } catch (error) {
    console.error(`SMOKE_FAIL ${error.message}`);
    return false;
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (Array.isArray(argv) && argv.includes('--background')) activateOverlay();
    else showMainWindow();
  });
}

if (hasSingleInstanceLock) {
  app.whenReady().then(async () => {
    logger.info(`BRO starting (packaged=${app.isPackaged}, smoke=${SMOKE_TEST}, background=${backgroundLaunch})`, { version: app.getVersion(), electron: process.versions.electron });
    masterKey = await loadMasterKey();
    configureSession();
    if (SMOKE_TEST) {
      const ok = await runSmokeTest();
      quitting = true;
      stopBackend();
      app.exit(ok ? 0 : 1);
      return;
    }

    // Preserve data from portable builds that kept data/ next to the exe.
    if (app.isPackaged) {
      const migrated = migrateLegacyData(path.join(path.dirname(app.getPath('exe')), 'data'), USER_DATA_DIR);
      if (migrated.length) {
        console.log(`BRO migrated legacy data: ${migrated.join(', ')}`);
        logger.info(`Migrated legacy data: ${migrated.join(', ')}`);
      }
    }

    const firstRun = !fs.existsSync(desktopStateFile);
    configureFirstRun();

    try {
      const ready = await startBackendIfNeeded();
      if (!ready) showBackendFailure('The backend process did not become ready within 15 seconds.');
    } catch (error) {
      showBackendFailure(`The backend could not be started: ${error.message}`);
    }

    try {
      // Ask the backend, not this process: only the backend knows the packaged
      // whisper paths (they arrive through its environment).
      const info = await backendJson('/api/voice/status');
      console.log(info.available ? `BRO voice engine: ${info.engine} (${info.model})` : `BRO voice engine unavailable: ${info.reason}`);
      logger.info(info.available ? `Voice engine ready: ${info.engine} (${info.model})` : `Voice engine unavailable: ${info.reason}`);
    } catch (error) {
      console.error(`BRO voice engine check failed: ${error.message}`);
      logger.error(`Voice engine check failed: ${error.message}`);
    }

    createTray();
    createMainWindow({ show: false });
    if (firstRun || !backgroundLaunch) showMainWindow();
    createOverlayWindow(false);
    registerHotkeys();
    startWindowMaximizer();
    writeDesktopState({ lastLaunchAt: new Date().toISOString() });
  }).catch((error) => {
    console.error(`BRO failed to start: ${error.stack || error.message}`);
    logger.error(`BRO failed to start: ${error.stack || error.message}`);
    dialog.showErrorBox('BRO could not start', String(error.message || error));
    app.exit(1);
  });
}

app.on('activate', () => showMainWindow());
app.on('window-all-closed', () => {
  // Keep running in the tray so the hotkey and wake word stay available.
  if (!tray && !backgroundLaunch) app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  stopWindowsHotkey();
  stopWindowMaximizer();
  stopBackend();
  if (tray) { tray.destroy(); tray = null; }
});
app.on('will-quit', () => {
  if (hotkeyRetryTimer) clearInterval(hotkeyRetryTimer);
  hotkeyRetryTimer = null;
  globalShortcut.unregisterAll();
});
