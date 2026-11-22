'use strict';

// Small async PowerShell runner for the agent layer.
//
// `tools.js` keeps its PowerShell helpers private, and the agent must never
// block the HTTP server while an observation runs. This mirrors the same
// invocation flags (no profile, no logo, UTF-8 output) but always asynchronous.

const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT = 12_000;
const MAX_BUFFER = 4 * 1024 * 1024;

function runPowerShellAsync(script, { timeoutMs = DEFAULT_TIMEOUT, env = {} } = {}) {
  if (process.platform !== 'win32') return Promise.reject(new Error('Windows PowerShell is only available on Windows.'));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', String(script || ''),
      ], {
        windowsHide: true,
        shell: false,
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish(new Error(`PowerShell timed out after ${Math.round(timeoutMs / 1000)}s.`));
    }, Math.max(1_000, Number(timeoutMs) || DEFAULT_TIMEOUT));

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_BUFFER) {
        try { child.kill(); } catch { /* ignore */ }
        finish(new Error('PowerShell produced too much output.'));
      }
    });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish(error));
    child.on('close', (code) => {
      finish(null, { code: Number(code) || 0, stdout, stderr });
    });
  });
}

function parseJsonLines(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    for (const line of raw.split(/\r?\n/).reverse()) {
      const candidate = line.trim();
      if (!candidate) continue;
      try {
        const parsed = JSON.parse(candidate);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        // keep looking
      }
    }
    return [];
  }
}

module.exports = { runPowerShellAsync, parseJsonLines, DEFAULT_TIMEOUT };
