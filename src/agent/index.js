'use strict';

// BRO 2.0 agent runtime.
//
// One task at a time. The deterministic router in assistant.js still handles
// ordinary commands first; requests that need several steps or real computer
// use are handed to this runtime, which owns the tool registry, the task state,
// cancellation and the pending confirmation.

const files = require('./adapters/files');
const vscode = require('./adapters/vscode');
const notepad = require('./adapters/notepad');
const observation = require('./observation');
const browser = require('./adapters/browser');
const webapps = require('./adapters/webapps');
const { ToolRegistry } = require('./registry');
const { TaskManager } = require('./task-state');
const { PlannerSession } = require('./planner');
const { chatComplete } = require('../provider');

function buildRegistry(extraTools = []) {
  return new ToolRegistry([
    ...files.fileTools(),
    ...vscode.vscodeTools(),
    ...notepad.notepadTools(),
    ...observation.observationTools(),
    ...browser.browserTools(),
    ...webapps.webAppTools(),
    ...extraTools,
  ]);
}

const ACTION_WORDS = /\b(open|launch|create|make|write|edit|save|rename|move|copy|run|execute|click|fill|type|read|search|find|play|pause|draft|compose|send|organize|download|upload|scroll|navigate|go\s+to|switch\s+to|inspect|verify)\b/;
const TARGET_WORDS = /\b(file|folder|directory|script|program|code|project|page|website|browser|tab|email|inbox|gmail|youtube|linkedin|notepad|vs\s?code|visual\s+studio\s+code|desktop|documents?|downloads?)\b/;

// Decides whether a request needs the multi-step agent instead of the fast
// deterministic router or a one-shot conversational answer. Kept deliberately
// narrow so “open Notepad” and “play X on YouTube” stay instant.
function looksLikeAgentTask(input) {
  const text = String(input || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!text) return false;
  if (/^(?:agent|computer use|step by step)\b[:,]?/.test(text)) return true;
  if (/^(?:what|why|how|who|when|where|explain|tell me|can you explain)\b/.test(text)) return false;
  // Simple one-shot commands the deterministic skills already handle well.
  if (/^(?:scroll|type|press|click)\b/.test(text) && !/\b(?:then|and|into|page|browser|field|form|website|window)\b/.test(text)) return false;
  if (/^(?:search|find)\s+(?:gmail|my\s+(?:email|inbox|mail)|google)\b/.test(text) && !/\b(?:then|and|reply|draft)\b/.test(text)) return false;
  if (/^play\b/.test(text) && !/\b(?:and then|then|first|search)\b/.test(text)) return false;
  if (/\b(?:and then|then|after that|followed by)\b/.test(text) && ACTION_WORDS.test(text)) return true;
  if (/\b(?:in|inside|using|with)\s+(?:vs\s?code|visual studio code|notepad|chrome|edge|the browser|youtube|gmail|linkedin)\b/.test(text)) return true;
  if (/\b(?:create|write|edit|save|run|execute)\b/.test(text) && /\b(?:file|script|program|code|note|document)\b/.test(text)) return true;
  if (/\b(?:click|fill|type into|submit|draft|compose|reply to)\b/.test(text)) return true;
  if (/\b(?:read|check|search)\b.*\b(?:inbox|email|gmail|linkedin|page|website)\b/.test(text)) return true;
  if (/\b(?:organize|sort|move|rename|copy)\b.*\b(?:files?|folders?|desktop|downloads|documents?)\b/.test(text)) return true;
  if (/\bsearch linkedin\b|\blinkedin\b.*\b(?:people|jobs|posts)\b/.test(text)) return true;
  if (/\byoutube\b.*\b(?:search|first|results?)\b|\bsearch\b.*\byoutube\b/.test(text)) return true;
  if (/\b(?:open|go to|navigate to)\b.*\b(?:then|and)\b/.test(text) && TARGET_WORDS.test(text)) return true;
  if (/\bvscode\b|\bvs code\b/.test(text) && ACTION_WORDS.test(text)) return true;
  return false;
}

function oneLine(value, limit = 140) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);
}

function actionTarget(args = {}) {
  const value = args.path || args.url || args.query || args.to || args.text || args.label || args.selector || args.window || args.name || '';
  return oneLine(value, 120);
}

function describePending(pending) {
  if (!pending) return '';
  const friendly = String(pending.name || '').replace(/_/g, ' ');
  const target = actionTarget(pending.args);
  return target ? `${friendly} (${target})` : friendly;
}

function confirmationPrompt(pending) {
  return `Before I ${describePending(pending)}: ${pending.reason} Say “yes” to run just that step, or “no” to cancel.`;
}

