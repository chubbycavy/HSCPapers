/* content-census.cjs - the definitive duplicate-census scanner (v1.0.25).
   HEAD-only fingerprint pass over every catalogue row at per-host caps
   (the user-approved amendment 2026-10-10):
     hscportal.pages.dev 5 r/s | thsconline.com.au 3 r/s | others 2 r/s
     (boardofstudies, nsw.gov.au, 4unitmaths, aceh.b-cdn.net)
     crest 1 r/s | pool/router rows via production /proxy unchanged (own queue)
   Rows carrying sha256 proofs are SKIPPED (already proven).
   Fingerprint = HTTP HEAD status + Content-Length (+ETag). Same-length
   candidate pairs across DIFFERENT hosts AND same hosts get a full
   GET+SHA verification pass (only the candidates, never the catalogue).

   Output: tools/.cache/census/{state.json,dupes.json}
           dupes.json = the duplicate manifest for the builder's collapse
           pass: [{ groupType: "url"|"sha", id, url, sha256, ... }]

   Usage: node tools/content-census.cjs [--limit=N] [--verify-only] [--report]
   Resume: node tools/content-census.cjs   (state.json carries HEAD results) */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOOLS = __dirname;
const WORKDIR = path.join(TOOLS, ".cache", "census");
const STATE = path.join(WORKDIR, "state.json");
const DUPES = path.join(WORKDIR, "dupes.json");
const UA = { "User-Agent": "HSCPapers/1.0 (content census, HEAD fingerprints)", "Accept-Encoding": "identity" };

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const LIMIT = Number(argValue("--limit") || 0);
const VERIFY_ONLY = process.argv.includes("--verify-only");

/* per-host HEAD caps (r/s) - the approved amendment */
const CAPS = {
  "hscportal.pages.dev": 5, "hscportal.app": 5,
  "thsconline.com.au": 3,
  "www.boardofstudies.nsw.edu.au": 2, "boardofstudies.nsw.edu.au": 2,
  "www.nsw.gov.au": 2,
  "web.archive.org": 2, "aceh.b-cdn.net": 2, "4unitmaths.com": 2,
  "pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev": 5,
  "cresteconomics.com": 1,
  default: 2,
};
const POOL_HOSTS = new Set(["thsconline.github.io", "thsconline.pages.dev"]); // the resolver lanes ride /proxy (own queue)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const capFor = (host) => CAPS[host] != null ? CAPS[host] : CAPS.default;
const gapFor = (host) => Math.ceil(1000 / capFor(host));

