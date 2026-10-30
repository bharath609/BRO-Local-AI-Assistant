const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore, ValidationError } = require('../src/store');
const tools = require('../src/tools');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-backend-'));
  const project = fs.mkdtempSync(path.join(root, 'project-'));
  const outside = fs.mkdtempSync(path.join(root, 'outside-'));
  return { root, project, outside, store: createStore(path.join(root, 'data')) };
}

test('rejects non-http URL schemes', () => {
  assert.throws(() => tools.validateHttpUrl('file:///etc/passwd'), /Only http/);
  assert.throws(() => tools.validateHttpUrl('javascript:alert(1)'), /Only http/);
  assert.equal(tools.validateHttpUrl('https://example.com/a'), 'https://example.com/a');
});

test('resolves only fixed Windows desktop target descriptors', () => {
  const downloads = tools.resolveWindowsTarget('Downloads');
  assert.equal(downloads.key, 'downloads');
  assert.equal(downloads.command, 'explorer.exe');
  assert.match(downloads.args[0], /Downloads$/i);
  assert.equal(tools.resolveWindowsTarget('windows settings').key, 'settings');
  assert.equal(tools.resolveWindowsTarget('Microsoft Word').key, 'word');
  assert.equal(tools.resolveWindowsTarget('Pictures').key, 'pictures');
  assert.throws(() => tools.resolveWindowsTarget('C:\\Users\\Bharath\\secret.txt'), /allowlisted/);
});

test('rejects Windows desktop execution on non-Windows hosts', () => {
  if (process.platform !== 'win32') assert.throws(() => tools.openWindowsTarget('notepad'), /only available on Windows/);
});

test('allows only paths inside the registered project root', () => {
  const { project, outside } = fixture();
  assert.equal(tools.validateProjectPath(project, project), fs.realpathSync(project));
  assert.throws(() => tools.validateProjectPath(project, outside), /outside/);
});

test('rejects duplicate project roots after resolution', () => {
  const { store, project } = fixture();
  store.registerProject({ name: 'one', root: project, commands: { test: 'node --version' } });
  assert.throws(() => store.registerProject({ name: 'again', root: path.join(project, '.'), commands: {} }), /already registered/);
});

test('rejects unconfigured command profiles', () => {
  const { store, project } = fixture();
  const registered = store.registerProject({ name: 'one', root: project, commands: { test: 'node --version' } });
  const internal = store.getProject(registered.id);
  assert.equal(internal.commands.test, 'node --version');
  assert.throws(() => {
    if (!Object.hasOwn(internal.commands, 'build')) throw new ValidationError('That project profile is not configured.');
  }, /not configured/);
});

test('stores OpenAI-compatible protocol settings and allows a local endpoint without a key', () => {
  const { store } = fixture();
  const openai = store.updateSettings({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', protocol: 'responses', apiKey: 'test-key' });
  assert.deepEqual(openai, { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', protocol: 'responses', configured: true });
  const local = store.updateSettings({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2:3b', protocol: 'chat', apiKey: '' });
  assert.deepEqual(local, { baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2:3b', protocol: 'chat', configured: true });
});

test('validates action types and approval flag', async () => {
  const serverModule = require('../server');
  await assert.rejects(() => serverModule.executeAction({ type: 'run_project_command', args: {} }), /approval flag/);
  await assert.rejects(() => serverModule.executeAction({ type: 'unknown', args: {} }), /Unsupported/);
  await assert.rejects(() => serverModule.executeAction({ type: 'open_desktop_target', args: { target: 'arbitrary.exe' } }), /allowlisted|only available on Windows/);
});

test('executes the deterministic activate BRO action', async () => {
  const serverModule = require('../server');
  const originalActivateBro = tools.activateBro;
  tools.activateBro = () => ({ activated: true, kind: 'bro_voice', target: 'BRO voice', mode: 'test' });
  try {
    const result = await serverModule.executeAction({ type: 'activate_bro', args: {} });
    assert.equal(result.type, 'activate_bro');
    assert.equal(result.result.activated, true);
    assert.equal(result.result.target, 'BRO voice');
  } finally {
    tools.activateBro = originalActivateBro;
  }
});

test('runs a configured profile only after explicit approval', async () => {
  const { project } = fixture();
  const serverModule = require('../server');
  const registered = serverModule.store.registerProject({ name: 'approval-test', root: project, commands: { test: 'node --version' } });
  try {
    await assert.rejects(() => serverModule.executeAction({ type: 'run_project_command', args: { projectId: registered.id, profile: 'test' } }), /approval flag/);
    const result = await serverModule.executeAction({ type: 'run_project_command', requiresApproval: true, args: { projectId: registered.id, profile: 'test' } });
    assert.equal(result.profile, 'test');
    assert.equal(result.result.code, 0);
  } finally {
    serverModule.store.deleteProject(registered.id);
  }
});

test('serves the Bharath profile and greeting through HTTP', async () => {
  const serverModule = require('../server');
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    serverModule.server.once('error', onError);
    serverModule.server.listen(0, serverModule.HOST, () => {
      serverModule.server.off('error', onError);
      resolve();
    });
  });
  try {
    const address = serverModule.server.address();
    const base = `http://${serverModule.HOST}:${address.port}`;
    const bootstrapResponse = await fetch(`${base}/api/bootstrap`);
    const bootstrap = await bootstrapResponse.json();
    assert.equal(bootstrapResponse.status, 200);
    assert.deepEqual(bootstrap.user, { displayName: 'Bharath' });

    const greetingResponse = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Hey bro, I welcome it bro, hey bro' })
    });
    const greeting = await greetingResponse.json();
    assert.equal(greetingResponse.status, 200);
    assert.match(greeting.reply, /Bharath/);
    assert.deepEqual(greeting.actions, []);
  } finally {
    await new Promise((resolve) => serverModule.server.close(resolve));
  }
});
