const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { createStore, ValidationError } = require('./src/store');
const tools = require('./src/tools');
const { providerInfo } = require('./src/provider');
const { handleChat, DEFAULT_USER_NAME } = require('./src/assistant');
const voice = require('./src/voice');

const DEFAULT_PORT = 4280;
const requestedPort = Number(process.env.BRO_PORT || DEFAULT_PORT);
const PORT = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : DEFAULT_PORT;
const HOST = '127.0.0.1';
const store = createStore();
const publicDir = path.join(__dirname, 'public');
const capabilities = ['activate_bro', 'open_url', 'open_app', 'open_start_menu_app', 'close_app', 'close_start_menu_app', 'close_named_app', 'close_opened_apps', 'close_website', 'close_window', 'close_all_windows', 'open_desktop_target', 'open_terminal', 'list_projects', 'open_project', 'run_project_command'];
const IMMEDIATE_ACTIONS = new Set(['activate_bro', 'open_url', 'open_app', 'open_start_menu_app', 'close_app', 'close_start_menu_app', 'close_named_app', 'close_opened_apps', 'close_website', 'close_window', 'close_all_windows', 'open_desktop_target', 'open_project', 'open_terminal']);
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
  if (action.type === 'open_terminal') {
    return { type: action.type, result: tools.openTerminal() };
  }
  if (action.type === 'activate_bro') {
    return { type: action.type, result: tools.activateBro() };
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

async function route(request, response) {
  const parsed = new URL(request.url, `http://${HOST}`);
  const pathname = parsed.pathname;
  if (request.method === 'GET' && pathname === '/api/bootstrap') {
    const settings = store.loadSettings();
    return json(response, 200, { appName: 'BRO Local AI Assistant', user: userProfile, provider: providerInfo(settings), projects: store.listProjects(), capabilities, voice: voice.status() });
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
    const settings = store.loadSettings();
    const result = await handleChat({ message: body.message, history: Array.isArray(body.history) ? body.history : [], projects: store.listProjects(), settings, user: userProfile, context: body.context || body.requestContext, lastTarget: body.lastTarget });
    const safeActions = [];
    const outcomes = [];
    for (const action of result.actions) {
      if (IMMEDIATE_ACTIONS.has(action.type)) outcomes.push(await executeAction(action));
      else safeActions.push(action);
    }
    result.actions = safeActions;
    if (Array.isArray(result.closeTargets)) {
      result.reply = describeCloseOutcome(outcomes);
      delete result.closeTargets;
    }
    return json(response, 200, result);
  }
  if (request.method === 'POST' && pathname === '/api/action') {
    const body = await readBody(request);
    return json(response, 200, await executeAction(body.action));
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
