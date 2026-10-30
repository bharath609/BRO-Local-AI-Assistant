(() => {
  'use strict';

  // BRO records its own microphone audio instead of borrowing another app's
  // dictation. Audio is captured as raw PCM, trimmed, and encoded as a mono
  // 16 kHz WAV clip that the local Whisper engine can transcribe.
  //
  // A Microphone can stay open between clips: the wake-word watcher keeps one
  // stream alive and hands each detected utterance to the renderer, while a
  // normal command capture opens the mic only for that command.
  const TARGET_SAMPLE_RATE = 16000;
  const DEFAULT_SILENCE_MS = 900;
  const DEFAULT_NO_SPEECH_MS = 6000;
  const DEFAULT_MAX_MS = 15000;
  const MIN_SPEECH_MS = 300;
  const CALIBRATION_MS = 350;
  const TRIM_PADDING_MS = 160;
  const WATCH_GAP_MS = 80;

  function mergeChunks(chunks, length) {
    const out = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  function downsample(input, fromRate, toRate) {
    if (fromRate === toRate || fromRate <= 0) return input;
    const ratio = fromRate / toRate;
    const length = Math.max(1, Math.floor(input.length / ratio));
    const out = new Float32Array(length);
    for (let index = 0; index < length; index += 1) {
      const start = Math.floor(index * ratio);
      const end = Math.min(Math.floor((index + 1) * ratio), input.length);
      let sum = 0;
      for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor];
      out[index] = end > start ? sum / (end - start) : 0;
    }
    return out;
  }

  function trimSilence(samples, sampleRate) {
    const threshold = 0.004;
    const windowSize = Math.max(1, Math.floor(sampleRate * 0.02));
    let first = -1;
    let last = -1;
    for (let start = 0; start < samples.length; start += windowSize) {
      const end = Math.min(start + windowSize, samples.length);
      let sum = 0;
      for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
      const rms = Math.sqrt(sum / Math.max(1, end - start));
      if (rms >= threshold) {
        if (first === -1) first = start;
        last = end;
      }
    }
    if (first === -1) return samples;
    const padding = Math.floor((TRIM_PADDING_MS / 1000) * sampleRate);
    return samples.slice(Math.max(0, first - padding), Math.min(samples.length, last + padding));
  }

  function encodeWavBase64(samples, sampleRate) {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const writeText = (offset, value) => {
      for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
    };
    writeText(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeText(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    let offset = 44;
    for (let index = 0; index < samples.length; index += 1) {
      const clamped = Math.max(-1, Math.min(1, samples[index]));
      view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
      offset += 2;
    }
    let binary = '';
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  class Microphone {
    constructor(options = {}) {
      this.defaultOptions = options;
      this.stream = null;
      this.context = null;
      this.source = null;
      this.node = null;
      this.processor = null;
      this.sink = null;
      this.sampleRate = TARGET_SAMPLE_RATE;
      this.clip = null;
      this.watch = null;
      this.closed = true;
    }

    async open() {
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw new Error('Microphone capture is not available in this window.');
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) throw new Error('Audio processing is not available in this window.');
      try {
        this.context = new AudioContextClass({ sampleRate: TARGET_SAMPLE_RATE });
      } catch (_) {
        this.context = new AudioContextClass();
      }
      if (this.context.state === 'suspended') {
        try { await this.context.resume(); } catch (_) { /* the meter stays flat if the OS blocks it */ }
      }
      this.sampleRate = this.context.sampleRate || TARGET_SAMPLE_RATE;
      this.source = this.context.createMediaStreamSource(this.stream);
      // Chromium only runs capture nodes while they are connected to the graph.
      // The sink gain is zero so nothing is played back through the speakers.
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.sink.connect(this.context.destination);
      this.closed = false;
      let worklet = false;
      if (this.context.audioWorklet && typeof window.AudioWorkletNode === 'function') {
        try {
          await this.context.audioWorklet.addModule('/voice-worklet.js');
          this.node = new window.AudioWorkletNode(this.context, 'bro-capture');
          this.node.port.onmessage = (event) => this.handleSamples(event.data);
          this.source.connect(this.node);
          this.node.connect(this.sink);
          worklet = true;
        } catch (error) {
          console.warn(`BRO voice: audio worklet unavailable (${error.message}); using the compatibility capture path.`);
        }
      }
      if (!worklet) {
        this.processor = this.context.createScriptProcessor(4096, 1, 1);
        this.processor.onaudioprocess = (event) => this.handleSamples(event.inputBuffer.getChannelData(0));
        this.source.connect(this.processor);
        this.processor.connect(this.sink);
      }
      return this;
    }

    startClip(options = {}) {
      const settings = { ...this.defaultOptions, ...options };
      const now = performance.now();
      return new Promise((resolve) => {
        this.clip = {
          settings,
          resolve,
          chunks: [],
          samples: 0,
          startedAt: now,
          lastSpeechAt: now,
          speechMs: 0,
          heardSpeech: false,
          calibrating: true,
          noiseFloor: 0.004,
          peak: 0,
          active: true,
        };
      });
    }

    handleSamples(data) {
      if (!data || !data.length) return;
      const clip = this.clip;
      if (!clip || !clip.active) return;
      const copy = new Float32Array(data.length);
      copy.set(data);
      clip.chunks.push(copy);
      clip.samples += copy.length;

      let sum = 0;
      for (let index = 0; index < data.length; index += 1) sum += data[index] * data[index];
      const rms = Math.sqrt(sum / Math.max(1, data.length));
      const now = performance.now();
      const frameMs = (copy.length / this.sampleRate) * 1000;
      const onLevel = clip.settings.onLevel;
      if (typeof onLevel === 'function') {
        try { onLevel(Math.min(1, rms * 14), rms); } catch (_) { /* UI callbacks must not break capture */ }
      }

      // The first moments of a capture measure the room instead of the user.
      if (clip.calibrating) {
        clip.noiseFloor = Math.min(0.03, Math.max(clip.noiseFloor, rms));
        if (now - clip.startedAt >= CALIBRATION_MS) {
          clip.calibrating = false;
          clip.lastSpeechAt = now;
          clip.noiseFloor = Math.max(clip.noiseFloor, 0.004);
        }
        return;
      }

      clip.peak = Math.max(clip.peak, rms);
      if (rms < clip.noiseFloor * 3) clip.noiseFloor = clip.noiseFloor * 0.94 + rms * 0.06;
      const threshold = Math.max(0.008, clip.noiseFloor * 2.2);
      if (rms >= threshold) {
        clip.lastSpeechAt = now;
        clip.speechMs += frameMs;
        if (clip.speechMs >= MIN_SPEECH_MS) clip.heardSpeech = true;
      }
      if (clip.heardSpeech && now - clip.lastSpeechAt >= clip.settings.silenceMs) {
        this.finishClip('silence');
        return;
      }
      if (!clip.heardSpeech && now - clip.startedAt >= clip.settings.noSpeechMs) {
        this.finishClip('no-speech');
        return;
      }
      if (now - clip.startedAt >= clip.settings.maxMs) this.finishClip('max-length');
    }

    finishClip(reason) {
      const clip = this.clip;
      if (!clip) return;
      clip.active = false;
      this.clip = null;
      const captured = mergeChunks(clip.chunks, clip.samples);
      const resampled = trimSilence(downsample(captured, this.sampleRate, TARGET_SAMPLE_RATE), TARGET_SAMPLE_RATE);
      clip.resolve({
        audio: encodeWavBase64(resampled, TARGET_SAMPLE_RATE),
        sampleRate: TARGET_SAMPLE_RATE,
        durationMs: Math.round((resampled.length / TARGET_SAMPLE_RATE) * 1000),
        reason,
        peak: Number(clip.peak.toFixed(4)),
      });
      if (this.watch) this.scheduleNextWatchClip();
    }

    scheduleNextWatchClip() {
      const watch = this.watch;
      if (!watch || this.closed) return;
      clearTimeout(watch.timer);
      watch.timer = setTimeout(() => {
        if (!this.watch || this.closed || this.clip) return;
        this.startClip(watch.options).then((clip) => {
          if (!this.watch || clip.reason === 'cancelled') return;
          try { this.watch.onClip(clip); } catch (error) { console.warn(`BRO voice: wake clip handler failed (${error.message})`); }
        });
      }, watch.gapMs);
    }

    capture(options = {}) {
      if (this.clip) this.finishClip('cancelled');
      return this.startClip(options);
    }

    stopCapture(reason = 'manual') {
      if (this.clip) this.finishClip(reason);
    }

    // Chromium can suspend an AudioContext (for example after the window was
    // hidden). Wake mode calls this to make sure the graph keeps running.
    ensureRunning() {
      if (!this.context || this.closed) return false;
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
      return true;
    }

    startWatch({ onClip, gapMs = WATCH_GAP_MS, ...options } = {}) {
      this.stopWatch();
      this.watch = { onClip, options, gapMs, timer: null };
      if (this.clip) this.finishClip('cancelled');
      this.scheduleNextWatchClip();
    }

    stopWatch() {
      if (!this.watch) return;
      clearTimeout(this.watch.timer);
      this.watch = null;
    }

    close() {
      this.stopWatch();
      if (this.clip) {
        const clip = this.clip;
        this.clip = null;
        clip.active = false;
        clip.resolve({ audio: '', sampleRate: TARGET_SAMPLE_RATE, durationMs: 0, reason: 'cancelled', peak: 0 });
      }
      try { if (this.processor) this.processor.onaudioprocess = null; } catch (_) { /* ignore */ }
      try { if (this.node) this.node.port.onmessage = null; } catch (_) { /* ignore */ }
      try { if (this.source) this.source.disconnect(); } catch (_) { /* ignore */ }
      try { if (this.node) this.node.disconnect(); } catch (_) { /* ignore */ }
      try { if (this.processor) this.processor.disconnect(); } catch (_) { /* ignore */ }
      try { if (this.sink) this.sink.disconnect(); } catch (_) { /* ignore */ }
      if (this.stream) {
        for (const track of this.stream.getTracks()) {
          try { track.stop(); } catch (_) { /* ignore */ }
        }
      }
      if (this.context && this.context.state !== 'closed') this.context.close().catch(() => {});
      this.closed = true;
      this.stream = null;
      this.context = null;
      this.source = null;
      this.node = null;
      this.processor = null;
      this.sink = null;
    }
  }

  async function open(options) {
    const microphone = new Microphone(options);
    await microphone.open();
    return microphone;
  }

  window.BroRecorder = {
    open,
    Microphone,
    isSupported: Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && (window.AudioContext || window.webkitAudioContext)),
    targetSampleRate: TARGET_SAMPLE_RATE,
    // Exposed for the unit tests that verify the WAV layout and resampling.
    encodeWavBase64,
    downsample,
    trimSilence,
  };
})();
