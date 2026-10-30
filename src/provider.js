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

async function chatCompletion(settings, messages) {
  const info = providerInfo(settings);
  if (!info.configured) return { ok: false, reason: 'unconfigured' };
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
    if (!response.ok) return { ok: false, reason: 'provider request failed' };
    const payload = await response.json();
    const content = useResponses ? responseText(payload) : chatText(payload);
    if (!content) return { ok: false, reason: 'provider returned no reply' };
    return { ok: true, reply: content };
  } catch (error) {
    return { ok: false, reason: error && error.name === 'AbortError' ? 'provider timed out' : 'provider request failed' };
  } finally {
    clearTimeout(timer);
  }
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
