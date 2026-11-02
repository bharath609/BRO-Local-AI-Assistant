const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { createStore, ValidationError } = require('./src/store');
const tools = require('./src/tools');
const { providerInfo } = require('./src/provider');
const { handleChat, DEFAULT_USER_NAME } = require('./src/assistant');
const voice = require('./src/voice');
const guardrails = require('./src/guardrails');

const DEFAULT_PORT = 4280;
const requestedPort = Number(process.env.BRO_PORT || DEFAULT_PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : DEFAULT_PORT;
const HOST = '127.0.0.1';
const store = createStore();
const approvals = guardrails.createApprovalStore();
const audit = guardrails.createAuditLog(path.join(store.dataDir, 'audit.log'));
const publicDir = path.join(__dirname, 'public');
const ADMIN_ACTIONS = new Set(['set_guardrails', 'lock_controls', 'unlock_controls']);
const capabilities = ['activate_bro', 'open_url', 'open_app', 'open_start_menu_app', 'open_user_file', 'close_app', 'close_start_menu_app', 'close_named_app', 'close_opened_apps', 'close_website', 'close_window', 'close_all_windows', 'focus_window', 'minimize_window', 'maximize_window', 'restore_window', 'open_desktop_target', 'open_terminal', 'list_projects', 'open_project', 'run_project_command', 'send_keys', 'type_text', 'media_key', 'windows_key', 'scroll', 'screenshot', 'show_desktop', 'refresh_desktop', 'click_element', 'click_first_result', 'sequence', 'open_settings', 'create_folder', 'rename_file', 'recycle_file', 'empty_recycle_bin', 'lock_pc', 'system_power', 'set_guardrails', 'lock_controls', 'unlock_controls'];
const IMMEDIATE_ACTIONS = new Set([...capabilities].filter((type) => !['list_projects', 'run_project_command'].includes(type)));
const userProfile = Object.freeze({ displayName: DEFAULT_USER_NAME });

function json(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

function readBody(request, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; if (Buffer.byteLength(body) > limit) { reject(new ValidationError('Request body is too large.')); request.destroy(); } });
    request.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch { reject(new ValidationError('Request body must be valid JSON.')); } });
    request.on('error', reject);
  });
}

function projectOrThrow(id) { return store.getProject(id); }

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(10_000, Number(ms) || 0))));
}

// Skill actions operate on the window BRO opened last. Bringing it to the
// front first keeps keystrokes and clicks away from the BRO popup.
function focusActionTarget(target) {
  if (!target) return null;
  return tools.controlWindow(target, 'focus');
}

async function executeSequence(args = {}) {
  const steps = Array.isArray(args.steps) ? args.steps : [];
  if (!steps.length) throw new ValidationError('The sequence has no steps.');
  if (args.target) await focusActionTarget(args.target);
  const results = [];
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    if (step.focus) {
      await focusActionTarget(step.focus);
      results.push({ focused: true });
      continue;
    }
    if (step.wait != null) {
      await delay(step.wait);
      results.push({ waited: step.wait });
      continue;
    }
    if (step.keys) {
      results.push({ keys: tools.sendKeys(step.keys).sent });
      continue;
    }
    if (step.type != null) {
      tools.typeText(step.type);
      results.push({ typed: String(step.type).length });
      continue;
    }
    if (step.first) {
      results.push(tools.clickFirstResult({ unread: Boolean(step.unread) }));
      continue;
    }
    if (step.click) {
      results.push(tools.clickElement(step.click, { button: step.button || 'left', double: Boolean(step.double) }));
      continue;
    }
  }
  return { steps: results.length, results };
}

