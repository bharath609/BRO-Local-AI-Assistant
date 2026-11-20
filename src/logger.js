'use strict';

// Small dependency-free file logger with secret redaction and rotation.
//
// Electron's console output disappears when the app is started from a
// shortcut, so the shell mirrors backend output into a log file. Anything that
// looks like a credential is scrubbed before it touches disk.

const fs = require('node:fs');
const path = require('node:path');

const REDACTED = '[redacted]';

function redact(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value == null ? '' : value);
  return String(text)
    // Authorization: Bearer <token>
    .replace(/(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${REDACTED}`)
    // apiKey / api_key / token / secret / password in JSON or key=value form
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|authorization)["']?\s*[:=]\s*"?)([^"'\s,;}]{4,})/gi, `$1${REDACTED}`)
    // OpenAI-style keys that appear on their own
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, `sk-${REDACTED}`)
    // Raw base64 audio blobs from request bodies
    .replace(/("(?:audio|data)"\s*:\s*")[A-Za-z0-9+/=]{200,}(")/g, `$1${REDACTED}$2`)
    // Home directory paths are personal; keep the file name only.
    .replace(/([A-Za-z]:\\Users\\)[^\\\s"']+/gi, '$1*');
}

function timestamp(date) {
  return date.toISOString().slice(0, 10);
}

function createLogger(logDir, { maxBytes = 2_000_000, maxFiles = 3, now = () => new Date() } = {}) {
  let disabled = false;

  function currentFile() {
    return path.join(logDir, `bro-${timestamp(now())}.log`);
  }

  function rotate(file) {
    try {
      if (fs.statSync(file).size < maxBytes) return;
    } catch {
      return; // nothing to rotate yet
    }
    try {
      for (let index = maxFiles; index >= 1; index -= 1) {
        const target = `${file}.${index}`;
        if (index === maxFiles) {
          if (fs.existsSync(target)) fs.rmSync(target, { force: true });
        } else if (fs.existsSync(target)) {
          fs.renameSync(target, `${file}.${index + 1}`);
        }
      }
      fs.renameSync(file, `${file}.1`);
    } catch {
      // Rotation is best effort; a locked file must not stop logging.
    }
  }

  function write(level, message, extra) {
    if (disabled) return;
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const file = currentFile();
      rotate(file);
      const entry = { at: now().toISOString(), level, message: redact(message) };
      if (extra !== undefined) entry.detail = redact(extra);
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // If logging fails (permissions, disk full), keep the app running.
      disabled = true;
    }
  }

  return {
    dir: logDir,
    file: currentFile,
    write,
    info: (message, extra) => write('info', message, extra),
    warn: (message, extra) => write('warn', message, extra),
    error: (message, extra) => write('error', message, extra),
  };
}

// Mirror a child process stream into the logger one line at a time.
function pipeToLogger(stream, logger, label, level = 'info') {
  if (!stream) return;
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) logger.write(level, `${label}: ${line}`);
    }
  });
  stream.on('end', () => {
    if (buffer.trim()) logger.write(level, `${label}: ${buffer}`);
    buffer = '';
  });
}

module.exports = { createLogger, pipeToLogger, redact };
