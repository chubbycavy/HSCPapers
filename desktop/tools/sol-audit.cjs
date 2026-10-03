/* sol-audit.cjs — comprehensive solution-link audit + recovery sweep.
 *
 * Sweeps EVERY distinct catalogue solutionUrl (plus the solFallbackUrl values
 * the reader may retry), classifies each by live byte-check (%PDF magic), then
 * mines recovery candidates for the broken ones from:
 *   1. the cached NESA course/year pages (.cache/nesa-recovery/{page,sol,slow}-*.html)
 *      — marking-guideline / marking-feedback PDFs per (course, year)
 *   2. the cached BOS index inventory (bos-*.html -> mg/sa/nfc kinds)
 *   3. Wayback (CDX) snapshots of the dead educationstandards URLs — probe-first,
 *      verified with the id_ raw-bytes form before acceptance
 * Verified candidates are written to the CUMULATIVE registry with --apply as
 * solution-keys (dead solutionUrl -> live document). Default: report-only.
 *
 * Usage: node desktop/tools/sol-audit.cjs [--apply] [--skip-wayback]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const CACHE = path.join(__dirname, ".cache");
const NESACACHE = path.join(CACHE, "nesa-recovery");
const CATALOGUE = path.join(__dirname, "..", "ui", "data", "papers.json");
const OUT = path.join(__dirname, "nesa-recovery.json");
const DEAD_OUT = path.join(__dirname, "dead-solutions.json");
const REPORT = path.join(CACHE, "sol-audit-report.json");
const UA = { "User-Agent": "HSCPapers/1.0 (study use; cached index, on-demand downloads)" };
const APPLY = process.argv.includes("--apply");
const SKIP_WAYBACK = process.argv.includes("--skip-wayback");
const PROBE_CACHE = path.join(CACHE, "sol-audit-probes.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* Resumable probe cache: url -> result. Saved incrementally so an
   interrupted sweep continues instead of redoing finished work. */
let probeCache = {};
try { probeCache = JSON.parse(fs.readFileSync(PROBE_CACHE, "utf8")); } catch { /* first run */ }
let cacheDirty = 0;
function cacheGet(url, stage) { return probeCache[`${stage}|${url}`]; }
function cacheSet(url, stage, val) { probeCache[`${stage}|${url}`] = val; if (++cacheDirty % 40 === 0) { try { fs.writeFileSync(PROBE_CACHE, JSON.stringify(probeCache)); } catch { /* best-effort */ } } }
function cacheFlush() { try { fs.writeFileSync(PROBE_CACHE, JSON.stringify(probeCache)); } catch { /* best-effort */ } }

function narrate(msg) { console.log(msg); }

