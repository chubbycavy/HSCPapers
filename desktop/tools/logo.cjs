/* logo.cjs — the HSCPapers brand: the "page & stack" mark.
 * Owner of: ui/logo.svg (master vector), ui/icon-192.png, ui/icon-512.png
 * (PWA), ui/og-card.png (1200x630 share card), and the favicon href used
 * by index.html + the landing/coverage generator NAVs. The mark: a white
 * exam sheet with a folded corner, the indigo H carved in negative space,
 * two receding pages behind, on the dark navy rounded field.
 * Run: node tools/logo.cjs            → rebuild all brand assets
 *      node tools/logo.cjs --previews → the 3 candidate previews only
 * (supersedes og-card.cjs — retired; this file owns every brand raster) */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const UI = path.join(__dirname, "..", "ui");

/* ---------- the master SVG (the wired source of truth) ----------
 * L1 "vibrant field": brand-indigo field, light-indigo receding pages,
 * white front sheet, deep-indigo-950 H — maximum contrast at 16px. */
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#4f46e5"/>
  <rect x="55" y="22" width="26" height="52" rx="5" fill="#a5b4fc"/>
  <rect x="47" y="28" width="26" height="52" rx="5" fill="#c7d2fe"/>
  <rect x="26" y="22" width="40" height="58" rx="5" fill="#f8fafc"/>
  <path d="M50 22 H66 V38 Z" fill="#e0e4f0"/>
  <rect x="32" y="34" width="5" height="34" fill="#1e1b4b"/>
  <rect x="52" y="34" width="5" height="34" fill="#1e1b4b"/>
  <rect x="37" y="47" width="15" height="5" fill="#1e1b4b"/>