// Closing is the one action whose outcome matters to the reply, so the sentence
// the user hears is built from what actually happened on the desktop.
function describeCloseOutcome(outcomes) {
  const parts = [];
  for (const outcome of outcomes) {
    const result = (outcome && outcome.result) || {};
    const label = result.label || 'the app';
    const kind = result.kind || 'app';
    if (kind === 'apps' && Array.isArray(result.tracked) && result.tracked.length === 0) {
      parts.push('I had not opened anything yet.');
      continue;
    }
    if (Array.isArray(result.protectedNames) && result.protectedNames.length) {
      parts.push(`${result.protectedNames.join(', ')} is part of Windows, so I left it alone.`);
    }
    if (result.closed) {
      if (kind === 'site') parts.push(`Closed the ${label} tab.`);
      else if (kind === 'window') parts.push(`Closed the window “${label}”.`);
      else if (kind === 'windows') parts.push(`Closed ${label}.`);
      else parts.push(`Closed ${label}.`);
      continue;
    }
    const stillOpen = [...(result.remainingWindows || []), ...(result.stillRunning || [])].filter(Boolean);
    if (stillOpen.length) parts.push(`${label} is still open — it may be waiting for you to save.`);
    else parts.push(`${label} was not open.`);
  }
  return parts.join(' ') || 'Nothing was open to close.';
}

// ---- Guardrails ------------------------------------------------------------
// Every action passes through this one checkpoint. New action types are
// unknown to the risk table, so they are treated as destructive and blocked
// until they are registered — safety is the default, not an opt-in.

function guardrailState() {
  return store.loadGuardrails();
}

function publicGuardrails() {
  const state = guardrailState();
  return { mode: state.mode, locked: state.locked, updatedAt: state.updatedAt, pending: approvals.size };
}

function auditDecision(action, risk, decision, source, extra = {}) {
  audit.append({
    type: action && action.type,
    label: guardrails.actionLabel(action),
    risk,
    decision,
    source,
    ...extra,
  });
}

// Returns one of: { executed, outcome }, { approval }, { blocked, message }.
async function runWithGuardrails(action, { source = 'chat', preapproved = false } = {}) {
  const state = guardrailState();
  const risk = guardrails.riskOf(action);
  if (risk === 'admin') {
    const outcome = await executeAction(action);
    auditDecision(action, risk, 'executed', source);
    return { executed: true, outcome, risk };
  }
  if (state.locked) {
    auditDecision(action, risk, 'blocked_locked', source);
    return {
      executed: false,
      blocked: true,
      message: 'Master lock is on, so I did not run that. Say “unlock controls” when you want me to take actions again.',
    };
  }
  const alreadyApproved = preapproved || action.confirmedByUser === true;
  if (!alreadyApproved && guardrails.approvalNeeded(state.mode, risk)) {
    const approval = approvals.request(action, risk);
    auditDecision(action, risk, 'approval_requested', source, { approvalId: approval.id });
    return { executed: false, approval };
  }
  try {
    const outcome = await executeAction(action);
    auditDecision(action, risk, alreadyApproved ? 'user_confirmed' : 'executed', source);
    return { executed: true, outcome, risk };
  } catch (error) {
    auditDecision(action, risk, 'failed', source, { error: String((error && error.message) || error) });
    throw error;
  }
}

