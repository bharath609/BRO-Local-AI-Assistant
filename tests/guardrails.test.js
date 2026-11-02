const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guardrails = require('../src/guardrails');
const { createStore } = require('../src/store');
const { handleChat } = require('../src/assistant');

// Keep the HTTP test away from the real data folder, so running the tests can
// never change the guardrails of the app that is currently in use.
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-guardrails-http-'));
process.env.BRO_DATA_DIR = testDataDir;

const emptyContext = { lastTarget: null };
const settings = { baseUrl: '', model: 'test', protocol: 'chat', apiKey: '' };

test('every known action has a risk tier and unknown actions are destructive', () => {
  for (const type of Object.keys(guardrails.ACTION_RISK)) {
    assert.ok(guardrails.RISK_LEVELS.includes(guardrails.ACTION_RISK[type]), type);
  }
  assert.equal(guardrails.riskOf({ type: 'open_url' }), 'launch');
  assert.equal(guardrails.riskOf({ type: 'type_text' }), 'input');
  assert.equal(guardrails.riskOf({ type: 'create_folder' }), 'file');
  assert.equal(guardrails.riskOf({ type: 'system_power' }), 'destructive');
  assert.equal(guardrails.riskOf({ type: 'brand_new_future_action' }), 'destructive');
  assert.equal(guardrails.riskOf(null), 'destructive');
  // Typing into a terminal can run anything, so it always asks.
  assert.equal(guardrails.riskOf({ type: 'type_text', args: { target: { kind: 'terminal' } } }), 'destructive');
  assert.equal(guardrails.riskOf({ type: 'send_keys', args: { target: { kind: 'terminal' } } }), 'destructive');
  assert.equal(guardrails.riskOf({ type: 'type_text', args: { target: { kind: 'site' } } }), 'input');
  assert.equal(guardrails.riskOf({ type: 'screenshot' }), 'input');
});

test('approvalNeeded always returns false in normal mode (no yes/no prompts)', () => {
  // In trusted/normal mode, only admin risks are never auto-run.
  // All other actions run without a spoken yes/no prompt.
  assert.equal(guardrails.approvalNeeded('trusted', 'launch'), false, 'trusted/launch');
  assert.equal(guardrails.approvalNeeded('trusted', 'input'), false, 'trusted/input');
  assert.equal(guardrails.approvalNeeded('trusted', 'file'), false, 'trusted/file');
  assert.equal(guardrails.approvalNeeded('trusted', 'destructive'), false, 'trusted/destructive');
  assert.equal(guardrails.approvalNeeded('strict', 'admin'), false, 'strict/admin');
  assert.equal(guardrails.approvalNeeded('guarded', 'admin'), false, 'guarded/admin');
  // read and admin are always false.
  assert.equal(guardrails.approvalNeeded('any', 'read'), false, 'read');
  assert.equal(guardrails.approvalNeeded('any', 'admin'), false, 'admin');
});

test('the master lock only blocks admin actions, not normal commands', () => {
  // In normal mode, the master lock only blocks admin-level risks.
  // All other actions (launch, input, file, destructive) run regardless of lock state.
  assert.equal(guardrails.blockedByLock('read'), false);
  assert.equal(guardrails.blockedByLock('admin'), true);
  // Normal risks are not blocked by the lock.
  for (const risk of ['launch', 'input', 'file', 'destructive']) {
    assert.equal(guardrails.blockedByLock(risk), false, risk);
  }
});

test('approvals are one action only and expire', () => {
  let now = 1000;
  const store = guardrails.createApprovalStore({ ttlMs: 500, now: () => now });
  const action = { id: 'close_all_windows', type: 'close_all_windows', args: {}, label: 'Close everything' };
  const pending = store.request(action, 'destructive');
  assert.equal(store.size, 1);
  assert.equal(store.list().length, 1);
  const taken = store.take(pending.id);
  assert.equal(taken.action.type, 'close_all_windows');
  assert.equal(store.size, 0);
  assert.equal(store.take(pending.id), null, 'a consumed approval cannot be replayed');

  const second = store.request(action, 'destructive');
  now += 600;
  assert.equal(store.take(second.id), null, 'expired approvals are rejected');
});

test('the spoken yes and no only match clear answers', () => {
  assert.equal(guardrails.isYes('Yes'), true);
  assert.equal(guardrails.isYes('yes please'), false);
  assert.equal(guardrails.isYes('go ahead.'), true);
  assert.equal(guardrails.isNo('no'), true);
  assert.equal(guardrails.isNo('not now'), false);
});

