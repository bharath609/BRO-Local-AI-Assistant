const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

// BRO owns its microphone pipeline. Recorded clips are transcribed by a local
// whisper.cpp build that ships under vendor/whisper (see scripts/setup-voice.js),
// so voice commands never depend on a separate dictation app, clipboard polling,
// or window focus.
//
// Two warm servers are used when available:
//   - the command model (base.en by default) for accurate commands
//   - a small wake model (tiny.en) so “BRO” is recognised in well under a second

const ROOT = path.resolve(__dirname, '..');
const WHISPER_HOME = process.env.BRO_WHISPER_HOME || path.join(ROOT, 'vendor', 'whisper');
const BIN_DIR = process.env.BRO_WHISPER_BIN_DIR || path.join(WHISPER_HOME, 'Release');
const SERVER_BIN = path.join(BIN_DIR, 'whisper-server.exe');
const CLI_BIN = path.join(BIN_DIR, 'whisper-cli.exe');
const MODEL_PATH = process.env.BRO_WHISPER_MODEL || path.join(WHISPER_HOME, 'models', 'ggml-base.en.bin');
const TINY_MODEL_PATH = path.join(WHISPER_HOME, 'models', 'ggml-tiny.en.bin');
const WAKE_MODEL_PATH = process.env.BRO_WHISPER_WAKE_MODEL
  || (fs.existsSync(TINY_MODEL_PATH) ? TINY_MODEL_PATH : MODEL_PATH);
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.BRO_WHISPER_TIMEOUT_MS) || 45_000;
const SERVER_START_TIMEOUT_MS = 30_000;
const THREADS = Math.max(2, Math.min(8, os.cpus().length - 1));
const PROMPT = process.env.BRO_WHISPER_PROMPT
  || 'BRO voice commands: open Telegram, open WhatsApp, open Chrome, open Discord, open Slack, open Spotify, open Zoom, open VS Code, open Steam, open YouTube, open ChatGPT, open Gmail, open Google Drive, open Downloads, open Calculator, open Notepad, open Task Manager, close Telegram, close Chrome, activate BRO, list projects, search for local AI assistants, run test in my app.';
// Deliberately empty: prompting the tiny model with “BRO” makes it hallucinate
// that phrase over room noise. Text matching does the work instead.
const WAKE_PROMPT = process.env.BRO_WHISPER_WAKE_PROMPT || '';

const servers = new Map();
let shuttingDown = false;

function platformSupported() {
  return process.platform === 'win32';
}

function binaryPresent(binary) {
  try { return fs.existsSync(binary); } catch { return false; }
}

function status() {
  const hasServer = binaryPresent(SERVER_BIN);
  const hasCli = binaryPresent(CLI_BIN);
  const hasModel = binaryPresent(MODEL_PATH);
  const remote = Boolean(process.env.BRO_WHISPER_URL);
  const available = remote || (platformSupported() && hasModel && (hasServer || hasCli));
  let reason = '';
  if (!available && !platformSupported()) reason = 'Local voice transcription is only available on Windows.';
  else if (!available && !hasModel) reason = 'The Whisper model is missing. Run “npm run setup:voice”.';
  else if (!available && !hasServer && !hasCli) reason = 'The Whisper engine is missing. Run “npm run setup:voice”.';
  return {
    available,
    engine: 'whisper.cpp',
    model: hasModel ? path.basename(MODEL_PATH) : '',
    wakeModel: binaryPresent(WAKE_MODEL_PATH) ? path.basename(WAKE_MODEL_PATH) : '',
    binary: remote ? 'remote' : (hasServer ? 'whisper-server' : (hasCli ? 'whisper-cli' : '')),
    warm: servers.size > 0,
    reason,
  };
}

function requestJson(options, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.request(options, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(`Whisper server responded with ${response.statusCode}.`));
          return;
        }
        resolve(text);
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Whisper request timed out.')));
    request.on('error', reject);
    if (body) request.end(body);
    else request.end();
  });
}

