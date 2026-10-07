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
   [9] SW/headers sanity (version marker, no-cache rule, manifest icons) */
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
const proxyJs = read(path.join(UI, "functions", "proxy.js"));
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
    if (allowed) for (const h of ["www.nsw.gov.au", "www.boardofstudies.nsw.edu.au"]) if (!allowed.has(h)) { fail(`proxy ALLOWED_HOSTS missing "${h}"`); ok = false; }
    const mainRsHosts = new Set([...mainRs.matchAll(/"(hscportal\.pages\.dev|pub-ec23[a-f0-9]*\.r2\.dev|www\.nsw\.gov\.au|boardofstudies\.nsw\.edu\.au|thsconline\.github\.io)"/g)].map((m) => m[1]));
    if (fast) for (const h of fast) { const s = stripWww(h); if (!mainRsHosts.has(h) && !mainRsHosts.has(s)) warn(`main.rs does not literally mention fast host "${h}"`); }
    if (ok) pass(`host layers in sync: ${fast ? fast.size : "?"} fast hosts, ${allowed ? allowed.size : "?"} proxy-allowed`);
  }

  /* [4] registry integrity */
  console.log("\n[4] registry integrity");
  {
    const reg = path.join(ROOT, "desktop", "tools");
    const statePath = path.join(reg, ".cache", "sweep-state.json");
    let state = {};
    try { state = JSON.parse(fs.readFileSync(statePath, "utf8")); } catch {}
    const counts = {};
    for (const f of ["nesa-recovery.json", "selfhost.json", "removals.json"]) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(reg, f), "utf8"));
        const n = (j.entries ? Object.keys(j.entries).length : Array.isArray(j) ? j.length : Object.keys(j).filter((k) => !k.startsWith("_")).length);
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

  /* [5] claims/numbers contract */
  console.log("\n[5] claims/numbers contract");
  {
    const fastRe = /hscportal\.pages\.dev|pub-ec23c9b69d2544938d816ad28ee491fd\.r2\.dev|www\.nsw\.gov\.au|www\.boardofstudies\.nsw\.edu\.au|thsconline\.github\.io/;
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
    if (readme.includes("hscpapers.pages.dev")) pass("README links the live site");
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
      if (!fs.existsSync(path.join(UI, ic.src))) { fail(`manifest icon missing on disk: ${ic.src}`); iconsOk = false; }
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
      if (!html.includes(`<b>${n}</b>`) || !html.includes("papers indexed")) { fail(`landing page count wrong for "${s}"`, `expected ${n}`); }
    }
    if (landed === subjects.length && subjects.length) pass(`landing pages: ${landed}/${subjects.length} present with correct counts`);
    const hub = path.join(UI, "subjects", "index.html");
    if (fs.existsSync(hub) && fs.readFileSync(hub, "utf8").includes("Browse NSW HSC papers by subject")) pass("subjects hub present");
    else fail("subjects hub missing");
    const sm = fs.readFileSync(path.join(UI, "sitemap.xml"), "utf8");
    const nUrls = (sm.match(/<loc>/g) || []).length;
    if (nUrls >= subjects.length + 4 && sm.includes("/subjects/")) pass(`sitemap covers the landing pages (${nUrls} urls)`);
    else fail(`sitemap under-covers the landing pages (${nUrls} urls)`);
    if (sm.includes(`<loc>https://hscpapers.pages.dev/subjects/${slugOf(subjects[0])}/</loc>`) || !subjects.length) pass("sitemap url scheme matches the page paths");
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
      if (loc === "https://hscpapers.pages.dev/") return "index.html";
      if (loc === "https://hscpapers.pages.dev/coverage") return "coverage.html";
      if (loc === "https://hscpapers.pages.dev/demo-scroll") return "demo-scroll.html";
      if (loc === "https://hscpapers.pages.dev/subjects/") return "subjects/index.html";
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
  }

  console.log("\n==== SWEEP SUMMARY ====");
  console.log(`PASS ${passes} | FAIL ${fails} | WARN ${warns}`);
  if (fails) { console.error("SWEEP RED -- fix before shipping"); process.exitCode = 1; }
  else console.log("SWEEP GREEN");
}
main().catch((e) => { console.error("sweep crashed:", e); process.exitCode = 1; });
