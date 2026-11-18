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
// Prefer a larger English model when one has been downloaded, then base.en,
// then tiny.en. BRO_WHISPER_MODEL still overrides everything.
const MODEL_DIR = path.join(WHISPER_HOME, 'models');
const MODEL_CANDIDATES = ['ggml-small.en.bin', 'ggml-base.en.bin', 'ggml-tiny.en.bin']
  .map((name) => path.join(MODEL_DIR, name));
const MODEL_PATH = process.env.BRO_WHISPER_MODEL
  || MODEL_CANDIDATES.find((candidate) => { try { return fs.existsSync(candidate); } catch { return false; } })
  || MODEL_CANDIDATES[1];
const TINY_MODEL_PATH = path.join(WHISPER_HOME, 'models', 'ggml-tiny.en.bin');
const WAKE_MODEL_PATH = process.env.BRO_WHISPER_WAKE_MODEL
  || (fs.existsSync(TINY_MODEL_PATH) ? TINY_MODEL_PATH : MODEL_PATH);
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.BRO_WHISPER_TIMEOUT_MS) || 45_000;
const SERVER_START_TIMEOUT_MS = 30_000;
// A wake check has to answer while the user is still holding the word in their
// head. If a check is slow, the watcher must not stay deaf, so both checks are
// capped well below the command timeout.
const WAKE_TIMEOUT_MS = Number(process.env.BRO_WHISPER_WAKE_TIMEOUT_MS) || 8_000;
const WAKE_SECOND_OPINION_TIMEOUT_MS = 3_000;
// Beam search 5 is noticeably more accurate than greedy decoding for short
// commands; BRO_WHISPER_BEAM=2 trades some accuracy for speed.
const BEAM_SIZE = Math.max(1, Math.min(8, Number(process.env.BRO_WHISPER_BEAM) || 5));
const THREADS = Math.max(2, Math.min(8, os.cpus().length - 1));
const PROMPT = process.env.BRO_WHISPER_PROMPT
  || 'BRO voice commands: open Telegram, open WhatsApp, open Chrome, open YouTube, open Settings, open Downloads, open Calculator, open start menu, open control panel, open device manager, open task manager, refresh, refresh the desktop, play, pause, stop, resume, forward, backward, rewind, next video, previous video, scroll down, scroll up, scroll to the top, scroll to the bottom, page down, page up, volume up, volume down, mute, unmute, fullscreen, take a screenshot, maximize, minimize, restore, close this window, search my Gmail for invoices, type hello world, click first result, create a folder called Reports, lock the pc, shut down the pc, go to sleep.';
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
      args.push('-bo', String(BEAM_SIZE), '-bs', String(BEAM_SIZE), '--prompt', PROMPT);
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

