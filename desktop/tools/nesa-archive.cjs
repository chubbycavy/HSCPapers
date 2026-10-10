/* nesa-archive.cjs - H1: the official-archive lane for the slow-route papers.
   Coverage split (probed 2026-10-10):
     - nsw.gov.au NESA pack pages LIVE: 2019-2026 on /<course-slug>/<year>,
       2014-2018 on /<course-slug>-archive/<year> (older years 404).
     - BOS self-describing pdf_doc files (cached pages, ~2007-2015): bonus lane.
     - 1967-2013 residue -> the Wayback lane (tools/wayback.cjs), NOT here.
   Byte proof everywhere: HTTP 200 + application/pdf + %PDF- + SHA-256 +
   PDF.js pages. Electing: ground-truth sha match first (tools/
   slow-route-truth.json), else lane order. Zero verified candidates =
   paper stays on the resolver and is reported for the Wayback lane.

   Modes:
     --scan        crawl pack pages (1 req/s, page-cached) -> candidates.json + report
     --verify      byte-proof candidates (resumable, 1 req/s) -> nesa-archive-verified.json
     --report-only scan without persisting; --limit=N; --refetch=id,id2

   Usage: node tools/nesa-archive.cjs --scan | --verify [--limit=N] [--refetch=id,id2] [--report-only] */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOOLS = __dirname;
const WORKDIR = path.join(TOOLS, ".cache", "nesa-archive");
const PAGES = path.join(WORKDIR, "pages");
const PROBES = path.join(WORKDIR, "probes.json");
const CANDS = path.join(WORKDIR, "candidates.json");
const OUT = path.join(TOOLS, "nesa-archive-verified.json");
const MISSES = path.join(WORKDIR, "misses.json");
const BASE = "https://www.nsw.gov.au/education-and-training/nesa/curriculum/hsc-exam-papers";
const UA = { "User-Agent": "HSCPapers/1.0 (nesa-archive verification)", "Accept-Encoding": "identity" };

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const MODE = process.argv.includes("--verify") ? "verify" : "scan";
const LIMIT = Number(argValue("--limit") || 0);
const REPORT_ONLY = process.argv.includes("--report-only");
const refetchIds = new Set(process.argv.includes("--refetch") ? String(argValue("--refetch") || "").split(",") : []);

const normKey = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* our subject -> NESA course slugs (cache-verified slug set, probed live + data.json-verified) */
const COURSE_ALIASES = {
  "mathematics advanced": ["mathematics"],             // pre-2019 course on the -archive pages; data.json "Mathematics" packs 2001-2018
  "mathematics standard": ["mathematics general"],     // pre-2019 the General course; data.json "Mathematics General" packs 2001-2018
  "mathematics extension 1": ["mathematics extension 1"],
  "mathematics extension 2": ["mathematics extension 2"],
  "earth and environmental science": ["earth and environmental science"],
  "english": ["english advanced", "english standard", "english-eald?"],  // variant resolved per paper by ROUTER path
  "english paper 1": ["english standard", "english advanced"],
  "japanese continuers": ["japanese continuers"],
  "japanese beginners": ["japanese beginners"],
  "japanese extension": ["japanese extension"],
  "latin continuers": ["latin continuers"],
  "latin extension": ["latin extension"],
  "society and culture": ["society and culture"],
  "legal studies": ["legal studies"],
  "physics": ["physics"],
};
function kindFor(title) {
  if (/sample answers/i.test(title)) return "sa";
  if (/notes from the marking centre/i.test(title)) return "nfc";
  if (/solutions|marking guideline/i.test(title)) return "mg";
  return "paper";
}
/* english variant: from the ROUTER URL path slug (titles carry no paper numbers) */
function routeVariantOf(p) {
  const tail = decodeURIComponent(String(p.url || "").split("/").pop() || "");
  const t = tail.toLowerCase();
  if (/\besl\b|\beal\b|\beald\b/.test(t)) return "esl";
  if (/paper-2|paper 2|p2/.test(t)) return /advanced|adv/.test(t) ? "adv-p2" : /standard|std/.test(t) ? "std-p2" : "p2";
  if (/paper-1|paper 1|p1/.test(t)) return "p1";
  if (/advanced|adv/.test(t)) return "adv";
  if (/standard|std/.test(t)) return "std";
  return null;
}
function variantsFor(p) {
  const nk = normKey(p.subject);
  let slugs = COURSE_ALIASES[nk];
  if (!slugs || !slugs.length) return [];
  slugs = slugs.filter((s) => s !== "english-eald?");
  if (nk === "english" || nk === "english paper 1") {
    const v = routeVariantOf(p);
    if (v === "esl") return ["english-eald"];
    if (v === "adv-p2" || v === "adv") return ["english advanced"];
    if (v === "std-p2" || v === "std") return ["english standard"];
    if (v === "p1" || v === "p2") return ["english standard", "english advanced"]; // p1 shared; p2 untagged -> try both
  }
  return slugs;
}
/* doc-text variant markers (pack page link text) */
function docVariantOf(text) {
  const t = text.toLowerCase();
  if (/\besl\b|\beal\/?d\b/.test(t)) return "esl";
  if (/paper 2/.test(t)) return /advance/.test(t) ? "adv-p2" : /standard/.test(t) ? "std-p2" : "p2";
  if (/paper 1/.test(t)) return "p1";
  return null;
}

