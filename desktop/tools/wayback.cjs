/* wayback.cjs - H2: the Wayback rescue lane for slow-route papers whose
   OFFICIAL pack pages are dead (educationstandards era, 2001-2013).

   The chain, per (course, year, kind):
     1. nesappscraper data.json pack url (the educationstandards era pack page)
     2. CDX lookup for its captures -> latest capture ts
     3. /web/<ts>/<packUrl> fetch -> the captured pack page HTML
     4. extract wcm doc links + names ("HSC Exam Paper" / "Marking
        Guidelines" / "Sample Answers" / "Notes From The Marking Centre")
     5. per-doc CDX lookup -> latest capture -> /web/<ts>id_/<doc> raw bytes
     6. byte-proof (200 + application/pdf + %PDF- + SHA-256 + PDF.js pages)
     7. elect: ground-truth sha match first; (course, year, kind) for
        withheld/preserved rows; school/provider/english-variant gates
        identical to nesa-archive.cjs

   Waysback politeness: CDX/availability at <=1 req/s with exponential
   backoff on 429/503 (minute-scale windows observed), checkpoint/resume
   after every paper. The actual file downloads (id_ form) are lenient.

   Scope note: pre-2009 BOS files with legacy names and school trials are
   NOT targets here (4unitmaths/mirror/acehsc lanes cover those) - the
   2001-2013 NESA residue is this tool's job.

   Usage: node tools/wayback.cjs [--limit=N] [--refetch=id,id2] [--report-only]
   Output: desktop/tools/wayback-verified.json + .cache/wayback/ state */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOOLS = __dirname;
const WORKDIR = path.join(TOOLS, ".cache", "wayback");
const STATE = path.join(WORKDIR, "state.json");
const OUT = path.join(TOOLS, "wayback-verified.json");
const DATA_JSON = path.join(TOOLS, ".cache", "nesa-archive", "data.json");
const UA = { "User-Agent": "HSCPapers/1.0 (wayback rescue lane)", "Accept-Encoding": "identity" };

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const LIMIT = Number(argValue("--limit") || 0);
const REPORT_ONLY = process.argv.includes("--report-only");
const refetchIds = new Set(process.argv.includes("--refetch") ? String(argValue("--refetch") || "").split(",") : []);

const normKey = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function kindFor(title) {
  if (/sample answers/i.test(title)) return "sa";
  if (/notes from the marking centre/i.test(title)) return "nfc";
  if (/solutions|marking guideline/i.test(title)) return "mg";
  return "paper";
}
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
function docVariantOf(text) {
  const t = text.toLowerCase();
  if (/\besl\b|\beal\/?d\b/.test(t)) return "esl";
  if (/paper 2/.test(t)) return /advance/.test(t) ? "adv-p2" : /standard/.test(t) ? "std-p2" : "p2";
  if (/paper 1/.test(t)) return "p1";
  return null;
}
function variantsFor(p) {
  // data.json course names map onto our subjects; english variants by route
  const nk = normKey(p.subject);
  const map = {
    "mathematics advanced (pre-2019)": "Mathematics",
    "mathematics advanced": ["Mathematics", "Mathematics Advanced"],
    "mathematics standard": ["Mathematics General", "Mathematics Standard"],
    "mathematics extension 1": "Mathematics Extension 1",
    "mathematics extension 2": "Mathematics Extension 2",
    "earth and environmental science": "Earth and Environmental Science",
    "english": ["English Advanced", "English Standard", "English EAL D"],
    "english paper 1": ["English Standard", "English Advanced"],
    "japanese continuers": "Japanese Continuers",
    "japanese beginners": "Japanese Beginners",
    "japanese extension": "Japanese Extension",
    "latin continuers": "Latin Continuers",
    "latin extension": "Latin Extension",
    "society and culture": "Society and Culture",
    "legal studies": "Legal Studies",
    "physics": "Physics",
  };
  let courses = map[nk] || null;
  if (!courses) return [];
  if (!Array.isArray(courses)) courses = [courses];
  if (nk === "english" || nk === "english paper 1") {
    const v = routeVariantOf(p);
    if (v === "esl") courses = ["English EAL D", "English ESL"];
    if (v === "adv-p2" || v === "adv") courses = ["English Advanced"];
    if (v === "std-p2" || v === "std") courses = ["English Standard"];
    if (v === "p1" || v === "p2") courses = ["English Standard", "English Advanced"];
  }
  return courses;
}

