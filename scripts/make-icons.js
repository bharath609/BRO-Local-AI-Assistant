#!/usr/bin/env node
'use strict';

// Generates the BRO brand icon without any external dependency.
//   node scripts/make-icons.js
// Outputs assets/icon.png (256x256) and assets/icon.ico (multi-size).

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.resolve(__dirname, '..');
const ASSETS = path.join(ROOT, 'assets');

const BG = [14, 17, 22];        // #0e1116
const ACCENT = [124, 245, 196]; // #7cf5c4

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Shapes are described in a 256x256 coordinate space and scaled per size.
const RECTS = [
  [86, 54, 30, 148],   // stem
  [86, 54, 74, 24],    // top bar
  [136, 54, 24, 58],   // top bowl
  [86, 118, 70, 22],   // middle bar
  [136, 142, 24, 60],  // bottom bowl
  [86, 178, 74, 24],   // bottom bar
];

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  const scale = size / 256;
  const radius = 46 * scale;
  const cx = size / 2;
  const cy = size / 2;
  const half = size / 2;

  const insideRounded = (x, y) => {
    const dx = Math.max(Math.abs(x - cx) - (half - radius), 0);
    const dy = Math.max(Math.abs(y - cy) - (half - radius), 0);
    return Math.hypot(dx, dy) <= radius + 0.5;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      if (!insideRounded(x + 0.5, y + 0.5)) continue;
      let color = BG;
      for (const [rx, ry, rw, rh] of RECTS) {
        if (x + 0.5 >= rx * scale && x + 0.5 <= (rx + rw) * scale && y + 0.5 >= ry * scale && y + 0.5 <= (ry + rh) * scale) {
          color = ACCENT;
          break;
        }
      }
      pixels[index] = color[0];
      pixels[index + 1] = color[1];
      pixels[index + 2] = color[2];
      pixels[index + 3] = 255;
    }
  }
  return pixels;
}

function buildIco(sizes) {
  const images = sizes.map((size) => encodePng(size, render(size)));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + images.length * 16;
  for (let index = 0; index < images.length; index += 1) {
    const size = sizes[index];
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(images[index].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += images[index].length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images]);
}

fs.mkdirSync(ASSETS, { recursive: true });
fs.writeFileSync(path.join(ASSETS, 'icon.png'), encodePng(256, render(256)));
fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco([16, 24, 32, 48, 64, 128, 256]));
console.log('Wrote assets/icon.png and assets/icon.ico');
