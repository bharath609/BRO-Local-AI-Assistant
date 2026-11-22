const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ToolRegistry, ToolValidationError } = require('../src/agent/registry');
const { TaskState, TaskManager, TaskCancelledError } = require('../src/agent/task-state');
const { confirmationReason, confirmationKey } = require('../src/agent/policy');
const files = require('../src/agent/adapters/files');

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bro-agent-'));
}

function registryWith(...tools) {
  return new ToolRegistry(tools);
}

test('policy asks for confirmation on risky work only', () => {
  const read = { name: 'read_file', risk: 'read' };
  const execute = { name: 'run_file', risk: 'execute' };
  const send = { name: 'send_email', risk: 'send' };
  const overwrite = { name: 'write_file', risk: 'file' };
  assert.equal(confirmationReason(read, {}), '');
  assert.match(confirmationReason(execute, {}), /confirmation/i);
  assert.match(confirmationReason(send, {}), /confirmation/i);
  assert.equal(confirmationReason(overwrite, {}), '');
  assert.match(confirmationReason(overwrite, { overwrite: true }), /overwrite/i);
});

test('a confirmation only applies to the exact tool call', () => {
  const tool = { name: 'run_file', risk: 'execute' };
  const args = { path: 'C:\\demo\\main.py' };
  const key = confirmationKey('run_file', args);
  assert.equal(confirmationReason(tool, args, { confirmed: { name: 'run_file', key } }), '');
  assert.match(confirmationReason(tool, { path: 'C:\\other.py' }, { confirmed: { name: 'run_file', key } }), /confirmation/i);
});

test('task state records steps and cancels cleanly', () => {
  const manager = new TaskManager();
  const task = manager.start({ goal: 'create a file' });
  const step = task.addStep({ tool: 'create_file', summary: 'creating' });
  task.updateStep(step.id, { status: 'ok' });
  assert.equal(manager.active(), true);
  assert.equal(manager.cancel(), true);
  assert.equal(task.status, 'cancelled');
  assert.equal(manager.active(), false);
  assert.throws(() => task.assertActive(), TaskCancelledError);
  assert.equal(manager.snapshot().steps[0].status, 'ok');
});

test('a new task supersedes a running one', () => {
  const manager = new TaskManager();
  const first = manager.start({ goal: 'one' });
  const second = manager.start({ goal: 'two' });
  assert.equal(first.status, 'cancelled');
  assert.equal(second.status, 'running');
});

test('registry validates arguments and rejects unknown tools', async () => {
  const registry = registryWith({
    name: 'demo',
    description: 'demo',
    risk: 'read',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['a', 'b'] }, count: { type: 'integer', minimum: 1, maximum: 5 } },
      required: ['mode'],
    },
    handler: (args) => ({ echo: args }),
  });
  await assert.rejects(() => registry.execute('missing', {}), ToolValidationError);
  await assert.rejects(() => registry.execute('demo', { mode: 'c' }), /must be one of/);
  await assert.rejects(() => registry.execute('demo', { mode: 'a', extra: 1 }), /unexpected argument/);
  await assert.rejects(() => registry.execute('demo', { mode: 'a', count: 99 }), /too large/);
  const result = await registry.execute('demo', '{"mode":"a","count":2}');
  assert.deepEqual(result.result, { echo: { mode: 'a', count: 2 } });
});

test('registry returns a confirmation request instead of running risky tools', async () => {
  let ran = false;
  const registry = registryWith({
    name: 'run_demo',
    description: 'demo',
    risk: 'execute',
    parameters: { type: 'object', properties: {}, required: [] },
    handler: () => { ran = true; return { ok: true }; },
  });
  const pending = await registry.execute('run_demo', {});
  assert.equal(pending.status, 'needs_confirmation');
  assert.equal(ran, false);
  const confirmed = await registry.execute('run_demo', {}, { confirmed: pending.pending });
  assert.equal(confirmed.status, 'ok');
  assert.equal(ran, true);
});

test('registry enforces a timeout and reports failures', async () => {
  const registry = registryWith(
    {
      name: 'slow',
      description: 'slow',
      risk: 'read',
      timeoutMs: 20,
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => new Promise(() => {}),
    },
    {
      name: 'bad',
      description: 'bad',
      risk: 'read',
      parameters: { type: 'object', properties: {}, required: [] },
      handler: () => ({ ok: false, message: 'nope' }),
    }
  );
  await assert.rejects(() => registry.execute('slow', {}), /timed out/);
  const failed = await registry.execute('bad', {});
  assert.equal(failed.status, 'failed');
  assert.equal(failed.message, 'nope');
});

test('file tools stay inside the allowed root', () => {
  const root = tempRoot();
  const outside = tempRoot();
  const ctx = { extraRoots: [root] };

  const folder = files.createFolder({ name: 'demo', parent: root }, ctx);
  assert.equal(fs.existsSync(folder.path), true);

  const created = files.createFile({ path: folder.path, name: 'main.py', content: 'print("hi")\n' }, ctx);
  assert.equal(created.created, true);

  const read = files.readFile({ path: created.path }, ctx);
  assert.match(read.content, /print/);

  const listed = files.listDirectory({ path: folder.path }, ctx);
  assert.ok(listed.entries.some((entry) => entry.name === 'main.py'));

  const found = files.searchFiles({ query: 'main', folder: root }, ctx);
  assert.equal(found.matches[0].name, 'main.py');

  const outsideFile = path.join(outside, 'secret.txt');
  fs.writeFileSync(outsideFile, 'secret');
  assert.throws(() => files.readFile({ path: outsideFile }, ctx), /outside/);
  assert.throws(() => files.createFile({ path: path.join(outside, 'x.txt'), content: 'x' }, ctx), /outside/);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('file tools refuse silent overwrites and renames', () => {
  const root = tempRoot();
  const ctx = { extraRoots: [root] };
  const first = files.createFile({ path: path.join(root, 'note.txt'), content: 'one' }, ctx);
  assert.equal(first.created, true);
  const duplicate = files.createFile({ path: path.join(root, 'note.txt'), content: 'two' }, ctx);
  assert.equal(duplicate.ok, false);
  const written = files.writeFile({ path: first.path, content: 'two', overwrite: true }, ctx);
  assert.equal(written.overwritten, true);
  const renamed = files.renameFile({ path: first.path, newName: 'renamed.txt' }, ctx);
  assert.equal(renamed.renamed, true);
  assert.equal(fs.existsSync(renamed.path), true);
});