async function executeAction(action) {
  if (!action || typeof action !== 'object' || typeof action.type !== 'string') throw new ValidationError('Action is required.');
  if (action.type === 'open_url') {
    const url = tools.validateHttpUrl(action.args && action.args.url);
    return { type: action.type, result: tools.openUrl(url) };
  }
  if (action.type === 'open_desktop_target') {
    const target = tools.resolveDesktopTarget(action.args && action.args.target);
    return { type: action.type, target: target.key, result: tools.openDesktopTarget(target.key) };
  }
  if (action.type === 'open_app') {
    return { type: action.type, result: tools.openCatalogApp(action.args && action.args.id) };
  }
  if (action.type === 'open_start_menu_app') {
    return { type: action.type, result: tools.openStartMenuApp(action.args && action.args.name) };
  }
  if (action.type === 'open_user_file') {
    const filePath = action.args && action.args.path;
    return { type: action.type, result: tools.openUserFile(filePath) };
  }
  if (action.type === 'close_app') {
    return { type: action.type, result: await tools.closeCatalogApp(action.args && action.args.id) };
  }
  if (action.type === 'close_start_menu_app') {
    return { type: action.type, result: await tools.closeStartMenuApp(action.args && action.args.name) };
  }
  if (action.type === 'close_named_app') {
    return { type: action.type, result: await tools.closeNamedApp(action.args && action.args.name) };
  }
  if (action.type === 'close_opened_apps') {
    return { type: action.type, result: await tools.closeOpenedApps() };
  }
  if (action.type === 'close_website') {
    const args = action.args || {};
    return { type: action.type, result: await tools.closeWebsite(args.name || args.label || '', { label: args.label, url: args.url }) };
  }
  if (action.type === 'close_window') {
    return { type: action.type, result: await tools.closeForegroundWindow({ tab: Boolean(action.args && action.args.tab) }) };
  }
  if (action.type === 'close_all_windows') {
    return { type: action.type, result: await tools.closeAllWindows() };
  }
  if (action.type === 'focus_window' || action.type === 'minimize_window' || action.type === 'maximize_window' || action.type === 'restore_window') {
    const mode = action.type.slice(0, action.type.indexOf('_window'));
    return { type: action.type, result: tools.controlWindow(action.args && action.args.target, mode) };
  }
  if (action.type === 'open_terminal') {
    return { type: action.type, result: tools.openTerminal() };
  }
  if (action.type === 'send_keys') {
    const args = action.args || {};
    if (args.target) await focusActionTarget(args.target);
    if (args.delayMs) await delay(args.delayMs);
    return { type: action.type, result: tools.sendKeys(args.keys) };
  }
  if (action.type === 'type_text') {
    const args = action.args || {};
    if (args.target) await focusActionTarget(args.target);
    return { type: action.type, result: tools.typeText(args.text) };
  }
  if (action.type === 'media_key') {
    return { type: action.type, result: tools.mediaKey(action.args && action.args.key) };
  }
  if (action.type === 'windows_key') {
    return { type: action.type, result: tools.pressWindowsKey(action.args && action.args.keys) };
  }
  if (action.type === 'refresh_desktop') {
    // Show the desktop, then press F5 on it, so the desktop icons and widgets
    // re-read the filesystem just like a manual refresh.
    tools.showDesktop();
    await delay(350);
    return { type: action.type, result: tools.sendKeys('{F5}') };
  }
  if (action.type === 'scroll') {
    const args = action.args || {};
    if (args.target) await focusActionTarget(args.target);
    return { type: action.type, result: tools.scrollActiveWindow(args.direction, args.amount) };
  }
  if (action.type === 'screenshot') {
    return { type: action.type, result: tools.takeScreenshot() };
  }
  if (action.type === 'show_desktop') {
    return { type: action.type, result: tools.showDesktop() };
  }
  if (action.type === 'click_element') {
    const args = action.args || {};
    if (args.target) await focusActionTarget(args.target);
    return { type: action.type, result: tools.clickElement(args.name, { button: args.button, double: Boolean(args.double) }) };
  }
  if (action.type === 'click_first_result') {
    const args = action.args || {};
    if (args.target) await focusActionTarget(args.target);
    return { type: action.type, result: tools.clickFirstResult({ unread: Boolean(args.unread) }) };
  }
  if (action.type === 'sequence') {
    return { type: action.type, result: await executeSequence(action.args) };
  }
  if (action.type === 'open_settings') {
    return { type: action.type, result: tools.openSettings(action.args && action.args.uri) };
  }
  if (action.type === 'create_folder') {
    const args = action.args || {};
    return { type: action.type, result: tools.createUserFolder(args.name, args.folder) };
  }
  if (action.type === 'rename_file') {
    const args = action.args || {};
    return { type: action.type, result: tools.renameUserFile(args.path, args.name) };
  }
  if (action.type === 'recycle_file') {
    return { type: action.type, result: tools.recycleFile(action.args && action.args.path) };
  }
  if (action.type === 'empty_recycle_bin') {
    return { type: action.type, result: tools.emptyRecycleBin() };
  }
  if (action.type === 'lock_pc') {
    return { type: action.type, result: tools.lockWorkstation() };
  }
  if (action.type === 'system_power') {
    return { type: action.type, result: tools.systemPower(action.args && action.args.mode) };
  }
  if (action.type === 'activate_bro') {
    return { type: action.type, result: tools.activateBro() };
  }
  if (action.type === 'set_guardrails') {
    const mode = guardrails.normalizeMode(action.args && action.args.mode);
    if (!mode) throw new ValidationError('Guardrail mode must be strict, guarded, or trusted.');
    return { type: action.type, result: store.updateGuardrails({ mode }) };
  }
  if (action.type === 'lock_controls') {
    return { type: action.type, result: store.updateGuardrails({ locked: true }) };
  }
  if (action.type === 'unlock_controls') {
    return { type: action.type, result: store.updateGuardrails({ locked: false }) };
  }
  if (action.type === 'list_projects') return { type: action.type, projects: store.listProjects() };
  if (action.type === 'open_project') {
    const project = projectOrThrow(action.args && action.args.projectId);
    return { type: action.type, project: store.publicProject(project), result: tools.openPath(project.root) };
  }
  if (action.type === 'run_project_command') {
    if (action.requiresApproval !== true) throw new ValidationError('Running a project profile requires an explicit approval flag.');
    const project = projectOrThrow(action.args && action.args.projectId);
    const profile = action.args && action.args.profile;
    if (typeof profile !== 'string' || !Object.prototype.hasOwnProperty.call(project.commands, profile)) throw new ValidationError('That project profile is not configured.');
    const result = await tools.runStoredCommand(project.commands[profile], project.root);
    return { type: action.type, project: store.publicProject(project), profile, result };
  }
  throw new ValidationError('Unsupported action type.');
}

