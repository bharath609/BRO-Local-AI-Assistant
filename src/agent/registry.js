'use strict';

// Typed tool registry for BRO 2.0.
//
// Every tool declares a strict JSON-schema-ish input, an optional output
// schema, a risk level, a timeout, and a handler. The model can only name a
// registered tool; arguments are validated before the handler runs, and the
// result is checked before it is shown back to the model.

const { normalizeRisk, confirmationReason, confirmationKey } = require('./policy');
const { TaskCancelledError } = require('./task-state');

class ToolValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolValidationError';
    this.code = 'TOOL_VALIDATION';
  }
}

const MAX_STRING = 4_000;

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value, expected) {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  if (expected === 'array') return actual === 'array';
  if (expected === 'object') return actual === 'object';
  return actual === expected;
}

function validateValue(value, schema, path, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${path} must be a ${schema.type}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.join(', ')}`);
    return;
  }
  if (schema.type === 'string') {
    const max = schema.maxLength || MAX_STRING;
    if (value.length > max) errors.push(`${path} is too long`);
    if (schema.minLength != null && value.length < schema.minLength) errors.push(`${path} is too short`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${path} has an invalid format`);
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    if (schema.minimum != null && value < schema.minimum) errors.push(`${path} is too small`);
    if (schema.maximum != null && value > schema.maximum) errors.push(`${path} is too large`);
  }
  if (schema.type === 'array') {
    const maxItems = schema.maxItems || 100;
    if (value.length > maxItems) errors.push(`${path} has too many items`);
    if (schema.items) value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, errors));
  }
  if (schema.type === 'object' && schema.properties) {
    const properties = schema.properties;
    for (const key of Object.keys(value)) {
      if (!Object.prototype.hasOwnProperty.call(properties, key)) {
        if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
      }
    }
    for (const [key, property] of Object.entries(properties)) {
      if (value[key] === undefined || value[key] === null) continue;
      validateValue(value[key], property, `${path}.${key}`, errors);
    }
  }
}

function normalizeArguments(raw) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return {};
    try { return JSON.parse(text); } catch { throw new ToolValidationError('arguments are not valid JSON'); }
  }
  if (raw == null) return {};
  return raw;
}

function validateArguments(tool, rawArguments) {
  const args = normalizeArguments(rawArguments);
  if (typeof args !== 'object' || Array.isArray(args)) throw new ToolValidationError('arguments must be an object');
  const schema = tool.parameters || { type: 'object', properties: {} };
  const properties = schema.properties || {};
  const errors = [];
  for (const key of Object.keys(args)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) errors.push(`unexpected argument: ${key}`);
  }
  for (const [key, property] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    validateValue(value, property, key, errors);
  }
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') errors.push(`missing argument: ${key}`);
  }
  if (errors.length) throw new ToolValidationError(errors[0]);
  return args;
}

function validateOutput(tool, result) {
  if (!tool.output) return result;
  const errors = [];
  validateValue(result, tool.output, 'result', errors);
  if (errors.length) throw new ToolValidationError(`tool returned invalid output: ${errors[0]}`);
  return result;
}

function openAiTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

class ToolRegistry {
  constructor(tools = []) {
    this.tools = new Map();
    for (const tool of tools) this.register(tool);
  }

  register(tool) {
    if (!tool || typeof tool.name !== 'string' || !tool.name.trim()) throw new ToolValidationError('tool needs a name');
    if (typeof tool.handler !== 'function') throw new ToolValidationError(`tool ${tool.name} needs a handler`);
    if (this.tools.has(tool.name)) throw new ToolValidationError(`duplicate tool: ${tool.name}`);
    this.tools.set(tool.name, {
      risk: 'read',
      timeoutMs: 15_000,
      parameters: { type: 'object', properties: {}, required: [] },
      ...tool,
      risk: normalizeRisk(tool.risk),
    });
    return this;
  }

  get(name) {
    return this.tools.get(String(name || '').trim()) || null;
  }

  list() {
    return [...this.tools.values()];
  }

  definitions() {
    return this.list().map(openAiTool);
  }

  confirmationReason(name, args, ctx) {
    const tool = this.get(name);
    return tool ? confirmationReason(tool, args, ctx) : 'Unknown tool.';
  }

  confirmationKey(name, args) {
    return confirmationKey(name, args);
  }

  async execute(name, rawArguments, ctx = {}) {
    const tool = this.get(name);
    if (!tool) throw new ToolValidationError(`unknown tool: ${name}`);
    const args = validateArguments(tool, rawArguments);
    const reason = confirmationReason(tool, args, ctx);
    if (reason) {
      const pending = { name: tool.name, args, reason, key: confirmationKey(tool.name, args) };
      return { status: 'needs_confirmation', tool: tool.name, args, pending, message: reason };
    }
    if (ctx.locked && tool.risk !== 'read') {
      return {
        status: 'blocked',
        tool: tool.name,
        args,
        message: 'Master lock is on, so I kept that step waiting. Say “unlock controls” when you want BRO to act again.',
      };
    }

    const task = ctx.task || null;
    if (task) {
      task.assertActive();
      task.toolCalls += 1;
    }

    const timeoutMs = Number(tool.timeoutMs) > 0 ? Number(tool.timeoutMs) : 15_000;
    let timer = null;
    let result;
    try {
      const work = Promise.resolve().then(() => tool.handler(args, ctx));
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${tool.name} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
      });
      result = await Promise.race([work, timeout]);
      if (task) task.assertActive();
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (result && typeof result === 'object' && result.ok === false) {
      return { status: 'failed', tool: tool.name, args, message: result.message || 'The tool reported a failure.' };
    }
    return { status: 'ok', tool: tool.name, args, result: validateOutput(tool, result) };
  }
}

module.exports = {
  ToolRegistry,
  ToolValidationError,
  TaskCancelledError,
  validateArguments,
  validateOutput,
  validateValue,
  openAiTool,
};
