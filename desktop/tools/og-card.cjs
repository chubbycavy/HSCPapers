/* og-card.cjs — generates desktop/ui/og-card.png (1200x630 OpenGraph share card)
   Pure Node (zlib built-in) — no image deps. Brand: indigo field, white
   rounded tile, indigo block "H" (matches the favicon/logo mark). Rerun
   after any rebrand: node desktop/tools/og-card.cjs */
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");

const W = 1200, H = 630;
const BG = [0x4f, 0x46, 0xe5];   // brand indigo
const FG = [0xff, 0xff, 0xff];   // white

const rows = [];
for (let y = 0; y < H; y++) {
  const row = Buffer.alloc(1 + W * 4);
  row[0] = 0; // filter: none
  rows.push(row);
}
function px(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = 1 + x * 4;
  rows[y][o] = c[0]; rows[y][o + 1] = c[1]; rows[y][o + 2] = c[2]; rows[y][o + 3] = 255;
}
function rect(x0, y0, w, h, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) px(x, y, c);
}
function roundRect(x0, y0, w, h, r, c) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const cx = x < x0 + r ? (x0 + r) - x : x >= x0 + w - r ? x - (x0 + w - 1 - r) : 0;
    const cy = y < y0 + r ? (y0 + r) - y : y >= y0 + h - r ? y - (y0 + h - 1 - r) : 0;
    if (cx === 0 || cy === 0 || cx * cx + cy * cy <= r * r) px(x, y, c);
  }
}

// background
rect(0, 0, W, H, BG);
// white tile (favicon-style), centred
const T = { x: 480, y: 165, s: 300, r: 64 };
roundRect(T.x, T.y, T.s, T.s, T.r, FG);
// block "H" in brand indigo, inside the tile
const barW = 36, barH = 190, top = T.y + (T.s - barH) / 2;
const left = T.x + 72, right = T.x + T.s - 72 - barW;
rect(left, top, barW, barH, BG);
rect(right, top, barW, barH, BG);
rect(left, top + (barH - 36) / 2, right + barW - left, 36, BG);
// two small white accent bars below the tile (title/subtitle suggestion)
roundRect(430, 505, 340, 26, 13, FG);
roundRect(510, 549, 180, 18, 9, FG);

// ---- PNG encode (RGBA, 8-bit, single IDAT) ----
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
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = path.join(__dirname, "..", "ui", "og-card.png");
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${W}x${H})`);