const OPENING_ACTIONS = new Set(['open_url', 'open_app', 'open_start_menu_app', 'open_desktop_target', 'open_terminal', 'open_project', 'open_user_file', 'open_settings']);

// After a successful launch, wait for the window to appear and bring it to the
// front. Then re-assert the BRO overlay as topmost without moving keyboard
// focus away from the app the user just opened.
async function bringOpenedThingForward(action, outcome) {
  if (!OPENING_ACTIONS.has(action.type)) return;
  const args = action.args || {};
  const result = (outcome && outcome.result) || {};
  try {
    if (action.type === 'open_url') {
      // Give the browser a moment to raise the new tab, then make that window
      // fill the screen. A restored browser window otherwise opens small.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          const focused = tools.controlWindow({ kind: 'site', label: '', url: args.url }, 'focus');
          if (focused && focused.hwnd) {
            tools.maximizeWindowByHwnd(focused.hwnd, { threshold: 1 });
            break;
          }
        } catch { /* the browser may need another moment */ }
        if (attempt < 7) await delay(400);
      }
    } else {
      const labels = [];
      if (result.label) labels.push(result.label);
      if (action.type === 'open_settings') labels.push('Settings', 'Windows Settings');
      if (action.type === 'open_desktop_target') {
        if (outcome.target === 'settings') labels.push('Settings');
        if (outcome.target === 'file_explorer') labels.push('File Explorer');
        if (outcome.target === 'task_manager') labels.push('Task Manager');
      }
      if (action.type === 'open_terminal') labels.push('Windows Terminal', 'Command Prompt', 'Terminal');
      if (action.type === 'open_project' && outcome.project && outcome.project.name) labels.push(outcome.project.name);
      if (action.type === 'open_user_file' && args.path) labels.push(path.basename(args.path).replace(/\.[^.]+$/, ''));
      await tools.focusOpenedWindow(labels);
    }
  } finally {
    try { tools.raiseBroOverlay(); } catch { /* best effort */ }
  }
}

