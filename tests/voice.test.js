const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const mainSource = fs.readFileSync(require.resolve('../desktop/main.js'), 'utf8');
const preloadSource = fs.readFileSync(require.resolve('../desktop/preload.js'), 'utf8');
const overlaySource = fs.readFileSync(require.resolve('../public/overlay.js'), 'utf8');
const appSource = fs.readFileSync(require.resolve('../public/app.js'), 'utf8');
const recorderSource = fs.readFileSync(require.resolve('../public/recorder.js'), 'utf8');
const serverSource = fs.readFileSync(require.resolve('../server.js'), 'utf8');

function loadRecorder() {
  const sandbox = {
    window: {},
    navigator: { mediaDevices: { getUserMedia: () => Promise.reject(new Error('not used')) } },
    btoa: (value) => Buffer.from(value, 'binary').toString('base64'),
    performance: { now: () => Date.now() },
    console,
    Uint8Array,
    Float32Array,
    DataView,
    Math,
    Number,
    Promise,
    String,
  };
  vm.createContext(sandbox);
  vm.runInContext(recorderSource, sandbox, { filename: 'recorder.js' });
  return sandbox.window.BroRecorder;
}

test('BRO records its own microphone audio and transcribes it locally', () => {
  assert.match(overlaySource, /window\.BroRecorder\.open/);
  assert.match(overlaySource, /api\('\/api\/voice\/transcribe'/);
  assert.match(overlaySource, /reason === 'no-speech'/);
  assert.match(appSource, /window\.BroRecorder\.open/);
  assert.match(appSource, /\/api\/voice\/transcribe/);
  assert.match(serverSource, /pathname === '\/api\/voice\/transcribe'/);
  assert.match(serverSource, /voice\.status\(\)/);
});

test('the old external dictation handoff is gone', () => {
  // No clipboard polling, hidden capture field, or synthetic dictation hotkeys.
  assert.doesNotMatch(mainSource, /clipboard/i);
  assert.doesNotMatch(mainSource, /Wispr/i);
  assert.doesNotMatch(mainSource, /keybd_event/i);
  assert.doesNotMatch(overlaySource, /wispr/i);
  assert.doesNotMatch(overlaySource, /clipboard/i);
  assert.doesNotMatch(preloadSource, /onWisprTranscript|startVoiceListening|startNativeListening/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'overlay.html'), 'utf8');
  assert.doesNotMatch(html, /wispr-capture/);
});

test('the recorder produces a mono 16 kHz PCM WAV clip', () => {
  const recorder = loadRecorder();
  const sampleRate = 16000;
  const samples = new Float32Array(sampleRate);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.sin((2 * Math.PI * 440 * index) / sampleRate) * 0.5;

  const encoded = Buffer.from(recorder.encodeWavBase64(samples, sampleRate), 'base64');
  assert.equal(encoded.toString('ascii', 0, 4), 'RIFF');
  assert.equal(encoded.toString('ascii', 8, 12), 'WAVE');
  assert.equal(encoded.readUInt16LE(20), 1, 'PCM format');
  assert.equal(encoded.readUInt16LE(22), 1, 'mono');
  assert.equal(encoded.readUInt32LE(24), sampleRate);
  assert.equal(encoded.readUInt16LE(34), 16, '16-bit samples');
  assert.equal(encoded.readUInt32LE(40), samples.length * 2);
  assert.equal(encoded.length, 44 + samples.length * 2);
  // The tone must survive the 16-bit conversion.
  let peak = 0;
  for (let offset = 44; offset < encoded.length; offset += 2) peak = Math.max(peak, Math.abs(encoded.readInt16LE(offset)));
  assert.ok(peak > 16000, `peak ${peak}`);
});

test('the recorder downsamples device audio to 16 kHz and trims silence', () => {
  const recorder = loadRecorder();
  const input = new Float32Array(48000).fill(0.1);
  const downsampled = recorder.downsample(input, 48000, 16000);
  assert.equal(downsampled.length, 16000);

  const padded = new Float32Array(16000);
  for (let index = 4000; index < 8000; index += 1) padded[index] = 0.2;
  const trimmed = recorder.trimSilence(padded, 16000);
  assert.ok(trimmed.length < padded.length);
  assert.ok(trimmed.length >= 4000);
});

test('the voice engine reports a helpful reason when it is not installed', () => {
  const voicePath = require.resolve('../src/voice');
  const previousHome = process.env.BRO_WHISPER_HOME;
  process.env.BRO_WHISPER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-voice-missing-'));
  delete require.cache[voicePath];
  try {
    const voice = require(voicePath);
    const info = voice.status();
    assert.equal(info.available, false);
    assert.match(info.reason, /setup:voice/);
  } finally {
    if (previousHome === undefined) delete process.env.BRO_WHISPER_HOME;
    else process.env.BRO_WHISPER_HOME = previousHome;
    delete require.cache[voicePath];
  }
});

test('the server rejects a recording that is not a WAV clip', async () => {
  const { server } = require('../server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/voice/transcribe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ audio: Buffer.alloc(200, 7).toString('base64') }),
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /WAV/i);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('the server exposes the voice engine status', async () => {
  const { server } = require('../server');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/voice/status`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.engine, 'whisper.cpp');
    assert.equal(typeof body.available, 'boolean');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Ctrl+Alt+B stays a one-shot global shortcut handled by the popup', () => {
  assert.match(mainSource, /if \(registerElectronHotkey\(\)\) return/);
  assert.match(mainSource, /startWindowsHotkey\(\)/);
  assert.match(mainSource, /RegisterHotKey/);
  assert.match(mainSource, /webContents\.send\('bro-hotkey'\)/);
  assert.match(mainSource, /setPermissionRequestHandler/);
  assert.match(mainSource, /callback\(permission === 'media'\)/);
  assert.match(mainSource, /backgroundThrottling: false/);
  assert.match(overlaySource, /onHotkey/);
  assert.match(overlaySource, /if \(state\.phase !== 'idle'\) return/);
  assert.match(overlaySource, /Done\. Press Ctrl \+ Alt \+ B once for the next command/);
});
