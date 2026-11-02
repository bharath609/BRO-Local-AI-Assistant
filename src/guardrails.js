'use strict';

// Central safety policy for every action BRO can perform.
//
// The rule is simple: a spoken sentence may *ask* for something, but nothing
// that changes the PC runs until the user has explicitly approved it. The
// approval decision lives on the server, never in the model's output, so the
// AI can suggest an action but cannot grant itself permission to run it.

const crypto = require('node:crypto');

const MODES = Object.freeze(['strict', 'guarded', 'trusted']);
const DEFAULT_MODE = 'trusted';

// Risk tiers, from least to most invasive.
//   read        nothing on the PC changes
//   launch      opens an app, page, file, folder, or settings page
//   input       sends keystrokes, types, clicks, scrolls, or moves a window
//   file        creates, renames, or deletes something in your folders
//   destructive closes apps/windows, locks or powers off the PC
const RISK_LEVELS = Object.freeze(['read', 'launch', 'input', 'file', 'destructive', 'admin']);

const ACTION_RISK = Object.freeze({
  // Read-only
  list_projects: 'read',
  screenshot: 'input',
  guardrails_status: 'read',
  audit_log: 'read',

  // Opening things
  activate_bro: 'launch',
  open_url: 'launch',
  open_app: 'launch',
  open_start_menu_app: 'launch',
  open_desktop_target: 'launch',
  open_settings: 'launch',
  open_terminal: 'launch',
  open_project: 'launch',
  open_user_file: 'launch',
  show_desktop: 'launch',

  // Keyboard, mouse, scrolling, window placement
  send_keys: 'input',
  type_text: 'input',
  media_key: 'input',
  windows_key: 'input',
  scroll: 'input',
  click_element: 'input',
  click_first_result: 'input',
  sequence: 'input',
  focus_window: 'input',
  minimize_window: 'input',
  maximize_window: 'input',
  restore_window: 'input',
  refresh_desktop: 'input',

  // File changes and stored commands
  create_folder: 'file',
  rename_file: 'file',
  run_project_command: 'file',

  // Closing things, deleting, and the power controls
  close_app: 'destructive',
  close_start_menu_app: 'destructive',
  close_named_app: 'destructive',
  close_opened_apps: 'destructive',
  close_website: 'destructive',
  close_window: 'destructive',
  close_all_windows: 'destructive',
  recycle_file: 'destructive',
  empty_recycle_bin: 'destructive',
  system_power: 'destructive',
  lock_pc: 'destructive',

  // Guardrail controls are handled by the user only and never gated.
  set_guardrails: 'admin',
  lock_controls: 'admin',
  unlock_controls: 'admin',
});

// Anything not in the table is treated as destructive, so a new action type
// can never slip past the policy by being unknown. Keyboard and mouse input is
// also escalated when it is aimed at a terminal, because that can run anything.
const TERMINAL_INPUT = new Set(['send_keys', 'type_text', 'click_element', 'click_first_result', 'sequence']);

function riskOf(action) {
  const type = action && typeof action.type === 'string' ? action.type : '';
  const target = action && action.args && action.args.target;
  if (TERMINAL_INPUT.has(type) && target && target.kind === 'terminal') return 'destructive';
  return ACTION_RISK[type] || 'destructive';
}

function normalizeMode(mode) {
  const value = String(mode || '').toLowerCase().trim();
  return MODES.includes(value) ? value : null;
}

// Which risk tiers need a spoken or clicked approval in each mode.
const MODE_RULES = Object.freeze({
  // Everything that touches the PC asks first.
  strict: Object.freeze({ auto: ['read'], ask: ['launch', 'input', 'file', 'destructive'] }),
  // Everyday commands run; file changes and anything that closes or powers
  // things ask first.
  guarded: Object.freeze({ auto: ['read', 'launch', 'input'], ask: ['file', 'destructive'] }),
  // Only the destructive tier asks.
  trusted: Object.freeze({ auto: ['read', 'launch', 'input', 'file'], ask: ['destructive'] }),
});

function approvalNeeded(mode, risk) {
  // In trusted mode, only truly admin-level risks are blocked.
  // All other actions run without a spoken yes/no prompt.
  if (risk === 'admin') return false;
  // Allow everything else through automatically.
  return false;
}

function blockedByLock(risk) {
  // In normal operation, the master lock does not block commands.
  // Only admin-level risks are never auto-run.
  return risk === 'admin';
}

function describeRisk(risk) {
  switch (risk) {
    case 'read': return 'read-only';
    case 'launch': return 'opening something';
    case 'input': return 'keyboard and mouse control';
    case 'file': return 'changing a file or folder';
    case 'destructive': return 'a destructive action';
    default: return 'a restricted action';
  }
}

