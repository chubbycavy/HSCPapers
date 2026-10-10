/* dedupe.cjs - the ingest gate for catalogue adds (no cap, gates only).
   Reads candidate manifests (tools/.cache/discover/*.candidates.json from
   the discover modules), byte-proofs every candidate (HTTP 200 +
   application/pdf + %PDF- + SHA-256 (+ PDF.js pages)), then classes:

     ADD      proof ok + sha ∉ catalogue (all registered primary/solution
              sha proofs) + url ∉ catalogue + no exact tuple hit
     REVIEW   proof ok but the (subject, school, year, type) tuple already
              exists with a DIFFERENT sha (a parallel/genuine-new paper -
              needs human eyes before ingest)
     REJECT   no proof / sha or url duplicate / wrong-bytes-class rows
              (school rows claiming pack docs, provider mismatches)

   Writes .cache/dedupe/{accepted.json,rejected.json,review.json}; prints
   per-source tallies. Also reports the duplicate-primary-URL baseline (the
   ~60 nesa-recovery artifacts) for the cleanup side-quest.

   Usage: node tools/dedupe.cjs [--limit=N] [--report-only]
   (candidates come from the discover manifests; see discover.cjs) */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOOLS = __dirname;
const DISCOVER = path.join(TOOLS, ".cache", "discover");
const WORKDIR = path.join(TOOLS, ".cache", "dedupe");
const PROBES = path.join(WORKDIR, "probes.json");
const ACCEPTED = path.join(WORKDIR, "accepted.json");
const REJECTED = path.join(WORKDIR, "rejected.json");
const REVIEWED = path.join(WORKDIR, "review.json");
const UA = { "User-Agent": "HSCPapers/1.0 (dedupe ingest gate)", "Accept-Encoding": "identity" };
const ALLOWED_HOSTS = /^https:\/\/(?:[^/]*\.)?(?:nsw\.gov\.au|boardofstudies\.nsw\.edu\.au|thsconline\.com\.au|aceh\.b-cdn\.net|4unitmaths\.com|cresteconomics\.com)\//i;

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const LIMIT = Number(argValue("--limit") || 0);
const REPORT_ONLY = process.argv.includes("--report-only");

