const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BASE_URL = '';
const DEFAULT_MODEL = 'omnirush/gpt-6-astra';
const DEFAULT_TIMEOUT_MS = 120_000;
// A local model answers from the same machine the microphone is running on, so
// a long wait means something is wrong (model loading, Ollama asleep). Fail in
// half a minute with a useful message instead of leaving BRO “working”.
const LOCAL_TIMEOUT_MS = Number(process.env.BRO_LOCAL_AI_TIMEOUT_MS || 30_000);
const DEFAULT_PROTOCOL = 'auto';
const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const GPT_6_1_SOL_MODEL = 'gpt-6.1-sol';
const OLLAMA_PORT = '11434';
// Leave half of the logical threads free so the wake word and command
// transcription stay responsive while the model is generating. Whisper runs on
// the other cores.
const LOCAL_THREADS = Math.max(2, Math.floor(os.cpus().length / 2));
const OLLAMA_KEEP_ALIVE = process.env.BRO_OLLAMA_KEEP_ALIVE || '10m';
const OLLAMA_NUM_CTX = Number(process.env.BRO_OLLAMA_CTX || 2048);

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

// Ollama's OpenAI-compatible endpoint ignores the tuning knobs BRO needs
// (threads, context size, keep-alive). Its native /api/chat endpoint accepts
// them, so local Ollama models use that path instead.
function isOllamaBaseUrl(baseUrl) {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') && port === OLLAMA_PORT;
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

async function requestChat(settings, info, messages, options = {}) {
  const controller = new AbortController();
  const configured = Number(process.env.BRO_AI_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  const requested = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0
    ? requested
    : (isLocalBaseUrl(info.baseUrl) ? LOCAL_TIMEOUT_MS : configured);
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS);
  try {
    const headers = { 'content-type': 'application/json' };
    if (settings.apiKey) headers.authorization = `Bearer ${settings.apiKey}`;
    const useResponses = info.protocol === 'responses' || (info.protocol === 'auto' && isOpenAIBaseUrl(info.baseUrl));
    const endpoint = useResponses ? `${info.baseUrl}/responses` : `${info.baseUrl}/chat/completions`;
    // The Responses protocol is only used for OpenAI, where the chat tool format
    // differs. Tool calling there falls back to the structured JSON protocol.
    const wantsTools = Array.isArray(options.tools) && options.tools.length > 0 && !useResponses;
    // A small local model speaks a lot slower per token, so cap the answer length there.
    // 120 tokens is already three or four spoken sentences, and it keeps a
    // worst-case answer around 16 s instead of letting the request time out.
    const maxTokens = isLocalBaseUrl(info.baseUrl) ? 240 : 700;
    const body = useResponses
      ? { model: info.model, input: messages, max_output_tokens: maxTokens }
      : {
          model: info.model,
          messages,
          temperature: Number.isFinite(options.temperature) ? options.temperature : 0.3,
          max_tokens: maxTokens,
          ...(wantsTools ? { tools: options.tools, tool_choice: options.toolChoice || 'auto' } : {}),
        };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response.ok) {
      // A 400/422 with tools usually means the endpoint does not implement the
      // OpenAI tool-calling shape. Tells the brain to switch to its JSON fallback.
      if (wantsTools && (response.status === 400 || response.status === 422)) {
        return { ok: false, toolsUnsupported: true, reason: 'provider rejected tool calling' };
      }
      // Ollama answers 404 when the configured model was never pulled; say so instead of "offline".
      return { ok: false, reason: response.status === 404 ? 'model not installed' : 'provider request failed' };
    }
    const payload = await response.json();
    const message = payload?.choices?.[0]?.message;
    const content = useResponses ? responseText(payload) : (typeof message?.content === 'string' ? message.content.trim() : '');
    const toolCalls = !useResponses && Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    if (!content && toolCalls.length === 0) return { ok: false, reason: 'provider returned no reply' };
    return { ok: true, reply: content, toolCalls, message, protocol: useResponses ? 'responses' : 'chat' };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return { ok: false, reason: aborted ? 'provider timed out' : 'provider request failed', network: !aborted };
  } finally {
    clearTimeout(timer);
  }
}

async function requestOllama(settings, info, messages, options = {}) {
  const controller = new AbortController();
  const requested = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : LOCAL_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const wantsTools = Array.isArray(options.tools) && options.tools.length > 0;
  try {
    const base = info.baseUrl.replace(/\/v1\/?$/, '');
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: info.model,
        messages,
        stream: false,
        ...(wantsTools ? { tools: options.tools } : {}),
        // Keep the model resident between questions so the second one does not
        // pay for a 2 GB load again, but cap the context and threads so voice
        // capture keeps its share of the CPU.
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          temperature: Number.isFinite(options.temperature) ? options.temperature : 0.3,
          num_predict: wantsTools ? 240 : 120,
          num_ctx: OLLAMA_NUM_CTX,
          num_thread: LOCAL_THREADS,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (wantsTools && (response.status === 400 || response.status === 422)) {
        return { ok: false, toolsUnsupported: true, reason: 'provider rejected tool calling' };
      }
      return { ok: false, reason: response.status === 404 ? 'model not installed' : 'provider request failed' };
    }
    const payload = await response.json();
    const message = payload?.message || {};
    const content = typeof message.content === 'string' ? message.content.trim() : '';
    const toolCalls = (Array.isArray(message.tool_calls) ? message.tool_calls : []).map((call, index) => ({
      id: call.id || `ollama-${index}`,
      type: 'function',
      function: { name: call.function?.name, arguments: call.function?.arguments ?? '{}' },
    })).filter((call) => call.function.name);
    if (!content && toolCalls.length === 0) return { ok: false, reason: 'provider returned no reply' };
    return { ok: true, reply: content, toolCalls, message: { role: 'assistant', content, tool_calls: toolCalls }, protocol: 'ollama' };
  } catch (error) {
    const aborted = error && error.name === 'AbortError';
    return { ok: false, reason: aborted ? 'provider timed out' : 'provider request failed', network: !aborted };
  } finally {
    clearTimeout(timer);
  }
}

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

async function chatComplete(settings, messages, options = {}) {
  const info = providerInfo(settings);
  if (!info.configured) return { ok: false, reason: 'unconfigured' };
  const native = isOllamaBaseUrl(info.baseUrl);
  const send = () => (native ? requestOllama(settings, info, messages, options) : requestChat(settings, info, messages, options));
  let result = await send();
  if (!result.ok && result.network && info.local) {
    if (await startLocalRuntime(info.baseUrl)) result = await send();
  }
  return result;
}

async function chatCompletion(settings, messages, options = {}) {
  const result = await chatComplete(settings, messages, options);
  return result.ok ? { ok: true, reply: result.reply } : { ok: false, reason: result.reason };
}

// Starts Ollama in the background (without loading a model) so the first
// question of a session does not also pay for a process launch.
async function warmLocalRuntime(baseUrl) {
  if (!baseUrl || !isOllamaBaseUrl(baseUrl)) return false;
  if (await ollamaResponding(baseUrl.replace(/\/v1\/?$/, ''))) return true;
  return startLocalRuntime(baseUrl);
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
  isOllamaBaseUrl,
  providerInfo,
  responseText,
  chatComplete,
  chatCompletion,
  warmLocalRuntime
};
