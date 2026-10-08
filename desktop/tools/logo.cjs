/* Classic H — refined. The selected SVG is the source for the favicon,
 * header logo, PWA icons (including maskable), and social card.
 * Native SVG rendering keeps PNGs identical to the approved preview.
 * Run: node desktop/tools/logo.cjs [--pages | --previews]
 * Importing this module exposes brand constants without writing files or
 * requiring Playwright; the catalogue's nightly generators use them. */
"use strict";
const fs = require("fs");
const path = require("path");

const UI = path.join(__dirname, "..", "ui");
const BRAND_VERSION = "classic-h-1";
const LOGO_HREF = `/logo.svg?v=${BRAND_VERSION}`;
const FAVICON_HREF = `/favicon.svg?v=${BRAND_VERSION}`;
const SOCIAL_IMAGE_URL = `https://hscpapers.com/og-card.png?v=${BRAND_VERSION}`;

// Geometry, colours, radius and shadow match option 01 in h-round-01.
const MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <defs>
    <linearGradient id="classic-h-field" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#5b52ea"/><stop offset="1" stop-color="#4338ca"/>
    </linearGradient>
    <linearGradient id="classic-h-paper" x1="0" y1="0" x2=".25" y2="1">
      <stop stop-color="#ffffff"/><stop offset="1" stop-color="#eef1ff"/>
    </linearGradient>
    <filter id="classic-h-shadow" x="-30%" y="-30%" width="160%" height="170%" color-interpolation-filters="sRGB">
      <feDropShadow dx="0" dy="1.3" stdDeviation="1" flood-color="#211558" flood-opacity=".16"/>
    </filter>
  </defs>
  <rect width="100" height="100" rx="23" fill="url(#classic-h-field)"/>
  <path d="M29 24H36Q39 24 39 27V44H61V27Q61 24 64 24H71Q74 24 74 27V73Q74 76 71 76H64Q61 76 61 73V56H39V73Q39 76 36 76H29Q26 76 26 73V27Q26 24 29 24Z"
    fill="url(#classic-h-paper)" filter="url(#classic-h-shadow)"/>
</svg>`;

const logoImage = (href = LOGO_HREF) => `<img src="${href}" width="100" height="100" alt="" aria-hidden="true">`;
const dataUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

function nestedMark(x, y, size) {
  return MARK_SVG.replace("<svg ", `<svg x="${x}" y="${y}" width="${size}" height="${size}" `);
}

function maskableSvg() {
  // Opaque, full-bleed canvas; the important H stays well inside the
  // central maskable safe circle. The inner tile blends into the field.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs><linearGradient id="mask-field" x1="0" y1="0" x2="1" y2="1">
      <stop stop-color="#5b52ea"/><stop offset="1" stop-color="#4338ca"/>
    </linearGradient></defs>
    <rect width="100" height="100" fill="url(#mask-field)"/>
    ${nestedMark(10, 10, 80)}
  </svg>`;
}

function socialSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#4f46e5"/>
    <rect x="420" y="135" width="360" height="360" rx="36" fill="#f8fafc"/>
    ${nestedMark(450, 165, 300)}
  </svg>`;
}

async function renderPng(page, svg, width, height = width) {
  const bytes = await page.evaluate(async ({ source, width, height }) => {
    const img = new Image();
    img.src = source;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    canvas.getContext("2d").drawImage(img, 0, 0, width, height);
    return canvas.toDataURL("image/png").split(",")[1];
  }, { source: dataUrl(svg), width, height });
  return Buffer.from(bytes, "base64");
}

async function build({ previews = false } = {}) {
  if (!fs.statSync(UI).isDirectory()) throw new Error("UI asset directory is missing");
  const { chromium } = require("@playwright/test");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    if (previews) {
      const directory = path.join(__dirname, "logo-previews");
      fs.mkdirSync(directory, { recursive: true });
      for (const size of [16, 32, 64, 512]) {
        const png = await renderPng(page, MARK_SVG, size);
        fs.writeFileSync(path.join(directory, `classic-h-${size}px.png`), png);
      }
      console.log("Classic H previews rendered at 16, 32, 64 and 512 pixels.");
      return;
    }

    // Render everything before writing; a browser/render failure cannot
    // leave half of the brand assets at an older design.
    const outputs = [
      ["logo.svg", MARK_SVG + "\n"],
      ["favicon.svg", MARK_SVG + "\n"],
      ["icon-192.png", await renderPng(page, MARK_SVG, 192)],
      ["icon-512.png", await renderPng(page, MARK_SVG, 512)],
      ["icon-maskable-512.png", await renderPng(page, maskableSvg(), 512)],
      ["og-card.png", await renderPng(page, socialSvg(), 1200, 630)],
    ];
    for (const [name, bytes] of outputs) fs.writeFileSync(path.join(UI, name), bytes);
    console.log(`Classic H rebuilt: ${outputs.map(([name]) => name).join(", ")}`);
  } finally {
    await browser.close();
  }
}

module.exports = { BRAND_VERSION, MARK_SVG, LOGO_HREF, FAVICON_HREF, SOCIAL_IMAGE_URL, logoImage, build };
if (require.main === module) {
  (async () => {
    const previews = process.argv.includes("--previews");
    await build({ previews });
    if (!previews && process.argv.includes("--pages")) {
      await require("./coverage-report.cjs")();
      await require("./landing-pages.cjs")();
    }
  })().catch((err) => {
    console.error(`Logo build failed: ${err.message}`); process.exitCode = 1;
  });
}
