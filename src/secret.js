'use strict';

// Encryption for credentials at rest.
//
// The provider API key is the only secret BRO stores. When the Electron shell
// can use the OS keychain (safeStorage), it generates a random master key,
// protects that key with the OS, and hands it to the backend as
// BRO_SECRET_KEY. The backend then encrypts the API key with AES-256-GCM.
//
// Without a master key (plain `node server.js`, tests) the store keeps the
// previous plaintext format so nothing breaks. Reads understand both formats.

const crypto = require('node:crypto');

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function parseKey(raw) {
  if (Buffer.isBuffer(raw) && raw.length === 32) return Buffer.from(raw);
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return null;
  if (/^[0-9a-f]{64}$/i.test(text)) return Buffer.from(text, 'hex');
  try {
    const decoded = Buffer.from(text, 'base64');
    if (decoded.length === 32) return decoded;
  } catch { /* not base64 */ }
  return null;
}

function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function createSecretBox(rawKey) {
  const key = parseKey(rawKey);
  if (!key) return null;

  function encrypt(value) {
    const text = String(value == null ? '' : value);
    if (!text) return '';
    if (isEncrypted(text)) return text;
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
  }

  function decrypt(value) {
    if (typeof value !== 'string' || !value) return '';
    if (!isEncrypted(value)) return value;
    try {
      const payload = Buffer.from(value.slice(PREFIX.length), 'base64');
      if (payload.length <= IV_BYTES + TAG_BYTES) return '';
      const iv = payload.subarray(0, IV_BYTES);
      const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
      const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      // A key from another machine (or a corrupted file) must not crash the
      // app. Treat it as "no key configured" and let the user re-enter it.
      return '';
    }
  }

  return { encrypted: true, encrypt, decrypt, isEncrypted };
}

// Returns null when no usable key is configured.
function createSecretBoxFromEnv(env = process.env) {
  return createSecretBox(env && env.BRO_SECRET_KEY);
}

module.exports = { PREFIX, createSecretBox, createSecretBoxFromEnv, isEncrypted, parseKey };