// Common Whisper spellings of BRO command words. This only rewrites whole
// words, so phrases such as “forward” still reach the command parser intact
// even when the recogniser wrote “maximise” or “vedio”.
function repairTranscript(text) {
  return text
    .replace(/\bmaximi[sz]e\b/gi, 'maximize')
    .replace(/\bmaximi[sz]ed\b/gi, 'maximized')
    .replace(/\bminimi[sz]e\b/gi, 'minimize')
    .replace(/\bminimi[sz]ed\b/gi, 'minimized')
    .replace(/\b(?:vedio|vidio|videio|vidoe|videos?)\b/g, (word) => (/s$/i.test(word) ? 'videos' : 'video'))
    .replace(/\bwhats\s*app\b/gi, 'WhatsApp')
    .replace(/\bwhat'?s\s+app\b/gi, 'WhatsApp')
    .replace(/\byou\s*tube\b/gi, 'YouTube')
    .replace(/\bg\s*mail\b/gi, 'Gmail')
    .replace(/\b(?:note\s*pad|not\s*pad|nodepad)\b/gi, 'notepad')
    .replace(/\b(?:calender|calandar)\b/gi, 'calendar')
    .replace(/\b(?:calculater|calcullator)\b/gi, 'calculator')
    .replace(/\b(?:power\s*point|powerpoint)\b/gi, 'PowerPoint')
    .replace(/\bone\s*note\b/gi, 'OneNote')
    .replace(/\bone\s*drive\b/gi, 'OneDrive')
    .replace(/\bv\s*s\s*code\b/gi, 'VS Code')
    .replace(/\b(?:file\s*explorer|file\s*manager)\b/gi, 'File Explorer')
    .replace(/\btask\s+mang?er\b/gi, 'Task Manager')
    .replace(/\bcontrol\s+pann?el\b/gi, 'Control Panel')
    .replace(/\bdevice\s+mang?er\b/gi, 'Device Manager')
    .replace(/\b(?:screen\s*shot|screens\s*shot|screen\s*short)\b/gi, 'screenshot')
    .replace(/\bscroll\s+tow?n\b/gi, 'scroll down')
    .replace(/\bun\s*mute\b/gi, 'unmute')
    .replace(/\b(?:paws|pause)\b/gi, 'pause');
}

// “Um, open settings” should be treated as “open settings”; Whisper sometimes
// also keeps a leading “okay” or “and” from the end of the wake word.
function stripLeadingFiller(text) {
  let out = String(text || '');
  for (let guard = 0; guard < 5; guard += 1) {
    const next = out.replace(/^(?:um+|uh+|hmm+|erm+|ah+|oh+|hey|okay|ok|so|and|like)[,\s]+/i, '').trim();
    if (next === out) break;
    out = next;
  }
  return out;
}

// A pre-rolled command clip can start with the wake word itself.
function stripLeadingWakeWord(text) {
  return String(text || '').replace(/^(?:(?:hey|okay|ok)\s+)?(?:there\s+)?(?:bro|bros|broh|brah|brow)[,\s]+/i, '').trim();
}

function cleanTranscript(value) {
  let text = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\[(?:blank_audio|silence|music|inaudible|noise|static|applause|laughter)\]/gi, ' ')
    .replace(/\((?:silence|music|inaudible|static)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  text = text.replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '').trim();
  if (NOISE_ARTIFACTS.has(text.toLowerCase().replace(/[.!?,]+$/, ''))) return '';
  return repairTranscript(text);
}

// Command-only cleanup: wake phrases such as “hey there bro” must survive
// cleanTranscript untouched, so filler and wake-word removal happens after a
// clip has already been identified as a command.
function cleanCommandTranscript(value) {
  const cleaned = stripLeadingWakeWord(stripLeadingFiller(cleanTranscript(value)));
  if (NOISE_ARTIFACTS.has(cleaned.toLowerCase().replace(/[.!?,]+$/, ''))) return '';
  return cleaned;
}

async function requestServer(modelPath, fields, wavBuffer, timeoutMs = TRANSCRIBE_TIMEOUT_MS) {
  const server = await ensureServer(modelPath);
  if (!server || !server.port) throw new Error('Whisper engine is not ready.');
  const { body, boundary } = multipartBody(fields, { name: 'command.wav', type: 'audio/wav', data: wavBuffer });
  const raw = await requestJson({
    host: '127.0.0.1',
    port: server.port,
    path: '/inference',
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, 'content-length': body.length },
  }, body, timeoutMs);
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
    const args = ['-m', MODEL_PATH, '-f', file, '-nt', '-np', '-t', String(THREADS), '-bo', String(BEAM_SIZE), '-bs', String(BEAM_SIZE), '--prompt', PROMPT];
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
    text: cleanCommandTranscript(text),
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
  'bros', 'broh', 'brah', 'brow', 'bruh', 'broo', 'brooo', 'bra', 'breh',
];

// Ordinary English words that start with “br” and would otherwise be mistaken
// for the wake word. Rejecting them keeps the looser matching below from
// waking BRO up in the middle of a normal sentence.
const WAKE_STOPWORDS = new Set([
  'brown', 'browne', 'brother', 'brothers', 'brought', 'broke', 'broken', 'browser',
  'browse', 'broad', 'bread', 'break', 'breakfast', 'brunch', 'bronze', 'broker',
  'brook', 'broom', 'bring', 'brings', 'brick', 'bridge', 'bright', 'brilliant',
  'brush', 'brave', 'brand', 'branch', 'breath', 'breathe', 'bruise', 'breeze',
  'brief', 'briefly', 'brutal', 'bribe', 'britain', 'british',
]);
// Sleep is matched by shape rather than a fixed list, so “go to sleep mode”,
// “sleep mode”, “go sleep”, “sleeping”, and small mis-hearings all work without
// the user having to repeat themselves.
const SLEEP_PATTERN = /^(?:go\s+(?:to\s+)?(?:the\s+)?sleep(?:\s+mode)?|go\s+to\s+bed|sleep(?:\s+mode)?|sleeping|stop\s+listening|stop\s+the\s+listening|go\s+quiet|go\s+away|disappear|hide(?:\s+yourself)?|good\s?bye|bye(?:\s+bro)?|shut\s+up|that(?:s|\s+is)\s+all)$/;
const SLEEP_PHRASES = new Set(['stop listening', 'sleep', 'go to sleep', 'go to sleep mode', 'go quiet', 'goodbye', 'good bye', 'bye', 'bye bro', 'shut up', 'thats all', 'that is all', 'sleep mode', 'sleeping']);