</svg>`;

/* ---------- PNG writer (no deps: zlib + CRC) ---------- */
function crc32(buf) {
  if (!crc32.table) {
    crc32.table = [];
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc32.table[n] = c >>> 0; }
  }
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = crc32.table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* ---------- tiny rasterizer (2x supersampled) ---------- */
function makeCanvas(w, h) { return { w, h, buf: Buffer.alloc(w * h * 4, 0) }; }
function setPx(c, x, y, [r, g, b, a]) {
  if (x < 0 || y < 0 || x >= c.w || y >= c.h) return;
  const i = (y * c.w + x) * 4;
  const da = a / 255, oa = c.buf[i + 3] / 255, na = da + oa * (1 - da);
  if (na <= 0) return;
  c.buf[i] = Math.round((r * da + c.buf[i] * oa * (1 - da)) / na);
  c.buf[i + 1] = Math.round((g * da + c.buf[i + 1] * oa * (1 - da)) / na);
  c.buf[i + 2] = Math.round((b * da + c.buf[i + 2] * oa * (1 - da)) / na);
  c.buf[i + 3] = Math.round(na * 255);
}
function hexRGB(c) { const n = parseInt(c.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]; }
function asRGBA(col) { return typeof col === "string" ? hexRGB(col) : col; }
function fillRect(c, x, y, w, h, col) {
  const [r, g, b, a] = asRGBA(col);
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) setPx(c, xx, yy, [r, g, b, a]);
}
function fillRoundRect(c, x, y, w, h, rad, col) {
  const [r, g, b, a] = asRGBA(col);
  x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h);
  rad = Math.min(rad, Math.floor(w / 2), Math.floor(h / 2));
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
    const dx = Math.max(x + rad - xx, xx - (x + w - 1 - rad), 0);
    const dy = Math.max(y + rad - yy, yy - (y + h - 1 - rad), 0);
    if (dx * dx + dy * dy <= rad * rad) setPx(c, xx, yy, [r, g, b, a]);
  }
}
function fillTriangle(c, p1, p2, p3, col) {
  const [r, g, b, a] = asRGBA(col);
  const minX = Math.floor(Math.min(p1[0], p2[0], p3[0])), maxX = Math.ceil(Math.max(p1[0], p2[0], p3[0]));
  const minY = Math.floor(Math.min(p1[1], p2[1], p3[1])), maxY = Math.ceil(Math.max(p1[1], p2[1], p3[1]));
  const area = (p2[0] - p1[0]) * (p3[1] - p1[1]) - (p3[0] - p1[0]) * (p2[1] - p1[1]);
  if (area === 0) return;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const w1 = ((p2[0] - x) * (p3[1] - y) - (p3[0] - x) * (p2[1] - y)) / area;
    const w2 = ((p3[0] - x) * (p1[1] - y) - (p1[0] - x) * (p3[1] - y)) / area;
    const w3 = 1 - w1 - w2;
    if (w1 >= 0 && w2 >= 0 && w3 >= 0) setPx(c, x, y, [r, g, b, a]);
  }
}
function downsample2x(big) {
  const w = big.w / 2, h = big.h / 2;
  const out = makeCanvas(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let ch = 0; ch < 4; ch++) {
      const i0 = ((y * 2) * big.w + x * 2) * 4 + ch;
      out.buf[(y * w + x) * 4 + ch] = Math.round((big.buf[i0] + big.buf[i0 + 4] + big.buf[i0 + big.w * 4] + big.buf[i0 + big.w * 4 + 4]) / 4);
    }
  }
  return out;
}

/* ---------- the L1 mark, raster form (optional origin for compositing) ---------- */
function drawMark(c, S, ox = 0, oy = 0) {
  const u = S / 100;
  fillRoundRect(c, ox, oy, S, S, 22 * u, "#4f46e5");
  fillRoundRect(c, ox + 55 * u, oy + 22 * u, 26 * u, 52 * u, 5 * u, "#a5b4fc");
  fillRoundRect(c, ox + 47 * u, oy + 28 * u, 26 * u, 52 * u, 5 * u, "#c7d2fe");
  fillRoundRect(c, ox + 26 * u, oy + 22 * u, 40 * u, 58 * u, 5 * u, "#f8fafc");
  fillTriangle(c, [ox + 50 * u, oy + 22 * u], [ox + 66 * u, oy + 22 * u], [ox + 66 * u, oy + 38 * u], "#e0e4f0");
  fillRect(c, ox + 32 * u, oy + 34 * u, 5 * u, 34 * u, "#1e1b4b");
  fillRect(c, ox + 52 * u, oy + 34 * u, 5 * u, 34 * u, "#1e1b4b");
  fillRect(c, ox + 37 * u, oy + 47 * u, 15 * u, 5 * u, "#1e1b4b");
}

/* ---------- the other two candidates (kept for --previews) ---------- */
function drawMonogram(c, S) {
  const u = S / 100;
  fillRoundRect(c, 0, 0, S, S, 22 * u, "#4f46e5");
  const white = "#ffffff";
  fillRect(c, 24 * u, 26 * u, 7 * u, 48 * u, white);
  fillRect(c, 62 * u, 26 * u, 7 * u, 48 * u, white);
  fillRect(c, 31 * u, 46 * u, 31 * u, 7 * u, white);
  fillRect(c, 40 * u, 26 * u, 22 * u, 7 * u, white);
  fillRect(c, 24 * u, 67 * u, 22 * u, 7 * u, white);
  fillRect(c, 40 * u, 33 * u, 5 * u, 5 * u, "#4f46e5");
  fillRect(c, 41 * u, 62 * u, 5 * u, 5 * u, "#4f46e5");
}
function drawShelf(c, S) {
  const u = S / 100;
  fillRoundRect(c, 0, 0, S, S, 22 * u, "#0b1220");
  const base = 76 * u;
  fillRoundRect(c, 18 * u, base, 64 * u, 6 * u, 3 * u, "#3e55a8");
  fillRoundRect(c, 22 * u, 26 * u, 13 * u, 50 * u, 2 * u, "#4f46e5");
  fillRoundRect(c, 39 * u, 36 * u, 13 * u, 40 * u, 2 * u, "#f8fafc");
  const cx = 66 * u, cy = base - 25 * u, w2 = 7 * u, h2 = 25 * u, tilt = 0.35;
  const dx = Math.sin(tilt) * h2, dy = Math.cos(tilt) * h2;
  fillTriangle(c, [cx - w2, cy], [cx + w2, cy], [cx + w2 + dx * 0.2, cy + dy], "#f8fafc");
  fillTriangle(c, [cx - w2, cy], [cx + w2 + dx * 0.2, cy + dy], [cx - w2 + dx * 0.2, cy + dy], "#e0e4f0");
  fillRect(c, 35 * u, 47 * u, 6 * u, 7 * u, "#0b1220");
}

/* ---------- build ---------- */
function build() {
  fs.writeFileSync(path.join(UI, "logo.svg"), MARK_SVG);
  for (const [size, name] of [[192, "icon-192.png"], [512, "icon-512.png"]]) {
    const big = makeCanvas(size * 2, size * 2);
    drawMark(big, size * 2);
    fs.writeFileSync(path.join(UI, name), encodePng(size, size, downsample2x(big).buf));
  }
  // the og-card: brand-indigo field + a white tile + the mark inside —
  // layered (echoes the app's card language); the mark-on-indigo edge
  // would vanish without the tile
  const W = 1200, H = 630;
  const card = makeCanvas(W, H);
  fillRect(card, 0, 0, W, H, "#4f46e5");
  fillRoundRect(card, (W - 360) / 2, (H - 360) / 2, 360, 360, 36, "#f8fafc");
  drawMark(card, 300, (W - 300) / 2, (H - 300) / 2);
  fs.writeFileSync(path.join(UI, "og-card.png"), encodePng(W, H, card.buf));
  console.log("brand assets rebuilt: logo.svg + icon-192.png + icon-512.png + og-card.png");
}

/* ---------- previews (the 3-candidate flow, kept for the record) ---------- */
function previews() {
  const outDir = path.join(__dirname, "logo-previews");
  fs.mkdirSync(outDir, { recursive: true });
  for (const [name, draw, blurb] of [
    ["c1-page-stack", drawMark, "exam sheet + receding stack, dark field (THE WINNER)"],
    ["c2-monogram", drawMonogram, "H+S ligature monogram, indigo field"],
    ["c3-shelf", drawShelf, "abstract bookshelf + tilted trial paper, dark field"],
  ]) {
    const big = makeCanvas(1024, 1024);
    draw(big, 1024);
    fs.writeFileSync(path.join(outDir, name + ".png"), encodePng(512, 512, downsample2x(big).buf));
    console.log(`${name}.png — ${blurb}`);
  }
}

if (process.argv.includes("--previews")) previews(); else build();