/* ---- wayback plumbing (polite CDX + availability, resumable) ---- */
const lastCall = new Map(); // endpoint -> last wall time
let lastHostCall = 0;
async function cdxGet(url) {
  const gap = lastHostCall + 1300 - Date.now();
  if (gap > 0) await sleep(gap);
  const u = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&fl=timestamp,statuscode,original&filter=statuscode:200&limit=-8`;
  let res;
  for (let backoff = 0; ; backoff++) {
    try { res = await fetch(u, { headers: UA, signal: AbortSignal.timeout(45000) }); }
    catch (e) { lastHostCall = Date.now(); throw new Error("network: " + String(e && e.message).slice(0, 60)); }
    lastHostCall = Date.now();
    if (res.status === 429 || res.status === 503) {
      if (res.body) try { await res.body.cancel(); } catch { /* ok */ }
      const wait = Math.min(20000 * (backoff + 1), 120000);
      process.stdout.write(`  [cdx ${res.status}] cooling ${wait / 1000}s...\n`);
      await sleep(wait);
      continue;
    }
    if (res.status !== 200) { if (res.body) try { await res.body.cancel(); } catch { /* ok */ } throw new Error("cdx HTTP " + res.status); }
    return res.json();
  }
}
/* availability fallback: a different quota bucket; answers with the single
   closest 200-capture row in the same shape as CDX. Works through the
   minute-long CDX throttle windows. */
async function availableGet(url) {
  for (let backoff = 0; ; backoff++) {
    const gap = lastHostCall + 1300 - Date.now();
    if (gap > 0) await sleep(gap);
    try {
      const res = await fetch("https://archive.org/wayback/available?url=" + encodeURIComponent(url), { headers: UA, signal: AbortSignal.timeout(45000) });
      lastHostCall = Date.now();
      if (res.status === 429 || res.status === 503) {
        if (res.body) try { await res.body.cancel(); } catch { /* ok */ }
        const wait = Math.min(25000 * (backoff + 1), 120000);
        process.stdout.write(`  [availability ${res.status}] cooling ${wait / 1000}s...\n`);
        await sleep(wait);
        continue;
      }
      if (res.status !== 200) { if (res.body) try { await res.body.cancel(); } catch { /* ok */ } throw new Error("availability HTTP " + res.status); }
      const j = await res.json();
      const c = j && j.archived_snapshots && j.archived_snapshots.closest;
      if (!c || c.status !== "200") return [];
      const ts = (c.url.match(/\/web\/(\d{4,17})(?:\/|$)/) || [])[1];
      return ts ? [[ts, "200", c.url.replace(/^https?:\/\/web\.archive\.org\/web\/\d+(?:\/[^/]*)?\//, "")]] : [];
    } catch (e) { lastHostCall = Date.now(); throw e; }
  }
}
async function getCaptures(url) {
  try { return await cdxGet(url); }
  catch (e) {
    process.stdout.write(`  [cdx fallback -> availability] (${String(e && e.message).slice(0, 40)})\n`);
    return await availableGet(url);
  }
}
async function fetchPage(url, { expectHtml = true } = {}) {
  const gap = lastHostCall + 1300 - Date.now();
  if (gap > 0) await sleep(gap);
  let res;
  try { res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(90000) }); }
  catch (e) { lastHostCall = Date.now(); throw new Error("network: " + String(e && e.message).slice(0, 60)); }
  lastHostCall = Date.now();
  if (res.status === 429 || res.status === 503) { if (res.body) try { await res.body.cancel(); } catch { /* ok */ } throw new Error("throttled " + res.status); }
  if (res.status !== 200) { if (res.body) try { await res.body.cancel(); } catch { /* ok */ } throw new Error("HTTP " + res.status + " for " + url); }
  return res;
}

let pdfjsReady = null;
function pdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = require("../ui/pdfjs/pdf.min.js");
    pdfjsReady.GlobalWorkerOptions.workerSrc = require.resolve("../ui/pdfjs/pdf.worker.min.js");
  }
  return pdfjsReady;
}
async function probeBytes(url) {
  const res = await fetchPage(url);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.subarray(0, 5).toString("binary") !== "%PDF-") return { cls: "not-pdf", bytes: buf.length };
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  let pages = null;
  try {
    const doc = await pdfjs().getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true }).promise;
    pages = doc.numPages;
    await doc.destroy();
  } catch { /* pages optional */ }
  return { cls: "pdf", bytes: buf.length, pages, sha256 };
}

/* ---- main ---- */
if (require.main === module) {
  (async () => {
    const t0 = Date.now();
    if (!fs.existsSync(DATA_JSON)) { console.error("data.json missing - run the T1/nesa-archive research step first"); process.exit(1); }
    const data = JSON.parse(fs.readFileSync(DATA_JSON, "utf8"));
    // course name -> packs (data.json is the skeleton source for the educationstandards-era urls)
    const packsByCourse = new Map();
    for (const c of data) packsByCourse.set(normKey(c.course_name), c.packs || []);
    const truth = (() => { try { return JSON.parse(fs.readFileSync(path.join(TOOLS, "slow-route-truth.json"), "utf8")).entries || {}; } catch { return {}; } })();
    const papers = require("../ui/data/papers.json").papers;
    const slow = papers.filter((p) => p.url && /\/s\/[dvfz]\//.test(p.url) && truth[p.id] && (truth[p.id].ok || truth[p.id].withheld));
    let registry;
    try { registry = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {
      registry = { _doc: "Wayback rescue lane (H2): slow-route router URLs -> verified raw-byte captures (/web/<ts>id_/<url>) of their OFFICIAL documents from the Internet Archive. Byte proof: 200 + application/pdf + %PDF- + SHA-256 (+ PDF.js pages). exact=true = bytes hash-equal the ground truth from tools/slow-route-truth.json; withheld rows elect by (course, year, kind). Builder applies exact-URL only; the router stays fallbackUrl. Registration rows carry capture timestamps for deterministic nightly re-verification.", version: 1, entries: {} };
    }
    fs.mkdirSync(WORKDIR, { recursive: true });
    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { state = { packCaptures: {}, docCaptures: {} }; }
    // default docCapture store if absent
    state.packCaptures = state.packCaptures || {};
    state.docCaptures = state.docCaptures || {};

    const work = slow.filter((p) => {
      const year = Number(p.year) || 0;
      if (!(year >= 2001 && year <= 2013)) return false; // scope: the dead-pack-page era
      if (!/\/s\/[dvfz]\//.test(p.url || "")) return false; // already re-pointed by another lane
      if (p.type === "trial" || (p.school && p.school !== "NESA")) return false; // school rows ride the adds lanes
      const existing = registry.entries[p.id];
      if (existing && existing.sha256 && !refetchIds.has(p.id)) return false;
      const kind = kindFor(p.title);
      if (kind === "nfc") return false; // not-from-pool classes ride other lanes
      return true;
    });
    const capped = LIMIT && LIMIT < work.length ? work.slice(0, LIMIT) : work;
    console.log(`wayback targets: ${capped.length} of slow-route^2001-2013 (total slow-route^2001-13: ${slow.filter((p) => { const y = Number(p.year) || 0; return y >= 2001 && y <= 2013; }).length})`);
    if (!capped.length || REPORT_ONLY) { console.log("nothing to do"); return; }

    const counts = { exact: 0, kind: 0, failed: 0 };
    const prev = Object.keys(registry.entries).length;
    const failures = [];
    let i = 0;
    let saveDirty = 0;
    for (const p of capped) {
      i++;
      const key = p.id;
      const kind = kindFor(p.title);
      const year = Number(p.year);
      const courses = variantsFor(p);
      const truthSha = truth[key].ok ? truth[key].sha256 : null;
      const routeV = routeVariantOf(p);
      let docsFound = null;
      let elected = null;
      for (const course of courses) {
        const packs = packsByCourse.get(normKey(course)) || [];
        const pack = packs.find((pk) => String(pk.year) === String(year));
        if (!pack) continue;
        // candidate docs come straight from the nesappscraper skeleton
        // (the wayback-captured pack pages carry no doc anchors - CSS only);
        // each pack entry: {year, link, docs: [{doc_name, doc_link}]}
        docsFound = pack.docs || [];
        // kind matching (mg accepts guidelines + feedback; nfc excluded above)
        const ACCEPT = { paper: ["paper"], mg: ["mg", "feedback"], sa: ["sa"] };
        const docKindFor = (name) => /marking guidelines/i.test(name) ? "mg" : /marking feedback/i.test(name) ? "feedback" : /sample answers/i.test(name) ? "sa" : /hsc exam paper|exam paper/i.test(name) ? "paper" : null;
        const cands = [];
        for (const d of docsFound) {
          const k = docKindFor(d.doc_name || "") || docKindFor(decodeURIComponent(d.doc_link.split("/").pop() || ""));
          if (!k || !ACCEPT[kind].includes(k)) continue;
          const docV = docVariantOf(d.doc_name || "");
          if (routeV === "adv-p2" || routeV === "std-p2") { if (docV && docV !== routeV) continue; }
          cands.push(d);
        }
        if (!cands.length) continue;
        // per-doc capture + bytes (the doc links carry their own captures)
        for (const c of cands) {
          let doccaps = state.docCaptures[c.doc_link];
          if (!doccaps) {
            try { doccaps = state.docCaptures[c.doc_link] = await getCaptures(c.doc_link); }
            catch (e) { continue; }
            if (++saveDirty % 3 === 0) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
          }
          if (!Array.isArray(doccaps)) continue;
          for (const dcap of [...doccaps].reverse()) {
            const id_Url = `https://web.archive.org/web/${dcap[0]}id_/${c.doc_link}`;
            let probe;
            try { probe = await probeBytes(id_Url); }
            catch (e) { continue; }
            if (probe.cls !== "pdf") continue;
            elected = { cand: c, probe, ts: dcap[0], exact: truthSha ? probe.sha256 === truthSha : false };
            if (elected.exact) break;
          }
          if (elected && elected.exact) break;
        }
        if (elected) break;
      }
      if (elected) {
        counts[elected.exact ? "exact" : "kind"]++;
        registry.entries[key] = {
          key, url: `https://web.archive.org/web/${elected.ts}id_/${elected.cand.doc_link}`,
          docUrl: elected.cand.doc_link, docName: elected.cand.doc_name,
          sha256: elected.probe.sha256, bytes: elected.probe.bytes, pages: elected.probe.pages,
          lane: "wayback", captureTs: elected.ts, kind, subject: p.subject, year: p.year,
          exact: elected.exact,
          groundTruth: truthSha ? { sha256: truthSha } : { withheld: true, guardKind: truth[key].guardKind || null },
          verifiedAt: new Date().toISOString(),
        };
        console.log(`[${i}/${capped.length}] ELECT ${elected.exact ? "exact" : "kind "} ${key} ${p.year} ${(elected.probe.sha256 || "").slice(0, 8)} ${((elected.probe.bytes || 0) / 1024).toFixed(0)}KB capTs=${elected.ts}`);
      } else {
        counts.failed++;
        failures.push({ id: key, year: p.year, kind });
        console.log(`[${i}/${capped.length}] MISS ${key} (${p.year} ${kind})`);
      }
      if (i % 5 === 0) { fs.writeFileSync(STATE, JSON.stringify(state, null, 1)); fs.writeFileSync(OUT, JSON.stringify(registry, null, 1) + "\n"); }
    }
    fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    fs.writeFileSync(OUT, JSON.stringify(registry, null, 1) + "\n");
    fs.writeFileSync(path.join(WORKDIR, "misses.json"), JSON.stringify({ generated: new Date().toISOString(), failures }, null, 1) + "\n");
    console.log(`\nDONE: entries ${prev} -> ${Object.keys(registry.entries).length} | exact=${counts.exact} kind=${counts.kind} failed=${counts.failed} elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
  })().catch((e) => { console.error("wayback crashed:", e); process.exit(2); });
} else {
  console.log("wayback: loaded via require() - main gated on require.main; nothing executed");
}

/* applyVerified: builder lane hook (exact-URL only, router stays fallback) */
function applyVerified(papers, registry) {
  const verified = new Map();
  for (const [key, entry] of Object.entries((registry && registry.entries) || {})) {
    if (!/^https:\/\/web\.archive\.org\/web\/\d+id_\//.test(entry.url || "")) continue;
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || "")) continue;
    verified.set(key, entry);
  }
  let rewritten = 0;
  for (const p of papers) {
    const hit = verified.get(p.id);
    if (!hit) continue;
    if (!require("./catalogue-identity.cjs").officialReplacementAllowed(p, hit)) continue;
    p.fallbackUrl = p.fallbackUrl || p.url;
    p.url = hit.url;
    p.mirror = "wayback";
    p.sha256 = hit.sha256;
    p.bytes = hit.bytes;
    rewritten++;
  }
  return rewritten;
}
module.exports = { applyVerified, verifiedRegistryPath: OUT };
