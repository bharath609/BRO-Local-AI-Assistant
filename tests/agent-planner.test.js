const test = require('node:test');
const assert = require('node:assert/strict');

const { ToolRegistry } = require('../src/agent/registry');
const { TaskState } = require('../src/agent/task-state');
const { PlannerSession } = require('../src/agent/planner');
const { AgentManager, looksLikeAgentTask, confirmationPrompt } = require('../src/agent');

const SETTINGS = { baseUrl: 'http://127.0.0.1:11434/v1', model: 'test', protocol: 'chat' };

function tool(name, { risk = 'read', handler, parameters } = {}) {
  return {
    name,
    description: name,
    risk,
    parameters: parameters || { type: 'object', properties: {}, required: [] },
    handler: handler || (() => ({ done: true })),
  };
}

function call(id, name, args = {}) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

test('intent detection keeps simple commands fast and routes real workflows', () => {
  for (const simple of ['open notepad', 'open youtube', 'play lofi beats on youtube', 'scroll down', 'what is a file?', 'open gmail']) {
    assert.equal(looksLikeAgentTask(simple), false, simple);
  }
  for (const workflow of [
    'open chrome and then search for a laptop',
    'create a python file on my desktop called hello.py',
    'read my gmail inbox',
    'search linkedin for machine learning jobs',
    'write a script in vs code and run it',
    'agent: organize the files on my desktop',
  ]) {
    assert.equal(looksLikeAgentTask(workflow), true, workflow);
  }
});

test('planner executes multiple validated steps and returns the real outcome', async () => {
  const events = [];
  const registry = new ToolRegistry([
    tool('create_demo', { handler: (args) => { events.push(['create', args.name]); return { created: true, path: `C:\\demo\\${args.name}` }; } , parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } }),
    tool('verify_demo', { handler: () => { events.push(['verify']); return { verified: true }; } }),
  ]);
  const replies = [
    { ok: true, reply: '', toolCalls: [call('a', 'create_demo', { name: 'note.txt' })] },
    { ok: true, reply: '', toolCalls: [call('b', 'verify_demo')] },
    { ok: true, reply: 'I created note.txt and verified it.', toolCalls: [] },
  ];
  const task = new TaskState({ goal: 'make a note' });
  const session = new PlannerSession({
    goal: 'make a note',
    settings: SETTINGS,
    registry,
    task,
    complete: async () => replies.shift(),
  });
  const result = await session.run();
  assert.equal(result.status, 'completed');
  assert.match(result.reply, /created note\.txt/i);
  assert.deepEqual(events, [['create', 'note.txt'], ['verify']]);
  assert.equal(result.task.status, 'completed');
  assert.equal(result.task.steps.length, 2);
  assert.equal(result.task.steps[0].status, 'ok');
});

test('a risky step pauses for confirmation and only that exact call runs', async () => {
  let runs = 0;
  const registry = new ToolRegistry([
    tool('run_demo', {
      risk: 'execute',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      handler: (args) => { runs += 1; return { ran: true, path: args.path }; },
    }),
  ]);
  const replies = [
    { ok: true, reply: '', toolCalls: [call('a', 'run_demo', { path: 'C:\\demo\\main.py' })] },
    { ok: true, reply: 'Ran main.py successfully.', toolCalls: [] },
  ];
  const task = new TaskState({ goal: 'run main.py' });
  const session = new PlannerSession({
    goal: 'run main.py',
    settings: SETTINGS,
    registry,
    task,
    complete: async () => replies.shift(),
  });
  const paused = await session.run();
  assert.equal(paused.status, 'awaiting_confirmation');
  assert.equal(runs, 0);
  assert.equal(paused.pending.name, 'run_demo');
  assert.match(confirmationPrompt(paused.pending), /confirm|before i/i);
  assert.equal(task.status, 'running');

  const done = await session.resume({ approve: true });
  assert.equal(done.status, 'completed');
  assert.equal(runs, 1);
  assert.match(done.reply, /ran main\.py/i);
});

