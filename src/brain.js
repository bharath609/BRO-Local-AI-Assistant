// The AI brain: conversation prompt, tool loop, and structured fallback.
//
// Design notes
// - The model decides whether a tool is needed. It can only pick from
//   `tool-schema.js`, and every argument is validated before it becomes an
//   action, so generated text never becomes a shell command.
// - Deterministic command parsing still runs first in `assistant.js`. That keeps
//   "open Chrome" instant and working offline, while everything conversational
//   or ambiguous goes through this module.
// - Providers with OpenAI-style tool calling use it. Providers without it (the
//   Responses protocol, or older models) get the JSON tool protocol, which is
//   parsed strictly.

const { chatComplete, isLocalBaseUrl } = require('./provider');
const { normalizeHistory } = require('./history');
const { openAiTools, validateToolArguments, toolByName } = require('./tool-schema');

const DEFAULT_MAX_STEPS = 4;
const DEFAULT_MAX_TOOL_CALLS = 6;

function greetingText(userName) {
  return `Hey ${userName}! I’m BRO, your personal AI desktop assistant. Good to see you — what would you like to do today?`;
}

// Used when the provider is not configured or the greeting request fails. This
// is deliberately a short, human sentence and never a command dump.
function capabilitySummary(userName) {
  return `I’m your desktop assistant, ${userName}. I can talk things through and answer questions, search the web, open apps, sites and your files, manage windows, type and click for you, take screenshots, and work with Windows settings — all on this PC. Tell me what you need in normal language and I’ll work out the rest.`;
}

function projectsLine(projects) {
  if (!Array.isArray(projects) || projects.length === 0) return 'none registered';
  return projects.map((project) => project.name).filter(Boolean).join(', ');
}

function systemPrompt({ userName = 'Bharath', projects = [], guardrailMode = 'guarded' } = {}) {
  return `You are BRO, ${userName}'s personal AI desktop assistant. You run locally on their Windows PC and can both talk and act on the computer through tools.

Voice and style:
- Warm, natural and confident. Talk like a capable assistant, not a manual.
- Short by default: one to three sentences, because replies are often read aloud. Give more detail only when the user asks.
- No markdown tables and no long bullet lists in conversational replies.
- Never mention tools, function calls, JSON, prompts, or a command registry. The user talks to an assistant, not to a system.

Acting on the PC:
- Only use a tool when the user clearly asks you to do something on the computer.
- Pick the smallest tool that satisfies the request. Never invent a tool or an argument.
- If the request is ambiguous (which app, which site, which file), ask one short clarifying question instead of guessing.
- After a tool result, describe what actually happened. If the result says blocked, failed, rejected, unavailable or needs approval, say so honestly and briefly.
- Never claim you opened, closed, typed, clicked, scrolled or changed something unless a tool result confirms it.
- Do not repeat a tool call that already failed. Explain the problem instead.
- Destructive requests (shutdown, restart, deleting files, emptying the Recycle Bin, changing guardrails) are handled outside the tools. Do not try to perform them; tell the user to confirm the action when asked.

What you can do — describe this conversationally if asked, never as a raw list:
talking and answering questions, explaining ideas, writing and planning; opening apps, websites, folders, files, Windows settings and terminals; web and YouTube search; closing apps and windows; focusing, minimizing and maximizing windows BRO opened; typing, keyboard shortcuts, scrolling, screenshots and media playback; creating folders; showing the desktop; and working with registered projects.

Registered projects: ${projectsLine(projects)}.
Guardrail mode: ${guardrailMode}.`;
}

const JSON_TOOL_PROTOCOL = `

Tool protocol (this provider has no native tool calling):
If the user asks you to do something on the PC, reply with exactly one JSON object and nothing else:
{"tool":"<tool name>","arguments":{...}}
Use only these tools: ${openAiTools().map((tool) => tool.function.name).join(', ')}.
If no action is needed, reply normally in plain language. Never wrap normal conversation in JSON.`;

