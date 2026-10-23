// Candidate-only growth audit for HSC Portal and the THSC change feed.
// Discovery and proofing never write the catalogue. Reviewed admission is
// handled separately through catalogue-imports.json / selfhost.json.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DESKTOP = path.resolve(__dirname, "..");
const ROOT = path.resolve(DESKTOP, "..");
const SOURCES = JSON.parse(fs.readFileSync(path.join(DESKTOP, "sources.json"), "utf8"));
const CATALOGUE = path.join(DESKTOP, "ui", "data", "papers-v2.json");
const CACHE = path.join(__dirname, ".cache", "growth");
const DOWNLOADS = path.join(CACHE, "downloads");
const PORTAL_URL = SOURCES.mirrors.hscportal.catalogue;
const FEED_URL = "https://raw.githubusercontent.com/thsconline/s/thsconline-website/feed.atom";
const UA = { "User-Agent": "HSCPapers/1.0 (growth candidate audit)" };

const arg = (name, fallback = "") => {
  const pref = "--" + name + "=";
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
};
const SOURCE = arg("source");
const VERIFY = process.argv.includes("--verify");
const YEAR = Number(arg("year", "0")) || 0;
const LIMIT = Number(arg("limit", "0")) || 0;

const norm = (s) => String(s || "").toLowerCase().replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
const titleNorm = (s) => norm(s).replace(/[^a-z0-9]+/g, " ").trim();
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "x";
const decodeEnt = (s) => String(s || "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");
const yearOf = (s) => {
  const m = String(s || "").match(/\b((?:19|20)\d{2})\b/);
  return m ? Number(m[1]) : null;
};
const roleOf = (s) => /&\s*solutions|w\.\s*sol/i.test(s) ? "combined" : /solutions?/i.test(s) ? "solutions" : "questions";
const taskOf = (s) => { const m = String(s || "").match(/\b(?:task|assessment)\s*(\d+)\b/i); return m ? "task" + m[1] : ""; };
const paperPart = (s) => { const m = String(s || "").match(/\bpaper\s*([12])\b|\bp([12])\b/i); return m ? "paper" + (m[1] || m[2]) : ""; };
const schoolFromTitle = (s) => {
  const year = yearOf(s);
  if (!year) return "";
  const before = String(s).slice(0, String(s).indexOf(String(year))).replace(/[-,]\s*$/, "").trim();
  return before && !/^\d+$/.test(before) && !/^hsc$/i.test(before) ? before : "";
};
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
const active = [...(catalogue.papers || []), ...(catalogue.recoveryPapers || [])];
const knownUrls = new Set();
const knownTitle = new Set();
const knownIdentity = new Set();
const knownView = new Set();
for (const p of active) {
  for (const u of [p.url, p.solutionUrl, p.fallbackUrl, p.solFallbackUrl,
    ...(p.alternateSources || []).map((a) => a.url), ...(p.fileVariants || []).map((v) => v.url)].filter(Boolean)) knownUrls.add(u);
  const role = p.documentRole || roleOf(p.linkText || p.title || "");
  knownTitle.add(titleNorm(p.title) + "|" + (p.year || "") + "|" + norm(p.school));
  knownIdentity.add([norm(p.subject), p.year || "", norm(p.school), norm(p.type), role,
    taskOf(p.title || p.linkText), paperPart(p.title || p.linkText || "")].join("|"));
  if (p.viewno) knownView.add(String(p.viewno) + "|" + norm(p.linkText || p.title));
}

async function fetchText(url, { cacheFile } = {}) {
  if (cacheFile && fs.existsSync(cacheFile)) return fs.readFileSync(cacheFile, "utf8");
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  const text = await res.text();
  if (cacheFile) {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, text);
  }
  return text;
}

function pdfProof(bytes, contentType) {
  if (!bytes || bytes.length < 8) throw new Error("Empty PDF response");
  if (!contentType || !/application\/pdf/i.test(contentType)) throw new Error("Not application/pdf: " + contentType);
  if (Buffer.from(bytes.subarray(0, 5)).toString() !== "%PDF-") throw new Error("Missing PDF signature");
  return bytes.length;
}

async function pdfMeta(bytes) {
  const pdfjs = await require("./pdfjs.cjs").load();
  const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  try {
    const text = (await (await doc.getPage(1)).getTextContent()).items.map((x) => x.str).join(" ").slice(0, 1400);
    return { pages: doc.numPages, text };
  } finally { await task.destroy(); }
}