function normalizeSpoken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[.,!?;:()[\]"“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSleepPhrase(value) {
  const text = normalizeSpoken(value);
  return Boolean(text) && SLEEP_PATTERN.test(text);
}

// Anything meaningful said after the wake word is a command now. The old list
// of verbs dropped bare app names (“BRO, chrome”), local clock questions
// (“BRO, what time is it”), and any phrasing not on the list, so BRO answered
// “Yes — listening…” and made the user repeat the whole sentence. Only pure
// filler is rejected.
const FILLER_WORDS = new Set(['you', 'thank', 'thanks', 'bye', 'okay', 'ok', 'the', 'a', 'i', 'hmm', 'uh', 'um', 'er', 'erm', 'ah', 'oh', 'so', 'and']);

function looksLikeCommand(value) {
  const text = normalizeSpoken(stripLeadingFiller(value));
  if (!text) return false;
  const words = text.split(' ').filter(Boolean);
  if (!words.length || words.length > 12) return false;
  return !words.every((word) => FILLER_WORDS.has(word));
}

function matchWake(value) {
  // “Um, BRO”, “okay bro”, “hey, BRO” — filler at the start of the clip must not
  // hide the wake word. Without this, a perfectly clear “BRO” that the tiny
  // model wrote as “Okay bro.” was silently ignored.
  const text = normalizeSpoken(stripLeadingFiller(value));
  if (!text) return { wake: false, sleep: false, remainder: '', commandText: '' };
  if (SLEEP_PHRASES.has(text) || isSleepPhrase(text)) return { wake: false, sleep: true, remainder: '', commandText: '' };
  for (const phrase of WAKE_PHRASES) {
    if (text === phrase) return { wake: true, sleep: false, remainder: '', commandText: '' };
    if (text.startsWith(`${phrase} `)) {
      const remainder = text.slice(phrase.length + 1).trim();
      return { wake: true, sleep: false, remainder, commandText: looksLikeCommand(remainder) ? remainder : '' };
    }
  }
  // The tiny wake model spells “BRO” in many ways (bra, brah, broo, bruh, bros).
  // Accept those shapes so the name never has to be said twice, while still
  // rejecting ordinary words such as “brown” or “brotherhood”.
  const [first, ...rest] = text.split(' ');
  if (!WAKE_STOPWORDS.has(first) && /^br[uoahe]{1,4}[whsd]?$/.test(first)) {
    const remainder = rest.join(' ').trim();
    return { wake: true, sleep: false, remainder, commandText: looksLikeCommand(remainder) ? remainder : '' };
  }
  return { wake: false, sleep: false, remainder: '', commandText: '' };
}

// Does this transcript look like the tiny model mis-hearing “BRO”? Used to
// decide whether one slow second opinion from the accurate model is worth it.
// It is deliberately narrow: re-checking every short clip made the watcher deaf
// for an extra second or two after ordinary speech.
function looksLikeWakeGarble(value) {
  const words = normalizeSpoken(value).split(' ').filter(Boolean);
  if (!words.length || words.length > 2) return false;
  return words.some((word) => {
    if (WAKE_STOPWORDS.has(word)) return false;
    if (/^br[uoahe]/.test(word) && word.length <= 6) return true;
    return editDistanceAtMost(word, 'bro', 1);
  });
}

function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  const cols = b.length + 1;
  let previous = new Array(cols);
  let current = new Array(cols);
  for (let j = 0; j < cols; j += 1) previous[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    let rowBest = current[0];
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < rowBest) rowBest = current[j];
    }
    if (rowBest > max) return false;
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[b.length] <= max;
}

