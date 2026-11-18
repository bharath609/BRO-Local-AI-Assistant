(() => {
  'use strict';

  console.log(`BRO voice popup ready (recorder=${Boolean(window.BroRecorder && window.BroRecorder.isSupported)})`);

  const $ = (selector) => document.querySelector(selector);
  const CONTEXT_STORAGE_KEY = 'bro-overlay-context-v1';
  const CAPTURE_OPTIONS = { silenceMs: 1100, noSpeechMs: 6000, maxMs: 15000 };
  // A wake clip only needs the name itself. A shorter silence window and a
  // shorter no-speech window mean each attempt is checked sooner instead of
  // waiting seconds before the engine even sees it.
  const WATCH_OPTIONS = { silenceMs: 450, noSpeechMs: 2500, maxMs: 4000 };
  const WAKE_COOLDOWN_MS = 400;
  // 20 s by default; BRO_AUTO_HIDE_MS tunes it for testing or personal taste.
  const AUTO_HIDE_MS = (window.broDesktop && Number(window.broDesktop.autoHideMs)) || 20000;
  // After every command BRO stays awake this long, treating the next thing you
  // say as a command without needing the wake word again.
  const FOLLOW_UP_MS = (window.broDesktop && Number(window.broDesktop.followUpMs)) || 20000;
  // Commands that put BRO to sleep: the popup disappears, but the microphone
  // keeps watching for “BRO” so saying it (or pressing Ctrl + Alt + B) brings
  // the popup straight back.
  const SLEEP_COMMAND = /^(?:stop\s+listening|(?:go\s+(?:to\s+)?)?sleep(?:\s+(?:mode|now|bro))?|sleeping|go\s+quiet|go\s+away|disappear|hide(?:\s+yourself)?|good\s?bye|bye(?:\s+bro)?|that(?:'?s|\s+is)\s+all)[.!]?$/i;
  let hideTimer = null;

  // phase: idle -> awake -> listening -> transcribing -> working -> idle
  //   idle    microphone closed, waiting for the hotkey
  //   awake   microphone open, listening only for the “BRO” wake word
  const state = { phase: 'idle', mic: null, micStarting: null, engine: null, context: {}, debug: false, wake: true, lastWakeCheckAt: 0, lastWatchClipAt: 0, followUp: false, followUpDeadline: 0, followUpToken: 0, retryCapture: false, wakeActive: 0, lastWakeHandledAt: 0 };
  let heartbeatTimer = null;
  const debugVoice = (message) => { if (state.debug) console.log(message); };
  const els = {
    dot: $('#connection-dot'), close: $('#close-popup'), start: $('#start-listening'), stop: $('#stop-listening'),
    micState: $('#mic-state'), voiceStatus: $('#voice-status'), transcript: $('#transcript'), reply: $('#reply'),
    guard: $('#guard-badge'),
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

  // The badge is always visible so the user can see which guardrail level is
  // active and whether the master lock is on before they speak.
  function renderGuardrails(info) {
    if (!info || !els.guard) return;
    const mode = String(info.mode || 'guarded').toLowerCase();
    const locked = Boolean(info.locked);
    els.guard.textContent = `${mode.toUpperCase()}${locked ? ' · LOCKED' : ''}`;
    els.guard.title = `Guardrails: ${mode}${locked ? ' (master lock on)' : ''}${info.pending ? ` · ${info.pending} waiting for approval` : ''}`;
    els.guard.classList.toggle('locked', locked);
    els.guard.classList.toggle('strict', !locked && mode === 'strict');
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

  // ---- Conversation window -------------------------------------------------
  // After a command finishes — whether it worked or failed — BRO keeps the
  // microphone open for FOLLOW_UP_MS. Anything you say in that window is run
  // as a new command without saying “BRO” again. Twenty seconds of silence
  // ends the window and returns BRO to wake-word-only mode.

  function cancelFollowUp() {
    state.followUp = false;
    state.followUpToken += 1;
    state.followUpDeadline = 0;
  }

  function startFollowUp() {
    if (!state.wake) return;
    cancelAutoHide();
    state.followUp = true;
    state.followUpDeadline = Date.now() + FOLLOW_UP_MS;
    state.followUpToken += 1;
    const token = state.followUpToken;
    setVoiceStatus('Listening — say your next command (20 s).');
    followUpLoop(token).catch((error) => {
      console.warn(`BRO follow-up stopped: ${error.message}`);
      if (state.followUpToken === token) endFollowUp({ quiet: true });
    });
  }

  function endFollowUp({ quiet = false } = {}) {
    if (!state.followUp) return;
    cancelFollowUp();
    state.phase = 'idle';
    renderUi();
    if (state.wake) {
      startWakeMode({ quiet });
      scheduleAutoHide();
    } else {
      closeMic();
    }
  }

  async function followUpLoop(token) {
    setVoiceStatus('Listening — say your next command (20 s).');
    while (state.followUp && state.followUpToken === token && state.wake) {
      const remaining = state.followUpDeadline - Date.now();
      if (remaining < 900) break;
      let mic;
      try {
        mic = await ensureMic();
      } catch (error) {
        state.phase = 'idle';
        renderUi();
        setVoiceStatus(describeMicError(error), true);
        break;
      }
      if (state.followUpToken !== token || !state.followUp) return;
      mic.stopWatch();
      state.phase = 'listening';
      renderUi();
      setVoiceStatus('Listening — say your next command (20 s).');
      let clip;
      try {
        clip = await mic.capture({ ...CAPTURE_OPTIONS, noSpeechMs: Math.min(remaining, FOLLOW_UP_MS), onLevel: setLevel });
      } catch (error) {
        setVoiceStatus(`Listening failed: ${error.message}`, true);
        break;
      }
      if (state.followUpToken !== token || !state.followUp || !state.wake) return;
      if (clip.reason === 'cancelled' || clip.reason === 'manual') break;
      // No speech for the rest of the window: go back to sleep.
      if (clip.reason === 'no-speech' || clip.durationMs < 250) break;

      state.phase = 'transcribing';
      renderUi();
      setVoiceStatus('Transcribing…');
      let spoken = '';
      try {
        const result = await api('/api/voice/transcribe', {
          method: 'POST',
          body: JSON.stringify({ audio: clip.audio, sampleRate: clip.sampleRate, durationMs: clip.durationMs }),
        });
        spoken = normalizeSpeech(result.text);
      } catch (error) {
        // Keep the conversation open so the user can simply try again.
        els.reply.textContent = `BRO could not hear that: ${error.message}`;
        setVoiceStatus('I did not catch that. Still listening — try again.', true);
        state.followUpDeadline = Date.now() + FOLLOW_UP_MS;
        continue;
      }
      if (state.followUpToken !== token || !state.followUp) return;
      if (!spoken) {
        setVoiceStatus('I’m here — go ahead.');
        state.followUpDeadline = Date.now() + FOLLOW_UP_MS;
        continue;
      }
      if (SLEEP_COMMAND.test(spoken)) {
        els.transcript.textContent = spoken;
        await sleepBro('Going to sleep. Say “BRO” or press Ctrl + Alt + B to wake me.');
        return;
      }
      els.transcript.textContent = spoken;
      state.followUpDeadline = Date.now() + FOLLOW_UP_MS;
      await sendCommand(spoken);
      // sendCommand keeps state.followUp set, so this loop continues and the
      // next sentence is treated as another command.
    }
    endFollowUp({ quiet: true });
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

  // Ask the backend to start (or reuse) the Whisper servers as soon as we enter
  // wake mode. Without this the first “BRO” of a session waited through a model
  // load, so it looked like the wake word had not been heard.
  let warmRequested = false;
  function warmVoiceEngine() {
    if (warmRequested) return;
    warmRequested = true;
    api('/api/voice/warm', { method: 'POST', body: '{}' }).catch(() => { warmRequested = false; });
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
    warmVoiceEngine();
    beginWatch(mic);
    startHeartbeat();
    scheduleAutoHide();
  }

  // Going to sleep hides the popup right away. The microphone is kept open in
  // wake-word mode, so “BRO” — or Ctrl + Alt + B — pops the window back up.
  async function sleepBro(message = 'Going to sleep. Say “BRO” or press Ctrl + Alt + B to wake me.', { hide = true } = {}) {
    cancelFollowUp();
    cancelAutoHide();
    state.wake = true;
    setLevel(0);
    const hideSoon = () => {
      if (hide) setTimeout(() => { if (state.phase === 'awake') hideWindow(); }, 900);
    };
    if (!state.mic) {
      state.phase = 'idle';
      renderUi();
      setVoiceStatus(message);
      hideSoon();
      await startWakeMode({ quiet: true });
      return;
    }
    state.phase = 'awake';
    renderUi();
    setVoiceStatus(message);
    startHeartbeat();
    resumeWatch();
    hideSoon();
  }

  async function handleWakeClip(clip) {
    state.lastWatchClipAt = Date.now();
    debugVoice(`BRO wake clip ${clip.durationMs}ms peak=${clip.peak} reason=${clip.reason} hidden=${document.hidden}`);
    if (state.phase !== 'awake' || !state.mic) return;
    if (clip.reason === 'cancelled' || clip.durationMs < 150) return;
    // The old gate ignored anything quieter than 0.02 RMS, which is normal
    // speaking volume for a single short word. 0.008 still rejects room noise.
    if (clip.peak < 0.008) return; // room noise, not someone talking
    // Allow one check to overlap while another is in flight, so a repeated
    // “BRO” is not swallowed while the first attempt is still being decoded.
    if (state.wakeActive >= 2) return;
    const now = Date.now();
    if (now - state.lastWakeCheckAt < WAKE_COOLDOWN_MS) return;
    state.lastWakeCheckAt = now;

    const mic = state.mic;
    // The watcher deliberately keeps running during the request. Stopping it
    // first made the microphone deaf for the whole round-trip, which is why
    // saying the name again usually did nothing.
    state.wakeActive += 1;
    try {
      const result = await api('/api/voice/wake', { method: 'POST', body: JSON.stringify({ audio: clip.audio }) });
      if (state.phase !== 'awake' || state.mic !== mic) return;
      if (result.sleep) {
        await sleepBro('Okay, going quiet. Press Ctrl + Alt + B when you want to talk again.');
        return;
      }
      if (result.wake) {
        // Two overlapping checks can both hear the same “BRO”; only the first
        // one starts a command.
        if (Date.now() - state.lastWakeHandledAt < 1200) return;
        state.lastWakeHandledAt = Date.now();
        console.log(`BRO wake word detected in ${result.ms}ms (${String(result.text || '').length} chars)`);
        debugVoice(`BRO wake transcript: ${result.text}`);
        state.retryCapture = false;
        cancelAutoHide();
        showWindow();
        mic.stopWatch(); // one command capture at a time
        if (result.commandText) { await runCommandText(result.commandText); return; }
        setVoiceStatus('Yes — listening…');
        await captureCommand();
        return;
      }
      debugVoice(`BRO ignored wake clip: ${JSON.stringify(result.text || '')} (${result.ms}ms)`);
    } catch (_) {
      // A failed wake check is never fatal; just keep listening.
    } finally {
      state.wakeActive = Math.max(0, state.wakeActive - 1);
    }
    // No wake: the watcher never stopped, so there is nothing to resume.
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
    const clip = await mic.capture({ ...CAPTURE_OPTIONS, preRollMs: 1200, onLevel: setLevel });
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
      // People often need a beat after saying “BRO”. Re-open the listening
      // window once instead of making them call the name a second time.
      if (state.wake && !state.retryCapture) {
        state.retryCapture = true;
        state.phase = 'idle';
        renderUi();
        setVoiceStatus('I’m here — go ahead.');
        await captureCommand();
        state.retryCapture = false;
        return;
      }
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
    // Keep the conversation window open after a miss or an error, so the user
    // can just speak again instead of reaching for the hotkey.
    if (state.wake) startFollowUp();
    else {
      closeMic();
      if (!els.voiceStatus.classList.contains('error')) setVoiceStatus('Press Ctrl + Alt + B once to listen.');
      scheduleAutoHide();
    }
  }

  async function sendCommand(message) {
    if (!message || state.phase === 'working') return;
    // “go to sleep mode” / “sleep” / “disappear” hides the popup immediately,
    // even as the very first command after the wake word.
    if (SLEEP_COMMAND.test(String(message).trim())) {
      console.log('BRO sleep command captured');
      els.transcript.textContent = message;
      await sleepBro('Going to sleep. Say “BRO” or press Ctrl + Alt + B to wake me.');
      return;
    }
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
      renderGuardrails(data.guardrails);
      els.reply.textContent = data.reply || 'Done.';
      if (Array.isArray(data.approvals) && data.approvals.length) {
        setVoiceStatus('Waiting for your approval — say “yes” or “no”.');
      }
      if (Array.isArray(data.actions) && data.actions.length) els.reply.textContent = `${els.reply.textContent} Open the full app to review the pending action.`;
      setConnection(true);
    } catch (error) {
      els.reply.textContent = `BRO could not respond: ${error.message}`;
      setConnection(false);
    } finally {
      state.phase = 'idle';
      renderUi();
      if (state.followUp) {
        // The follow-up loop is already waiting for the next sentence.
        setVoiceStatus('Listening — say your next command (20 s).');
      } else if (state.wake) {
        // Start the 20-second conversation window instead of asking for the
        // wake word again. Works the same after a successful reply or an error.
        startFollowUp();
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
    if (state.phase === 'idle' || state.phase === 'awake') { state.retryCapture = false; captureCommand(); return; }
    if (state.phase === 'listening' && state.mic) state.mic.stopCapture('manual');
  }

  async function checkBackend() {
    try {
      const data = await api('/api/bootstrap');
      setConnection(true);
      state.engine = data.voice || null;
      renderGuardrails(data.guardrails);
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
      state.retryCapture = false;
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
    cancelFollowUp();
    closeMic();
    if (window.broDesktop && typeof window.broDesktop.closeOverlay === 'function') window.broDesktop.closeOverlay();
    else window.close();
  });
  window.addEventListener('beforeunload', () => { state.wake = false; cancelFollowUp(); closeMic(); });

  loadContext();
  state.debug = Boolean(window.broDesktop && window.broDesktop.voiceDebug);
  state.wake = !(window.broDesktop && window.broDesktop.wakeWord === false);
  registerHotkey();
  renderUi();
  checkBackend();
})();