function freePort(start = 4791) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(freePort(start + 1)));
    probe.listen(start, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolve(address && typeof address === 'object' ? address.port : start));
    });
  });
}

async function waitForServer(record, port, timeoutMs = SERVER_START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await requestJson({ host: '127.0.0.1', port, path: '/', method: 'GET' }, null, 1_500);
      return true;
    } catch (_) {
      if (!record.child) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

function ensureServer(modelPath) {
  if (shuttingDown || !platformSupported()) return Promise.resolve(null);
  if (!binaryPresent(SERVER_BIN) || !binaryPresent(modelPath)) return Promise.resolve(null);
  const existing = servers.get(modelPath);
  if (existing) return existing.promise;
  if (process.env.BRO_WHISPER_URL) {
    const url = new URL(process.env.BRO_WHISPER_URL);
    return Promise.resolve({ port: Number(url.port) || 80 });
  }

  const record = { child: null, port: 0, promise: null };
  record.promise = (async () => {
    const port = await freePort(Number(process.env.BRO_WHISPER_PORT) || 4791);
    const wakeServer = modelPath === WAKE_MODEL_PATH && WAKE_MODEL_PATH !== MODEL_PATH;
    const args = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', String(port),
      '-t', String(THREADS),
      '-bo', '1',
      '-bs', '1',
      '-nt',
    ];
    if (wakeServer) {
      // Short, greedy decode with no prompt and no temperature fallback keeps
      // the wake check fast and stops it inventing wake phrases from noise.
      args.push('-nf', '-sns', '-nth', '0.4');
      if (WAKE_PROMPT) args.push('--prompt', WAKE_PROMPT);
    } else {
      args.push('-bo', '2', '-bs', '2', '--prompt', PROMPT);
    }
    const child = spawn(SERVER_BIN, args, {
      cwd: BIN_DIR,
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
    });
    record.child = child;
    record.port = port;
    child.once('error', () => { if (servers.get(modelPath) === record) servers.delete(modelPath); });
    child.once('close', () => { if (servers.get(modelPath) === record) servers.delete(modelPath); });
    const ready = await waitForServer(record, port);
    if (!ready) {
      try { child.kill(); } catch (_) { /* already gone */ }
      servers.delete(modelPath);
      return null;
    }
    console.log(`BRO voice: Whisper warm on 127.0.0.1:${port} (${path.basename(modelPath)})`);
    return { port };
  })();
  servers.set(modelPath, record);
  return record.promise;
}

