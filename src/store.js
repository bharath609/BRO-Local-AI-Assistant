const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DEFAULT_MODEL, DEFAULT_PROTOCOL, providerInfo, normalizeProtocol } = require('./provider');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

function canonicalDirectory(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new ValidationError('Project root is required.');
  }
  const absolute = path.resolve(input.trim());
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isDirectory()) {
    throw new ValidationError('Project root must be an existing directory.');
  }
  return fs.realpathSync(absolute);
}

function normalizeCommands(commands) {
  if (commands == null) return {};
  if (!commands || Array.isArray(commands) || typeof commands !== 'object') {
    throw new ValidationError('Commands must be a profile-name map.');
  }
  const result = Object.create(null);
  for (const [name, value] of Object.entries(commands)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name)) {
      throw new ValidationError(`Invalid command profile name: ${name}`);
    }
    const command = typeof value === 'string' ? value : value && value.command;
    if (typeof command !== 'string' || !command.trim()) {
      throw new ValidationError(`Command profile ${name} must contain a command.`);
    }
    result[name] = command.trim();
  }
  return result;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return fallback;
    throw error;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function createStore(dataDir = path.join(__dirname, '..', 'data')) {
  const stateFile = path.join(dataDir, 'state.json');
  const settingsFile = path.join(dataDir, 'settings.json');
  fs.mkdirSync(dataDir, { recursive: true });

  function loadState() {
    const state = readJson(stateFile, { projects: [] });
    if (!state || !Array.isArray(state.projects)) return { projects: [] };
    return state;
  }

  function loadSettings() {
    const settings = readJson(settingsFile, {});
    return {
      baseUrl: typeof settings.baseUrl === 'string' && settings.baseUrl ? settings.baseUrl : (process.env.BRO_AI_BASE_URL || ''),
      model: typeof settings.model === 'string' && settings.model ? settings.model : (process.env.BRO_AI_MODEL || DEFAULT_MODEL),
      protocol: normalizeProtocol(typeof settings.protocol === 'string' && settings.protocol ? settings.protocol : (process.env.BRO_AI_PROTOCOL || DEFAULT_PROTOCOL)),
      apiKey: typeof settings.apiKey === 'string' && settings.apiKey ? settings.apiKey : (process.env.BRO_AI_API_KEY || '')
    };
  }

  function publicProject(project) {
    return {
      id: project.id,
      name: project.name,
      root: project.root,
      commands: { ...(project.commands || {}) }
    };
  }

  function listProjects() {
    return loadState().projects.map(publicProject);
  }

  function getProject(id) {
    const project = loadState().projects.find((item) => item.id === id);
    if (!project) throw new ValidationError('Project was not found.');
    return project;
  }

  function registerProject({ name, root, commands }) {
    if (typeof name !== 'string' || !name.trim()) throw new ValidationError('Project name is required.');
    const canonicalRoot = canonicalDirectory(root);
    const state = loadState();
    if (state.projects.some((project) => project.root === canonicalRoot)) {
      throw new ValidationError('A project with this root is already registered.');
    }
    const project = {
      id: crypto.randomUUID(),
      name: name.trim().slice(0, 120),
      root: canonicalRoot,
      commands: normalizeCommands(commands)
    };
    state.projects.push(project);
    writeJson(stateFile, state);
    return publicProject(project);
  }

  function deleteProject(id) {
    const state = loadState();
    const index = state.projects.findIndex((project) => project.id === id);
    if (index < 0) throw new ValidationError('Project was not found.');
    const [removed] = state.projects.splice(index, 1);
    writeJson(stateFile, state);
    return publicProject(removed);
  }

  function updateSettings({ baseUrl, model, protocol, apiKey }) {
    const current = loadSettings();
    const next = {
      baseUrl: baseUrl === undefined ? current.baseUrl : String(baseUrl || '').trim().replace(/\/$/, ''),
      model: model === undefined ? current.model : String(model || '').trim() || DEFAULT_MODEL,
      protocol: protocol === undefined ? current.protocol : normalizeProtocol(protocol),
      apiKey: apiKey === undefined ? current.apiKey : String(apiKey || '')
    };
    if (next.baseUrl) {
      let parsed;
      try { parsed = new URL(next.baseUrl); } catch { throw new ValidationError('Provider base URL must be a valid URL.'); }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new ValidationError('Provider base URL must use http or https.');
      }
    }
    if (next.apiKey.length > 2000) throw new ValidationError('Provider API key is too long.');
    writeJson(settingsFile, next);
    const info = providerInfo(next);
    return { baseUrl: info.baseUrl, model: info.model, protocol: info.protocol, configured: info.configured };
  }

  return {
    dataDir,
    stateFile,
    settingsFile,
    loadState,
    loadSettings,
    listProjects,
    getProject,
    registerProject,
    deleteProject,
    updateSettings,
    publicProject,
    canonicalDirectory,
    normalizeCommands
  };
}

module.exports = { createStore, ValidationError, canonicalDirectory, normalizeCommands };