/* ---- polite page cache: 1 req/s, writes-once ---- */
let lastFetch = 0;
async function fetchPage(url, cacheKey) {
  const file = path.join(PAGES, cacheKey + ".html");
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const gap = lastFetch + 1100 - Date.now();
  if (gap > 0) await sleep(gap);
  let res;
  try { res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(45000) }); }
  catch (e) { throw new Error("network: " + String(e && e.message).slice(0, 60)); }
  lastFetch = Date.now();
  if (!res.ok) { if (res.body) try { await res.body.cancel(); } catch { /* ok */ } throw new Error("HTTP " + res.status); }
  const html = await res.text();
  fs.writeFileSync(file, html);
  await sleep(900);
  return html;
}

/* ---- pack-page resolution ----
   2019+: /<slug>/<year>       (linked from the course page)
   2014-2018: /<slug>-archive/<year>  (linked from the -archive listing page)
   returns [{url, text}] for every pdf link on the pack page */
async function packPdfDocs(slug, year) {
  const urlSlug = slug.replace(/\s+/g, "-");
  const paths = [];
  if (year >= 2019) paths.push(`${urlSlug}/${year}`);
  else paths.push(`${urlSlug}-archive/${year}`, `${urlSlug}/${year}`);
  for (const tail of paths) {
    if (process.env.NESARCHIVE_DEBUG) console.log(`    [doc] pack try https://.../${tail}`);
    let html;
    try { html = await fetchPage(`${BASE}/${tail}`, `pack-${tail.replace(/\//g, "_")}`); }
    catch (e) { if (process.env.NESARCHIVE_DEBUG) console.log(`    [doc] pack fail ${tail}: ${String(e && e.message).slice(0, 60)}`); continue; }
    if (!/\.pdf/.test(html)) { if (process.env.NESARCHIVE_DEBUG) console.log(`    [doc] pack no-pdf ${tail} (len ${html.length})`); continue; }
    const docs = [];
    for (const a of html.matchAll(/<a\b[^>]*href="([^"]+\.pdf[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const href = a[1].replace(/&amp;/g, "&");
      const text = a[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      try { docs.push({ url: new URL(href, `${BASE}/${tail}/`).href, text }); } catch { /* skip */ }
    }
    if (docs.length) return docs;
  }
  return [];
}
const PACK_MEMBER = (text) => /sample answers/i.test(text) ? "sa"
  : /notes from the marking centre/i.test(text) ? "nfc"
  : /marking guidelines/i.test(text) ? "mg"
  : /marking feedback/i.test(text) ? "feedback"
  : /hsc exam/i.test(text) ? "paper"
  : null;
const ACCEPT = { paper: ["paper"], mg: ["mg", "feedback"], sa: ["sa"], nfc: ["nfc"] };

/* ---- BOS bonus lane (cached, self-describing files only; kind via filename) ---- */
function mineBosRows() {
  const CACHE = path.join(TOOLS, ".cache");
  const urls = new Set();
  for (const f of fs.readdirSync(CACHE)) {
    if (!/^bos-(\d{4})/.test(f)) continue;
    let html;
    try { html = fs.readFileSync(path.join(CACHE, f), "utf8"); } catch { continue; }
    for (const a of html.matchAll(/<a\b[^>]*href="([^"]+\.pdf)"[^>]*>/gi)) {
      try { urls.add(new URL(a[1].replace(/^\/\//, "https://"), "https://www.boardofstudies.nsw.edu.au/").href); } catch { /* skip */ }
    }
  }
  const rows = [];
  for (const u of urls) {
    const file = decodeURIComponent(u.split("/").pop() || "").toLowerCase();
    const m = file.match(/^(\d{4})[-_](.+?)\.pdf$/);
    if (!m) continue; // legacy cryptic names (<=2008 era) are the Wayback lane's problem
    let kind = "paper", token = m[2];
    if (/^(?:marking-guidelines?|marking-feedback|hsc-mg|marking-guide)-?/.test(token)) { kind = "mg"; token = token.replace(/^(?:marking-guidelines?|marking-feedback|hsc-mg|marking-guide)-?/, ""); }
    else if (/^sample-answers?-.?/.test(token)) { kind = "sa"; token = token.replace(/^sample-answers?-.?/, ""); }
    else if (/^notes-from-|^hsc-notes-/.test(token)) { kind = "nfc"; token = token.replace(/^(?:notes-from-(?:the-marking-centre-)?|hsc-notes-)/, ""); }
    else if (/^exam-report-|^review-|^specimen/.test(token)) continue;
    else if (/^(?:hsc-exam-|hsc-)/.test(token)) token = token.replace(/^(?:hsc-exam-|hsc-)/, "");
    token = token.replace(/&amp;/gi, " and ").replace(/&/g, " and ").replace(/\bamp\b/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
    if (/transcript|audio|listening|oral|specimen/.test(token)) continue;
    rows.push({ year: Number(m[1]), kind, token, url: u });
  }
  return rows;
}
/* token aliases per subject (grounded in the cache token survey) */
const BOS_TOKEN_RE = {
  "mathematics advanced": /^math(?:s|ematics)$/,
  "mathematics standard": /^general maths$|^general mathematics$|^mathematics general$/,
  "mathematics extension 1": /^maths ext$|^maths ext 1$|^mathematics ext1$|^maths-ext1$|^mathematics extension$/,
  "mathematics extension 2": /^maths ext 2$|^mathematics ext2$|^maths-ext2$|^mathematics extension 2$/,
  "earth and environmental science": /^earth env science$|^earth and env science$|^earth and environmental science$|^earth environmental science$/,
  "physics": /^physics$/,
  "japanese continuers": /^japanese contin?uers$|^japanese cont$/,
  "japanese beginners": /^japanese beginners$|^japanese beg$/,
  "japanese extension": /^japanese extension$|^japanese ext$/,
  "latin continuers": /^latin contin?uers$|^latin cont$/,
  "society and culture": /^society and culture$/,
  "legal studies": /^legal studies$/,
};

/* ---- byte-proof ---- */
let pdfjsReady = null;
function pdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = require("../ui/pdfjs/pdf.min.js");
    pdfjsReady.GlobalWorkerOptions.workerSrc = require.resolve("../ui/pdfjs/pdf.worker.min.js");
  }
  return pdfjsReady;
}
let lastFetch2 = 0;
async function probeUrl(url) {
  const gap = lastFetch2 + 1100 - Date.now();
  if (gap > 0) await sleep(gap);
  let res;
  try { res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(60000) }); }
  catch (e) { lastFetch2 = Date.now(); return { cls: "network", reason: String(e && e.message).slice(0, 60) }; }
  lastFetch2 = Date.now();
  await sleep(900);
  if (res.status === 429 || res.status === 503) { if (res.body) try { await res.body.cancel(); } catch { /* ok */ } return { cls: "throttled", retryAfter: Number(res.headers.get("retry-after") || 0) || 60 }; }
  if (res.status !== 200) { if (res.body) try { await res.body.cancel(); } catch { /* ok */ } return { cls: "http", status: res.status }; }
  const ct = res.headers.get("content-type") || "";
  if (!/^application\/pdf\b/i.test(ct)) { if (res.body) try { await res.body.cancel(); } catch { /* ok */ } return { cls: "not-pdf", ct: ct.slice(0, 30) }; }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 5).toString("binary") !== "%PDF-") return { cls: "not-pdf", ct: ct.slice(0, 30) };
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  let pages = null;
  try {
    const doc = await pdfjs().getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true }).promise;
    pages = doc.numPages;
    await doc.destroy();
  } catch { /* page proof optional */ }
  return { cls: "pdf", bytes: buf.length, pages, sha256 };
}

