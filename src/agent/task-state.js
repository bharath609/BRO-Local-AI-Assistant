'use strict';

// One observable task at a time, with cancellation.
//
// BRO is single-user, so a module-level manager is enough. Every step is
// recorded so the UI and the final reply can state what actually happened.

const { randomUUID } = require('node:crypto');

class TaskCancelledError extends Error {
  constructor(message = 'Task cancelled.') {
    super(message);
    this.name = 'TaskCancelledError';
    this.code = 'TASK_CANCELLED';
  }
}

class TaskState {
  constructor({ goal = '', maxSteps = 12, maxToolCalls = 20 } = {}) {
    this.id = randomUUID();
    this.goal = String(goal || '');
    this.status = 'running';
    this.startedAt = Date.now();
    this.finishedAt = 0;
    this.maxSteps = Math.max(1, Number(maxSteps) || 12);
    this.maxToolCalls = Math.max(1, Number(maxToolCalls) || 20);
    this.toolCalls = 0;
    this.steps = [];
    this.cancelled = false;
    this.cancelReason = '';
    this.pending = null;
  }

  assertActive() {
    if (this.cancelled) throw new TaskCancelledError(this.cancelReason || 'Task cancelled.');
    if (this.status !== 'running') throw new TaskCancelledError(`Task is ${this.status}.`);
  }

  addStep(step = {}) {
    const entry = {
      id: this.steps.length + 1,
      at: Date.now(),
      status: 'running',
      tool: '',
      summary: '',
      ...step,
    };
    this.steps.push(entry);
    return entry;
  }

  updateStep(id, patch = {}) {
    const entry = this.steps.find((step) => step.id === id);
    if (!entry) return null;
    Object.assign(entry, patch);
    return entry;
  }

  cancel(reason = 'Cancelled by the user.') {
    if (this.status !== 'running') return false;
    this.cancelled = true;
    this.cancelReason = String(reason || 'Cancelled by the user.');
    this.status = 'cancelled';
    this.finishedAt = Date.now();
    return true;
  }

  complete(status = 'completed') {
    if (this.status === 'running') {
      this.status = status;
      this.finishedAt = Date.now();
    }
    return this.snapshot();
  }

  snapshot() {
    return {
      id: this.id,
      goal: this.goal,
      status: this.status,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt,
      toolCalls: this.toolCalls,
      steps: this.steps.map((step) => ({ ...step })),
      cancelled: this.cancelled,
      cancelReason: this.cancelReason,
      pending: this.pending,
    };
  }
}

class TaskManager {
  constructor() {
    this.current = null;
  }

  start(options = {}) {
    if (this.current && this.current.status === 'running') {
      this.current.cancel('Superseded by a new task.');
    }
    this.current = new TaskState(options);
    return this.current;
  }

  cancel(reason) {
    return this.current ? this.current.cancel(reason) : false;
  }

  get() {
    return this.current;
  }

  active() {
    return Boolean(this.current && this.current.status === 'running');
  }

  snapshot() {
    return this.current ? this.current.snapshot() : null;
  }
}

module.exports = { TaskState, TaskManager, TaskCancelledError };