async function pool(items, workers, fn, staggerMs) {
  const results = new Array(items.length);
  let next = 0, launched = 0;
  async function worker() {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      if (launched++ > 0) await sleep(staggerMs);
      try { results[i] = await fn(items[i], i); } catch (e) { results[i] = { error: String(e?.message || e) }; }
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

/* Follow up to 3 manual redirects, then a ranged GET for the magic bytes.
   Class: live-pdf | html | dead (4xx) | http-error | unreachable */
async function classify(url, depth = 0) {
  try {
    const res = await fetch(url, { method: "GET", redirect: "manual", headers: { ...UA, Range: "bytes=0-15" }, signal: AbortSignal.timeout(20000) });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get("location");
      if (!loc || depth >= 3) return { cls: "html", trail: [`${res.status} -> ${loc || "?"}`], final: url };
      const next = new URL(loc, url).href;
      const out = await classify(next, depth + 1);
      out.trail = [`${res.status} -> ${loc}`, ...(out.trail || [])];
      return out;
    }
    if (res.status >= 200 && res.status < 300) {
      const type = res.headers.get("content-type") || "";
      let head = "";
      try { if (res.body) { const reader = res.body.getReader(); const { value } = await reader.read(); head = Buffer.from(value || []).toString("latin1"); await reader.cancel().catch(() => {}); } } catch { /* no body */ }
      if (/^\s*%PDF/.test(head) || /application\/pdf/i.test(type)) return { cls: "live-pdf", type, trail: [], final: url };
      if (/text\/html|application\/xhtml/i.test(type) || /^\s*<(!doctype|html|\{)/i.test(head)) return { cls: "html", type, trail: [], final: url };
      return { cls: "other", type, head: head.slice(0, 12), trail: [], final: url };
    }
    if (res.status === 404 || res.status === 410) return { cls: "dead", status: res.status, trail: [], final: url };
    return { cls: "http-error", status: res.status, trail: [], final: url };
  } catch (e) {
    return { cls: "unreachable", error: String(e?.message || e).slice(0, 80), trail: [], final: url };
  }
}

/* Mine every cached NESA page: (courseNk, year) -> distinct pdf urls */
function mineNesaPages() {
  const byYear = new Map(); // "nk|year" -> Set<url>
  const add = (nk, year, url) => {
    if (!nk || !year) return;
    const k = `${nk}|${year}`;
    if (!byYear.has(k)) byYear.set(k, new Set());
    byYear.get(k).add(url);
  };
  for (const f of fs.readdirSync(NESACACHE)) {
    let m = f.match(/^page-(.+)-(\d{4})-\d+\.html$/);
    if (m) { mineFile(path.join(NESACACHE, f), m[1], m[2], add); continue; }
    m = f.match(/^(?:sol|slow)-(.+)-(\d{4})\.html$/);
    if (m) mineFile(path.join(NESACACHE, f), m[1], m[2], add);
  }
  return byYear;
}
function mineFile(file, nk, year, add) {
  try {
    const html = fs.readFileSync(file, "utf8");
    for (const mm of html.matchAll(/href="([^"]*\.pdf[^"]*)"/gi)) {
      try { add(nk, year, new URL(mm[1], "https://www.nsw.gov.au/education-and-training/nesa/curriculum/hsc-exam-papers/x").href); } catch { /* bad href */ }
    }
  } catch { /* unreadable cache file */ }
}

/* Cached BOS inventory (same parse as legacy-probe.cjs) */
function mineBosPages() {
  const stripTags = (s) => s.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ");
  const bosKindFor = (text) =>
    /marking guideline/i.test(text) ? "mg" :
    /sample answer/i.test(text) ? "sa" :
    /notes from the marking centre/i.test(text) ? "nfc" :
    /transcript|audio|listening|oral|specimen|workbook/i.test(text) ? null : "paper";
  const map = new Map(); // "nk|year|kind" -> url
  let filesSeen = 0;
  for (const f of fs.readdirSync(CACHE)) {
    const m = f.match(/^bos-(\d{4})-(?:wayback-)?(.+)-html\.html$/);
    if (!m) continue;
    const year = Number(m[1]);
    let html;
    try { html = fs.readFileSync(path.join(CACHE, f), "utf8"); } catch { continue; }
    for (const r of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const firstCell = stripTags((r[1].split(/<\/td>|<\/th>/i)[0] || "")).replace(/[\u2013\u2014]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      const subject = normKey(firstCell);
      if (!subject) continue;
      for (const a of r[1].matchAll(/<a\b[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const kind = bosKindFor(stripTags(a[2]));
        if (!kind) continue;
        let abs;
        try { abs = new URL(a[1].replace(/^\/\//, "https://"), "https://www.boardofstudies.nsw.edu.au/").href; } catch { continue; }
        if (!/^https:/.test(abs)) continue;
        const key = `${subject}|${year}|${kind}`;
        if (!map.has(key)) map.set(key, abs);
        filesSeen++;
      }
    }
  }
  narrate(`bos inventory: ${filesSeen} pdf links -> ${map.size} (nk|year|kind) keys`);
  return map;
}

/* Wayback: nearest 200 capture for this URL via the availability redirect
   (the CDX API rate-limits aggressively; the /web/<year>/<url> endpoint
   answers with a 302 whose Location carries the capture timestamp). The
   returned id_ form serves the ORIGINAL bytes (no archive chrome) — verified
   for %PDF magic before acceptance. */
async function waybackCandidate(url) {
  try {
    const probe = `https://web.archive.org/web/2024/${url}`;
    const res = await fetch(probe, { method: "GET", redirect: "manual", headers: { ...UA, Range: "bytes=0-15" }, signal: AbortSignal.timeout(25000) });
    if (res.status === 429) { await sleep(15000); return waybackCandidate(url); }
    if (![301, 302, 303, 307, 308].includes(res.status)) {
      // 200 = the /web/ endpoint served bytes itself; 404 = no capture
      if (res.status === 200) {
        let head = "";
        try { if (res.body) { const reader = res.body.getReader(); const { value } = await reader.read(); head = Buffer.from(value || []).toString("latin1"); await reader.cancel().catch(() => {}); } } catch { /* no body */ }
        return /^\s*%PDF/.test(head) ? res.url || probe : null;
      }
      return null;
    }
    const loc = res.headers.get("location") || "";
    const m = loc.match(/\/web\/(\d{4,14})\//);
    if (!m) return null;
    return `https://web.archive.org/web/${m[1]}id_/${url}`;
  } catch { return null; }
}

(async () => {
  const t0 = Date.now();
  const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, "utf8")).papers;

  // ---- 1. population ----
  const withSol = catalogue.filter((p) => p.solutionUrl);
  const distinctSols = [...new Set(withSol.map((p) => p.solutionUrl))];
  const deadPrimaryEntries = withSol.filter((p) => /educationstandards|wcm\/connect/.test(p.solutionUrl));
  const distinctFallbacks = [...new Set(deadPrimaryEntries.filter((p) => p.solFallbackUrl).map((p) => p.solFallbackUrl))];
  narrate(`sweep: ${withSol.length} entries carry solutionUrl (${distinctSols.length} distinct) · ${deadPrimaryEntries.length} on the dead host class · ${distinctFallbacks.length} distinct fallbacks`);
  const entriesOf = new Map(); // url -> [ids]
  for (const p of withSol) { if (!entriesOf.has(p.solutionUrl)) entriesOf.set(p.solutionUrl, []); entriesOf.get(p.solutionUrl).push(p.id); }

  // ---- 2. probe everything (resumable via the probe cache) ----
  const all = [...distinctSols, ...distinctFallbacks];
  const uncached = all.filter((u) => !cacheGet(u, "probe"));
  narrate(`probing ${all.length} distinct urls (${uncached.length} uncached, 6 workers, 100ms stagger)…`);
  let done = 0;
  await pool(uncached, 6, async (u) => {
    const r = await classify(u);
    // definitive classes cache; transient ones (http-error/unreachable) retry on the next run
    if (!["http-error", "unreachable"].includes(r.cls)) cacheSet(u, "probe", r);
    if (++done % 100 === 0) narrate(`  probed ${done}/${uncached.length}…`);
    return r;
  }, 100);
  cacheFlush();
  const cls = new Map();
  all.forEach((u) => cls.set(u, cacheGet(u, "probe") || { cls: "unreachable" }));
  const tally = {};
  for (const r of cls.values()) tally[r.cls] = (tally[r.cls] || 0) + 1;
  narrate(`probe tally (solutionUrls + fallbacks): ${JSON.stringify(tally)}`);

  // broken = anything not live-pdf, restricted to PRIMARY solution urls
  const broken = distinctSols.filter((u) => cls.get(u).cls !== "live-pdf");
  narrate(`broken solutionUrls: ${broken.length} (${[...new Set(broken.map((u) => cls.get(u).cls))].join(", ")})`);

  // ---- 3. candidates from the local caches ----
  const nesaByYear = mineNesaPages();
  const bosMap = mineBosPages();
  const pairs = new Map(); // "subject|year" -> [{ deadUrl, entryId }]
  for (const u of broken) {
    for (const id of entriesOf.get(u)) {
      const p = catalogue.find((x) => x.id === id);
      if (!p || !p.year) continue;
      const k = `${normKey(p.subject)}|${p.year}`;
      if (!pairs.has(k)) pairs.set(k, []);
      pairs.get(k).push({ deadUrl: u, entryId: id });
    }
  }
  narrate(`broken (nk|year) pairs: ${pairs.size}`);
  const markingRe = /-mg-|-marking|-feedback|guideline|sample-answer|sample_answers|notes-from|-sa-|-nfc-/i;
  const candByDeadUrl = new Map();
  const distinctCandidates = new Map(); // url -> { source }
  for (const [k, list] of pairs) {
    const [nk, yearStr] = k.split("|");
    const cands = [];
    for (const u of nesaByYear.get(k) || []) if (markingRe.test(u) && u !== list[0].deadUrl) cands.push(u);
    for (const kind of ["mg", "sa", "nfc"]) {
      const u = bosMap.get(`${nk}|${yearStr}|${kind}`);
      if (u) cands.push(u);
    }
    const best = cands.find((u) => cls.get(u)?.cls === "live-pdf") || null;
    if (best) { for (const it of list) candByDeadUrl.set(it.deadUrl, best); distinctCandidates.set(best, { source: "cache" }); }
  }
  let cacheHits = candByDeadUrl.size;
  narrate(`cache-mined candidates (pre-verify): ${cacheHits} of ${broken.length} broken urls`);

  // ---- 4. wayback for the rest ----
  const waybackTargets = broken.filter((u) => !candByDeadUrl.has(u) && /educationstandards\.nsw\.edu\.au/.test(u));
  if (!SKIP_WAYBACK && waybackTargets.length) {
    narrate(`wayback sweep: ${waybackTargets.length} urls (2 workers, 600ms stagger — archive.org rate bucket)…`);
    let wdone = 0, wfound = 0;
    await pool(waybackTargets, 2, async (u) => {
      let s = cacheGet(u, "wb");
      if (s === undefined) { s = await waybackCandidate(u); cacheSet(u, "wb", s); await sleep(600); }
      if (s) { distinctCandidates.set(s, { source: "wayback" }); candByDeadUrl.set(u, s); wfound++; }
      if (++wdone % 100 === 0) { narrate(`  wayback ${wdone}/${waybackTargets.length} · found ${wfound}…`); cacheFlush(); }
      return s;
    }, 600);
    cacheFlush();
    narrate(`wayback candidates: ${wfound}`);
  }

  // ---- 5. verify ALL distinct candidates live (ranged magic check) ----
  const candList = [...distinctCandidates.keys()].filter((u) => cacheGet(u, "verify") === undefined);
  for (const u of [...distinctCandidates.keys()]) {
    const cached = cacheGet(u, "verify");
    if (cached !== undefined) distinctCandidates.set(u, { ...distinctCandidates.get(u), verified: cached?.cls === "live-pdf", cls: cached?.cls });
  }
  narrate(`verifying ${candList.length} distinct candidates (uncached of ${distinctCandidates.size})…`);
  const verResults = await pool(candList, 6, async (u) => {
    const r = await classify(u);
    cacheSet(u, "verify", r);
    return r;
  }, 100);
  cacheFlush();
  const verified = new Map(); // deadUrl -> liveUrl (only %PDF-verified)
  for (const [u, meta] of distinctCandidates) {
    const r = cacheGet(u, "verify");
    if (r?.cls !== "live-pdf") continue;
    for (const [dead, cand] of candByDeadUrl) if (cand === u && cls.get(dead)?.cls !== "live-pdf") verified.set(dead, u);
  }
  narrate(`verified candidates: ${verified.size} of ${candByDeadUrl.size} dead urls matched`);

  // ---- 6. report (+ apply) ----
  const byYear = {};
  for (const [dead] of verified) {
    const id = (entriesOf.get(dead) || [])[0];
    const p = catalogue.find((x) => x.id === id);
    if (p?.year) byYear[p.year] = (byYear[p.year] || 0) + 1;
  }
  const report = {
    generated: new Date().toISOString(),
    apply: APPLY, skipWayback: SKIP_WAYBACK,
    probed: all.length,
    probeTally: tally,
    broken: broken.length,
    brokenList: broken.map((u) => ({ url: u, cls: cls.get(u).cls, entries: (entriesOf.get(u) || []).length, trail: cls.get(u).trail?.slice(0, 2) })),
    cacheHits, waybackSwept: SKIP_WAYBACK ? 0 : waybackTargets.length,
    verified: verified.size, byYear,
    registry: Object.fromEntries([...verified].map(([dead, live]) => {
      const id = (entriesOf.get(dead) || [])[0];
      const p = catalogue.find((x) => x.id === id);
      return [dead, { url: live, title: p?.title || "", solution: true }];
    })),
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 1));
  narrate(`report: ${REPORT} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);

  if (APPLY) {
    /* 6a. dead-solutions blacklist: the LIVE-STATE map of broken solution
       urls. The builder clears solutionUrl/hasSolutions on listed entries;
       a later audit removes entries whose urls probed live again. This is
       the honest fix when no recovery source exists (NESA's wcm archive
       has no live equivalent and no wayback capture). */
    const deadReg = (() => { try { return JSON.parse(fs.readFileSync(DEAD_OUT, "utf8")); } catch { return { _doc: "", generated: "", urls: {} }; } })();
    let addedD = 0, removedD = 0;
    const now = new Date().toISOString();
    for (const u of distinctSols) {
      const c = cls.get(u)?.cls;
      const isDead = c && c !== "live-pdf";
      const had = !!deadReg.urls[u];
      if (isDead && !had) { deadReg.urls[u] = { cls: c, firstSeen: now }; addedD++; }
      if (!isDead && had) { delete deadReg.urls[u]; removedD++; }
    }
    deadReg._doc = "Broken solution urls (live-probed by sol-audit.cjs). The builder clears solutionUrl/hasSolutions for listed urls. Entries are REMOVED when a later audit probes the url live again — never hand-edit; re-run the audit.";
    deadReg.generated = now;
    fs.writeFileSync(DEAD_OUT, JSON.stringify(deadReg, null, 1) + "\n");
    narrate(`dead-solutions blacklist: ${Object.keys(deadReg.urls).length} urls (+${addedD} / -${removedD})`);
  }

  if (APPLY && verified.size) {
    const reg = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const before = Object.keys(reg.entries).length;
    let added = 0;
    for (const [dead, live] of verified) {
      if (reg.entries[dead]?.url === live) continue;
      const id = (entriesOf.get(dead) || [])[0];
      const p = catalogue.find((x) => x.id === id);
      reg.entries[dead] = { url: live, title: p?.title || "", solution: true };
      added++;
    }
    reg.generated = new Date().toISOString();
    fs.writeFileSync(OUT, JSON.stringify(reg, null, 1) + "\n");
    narrate(`registry: ${before} -> ${Object.keys(reg.entries).length} entries (+${added})`);
  } else if (!APPLY) {
    narrate("[report-only — registry not written; re-run with --apply to write verified recoveries]");
  }
})();
