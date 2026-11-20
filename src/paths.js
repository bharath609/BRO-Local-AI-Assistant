'use strict';

// Resolves the directories BRO uses in development and in a packaged build.
// This module must not require Electron: the HTTP backend also runs under
// plain Node for development and tests.

const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.resolve(__dirname, '..');

function envPath(value, fallback) {
  if (typeof value === 'string' && value.trim()) return path.resolve(value.trim());
  return fallback;
}

function resolvePaths(env = process.env) {
  const packaged = env.BRO_PACKAGED === '1';
  const resourcesDir = envPath(env.BRO_RESOURCES_DIR, packaged ? (env.BRO_RESOURCES_PATH || APP_ROOT) : APP_ROOT);
  const dataDir = envPath(env.BRO_DATA_DIR, path.join(APP_ROOT, 'data'));
  return {
    packaged,
    appRoot: APP_ROOT,
    resourcesDir,
    publicDir: envPath(env.BRO_PUBLIC_DIR, path.join(APP_ROOT, 'public')),
    dataDir,
    logsDir: envPath(env.BRO_LOGS_DIR, path.join(dataDir, 'logs')),
    scriptsDir: envPath(env.BRO_SCRIPTS_DIR, packaged ? path.join(resourcesDir, 'scripts') : path.join(APP_ROOT, 'scripts')),
    whisperHome: envPath(env.BRO_WHISPER_HOME, packaged ? path.join(resourcesDir, 'whisper') : path.join(APP_ROOT, 'vendor', 'whisper')),
  };
}

const LEGACY_DATA_FILES = ['state.json', 'settings.json', 'guardrails.json', 'audit.log'];

// Copies the developer's existing data into the packaged data directory the
// first time the app runs. Existing files always win; nothing is ever deleted.
function migrateLegacyData(legacyDir, dataDir, { files = LEGACY_DATA_FILES } = {}) {
  if (!legacyDir || !dataDir) return [];
  const source = path.resolve(legacyDir);
  const target = path.resolve(dataDir);
  if (source === target) return [];
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) return [];
  fs.mkdirSync(target, { recursive: true });
  const copied = [];
  for (const name of files) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    try {
      if (!fs.existsSync(from) || !fs.statSync(from).isFile() || fs.existsSync(to)) continue;
      fs.copyFileSync(from, to);
      copied.push(name);
    } catch {
      // Migration is best effort; the app still starts with defaults.
    }
  }
  return copied;
}

module.exports = { APP_ROOT, resolvePaths, migrateLegacyData, LEGACY_DATA_FILES };