test('declining a confirmation cancels without running the tool', async () => {
  let runs = 0;
  const registry = new ToolRegistry([
    tool('delete_demo', { risk: 'destructive', handler: () => { runs += 1; return { deleted: true }; } }),
  ]);
  const replies = [{ ok: true, reply: '', toolCalls: [call('a', 'delete_demo')] }];
  const task = new TaskState({ goal: 'delete something' });
  const session = new PlannerSession({
    goal: 'delete something',
    settings: SETTINGS,
    registry,
    task,
    complete: async () => replies.shift(),
  });
  const paused = await session.run();
  assert.equal(paused.status, 'awaiting_confirmation');
  const denied = await session.resume({ approve: false });
  assert.equal(denied.status, 'cancelled');
  assert.equal(runs, 0);
  assert.equal(task.status, 'cancelled');
});

test('cancelling the task stops the planner between steps', async () => {
  const registry = new ToolRegistry([
    tool('cancel_me', {
      handler: (args, ctx) => { ctx.task.cancel('Stopped by the test.'); return { done: true }; },
    }),
    tool('never_runs'),
  ]);
  const replies = [
    { ok: true, reply: '', toolCalls: [call('a', 'cancel_me')] },
    { ok: true, reply: 'should not be used', toolCalls: [] },
  ];
  const task = new TaskState({ goal: 'cancel mid-task' });
  const session = new PlannerSession({
    goal: 'cancel mid-task',
    settings: SETTINGS,
    registry,
    task,
    complete: async () => replies.shift(),
  });
  const result = await session.run();
  assert.equal(result.status, 'cancelled');
  assert.match(result.reply, /stopped by the test/i);
  assert.equal(result.task.cancelled, true);
});

test('the JSON fallback accepts only registered tools', async () => {
  const seen = [];
  const registry = new ToolRegistry([
    tool('ping_demo', {
      handler: (args) => { seen.push(args); return { pong: true }; },
      parameters: { type: 'object', properties: { n: { type: 'integer' } }, required: [] },
    }),
  ]);
  const replies = [
    { ok: false, reason: 'provider rejected tool calling', toolsUnsupported: true },
    { ok: true, reply: '```json\n{"tool":"ping_demo","arguments":{"n":1}}\n```', toolCalls: [] },
    { ok: true, reply: 'Pinged once.', toolCalls: [] },
  ];
  const task = new TaskState({ goal: 'ping' });
  const session = new PlannerSession({
    goal: 'ping',
    settings: SETTINGS,
    registry,
    task,
    complete: async () => replies.shift(),
  });
  const result = await session.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.reply, 'Pinged once.');
  assert.deepEqual(seen, [{ n: 1 }]);
});

test('the master lock blocks agent steps that would change the PC', async () => {
  let runs = 0;
  const registry = new ToolRegistry([
    tool('launch_demo', { risk: 'launch', handler: () => { runs += 1; return { opened: true }; } }),
  ]);
  const blocked = await registry.execute('launch_demo', {}, { locked: true });
  assert.equal(blocked.status, 'blocked');
  assert.equal(runs, 0);
  const allowed = await registry.execute('launch_demo', {}, { locked: false });
  assert.equal(allowed.status, 'ok');
  assert.equal(runs, 1);
});

test('the manager exposes a pending confirmation and cancels cleanly', async () => {
  const registry = new ToolRegistry([
    tool('send_demo', { risk: 'send', handler: () => ({ sent: true }) }),
  ]);
  let calls = 0;
  const manager = new AgentManager({
    registry,
    complete: async () => {
      calls += 1;
      return calls === 1
        ? { ok: true, reply: '', toolCalls: [call('a', 'send_demo')] }
        : { ok: true, reply: 'I did not send anything.', toolCalls: [] };
    },
  });
  const paused = await manager.run({ goal: 'send it', settings: SETTINGS });
  assert.equal(paused.status, 'awaiting_confirmation');
  assert.equal(manager.status().awaitingConfirmation, true);
  assert.equal(manager.pending.name, 'send_demo');
  const denied = await manager.resume({ approve: false });
  assert.equal(denied.status, 'cancelled');
  assert.equal(manager.pending, null);
  assert.equal(manager.cancel().cancelled, false);
});
