'use strict';

// Minimal Chrome DevTools Protocol client.
//
// No Playwright, no Puppeteer: BRO talks to a browser over its local debugging
// port, which keeps the app dependency-free and works with an installed Chrome
// or Edge. Only page-level, read/act primitives are exposed to tools.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_PORT = Number(process.env.BRO_CDP_PORT || 9222);
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 20_000;

class CdpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CdpError';
  }
}

class CdpConnection {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  open() {
    if (typeof WebSocket !== 'function') {
      return Promise.reject(new CdpError('This Node runtime does not provide WebSocket support.'));
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { this.close(); } catch { /* ignore */ }
        reject(new CdpError('Connecting to the browser timed out.'));
      }, CONNECT_TIMEOUT_MS);
      let socket;
      try {
        socket = new WebSocket(this.wsUrl);
      } catch (error) {
        clearTimeout(timer);
        reject(new CdpError(`Could not open the browser connection: ${error.message}`));
        return;
      }
      this.socket = socket;
      socket.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(this);
      });
      socket.addEventListener('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new CdpError('The browser rejected the debugging connection.'));
      });
      socket.addEventListener('close', () => {
        this.closed = true;
        for (const [, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new CdpError('The browser closed the connection.'));
        }
        this.pending.clear();
      });
      socket.addEventListener('message', (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (!message || typeof message.id !== 'number') return;
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new CdpError(message.error.message || 'Browser command failed.'));
        else entry.resolve(message.result || {});
      });
    });
  }

  send(method, params = {}, timeoutMs = CALL_TIMEOUT_MS) {
    if (!this.socket || this.closed) return Promise.reject(new CdpError('The browser connection is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`Browser command ${method} timed out.`));
      }, Math.max(500, Number(timeoutMs) || CALL_TIMEOUT_MS));
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError(`Could not send a browser command: ${error.message}`));
      }
    });
  }

  async evaluate(expression, { timeoutMs = CALL_TIMEOUT_MS } = {}) {
    const result = await this.send('Runtime.evaluate', {
      expression: String(expression || ''),
      returnByValue: true,
      awaitPromise: true,
      userGesture: false,
    }, timeoutMs);
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new CdpError(`The page script failed: ${String(detail || result.exceptionDetails.text || 'unknown error').slice(0, 300)}`);
    }
    return result.result ? result.result.value : undefined;
  }

  close() {
    this.closed = true;
    try { this.socket && this.socket.close(); } catch { /* ignore */ }
    this.socket = null;
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function browserCandidates() {
  const local = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  return [
    process.env.BRO_BROWSER_PATH || '',
    local ? path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    pf ? path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    pf86 ? path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
    local ? path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    pf ? path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
    pf86 ? path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe') : '',
  ].filter(Boolean);
}

function findBrowserExe() {
  for (const candidate of browserCandidates()) {
    try { if (fs.existsSync(candidate)) return candidate; } catch { /* ignore */ }
  }
  return '';
}

async function fetchJson(url, timeoutMs = 2_000) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function probePort(port) {
  const version = await fetchJson(`http://127.0.0.1:${port}/json/version`, 1_500);
  return version && version.webSocketDebuggerUrl ? version : null;
}

async function ensureBrowser({ port = DEFAULT_PORT, dataDir = '', onStatus } = {}) {
  const wantedPort = Math.max(1024, Math.min(65535, Number(port) || DEFAULT_PORT));
  let version = await probePort(wantedPort);
  if (version) return { port: wantedPort, version, launched: false, exe: '' };

  const exe = findBrowserExe();
  if (!exe) throw new Error('Chrome or Edge is not installed, so BRO cannot start browser automation.');
  const profileDir = path.join(dataDir || path.join(os.homedir(), '.bro'), 'browser-profile');
  try { fs.mkdirSync(profileDir, { recursive: true }); } catch { /* Chrome will report a clearer error */ }
  if (typeof onStatus === 'function') {
    try { onStatus(`Starting ${path.basename(exe).replace(/\.exe$/i, '')} for browser control…`); } catch { /* cosmetic */ }
  }
  const args = [
    `--remote-debugging-port=${wantedPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-mode',
    '--disable-features=Translate',
    'about:blank',
  ];
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', shell: false, windowsHide: false });
  child.once('error', () => {});
  child.unref();

  for (let attempt = 0; attempt < 24; attempt += 1) {
    await wait(600);
    version = await probePort(wantedPort);
    if (version) return { port: wantedPort, version, launched: true, exe, profileDir };
  }
  throw new Error('The browser started but did not expose its debugging port. Close extra browser windows and try again.');
}

async function listPages(port) {
  const pages = await fetchJson(`http://127.0.0.1:${port}/json/list`, 3_000);
  if (!Array.isArray(pages)) return [];
  return pages
    .filter((page) => page && page.type === 'page' && page.webSocketDebuggerUrl)
    .filter((page) => !/^devtools:/i.test(String(page.url || '')));
}

async function newTab(port, url) {
  const encoded = encodeURIComponent(url);
  let page = await fetchJson(`http://127.0.0.1:${port}/json/new?${encoded}`, 5_000);
  if (page && page.webSocketDebuggerUrl) return page;
  // Older builds only accept GET for /json/new.
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/new?${encoded}`, { method: 'PUT', signal: AbortSignal.timeout(5_000) });
    if (response.ok) return await response.json();
  } catch { /* fall through */ }
  return null;
}

const connectionCache = new Map();

async function connectPage(page) {
  const cached = connectionCache.get(page.id);
  if (cached && !cached.closed) return cached;
  if (cached) connectionCache.delete(page.id);
  const connection = await new CdpConnection(page.webSocketDebuggerUrl).open();
  connectionCache.set(page.id, connection);
  return connection;
}

function dropConnection(targetId) {
  const cached = connectionCache.get(targetId);
  if (cached) {
    try { cached.close(); } catch { /* ignore */ }
    connectionCache.delete(targetId);
  }
}

function isLoginUrl(url) {
  return /^https?:\/\/(?:accounts\.google\.com|login\.(?:live|microsoftonline)\.com|www\.linkedin\.com\/(?:login|authwall|checkpoint)|www\.facebook\.com\/login|github\.com\/login)/i.test(String(url || ''));
}

module.exports = {
  CdpConnection,
  CdpError,
  DEFAULT_PORT,
  ensureBrowser,
  findBrowserExe,
  listPages,
  newTab,
  connectPage,
  dropConnection,
  isLoginUrl,
  probePort,
  wait,
};
