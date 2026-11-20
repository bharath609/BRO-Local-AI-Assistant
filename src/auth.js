'use strict';

// Local HTTP API protection.
//
// The backend only ever listens on loopback, but a loopback listener is still
// reachable from any web page the user has open (CSRF / DNS rebinding). Two
// cheap checks close that gap:
//
//   1. Host must be a loopback name.
//   2. Origin, when a browser sends one, must also be loopback.
//   3. When the Electron shell launches the backend it generates a random
//      per-launch token and injects it into its own requests. Requests from
//      anything that does not know the token are rejected.
//
// The token is optional: plain `node server.js` and the test suite keep
// working with auth disabled, because nothing is exposed beyond this machine.

const crypto = require('node:crypto');

const TOKEN_HEADERS = ['x-bro-token', 'x-api-token'];

function digest(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest();
}

function timingSafeEqualText(a, b) {
  // Hashing first makes the comparison length-constant, so neither the token
  // value nor its length leaks through timing.
  return crypto.timingSafeEqual(digest(a), digest(b));
}

function hostnameOf(hostHeader) {
  const value = String(hostHeader || '').trim().toLowerCase();
  if (!value) return '';
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : '';
  }
  const colon = value.lastIndexOf(':');
  if (colon > 0 && /^\d{1,5}$/.test(value.slice(colon + 1))) return value.slice(0, colon);
  return value;
}

function isLoopbackHostname(name) {
  return name === '127.0.0.1' || name === 'localhost' || name === '::1';
}

function isLoopbackOrigin(origin) {
  if (!origin || origin === 'null') return false;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  return isLoopbackHostname(parsed.hostname.toLowerCase());
}

function bearerToken(headers = {}) {
  for (const name of TOKEN_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  const authorization = headers.authorization;
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1].trim();
  }
  return '';
}

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/');
}

// Returns null when the request may proceed, or { status, error } when it must
// be rejected. `token` is the expected secret; omit it to disable token checks.
function authorize({ pathname, method, headers, token } = {}) {
  const host = hostnameOf(headers && headers.host);
  if (!isLoopbackHostname(host)) {
    return { status: 403, error: 'Requests must target this computer.', reason: 'host' };
  }

  const origin = headers && headers.origin;
  if (origin !== undefined && origin !== '' && !isLoopbackOrigin(origin)) {
    return { status: 403, error: 'Cross-origin requests are not allowed.', reason: 'origin' };
  }

  if (!token || !isApiPath(pathname)) return null;

  // Browsers cannot set arbitrary headers on a cross-site request without a
  // CORS preflight, which this server never approves.
  if (method === 'OPTIONS') {
    return { status: 403, error: 'Cross-origin requests are not allowed.', reason: 'preflight' };
  }

  const provided = bearerToken(headers);
  if (!provided || !timingSafeEqualText(provided, token)) {
    return { status: 401, error: 'A valid BRO access token is required.', reason: 'token' };
  }
  return null;
}

module.exports = {
  authorize,
  bearerToken,
  hostnameOf,
  isLoopbackHostname,
  isLoopbackOrigin,
  isApiPath,
  timingSafeEqualText,
};
