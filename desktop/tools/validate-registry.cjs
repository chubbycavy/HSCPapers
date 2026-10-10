/* validate-registry.cjs — the anti-rot engine (H4).
   Re-proofs registry entries by re-fetching their URLs and comparing bytes:
     thsc-au-verified.json : url + bytes + sha256 + pages -> full proof
     nesa-recovery.json    : url -> HTTP 200 + %PDF- magic (+ sha drift capture)
   Modes:
     --sample  re-proof ~5% of entries rotating deterministically by day
               (the nightly bot job; full coverage every ~20 days)
     --full    re-proof EVERY entry (pre-release audit)
   Output: tools/health-report.json — sweep-check reads it and goes RED on
   any rotted entry (sha/page/byte drift, not-PDF, 4xx/5xx). Throttling and
   network errors class as ERROR (transient) — visible in the report, never
   a false rot alarm. Exit 1 when anything ROTTED.

   Usage: node tools/validate-registry.cjs [--sample|--full] [--registry=thsc-au|nesa-recovery] [--limit=N] [--report-only] */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOOLS = __dirname;
const OUT = path.join(TOOLS, "health-report.json");
const REGISTRIES = [
  { name: "thsc-au", file: path.join(TOOLS, "thsc-au-verified.json") },
  { name: "nesa-archive", file: path.join(TOOLS, "nesa-archive-verified.json") },
  { name: "nesa-recovery", file: path.join(TOOLS, "nesa-recovery.json") },
];
const UA = { "User-Agent": "HSCPapers/1.0 (registry anti-rot validation)", "Accept-Encoding": "identity" };
const SAMPLE_FRACTION = 0.05;
const MIN_GAP_MS = 1000; // 1 req/s politeness across ALL probes
const MAX_THROTTLE_WAITS = 4;

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const MODE = process.argv.includes("--full") ? "full" : process.argv.includes("--sample") ? "sample" : null;
const ONLY = argValue("--registry");
const LIMIT = Number(argValue("--limit") || 0);
const REPORT_ONLY = process.argv.includes("--report-only");

if (!MODE) {
  console.error("usage: node tools/validate-registry.cjs --sample | --full [--registry=thsc-au|nesa-archive|nesa-recovery] [--limit=N] [--report-only]");
  process.exit(2);
}

function loadEntries(reg) {
  let json;
  try { json = JSON.parse(fs.readFileSync(reg.file, "utf8")); } catch (e) {
    if (e.code === "ENOENT") return { rows: [], json: null };
    throw e;
  }
  const rows = [];
  if (reg.name === "nesa-recovery") {
    for (const [deadUrl, hit] of Object.entries(json.entries || {})) {
      if (!hit || !hit.url) continue;
      rows.push({ id: hit.url, url: hit.url, sha256: hit.lastSha256 || null, deadUrl, solution: !!hit.solution });
    }
  } else {
    const list = Array.isArray(json.entries) ? json.entries.map((e, i) => [e.key || e.url || String(i), e]) : Object.entries(json.entries || {});
    for (const [, e] of list) {
      if (!e || !e.url) continue;
      rows.push({ id: e.key || e.url, url: e.url, sha256: e.sha256 || null, bytes: e.bytes || null, pages: e.pages || null });
    }
  }
  return { rows, json };
}

/* deterministic sample: sort by id, rotate the start by day-index, stride */
function sampleOf(rows) {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const n = Math.max(1, Math.ceil(sorted.length * SAMPLE_FRACTION));
  const offset = Math.floor(Date.now() / 86400000) % sorted.length;
  const out = [];
  for (let i = 0; i < n; i++) out.push(sorted[(offset + i * Math.floor(sorted.length / n)) % sorted.length]);
  return [...new Map(out.map((r) => [r.id, r])).values()];
}

let lastEnd = 0;
async function politeGap() {
  const gap = lastEnd + MIN_GAP_MS - Date.now();
  if (gap > 0) await new Promise((r) => setTimeout(r, gap));
}

async function fetchWithRetry(url) {
  for (let throttleWaits = 0; ; throttleWaits++) {
    await politeGap();
    try {
      const res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(45000) });
      lastEnd = Date.now();
      if (res.status === 429 || res.status === 503) {
        if (throttleWaits < MAX_THROTTLE_WAITS) {
          const wait = Math.min(Number(res.headers.get("retry-after") || 0) * 1000 || 60000, 120000);
          console.log(`  [throttle] ${res.status} — waiting ${wait / 1000}s`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        return { status: res.status, headers: res.headers, class: "throttled", arrayBuffer: () => res.arrayBuffer() };
      }
      return { status: res.status, headers: res.headers, class: "http", arrayBuffer: () => res.arrayBuffer() };
    } catch (e) {
      lastEnd = Date.now();
      return { status: 0, headers: new Headers(), class: "network", error: String((e && e.message) || e).slice(0, 100) };
    }
  }
}

