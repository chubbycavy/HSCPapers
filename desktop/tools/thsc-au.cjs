const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const BASE = "https://thsconline.com.au";
const REGISTRY_PATH = path.join(__dirname, "thsc-au-verified.json");
const norm = value => String(value || "").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim().toLowerCase();
function routerKey(url) {
  try {
    const parsed = new URL(url);
    if (!["thsconline.github.io", "thsconline.pages.dev"].includes(parsed.host)) return null;
    const match = parsed.pathname.match(/^\/s\/(?:d|v|fz|f|z)\/(\d+)\/(.+)$/);
    return match ? match[1] + "|" + norm(decodeURIComponent(match[2])) : null;
  } catch { return null; }
}
function candidate(row) {
  const match = String(row.id || "").match(/^(\d+)\/(.+)$/);
  if (!match || !row.r2_key || !Number.isInteger(row.bytes) || row.bytes <= 0 || !Number.isInteger(row.pages) || row.pages <= 0) return null;
  const parts = row.r2_key.split("/");
  if (parts[0] !== "papers" || parts.some(part => !part || [".", ".."].includes(part) || /[\\\x00-\x1f]/.test(part))) return null;
  return { key: match[1] + "|" + norm(match[2]), url: BASE + "/pdf/" + parts.map(encodeURIComponent).join("/"), bytes: row.bytes, pages: row.pages };
}
function candidates(lists) {
  const byKey = new Map(), ambiguous = new Set();
  for (const list of lists) for (const row of list.papers || []) {
    const item = candidate(row);
    if (!item) continue;
    const previous = byKey.get(item.key);
    if (previous && (previous.url !== item.url || previous.bytes !== item.bytes || previous.pages !== item.pages)) ambiguous.add(item.key);
    else byKey.set(item.key, item);
  }
  for (const key of ambiguous) byKey.delete(key);
  return { byKey, ambiguous };
}
function readRegistry(file = REGISTRY_PATH) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return { version: 1, entries: [] }; throw e; }
}
function applyVerified(papers, registry) {
  const verified = new Map();
  for (const entry of registry.entries || []) {
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || "") || !Number.isInteger(entry.bytes) || entry.bytes <= 0 || !Number.isInteger(entry.pages) || entry.pages <= 0) continue;
    let url;
    try { url = new URL(entry.url); } catch { continue; }
    if (url.origin !== BASE || !url.pathname.startsWith("/pdf/papers/")) continue;
    verified.set(entry.key, entry);
  }
  let rewritten = 0;
  for (const paper of papers) {
    const key = routerKey(paper.url);
    const hit = key && verified.get(key);
    if (!hit) continue;
    paper.fallbackUrl = paper.fallbackUrl || paper.url;
    paper.url = hit.url;
    paper.mirror = "thsc-au";
    paper.sha256 = hit.sha256;
    paper.bytes = hit.bytes;
    rewritten++;
  }
  return rewritten;
}
async function validate(item, { fetchImpl = fetch } = {}) {
  const response = await fetchImpl(item.url, { headers: { "User-Agent": "HSCPapers/1.0 (verified mirror reconciliation)", "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(30000), redirect: "manual" });
  if (response.status !== 200 || !/^application\/pdf\b/i.test(response.headers.get("content-type") || "")) {
    await response.body?.cancel();
    throw new Error(`not a direct PDF: HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== item.bytes || bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("PDF signature or declared byte length mismatch");
  const pdfjs = require("../ui/pdfjs/pdf.min.js");
  pdfjs.GlobalWorkerOptions.workerSrc = require.resolve("../ui/pdfjs/pdf.worker.min.js");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true }).promise;
  try { if (doc.numPages !== item.pages) throw new Error("PDF page count mismatch"); }
  finally { await doc.destroy(); }
  return { ...item, sha256: crypto.createHash("sha256").update(bytes).digest("hex"), verifiedAt: new Date().toISOString() };
}
async function refresh(papers, { cached, slug, log = console.log, registryPath = REGISTRY_PATH } = {}) {
  const registry = readRegistry(registryPath);
  let lists;
  try {
    const index = JSON.parse(await cached("au-index.json", BASE + "/api/index"));
    lists = [];
    for (const level of index.levels || []) for (const course of level.courses || []) {
      const file = "au-" + slug(level.level) + "-" + slug(course.course) + ".json";
      lists.push(JSON.parse(await cached(file, BASE + "/api/papers?level=" + encodeURIComponent(level.level) + "&course=" + encodeURIComponent(course.course))));
    }
  } catch (e) { log(`thsc-au: catalogue unavailable; retaining validated mappings (${e.message})`); return registry; }
  const { byKey, ambiguous } = candidates(lists);
  const wanted = new Set(papers.map(p => routerKey(p.url)).filter(Boolean));
  const records = new Map((registry.entries || []).map(entry => [entry.key, entry]));
  let checked = 0, rejected = 0;
  for (const key of wanted) {
    const item = byKey.get(key);
    if (!item || ambiguous.has(key)) continue;
    const previous = records.get(key);
    if (previous && previous.url === item.url && previous.bytes === item.bytes && previous.pages === item.pages && Date.now() - Date.parse(previous.verifiedAt) < 86400000) continue;
    try {
      const proof = await validate(item);
      records.set(key, proof);
      checked++;
      log(`thsc-au verified ${checked}: ${key} (${proof.bytes} B, ${proof.pages} pages)`);
    } catch (e) {
      records.delete(key);
      rejected++;
      log(`thsc-au rejected ${key}: ${e.message}`);
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  const updated = { version: 1, _doc: "Exact THSC viewno/title mappings verified by HTTP 200, PDF MIME/signature, byte length, PDF.js page count and SHA-256. Used identically by online and offline builds.", entries: [...records.values()].sort((a, b) => a.key.localeCompare(b.key)) };
  fs.writeFileSync(registryPath, JSON.stringify(updated, null, 2) + "\n");
  log(`thsc-au validation: ${checked} checked, ${rejected} rejected, ${updated.entries.length} persisted proofs`);
  return updated;
}
module.exports = { routerKey, candidate, candidates, readRegistry, applyVerified, validate, refresh, REGISTRY_PATH };
