// Conversation history helpers.
//
// The browser keeps the visible transcript and sends the recent turns with each
// request. That transcript is untrusted input: it may be stale, huge, or contain
// roles the provider should never see. Everything that goes to the model is
// filtered, bounded, and ordered here.

const MAX_MESSAGES = 24;
const MAX_CHARS = 9_000;
const MAX_MESSAGE_CHARS = 2_500;

const ALLOWED_ROLES = new Set(['user', 'assistant']);

function normalizeHistory(history, { maxMessages = MAX_MESSAGES, maxChars = MAX_CHARS } = {}) {
  if (!Array.isArray(history)) return [];
  const cleaned = [];
  for (const item of history) {
    if (!item || typeof item !== 'object') continue;
    const role = typeof item.role === 'string' ? item.role.trim().toLowerCase() : '';
    if (!ALLOWED_ROLES.has(role)) continue;
    const content = typeof item.content === 'string'
      ? item.content
      : typeof item.text === 'string'
        ? item.text
        : '';
    const trimmed = content.trim();
    if (!trimmed) continue;
    cleaned.push({ role, content: trimmed.slice(0, MAX_MESSAGE_CHARS) });
  }

  let messages = cleaned.slice(-Math.max(1, maxMessages));
  let total = messages.reduce((sum, message) => sum + message.content.length, 0);
  while (messages.length > 1 && total > maxChars) {
    total -= messages[0].content.length;
    messages = messages.slice(1);
  }
  // A transcript that starts with an assistant turn is confusing for the model
  // and for the provider's chat template, so drop leading assistant messages.
  while (messages.length && messages[0].role !== 'user') messages = messages.slice(1);
  return messages;
}

module.exports = { normalizeHistory, MAX_MESSAGES, MAX_CHARS, MAX_MESSAGE_CHARS };
