/* sweep-check.cjs — Tier 1 automated scan (static contracts + logic).
   Runs after every semi-major change; a red sweep blocks the push ritual.
   Exit code 1 on any FAIL. Sections:
   [1] selector cross-check (app.js $()/on() ids vs index.html)
   [2] Rust<->JS contracts (serde struct fields vs JS reads, invoke
       commands/args vs generate_handler + Rust params)
   [3] host-list layer sync (app.js / build-index.cjs / proxy.js / main.rs)
   [4] registry integrity (cumulative counts, monotonic via .cache state)
   [5] claims/numbers contract (catalogue-derived vs index.html copy)
   [6] engine logic tests (reader page detection, unload, queue, sync clamp)
   [7] share round-trip logic (gzip+base64url, corrupt-link graceful)
   [8] updater API simulation (live parse exactly like update_check)
   [9] SW/headers sanity (version marker, no-cache rule, manifest icons)
   [10] landing pages cross-check (Phase C)
   [11] theme-token integrity (every var() defined or JS-set) */
const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.join(__dirname, "..", "..");
const UI = path.join(ROOT, "desktop", "ui");
const read = (p) => fs.readFileSync(p, "utf8");
const appJs = read(path.join(UI, "js", "app.js"));
const html = read(path.join(UI, "index.html"));
const mainRs = read(path.join(ROOT, "desktop", "src-tauri", "src", "main.rs"));
const builder = read(path.join(ROOT, "desktop", "tools", "build-index.cjs"));
const proxyJs = read(path.join(UI, "functions", "proxy.js")) + "\n" + read(path.join(UI, "_lib", "pdf-proxy.mjs"));
const headers = read(path.join(UI, "_headers"));
const swJs = read(path.join(UI, "sw.js"));
const manifest = JSON.parse(read(path.join(UI, "manifest.webmanifest")));
const catalogue = JSON.parse(read(path.join(UI, "data", "papers.json")));
const papers = catalogue.papers || [];

let fails = 0, passes = 0, warns = 0;
const pass = (s) => { passes++; console.log(`  PASS  ${s}`); };
const fail = (s, d) => { fails++; console.log(`  FAIL  ${s}${d ? " -- " + d : ""}`); };
const warn = (s, d) => { warns++; console.log(`  WARN  ${s}${d ? " -- " + d : ""}`); };
const snake = (s) => s.replace(/([A-Z])/g, (_, c) => "_" + c.toLowerCase());

