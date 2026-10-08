/* make-icons.cjs — the DESKTOP app icon set (src-tauri/icons/):
 * 32x32.png, 128x128.png, 128x128@2x.png (256px) and icon.ico.
 * RENDERS THE CLASSIC H MASTER (tools/logo.cjs) via Chromium — the same
 * vector the site header/favicon/PWA icons use, so the desktop icon can
 * never drift from the brand. The .ico wraps the 256px PNG (Vista+;
 * PNG-compressed ICO, 32bpp ARGB). macOS .icns intentionally skipped —
 * Windows NSIS builds only.
 * Run: node desktop/tools/make-icons.cjs */
"use strict";
const fs = require("fs");
const path = require("path");
const { chromium } = require("@playwright/test");
const { MARK_SVG } = require("./logo.cjs");

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
const dataUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

async function main() {
  if (!fs.statSync(path.resolve(__dirname, "..", "src-tauri")).isDirectory()) throw new Error("src-tauri directory is missing");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const render = async (size) => await page.evaluate(async ({ source, size }) => {
      const img = new Image();
      img.src = source;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      canvas.getContext("2d").drawImage(img, 0, 0, size, size);
      return canvas.toDataURL("image/png").split(",")[1];
    }, { source: dataUrl(MARK_SVG), size });
    // render all sizes BEFORE writing any (a render failure cannot leave a half-rebrand).
    // render() returns PNG-encoded bytes (canvas.toDataURL) — valid PNGs at
    // the exact requested size; write them straight out.
    const p32 = Buffer.from(await render(32), "base64");
    const p128 = Buffer.from(await render(128), "base64");
    const p256png = Buffer.from(await render(256), "base64");
    fs.writeFileSync(path.join(OUT, "32x32.png"), p32);
    fs.writeFileSync(path.join(OUT, "128x128.png"), p128);
    fs.writeFileSync(path.join(OUT, "128x128@2x.png"), p256png);
    // .ico wrapping the 256px PNG (Vista+; PNG-compressed entry — the same
    // construction every prior release shipped)
    const ico = Buffer.alloc(6 + 16);
    ico.writeUInt16LE(0, 0); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4);
    ico[6] = 0; ico[7] = 0; // 256x256 via 0
    ico[8] = 0; ico[9] = 0; ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12);
    ico.writeUInt32LE(p256png.length, 14); ico.writeUInt32LE(6 + 16, 18);
    fs.writeFileSync(path.join(OUT, "icon.ico"), Buffer.concat([ico, p256png]));
    console.log("Classic H icons written:", ["32x32.png", "128x128.png", "128x128@2x.png", "icon.ico"].map((k) => `${k} ${fs.statSync(path.join(OUT, k)).size}b`).join(", "));
  } finally { await browser.close(); }
}
main().catch((e) => { console.error(`make-icons failed: ${e.message}`); process.exitCode = 1; });
