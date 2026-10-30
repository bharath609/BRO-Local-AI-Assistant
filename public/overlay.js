(() => {
  'use strict';

  console.log(`BRO voice popup ready (recorder=${Boolean(window.BroRecorder && window.BroRecorder.isSupported)})`);

  const $ = (selector) => document.querySelector(selector);
  const CONTEXT_STORAGE_KEY = 'bro-overlay-context-v1';
  const CAPTURE_OPTIONS = { silenceMs: 900, noSpeechMs: 6000, maxMs: 15000 };
  const WATCH_OPTIONS = { silenceMs: 550, noSpeechMs: 3500, maxMs: 3500 };
  const WAKE_COOLDOWN_MS = 900;
  // 20 s by default; BRO_AUTO_HIDE_MS tunes it for testing or personal taste.
  const AUTO_HIDE_MS = (window.broDesktop && Number(window.broDesktop.autoHideMs)) || 20000;
  let hideTimer = null;

  // phase: idle -> awake -> listening -> transcribing -> working -> idle
  //   idle    microphone closed, waiting for the hotkey
  //   awake   microphone open, listening only for the “BRO” wake word
  const state = { phase: 'idle', mic: null, micStarting: null, engine: null, context: {}, debug: false, wake: true, lastWakeCheckAt: 0, lastWatchClipAt: 0 };
  let heartbeatTimer = null;
  const debugVoice = (message) => { if (state.debug) console.log(message); };
  const els = {
    dot: $('#connection-dot'), close: $('#close-popup'), start: $('#start-listening'), stop: $('#stop-listening'),
    micState: $('#mic-state'), voiceStatus: $('#voice-status'), transcript: $('#transcript'), reply: $('#reply'),
  };

  function setVoiceStatus(message, error = false) {
    els.voiceStatus.textContent = message;
    els.voiceStatus.classList.toggle('error', error);
  }
  function setLevel(level) {
    document.documentElement.style.setProperty('--level', String(Math.max(0, Math.min(1, level))));
  }
  function loadContext() {
    try { const saved = JSON.parse(window.localStorage.getItem(CONTEXT_STORAGE_KEY) || '{}'); if (saved && typeof saved === 'object') state.context = saved; }
    catch (_) { state.context = {}; }
  }
  function saveContext() {
    try { window.localStorage.setItem(CONTEXT_STORAGE_KEY, JSON.stringify(state.context || {})); } catch (_) { /* best effort */ }
  }
  function setConnection(online) {
    els.dot.classList.toggle('online', online);
    els.dot.classList.toggle('offline', !online);
    els.dot.title = online ? 'BRO backend ready' : 'BRO backend offline';
  }

  function renderUi() {
    const phase = state.phase;
    const listening = phase === 'listening';
    const working = phase === 'transcribing' || phase === 'working';
    els.start.classList.toggle('listening', listening);
    els.start.disabled = working;
    els.micState.textContent = listening ? 'LISTENING' : (working ? 'WORKING' : (phase === 'awake' ? 'READY' : 'MIC OFF'));
    els.micState.classList.toggle('active', listening || working || phase === 'awake');
    els.stop.disabled = !(listening || phase === 'awake');
    els.stop.textContent = phase === 'awake' ? 'Sleep' : 'Stop';
    if (!listening) setLevel(0);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    let data = null;
    try { data = await response.json(); } catch (_) { /* non-JSON response */ }
    if (!response.ok) {
      const error = new Error((data && data.error) || `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }
    return data || {};
  }

  function normalizeSpeech(value) {
    let text = String(value || '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    text = text.replace(/^(?:hey|hi|hello|ok|okay|yo)\s+(?:bro|brother)\b[\s,.:;!-]*/i, '');
    text = text.replace(/^(?:bro|brother)\b[\s,.:;!-]*/i, '');
    text = text.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '');
    text = text.replace(/[.!?,;]+$/, '').trim();
    return text;
  }

  function showWindow() {
    if (window.broDesktop && typeof window.broDesktop.showOverlay === 'function') window.broDesktop.showOverlay();
  }
  function hideWindow() {
    if (window.broDesktop && typeof window.broDesktop.hideOverlay === 'function') window.broDesktop.hideOverlay();
  }
  function cancelAutoHide() {
    if (!hideTimer) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  // Hide the popup after a quiet period. The microphone stays in wake mode, so
  // saying “BRO” brings the window straight back.
  function scheduleAutoHide(delayMs = AUTO_HIDE_MS) {
    cancelAutoHide();
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (state.phase === 'awake' || state.phase === 'idle') hideWindow();
    }, delayMs);
  }

  function describeMicError(error) {
    const name = error && error.name ? error.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow the mic for BRO in Windows privacy settings.';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No microphone was found. Plug one in, then try again.';
    if (name === 'NotReadableError') return 'The microphone is busy in another app. Close it and try again.';
    return String((error && error.message) || 'The microphone could not be opened.');
  }

  async function ensureMic() {
    if (state.mic && !state.mic.closed) return state.mic;
    if (!state.micStarting) {
      state.micStarting = window.BroRecorder.open({ onLevel: setLevel })
        .then((mic) => { state.mic = mic; state.micStarting = null; return mic; })
        .catch((error) => { state.micStarting = null; throw error; });
    }
    return state.micStarting;
  }

  function closeMic() {
    stopHeartbeat();
    if (!state.mic) return;
    const mic = state.mic;
    state.mic = null;
    try { mic.close(); } catch (_) { /* already closed */ }
  }

  function beginWatch(mic) {
    state.lastWatchClipAt = Date.now();
    mic.startWatch({ ...WATCH_OPTIONS, onLevel: setLevel, onClip: (clip) => { handleWakeClip(clip); } });
  }

  // The watcher produces a clip at least every few seconds even in silence.
  // If that stops, the audio graph was suspended (Chromium does this when a
  // window is hidden or the system sleeps), so revive it instead of going deaf.
  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (state.phase !== 'awake' || !state.mic) { stopHeartbeat(); return; }
      const stalledFor = Date.now() - state.lastWatchClipAt;
      if (stalledFor > 8000) {
        console.log(`BRO voice: wake capture stalled for ${Math.round(stalledFor / 1000)}s; restarting`);
        if (typeof state.mic.ensureRunning === 'function') state.mic.ensureRunning();
        resumeWatch();
      }
    }, 5000);
  }
  function stopHeartbeat() {
    if (!heartbeatTimer) return;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  function resumeWatch() {
    if (state.phase !== 'awake' || !state.mic) return;
    beginWatch(state.mic);
  }

  async function startWakeMode({ quiet = false } = {}) {
    if (!state.wake || (state.phase !== 'idle' && state.phase !== 'awake')) return;
    if (state.phase === 'awake' && state.mic) { resumeWatch(); return; }
    let mic;
    try { mic = await ensureMic(); }
    catch (error) {
      state.phase = 'idle';
      renderUi();
      setVoiceStatus(describeMicError(error), true);
      return;
    }
    if (!state.wake) { closeMic(); return; }
    state.phase = 'awake';
    renderUi();
    if (!quiet) setVoiceStatus('Say “BRO” to talk — or press Ctrl + Alt + B.');
    beginWatch(mic);
    startHeartbeat();
    scheduleAutoHide();
  }

  async function sleepBro(message = 'Microphone off. Press Ctrl + Alt + B when you want to talk again.') {
    state.wake = false;
    stopHeartbeat();
    if (state.mic) state.mic.stopWatch();
    state.phase = 'idle';
    closeMic();
    renderUi();
    setVoiceStatus(message);
    scheduleAutoHide(5000);
  }

  async function handleWakeClip(clip) {
    state.lastWatchClipAt = Date.now();
    debugVoice(`BRO wake clip ${clip.durationMs}ms peak=${clip.peak} reason=${clip.reason} hidden=${document.hidden}`);
    if (state.phase !== 'awake' || !state.mic) return;
    if (clip.reason === 'cancelled' || clip.durationMs < 250) return;
    if (clip.peak < 0.02) return; // room noise, not someone talking
    const now = Date.now();
    if (now - state.lastWakeCheckAt < WAKE_COOLDOWN_MS) return;
    state.lastWakeCheckAt = now;

    const mic = state.mic;
    mic.stopWatch(); // one wake check at a time
    try {
      const result = await api('/api/voice/wake', { method: 'POST', body: JSON.stringify({ audio: clip.audio }) });
      if (state.phase !== 'awake' || state.mic !== mic) return;
      if (result.sleep) {
        await sleepBro('Okay, going quiet. Press Ctrl + Alt + B when you want to talk again.');
        return;
      }
      if (result.wake) {
        console.log(`BRO wake word detected in ${result.ms}ms (${String(result.text || '').length} chars)`);
        debugVoice(`BRO wake transcript: ${result.text}`);
        cancelAutoHide();
        showWindow();
        if (result.commandText) { await runCommandText(result.commandText); return; }
        setVoiceStatus('Yes — listening…');
        await captureCommand();
        return;
      }
      debugVoice(`BRO ignored wake clip: ${JSON.stringify(result.text || '')} (${result.ms}ms)`);
    } catch (_) {
      // A failed wake check is never fatal; just keep listening.
    }
    if (state.phase === 'awake' && state.mic === mic) resumeWatch();
  }

  async function runCommandText(text) {
    if (!text || state.phase === 'working') return;
    if (state.mic) state.mic.stopWatch();
    els.transcript.textContent = text;
    await sendCommand(text);
  }

  async function captureCommand() {
    if (state.phase !== 'idle' && state.phase !== 'awake') return;
    cancelAutoHide();
    showWindow();
    let mic;
    try { mic = await ensureMic(); }
    catch (error) {
      state.phase = 'idle';
      renderUi();
      setVoiceStatus(describeMicError(error), true);
      return;
    }
    mic.stopWatch();
    state.phase = 'listening';
    els.transcript.textContent = '\u00a0';
    els.reply.textContent = '\u00a0';
    renderUi();
    setVoiceStatus('Listening… speak your command.');
    const clip = await mic.capture({ ...CAPTURE_OPTIONS, onLevel: setLevel });
    if (state.phase !== 'listening') return;
    if (clip.reason === 'cancelled') {
      state.phase = 'idle';
      renderUi();
      if (state.wake) startWakeMode(); else setVoiceStatus('Press Ctrl + Alt + B once to listen.');
      return;
    }
    state.phase = 'transcribing';
    renderUi();
    console.log(`BRO voice clip ${clip.durationMs}ms reason=${clip.reason} peak=${clip.peak}`);
    if (clip.reason === 'no-speech' || clip.durationMs < 250) {
      const quiet = clip.peak < 0.01;
      setVoiceStatus(quiet
        ? 'I did not hear anything. Check that your microphone is not muted in Windows, then try again.'
        : 'I did not hear a command. Say “BRO” again or press Ctrl + Alt + B.', true);
      finishCycle();
      return;
    }
    await transcribeClip(clip);
  }

  function finishCycle() {
    state.phase = 'idle';
    renderUi();
    // Keep whatever message the caller just set (usually an error or retry hint).
    if (state.wake) startWakeMode({ quiet: true });
    else {
      closeMic();
      if (!els.voiceStatus.classList.contains('error')) setVoiceStatus('Press Ctrl + Alt + B once to listen.');
      scheduleAutoHide();
    }
  }

  async function sendCommand(message) {
    if (!message || state.phase === 'working') return;
    console.log(`BRO command captured (${message.length} chars)`);
    debugVoice(`BRO transcript: ${message}`);
    if (state.mic) state.mic.stopWatch();
    state.phase = 'working';
    renderUi();
    els.transcript.textContent = message;
    els.reply.textContent = '';
    setVoiceStatus('BRO is working…');
    try {
      const data = await api('/api/chat', { method: 'POST', body: JSON.stringify({ message, context: state.context }) });
      if (data.context && typeof data.context === 'object') { state.context = data.context; saveContext(); }
      els.reply.textContent = data.reply || 'Done.';
      if (Array.isArray(data.actions) && data.actions.length) els.reply.textContent = `${els.reply.textContent} Open the full app to review the pending action.`;
      setConnection(true);
    } catch (error) {
      els.reply.textContent = `BRO could not respond: ${error.message}`;
      setConnection(false);
    } finally {
      state.phase = 'idle';
      renderUi();
      if (state.wake) {
        setVoiceStatus('Say “BRO” for the next command — or press Ctrl + Alt + B.');
        startWakeMode();
        scheduleAutoHide();
      } else {
        closeMic();
        setVoiceStatus('Done. Press Ctrl + Alt + B once for the next command.');
      }
    }
  }

  async function transcribeClip(clip) {
    state.phase = 'transcribing';
    renderUi();
    setVoiceStatus('Transcribing…');
    try {
      const result = await api('/api/voice/transcribe', {
        method: 'POST',
        body: JSON.stringify({ audio: clip.audio, sampleRate: clip.sampleRate, durationMs: clip.durationMs }),
      });
      const spoken = normalizeSpeech(result.text);
      if (!spoken) {
        els.transcript.textContent = '\u00a0';
        setVoiceStatus(state.wake ? 'I did not catch any words. Say “BRO” and try again.' : 'I did not catch any words. Press Ctrl + Alt + B and speak clearly.', true);
        finishCycle();
        return;
      }
      els.transcript.textContent = spoken;
      await sendCommand(spoken);
    } catch (error) {
      if (error.status === 503) {
        setVoiceStatus('The local voice engine is not installed. Run “npm run setup:voice” once, then retry.', true);
        state.phase = 'idle';
        renderUi();
        return;
      }
      setVoiceStatus(`Voice input failed: ${error.message}`, true);
      finishCycle();
    }
  }

  function stopPressed() {
    cancelAutoHide();
    if (state.phase === 'awake') { sleepBro(); return; }
    if (state.phase === 'listening' && state.mic) {
      setVoiceStatus('Finishing the recording…');
      state.mic.stopCapture('manual');
    }
  }

  function micPressed() {
    cancelAutoHide();
    showWindow();
    if (state.phase === 'idle' || state.phase === 'awake') { captureCommand(); return; }
    if (state.phase === 'listening' && state.mic) state.mic.stopCapture('manual');
  }

  async function checkBackend() {
    try {
      const data = await api('/api/bootstrap');
      setConnection(true);
      state.engine = data.voice || null;
      if (!state.engine || state.engine.available === false) {
        setVoiceStatus((state.engine && state.engine.reason) || 'Press Ctrl + Alt + B once to listen', true);
      } else {
        setVoiceStatus('Press Ctrl + Alt + B once to listen');
        if (state.wake) startWakeMode();
      }
    } catch (_) {
      setConnection(false);
      setVoiceStatus('BRO backend is offline.', true);
    }
  }

  function registerHotkey() {
    if (!window.broDesktop || typeof window.broDesktop.onHotkey !== 'function') return;
    window.broDesktop.onHotkey(() => {
      cancelAutoHide();
      showWindow();
      if (state.phase === 'working' || state.phase === 'transcribing') return;
      if (state.phase === 'awake') { captureCommand(); return; }
      if (state.phase !== 'idle') return;
      state.wake = true;
      captureCommand();
    });
  }

  els.start.addEventListener('click', micPressed);
  els.stop.addEventListener('click', stopPressed);
  els.close.addEventListener('click', () => {
    state.wake = false;
    closeMic();
    if (window.broDesktop && typeof window.broDesktop.closeOverlay === 'function') window.broDesktop.closeOverlay();
    else window.close();
  });
  window.addEventListener('beforeunload', () => { state.wake = false; closeMic(); });

  loadContext();
  state.debug = Boolean(window.broDesktop && window.broDesktop.voiceDebug);
  state.wake = !(window.broDesktop && window.broDesktop.wakeWord === false);
  registerHotkey();
  renderUi();
  checkBackend();
})();