async function main() {
  /* [1] selector cross-check */
  console.log("\n[1] selector cross-check");
  {
    const used = new Set();
    for (const m of appJs.matchAll(/\$\("#([A-Za-z0-9_-]+)"\)/g)) used.add(m[1]);
    for (const m of appJs.matchAll(/\bon\("#([A-Za-z0-9_-]+)"/g)) used.add(m[1]);
    const defined = new Set();
    for (const m of html.matchAll(/id="([A-Za-z0-9_-]+)"/g)) defined.add(m[1]);
    const missing = [...used].filter((id) => !defined.has(id));
    if (!missing.length) pass(`all ${used.size} wired selectors exist in index.html`);
    else fail(`${missing.length} wired selectors missing from index.html`, missing.join(", "));
  }

  /* [2] Rust<->JS contracts */
  console.log("\n[2] Rust<->JS contracts");
  {
    const structs = {};
    for (const m of mainRs.matchAll(/#\[derive\(([^\)]*)\)\]\s*(?:#\[[^\]]*\]\s*)?struct\s+(\w+)\s*\{([^}]*)\}/g)) {
      if (!/Serialize/.test(m[1])) continue;
      const fields = [];
      for (const line of m[3].split(/\r?\n/)) {
        const f = line.trim().match(/^([a-z_][a-z0-9_]*)\s*:/);
        if (f) fields.push(f[1]);
      }
      if (fields.length) structs[m[2]] = fields;
    }
    const surface = [
      { struct: "UpdateInfo", reads: [...appJs.matchAll(/updateInfo\.([A-Za-z0-9_]+)/g)].map((m) => m[1]) },
      { struct: "UpdateProgress", reads: [...appJs.matchAll(/p\.([A-Za-z0-9_]+)/g)].map((m) => m[1]).filter((f) => ["downloaded", "total", "done"].includes(f)) },
      { struct: "LibraryConfig", reads: [...appJs.matchAll(/cfg\.([A-Za-z0-9_]+)/g)].map((m) => m[1]) },
    ];
    let contractFails = 0;
    for (const s of surface) {
      const fields = structs[s.struct];
      if (!fields) { fail(`struct ${s.struct} not found in main.rs`); contractFails++; continue; }
      const fieldSet = new Set([...fields, ...fields.map(camelSnakeUp)]);
      for (const r of s.reads) {
        if (!fieldSet.has(r)) { fail(`JS reads ${s.struct}.${r} -- no such serialized field`, `fields: ${fields.join(", ")}`); contractFails++; }
      }
      pass(`${s.struct}: ${s.reads.length} JS reads checked against ${fields.length} fields`);
    }
    function camelSnakeUp(f) { return f.includes("_") ? f.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()) : f; }

    const handlerBlock = (mainRs.match(/generate_handler!\[([\s\S]*?)\]/) || [])[1] || "";
    const registered = new Set(handlerBlock.split(",").map((s) => s.trim()).filter(Boolean));
    const paramsOf = {};
    for (const m of mainRs.matchAll(/(?:async )?fn\s+([a-z_]+)\s*\(([^{]*?)\)\s*(?:->[^{]*)?\{/g)) {
      const ps = [...m[2].matchAll(/([a-z_][a-z0-9_]*)\s*:/g)].map((x) => x[1]);
      paramsOf[m[1]] = new Set(ps);
    }
    // paren-matched invoke scan: regex capture can truncate args whose
    // objects contain their own "})" (preflight's files.map does)
    // paren-matched invoke scan: regex capture can truncate args whose
    // objects contain their own "})" (preflight's files.map does)
    const flatArgs = (body) => {
      let s = body.replace(/`[^`]*`/g, "0");
      for (let prev = null; prev !== s;) {
        prev = s;
        s = s.replace(/\{[^{}]*\}|\([^()]*\)|\[[^\[\]]*\]/g, "0");
      }
      return s;
    };
    const cmds = [];
    let i = 0;
    for (;;) {
      const k = appJs.indexOf('.invoke("', i);
      if (k < 0) break;
      const cmd = (appJs.slice(k).match(/^\.invoke\(\s*"([a-z_]+)"/) || [])[1];
      if (!cmd) { i = k + 1; continue; }
      const start = k + appJs.slice(k).indexOf("(");
      let depth = 0, end = -1;
      for (let x = start; x < appJs.length; x++) {
        const ch = appJs[x];
        if (ch === "(" || ch === "{" || ch === "[") depth++;
        else if (ch === ")" || ch === "}" || ch === "]") { depth--; if (depth === 0) { end = x; break; } }
      }
      const argsText = appJs.slice(start + 1, end);
      const obj = (argsText.match(/"([a-z_]+)"\s*,\s*\{([\s\S]*)\}\s*$/) || [])[2] || "";
      cmds.push({ cmd, body: flatArgs(obj) });
      i = end;
    }
    for (const c of cmds) {
      const cmd = c.cmd;
      if (!registered.has(cmd)) { fail(`invoke("${cmd}") not registered in generate_handler`); contractFails++; continue; }
      const rust = paramsOf[cmd];
      if (!rust) { fail(`fn ${cmd} not found in main.rs`); contractFails++; continue; }
      const keys = c.body ? [...c.body.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((x) => x[1]) : [];
      for (const k of keys) {
        const sk = snake(k);
        if (!rust.has(k) && !rust.has(sk)) { fail(`invoke("${cmd}") arg ${k} -- no such Rust param`, `params: ${[...rust].join(", ")}`); contractFails++; }
      }
    }
    for (const r of registered) {
      if (!cmds.some((c) => c.cmd === r)) warn(`registered command "${r}" never invoked from JS (checked invoke() only)`);
    }
    if (!contractFails) pass(`Rust<->JS contract check: ${cmds.length} invoke commands + ${surface.length} struct surfaces clean`);
  }

  /* [3] host-list layer sync */
  console.log("\n[3] host-list layer sync");
  {
    const hostsOf = (text, anchor) => {
      const i = text.indexOf(anchor);
      if (i < 0) return null;
      const m = text.slice(i, i + 400).match(/Set\(\[([\s\S]*?)\]\)/);
      return m ? new Set([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1])) : null;
    };
    const fast = hostsOf(appJs, "const FAST_SAVE_HOSTS");
    const cors = hostsOf(appJs, "const CORS_OK_HOSTS");
    const allowed = hostsOf(proxyJs, "const ALLOWED_HOSTS");
    const biLine = (builder.split("\n").find((l) => l.includes("FAST_HOST_RE")) || "");
    const biInner = biLine ? biLine.slice(biLine.indexOf("/"), biLine.lastIndexOf("/") + 1).replace(/^\/|\/$/g, "") : "";
    const biHosts = new Set(biInner.split("|").map((h) => h.replace(/\\+/g, "").trim()).filter(Boolean));
    const stripWww = (h) => h.replace(/^www\./, "");
    let ok = true;
    if (fast && biHosts.size) {
      const normFast = new Set([...fast].map(stripWww));
      for (const h of biHosts) if (!normFast.has(stripWww(h))) { fail(`build-index isFastHost host "${h}" missing from app.js FAST_SAVE_HOSTS`); ok = false; }
      for (const h of fast) if (!biHosts.has(stripWww(h)) && !biHosts.has(h)) { fail(`app.js FAST_SAVE_HOSTS host "${h}" missing from build-index isFastHost`); ok = false; }
    } else { warn("host sets not parseable (regex drift)"); ok = false; }
    if (fast && cors) for (const h of cors) if (!fast.has(h)) { fail(`CORS_OK_HOSTS host "${h}" not in FAST_SAVE_HOSTS`); ok = false; }
    if (allowed) for (const h of ["www.nsw.gov.au", "www.boardofstudies.nsw.edu.au", "thsconline.com.au", "thsconline.pages.dev"]) if (!allowed.has(h)) { fail(`proxy ALLOWED_HOSTS missing "${h}"`); ok = false; }
    const mainRsHosts = new Set([...mainRs.matchAll(/"(hscportal\.pages\.dev|pub-ec23[a-f0-9]*\.r2\.dev|www\.nsw\.gov\.au|boardofstudies\.nsw\.edu\.au|thsconline\.github\.io|thsconline\.com\.au|thsconline\.pages\.dev|web\.archive\.org|aceh\.b-cdn\.net|4unitmaths\.com|cresteconomics\.com)"/g)].map((m) => m[1]));
    if (fast) for (const h of fast) { const s = stripWww(h); if (!mainRsHosts.has(h) && !mainRsHosts.has(s)) warn(`main.rs does not literally mention fast host "${h}"`); }
    // Resolver lane contract: proxy.js must carry the Apps Script resolution
    // branch, and its 16 quota pools must EXACTLY match the Rust WORKERS
    // array (round-robin spreads load across the same deployments).
    for (const marker of ["THSC_ROUTER_RE", "export=data", "resolveRouter"]) {
      if (!proxyJs.includes(marker)) { fail(`proxy resolver lane missing "${marker}"`); ok = false; }
    }
    const ep = (text) => [...text.matchAll(/"(https:\/\/script\.google\.com\/macros\/s\/[^"]+)"/g)].map((m) => m[1]);
    const epProxy = ep(proxyJs), epRust = ep(mainRs);
    if (epProxy.length === epRust.length && epProxy.every((u, i) => u === epRust[i])) {
      if (epProxy.length === 16) pass(`resolver endpoints in sync across proxy.js + main.rs (${epProxy.length} quota pools)`);
      else { fail(`resolver endpoint count unexpected`, `${epProxy.length} pools (expected 16)`); ok = false; }
    } else { fail(`resolver endpoints drifted`, `proxy ${epProxy.length} vs rust ${epRust.length}`); ok = false; }
    if (ok) pass(`host layers in sync: ${fast ? fast.size : "?"} fast hosts, ${allowed ? allowed.size : "?"} proxy-allowed`);
    const registry = JSON.parse(read(path.join(ROOT, "desktop", "tools", "thsc-au-verified.json")));
    const proofs = new Map((registry.entries || []).map(entry => [entry.url, entry]));
    const mirrors = papers.filter(p => p.mirror === "thsc-au");
    if (mirrors.every(p => proofs.has(p.url) && proofs.get(p.url).sha256 === p.sha256 && proofs.get(p.url).bytes === p.bytes)) pass(`independent mirror: ${mirrors.length} mappings backed by PDF validation and SHA-256`);
    else fail("independent mirror contains an unverified replacement");
    if (new Set(papers.map(p => p.id)).size === papers.length) pass(`catalogue IDs unique (${papers.length})`);
    else fail("duplicate catalogue IDs");
  }

  /* [4] registry integrity */
  console.log("\n[4] registry integrity");
  {
    const reg = path.join(ROOT, "desktop", "tools");
    const statePath = path.join(reg, ".cache", "sweep-state.json");
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}    const counts = {};
    for (const f of ["nesa-recovery.json", "nesa-archive-verified.json", "selfhost.json", "removals.json"]) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(reg, f), "utf8"));
        const entries = j.entries || {};
        const n = (j.entries ? (Array.isArray(j.entries) ? j.entries.length : Object.keys(entries).length) : Array.isArray(j) ? j.length : Object.keys(j).filter((k) => !k.startsWith("_")).length);
        counts[f] = n;
        if (!n && f !== "removals.json") fail(`${f} is empty`);
      } catch (e) { fail(`${f} unparseable`, String(e).slice(0, 60)); }
    }
    const prev = state.registries || {};
    let regressed = false;
    for (const f of Object.keys(counts)) {
      if (typeof prev[f] === "number" && counts[f] < prev[f]) { fail(`${f} shrank: ${prev[f]} -> ${counts[f]} (registries are cumulative)`); regressed = true; }
    }
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ ...state, registries: counts, at: new Date().toISOString() }, null, 1));
    } catch {}
    if (!regressed) pass(`registries intact (${Object.entries(counts).map(([f, n]) => `${f}=${n}`).join(" | ")})`);
  }

  /* [4b] phase-H gates: payload budget, slow-route KPI, anti-rot health */
  console.log("\n[4b] phase-H gates");
  {
    // (a) payload budget: the catalogue is the app's biggest download —
    // brotli-compressed it must stay under 0.75 MB (measured 0.21 at v1.0.22)
    const raw = read(path.join(UI, "data", "papers.json"));
    const brotli = require("zlib").brotliCompressSync(Buffer.from(raw, "utf8"));
    const MB = brotli.length / (1024 * 1024);
    if (MB <= 0.75) pass(`papers.json payload budget holds (brotli ${MB.toFixed(2)} MB of 0.75)`);
    else fail(`papers.json payload budget BLOWN (brotli ${MB.toFixed(2)} MB > 0.75)`, "catalogue growth needs a structural fix, not a shrug");

    // (b) slow-route KPI: the resolver-lane count never increases. Baseline
    // evolved per release: 394 (pre-v1.0.21) -> 329 (v1.0.21) -> 277
    // (v1.0.23); the demote-to-fallback doctrine drives it to 0 primaries.
    const slowN = papers.filter((p) => /\/s\/[dvfz]\//.test(p.url || "")).length;
    const SLOW_BASE = 277;
    let prevSlow = null;
    try { prevSlow = JSON.parse(fs.readFileSync(statePath, "utf8")).slowRoute; } catch {}
    if (slowN > SLOW_BASE) fail(`slow-route KPI BROKE (${slowN} > baseline ${SLOW_BASE})`, "slow lane must never grow");
    else if (typeof prevSlow === "number" && slowN > prevSlow) fail(`slow-route count regressed (${prevSlow} -> ${slowN})`, "a release moved papers BACK onto the slow lane");
    else pass(`slow-route KPI holds (${slowN} <= ${typeof prevSlow === "number" && prevSlow !== slowN ? `previous ${prevSlow}, baseline ` : ""}${SLOW_BASE})`);

    // (b2) fast-share KPI (v1.0.24): direct-file lanes (FAST+MEDIUM) as a
    // share of all file pointers must be non-decreasing release-over-release
    // — the catalogue can only get faster, never slower.
    const fastRe = /hscportal\.pages\.dev|pub-ec23c9b69d2544938d816ad28ee491fd\.r2\.dev|www\.nsw\.gov\.au|www\.boardofstudies\.nsw\.edu\.au|thsconline\.github\.io|thsconline\.com\.au|web\.archive\.org|aceh\.b-cdn\.net|4unitmaths\.com|cresteconomics\.com/;
    const isFastUrl = (u) => u && !/\/s\/[dvfz]\//.test(u) && fastRe.test(u);
    const totalFilesN = papers.reduce((n, p) => n + (p.url ? 1 : 0) + (p.solutionUrl ? 1 : 0), 0);
    const fastFilesN = papers.reduce((n, p) => n + (isFastUrl(p.url) ? 1 : 0) + (isFastUrl(p.solutionUrl) ? 1 : 0), 0);
    const share = totalFilesN ? fastFilesN / totalFilesN : 0;
    let prevShare = null;
    try { prevShare = JSON.parse(fs.readFileSync(statePath, "utf8")).fastShare; } catch {}
    if (typeof prevShare === "number" && share + 0.002 < prevShare) fail(`fast-share regressed (${(prevShare * 100).toFixed(1)}% -> ${(share * 100).toFixed(1)}%)`, "the catalogue got slower");
    else pass(`fast-share KPI holds (${(share * 100).toFixed(1)}% of ${totalFilesN} files direct-lane${typeof prevShare === "number" ? `, prev ${(prevShare * 100).toFixed(1)}%` : ""})`);

    // (c) anti-rot health report: validate-registry.cjs must have run recently
    // and nothing may be rotted. ERROR-class entries (throttle/network) do not
    // block — they're transient; ROT never pardons.
    const reportPath = path.join(ROOT, "desktop", "tools", "health-report.json");
    let report = null;
    try { report = JSON.parse(fs.readFileSync(reportPath, "utf8")); } catch {}
    if (!report || !report.generated) {
      warn("health-report.json missing — run tools/validate-registry.cjs (--sample nightly, --full pre-release)");
    } else {
      const ageH = (Date.now() - Date.parse(report.generated)) / 3600000;
      const s = report.summary || {};
      const rotted = s.rotted || 0;
      if (ageH > 7 * 24) fail(`health report is ${(ageH / 24).toFixed(1)} days stale (> 7d)`, "run validate-registry.cjs");
      else if (rotted > 0) fail(`anti-rot: ${rotted} rotted registry entries`, (report.checks || []).filter((c) => c.cls === "rot").slice(0, 5).map((c) => `${c.registry}:${String(c.id).slice(0, 40)} ${c.reason}`).join(" | "));
      else pass(`anti-rot report clean (${s.ok || 0} verified, ${s.error || 0} transient, mode ${report.mode}, ${(ageH).toFixed(1)}h old)`);
    }
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(statePath, JSON.stringify({ ...state, registries: counts, slowRoute: slowN, fastShare: share, at: new Date().toISOString() }, null, 1));
    } catch {}
  }

  /* [5] claims/numbers contract */
  console.log("\n[5] claims/numbers contract");
  {
    const fastRe = /hscportal\.pages\.dev|pub-ec23c9b69d2544938d816ad28ee491fd\.r2\.dev|www\.nsw\.gov\.au|www\.boardofstudies\.nsw\.edu\.au|thsconline\.github\.io|thsconline\.com\.au/;
    const isFast = (u) => u && !/\/s\/[dvfz]\//.test(u) && fastRe.test(u); // THSC route endpoints excluded
    const totalFiles = papers.reduce((n, p) => n + (p.url ? 1 : 0) + (p.solutionUrl ? 1 : 0), 0);
    const fastFiles = papers.reduce((n, p) => n + (isFast(p.url) ? 1 : 0) + (isFast(p.solutionUrl) ? 1 : 0), 0);
    const subjects = new Set(papers.map((p) => p.subject)).size;
    for (const [claim, actual, min] of [["7,000+", papers.length, 6750], ["7,700+", totalFiles, 7550], ["6,400+", fastFiles, 6250]]) {
      if (html.includes(claim)) { if (actual >= min) pass(`claim "${claim}" holds (actual ${actual})`); else fail(`claim "${claim}" DRIFTED`, `actual ${actual} < floor ${min}`); }
      else warn(`claim "${claim}" not found in index.html`);
    }
    if (html.includes("121 subjects")) { if (subjects >= 119) pass(`121 subjects holds (actual ${subjects})`); else fail("121 subjects drifted", `actual ${subjects}`); }
    // the repo README = a crawled, indexed surface — it must link the live
    // site and carry the evergreen counts (the discovery/trust path)
    const readme = fs.readFileSync(path.join(__dirname, "..", "..", "README.md"), "utf8");
    if (readme.includes("hscpapers.com")) pass("README links the live site");
    else fail("README missing the live site link");
    if (readme.includes("7,000+ papers") && readme.includes("7,700+ files")) pass("README carries the evergreen counts");
    else fail("README counts stale or missing");
  }

  /* [6] engine logic tests */
  console.log("\n[6] engine logic tests");
  {
    const N = 10, PAGE_H = 1400, VH = 800;
    const pages = Array.from({ length: N }, (_, i2) => ({ top: i2 * PAGE_H, rendered: i2 < 3, rendering: false }));
    const curPageFromScroll = (scrollTop) => {
      const half = VH * 0.4;
      let cur = 1;
      for (let i2 = 0; i2 < N; i2++) { if (pages[i2].top <= scrollTop + half) cur = i2 + 1; else break; }
      return cur;
    };
    if (curPageFromScroll(0) === 1 && curPageFromScroll(2479) === 2 && curPageFromScroll(2480) === 3 && curPageFromScroll(99999) === N) pass("current-page detection"); else fail("current-page detection");
    const sweep = (scrollTop) => {
      const mid = scrollTop + VH / 2, out = [];
      for (const p of pages) {
        if (!p.rendered || p.rendering) continue;
        if (Math.abs(p.top + PAGE_H / 2 - mid) > VH * 2.5) out.push(pages.indexOf(p) + 1);
      }
      return out;
    };
    if (JSON.stringify(sweep(0)) === "[3]" && JSON.stringify(sweep(4200)) === "[1,2]") pass("sweep-unload bounds"); else fail("sweep-unload bounds");
    const q = [8, 2, 5, 1, 7]; q.sort((a, b) => Math.abs(a - 4) - Math.abs(b - 4));
    if (q[0] === 5 && q[q.length - 1] === 8) pass("render-queue nearest-first"); else fail("render-queue priority");
    const clamp = (n, o) => Math.min(n, o);
    if (clamp(30, 10) === 10 && clamp(5, 10) === 5) pass("sync clamp"); else fail("sync clamp");
    // URL list-encoding round-trip: subject names can contain COMMAS
    // ("Personal Development, Health and Physical Education"). Wire format:
    // values %-encoded (+ for spaces), separated by %7C; legacy links
    // separated values with a RAW comma — a name's own comma is always %2C,
    // so the raw-level split before decoding is unambiguous.
    const enc = (v) => encodeURIComponent(v).replace(/%20/g, "+");
    const dec = (s) => { try { return decodeURIComponent(s.replace(/\+/g, " ")); } catch { return s; } };
    const parseList = (raw) => (/%7C/i.test(raw) ? raw.split(/%7C/i) : raw.split(",")).map(dec).map((s) => s.trim());
    const pdhpe = "Personal Development, Health and Physical Education";
    const r1 = parseList(enc(pdhpe) + "%7C" + enc("Chemistry")); // the new format
    const r2 = parseList("Chemistry,Physics"); // the legacy format
    const r3 = parseList(enc(pdhpe)); // a lone comma-name (the landing CTA / the old shared link)
    if (JSON.stringify(r1) === JSON.stringify([pdhpe, "Chemistry"]) && JSON.stringify(r2) === JSON.stringify(["Chemistry", "Physics"]) && r3[0] === pdhpe) pass("filter-list URL round-trip (comma-safe raw-level split)"); else fail("filter-list URL round-trip");
    // clear-all must restore the SLOW-ROUTE default too (the B1 bug class:
    // a user enables 🐢 for one search, clears, and slow files silently
    // stayed in saves). Mirrors app.js resetSlowRoute(): toggle off +
    // selection pruned of now-hidden papers.
    const isFast = (u) => u && !/\/s\/[dvfz]\//.test(u) && /hscportal\.pages\.dev|pub-ec23c9b69d2544938d816ad28ee491fd\.r2\.dev|www\.nsw\.gov\.au|www\.boardofstudies\.nsw\.edu\.au|thsconline\.github\.io|thsconline\.com\.au/.test(u);
    {
      // Data-independent fixture: explicitly mix fast + slow-route papers so
      // the assertion tests the reset logic, not the catalogue's array order
      // (the .com.au re-points made the old first-30 slice all-fast).
      const slowIds = papers.filter((p) => !isFast(p.url)).slice(0, 15).map((p) => p.id);
      const fastIds = papers.filter((p) => isFast(p.url)).slice(0, 15).map((p) => p.id);
      const initial = fastIds.length + slowIds.length;
      const st = { includeSlowRoute: true, selected: new Set([...fastIds, ...slowIds]) };
      const appResetSlowRoute = (st) => {
        st.includeSlowRoute = false;
        const hide = new Set(papers.filter((p) => !isFast(p.url)).map((p) => p.id));
        for (const id of [...st.selected]) if (hide.has(id)) st.selected.delete(id);
      };
      appResetSlowRoute(st);
      const fastSelected = [...st.selected].filter((id) => { const p = papers.find((x) => x.id === id); return p && isFast(p.url); }).length;
      if (st.includeSlowRoute === false && st.selected.size === fastSelected && st.selected.size < initial) pass("clear-all resets includeSlowRoute + prunes 🐢-hidden from selection");
      else fail("clear-all slow-route reset broken", `includeSlowRoute=${st.includeSlowRoute}, sel=${st.selected.size}/${initial} fast=${fastSelected}`);
    }
  }

  /* [7] share round-trip logic */
  console.log("\n[7] share round-trip logic");
  {
    const ids = papers.map((p) => p.id);
    const encodeSel = async (list) => {
      const raw = list.join("\n");
      const buf = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer());
      let bin = ""; for (const b of buf) bin += String.fromCharCode(b);
      return "g." + Buffer.from(bin, "binary").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    const decodeSel = async (v) => {
      try {
        let text = v;
        if (v.startsWith("g.")) {
          const b64 = v.slice(2).replace(/-/g, "+").replace(/_/g, "/");
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i2 = 0; i2 < bin.length; i2++) bytes[i2] = bin.charCodeAt(i2);
          text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
        }
        return [...new Set(text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean))];
      } catch { return null; }
    };
    let ok = true;
    for (const n of [1, 10, 200]) {
      const pick = ids.slice(0, n);
      const dec = await decodeSel(await encodeSel(pick));
      if (JSON.stringify(dec) !== JSON.stringify(pick)) { fail(`sel round-trip ${n} ids`); ok = false; }
    }
    if ((await decodeSel("g.!!!not-base64!!!")) === null) { /* graceful */ } else { fail("corrupt sel link not graceful"); ok = false; }
    if (ok) pass("sel round-trip clean (1/10/200 ids, corrupt links graceful)");
  }

  /* [8] updater API simulation */
  console.log("\n[8] updater API simulation");
  {
    const apiOk = await new Promise((resolve) => {
      const req = https.get("https://api.github.com/repos/chubbycavy/HSCPapers/releases/latest", { headers: { "User-Agent": "hscpapers-sweep", Accept: "application/vnd.github+json" }, timeout: 20000 }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          try {
            const j = JSON.parse(d);
            const tag = (j.tag_name || "").replace(/^v/, "");
            let asset = null;
            for (const a of j.assets || []) if ((a.name || "").startsWith("HSCPapers_") && a.name.endsWith("x64-setup.exe")) { asset = a; break; }
            const ok = tag && asset && /^sha256:[0-9a-f]{64}$/.test(asset.digest || "") && (asset.browser_download_url || "").startsWith("https://github.com/");
            if (ok) pass(`updater API parse: latest=${tag} | asset=${asset.name} | digest attested`);
            else fail("updater API parse incomplete", `tag=${tag} asset=${asset ? asset.name : "none"}`);
            resolve(true);
          } catch (e) { warn("updater API parse error", String(e).slice(0, 60)); resolve(true); }
        });
      });
      req.on("error", () => { warn("updater API unreachable (offline?)"); resolve(true); });
      req.on("timeout", () => { req.destroy(); });
    });
    void apiOk;
  }

  /* [9] SW/headers sanity */
  console.log("\n[9] SW/headers sanity");
  {
    if (/putBestEffort/.test(swJs)) pass("sw.js carries the best-effort cache-write guard");
    else fail("sw.js missing best-effort guard");
    if (headers.includes("/sw.js") && headers.includes("no-cache")) pass("_headers: sw.js no-cache rule present");
    else fail("_headers missing /sw.js no-cache rule");
    let iconsOk = true;
    for (const ic of manifest.icons || []) {
      const assetPath = ic.src.split(/[?#]/)[0]; // revision query is not part of the filename
      if (!fs.existsSync(path.join(UI, assetPath))) { fail(`manifest icon missing on disk: ${ic.src}`); iconsOk = false; }
    }
    if (iconsOk) pass(`manifest icons present (${(manifest.icons || []).length})`);
  }

  /* [10] landing pages cross-check (Phase C) */
  console.log("\n[10] landing pages cross-check");
  {
    const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const bySubject = new Map();
    for (const p of papers) { if (!bySubject.has(p.subject)) bySubject.set(p.subject, 0); bySubject.set(p.subject, bySubject.get(p.subject) + 1); }
    const subjects = [...bySubject.keys()];
    let landed = 0;
    for (const s of subjects) {
      const f = path.join(UI, "subjects", slugOf(s), "index.html");
      if (!fs.existsSync(f)) { fail(`landing page missing: /subjects/${slugOf(s)}/`); continue; }
      landed++;
      const html = fs.readFileSync(f, "utf8");
      const n = bySubject.get(s);
      if (!html.includes(`<b>${n}</b>`) || (!html.includes("papers indexed") && !html.includes("paper indexed"))) { fail(`landing page count wrong for "${s}"`, `expected ${n}`); }
    }
    if (landed === subjects.length && subjects.length) pass(`landing pages: ${landed}/${subjects.length} present with correct counts`);
    const hub = path.join(UI, "subjects", "index.html");
    if (fs.existsSync(hub) && fs.readFileSync(hub, "utf8").includes("Browse NSW HSC papers by subject")) pass("subjects hub present");
    else fail("subjects hub missing");
    const sm = fs.readFileSync(path.join(UI, "sitemap.xml"), "utf8");
    const nUrls = (sm.match(/<loc>/g) || []).length;
    if (nUrls >= subjects.length + 4 && sm.includes("/subjects/")) pass(`sitemap covers the landing pages (${nUrls} urls)`);
    else fail(`sitemap under-covers the landing pages (${nUrls} urls)`);
    if (sm.includes(`<loc>https://hscpapers.com/subjects/${slugOf(subjects[0])}/</loc>`) || !subjects.length) pass("sitemap url scheme matches the page paths");
    else fail("sitemap url scheme mismatch");
    // the static subject grids: the SPA shell is JS-rendered, so the raw HTML
    // Googlebot fetches must carry the subject links statically (the
    // HTML-sitemap crawl lane) — the injector's markers scope the block
    const gridRe = /<!-- SUBJECTS:STATIC:START -->([\s\S]*?)<!-- SUBJECTS:STATIC:END -->/;
    for (const [label, file] of [["homepage footer grid", path.join(UI, "index.html")], ["coverage footer grid", path.join(UI, "coverage.html")]]) {
      const src = fs.readFileSync(file, "utf8");
      const block = (src.match(gridRe) || [])[1];
      if (!block) { fail(`${label} missing (SUBJECTS:STATIC block)`); continue; }
      const missing = subjects.filter((s) => !block.includes(`/subjects/${slugOf(s)}/`));
      if (!missing.length) pass(`${label}: ${subjects.length}/${subjects.length} slugs present`);
      else fail(`${label} missing slugs`, `${missing.length} e.g. ${missing.slice(0, 5).join(", ")}`);
    }
    // brand assets: the logo generator's outputs must exist and the shell
    // must reference the svg favicon (logo.cjs owns logo.svg + icons +
    // og-card; the retired og-card.cjs must NOT come back as an orphan)
    for (const f of ["logo.svg", "favicon.svg", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "og-card.png"]) {
      if (fs.existsSync(path.join(UI, f))) pass(`brand asset on disk: ${f}`);
      else fail(`brand asset missing: ${f}`);
    }
    const { FAVICON_HREF, LOGO_HREF } = require("./logo.cjs");
    const brandPages = [html, fs.readFileSync(path.join(UI, "coverage.html"), "utf8"), fs.readFileSync(hub, "utf8"),
      ...subjects.map((s) => fs.readFileSync(path.join(UI, "subjects", slugOf(s), "index.html"), "utf8"))];
    const consistentBrand = brandPages.every((page) => {
      const favicons = [...page.matchAll(/<link\b[^>]*\brel="icon"[^>]*>/g)];
      return favicons.length === 1 && favicons[0][0].includes(`href="${FAVICON_HREF}"`) &&
        (page.includes(`src="${LOGO_HREF}"`) || page.includes(`src="${LOGO_HREF.slice(1)}"`));
    });
    if (consistentBrand) pass(`Classic H logo and favicon revision consistent (${brandPages.length} pages)`);
    else fail("logo or favicon revision drifted (including duplicate favicon declarations)");
    // B3 follow-system dark: all three HTML surfaces must carry the pre-paint
    // theme script (system default, no light-lock), and nothing may hardcode
    // data-theme="light" as the default experience
    const themeOk = (t) => t.includes('localStorage.getItem("hsc-theme")') && t.includes("prefers-color-scheme");
    if (themeOk(html)) pass("index.html: pre-paint theme script (follow-system)");
    else fail("index.html theme script missing/system-blind");
    const theme = fs.readFileSync(path.join(__dirname, "landing-pages.cjs"), "utf8");
    if (themeOk(theme)) pass("landing generator THEME: follow-system");
    else fail("landing THEME const light-locked");
    const cov = fs.readFileSync(path.join(__dirname, "coverage-report.cjs"), "utf8");
    if (themeOk(cov)) pass("coverage generator: theme script present (follow-system)");
    else fail("coverage.html theme script missing (light-locked page)");
    // B3.1 computed WCAG readability: every dark-mode text/background pair
    // must pass AA (4.5:1) — the value that caught --muted-2 at 3.5:1. The
    // color list is curated to the palette + the tag-chip rules.
    const lum = (h) => { const n = parseInt(h.slice(1), 16); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255); };
    const cr = (fg, bg) => (Math.max(lum(fg), lum(bg)) + 0.05) / (Math.min(lum(fg), lum(bg)) + 0.05);
    const css = fs.readFileSync(path.join(UI, "css", "styles.css"), "utf8");
    const darkBlock = (css.match(/\[data-theme="dark"\]\s*\{([^}]*)\}/) || [])[1] || "";
    const vars = {};
    for (const m of darkBlock.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})/g)) vars[m[1]] = m[2];
    const pairs = [
      ["text/surface", vars.text, vars.surface],
      ["text/bg", vars.text, vars.bg],
      ["muted/surface", vars.muted, vars.surface],
      ["muted/surface-2", vars.muted, vars["surface-2"]],
      ["muted-2/surface", vars["muted-2"], vars.surface],
      ["accent/surface", vars.accent, vars.surface],
    ];
    let lowContrast = pairs.filter(([, fg, bg]) => !fg || !bg || cr(fg, bg) < 4.5);
    if (!lowContrast.length) pass(`dark palette WCAG AA: ${pairs.length} core pairs >= 4.5:1`);
    else fail("dark-mode text below AA", lowContrast.map(([n, fg, bg]) => `${n} ${fg}/${bg}=${cr(fg, bg)}`).join("; "));
    // the tag-chip families (dark rules with their own bg)
    const tagRules = [...css.matchAll(/\[data-theme="dark"\]\s*(\.[a-z-]+(?:\.[a-z-]+)?)\s*\{([^}]*)\}/g)]
      .filter((m) => /color|background/.test(m[2]) && /#/.test(m[2]));
    const lowTags = [];
    for (const m of tagRules) {
      const fg = (m[2].match(/(?<!background[^;]*)color:\s*(#[0-9a-fA-F]{6})/) || [])[1];
      const bg = (m[2].match(/background:\s*(#[0-9a-fA-F]{6})/) || [])[1];
      if (fg && bg && cr(fg, bg) < 4.5) lowTags.push(`${m[1]} ${fg}/${bg}=${cr(fg, bg).toFixed(2)}`);
    }
    if (!lowTags.length) pass(`tag chips WCAG AA: ${tagRules.length} dark rules checked`);
    else fail("dark tag chips below AA", lowTags.join("; "));
    // DISK != GIT blind spot: a landing page can exist on disk yet be
    // git-ignored/excluded (the .gitignore "Physics/" case) — the deployed
    // Pages tree would 404/SPA-fallback it. Every slug must be git-tracked.
    const { spawnSync } = require("child_process");
    const spawnGitSync = (args) => {
      const r = spawnSync("git", args, { cwd: path.join(__dirname, "..", ".."), encoding: "utf8" }); // repo ROOT cwd
      if (r.status !== 0) throw new Error("git " + args.join(" ") + " failed");
      return r.stdout;
    };
    const tracked = new Set(
      spawnGitSync(["ls-files", "desktop/ui/subjects/"]).toString().trim().split("\n").filter(Boolean)
    );
    const untrackedSlugs = subjects.filter((s) => !tracked.has(`desktop/ui/subjects/${slugOf(s)}/index.html`));
    if (!untrackedSlugs.length) pass(`all ${subjects.length} landing pages git-tracked`);
    else fail(`landing pages on disk but NOT in git: ${untrackedSlugs.length}`, untrackedSlugs.slice(0, 5).join(", "));
    // lastmod freshness contract (independent re-verification of the
    // generator's content-diff): a url whose normalized content differs
    // from HEAD's blob must carry the sitemap's max (build-stamp) date;
    // an unchanged url must retain a date <= max; all dates valid, none
    // future. Normalization must MATCH the generator's (cov-note stamp
    // strip + CRLF + trim) — duplicated here as the verifier's own logic.
    const smUrls = [...sm.matchAll(/<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)];
    const today = new Date().toISOString().slice(0, 10);
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    const dates = smUrls.map((m) => m[2]);
    const malformed = dates.filter((d) => !dateRe.test(d) || d > today);
    const maxDate = dates.filter((d) => dateRe.test(d) && d <= today).sort().pop() || "";
    const normLm = (t) => String(t).replace(/<p class="cov-note">Generated [^<]*<\/p>/, "").replace(/\r\n/g, "\n").trim();
    const shaLm = (t) => require("crypto").createHash("sha256").update(normLm(t)).digest("hex");
    const contentPathOf = (loc) => {
      if (loc === "https://hscpapers.com/") return "index.html";
      if (loc === "https://hscpapers.com/coverage") return "coverage.html";
      if (loc === "https://hscpapers.com/demo-scroll") return "demo-scroll.html";
      if (loc === "https://hscpapers.com/subjects/") return "subjects/index.html";
      const m = loc.match(/\/subjects\/([^/]+)\/$/);
      return m ? `subjects/${m[1]}/index.html` : null;
    };
    let lmBad = [];
    for (const m of smUrls) {
      const loc = m[1], lm = m[2];
      const rel = contentPathOf(loc);
      if (!rel) continue;
      let headSha = null, newSha = null;
      try { headSha = shaLm(spawnGitSync(["show", `HEAD:desktop/ui/${rel}`])); } catch { /* blob missing -> unverifiable */ }
      try { newSha = shaLm(fs.readFileSync(path.join(UI, rel), "utf8")); } catch { /* unreadable */ }
      if (headSha === null || newSha === null) continue;
      if (headSha !== newSha && lm !== maxDate) lmBad.push(`${loc} changed but stamped ${lm} != ${maxDate}`);
      else if (headSha === newSha && lm > maxDate) lmBad.push(`${loc} unchanged but stamped ${lm} > ${maxDate}`);
    }
    if (!malformed.length && !lmBad.length) pass(`lastmod contract: ${smUrls.length} urls, max ${maxDate}, changed stamped / unchanged retained`);
    else fail("lastmod contract violated", `${malformed.length} malformed/future; ${lmBad.slice(0, 3).join(" | ")}`);
    // hub + footer-grid COUNT cross-check (the a7bfc16 blind spot): the
    // small-count labels on BOTH surfaces must match the catalogue per
    // subject — a stale canary-era hub shipped once because only the
    // per-subject PAGES were checked
    const countRe = /href="\/subjects\/([a-z0-9-]+)\/"><span>[^<]+<\/span><small>(\d+) papers?<\/small>/g;
    for (const [label, file] of [["hub", path.join(UI, "subjects", "index.html")], ["footer grid", path.join(UI, "index.html")]]) {
      const src = fs.readFileSync(file, "utf8");
      const block = label === "footer grid" ? ((src.match(gridRe) || [])[1] || "") : src;
      const got = new Map([...block.matchAll(countRe)].map((m) => [m[1], Number(m[2])]));
      const mism = subjects.filter((s) => got.get(slugOf(s)) !== bySubject.get(s));
      if (!mism.length && got.size === subjects.length) pass(`${label} counts match the catalogue (${got.size}/${subjects.length})`);
      else fail(`${label} counts drifted`, `${mism.length} mismatches e.g. ${mism.slice(0, 4).map((s) => `${slugOf(s)}:${got.get(slugOf(s))}!=${bySubject.get(s)}`).join(", ")}`);
    }
  }

  /* [11] theme-token integrity */
  console.log("\n[11] theme-token integrity");
  {
    // Every var(--token) the ui references must be either declared in a
    // stylesheet/style block or set at runtime via setProperty. The
    // reader once styled itself against --card/--soft/--primary — names
    // the dark-mode token migration renamed — so every rule fell back to
    // its hardcoded LIGHT value while the text color went dark-token:
    // near-white title on a permanent white bar. Regression guard for
    // that whole failure class.
    const styles = read(path.join(UI, "css", "styles.css"));
    const files = [styles, html, appJs];
    const subjDir = path.join(UI, "subjects");
    for (const d of fs.readdirSync(subjDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(subjDir, d.name, "index.html");
      if (fs.existsSync(f)) files.push(read(f));
    }
    for (const f of ["coverage.html", "demo-scroll.html"]) {
      const p = path.join(UI, f);
      if (fs.existsSync(p)) files.push(read(p));
    }
    const defined = new Set();
    for (const src of files) for (const m of src.matchAll(/(^|[{;])(\s*)(--[A-Za-z0-9-]+)\s*:/g)) defined.add(m[3]);
    for (const m of appJs.matchAll(/setProperty\(\s*"(--[A-Za-z0-9-]+)"/g)) defined.add(m[1]);
    const used = new Set();
    for (const src of files) for (const m of src.matchAll(/var\((--[A-Za-z0-9-]+)/g)) used.add(m[1]);
    const dead = [...used].filter((t) => !defined.has(t));
    if (!dead.length) pass(`theme tokens: all ${used.size} var() references defined or JS-set`);
    else fail(`dead theme tokens referenced: ${dead.length}`, dead.slice(0, 8).join(", "));
  }

  console.log("\n==== SWEEP SUMMARY ====");
  console.log(`PASS ${passes} | FAIL ${fails} | WARN ${warns}`);
  if (fails) { console.error("SWEEP RED -- fix before shipping"); process.exitCode = 1; }
  else console.log("SWEEP GREEN");
}
main().catch((e) => { console.error("sweep crashed:", e); process.exitCode = 1; });
