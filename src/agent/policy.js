'use strict';

// Permission and risk model for BRO 2.0 agent tools.
//
// The existing desktop-action guardrails stay exactly as they were. These rules
// add a second, explicit gate for the new computer-use tools: a model plan is
// never enough on its own for work that writes files, runs code, sends
// messages, or submits anything.

const RISKS = Object.freeze(['read', 'launch', 'input', 'file', 'network', 'execute', 'send', 'destructive']);

const ALWAYS_CONFIRM = new Set(['send', 'destructive']);

function normalizeRisk(value) {
  const risk = String(value || '').trim().toLowerCase();
  return RISKS.includes(risk) ? risk : 'destructive';
}

function isWriteIntent(args = {}) {
  if (!args || typeof args !== 'object') return false;
  return args.overwrite === true || args.move === true || args.delete === true || args.mode === 'write';
}

// Returns a reason string when the user must confirm, or '' when the tool may
// run. `ctx.confirmed` only applies to the exact pending tool call, so a generic
// "yes" can never approve a different action.
function confirmationReason(tool, args = {}, ctx = {}) {
  if (!tool) return 'Unknown tool.';
  const risk = normalizeRisk(tool.risk);
  const key = confirmationKey(tool.name, args);
  const confirmed = ctx && ctx.confirmed
    && ctx.confirmed.key === key
    && ctx.confirmed.name === tool.name;
  if (confirmed) return '';

  if (typeof tool.confirm === 'function') {
    const reason = tool.confirm(args);
    if (reason) return String(reason);
  }
  if (ALWAYS_CONFIRM.has(risk)) {
    return tool.confirmationText || `I need your confirmation before I ${tool.name.replace(/_/g, ' ')}.`;
  }
  if (risk === 'execute') {
    return tool.confirmationText || 'Running code changes the computer, so I need your confirmation first.';
  }
  if (risk === 'file' && isWriteIntent(args)) {
    return tool.confirmationText || 'That would overwrite or move something. Confirm the exact target first.';
  }
  return '';
}

function confirmationKey(name, args) {
  let payload = '';
  try { payload = JSON.stringify(args || {}, Object.keys(args || {}).sort()); } catch { payload = '{}'; }
  return `${name}:${payload}`;
}

function describeAction(tool, args = {}) {
  const target = args.path || args.target || args.name || args.query || args.url || '';
  return target ? `${tool.name} (${target})` : tool.name;
}

module.exports = {
  RISKS,
  normalizeRisk,
  confirmationReason,
  confirmationKey,
  describeAction,
  isWriteIntent,
};
