(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const CHAT_STORAGE_KEY = 'bro-chat-history-v1';
  const CONTEXT_STORAGE_KEY = 'bro-last-target-v1';
  const state = { view: 'chat', messages: [], projects: [], settings: {}, user: { displayName: 'Bharath' }, context: {}, online: false, readAloud: false, busy: false, recognition: null, voice: null };

  const els = {
    views: $$('.view'), nav: $$('.nav-item'), title: $('#view-title'), eyebrow: $('#view-eyebrow'), welcome: $('#welcome-state'), welcomeHeading: $('#welcome-heading'), messages: $('#messages'), actionFeed: $('#action-feed'), typing: $('#typing-indicator'), input: $('#message-input'), chatForm: $('#chat-form'), send: $('#send-button'), mic: $('#mic-button'), speaker: $('#speaker-toggle'), connectionDot: $('#connection-dot'), connectionLabel: $('#connection-label'), connectionDetail: $('#connection-detail'), serverAlert: $('#server-alert'), serverAlertText: $('#server-alert-text'), toast: $('#toast'), projects: $('#project-list'), projectCount: $('#project-count'), projectForm: $('#project-form'), projectFormPanel: $('#project-form-panel'), projectMessage: $('#project-form-message'), settingsForm: $('#settings-form'), settingsMessage: $('#settings-message')
  };
  const viewCopy = { chat: ['PERSONAL ASSISTANT', 'Good to see you, Bharath.'], workspace: ['YOUR WORKSPACE', 'Projects'], settings: ['LOCAL CONFIGURATION', 'Provider settings'] };

  function text(value, fallback = '') { return value == null ? fallback : String(value); }
  function saveMessages() { try { window.localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(state.messages.slice(-80))); } catch (_) { /* local persistence is best effort */ } }
  function saveContext() { try { window.localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(state.context || {})); } catch (_) { /* local persistence is best effort */ } }
  function loadContext() { try { const saved = JSON.parse(window.localStorage.getItem(CONTEXT_STORAGE_KEY) || '{}'); if (saved && typeof saved === 'object') state.context = saved; } catch (_) { state.context = {}; } }
  function loadSavedMessages() { try { const saved = JSON.parse(window.localStorage.getItem(CHAT_STORAGE_KEY) || '[]'); if (Array.isArray(saved)) renderHistory(saved.slice(-80)); } catch (_) { /* ignore invalid local history */ } }
  function showToast(message) { els.toast.textContent = message; els.toast.hidden = false; clearTimeout(showToast.timer); showToast.timer = setTimeout(() => { els.toast.hidden = true; }, 3600); }
  function setFormMessage(node, message, error = false) { node.textContent = message; node.classList.toggle('error', error); }
  function formatTime(date = new Date()) { return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
  function setConnection(online, detail = '') {
    state.online = online; els.connectionDot.classList.toggle('online', online); els.connectionDot.classList.toggle('offline', !online); els.connectionLabel.textContent = online ? 'Local server ready' : 'Local server offline'; els.connectionDetail.textContent = detail || (online ? 'Connected to BRO backend' : 'Start the backend to connect');
    els.serverAlert.hidden = online;
  }
  function setView(view) {
    state.view = view;
    els.nav.forEach(button => { const active = button.dataset.view === view; button.classList.toggle('active', active); if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current'); });
    els.views.forEach(panel => { const active = panel.dataset.viewPanel === view; panel.hidden = !active; panel.classList.toggle('active', active); });
    els.eyebrow.textContent = viewCopy[view][0]; els.title.textContent = viewCopy[view][1]; document.title = `BRO · ${viewCopy[view][1]}`;
    $('.sidebar')?.classList.remove('open');
  }
  function setBusy(busy, showThinking = busy) { state.busy = busy; els.send.disabled = busy; els.input.disabled = busy; els.typing.hidden = !showThinking; }
  function isLightConversation(message) { const value = text(message).trim(); const greeting = /\b(?:hey|hi|hello|welcome|good\s+(?:morning|afternoon|evening))\b/i.test(value); const action = /https?:\/\/|\b(?:open|visit|go\s+to|run|execute|list|show|search|find|google|status|health|help|activate|wake\s+up)\b/i.test(value); return greeting && !action; }
  function isActivateBroCommand(message) { return /^(?:please\s+|could\s+you\s+|can\s+you\s+|would\s+you\s+)?(?:activate|start|wake\s+up)\s+bro(?:\s+command)?[.!?]*$/i.test(text(message).trim()); }
  function scheduleActivateBro(message) {
    if (!isActivateBroCommand(message) || state.busy) return;
    clearTimeout(scheduleActivateBro.timer);
    scheduleActivateBro.timer = setTimeout(() => {
      if (!state.busy && isActivateBroCommand(els.input.value)) sendMessage(els.input.value);
    }, 250);
  }
  function scrollChat() { requestAnimationFrame(() => { const scroller = $('#chat-scroll'); scroller.scrollTop = scroller.scrollHeight; }); }
  function makeAvatar(kind) { const avatar = document.createElement('div'); avatar.className = `avatar ${kind === 'user' ? 'user-avatar' : 'assistant-avatar'}`; const name = state.user?.displayName || 'Bharath'; avatar.textContent = kind === 'user' ? name.charAt(0).toUpperCase() : 'B'; avatar.setAttribute('aria-hidden', 'true'); return avatar; }
  function speak(reply) { if (state.readAloud && 'speechSynthesis' in window && reply) { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(reply); utterance.rate = .98; window.speechSynthesis.speak(utterance); } }
  function addMessage(role, value, timestamp = new Date(), shouldSpeak = false) {
    const message = text(value).trim(); if (!message) return;
    state.messages.push({ role, content: message }); saveMessages(); els.welcome.hidden = true;
    const row = document.createElement('div'); row.className = `message-row ${role}`;
    row.append(makeAvatar(role)); const content = document.createElement('div'); content.className = 'message-content'; const bubble = document.createElement('div'); bubble.className = 'message-bubble'; bubble.textContent = message; content.append(bubble);
    const meta = document.createElement('div'); meta.className = 'message-meta'; const time = document.createElement('span'); time.textContent = timestamp instanceof Date ? formatTime(timestamp) : text(timestamp); meta.append(time);
    if (role === 'assistant' && 'speechSynthesis' in window) { const button = document.createElement('button'); button.type = 'button'; button.className = 'speak-message'; button.textContent = '◖'; button.title = 'Read this reply aloud'; button.setAttribute('aria-label', 'Read this reply aloud'); button.addEventListener('click', () => { window.speechSynthesis.cancel(); const utterance = new SpeechSynthesisUtterance(message); window.speechSynthesis.speak(utterance); }); meta.append(button); }
    content.append(meta); row.append(content); els.messages.append(row); if (shouldSpeak) speak(message); scrollChat();
  }
  function renderHistory(items) {
    if (!Array.isArray(items) || !items.length) return;
    items.forEach(item => { const role = item.role === 'user' ? 'user' : 'assistant'; const value = item.content ?? item.message ?? item.text ?? item.reply; if (value) addMessage(role, value, item.createdAt ? new Date(item.createdAt) : new Date()); });
  }
  function errorMessage(error) { return error?.message || 'Something went wrong. Please try again.'; }
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    let data = null; try { data = await response.json(); } catch (_) { /* non-JSON response */ }
    if (!response.ok) throw new Error(data?.error || data?.message || `Request failed (${response.status})`);
    return data || {};
  }
  function normalizeBootstrap(data) {
    const projects = data.projects || data.workspace?.projects || data.data?.projects || [];
    state.projects = Array.isArray(projects) ? projects : [];
    const displayName = text(data.user?.displayName, 'Bharath').trim() || 'Bharath';
    state.user = { displayName };
    viewCopy.chat[1] = `Good to see you, ${displayName}.`;
    if (els.welcomeHeading) els.welcomeHeading.textContent = `What are we building today, ${displayName}?`;
    state.settings = data.settings || data.provider || data.config || {};
    if (data.context && typeof data.context === 'object') { state.context = data.context; saveContext(); }
    if (data.voice && typeof data.voice === 'object') state.voice = data.voice;
    const history = data.history || data.messages || data.conversation;
    if (!state.messages.length && Array.isArray(history)) renderHistory(history);
    renderProjects(); fillSettings(); if (state.view === 'chat') setView('chat');
  }
  async function refreshBootstrap(showError = true) {
    try { const data = await api('/api/bootstrap'); normalizeBootstrap(data); setConnection(true); return data; }
    catch (error) { setConnection(false, 'Start the local server, then retry'); if (showError) els.serverAlertText.textContent = `${errorMessage(error)} Start the local backend, then retry.`; return null; }
  }
  function getChatReply(data) { return data.reply ?? data.response ?? data.message ?? data.text ?? data.content ?? ''; }
  function getActions(data) { const actions = data.actions || data.actionCards || data.tools || data.toolCalls || []; return Array.isArray(actions) ? actions : (data.action || data.tool ? [data.action || data.tool] : []); }
  function actionType(action) { return text(action?.type || action?.action || action?.name || action).toLowerCase(); }
  function actionSummary(action) { return action?.command || action?.summary || action?.description || action?.detail || action?.label || (typeof action === 'string' ? action : 'BRO is ready to perform this action.'); }
  function actionLabel(action) { const type = actionType(action); if (type.includes('run_project_command')) return 'Run project command'; if (type.includes('open_project')) return 'Open project'; return text(action?.label || action?.title || type || 'Suggested action'); }
  function resultText(data, fallback = 'Action completed.') {
    if (typeof data?.message === 'string' && data.message) return data.message;
    const result = data?.result;
    if (typeof result === 'string' && result) return result;
    if (result && typeof result === 'object') {
      if (typeof result.stdout === 'string' || typeof result.stderr === 'string') {
        const parts = [];
        if (result.stdout) parts.push(`stdout:\n${result.stdout}`);
        if (result.stderr) parts.push(`stderr:\n${result.stderr}`);
        if (result.timedOut) parts.push('The command timed out after 30 seconds.');
        if (typeof result.code === 'number') parts.push(`Exit code: ${result.code}`);
        return parts.join('\n\n') || 'The command finished without output.';
      }
      if (result.opened && result.target) return `Opened ${result.target}`;
      try { return JSON.stringify(result, null, 2); } catch (_) { return fallback; }
    }
    return fallback;
  }
  function appendAction(action) {
    const type = actionType(action); const approval = type.includes('run_project_command'); const card = document.createElement('article'); card.className = `action-card${approval ? ' approval' : ''}`; const head = document.createElement('div'); head.className = 'action-card-head'; const icon = document.createElement('div'); icon.className = 'action-card-icon'; icon.textContent = approval ? '!' : '→'; icon.setAttribute('aria-hidden', 'true'); const body = document.createElement('div'); const title = document.createElement('h4'); title.textContent = approval ? 'Approval needed' : actionLabel(action); const summary = document.createElement('p'); summary.textContent = actionSummary(action); body.append(title, summary); head.append(icon, body); card.append(head);
    const buttons = document.createElement('div'); buttons.className = 'action-buttons'; const result = document.createElement('div'); result.className = 'action-result';
    if (approval) { const dismiss = document.createElement('button'); dismiss.type = 'button'; dismiss.className = 'dismiss-button'; dismiss.textContent = 'Dismiss'; const approve = document.createElement('button'); approve.type = 'button'; approve.className = 'approve-button'; approve.textContent = 'Approve'; dismiss.addEventListener('click', () => { result.textContent = 'Dismissed'; card.classList.add('resolved'); dismiss.disabled = true; approve.disabled = true; }); approve.addEventListener('click', () => executeAction(action, card, result, approve, dismiss)); buttons.append(dismiss, approve); }
    else { const execute = document.createElement('button'); execute.type = 'button'; execute.className = 'approve-button'; execute.textContent = 'Run action'; execute.addEventListener('click', () => executeAction(action, card, result, execute)); buttons.append(execute); }
    card.append(buttons, result); els.actionFeed.append(card); scrollChat();
  }
  async function executeAction(action, card, result, primary, secondary) {
    primary.disabled = true; if (secondary) secondary.disabled = true; result.className = 'action-result'; result.textContent = 'Working…';
    try { const data = await api('/api/action', { method: 'POST', body: JSON.stringify({ action }) }); result.className = 'action-result success'; result.textContent = resultText(data); await refreshBootstrap(false); }
    catch (error) { result.className = 'action-result error'; result.textContent = errorMessage(error); primary.disabled = false; if (secondary) secondary.disabled = false; }
  }
  async function sendMessage(value = els.input.value) {
    const message = text(value).trim(); if (!message || state.busy) return;
    addMessage('user', message); els.input.value = ''; resizeInput(); setBusy(true, !isLightConversation(message));
    try { const history = state.messages.slice(0, -1).slice(-20); const data = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message, history, context: state.context }) }); if (data.context && typeof data.context === 'object') { state.context = data.context; saveContext(); } const reply = getChatReply(data); if (reply) addMessage('assistant', reply, new Date(), true); getActions(data).forEach(appendAction); if (!reply && !getActions(data).length) addMessage('assistant', 'I received that, but the backend did not return a message.'); }
    catch (error) { addMessage('assistant', `I couldn’t reach the local backend. ${errorMessage(error)}`); setConnection(false, 'Chat request failed'); }
    finally { setBusy(false); els.input.focus(); scrollChat(); }
  }
  function resizeInput() { els.input.style.height = 'auto'; els.input.style.height = `${Math.min(els.input.scrollHeight, 140)}px`; }
  function renderProjects() {
    els.projects.textContent = ''; const count = state.projects.length; els.projectCount.textContent = `${count} project${count === 1 ? '' : 's'}`; $('#chat-count').textContent = state.messages.filter(message => message.role === 'user').length;
    if (!count) { const empty = document.createElement('div'); empty.className = 'empty-projects'; const strong = document.createElement('strong'); strong.textContent = 'No projects yet'; const p = document.createElement('span'); p.textContent = 'Add a folder to give BRO a place to work.'; empty.append(strong, p); els.projects.append(empty); return; }
    state.projects.forEach(project => { const card = document.createElement('article'); card.className = 'project-card'; const header = document.createElement('div'); header.className = 'project-card-header'; const icon = document.createElement('div'); icon.className = 'project-icon'; icon.textContent = '▦'; icon.setAttribute('aria-hidden', 'true'); const info = document.createElement('div'); const name = document.createElement('h4'); name.textContent = text(project.name, 'Unnamed project'); const root = document.createElement('span'); root.className = 'project-root'; root.title = text(project.root); root.textContent = text(project.root, 'No folder path'); info.append(name, root); header.append(icon, info); card.append(header); const actions = document.createElement('div'); actions.className = 'project-card-actions'; const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Open'; open.addEventListener('click', () => projectRequest(project, 'open')); actions.append(open); ['dev', 'test', 'build', 'lint'].forEach(profile => { const command = project.commands?.[profile] ?? project[`${profile}Command`]; if (command) { const run = document.createElement('button'); run.type = 'button'; run.textContent = `Run ${profile}`; run.addEventListener('click', () => projectRequest(project, 'run', profile)); actions.append(run); } }); const del = document.createElement('button'); del.type = 'button'; del.className = 'delete-project'; del.textContent = 'Remove'; del.addEventListener('click', () => deleteProject(project)); actions.append(del); card.append(actions); els.projects.append(card); });
  }
  function projectId(project) { return project.id ?? project._id ?? project.projectId; }
  async function projectRequest(project, operation, profile = '') { const id = projectId(project); if (id == null) { showToast('This project has no backend id yet. Refresh and try again.'); return; } if (operation === 'run' && !window.confirm(`Run the configured “${profile}” profile in ${text(project.name, 'this project')}?`)) return; try { const encodedId = encodeURIComponent(id); const path = operation === 'open' ? `/api/projects/${encodedId}/open` : `/api/projects/${encodedId}/run`; const body = operation === 'run' ? JSON.stringify({ profile, approved: true }) : undefined; const data = await api(path, { method: 'POST', ...(body ? { body } : {}) }); showToast(resultText(data, operation === 'open' ? 'Project opened.' : `${profile} command finished.`)); await refreshBootstrap(false); } catch (error) { showToast(errorMessage(error)); } }
  async function deleteProject(project) { const id = projectId(project); if (id == null) { showToast('This project has no backend id yet. Refresh and try again.'); return; } if (!window.confirm(`Remove ${text(project.name, 'this project')} from BRO?`)) return; try { await api(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' }); showToast('Project removed.'); await refreshBootstrap(false); } catch (error) { showToast(errorMessage(error)); } }
  function fillSettings() { if (state.settings.baseUrl) $('#base-url').value = text(state.settings.baseUrl); if (state.settings.model) $('#model').value = text(state.settings.model); if (state.settings.protocol) $('#protocol').value = text(state.settings.protocol); $('#api-key').value = ''; }
  function setupVoice() {
    let recorder = null;
    const releaseMic = () => { recorder = null; els.mic.classList.remove('recording'); els.mic.setAttribute('aria-label', 'Use voice input'); };

    async function recordOnce() {
      if (!window.BroRecorder || !window.BroRecorder.isSupported) { showToast('Microphone capture is not available in this browser.'); return; }
      if (state.voice && state.voice.available === false) { showToast(state.voice.reason || 'The local voice engine is not available.'); return; }
      els.mic.classList.add('recording'); els.mic.setAttribute('aria-label', 'Stop voice input');
      showToast('Listening… speak, then pause.');
      let mic;
      try { mic = await window.BroRecorder.open({ onLevel: () => {} }); }
      catch (error) {
        releaseMic();
        const denied = error && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
        showToast(denied ? 'Microphone permission was denied. Allow microphone access for BRO.' : `Voice input failed: ${(error && error.message) || 'unknown error'}.`);
        return;
      }
      recorder = mic;
      const clip = await mic.capture({ silenceMs: 900, noSpeechMs: 7000, maxMs: 20000 });
      mic.close();
      releaseMic();
      if (clip.reason === 'no-speech' || clip.durationMs < 250) { showToast('I did not hear anything. Tap the mic and speak.'); return; }
      try {
        const data = await api('/api/voice/transcribe', { method: 'POST', body: JSON.stringify({ audio: clip.audio, sampleRate: clip.sampleRate }) });
        const transcript = text(data.text).trim();
        if (!transcript) { showToast('I did not catch any words. Try again.'); return; }
        els.input.value = transcript; resizeInput(); els.input.focus(); scheduleActivateBro(transcript);
      } catch (error) { showToast(errorMessage(error)); }
    }

    els.mic.addEventListener('click', () => {
      if (recorder) { recorder.stopCapture('manual'); return; }
      recordOnce();
    });
  }
  function wireEvents() {
    els.nav.forEach(button => button.addEventListener('click', () => setView(button.dataset.view))); $$('.suggestion-chip').forEach(button => button.addEventListener('click', () => { els.input.value = button.dataset.suggestion; resizeInput(); els.input.focus(); })); $('#mobile-menu').addEventListener('click', () => $('.sidebar').classList.toggle('open')); $('#retry-bootstrap').addEventListener('click', () => refreshBootstrap());
    els.chatForm.addEventListener('submit', event => { event.preventDefault(); sendMessage(); }); els.input.addEventListener('input', () => { resizeInput(); scheduleActivateBro(els.input.value); }); els.input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); sendMessage(); } });
    els.speaker.addEventListener('click', () => { if (!('speechSynthesis' in window)) { showToast('Read aloud is not supported in this browser.'); return; } state.readAloud = !state.readAloud; els.speaker.setAttribute('aria-pressed', String(state.readAloud)); els.speaker.setAttribute('aria-label', state.readAloud ? 'Turn read aloud off' : 'Turn read aloud on'); showToast(state.readAloud ? 'Read aloud enabled.' : 'Read aloud disabled.'); if (!state.readAloud) window.speechSynthesis.cancel(); });
    $('#show-project-form').addEventListener('click', () => { els.projectFormPanel.hidden = false; $('#project-name').focus(); }); $('#hide-project-form').addEventListener('click', () => { els.projectFormPanel.hidden = true; }); $('#cancel-project').addEventListener('click', () => { els.projectForm.reset(); els.projectFormPanel.hidden = true; setFormMessage(els.projectMessage, ''); });
    els.projectForm.addEventListener('submit', async event => { event.preventDefault(); const form = new FormData(els.projectForm); const commands = {}; ['dev', 'test', 'build', 'lint'].forEach(key => { if (form.get(key)) commands[key] = form.get(key); }); const payload = { name: form.get('name'), root: form.get('root'), commands }; const button = $('button[type="submit"]', els.projectForm); button.disabled = true; setFormMessage(els.projectMessage, 'Registering…'); try { await api('/api/projects/register', { method: 'POST', body: JSON.stringify(payload) }); els.projectForm.reset(); els.projectFormPanel.hidden = true; showToast('Project added.'); await refreshBootstrap(false); } catch (error) { setFormMessage(els.projectMessage, errorMessage(error), true); } finally { button.disabled = false; } });
    $('#openai-gpt-preset').addEventListener('click', () => { $('#base-url').value = 'https://api.openai.com/v1'; $('#model').value = 'gpt-6.1-sol'; $('#protocol').value = 'responses'; $('#api-key').focus(); setFormMessage(els.settingsMessage, 'Preset filled. Add your API key, then save.'); });
    els.settingsForm.addEventListener('submit', async event => { event.preventDefault(); const form = new FormData(els.settingsForm); const payload = { baseUrl: form.get('baseUrl'), model: form.get('model'), protocol: form.get('protocol'), apiKey: form.get('apiKey') }; const button = $('button[type="submit"]', els.settingsForm); button.disabled = true; setFormMessage(els.settingsMessage, 'Saving locally…'); try { await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) }); $('#api-key').value = ''; setFormMessage(els.settingsMessage, 'Saved. The key will not be shown again.'); showToast('Provider settings saved.'); await refreshBootstrap(false); } catch (error) { setFormMessage(els.settingsMessage, errorMessage(error), true); } finally { button.disabled = false; } });
  }
  loadSavedMessages(); loadContext(); wireEvents(); setupVoice(); setView('chat'); refreshBootstrap();
})();