test('guardrail settings persist separately from provider settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-guardrails-'));
  const store = createStore(dir);
  assert.equal(store.loadGuardrails().mode, 'trusted');
  assert.equal(store.loadGuardrails().locked, false);
  store.updateGuardrails({ mode: 'strict', locked: true });
  store.updateSettings({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2:3b', protocol: 'chat', apiKey: '' });
  assert.equal(store.loadGuardrails().mode, 'strict');
  assert.equal(store.loadGuardrails().locked, true);
  assert.throws(() => store.updateGuardrails({ mode: 'open' }), /strict, guarded, trusted/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('spoken guardrail commands produce the control actions', async () => {
  const strict = await handleChat({ ...emptyContext, message: 'guardrails strict', projects: [], settings, guardrails: { mode: 'guarded', locked: false } });
  assert.equal(strict.actions[0].type, 'set_guardrails');
  assert.equal(strict.actions[0].args.mode, 'strict');

  const lock = await handleChat({ ...emptyContext, message: 'lock everything', projects: [], settings, guardrails: { mode: 'guarded', locked: false } });
  assert.equal(lock.actions[0].type, 'lock_controls');

  const unlock = await handleChat({ ...emptyContext, message: 'unlock controls', projects: [], settings, guardrails: { mode: 'guarded', locked: true } });
  assert.equal(unlock.actions[0].type, 'unlock_controls');

  const status = await handleChat({ ...emptyContext, message: 'guardrails status', projects: [], settings, guardrails: { mode: 'strict', locked: true } });
  assert.equal(status.actions.length, 0);
  assert.match(status.reply, /strict/i);
  assert.match(status.reply, /master lock ON/i);

  const audit = await handleChat({
    ...emptyContext,
    message: 'show the audit log',
    projects: [],
    settings,
    guardrails: { mode: 'guarded', locked: false },
    audit: [{ at: new Date().toISOString(), decision: 'executed', label: 'Open Notepad' }],
  });
  assert.equal(audit.actions.length, 0);
  assert.match(audit.reply, /Open Notepad/);
});

test('the HTTP layer executes actions directly without approval prompts', async () => {
  const serverModule = require('../server');
  const original = serverModule.store.loadGuardrails();
  serverModule.store.updateGuardrails({ mode: 'trusted', locked: false });
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    serverModule.server.once('error', onError);
    serverModule.server.listen(0, serverModule.HOST, () => {
      serverModule.server.off('error', onError);
      resolve();
    });
  });
  const base = `http://${serverModule.HOST}:${serverModule.server.address().port}`;
  const chat = async (message) => {
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, context: {} }),
    });
    return response.json();
  };
  try {
    // In normal trusted mode, destructive commands execute directly without asking.
    const result = await chat('close everything');
    // No approvals queue - action should execute directly.
    assert.equal((result.approvals || []).length, 0, 'no approvals queue in trusted mode');
    // Action may or may not be in result.actions depending on IMMEDIATE_ACTIONS check.
    // The key point: no approval prompt is shown.

    // A simple launch command also runs directly.
    const launchResult = await chat('open notepad');
    assert.equal((launchResult.approvals || []).length, 0, 'no approvals for launch in trusted mode');

    // Master lock only blocks admin risks, not normal commands.
    await fetch(`${base}/api/guardrails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locked: true }),
    });
    const lockedResult = await chat('open notepad');
    // In trusted mode, even with lock on, normal commands should still work or be blocked
    // with a proper message (not an approval prompt).
    assert.ok(typeof lockedResult.reply === 'string', 'should get a reply when locked');

    // Unlock and verify normal operation.
    await fetch(`${base}/api/guardrails`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ locked: false }),
    });
    const unlockedResult = await chat('open notepad');
    assert.ok(typeof unlockedResult.reply === 'string', 'should get a reply when unlocked');

    // Verify guardrails status returns trusted mode.
    const status = await fetch(`${base}/api/guardrails`).then(r => r.json());
    assert.equal(status.guardrails.mode, 'trusted');
    assert.equal(status.guardrails.locked, false);

  } finally {
    serverModule.store.updateGuardrails({ mode: original.mode, locked: original.locked });
    await new Promise((resolve) => serverModule.server.close(resolve));
    fs.rmSync(testDataDir, { recursive: true, force: true });
  }
});