if (require.main === module) {
  (async () => {
  const t0 = Date.now();
  const catalogue = require("../ui/data/papers.json").papers;
  const truth = (() => { try { return JSON.parse(fs.readFileSync(path.join(TOOLS, "slow-route-truth.json"), "utf8")).entries || {}; } catch { return {}; } })();
  const slow = catalogue.filter((p) => p.url && /\/s\/[dvfz]\//.test(p.url));
  const usable = slow.filter((p) => truth[p.id] && (truth[p.id].ok || truth[p.id].withheld));
  console.log(`slow-route: ${slow.length} | with truth: ${usable.length}`);
  fs.mkdirSync(WORKDIR, { recursive: true });
  fs.mkdirSync(PAGES, { recursive: true });

  if (MODE === "scan") {
    const bosRows = mineBosRows();
    console.log(`bos bonus rows (self-describing): ${bosRows.length}`);
    const cands = {};
    const stats = { found: 0, none: 0, school: 0, unsupportedYear: 0 };
    const byYear = {};
    for (const p of usable) {
      if (LIMIT && Object.keys(cands).length >= LIMIT) break;
      const year = Number(p.year) || null;
      if (!year || year < 2007) { stats.unsupportedYear++; continue; } // live lane scope: 2007+ (pack pages 2014+; bos files 2009+) â€” pre-2007 is the Wayback lane
      const kind = kindFor(p.title);
      const slugs = variantsFor(p);
      const routeV = routeVariantOf(p);
      if (process.env.NESARCHIVE_DEBUG) console.log(`    [dbg] ${p.id} nk=${normKey(p.subject)} slugs=[${slugs.join("|")}] routeV=${routeV}`);
      const routeTail = normKey(decodeURIComponent(String(p.url || "").split("/").pop() || ""));
      const list = [];
      for (const slug of slugs) {
        try {
          const docs = await packPdfDocs(slug, year);
          const scored = [];
          for (const d of docs) {
            const k = PACK_MEMBER(d.text);
            if (!k || !ACCEPT[kind].includes(k)) continue;
            // english variant aligment: the route slug and the doc text must agree
            if (slug === "english advanced" || slug === "english standard") {
              const docV = docVariantOf(d.text);
              if (routeV && (routeV === "adv-p2" || routeV === "std-p2" || routeV === "adv" || routeV === "std")) {
                if (docV && docV !== routeV && !(docV === "p2" && (routeV === "adv-p2" || routeV === "std-p2"))) continue;
                if (!docV && routeV.includes("p2")) continue; // a paper-2 route needs an explicit paper-2 doc marker
              }
            }
            // feedback routes prefer the feedback doc over the guidelines doc
            const docScore = (/marking feedback/i.test(d.text) ? 1 : 0) + (/marking guidelines/i.test(d.text) ? 1 : 0) - (/feedback/i.test(routeTail) && !/feedback/i.test(d.text) ? 1 : 0) - (/guidelines/.test(routeTail) && /feedback/i.test(d.text) ? 1 : 0);
            scored.push({ url: d.url, lane: "nsw", kind: k, text: d.text.slice(0, 80), score: docScore });
          }
          scored.sort((a, b) => b.score - a.score);
          for (const s of scored) list.push(s);
        } catch (e) { console.log(`    pack fail ${slug}#${year}: ${String(e && e.message).slice(0, 70)}`); }
      }
      // bos bonus: self-describing filename matched against our subject token
      // (english excluded - variant resolution is title-driven there)
      const bosNk = normKey(p.subject);
      if (bosNk !== "english" && bosNk !== "english paper 1") {
        for (const u of BOS_BONUS_ELECT(bosRows, bosNk, year, kind)) list.push({ url: u, lane: "bos", kind, text: "bos pdf_doc (filename-classified)" });
      }
      const bucket = p.type === "trial" ? "school" : list.length ? "found" : "none";
      stats[bucket]++;
      byYear[year] = byYear[year] || { total: 0, found: 0 };
      byYear[year].total++;
      if (list.length) byYear[year].found++;
      const school = String(p.school || "").trim();
      const schoolish = (!!school && !/^nesa$/i.test(school)) || p.type === "assessment" || /\bassess|\bhalf\W|\byearly\b|\bhy\b/i.test(routeTail);
      const provider = /itute/i.test(routeTail) ? "itute" : null;
      cands[p.id] = { url: p.url, title: p.title, subject: p.subject, year, kind, type: p.type, schoolish, school, provider, routeTail, candidates: list };
    }
    if (!REPORT_ONLY) fs.writeFileSync(CANDS, JSON.stringify(cands, null, 1) + "\n");
    fs.writeFileSync(path.join(WORKDIR, "unsupported.json"), JSON.stringify({ generated: new Date().toISOString(), note: "years <2007 are the Wayback lane; papers skipped here by design", count: stats.unsupportedYear }, null, 1));
    console.log(`scan: found=${stats.found} none=${stats.none} school-trials=${stats.school} unsupportedYear(<2007)=${stats.unsupportedYear}`);
    for (const y of Object.keys(byYear).map(Number).sort((a, b) => a - b)) console.log(`  ${y}: ${byYear[y].found}/${byYear[y].total}`);
    return;
  }

  if (MODE === "verify") {
    let probes = {};
    try { probes = JSON.parse(fs.readFileSync(PROBES, "utf8")); } catch { /* fresh */ }
    let cands = {};
    try { cands = JSON.parse(fs.readFileSync(CANDS, "utf8")); } catch { console.error("no candidates.json - run --scan first"); process.exit(1); }
    let registry;
    try { registry = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {
      registry = { _doc: "Official archive lane (H1): slow-route router URLs -> verified OFFICIAL documents (nsw.gov.au NESA course-year pack pages + boardofstudies.nsw.edu.au self-describing pdf_doc files). Byte proof: HTTP 200 + application/pdf + %PDF- + SHA-256 + PDF.js pages. exact=true = elected bytes hash-equal the ground truth from tools/slow-route-truth.json; for withheld viewnos the (course, year, kind) match is the identity. Builder applies exact-URL only; the router URL remains fallbackUrl.", version: 1, entries: {} };
    }
    const prev = Object.keys(registry.entries).length;
    console.log(`verify: registry starts with ${prev} entries`);
    const work = usable.filter((p) => refetchIds.size ? refetchIds.has(p.id) : true);
    const counts = { exact: 0, kind: 0, failed: 0 };
    const failed = [];
    let i = 0;
    for (const p of work) {
      i++;
      const key = p.id;
      const existing = registry.entries[key];
      if (existing && existing.sha256 && !refetchIds.has(key)) continue;
      const rec = truth[key];
      const candRec = cands[key];
      const truthSha = rec.ok ? rec.sha256 : null;
      if (!candRec || !candRec.candidates.length) { failed.push({ id: key, reason: "no-scan-candidates" }); failed.length && counts.failed++; continue; }
      // never-serve-wrong-bytes gates:
      // (1) school rows may only elect docs whose text actually carries the school
      // (2) itute/provider rows may only elect same-provider docs (NESA pages never qualify)
      let pool = candRec.candidates;
      if (candRec.schoolish && candRec.school) {
        const tokens = normKey(candRec.school).split(/\s+/).filter(Boolean);
        pool = pool.filter((c) => { const t = normKey(c.text || ""); return t && tokens.every((w) => t.includes(w)); });
        if (!pool.length) { failed.push({ id: key, reason: "school rows must match a school-specific doc; year packs are a different paper" }); counts.failed++; continue; }
      }
      if (candRec.provider === "itute") {
        pool = pool.filter((c) => /independent|itute/i.test(c.text || ""));
        if (!pool.length) { failed.push({ id: key, reason: "itute routes need the provider doc; official packs are different files" }); counts.failed++; continue; }
      }
      let elected = null;
      for (const round of ["exact", "first"]) {
        for (const cand of pool) {
          let probe = probes[cand.url];
          if (!probe || !probe.cls) probe = probes[cand.url] = await probeUrl(cand.url);
          if (probe.cls === "throttled") { await sleep((probe.retryAfter + 5) * 1000); continue; }
          if (probe.cls !== "pdf") continue;
          if (round === "exact") {
            if (truthSha && probe.sha256 === truthSha) { elected = { cand, probe, exact: true }; break; }
          } else { elected = { cand, probe, exact: false }; break; }
        }
        if (elected) break;
      }
      if (elected) {
        counts[elected.exact ? "exact" : "kind"]++;
        registry.entries[key] = {
          key, url: elected.cand.url,
          sha256: elected.probe.sha256, bytes: elected.probe.bytes, pages: elected.probe.pages,
          lane: elected.cand.lane === "nsw" ? "nesa-archive" : "nesa-archive-bos",
          packText: elected.cand.text,
          kind: candRec.kind, subject: candRec.subject, year: candRec.year,
          exact: elected.exact,
          groundTruth: rec.ok ? { sha256: truthSha, bytes: rec.bytes } : { withheld: true, guardKind: rec.guardKind || null },
          verifiedAt: new Date().toISOString(),
        };
        if (Object.keys(registry.entries).length % 10 === 0) { fs.writeFileSync(OUT, JSON.stringify(registry, null, 1) + "\n"); fs.writeFileSync(PROBES, JSON.stringify(probes, null, 1)); }
        console.log(`[${i}/${work.length}] ELECT ${elected.exact ? "exact" : "kind "} ${key} ${(elected.probe.sha256 || "").slice(0, 8)} ${((elected.probe.bytes || 0) / 1024).toFixed(0)}KB ${elected.cand.lane}`);
      } else {
        counts.failed++;
        failed.push({ id: key, reason: "no-verified-candidate", candidates: candRec.candidates.map((c) => c.url) });
        console.log(`[${i}/${work.length}] MISS ${key}`);
      }
      if (i % 10 === 0) fs.writeFileSync(PROBES, JSON.stringify(probes, null, 1));
    }
    fs.writeFileSync(OUT, JSON.stringify(registry, null, 1) + "\n");
    fs.writeFileSync(PROBES, JSON.stringify(probes, null, 1));
    fs.writeFileSync(MISSES, JSON.stringify({ generated: new Date().toISOString(), failed }, null, 1) + "\n");
    console.log(`\nDONE: entries ${prev} -> ${Object.keys(registry.entries).length} | exact=${counts.exact} kind=${counts.kind} failed=${counts.failed} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  })().catch((e) => { console.error("nesa-archive crashed:", e); process.exit(2); });
} else {
  console.log("nesa-archive: loaded via require() - main gated on require.main; nothing executed");
}

/* applyVerified: the builder's lane hook. Re-points slow-route papers whose
   ids carry a verified row. Exact-URL only; the router stays as fallback trail. */
function applyVerified(papers, registry) {
  const verified = new Map();
  for (const [key, entry] of Object.entries((registry && registry.entries) || {})) {
    if (!/^https:\/\/(?:www\.)?(?:nsw\.gov\.au|boardofstudies\.nsw\.edu\.au)\//i.test(entry.url || "")) continue;
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || "")) continue;
    verified.set(key, entry);
  }
  let rewritten = 0;
  for (const p of papers) {
    const hit = verified.get(p.id);
    if (!hit) continue;
    p.fallbackUrl = p.fallbackUrl || p.url;
    p.url = hit.url;
    p.mirror = "nesa-archive";
    p.sha256 = hit.sha256;
    p.bytes = hit.bytes;
    rewritten++;
  }
  return rewritten;
}
module.exports = { applyVerified, verifiedRegistryPath: OUT };

/* BOS bonus electing: token aliases per our subject (grounded survey) */
function BOS_BONUS_ELECT(rows, nk, year, kind) {
  const re = BOS_TOKEN_RE[nk];
  if (!re) return [];
  const hits = rows.filter((r) => r.year === year && r.kind === kind && re.test(r.token));
  return hits.map((h) => h.url);
}