async function route(request, response) {
  const parsed = new URL(request.url, `http://${HOST}`);
  const pathname = parsed.pathname;
  if (request.method === 'GET' && pathname === '/api/bootstrap') {
    const settings = store.loadSettings();
    return json(response, 200, { appName: 'BRO Local AI Assistant', user: userProfile, provider: providerInfo(settings), projects: store.listProjects(), capabilities, voice: voice.status(), guardrails: publicGuardrails(), approvals: approvals.list() });
  }
  if (request.method === 'GET' && pathname === '/api/guardrails') {
    return json(response, 200, { guardrails: publicGuardrails(), approvals: approvals.list() });
  }
  if (request.method === 'POST' && pathname === '/api/guardrails') {
    const body = await readBody(request);
    const updated = store.updateGuardrails({ mode: body.mode, locked: body.locked });
    audit.append({ type: 'set_guardrails', label: `Guardrails ${updated.mode}${updated.locked ? ', locked' : ''}`, risk: 'admin', decision: 'executed', source: 'app' });
    return json(response, 200, { guardrails: publicGuardrails() });
  }
  if (request.method === 'GET' && pathname === '/api/approvals') {
    return json(response, 200, { approvals: approvals.list() });
  }
  const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)$/);
  if (request.method === 'POST' && approvalMatch) {
    const body = await readBody(request);
    const id = decodeURIComponent(approvalMatch[1]);
    if (body.approve === false || body.approve === 'false') {
      const entry = approvals.deny(id);
      if (!entry) throw new ValidationError('That approval is no longer valid.');
      auditDecision(entry.action, entry.risk, 'denied', 'approval_endpoint');
      return json(response, 200, { approved: false, executed: false, reply: 'Cancelled. Nothing was run.', guardrails: publicGuardrails() });
    }
    if (store.loadGuardrails().locked) {
      const held = approvals.list().find((item) => item.id === id);
      if (held) auditDecision(held.action, held.risk, 'blocked_locked', 'approval_endpoint');
      return json(response, 200, { approved: false, executed: false, reply: 'Master lock is on, so I kept that approval waiting. Say “unlock controls” first, then approve it.', guardrails: publicGuardrails() });
    }
    const entry = approvals.take(id);
    if (!entry) throw new ValidationError('That approval has expired. Please ask again.');
    const gate = await runWithGuardrails(entry.action, { source: 'approval_endpoint', preapproved: true });
    if (!gate.executed) {
      return json(response, 200, { approved: true, executed: false, reply: gate.message || 'Master lock is on, so nothing was run.', guardrails: publicGuardrails() });
    }
    bringOpenedThingForward(entry.action, gate.outcome).catch(() => {});
    return json(response, 200, { approved: true, executed: true, outcome: gate.outcome, reply: `Approved and run: ${entry.label}.`, guardrails: publicGuardrails() });
  }
  if (request.method === 'GET' && pathname === '/api/audit') {
    const limit = Number(parsed.searchParams.get('limit') || 50);
    return json(response, 200, { entries: audit.read(limit) });
  }
  if (request.method === 'GET' && pathname === '/api/voice/status') {
    return json(response, 200, voice.status());
  }
  if (request.method === 'POST' && pathname === '/api/voice/wake') {
    const body = await readBody(request, 8_000_000);
    const encoded = typeof body.audio === 'string' ? body.audio : '';
    if (!encoded) throw new ValidationError('The recording is missing.');
    const audio = Buffer.from(encoded, 'base64');
    if (audio.length < 44) throw new ValidationError('The recording was empty.');
    if (process.env.BRO_VOICE_SAVE_CLIPS === '1') {
      try {
        const dir = path.join(__dirname, 'data', 'voice-clips');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, `wake-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`), audio);
      } catch (_) { /* diagnostics are best effort */ }
    }
    const result = await voice.detectWake(audio);
    if (result.wake || result.sleep) console.log(`BRO wake: ${result.audioDurationMs}ms audio -> wake=${Boolean(result.wake)} sleep=${Boolean(result.sleep)} in ${result.ms}ms`);
    return json(response, 200, result);
  }
  if (request.method === 'POST' && pathname === '/api/voice/transcribe') {
    const body = await readBody(request, 24_000_000);
    const encoded = typeof body.audio === 'string' ? body.audio : '';
    if (!encoded) throw new ValidationError('The recording is missing.');
    const audio = Buffer.from(encoded, 'base64');
    if (audio.length < 44) throw new ValidationError('The recording was empty.');
    const result = await voice.transcribe(audio);
    console.log(`BRO voice: ${result.audioDurationMs}ms audio -> ${result.text.length} chars in ${result.ms}ms (${result.engine})`);
    return json(response, 200, result);
  }
  if (request.method === 'POST' && pathname === '/api/chat') {
    const body = await readBody(request);
    const message = String(body.message || '');
    const incomingContext = body.context || body.requestContext || {};
    const state = store.loadGuardrails();

    // In normal mode, execute actions directly without requiring yes/no approval.
    // The model suggests, the server checks guardrails, and the action runs.
    const result = await handleChat({
      message,
      history: Array.isArray(body.history) ? body.history : [],
      projects: store.listProjects(),
      settings: store.loadSettings(),
      user: userProfile,
      context: incomingContext,
      lastTarget: body.lastTarget,
      guardrails: state,
      audit: audit.read(6),
      pendingApprovals: 0,
    });
    const safeActions = [];
    const outcomes = [];
    for (const action of result.actions) {
      if (!IMMEDIATE_ACTIONS.has(action.type)) { safeActions.push(action); continue; }
      const gate = await runWithGuardrails(action, { source: 'chat' });
      if (gate.executed) {
        outcomes.push(gate.outcome);
        bringOpenedThingForward(action, gate.outcome).catch(() => {});
      }
      // In normal mode we don't queue approvals - actions just run or are blocked.
    }
    result.actions = safeActions;
    // No approvals queue in normal mode.
    result.guardrails = publicGuardrails();
    return json(response, 200, result);
  }
  if (request.method === 'POST' && pathname === '/api/action') {
    const body = await readBody(request);
    let action = body.action;
    if (!action || typeof action !== 'object') throw new ValidationError('Action is required.');
    // Execute directly - no approval needed in normal mode.
    const gate = await runWithGuardrails(action, { source: 'app', preapproved: true });
    if (gate.executed) {
      bringOpenedThingForward(action, gate.outcome).catch(() => {});
    }
    return json(response, 200, { ...gate.outcome, executed: true, guardrails: publicGuardrails() });
  }
  if (request.method === 'POST' && pathname === '/api/projects/register') {
    const body = await readBody(request);
    return json(response, 201, { project: store.registerProject(body) });
  }
  if (request.method === 'DELETE' && /^\/api\/projects\/[^/]+$/.test(pathname)) {
    return json(response, 200, { project: store.deleteProject(decodeURIComponent(pathname.split('/').pop())) });
  }
  if (request.method === 'POST' && pathname === '/api/settings') {
    const body = await readBody(request);
    return json(response, 200, { provider: store.updateSettings(body) });
  }
  const openMatch = pathname.match(/^\/api\/projects\/([^/]+)\/open$/);
  if (request.method === 'POST' && openMatch) {
    const project = projectOrThrow(decodeURIComponent(openMatch[1]));
    return json(response, 200, { project: store.publicProject(project), result: tools.openPath(project.root) });
  }
  const runMatch = pathname.match(/^\/api\/projects\/([^/]+)\/run$/);
  if (request.method === 'POST' && runMatch) {
    const body = await readBody(request);
    if (body.approved !== true) throw new ValidationError('Running a project profile requires an explicit approval flag.');
    const project = projectOrThrow(decodeURIComponent(runMatch[1]));
    if (typeof body.profile !== 'string' || !Object.prototype.hasOwnProperty.call(project.commands, body.profile)) throw new ValidationError('That project profile is not configured.');
    return json(response, 200, { project: store.publicProject(project), profile: body.profile, result: await tools.runStoredCommand(project.commands[body.profile], project.root) });
  }
  return serveStatic(pathname, response);
}