(async () => {
  fs.mkdirSync(WORKDIR, { recursive: true });
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { state = { heads: {}, verified: {} }; }
  state.heads = state.heads || {};
  state.verified = state.verified || {};

  const papers = require("../ui/data/papers.json").papers;
  const rows = papers.filter((p) => p.url).map((p) => ({ id: p.id, url: p.url, sha: p.sha256 || null, mirror: p.mirror || p.source || null }));
  const start = Date.now();
  console.log(`census: ${rows.length} rows | sha-proved rows skipped: ${rows.filter((r) => r.sha).length}`);

  /* stage 1: HEAD pass, per-host parallel */
  const t0 = Date.now();
  const byHost = new Map();
  for (const r of rows) {
    let host;
    try { host = new URL(r.url).host; } catch { continue; }
    if (!byHost.has(host)) byHost.set(host, []);
    byHost.get(host).push(r);
  }
  if (!VERIFY_ONLY) {
    const work = LIMIT ? rows.slice(0, LIMIT) : rows.filter((r) => !r.sha);
    const hosts = [...new Set(work.map((r) => { try { return new URL(r.url).host; } catch { return null; } }).filter(Boolean))];
    console.log(`stage 1: ${work.length} rows across ${hosts.length} hosts`);
    const perHost = hosts.map((h) => {
      const list = work.filter((r) => { try { return new URL(r.url).host === h; } catch { return false; } });
      return (async () => {
        const gap = gapFor(h);
        let n = 0;
        for (const r of list) {
          if (state.heads[r.url]) { n++; continue; }
          try {
            const res = await fetch(r.url, { method: "HEAD", headers: UA, redirect: "follow", signal: AbortSignal.timeout(30000) });
            n++;
            state.heads[r.url] = { status: res.status, len: Number(res.headers.get("content-length") || 0), etag: res.headers.get("etag") || null, at: new Date().toISOString() };
            if (res.body) try { await res.body.cancel(); } catch { /* ok */ }
          } catch (e) {
            state.heads[r.url] = { status: 0, err: String(e && e.message).slice(0, 60), at: new Date().toISOString() };
          }
          if (n % 200 === 0) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
          await sleep(gap);
        }
        fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
        const ok = list.filter((r) => state.heads[r.url] && state.heads[r.url].status === 200).length;
        console.log(`  host ${h}: ${ok}/${list.length} heads ok in ${Math.round((Date.now() - t0) / 1000)}s`);
      })();
    });
    await Promise.all(perHost);
  }

  /* stage 2: same-length candidate pairs (both hashes equal => the pair is a
     byte-duplicate candidate; verify by GET+SHA where cheap) */
  const heads = state.heads;
  const byLen = new Map();
  for (const [url, h] of Object.entries(heads)) {
    if (h.status !== 200 || !h.len) continue;
    if (!byLen.has(h.len)) byLen.set(h.len, new Set());
    byLen.get(h.len).add(url);
  }
  const shaByUrl = new Map();
  for (const p of papers) { if (p.url && p.sha256) shaByUrl.set(p.url, p.sha256); }
  const candidatePairs = [];
  const urlRow = new Map(papers.map((p) => [p.url, p]));
  for (const [len, urls] of Object.entries(byLen)) {
    if (urls.size < 2) continue;
    const list = [...urls];
    for (let a = 0; a < list.length; a++) for (let b = a + 1; b < list.length; b++) {
      if (candidatePairs.length > 4000) break; // safety cap
      candidatePairs.push([list[a], list[b]]);
    }
  }
  console.log(`stage 2: ${candidatePairs.length} same-length pairs to verify`);

  /* stage 3: GET+SHA verification for the candidate pairs */
  const need = new Set();
  for (const [a, b] of candidatePairs) for (const u of [a, b]) if (!shaByUrl.has(u) && !state.verified[u]) need.add(u);
  console.log(`stage 3: ${need.size} urls need a full GET+SHA proof`);
  const byLen2 = [...need].sort();
  for (let i = 0; i < byLen2.length; i++) {
    const url = byLen2[i];
    let host;
    try { host = new URL(url).host; } catch { continue; }
    const gap = gapFor(host);
    let shaOut = null;
    try {
      const res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(60000) });
      const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
      shaOut = res.ok && buf.subarray(0, 5).toString("binary") === "%PDF-" ? crypto.createHash("sha256").update(buf).digest("hex") : "non-pdf:" + res.status;
      if (res.body) try { await res.body.cancel(); } catch { /* ok */ }
    } catch (e) { shaOut = "err:" + String(e && e.message).slice(0, 40); }
    state.verified[url] = { sha: shaOut, at: new Date().toISOString() };
    if (i % 25 === 0) fs.writeFileSync(STATE, JSON.stringify(state, null, 1));
    await sleep(gap);
  }
  fs.writeFileSync(STATE, JSON.stringify(state, null, 1));

  /* stage 4: the duplicate manifest (the builder's collapse input) */
  const urlSha = (u) => shaByUrl.get(u) || (state.verified[u] && !String(state.verified[u].sha).startsWith("err") && !String(state.verified[u].sha).startsWith("non-pdf") ? state.verified[u].sha : null);
  const statusOf = (u) => { const h = heads[u]; return h ? h.status : null; };
  const groups = [];
  // 1. url-level dupes stay url-groups
  // 2. length candidates -> sha-verified same-sha groups
  const pairVerified = [];
  for (const [a, b] of candidatePairs) {
    const sa = urlSha(a), sb = urlSha(b);
    if (sa && sb && sa === sb) {
      const ra = urlRow.get(a), rb2 = urlRow.get(b);
      const survivor = (ra && (ra.mirror || ra.source)) === "selfhost" ? ra : ((rb2 && (rb2.mirror || rb2.source)) === "selfhost" ? rb2 : ((ra && (ra.sha256)) ? ra : rb2));
      pairVerified.push({ type: "content", hash: sa, survivor: survivor && survivor.id, urls: [a, b], rows: { a: { id: ra && ra.id, fallbackUrl: ra && ra.fallbackUrl || null }, b: { id: rb2 && rb2.id, fallbackUrl: rb2 && rb2.fallbackUrl || null } } });
    }
  }
  fs.writeFileSync(DUPES, JSON.stringify({ generated: new Date().toISOString(), pairs: pairVerified }, null, 1) + "\n");
  console.log(`\nCENSUS DONE in ${Math.round((Date.now() - t0) / 1000)}s: duplicate groups (content) = ${pairVerified.length}`);
  for (const g of pairVerified.slice(0, 12)) {
    console.log(`  ${g.hash.slice(0, 10)}: ${g.survivor} vs ${g.rows.a.id === g.survivor ? g.rows.b.id : g.rows.a.id}`);
  }
})();