async function verifyDirect(url, key) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error("PDF HTTP " + res.status);
  const declared = Number(res.headers.get("content-length"));
  if (declared > 32 * 1024 * 1024) throw new Error("PDF exceeds 32 MiB");
  const bytes = new Uint8Array(await res.arrayBuffer());
  const byteLength = pdfProof(bytes, res.headers.get("content-type"));
  const digest = sha(bytes);
  const file = path.join(DOWNLOADS, "hscportal", slug(key) + ".pdf");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  // PDF.js may transfer/detach the backing buffer; hash and persist first,
  // then parse a private copy.
  const meta = await pdfMeta(new Uint8Array(bytes));
  return { sha256: digest, bytes: byteLength, pages: meta.pages, text: meta.text, file, contentType: res.headers.get("content-type"), verifiedAt: new Date().toISOString() };
}

async function verifyB2(viewno, title, key) {
  const { resolveFragments, sanitizeThscTitle } = await import("../ui/_lib/thsc-fragments.mjs");
  const result = await resolveFragments({ viewno: String(viewno), title: sanitizeThscTitle(title) }, { signal: AbortSignal.timeout(60000) });
  const bytes = result.bytes;
  const file = path.join(DOWNLOADS, "thsc", slug(key) + ".pdf");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  const meta = await pdfMeta(new Uint8Array(bytes));
  return { sha256: result.sha256, bytes: result.byteLength ?? bytes.length, pages: meta.pages, text: meta.text, file, contentType: "application/pdf", metadata: result.metadata, verifiedAt: new Date().toISOString() };
}

const PORTAL_SUBJECT_MAP = {
  "maths 2u": "Mathematics Advanced", "maths (2u)": "Mathematics Advanced",
  "maths ext 1": "Mathematics Extension 1", "maths ext 2": "Mathematics Extension 2",
  "standard maths": "Mathematics Standard", "general maths": "Mathematics Standard",
};
const portalSubject = (s) => PORTAL_SUBJECT_MAP[norm(s)] || s;
const levelFromPath = (cf) => /^yr12\//.test(cf) ? "HSC" : /^yr11\//.test(cf) ? "Preliminary" : /^yr10\//.test(cf) ? "Year 10" : /^yr9\//.test(cf) ? "Year 9" : "";
const typeFromPath = (cf) => /Assessments\//i.test(cf) ? "assessment" : /Trials\//i.test(cf) ? "trial" : /HSC\//i.test(cf) ? "hsc" : "other";

async function hscPortal() {
  const portal = JSON.parse(await fetchText(PORTAL_URL));
  const subjects = portal.subjects || [];
  const schools = portal.schools || [];
  const candidates = [];
  let raw = 0, urlMatched = 0, titleMatched = 0, identityMatched = 0;
  for (const e of portal.papers || []) {
    if (!e.v || !e.n || !e.cf) continue;
    raw++;
    const year = Number(e.y) || null;
    if (YEAR && year !== YEAR) continue;
    const url = "https://hscportal.pages.dev/" + e.cf.split("/").map(encodeURIComponent).join("/");
    if (knownUrls.has(url)) { urlMatched++; continue; }
    const subject = portalSubject(subjects[e.s] || "Miscellaneous");
    const indexedSchool = Number.isInteger(e.h) ? (schools[e.h] || "") : "";
    const title = decodeEnt(e.n);
    const school = schoolFromTitle(title) || indexedSchool || "NESA";
    const role = roleOf(title);
    const tk = titleNorm(title) + "|" + (year || "") + "|" + norm(school);
    if (knownTitle.has(tk)) { titleMatched++; continue; }
    const type = typeFromPath(e.cf);
    const level = levelFromPath(e.cf);
    const ik = [norm(subject), year || "", norm(school), norm(type), role,
      taskOf(title), paperPart(title)].join("|");
    if (knownIdentity.has(ik)) { identityMatched++; continue; }
    const id = `hscportal-${slug(e.v).slice(0, 24)}-${slug(title).slice(0, 50)}`;
    const candidate = {
      id, source: "hscportal", subject, level, year, school, type,
      title, hasSolutions: e.w === 1 || role !== "questions", viewno: String(e.v), linkText: e.n,
      url, sourceKeys: [`hscportal|${e.v}|${titleNorm(title)}`], hints: { portalRow: e.v, cf: e.cf },
      role, r2Upload: false,
    };
    candidates.push(candidate);
  }
  const limited = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  let ok = 0, failed = 0;
  if (VERIFY) {
    for (const c of limited) {
      try { c.proof = await verifyDirect(c.url, c.id); ok++; }
      catch (e) { c.verifyError = String(e.message || e); failed++; }
    }
  }
  const out = { generated: new Date().toISOString(), source: "hscportal", raw, urlMatched, titleMatched, identityMatched, candidates: limited, stats: { candidates: limited.length, verified: ok, failed } };
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, "hscportal.candidates.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify({ source: "hscportal", raw, urlMatched, titleMatched, identityMatched, candidates: limited.length, verified: ok, failed, file }, null, 2));
}

