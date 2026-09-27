/* icons.cjs — PWA icons: ui/icon-192.png, ui/icon-512.png, ui/icon-maskable-512.png
   Same pure-Node PNG writer as og-card.cjs. Maskable variant keeps the tile
   inside the safe zone (central ~70%). Rerun after any rebrand. */
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

function draw(size, tileFrac) {
  const BG = [0x4f, 0x46, 0xe5], FG = [255, 255, 255];
  const rows = [];
  for (let y = 0; y < size; y++) rows.push(Buffer.alloc(1 + size * 4));
  const px = (x, y, c) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = 1 + x * 4;
    rows[y][o] = c[0]; rows[y][o + 1] = c[1]; rows[y][o + 2] = c[2]; rows[y][o + 3] = 255;
  };
  const rect = (x0, y0, w, h, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(x, y, c);
  };
  const rrect = (x0, y0, w, h, r, c) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
      const cx = x < x0 + r ? (x0 + r) - x : x >= x0 + w - r ? x - (x0 + w - 1 - r) : 0;
      const cy = y < y0 + r ? (y0 + r) - y : y >= y0 + h - r ? y - (y0 + h - 1 - r) : 0;
      if (cx === 0 || cy === 0 || cx * cx + cy * cy <= r * r) px(x, y, c);
    }
  };
  rect(0, 0, size, size, BG);
  const T = Math.round(size * tileFrac), off = Math.round((size - T) / 2);
  rrect(off, off, T, T, Math.round(T * 0.21), FG);
  const barW = Math.round(T * 0.12), barH = Math.round(T * 0.63);
  const top = off + Math.round((T - barH) / 2);
  const left = off + Math.round(T * 0.24), right = off + T - Math.round(T * 0.24) - barW;
  rect(left, top, barW, barH, BG);
  rect(right, top, barW, barH, BG);
  rect(left, top + Math.round((barH - barW) / 2), right + barW - left, barW, BG);
  return Buffer.concat(rows);
}

const crcTable = [];
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encode(size, raw) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
for (const [name, size, frac] of [
  ["icon-192.png", 192, 0.86],
  ["icon-512.png", 512, 0.86],
  ["icon-maskable-512.png", 512, 0.70],
]) {
  const out = path.join(__dirname, "..", "ui", name);
  fs.writeFileSync(out, encode(size, draw(size, frac)));
  console.log(`wrote ${out} (${fs.statSync(out).size} bytes, ${size}x${size})`);
}