/* core probe: 200 + application/pdf + %PDF- + optional byte/sha/page proof */
let pdfjsReady = null;
function pdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = require("../ui/pdfjs/pdf.min.js");
    pdfjsReady.GlobalWorkerOptions.workerSrc = require.resolve("../ui/pdfjs/pdf.worker.min.js");
  }
  return pdfjsReady;
}
async function probe(row) {
  const res = await fetchWithRetry(row.url);
  if (res.class === "throttled") return { ok: false, cls: "error", reason: "throttled upstream after retries" };
  if (res.class === "network") return { ok: false, cls: "error", reason: "unreachable: " + res.error };
  if (res.status !== 200) return { ok: false, cls: "rot", reason: "HTTP " + res.status };
  if (!/^application\/pdf\b/i.test(res.headers.get("content-type") || ""))
    return { ok: false, cls: "rot", reason: "content-type not PDF: " + (res.headers.get("content-type") || "none") };
  const bytes = Buffer.from(await res.arrayBuffer());
  const evidence = { bytes: bytes.length, sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
  if (!bytes.subarray(0, 5).toString("binary").startsWith("%PDF-")) return { ok: false, cls: "rot", reason: "PDF magic missing", ...evidence };
  if (row.bytes != null && evidence.bytes !== row.bytes)
    return { ok: false, cls: "rot", reason: `byte drift: ${evidence.bytes} stored ${row.bytes}`, ...evidence };
  if (row.sha256 && evidence.sha256 !== row.sha256)
    return { ok: false, cls: "rot", reason: `sha drift: ${evidence.sha256.slice(0, 12)} stored ${row.sha256.slice(0, 12)}`, ...evidence };
  if (row.pages != null && Number.isInteger(row.pages) && row.pages > 0) {
    try {
      const doc = await pdfjs().getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true }).promise;
      try {
        if (doc.numPages !== row.pages) return { ok: false, cls: "rot", reason: `page drift: ${doc.numPages} stored ${row.pages}`, ...evidence, pages: doc.numPages };
      } finally { await doc.destroy(); }
    } catch (e) { return { ok: false, cls: "rot", reason: "PDF.js open failed: " + String((e && e.message) || e).slice(0, 80), ...evidence }; }
  }
  return { ok: true, cls: "ok", reason: "verified", evidence };
}

(async () => {
  const checks = [];
  const t0 = Date.now();
  let rotted = 0, okN = 0, errorN = 0;
  // nesa-recovery sha capture: load once, mutate in memory, flush at checkpoints
  const nesas = REGISTRIES.filter((r) => !ONLY || r.name === ONLY);
  const recoveryJsons = {};
  for (const reg of nesas) {
    if (reg.name === "nesa-recovery") {
      try { recoveryJsons[reg.file] = JSON.parse(fs.readFileSync(reg.file, "utf8")); } catch { recoveryJsons[reg.file] = null; }
    }
  }
  const flushRecovery = (reg) => {
    const j = recoveryJsons[reg.file];
    if (j && !REPORT_ONLY) try { fs.writeFileSync(reg.file, JSON.stringify(j, null, 1) + "\n"); } catch { }
  };

  for (const reg of nesas) {
    let { rows } = loadEntries(reg);
    if (MODE === "sample") rows = sampleOf(rows);
    if (LIMIT) rows = rows.slice(0, LIMIT);
    console.log(`\n[${reg.name}] ${rows.length} entries to re-proof (${MODE})`);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const verdict = await probe(row);
      const check = {
        registry: reg.name, id: String(row.id), url: row.url,
        ok: verdict.ok, cls: verdict.cls, reason: verdict.reason,
        sha256: verdict.evidence ? verdict.evidence.sha256 : null,
        bytes: verdict.evidence ? verdict.evidence.bytes : null,
        checkedAt: new Date().toISOString(),
      };
      checks.push(check);
      if (verdict.cls === "ok") {
        okN++;
        // nesa-recovery has no stored hashes — capture one on first proof so
        // FUTURE runs detect drift (idempotent upgrade, skipped by --report-only)
        if (reg.name === "nesa-recovery" && row.deadUrl && recoveryJsons[reg.file]) {
          const rec = recoveryJsons[reg.file].entries[row.deadUrl];
          if (rec && !rec.lastSha256) {
            rec.lastSha256 = verdict.evidence.sha256;
            rec.lastBytes = verdict.evidence.bytes;
            rec.lastVerifiedAt = check.checkedAt;
          }
        }
      } else if (verdict.cls === "rot") rotted++;
      else errorN++;
      if ((i + 1) % 10 === 0 || i === rows.length - 1) {
        fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), mode: MODE, summary: { ok: okN, rotted, error: errorN, total: okN + rotted + errorN }, checks }, null, 1) + "\n");
        flushRecovery(reg);
      }
      console.log(`  [${i + 1}/${rows.length}] ${verdict.ok ? "OK" : verdict.cls === "rot" ? "ROTTED" : "ERROR"} ${row.id} ${verdict.ok ? (verdict.evidence.sha256 || "").slice(0, 12) : verdict.reason}`);
    }
    flushRecovery(reg);
  }
  fs.writeFileSync(OUT, JSON.stringify({ generated: new Date().toISOString(), mode: MODE, summary: { ok: okN, rotted, error: errorN, total: okN + rotted + errorN }, checks }, null, 1) + "\n");
  console.log(`\nDONE (${MODE}): ok=${okN} rotted=${rotted} error=${errorN} in ${Math.round((Date.now() - t0) / 1000)}s`);
  process.exit(rotted ? 1 : 0);
})().catch((e) => { console.error("validate-registry crashed:", e); process.exit(2); });