// The tiny wake model handles the short commands people actually say
// (“open notepad”, “what time is it”, “search youtube for lofi beats”) as well
// as the accurate model does, and it answers in under a second. Only genuinely
// long sentences are re-checked, where the tiny model starts dropping words.
function needsAccurateTranscript(remainder, audioDurationMs) {
  const words = String(remainder || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return false;
  return words.length >= 7 || audioDurationMs > 4200;
}

async function detectWake(wavBuffer) {
  const startedAt = Date.now();
  const info = validateWav(wavBuffer);
  const audioDurationMs = Math.max(0, Math.round(((info.bytes - 44) / (info.sampleRate * 2)) * 1000));
  if (audioDurationMs < 150) return { text: '', wake: false, sleep: false, remainder: '', commandText: '', ms: 0, audioDurationMs };
  let parsed;
  const wakeFields = { response_format: 'json', temperature: '0.0', language: 'en' };
  if (WAKE_PROMPT) wakeFields.prompt = WAKE_PROMPT;
  try {
    parsed = await requestServer(WAKE_MODEL_PATH, wakeFields, wavBuffer, WAKE_TIMEOUT_MS);
  } catch (error) {
    // Fall back to the command model if the wake model is unavailable.
    parsed = await requestServer(MODEL_PATH, wakeFields, wavBuffer, WAKE_TIMEOUT_MS);
  }
  // Whisper’s no_speech_prob is unreliable for one-word clips (a clear “BRO”
  // can score 0.85), so the wake decision is made purely from the transcript.
  const text = cleanTranscript(parsed && typeof parsed.text === 'string' ? parsed.text : '');
  const first = matchWake(text);
  if (first.wake || first.sleep) {
    // A command said in the same breath as the name was transcribed by the
    // small wake model, which is fine for “BRO, notepad” but loses accuracy on
    // longer requests. Re-check those with the accurate model.
    if (first.commandText && needsAccurateTranscript(first.remainder, audioDurationMs)) {
      try {
        const refined = await requestServer(MODEL_PATH, {
          response_format: 'json', temperature: '0.0', language: 'en', prompt: PROMPT,
        }, wavBuffer, WAKE_TIMEOUT_MS);
        const refinedText = cleanTranscript(refined && typeof refined.text === 'string' ? refined.text : '');
        const refinedMatch = matchWake(refinedText);
        if ((refinedMatch.wake || refinedMatch.sleep) && refinedMatch.commandText) {
          return { text: refinedText, ...refinedMatch, ms: Date.now() - startedAt, audioDurationMs, confirmed: false, refined: true };
        }
      } catch (_) {
        // Keep the wake-model transcript.
      }
    }
    return { text, ...first, ms: Date.now() - startedAt, audioDurationMs, confirmed: false };
  }

  // Near miss: a short utterance that looks like a mangled “BRO”. Only then is
  // it worth asking the accurate model for a second opinion — re-checking every
  // short clip kept the microphone deaf for an extra second or two, which made
  // people repeat the wake word.
  if (WAKE_MODEL_PATH !== MODEL_PATH && audioDurationMs <= 3500 && looksLikeWakeGarble(text)) {
    try {
      const second = await requestServer(MODEL_PATH, {
        response_format: 'json', temperature: '0.0', language: 'en', prompt: 'BRO',
      }, wavBuffer, WAKE_SECOND_OPINION_TIMEOUT_MS);
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

// Starts both Whisper servers ahead of the first spoken word. Without this the
// very first “BRO” of a session paid for the server start and model load, so
// the watcher was deaf for several seconds — the user said the name three times
// before anything happened.
async function warm() {
  if (shuttingDown || !platformSupported()) return { ready: false, models: [] };
  if (!binaryPresent(SERVER_BIN)) return { ready: false, models: [] };
  const models = [...new Set([WAKE_MODEL_PATH, MODEL_PATH])].filter((model) => binaryPresent(model));
  const results = await Promise.all(models.map((model) => ensureServer(model).catch(() => null)));
  const ready = results.some((result) => Boolean(result && result.port));
  return { ready, models: models.map((model) => path.basename(model)) };
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
  warm,
  transcribe,
  detectWake,
  matchWake,
  looksLikeCommand,
  cleanTranscript,
  cleanCommandTranscript,
  shutdown,
  MODEL_PATH,
  WAKE_MODEL_PATH,
  BIN_DIR,
};
