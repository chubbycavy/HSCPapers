/* Generates minimal app icons (pure Node, no deps): 32px + 128px PNGs
 * (solid indigo rounded square with white "H") and a .ico embedding the PNG.
 * Run once:  node desktop/tools/make-icons.js
 * (128x128@2x is a 256px PNG; .icns for macOS is intentionally skipped —
 *  Windows NSIS builds only need .ico + PNGs.)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const OUT = path.resolve(__dirname, "..", "src-tauri", "icons");
fs.mkdirSync(OUT, { recursive: true });

function crc32(buf) {
  const t = crc32.table || (crc32.table = (() => {
    const c = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let v = n;
      for (let k = 0; k < 8; k++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1;
      c[n] = v >>> 0;
    }
    return c;
  })());
  let crc = 0xffffffff;
  for (const b of buf) crc = t[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
// Raster: indigo gradient-ish rounded square + white "H" bars, on transparent bg.
function raster(size) {
  const px = Buffer.alloc(size * size * 4);
  const r = size * 0.24; // corner radius
  const hBar = size * 0.13, hTop = size * 0.24, hBot = size - hTop; // H geometry
  const hL = size * 0.28, hR = size - hL, hMid = size * 0.465, hMidB = size * 0.535;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cx = Math.min(x, size - 1 - x), cy = Math.min(y, size - 1 - y);
      const inside = cx >= 0 && cy >= 0 && (cx >= r || cy >= r || (r - cx) ** 2 + (r - cy) ** 2 <= r * r);
      const i = (y * size + x) * 4;
      if (!inside) { px[i + 3] = 0; continue; }
      const t = (x + y) / (2 * size); // 0..1 diagonal for gradient
      px[i] = Math.round(79 + (6 - 79) * t);     // R 4f46e5 -> 06b6d4
      px[i + 1] = Math.round(70 + (182 - 70) * t); // G
      px[i + 2] = Math.round(229 + (212 - 229) * t); // B
      px[i + 3] = 255;
      const inH = y >= hTop && y <= hBot &&
        ((x >= hL - hBar / 2 && x <= hL + hBar / 2) ||
         (x >= hR - hBar / 2 && x <= hR + hBar / 2) ||
         (y >= hMid && y <= hMidB && x >= hL && x <= hR));
      if (inH) { px[i] = 255; px[i + 1] = 255; px[i + 2] = 255; }
    }
  }
  return px;
}
function png(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const px = raster(size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    px.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}
const p32 = png(32), p128 = png(128), p256 = png(256);
fs.writeFileSync(path.join(OUT, "32x32.png"), p32);
fs.writeFileSync(path.join(OUT, "128x128.png"), p128);
fs.writeFileSync(path.join(OUT, "128x128@2x.png"), p256);
// .ico wrapping the 256px PNG (Vista+ compatible)
const ico = Buffer.alloc(6 + 16);
ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
ico[6] = 0; ico[7] = 0; // 256x256 via 0
ico[8] = 0; ico[9] = 0; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(p256.length, 14); ico.writeUInt32LE(6 + 16, 18);
fs.writeFileSync(path.join(OUT, "icon.ico"), Buffer.concat([ico, p256]));
console.log("icons written to", OUT, Object.entries({ "32x32.png": p32.length, "128x128.png": p128.length, "128x128@2x.png": p256.length }).map(([k, v]) => `${k} ${v}b`).join(", "));