function friendlyFailure(reason) {
  const text = String(reason || '');
  if (/timeout|timed out/i.test(text)) return 'The AI model took too long while planning, so I stopped that task.';
  if (/not installed/i.test(text)) return 'The configured local model is not installed yet. Pull it once, then ask me again.';
  if (/unconfigured/i.test(text)) return 'No AI provider is configured, so I can only run the direct commands.';
  return text || 'I could not finish that task.';
}

class AgentManager {
  constructor({ registry = buildRegistry(), tasks = new TaskManager(), complete = chatComplete } = {}) {
    this.registry = registry;
    this.tasks = tasks;
    this.complete = complete;
    this.session = null;
    this.lastTask = null;
    this.createdAt = Date.now();
  }

  get pending() {
    return this.session && this.session.pending ? this.session.pending : null;
  }

  isBusy() {
    return Boolean(this.session && !this.session.finished && this.session.task && this.session.task.status === 'running');
  }

  cancel(reason = 'Cancelled by the user.') {
    const session = this.session;
    if (!session) return { cancelled: false };
    session.expire();
    this.tasks.cancel(reason);
    this.lastTask = session.task.snapshot();
    const hadPending = Boolean(session.pending);
    session.pending = null;
    session.task.pending = null;
    this.session = null;
    return { cancelled: true, hadPending, task: this.lastTask };
  }

  async run({ goal = '', history = [], projects = [], userName = 'Bharath', settings, guardrails, dataDir = '', extraRoots = [], cdpPort, onStatus } = {}) {
    if (!settings || !settings.baseUrl) {
      return { status: 'failed', ok: false, reply: friendlyFailure('unconfigured'), reason: 'unconfigured' };
    }
    if (this.session && !this.session.finished) {
      // A new goal replaces an unfinished one, including a pending confirmation.
      this.cancel('Superseded by a new task.');
    }
    const task = this.tasks.start({ goal });
    this.lastTask = task;
    const session = new PlannerSession({
      goal,
      history,
      projects,
      userName,
      settings,
      task,
      registry: this.registry,
      complete: this.complete,
      onStatus,
      ctx: {
        projects,
        dataDir,
        extraRoots,
        ...(cdpPort ? { cdpPort } : {}),
        locked: Boolean(guardrails && guardrails.locked),
        guardrails: guardrails || null,
      },
    });
    this.session = session;
    const result = await session.run();
    this.lastTask = result.task || task.snapshot();
    if (result.status === 'awaiting_confirmation') {
      return {
        status: 'awaiting_confirmation',
        ok: true,
        reply: confirmationPrompt(result.pending),
        pending: result.pending,
        task: result.task,
      };
    }
    if (result.status === 'completed') {
      this.session = null;
      return { status: 'completed', ok: true, reply: result.reply, task: result.task };
    }
    if (result.status === 'cancelled') {
      this.session = null;
      return { status: 'cancelled', ok: false, reply: result.reply || 'Task cancelled.', task: result.task };
    }
    this.session = null;
    return { status: 'failed', ok: false, reply: friendlyFailure(result.reply), reason: result.reply, task: result.task };
  }

  async resume({ approve = true, onStatus } = {}) {
    const session = this.session;
    if (!session || !session.pending) {
      return { status: 'expired', ok: false, reply: 'That confirmation is no longer valid. Please ask me again.' };
    }
    if (typeof onStatus === 'function') session.onStatus = onStatus;
    const result = await session.resume({ approve });
    this.lastTask = result.task || this.lastTask;
    if (result.status === 'awaiting_confirmation') {
      // Unusual: a confirmed step produced another confirmation request.
      return {
        status: 'awaiting_confirmation',
        ok: true,
        reply: confirmationPrompt(result.pending),
        pending: result.pending,
        task: result.task,
      };
    }
    if (result.status === 'completed') {
      this.session = null;
      return { status: 'completed', ok: true, reply: result.reply, task: result.task };
    }
    if (result.status === 'cancelled') {
      this.session = null;
      return { status: 'cancelled', ok: false, reply: result.reply || 'Cancelled.', task: result.task };
    }
    this.session = null;
    return { status: 'failed', ok: false, reply: friendlyFailure(result.reply), reason: result.reply, task: result.task };
  }

  status() {
    const session = this.session;
    return {
      busy: this.isBusy(),
      awaitingConfirmation: Boolean(session && session.pending),
      pending: session && session.pending ? {
        name: session.pending.name,
        reason: session.pending.reason,
        target: actionTarget(session.pending.args),
        at: session.pending.at,
      } : null,
      task: this.lastTask,
      tools: this.registry.list().length,
    };
  }
}

// One runtime per process, exactly like the app’s existing stores.
const agent = new AgentManager();

module.exports = {
  AgentManager,
  agent,
  buildRegistry,
  looksLikeAgentTask,
  confirmationPrompt,
  describePending,
  actionTarget,
  friendlyFailure,
  files,
  vscode,
  notepad,
  observation,
  browser,
  webapps,
};