function multipartBody(fields, file) {
  const boundary = `----bro${Math.random().toString(16).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), boundary };
}

const NOISE_ARTIFACTS = new Set(['you', 'thank you', 'thanks', 'bye', 'okay', 'bye bye', 'the', 'a', 'i', 'hmm', 'uh', 'um']);

function cleanTranscript(value) {
  let text = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\[(?:blank_audio|silence|music|inaudible|noise|static|applause|laughter)\]/gi, ' ')
    .replace(/\((?:silence|music|inaudible|static)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '').trim();
  if (NOISE_ARTIFACTS.has(text.toLowerCase().replace(/[.!?,]+$/, ''))) return '';
  return text;
}

async function requestServer(modelPath, fields, wavBuffer) {
  const server = await ensureServer(modelPath);
  if (!server || !server.port) throw new Error('Whisper engine is not ready.');
  const { body, boundary } = multipartBody(fields, { name: 'command.wav', type: 'audio/wav', data: wavBuffer });
  const raw = await requestJson({
    host: '127.0.0.1',
    port: server.port,
    path: '/inference',
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length },
  }, body, TRANSCRIBE_TIMEOUT_MS);
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
  return parsed || { text: raw };
}

async function transcribeWithServer(wavBuffer) {
  const parsed = await requestServer(MODEL_PATH, {
    response_format: 'verbose_json',
    temperature: '0.0',
    language: 'en',
    prompt: PROMPT,
  }, wavBuffer);
  const segments = Array.isArray(parsed.segments) ? parsed.segments : null;
  if (!segments) return cleanTranscript(parsed.text);
  // Whisper invents short phrases over silence. Segments that the model itself
  // marks as unlikely speech, or that decoded with very low confidence, are
  // discarded before the text reaches the command parser.
  const kept = segments.filter((segment) => {
    const noSpeech = Number(segment.no_speech_prob);
    const logprob = Number(segment.avg_logprob);
    if (Number.isFinite(noSpeech) && noSpeech > 0.55) return false;
    if (Number.isFinite(logprob) && logprob < -1.1) return false;
    return true;
  });
  return cleanTranscript(kept.map((segment) => segment.text || '').join(' '));
}

function transcribeWithCli(wavBuffer) {
  return new Promise((resolve, reject) => {
    if (!binaryPresent(CLI_BIN)) {
      reject(new Error('The Whisper engine is not installed.'));
      return;
    }
    const file = path.join(os.tmpdir(), `bro-voice-${process.pid}-${Date.now()}.wav`);
    fs.writeFileSync(file, wavBuffer);
    const args = ['-m', MODEL_PATH, '-f', file, '-nt', '-np', '-t', String(THREADS), '-bo', '2', '-bs', '2', '--prompt', PROMPT];
    const child = spawn(CLI_BIN, args, { cwd: BIN_DIR, windowsHide: true, shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } }, TRANSCRIBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => { clearTimeout(timer); fs.rm(file, { force: true }, () => {}); reject(error); });
    child.once('close', (code) => {
      clearTimeout(timer);
      fs.rm(file, { force: true }, () => {});
      if (code !== 0) {
        reject(new Error(stderr.trim() || 'Whisper could not transcribe the recording.'));
        return;
      }
      const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^(whisper_|load|main:|system_info|ggml_|register_)/.test(line));
      resolve(cleanTranscript(lines.join(' ')));
    });
  });
}

function parseWav(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44) return null;
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return null;
  return {
    bytes: buffer.length,
    sampleRate: buffer.readUInt32LE(24),
    channels: buffer.readUInt16LE(22),
    bitsPerSample: buffer.readUInt16LE(34),
  };
}

function validateWav(buffer) {
  const info = parseWav(buffer);
  if (!info) throw Object.assign(new Error('The recording was not a valid WAV clip.'), { statusCode: 400 });
  if (info.bitsPerSample !== 16 || info.channels !== 1) throw Object.assign(new Error('The recording must be mono 16-bit PCM.'), { statusCode: 400 });
  return info;
}

async function transcribe(wavBuffer) {
  const startedAt = Date.now();
  const info = validateWav(wavBuffer);

  let text = '';
  let engine = 'whisper-cli';
  let lastError = null;
  try {
    text = await transcribeWithServer(wavBuffer);
    engine = 'whisper-server';
  } catch (error) {
    lastError = error;
    try {
      text = await transcribeWithCli(wavBuffer);
    } catch (cliError) {
      lastError = cliError;
    }
  }
  if (!text && lastError && /not installed|not ready|not available|ENOENT/i.test(lastError.message || '')) {
    throw Object.assign(new Error(lastError.message), { statusCode: 503 });
  }
  return {
    text,
    empty: !text,
    engine,
    ms: Date.now() - startedAt,
    audioDurationMs: Math.max(0, Math.round(((info.bytes - 44) / (info.sampleRate * 2)) * 1000)),
  };
}

const WAKE_PHRASES = [
  'hey there bro', 'wake up brother', 'wake up bro', 'hello brother', 'hey brother',
  'listen brother', 'listen bro', 'bro listen', 'hey bro', 'hi bro', 'hello bro', 'ok bro', 'okay bro',
  'yo bro', 'bro command', 'brother', 'bro',
  // The tiny model sometimes spells the same sound differently; these are the
  // variants observed from room audio, not extra commands.
  'bros', 'broh', 'brah', 'brow',
];
const SLEEP_PHRASES = new Set(['stop listening', 'sleep', 'go to sleep', 'go quiet', 'goodbye', 'good bye', 'bye', 'bye bro', 'shut up', 'thats all', 'that is all']);

function normalizeSpoken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[.,!?;:()[\]"“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeCommand(value) {
  const text = String(value || '').trim();
  if (!text) return false;
  return /^(?:(?:please|bro|could you|can you|would you)\s+)?(?:open|launch|start|visit|go to|close|quit|exit|shut|kill|search|find|google|check|list|show|run|execute|activate|wake up|stop listening|sleep|help|status|what can you do|play|send)\b/i.test(text);
}

function matchWake(value) {
  const text = normalizeSpoken(value);
  if (!text) return { wake: false, sleep: false, remainder: '', commandText: '' };
  if (SLEEP_PHRASES.has(text)) return { wake: false, sleep: true, remainder: '', commandText: '' };
  for (const phrase of WAKE_PHRASES) {
    if (text === phrase) return { wake: true, sleep: false, remainder: '', commandText: '' };
    if (text.startsWith(`${phrase} `)) {
      const remainder = text.slice(phrase.length + 1).trim();
      return { wake: true, sleep: false, remainder, commandText: looksLikeCommand(remainder) ? remainder : '' };
    }
  }
  return { wake: false, sleep: false, remainder: '', commandText: '' };
}

async function detectWake(wavBuffer) {
  const startedAt = Date.now();
  const info = validateWav(wavBuffer);
  const audioDurationMs = Math.max(0, Math.round(((info.bytes - 44) / (info.sampleRate * 2)) * 1000));
  if (audioDurationMs < 200) return { text: '', wake: false, sleep: false, remainder: '', commandText: '', ms: 0, audioDurationMs };
  let parsed;
  const wakeFields = { response_format: 'json', temperature: '0.0', language: 'en' };
  if (WAKE_PROMPT) wakeFields.prompt = WAKE_PROMPT;
  try {
    parsed = await requestServer(WAKE_MODEL_PATH, wakeFields, wavBuffer);
  } catch (error) {
    // Fall back to the command model if the wake model is unavailable.
    parsed = await requestServer(MODEL_PATH, wakeFields, wavBuffer);
  }
  // Whisper’s no_speech_prob is unreliable for one-word clips (a clear “BRO”
  // can score 0.85), so the wake decision is made purely from the transcript.
  const text = cleanTranscript(parsed && typeof parsed.text === 'string' ? parsed.text : '');
  const first = matchWake(text);
  if (first.wake || first.sleep) return { text, ...first, ms: Date.now() - startedAt, audioDurationMs, confirmed: false };

  // Near miss: a short utterance that did not look like a wake phrase. The tiny
  // model mangles single words (“BRO” can come back as “Brit”), so a short clip
  // is re-checked with the accurate command model before deciding.
  const words = text ? text.split(/\s+/).filter(Boolean) : [];
  if (text && words.length <= 3 && audioDurationMs <= 3500 && WAKE_MODEL_PATH !== MODEL_PATH) {
    try {
      const second = await requestServer(MODEL_PATH, { response_format: 'json', temperature: '0.0', language: 'en', prompt: PROMPT }, wavBuffer);
      const altText = cleanTranscript(second && typeof second.text === 'string' ? second.text : '');
      const altMatch = matchWake(altText);
      if (altMatch.wake || altMatch.sleep) return { text: altText, ...altMatch, ms: Date.now() - startedAt, audioDurationMs, confirmed: true };
      return { text, altText, ...first, ms: Date.now() - startedAt, audioDurationMs, confirmed: false };
    } catch (_) {
      // Fall through with the first result.
    }
  }
  return { text, ...first, ms: Date.now() - startedAt, audioDurationMs, confirmed: false };
}

function shutdown() {
  shuttingDown = true;
  for (const record of servers.values()) {
    if (record.child) {
      try { record.child.kill(); } catch (_) { /* already gone */ }
    }
  }
  servers.clear();
}

module.exports = {
  status,
  transcribe,
  detectWake,
  matchWake,
  looksLikeCommand,
  shutdown,
  MODEL_PATH,
  WAKE_MODEL_PATH,
  BIN_DIR,
};