async function listingContext() {
  const { parseListing } = require("./build-index.cjs");
  const tree = JSON.parse(await fetchText(SOURCES.github.treeApi, { cacheFile: path.join(__dirname, ".cache", "growth", "tree.json") }));
  const pages = (tree.tree || []).map((e) => e.path).filter((p) => /^yr(9|10|11|12)\//.test(p) && /(trialpapers|hscpapers|assessment-tasks).*\.html$/i.test(p));
  const map = new Map();
  // Historical/uploaded feed collections may no longer have a listing page in
  // the current tree; retain their established catalogue context.
  for (const p of active) {
    if (p.viewno && !map.has(String(p.viewno))) map.set(String(p.viewno), {
      subject: p.subject, level: p.level || "", type: p.type || "other", page: "",
      examBlock: p.examBlock || "",
    });
  }
  for (const page of pages) {
    try {
      const cacheFile = path.join(__dirname, ".cache", "pages-" + slug(page) + ".html");
      const html = await fetchText(SOURCES.github.rawBase + "/" + page, { cacheFile });
      const r = parseListing(page, html);
      for (const e of r.entries) if (!map.has(e.viewno)) map.set(e.viewno, { subject: e.subject, level: e.level, type: e.type, page, examBlock: e.examBlock || "" });
    } catch (e) { console.log("listing context failed", page, String(e.message || e)); }
  }
  return map;
}

async function thscFeed() {
  const feed = await fetchText(FEED_URL);
  const entries = [...feed.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g)].map((m) => {
    const b = m[1];
    return {
      title: decodeEnt((b.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "").trim(),
      collection: ((b.match(/<collection>([\s\S]*?)<\/collection>/) || [])[1] || "").trim(),
    };
  });
  const portal = JSON.parse(await fetchText(PORTAL_URL));
  const portalExact = new Set((portal.papers || []).map((e) => String(e.v) + "|" + norm(e.n)));
  const context = await listingContext();
  const candidates = [];
  let missing = 0, portalMatches = 0;
  for (const e of entries) {
    if (!e.collection || !e.title) continue;
    if (knownView.has(e.collection + "|" + norm(e.title))) continue;
    missing++;
    const year = yearOf(e.title);
    const before = year ? e.title.slice(0, e.title.indexOf(String(year))).trim() : "";
    const school = before && !/^\d+$/.test(before) ? before.replace(/[-,]\s*$/, "").trim() : "NESA";
    const ctx = context.get(e.collection) || { subject: "Miscellaneous", level: "", type: "other", page: "" };
    const role = roleOf(e.title);
    const portalMatch = portalExact.has(e.collection + "|" + norm(e.title));
    if (portalMatch) portalMatches++;
    const type = ctx.type === "other" ? (/assessment/i.test(e.title) ? "assessment" : /trial/i.test(e.title) ? "trial" : "other") : ctx.type;
    const c = {
      id: `thsc-${e.collection}-${slug(e.title)}`,
      source: "thsc-feed", subject: ctx.subject, level: ctx.level || (type === "hsc" ? "HSC" : ""),
      year, school, type, title: e.title, hasSolutions: role !== "questions",
      viewno: String(e.collection), linkText: e.title,
      url: `https://www.thsconline.net/s/v/${encodeURIComponent(e.collection)}/${encodeURIComponent(e.title)}`,
      fallbackUrl: `https://www.thsconline.net/s/v/${encodeURIComponent(e.collection)}/${encodeURIComponent(e.title)}`,
      sourceKeys: [`${e.collection}|${norm(e.title)}`], hints: { listingPage: ctx.page, examBlock: ctx.examBlock || "", portalExact: portalMatch },
      role, portalExact: portalMatch, r2Upload: !portalMatch,
    };
    candidates.push(c);
  }
  const limited = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  let ok = 0, failed = 0;
  if (VERIFY) {
    for (const c of limited) {
      try { c.proof = await verifyB2(c.viewno, c.linkText, c.id); ok++; }
      catch (e) { c.verifyError = String(e.message || e); failed++; }
    }
  }
  const out = { generated: new Date().toISOString(), source: "thsc-feed", feedEntries: entries.length, missing, portalMatches, b2Only: missing - portalMatches, candidates: limited, stats: { candidates: limited.length, verified: ok, failed } };
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, "thsc-feed.candidates.json");
  fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify({ source: "thsc-feed", feedEntries: entries.length, missing, portalMatches, b2Only: missing - portalMatches, candidates: limited.length, verified: ok, failed, file }, null, 2));
}

(async () => {
  if (SOURCE === "hscportal") return hscPortal();
  if (SOURCE === "thsc-feed") return thscFeed();
  console.error("usage: node tools/growth-candidates.cjs --source=hscportal|thsc-feed [--verify] [--year=2026] [--limit=N]");
  process.exitCode = 2;
})().catch((e) => { console.error(e); process.exitCode = 1; });
