const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_BASE_URL = '';
const DEFAULT_MODEL = 'omnirush/gpt-6-astra';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_PROTOCOL = 'auto';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const GPT_6_1_SOL_MODEL = 'gpt-6.1-sol';

function normalizeProtocol(value) {
  const protocol = String(value || DEFAULT_PROTOCOL).trim().toLowerCase();
  return ['auto', 'chat', 'responses'].includes(protocol) ? protocol : DEFAULT_PROTOCOL;
}

function isLocalBaseUrl(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function isOpenAIBaseUrl(baseUrl) {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === 'api.openai.com';
  } catch {
    return false;
  }
}

function providerInfo(settings) {
  const baseUrl = settings && settings.baseUrl ? String(settings.baseUrl).replace(/\/$/, '') : '';
  const model = settings && settings.model ? String(settings.model) : DEFAULT_MODEL;
  const local = isLocalBaseUrl(baseUrl);
  const protocol = normalizeProtocol(settings && settings.protocol);
  return { configured: Boolean(settings && baseUrl && model && (local || settings.apiKey)), local, model, baseUrl, protocol };
}

function responseText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.trim()) return payload.output_text.trim();
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const text = output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((item) => item?.text)
    .find((value) => typeof value === 'string' && value.trim());
  return typeof text === 'string' ? text.trim() : '';
}

function chatText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

async function requestChat(settings, info, messages) {
  const controller = new AbortController();
  const timeoutMs = Number(process.env.BRO_AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
    const useResponses = info.protocol === 'responses' || (info.protocol === 'auto' && isOpenAIBaseUrl(info.baseUrl));
    const endpoint = useResponses ? `${info.baseUrl}/responses` : `${info.baseUrl}/chat/completions`;
    const body = useResponses
      ? { model: info.model, input: messages, max_output_tokens: 512 }
      : { model: info.model, messages, temperature: 0.2, max_tokens: 512 };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      // Ollama answers 404 when the configured model was never pulled; say so instead of "offline".
      return { ok: false, reason: response.status === 404 ? 'model not installed' : 'provider request failed' };
    }
    const payload = await response.json();
    const content = useResponses ? responseText(payload) : chatText(payload);
    if (!content) return { ok: false, reason: 'provider returned no reply' };
    return { ok: true, reply: content };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return { ok: false, reason: aborted ? 'provider timed out' : 'provider request failed', network: !aborted };
  } finally {
    clearTimeout(timer);
  }
}

const OLLAMA_PORT = '11434';
let ollamaAttempt = { at: 0, promise: null };

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findOllama() {
  const candidates = [];
  if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'Ollama', 'ollama.exe'));
  if (process.env.PROGRAMFILES) candidates.push(path.join(process.env.PROGRAMFILES, 'Ollama', 'ollama.exe'));
  if (process.env['PROGRAMFILES(X86)']) candidates.push(path.join(process.env['PROGRAMFILES(X86)'], 'Ollama', 'ollama.exe'));
  const installed = candidates.find((candidate) => {
    try { return fs.existsSync(candidate); } catch { return false; }
  });
  if (installed) return installed;
  // Falls back to whatever `ollama` is on PATH (scoop, chocolatey, portable).
  try {
    const found = execFileSync('where.exe', ['ollama.exe'], { encoding: 'utf8', timeout: 3_000, windowsHide: true });
    const first = String(found || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean);
    if (first && fs.existsSync(first)) return first;
  } catch {
    // not on PATH
  }
  return '';
}

async function ollamaResponding(base) {
  try {
    const response = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(1_200) });
    return response.ok;
  } catch {
    return false;
  }
}

// The local model is the most common reason a spoken sentence gets “I could not
// reach the configured AI provider”: Ollama was closed, or the PC just booted.
// Start it once and retry, so the user never has to open a terminal for it.
async function startLocalRuntime(baseUrl) {
  let port = '';
  try { port = new URL(baseUrl).port; } catch { return false; }
  if (port !== OLLAMA_PORT) return false;
  if (ollamaAttempt.promise && Date.now() - ollamaAttempt.at < 60_000) return ollamaAttempt.promise;
  const base = baseUrl.replace(/\/v1\/?$/, '');
  const exe = findOllama();
  if (!exe) return false;
  const promise = (async () => {
    try {
      const child = spawn(exe, ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
      child.once('error', () => {});
      child.unref();
    } catch {
      return false;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await wait(400);
      if (await ollamaResponding(base)) return true;
    }
    return false;
  })();
  ollamaAttempt = { at: Date.now(), promise };
  return promise;
}

async function chatCompletion(settings, messages) {
  const info = providerInfo(settings);
  if (!info.configured) return { ok: false, reason: 'unconfigured' };
  let result = await requestChat(settings, info, messages);
  if (!result.ok && result.network && info.local) {
    if (await startLocalRuntime(info.baseUrl)) result = await requestChat(settings, info, messages);
  }
  return result.ok ? { ok: true, reply: result.reply } : { ok: false, reason: result.reason };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_PROTOCOL,
  OPENAI_BASE_URL,
  GPT_6_1_SOL_MODEL,
  normalizeProtocol,
  isLocalBaseUrl,
  isOpenAIBaseUrl,
  providerInfo,
  responseText,
  chatCompletion
};
