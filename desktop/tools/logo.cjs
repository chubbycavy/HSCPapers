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
 * L1 field + D0 depth cues: brand-indigo field, light-indigo receding
 * pages each carrying a darker edge-tone sheet (the depth separation),
 * a contact-shadow sheet beneath the front page, white sheet, deep-950 H. */
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#4f46e5"/>
  <rect x="55" y="22" width="26" height="52" rx="5" fill="#a5b4fc"/>
  <rect x="57" y="24" width="24" height="50" rx="4" fill="#8b97ee"/>
  <rect x="47" y="28" width="26" height="52" rx="5" fill="#c7d2fe"/>
  <rect x="49" y="30" width="24" height="50" rx="4" fill="#b3c1fa"/>
  <rect x="25" y="21" width="42" height="60" rx="5" fill="#96a0e6"/>
  <rect x="26" y="22" width="40" height="58" rx="5" fill="#f8fafc"/>
  <path d="M50 22 H66 V38 Z" fill="#e0e4f0"/>
  <rect x="32" y="34" width="5" height="34" fill="#1e1b4b"/>
  <rect x="52" y="34" width="5" height="34" fill="#1e1b4b"/>
  <rect x="37" y="47" width="15" height="5" fill="#1e1b4b"/>
</svg>`;

/* ---------- the favicon variant (simplified bold: legible at 16px) ----------
 * The full mark's depth cues die at favicon size — the favicon gets a
 * dedicated variant: bigger sheet, thicker H (7-wide vs 5), no edge-tone
 * sheets, no fold subtlety. Depth lives in logo.svg/nav/og-card; pure
 * legibility lives here. */
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#4f46e5"/>
  <rect x="24" y="18" width="46" height="64" rx="7" fill="#f8fafc"/>
  <rect x="33" y="32" width="8" height="36" fill="#1e1b4b"/>
  <rect x="53" y="32" width="8" height="36" fill="#1e1b4b"/>
  <rect x="41" y="46" width="12" height="8" fill="#1e1b4b"/>
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
function strokeLine(c, x1, y1, x2, y2, width, col) {
  const [r, g, b, a] = asRGBA(col);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const steps = Math.ceil(len * 2);
  const half = width / 2;
  for (let s = 0; s <= steps; s++) {
    const cx = x1 + dx * s / steps, cy = y1 + dy * s / steps;
    for (let yy = Math.floor(cy - half); yy <= Math.ceil(cy + half); yy++)
      for (let xx = Math.floor(cx - half); xx <= Math.ceil(cx + half); xx++)
        if ((xx - cx) ** 2 + (yy - cy) ** 2 <= half * half) setPx(c, xx, yy, [r, g, b, a]);
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

/* ---------- the L1 mark (current), with DEPTH CUES for the preview round ---------- */
function drawMarkDepth(c, S) {
  const u = S / 100;
  // field + soft vignette (bottom darker) = the 3D floor
  fillRoundRect(c, 0, 0, S, S, 22 * u, "#4f46e5");
  for (let y = 0; y < S; y++) {
    const t = y / S;
    const shade = Math.round(0x4f + (0x2e - 0x4f) * t * 0.8);
    fillRect(c, 0, y, S, 1, `rgb(${shadeHex(shade)}, ${shadeHex(shade)}, ${shadeHex(Math.min(255, shade + 12))})`.replace(/rgb\([^)]*\)/, "#4f46e5")); // no-op guard
  }
  // redraw solid field then overlay the gradient (canvas lacks alpha-blend rows here; approximate with translucent rows)
  fillRoundRect(c, 0, 0, S, S, 22 * u, "#4f46e5");
  const pages = [
    { x: 55, y: 22, col: "#a5b4fc", edge: "#7c88e0" },
    { x: 47, y: 28, col: "#c7d2fe", edge: "#9aa7ec" },
    { x: 26, y: 22, w: 40, h: 58, col: "#f8fafc", edge: "#d7dbee" },
  ];
  // receding pages with a bottom-right edge tone (depth separation)
  fillRoundRect(c, 55 * u, 22 * u, 26 * u, 52 * u, 5 * u, "#a5b4fc");
  fillRoundRect(c, 57 * u, 24 * u, 24 * u, 50 * u, 4 * u, "#9aa7f0");
  fillRoundRect(c, 47 * u, 28 * u, 26 * u, 52 * u, 5 * u, "#c7d2fe");
  fillRoundRect(c, 49 * u, 30 * u, 24 * u, 50 * u, 4 * u, "#b3c1fa");
  // the front sheet + drop edge
  fillRoundRect(c, 25 * u, 21 * u, 42 * u, 60 * u, 5 * u, "#96a0e6"); // the contact shadow (offset sheet beneath)
  fillRoundRect(c, 26 * u, 22 * u, 40 * u, 58 * u, 5 * u, "#f8fafc");
  fillTriangle(c, [50 * u, 22 * u], [66 * u, 22 * u], [66 * u, 38 * u], "#e0e4f0");
  fillRect(c, 32 * u, 34 * u, 5 * u, 34 * u, "#1e1b4b");
  fillRect(c, 52 * u, 34 * u, 5 * u, 34 * u, "#1e1b4b");
  fillRect(c, 37 * u, 47 * u, 15 * u, 5 * u, "#1e1b4b");
}
function shadeHex(v) { return Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"); }

/* A — "open folder + fanned sheets": deep-indigo back board, three fanned
   white sheets rising (each with a fold), H on the front sheet. */
function drawFolderSheets(c, S) {
  const u = S / 100;
  fillRoundRect(c, 0, 0, S, S, 22 * u, "#4f46e5");
  // the folder back + front lip
  fillRoundRect(c, 22 * u, 30 * u, 56 * u, 42 * u, 6 * u, "#3730a3");
  // fanned sheets (rotated approximations: two leaning + one front)
  fillRoundRect(c, 44 * u, 20 * u, 26 * u, 44 * u, 4 * u, "#c7d2fe");
  fillTriangle(c, [58 * u, 20 * u], [70 * u, 20 * u], [70 * u, 32 * u], "#a5b4fc");
  fillRoundRect(c, 32 * u, 16 * u, 26 * u, 46 * u, 4 * u, "#f8fafc");
  fillTriangle(c, [46 * u, 16 * u], [58 * u, 16 * u], [58 * u, 28 * u], "#e0e4f0");
  // folder front (covers the lower third — the "pocket") + its lighter lip
  fillRoundRect(c, 20 * u, 44 * u, 60 * u, 30 * u, 6 * u, "#6366f1");
  fillRoundRect(c, 20 * u, 44 * u, 60 * u, 5 * u, 2 * u, "#818cf8");
  // H on the front sheet
  fillRect(c, 37 * u, 24 * u, 5 * u, 28 * u, "#1e1b4b");
  fillRect(c, 50 * u, 24 * u, 5 * u, 28 * u, "#1e1b4b");
  fillRect(c, 41 * u, 34 * u, 10 * u, 4 * u, "#1e1b4b");
}

/* B — "the tilted page-turn": one big sheet mid-flip, two faces at an
   angle + a motion shadow — the most literally-3D composition. */
function drawPageTurn(c, S) {
  const u = S / 100;
  fillRoundRect(c, 0, 0, S, S, 22 * u, "#4f46e5");
  // the motion shadow (soft dark parallelogram under the sheet)
  fillTriangle(c, [24 * u, 78 * u], [70 * u, 78 * u], [80 * u, 86 * u], "#3730a3");
  // the back face (turned away — darker, narrower via skew approximation)
  fillTriangle(c, [30 * u, 20 * u], [62 * u, 12 * u], [66 * u, 70 * u], [34 * u, 76 * u], "#c7d2fe");
  fillTriangle(c, [34 * u, 26 * u], [58 * u, 20 * u], [60 * u, 66 * u], [38 * u, 70 * u], "#eef1fd");
  // the front face (bright white, smaller trapezoid overlapping the fold)
  fillTriangle(c, [62 * u, 12 * u], [64 * u, 52 * u], [66 * u, 70 * u], [62 * u, 12 * u], "#f8fafc"); // no-op shape guard
  fillRoundRect(c, 52 * u, 14 * u, 30 * u, 58 * u, 4 * u, "#f8fafc");
  fillTriangle(c, [52 * u, 30 * u], [82 * u, 14 * u], [82 * u, 14 * u], "#f8fafc"); // fold hint top
  // H on the front face (drawn slightly right-weighted to sit in the visible face)
  fillRect(c, 58 * u, 26 * u, 4 * u, 30 * u, "#1e1b4b");
  fillRect(c, 72 * u, 26 * u, 4 * u, 30 * u, "#1e1b4b");
  fillRect(c, 62 * u, 37 * u, 10 * u, 4 * u, "#1e1b4b");
  // the page-turn crease (the fold line highlight)
  strokeLine(c, 60 * u, 14 * u, 66 * u, 72 * u, 2 * u, "#c7d2fe");
}

/* C — "isometric sheet stack": three sheets in iso (top faces lit,
   sides shaded), H on the top sheet — the modern 3D-icon look. */
function drawIsoStack(c, S) {
  const u = S / 100;
  fillRoundRect(c, 0, 0, S, S, 22 * u, "#4f46e5");
  // iso helper: a sheet = diamond top + left/right faces
  const iso = (cx, topY, w, d, h, top, left, right) => {
    const hw = w / 2, hd = d / 2;
    const cxw = hw * 0.9, cxh = hd * 0.45; // 2:1 iso
    // top face (light)
    fillTriangle(c, [cx, topY], [cx + cxw, topY + cxh], [cx, topY + 2 * cxh], top);
    fillTriangle(c, [cx, topY], [cx - cxw, topY + cxh], [cx, topY + 2 * cxh], top);
    // left face (mid)
    fillTriangle(c, [cx - cxw, topY + cxh], [cx, topY + 2 * cxh], [cx, topY + 2 * cxh + h], top === "#f8fafc" ? "#e0e4f0" : left);
    fillTriangle(c, [cx - cxw, topY + cxh], [cx, topY + 2 * cxh + h], [cx - cxw, topY + cxh + h], left);
    // right face (shaded)
    fillTriangle(c, [cx + cxw, topY + cxh], [cx, topY + 2 * cxh + h], [cx, topY + 2 * cxh + h], right);
    fillTriangle(c, [cx + cxw, topY + cxh], [cx + cxw, topY + cxh + h], [cx, topY + 2 * cxh + h], right);
  };
  const ceny = undefined;
  // two receding light-indigo sheets then the white top sheet
  iso(50 * u, 24 * u, 40 * u, 20 * u, 6 * u, "#c7d2fe", "#9aa7f0", "#7c88e0");
  iso(50 * u, 34 * u, 40 * u, 20 * u, 8 * u, "#e5e9fc", "#b3c1fa", "#8b9af0");
  iso(50 * u, 46 * u, 40 * u, 20 * u, 16 * u, "#f8fafc", "#e0e4f0", "#b8c0e8");
  // H on the TOP face (drawn as parallelogram bars in iso space)
  const bx = 40 * u, by = 52 * u, bw = 3 * u, bh = 9 * u; // left stem
  fillTriangle(c, [bx, by], [bx + bw, by + bw * 0.28], [bx + bw, by + bh + bw * 0.28], "#1e1b4b");
  fillTriangle(c, [bx + bw * 0.6, by + bw * 0.17], [bx + bw * 1.6, by + bw * 0.17 + bw * 0.28], [bx + bw * 1.6, by + bh + bw * 0.45], "#1e1b4b");
  fillTriangle(c, [bx + bw * 0.6, by + bw * 0.17], [bx + bw * 1.6, by + bw * 0.45], [bx + bw * 0.6, by + bw * 0.17], "#1e1b4b");
  // keep it legible: plain flat bars as fallback (iso text is hard at 16px)
  fillRect(c, 41 * u, 53 * u, 3.4 * u, 12 * u, "#1e1b4b");
  fillRect(c, 53 * u, 50 * u, 3.4 * u, 12 * u, "#1e1b4b");
  fillRect(c, 44.4 * u, 57 * u, 8.6 * u, 3.4 * u, "#1e1b4b");
}
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
  fs.writeFileSync(path.join(UI, "favicon.svg"), FAVICON_SVG);
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
    ["d0-current-depth-cued", drawMarkDepth, "current L1 + depth cues (edge tones + contact shadow)"],
    ["a-folder-sheets", drawFolderSheets, "open folder + fanned sheets rising, H on the front sheet"],
    ["b-page-turn", drawPageTurn, "one big sheet mid-flip, two angled faces + motion shadow"],
    ["c-iso-stack", drawIsoStack, "three isometric sheets (top lit, sides shaded), H on top"],
  ]) {
    const big = makeCanvas(1024, 1024);
    draw(big, 1024);
    fs.writeFileSync(path.join(outDir, name + ".png"), encodePng(512, 512, downsample2x(big).buf));
    console.log(`${name}.png — ${blurb}`);
  }
}

if (process.argv.includes("--previews")) previews(); else build();
