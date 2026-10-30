#!/usr/bin/env node
'use strict';

// One-time downloader for BRO's local voice engine.
//   npm run setup:voice
// Downloads the whisper.cpp Windows CPU build and an English model into
// vendor/whisper. Everything after that runs offline.

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOME = process.env.BRO_WHISPER_HOME || path.join(ROOT, 'vendor', 'whisper');
const RELEASE_DIR = path.join(HOME, 'Release');
const SERVER_BIN = path.join(RELEASE_DIR, 'whisper-server.exe');
const MODEL = process.env.BRO_WHISPER_MODEL || path.join(HOME, 'models', 'ggml-base.en.bin');
const ENGINE_URL = process.env.BRO_WHISPER_ENGINE_URL
  || 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip';
const MODEL_URL = process.env.BRO_WHISPER_MODEL_URL
  || 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

function download(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) { reject(new Error('Too many redirects.')); return; }
    const request = https.get(url, { headers: { 'user-agent': 'bro-local-assistant' } }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        resolve(download(new URL(response.headers.location, url).toString(), destination, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}.`));
        return;
      }
      const total = Number(response.headers['content-length']) || 0;
      let received = 0;
      let lastLogged = 0;
      const file = fs.createWriteStream(destination);
      response.on('data', (chunk) => {
        received += chunk.length;
        if (total && received - lastLogged > total / 10) {
          lastLogged = received;
          process.stdout.write(`  ${Math.round((received / total) * 100)}%\n`);
        }
      });
      response.pipe(file);
      file.on('finish', () => file.close(() => resolve()));
      file.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(120_000, () => request.destroy(new Error('Download timed out.')));
  });
}

function expand(archive, destination) {
  const result = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `Expand-Archive -LiteralPath '${archive.replace(/'/g, "''")}' -DestinationPath '${destination.replace(/'/g, "''")}' -Force`,
  ], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error('Could not unpack the Whisper engine archive.');
}

(async () => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.mkdirSync(path.dirname(MODEL), { recursive: true });

  if (fs.existsSync(SERVER_BIN)) {
    console.log(`Engine already installed: ${path.relative(ROOT, SERVER_BIN)}`);
  } else {
    const archive = path.join(HOME, 'whisper-bin-x64.zip');
    console.log('Downloading the whisper.cpp Windows engine…');
    await download(ENGINE_URL, archive);
    console.log('Unpacking the engine…');
    expand(archive, HOME);
    fs.rmSync(archive, { force: true });
    if (!fs.existsSync(SERVER_BIN)) throw new Error('The Whisper engine did not unpack as expected.');
    console.log(`Engine installed: ${path.relative(ROOT, SERVER_BIN)}`);
  }

  if (fs.existsSync(MODEL)) {
    console.log(`Model already installed: ${path.relative(ROOT, MODEL)}`);
  } else {
    console.log(`Downloading ${path.basename(MODEL)} (about 150 MB)…`);
    await download(MODEL_URL, MODEL);
    console.log(`Model installed: ${path.relative(ROOT, MODEL)}`);
  }

  console.log('\nBRO voice is ready. Start the app with “npm start” or “npm run desktop”.');
})().catch((error) => {
  console.error(`\nVoice setup failed: ${error.message}`);
  process.exitCode = 1;
});