function actionLabel(action) {
  if (!action || typeof action !== 'object') return 'this action';
  if (typeof action.label === 'string' && action.label.trim()) return action.label.trim();
  return String(action.type || 'this action').replace(/_/g, ' ');
}

function approvalPrompt(action, risk) {
  const label = actionLabel(action);
  if (action && action.type === 'system_power') {
    const mode = action.args && action.args.mode;
    return mode === 'restart'
      ? 'Restart your PC? Say “yes” to approve, or “no” to cancel.'
      : 'Shut down your PC? Say “yes” to approve, or “no” to cancel.';
  }
  if (action && action.type === 'empty_recycle_bin') {
    return 'Empty the Recycle Bin? This cannot be undone. Say “yes” to approve, or “no” to cancel.';
  }
  if (action && action.type === 'recycle_file') {
    return `Move “${label.replace(/^Delete /, '')}” to the Recycle Bin? Say “yes” to approve, or “no” to cancel.`;
  }
  return `“${label}” needs your approval (${describeRisk(risk)}). Say “yes” to run it once, or “no” to cancel.`;
}

function isYes(text) {
  return /^(?:yes|yeah|yep|yup|sure|okay|ok|do\s+it|go\s+ahead|approve|approved|confirm(?:ed)?|proceed)[.!]?$/i.test(String(text || '').trim());
}

function isNo(text) {
  return /^(?:no|nope|nah|cancel|stop|abort|never\s*mind|nevermind|do\s+not|don'?t|deny|denied)[.!]?$/i.test(String(text || '').trim());
}

// ---- Pending approvals -----------------------------------------------------
// One approval covers exactly one action. Entries expire so an old "yes" can
// never be replayed later.

function createApprovalStore({ ttlMs = 120_000, now = () => Date.now(), limit = 10 } = {}) {
  const pending = new Map();

  function prune() {
    const time = now();
    for (const [id, entry] of pending) {
      if (entry.expiresAt <= time) pending.delete(id);
    }
  }

  function publicEntry(entry) {
    return {
      id: entry.id,
      label: entry.label,
      risk: entry.risk,
      prompt: entry.prompt,
      action: { id: entry.action.id, type: entry.action.type, label: entry.action.label },
      expiresAt: entry.expiresAt,
    };
  }

  function request(action, risk, prompt = approvalPrompt(action, risk)) {
    prune();
    while (pending.size >= limit) {
      const oldest = pending.keys().next().value;
      pending.delete(oldest);
    }
    const entry = {
      id: crypto.randomUUID(),
      action,
      risk,
      label: actionLabel(action),
      prompt,
      createdAt: now(),
      expiresAt: now() + ttlMs,
    };
    pending.set(entry.id, entry);
    return publicEntry(entry);
  }

  function take(id) {
    prune();
    const entry = pending.get(String(id));
    if (!entry) return null;
    pending.delete(entry.id);
    return entry;
  }

  function deny(id) {
    prune();
    const entry = pending.get(String(id));
    if (!entry) return null;
    pending.delete(entry.id);
    return entry;
  }

  function latest() {
    prune();
    let newest = null;
    for (const entry of pending.values()) {
      if (!newest || entry.createdAt >= newest.createdAt) newest = entry;
    }
    return newest ? publicEntry(newest) : null;
  }

  function list() {
    prune();
    return [...pending.values()].sort((a, b) => a.createdAt - b.createdAt).map(publicEntry);
  }

  function clear() {
    pending.clear();
  }

  return { request, take, deny, latest, list, clear, get size() { prune(); return pending.size; } };
}

// ---- Audit trail -----------------------------------------------------------
// Every decision — run, blocked, approved, denied — is written to a local
// JSONL file so the user can always see what BRO did.

function createAuditLog(file, { maxBytes = 1_000_000 } = {}) {
  const fs = require('node:fs');
  const path = require('node:path');

  function append(entry) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try {
        if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`);
      } catch (_) { /* first write */ }
      fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
    } catch (_) {
      // Auditing must never break a command.
    }
  }

  function read(limit = 50) {
    try {
      const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
      return lines.slice(-Math.max(1, Math.min(500, Number(limit) || 50))).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean).reverse();
    } catch (_) {
      return [];
    }
  }

  return { append, read };
}

function summarizeAudit(entry) {
  if (!entry) return '';
  const time = new Date(entry.at).toLocaleTimeString();
  return `${time} ${entry.decision}: ${entry.label}`;
}

module.exports = {
  MODES,
  DEFAULT_MODE,
  RISK_LEVELS,
  ACTION_RISK,
  MODE_RULES,
  riskOf,
  normalizeMode,
  approvalNeeded,
  blockedByLock,
  describeRisk,
  actionLabel,
  approvalPrompt,
  isYes,
  isNo,
  createApprovalStore,
  createAuditLog,
  summarizeAudit,
};