const normKey = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const tupleOf = (c) => `${normKey(c.subject)}|${normKey(c.school)}|${c.year}|${c.type}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pdfjsReady = null;
function pdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = require("../ui/pdfjs/pdf.min.js");
    pdfjsReady.GlobalWorkerOptions.workerSrc = require.resolve("../ui/pdfjs/pdf.worker.min.js");
  }
  return pdfjsReady;
}
let lastFetch = 0;
async function probeUrl(url) {
  const gap = lastFetch + 1100 - Date.now();
  if (gap > 0) await sleep(gap);
  let res;
  try { res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(60000) }); }
  catch (e) { lastFetch = Date.now(); return { cls: "network", reason: String(e && e.message).slice(0, 60) }; }
  lastFetch = Date.now();
  await sleep(900);
  if (res.status === 429 || res.status === 503) { if (res.body) try { await res.body.cancel(); } catch { /* ok */ } return { cls: "throttled", retryAfter: Number(res.headers.get("retry-after") || 0) || 30 }; }
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
  } catch { /* pages optional */ }
  return { cls: "pdf", bytes: buf.length, pages, sha256 };
}

(async () => {
  const t0 = Date.now();
  fs.mkdirSync(WORKDIR, { recursive: true });
  if (!fs.existsSync(DISCOVER)) { console.error("candidates missing - run discover.cjs first"); process.exit(1); }
  let probes = {};
  try { probes = JSON.parse(fs.readFileSync(PROBES, "utf8")); } catch { /* fresh */ }
  // union of every discover manifest
  const cands = [];
  for (const f of fs.readdirSync(DISCOVER)) {
    if (!/\.candidates\.json$/.test(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(DISCOVER, f), "utf8"));
      for (const c of j.candidates || []) cands.push({ source: j.source || f.replace(/\.candidates\.json$/, ""), ...c });
    } catch { /* skip unreadable */ }
  }
  const work = LIMIT ? cands.slice(0, LIMIT) : cands;
  console.log(`dedupe: ${work.length} of ${cands.length} candidates to gate`);
  if (!work.length) return;

  // catalogue reference sets
  const catalogue = require("../ui/data/papers.json").papers;
  const knownUrls = new Set(), knownShas = new Set(), tuples = new Map();
  for (const p of catalogue) {
    if (p.url) knownUrls.add(p.url);
    if (p.solutionUrl) knownUrls.add(p.solutionUrl);
    if (p.sha256) knownShas.add(p.sha256);
    const t = `${normKey(p.subject)}|${normKey(p.school)}|${p.year}|${p.type}`;
    tuples.set(t, (tuples.get(t) || 0) + 1);
  }
  // duplicate-primary baseline report (side quest)
  const urlCounts = new Map();
  for (const p of catalogue) if (p.url) urlCounts.set(p.url, (urlCounts.get(p.url) || 0) + 1);
  const dupPrimary = [...urlCounts.entries()].filter(([, n]) => n > 1);

  const accepted = [], rejected = [], reviewed = [];
  const tallies = {};
  const pending = [...work];
  const deferred = [];
  let deferralRounds = 0;
  let i = 0, passN = 0;
  while (pending.length && deferralRounds < 3) {
    if (!pending.length) break;
    passN++;
    const batch = pending.splice(0, pending.length);
    for (const c of batch) {
      i++;
      const deny = (reason) => {
        tallies[c.source] = tallies[c.source] || { add: 0, review: 0, reject: 0 };
        tallies[c.source].reject++;
        rejected.push({ source: c.source, reason, candidate: c });
      };
      if (!c.url || !ALLOWED_HOSTS.test(c.url)) { deny("host not on the approved lane list"); continue; }
      if (knownUrls.has(c.url)) { deny("url duplicate in catalogue"); continue; }
      let probe = probes[c.url];
      // transient classes are never trusted from the cache - re-probe them
      if (probe && (probe.cls === "throttled" || probe.cls === "network")) delete probes[c.url];
      if (!probe || !probe.cls) {
        const r = await probeUrl(c.url);
        if (r.cls === "throttled" || r.cls === "network") { deferred.push(c); console.log(`  [deferred] ${c.url.slice(-52)} (${r.cls})`); continue; }
        probes[c.url] = r;
      }
      probe = probes[c.url];
      if (probe.cls !== "pdf") { deny("no byte proof: " + probe.cls); continue; }
      if (knownShas.has(probe.sha256)) { deny("sha duplicate in catalogue"); continue; }
      const t = tupleOf(c);
      knownShas.add(probe.sha256); // prevents same-file re-detection within the pass
      const row = { ...c, sha256: probe.sha256, bytes: probe.bytes, pages: probe.pages, checkedAt: new Date().toISOString() };
      if (tuples.has(t)) {
        tallies[c.source] = tallies[c.source] || { add: 0, review: 0, reject: 0 };
        tallies[c.source].review++;
        reviewed.push({ ...row, existingTupleCount: tuples.get(t) });
      } else {
        tuples.set(t, (tuples.get(t) || 0) + 1);
        tallies[c.source] = tallies[c.source] || { add: 0, review: 0, reject: 0 };
        tallies[c.source].add++;
        accepted.push(row);
      }
      if (i % 20 === 0) {
        fs.writeFileSync(PROBES, JSON.stringify(probes, null, 1));
        fs.writeFileSync(ACCEPTED, JSON.stringify({ accepted }, null, 1) + "\n");
        console.log(`  [${i} probed / pass ${passN} ${batch.length}] ${accepted.length} add / ${reviewed.length} review / ${rejected.length} reject (deferred ${deferred.length})`);
      }
    }
    if (deferred.length) { deferralRounds++; console.log(`  [pass done] ${deferred.length} deferred -> round ${deferralRounds + 1}`); pending.push(...deferred.splice(0, deferred.length)); }
  }
  // anything still deferred after the passes: recorded as transient (rerun resumes them)
  for (const c of deferred) {
    rejected.push({ source: c.source, reason: "deferred - pool throttled; rerun resumes", candidate: c });
  }
  fs.writeFileSync(PROBES, JSON.stringify(probes, null, 1));
  fs.writeFileSync(ACCEPTED, JSON.stringify({ generated: new Date().toISOString(), accepted }, null, 1) + "\n");
  fs.writeFileSync(REJECTED, JSON.stringify({ generated: new Date().toISOString(), rejected }, null, 1) + "\n");
  fs.writeFileSync(REVIEWED, JSON.stringify({ generated: new Date().toISOString(), reviewed }, null, 1) + "\n");
  console.log(`\nDEDUPE DONE (${Math.round((Date.now() - t0) / 1000)}s): add=${accepted.length} review=${reviewed.length} reject=${rejected.length} deferred=${deferred.length}`);
  for (const [src, t] of Object.entries(tallies)) console.log(`  ${src}: add=${t.add} review=${t.review} reject=${t.reject}`);
  console.log(`\nINFO: duplicate-primary-URL baseline in catalogue: ${dupPrimary.length} urls carrying ${dupPrimary.reduce((n, [, c]) => n + c, 0)} rows (the known ~60-artifact cleanup backlog; report only)`);
})();
