const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { authorize, timingSafeEqualText } = require('../src/auth');
const { createSecretBox } = require('../src/secret');
const { createStore } = require('../src/store');
const { createLogger, redact } = require('../src/logger');

const TOKEN = 'test-token-0123456789abcdef0123456789abcdef';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-security-'));
process.env.BRO_DATA_DIR = path.join(root, 'data');
process.env.BRO_API_TOKEN = TOKEN;
const serverModule = require('../server');

function request(base, pathname, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, base);
    const request = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text }));
    });
    request.on('error', reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

test('API token is required only when configured', () => {
  const base = { pathname: '/api/bootstrap', method: 'GET', headers: { host: '127.0.0.1:4280' } };
  assert.equal(authorize({ ...base, token: '' }), null);
  const missing = authorize({ ...base, token: TOKEN });
  assert.equal(missing.status, 401);
  assert.equal(missing.reason, 'token');
  assert.equal(authorize({ ...base, token: TOKEN, headers: { ...base.headers, 'x-bro-token': TOKEN } }), null);
  assert.equal(authorize({ ...base, token: TOKEN, headers: { ...base.headers, authorization: `Bearer ${TOKEN}` } }), null);
  assert.equal(authorize({ ...base, token: TOKEN, headers: { ...base.headers, 'x-bro-token': 'wrong' } }).status, 401);
});

test('non-loopback hosts and cross-site origins are rejected', () => {
  const local = { pathname: '/api/bootstrap', method: 'GET', token: '', headers: { host: '127.0.0.1:4280' } };
  assert.equal(authorize({ ...local, headers: { host: 'evil.example' } }).reason, 'host');
  assert.equal(authorize({ ...local, headers: { host: '127.0.0.1.nip.io:4280' } }).reason, 'host');
  assert.equal(authorize({ ...local, headers: { ...local.headers, origin: 'https://evil.example' } }).reason, 'origin');
  assert.equal(authorize({ ...local, headers: { ...local.headers, origin: 'http://127.0.0.1:4280' } }), null);
  assert.equal(authorize({ ...local, headers: { ...local.headers, origin: 'http://localhost:4280' } }), null);
});

test('token comparison does not leak length', () => {
  assert.equal(timingSafeEqualText(TOKEN, TOKEN), true);
  assert.equal(timingSafeEqualText(TOKEN, `${TOKEN}x`), false);
  assert.equal(timingSafeEqualText(TOKEN, ''), false);
});

test('credentials are encrypted at rest when a master key exists', () => {
  const dataDir = path.join(root, 'encrypted');
  const store = createStore(dataDir, { secretKey: 'a'.repeat(64) });
  store.updateSettings({ apiKey: 'sk-super-secret-value' });
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.match(raw.apiKey, /^enc:v1:/);
  assert.doesNotMatch(raw.apiKey, /super-secret/);
  assert.equal(store.loadSettings().apiKey, 'sk-super-secret-value');
});

test('an existing plaintext key is upgraded on first read', () => {
  const dataDir = path.join(root, 'migrate');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({ apiKey: 'plain-key-value' }));
  const store = createStore(dataDir, { secretKey: 'b'.repeat(64) });
  assert.equal(store.loadSettings().apiKey, 'plain-key-value');
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.match(raw.apiKey, /^enc:v1:/);
});

test('a key from another machine decrypts to empty instead of crashing', () => {
  const box = createSecretBox('c'.repeat(64));
  const other = createSecretBox('d'.repeat(64));
  const encrypted = box.encrypt('secret');
  assert.notEqual(encrypted, 'secret');
  assert.equal(box.decrypt(encrypted), 'secret');
  assert.equal(other.decrypt(encrypted), '');
});

test('log output redacts credentials and rotates', () => {
  assert.doesNotMatch(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz'), /abcdefghijklmnop/);
  assert.doesNotMatch(redact('{"apiKey":"sk-live-1234567890abcd"}'), /sk-live/);
  assert.doesNotMatch(redact('C:\\Users\\bharath\\secret.txt'), /bharath/);

  const dir = path.join(root, 'logs');
  const logger = createLogger(dir, { maxBytes: 200 });
  for (let index = 0; index < 30; index += 1) logger.info(`entry ${index} token=${TOKEN}`);
  const files = fs.readdirSync(dir);
  assert.ok(files.some((name) => name.endsWith('.log.1')), `expected a rotated file, saw ${files.join(', ')}`);
  const text = files.filter((name) => name.endsWith('.log') || name.endsWith('.log.1'))
    .map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('');
  assert.doesNotMatch(text, new RegExp(TOKEN));
});

test('the HTTP server enforces the token and sends security headers', async () => {
  await new Promise((resolve, reject) => {
    serverModule.server.once('error', reject);
    serverModule.server.listen(0, serverModule.HOST, () => {
      serverModule.server.off('error', reject);
      resolve();
    });
  });
  const base = `http://${serverModule.HOST}:${serverModule.server.address().port}`;
  try {
    const page = await request(base, '/index.html');
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /default-src 'self'/);
    assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal(page.headers['referrer-policy'], 'no-referrer');

    const anonymous = await request(base, '/api/bootstrap');
    assert.equal(anonymous.status, 401);

    const authorized = await request(base, '/api/bootstrap', { headers: { 'x-bro-token': TOKEN } });
    assert.equal(authorized.status, 200);
    assert.equal(JSON.parse(authorized.body).appName, 'BRO Local AI Assistant');

    const crossSite = await request(base, '/api/bootstrap', { headers: { 'x-bro-token': TOKEN, origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
  } finally {
    await new Promise((resolve) => serverModule.server.close(resolve));
  }
});