function parseToolJson(content) {
  if (typeof content !== 'string' || !content.trim()) return null;
  const text = content.trim();
  // Prefer a fenced block, then the first {...} object that mentions a tool.
  const candidates = [];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) candidates.push(fenced[1].trim());
  candidates.push(text);
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) candidates.push(objectMatch[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      const name = parsed.tool || parsed.action || parsed.name;
      if (typeof name !== 'string' || !toolByName(name)) continue;
      const args = parsed.arguments ?? parsed.args ?? {};
      return { name, args };
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function providerTimeout(settings, requested) {
  if (Number.isFinite(requested) && requested > 0) return requested;
  return isLocalBaseUrl(settings && settings.baseUrl) ? 30_000 : 60_000;
}

async function runTool(call, { toAction, runAction, onStatus, seen }) {
  const name = String(call?.function?.name || '').trim();
  const validation = validateToolArguments(name, call?.function?.arguments);
  if (!validation.ok) return { status: 'rejected', tool: name || 'unknown', message: validation.error };

  const key = `${name}:${JSON.stringify(validation.args)}`;
  if (seen.has(key)) return { status: 'skipped', tool: name, message: 'This exact action was already attempted.' };
  seen.add(key);

  let mapped;
  try {
    mapped = toAction(name, validation.args);
  } catch (error) {
    return { status: 'failed', tool: name, message: String((error && error.message) || error) };
  }
  if (!mapped) return { status: 'unavailable', tool: name, message: 'No matching action is available for that request.' };
  if (typeof mapped.reply === 'string' && mapped.reply) {
    return { status: 'ok', tool: name, message: mapped.reply };
  }
  const action = mapped.action;
  if (!action) return { status: 'unavailable', tool: name, message: 'No matching action is available for that request.' };

  if (typeof onStatus === 'function') {
    try { onStatus(mapped.status || action.label || 'Working…'); } catch { /* status is cosmetic */ }
  }

  if (typeof runAction !== 'function') {
    return { status: 'unavailable', tool: name, action: action.type, message: 'Actions cannot run in this context.' };
  }
  try {
    const outcome = await runAction(action);
    return {
      status: (outcome && outcome.status) || 'ok',
      tool: name,
      action: action.type,
      message: (outcome && (outcome.message || outcome.summary)) || 'Done.',
    };
  } catch (error) {
    return { status: 'failed', tool: name, action: action.type, message: String((error && error.message) || error) };
  }
}

function toolResultText(outcome) {
  const payload = { status: outcome.status, tool: outcome.tool, message: outcome.message };
  if (outcome.action) payload.action = outcome.action;
  return JSON.stringify(payload).slice(0, 1_200);
}

/**
 * Run one conversational turn, letting the model call tools as needed.
 * Returns { ok, reply, steps, reason }.
 */
async function respond({
  settings,
  userName = 'Bharath',
  projects = [],
  history = [],
  message,
  guardrailMode = 'guarded',
  toAction,
  runAction,
  onStatus,
  maxSteps = DEFAULT_MAX_STEPS,
  maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
  timeoutMs,
} = {}) {
  if (!settings || !settings.baseUrl) return { ok: false, reason: 'unconfigured' };
  if (typeof message !== 'string' || !message.trim()) return { ok: false, reason: 'empty message' };

  const basePrompt = systemPrompt({ userName, projects, guardrailMode });
  let systemContent = basePrompt;
  let nativeTools = true;
  const messages = [
    { role: 'system', content: systemContent },
    ...normalizeHistory(history),
    { role: 'user', content: message.trim() },
  ];
  const steps = [];
  const seen = new Set();
  let toolCalls = 0;
  let step = 0;
  const budget = providerTimeout(settings, timeoutMs);

  while (step < maxSteps) {
    step += 1;
    const result = await chatComplete(settings, messages, {
      tools: nativeTools ? openAiTools() : undefined,
      timeoutMs: budget,
      temperature: 0.35,
    });

    if (!result.ok) {
      if (result.toolsUnsupported && nativeTools) {
        nativeTools = false;
        systemContent = basePrompt + JSON_TOOL_PROTOCOL;
        messages[0] = { role: 'system', content: systemContent };
        step -= 1;
        continue;
      }
      return { ok: false, reason: result.reason || 'provider request failed', steps };
    }

    const calls = Array.isArray(result.toolCalls) ? result.toolCalls.filter((call) => call?.function?.name) : [];
    if (calls.length > 0) {
      // Only advertise the calls that will actually run, and only as many as the
      // budget allows. Every tool_call in an assistant message must be followed
      // by a matching tool result, or some providers reject the next request.
      if (toolCalls >= maxToolCalls) break;
      const batch = calls.slice(0, Math.min(3, maxToolCalls - toolCalls));
      messages.push({ role: 'assistant', content: result.reply || '', tool_calls: batch });
      for (const call of batch) {
        const outcome = await runTool(call, { toAction, runAction, onStatus, seen });
        steps.push(outcome);
        toolCalls += 1;
        messages.push({ role: 'tool', tool_call_id: call.id || `call-${toolCalls}`, name: call.function.name, content: toolResultText(outcome) });
      }
      continue;
    }

    if (!nativeTools) {
      const jsonCall = parseToolJson(result.reply);
      if (jsonCall) {
        const outcome = await runTool({ id: `json-${toolCalls + 1}`, function: { name: jsonCall.name, arguments: jsonCall.args } }, { toAction, runAction, onStatus, seen });
        steps.push(outcome);
        toolCalls += 1;
        messages.push({ role: 'assistant', content: result.reply });
        messages.push({ role: 'user', content: `TOOL RESULT ${toolResultText(outcome)}` });
        continue;
      }
    }

    return { ok: true, reply: String(result.reply || '').trim(), steps };
  }

  // Step budget exhausted. Ask once for a plain summary without tools so the
  // user still gets an answer instead of a stuck request.
  const last = await chatComplete(settings, [
    ...messages,
    { role: 'user', content: 'Summarise what happened in one or two sentences. Do not call any more tools.' },
  ], { timeoutMs: budget, temperature: 0.3 });
  if (last.ok && last.reply) return { ok: true, reply: last.reply.trim(), steps, limited: true };
  return { ok: false, reason: last.reason || 'tool loop limit', steps };
}

/**
 * One-shot answer for greetings and short social turns. No tools.
 */
async function quickReply({ settings, userName = 'Bharath', history = [], message, instruction = '', timeoutMs = 15_000 } = {}) {
  if (!settings || !settings.baseUrl) return { ok: false, reason: 'unconfigured' };
  const system = systemPrompt({ userName }) + (instruction ? `\n\n${instruction}` : '');
  const result = await chatComplete(settings, [
    { role: 'system', content: system },
    ...normalizeHistory(history).slice(-6),
    { role: 'user', content: String(message || '').trim() },
  ], { timeoutMs, temperature: 0.6 });
  if (!result.ok) return { ok: false, reason: result.reason };
  return { ok: true, reply: String(result.reply || '').trim() };
}

module.exports = {
  respond,
  quickReply,
  systemPrompt,
  greetingText,
  capabilitySummary,
  parseToolJson,
  JSON_TOOL_PROTOCOL,
  DEFAULT_MAX_STEPS,
  DEFAULT_MAX_TOOL_CALLS,
};