function serveStatic(pathname, response) {
  const requested = pathname === '/' ? '/index.html' : pathname;
  let decoded;
  try { decoded = decodeURIComponent(requested); } catch { return json(response, 400, { error: 'Invalid path.' }); }
  const file = path.resolve(publicDir, `.${decoded}`);
  if (file !== publicDir && !file.startsWith(`${publicDir}${path.sep}`)) return json(response, 404, { error: 'Not found.' });
  let stat;
  try { stat = fs.statSync(file); } catch { return json(response, 404, { error: 'Not found.' }); }
  if (!stat.isFile()) return json(response, 404, { error: 'Not found.' });
  const contentTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };
  response.writeHead(200, { 'content-type': contentTypes[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
}

const server = http.createServer((request, response) => {
  route(request, response).catch((error) => {
    const status = error.statusCode || 500;
    json(response, status, { error: status >= 500 ? 'Internal server error.' : error.message });
  });
});

server.on('close', () => voice.shutdown());
process.on('exit', () => voice.shutdown());
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { voice.shutdown(); process.exit(0); });
}

if (require.main === module) server.listen(PORT, HOST, () => console.log(`BRO Local AI Assistant listening at http://${HOST}:${PORT}`));
module.exports = { server, executeAction, store, HOST, PORT };
