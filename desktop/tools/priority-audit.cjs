/* Resumable full-byte catalogue audit. Cached run state is never a build input.
 * --baseline captures publication; --run checks all active files; --publish
 * exports reviewed byte outcomes to the committed catalogue-validation registry.
 */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
globalThis.crypto ||= crypto.webcrypto;
const TOOLS = __dirname, DIR = path.join(TOOLS, ".cache", "priority-audit");
const BASE = path.join(DIR, "baseline.json"), STATE = path.join(DIR, "state.json");
const OUT = path.join(TOOLS, "catalogue-validation.json");
const read = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { if (e.code === "ENOENT") return fallback; throw e; } };
const write = (file, value) => { fs.writeFileSync(file + ".tmp", JSON.stringify(value, null, 1) + "\n"); fs.renameSync(file + ".tmp", file); };
const isLegacy = url => { try { const u = new URL(url); return ["thsconline.github.io", "thsconline.pages.dev"].includes(u.host) && /^\/s\/(?:d|v|fz|f|z)\//.test(u.pathname); } catch { return false; } };
function inventory(catalogue) {
  const files = new Map();
  for (const p of catalogue.papers || []) {
    const add = (url, role) => {
      if (!url) return;
      const row = files.get(url) || { url, owners: [] };
      if (!row.owners.some(o => o.id === p.id && o.role === role)) row.owners.push({ id: p.id, role, subject: p.subject, year: p.year, level: p.level, type: p.type, title: p.title, school: p.school });
      files.set(url, row);
    };
    add(p.url, "primary"); add(p.solutionUrl, "solutions");
    for (const alt of p.alternateSources || []) add(alt.url, "alternate");
    // Unverified script fallbacks are inventoried, then quarantined, not hammered
    // with thousands of quota-consuming requests when a primary already exists.
    add(p.fallbackUrl, "fallback"); add(p.solFallbackUrl, "solution-fallback");
  }
  return files;
}
function scopeProblem(row, text) {
  const joined = row.title + " " + text;
  if (/\bMATH(?:3202|7232)\b|Operations Research and (?:Math|Mathematical) Planning/i.test(joined)) return "University operations-research examination is outside the supported school curriculum";
  if (/University of Queensland|St Lucia Campus/i.test(text) && /Semester (?:One|Two) Final Examinations/i.test(text)) return "University examination is outside the supported school curriculum";
  return null;
}
module.exports = { inventory, scopeProblem, isLegacy };
if (require.main === module) (async () => {
  fs.mkdirSync(DIR, { recursive: true });
  const current = read(path.join(TOOLS, "../ui/data/papers-v2.json"));
  if (process.argv.includes("--baseline")) {
    if (fs.existsSync(BASE)) throw new Error("Baseline already exists; do not overwrite publication history");
    write(BASE, current); console.log(`Captured ${current.papers.length} published records`); return;
  }
  const baseline = read(BASE); if (!baseline) throw new Error("Capture --baseline first");
  const files = inventory(baseline), state = read(STATE, { version: 1, entries: {} });
  const summary = () => {
    const counts = {}; for (const url of files.keys()) { const status = state.entries[url]?.state || "pending"; counts[status] = (counts[status] || 0) + 1; }
    return { total: files.size, counts, complete: !counts.pending && !counts.transient };
  };
  if (process.argv.includes("--publish")) {
    const result = summary(); if (!result.complete) throw new Error("Audit still contains pending/transient records: " + JSON.stringify(result));
    const entries = { ...state.entries };
    for (const [url, e] of Object.entries(state.entries)) if (e.state === "verified" && e.migratedUrl)
      entries[e.migratedUrl] ||= { ...e, migratedUrl: undefined, proofSource: url };
    write(OUT, { version: 1, baselineGenerated: baseline.generated, generated: new Date().toISOString(), coverage: result, entries });
    console.log("Published audit registry:", JSON.stringify(result)); return;
  }
  if (!process.argv.includes("--run")) { console.log(JSON.stringify(summary(), null, 2)); return; }
  const { pdfProof, readBounded, fragmentDescriptor, resolveFragments, sanitizeThscTitle, fragmentUrl } = await import("../ui/_lib/thsc-fragments.mjs");
  const { EXPORT_APIS } = await import("../ui/_lib/pdf-proxy.mjs");
  const pdfjs = await require("./pdfjs.cjs").load();
  const arg = process.argv.find(a => a.startsWith("--limit=")), limit = arg ? Number(arg.slice(8)) : Infinity;
  const pending = [...files.values()].filter(r => !state.entries[r.url] || state.entries[r.url].state === "transient").slice(0, limit);
  for (const row of pending) if (isLegacy(row.url) && !row.owners.some(o => o.role === "primary" || o.role === "solutions"))
    state.entries[row.url] = { state: "review", reason: "Unverified legacy fallback retained as provenance, not an actionable source", at: new Date().toISOString() };
  const work = pending.filter(row => !state.entries[row.url] || state.entries[row.url].state === "transient");
  const groups = new Map(); for (const row of work) { const host = isLegacy(row.url) ? "legacy" : new URL(row.url).host; if (!groups.has(host)) groups.set(host, []); groups.get(host).push(row); }
  let done = files.size - work.length;
  const t0 = Date.now(), counters = new Map();
  async function probe(row) {
    const at = new Date().toISOString();
    if (isLegacy(row.url) && !row.owners.some(o => o.role === "primary" || o.role === "solutions")) return { state: "review", reason: "Unverified legacy fallback retained as provenance, not an actionable source", at };
    let bytes, transport = "direct-pdf", migratedUrl, apiFilename;
    try {
      if (isLegacy(row.url)) {
        const u = new URL(row.url), m = /^\/s\/(?:d|v|fz|f|z)\/(\d+)\/(.+)$/.exec(u.pathname);
        if (!m) throw new Error("Malformed legacy source identity");
        const rawTitle = decodeURIComponent(m[2]);
        try {
          const net = await resolveFragments({ viewno: m[1], title: sanitizeThscTitle(rawTitle) }, { signal: AbortSignal.timeout(18000) });
          bytes = net.bytes; migratedUrl = fragmentUrl(m[1], rawTitle); apiFilename = net.metadata.originalFileName; transport = "thsc-fragments";
        } catch (e) {
          if (e.code !== "not-migrated") throw e;
          const hash = crypto.createHash("sha256").update(m[1]).digest("hex");
          const url = `${EXPORT_APIS.at(-1)}?export=view&base=${m[1]}&field=${encodeURIComponent(rawTitle.replace(/&/g, "_"))}&hash=${hash}`;
          const response = await fetch(url, { signal: AbortSignal.timeout(25000) });
          if (!response.ok) throw Object.assign(new Error("Legacy HTTP " + response.status), { status: response.status });
          const text = new TextDecoder().decode(await readBounded(response, 48 * 1024 * 1024));
          const record = JSON.parse(text.replace(/^\s*downloadfile\(/, "").replace(/\)\s*;?\s*$/, ""));
          if (!record.data) throw new Error("Legacy source returned no file");
          bytes = new Uint8Array(Buffer.from(record.data, "base64")); transport = "legacy-resolver";
        }
      } else {
        const descriptor = fragmentDescriptor(row.url);
        if (descriptor) { const net = await resolveFragments(descriptor); bytes = net.bytes; transport = "thsc-fragments"; }
        else {
          const response = await fetch(row.url, { headers: { "User-Agent": "HSCPapers/1.0 (full catalogue verification)", "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(20000) });
          if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error("HTTP " + response.status), { status: response.status }); }
          if (/text\/html/i.test(response.headers.get("content-type") || "")) { await response.body?.cancel(); return { state: "invalid", reason: "Source redirects/returns HTML rather than PDF", finalUrl: response.url, at }; }
          bytes = await readBounded(response, 96 * 1024 * 1024);
        }
      }
      const proof = await pdfProof(bytes);
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true, verbosity: 0 });
      let doc, text = "", pages;
      try { doc = await task.promise; pages = doc.numPages; for (let n = 1; n <= Math.min(2, pages); n++) { const c = await (await doc.getPage(n)).getTextContent(); text += c.items.map(x => x.str).join(" ") + " "; } }
      finally { await task.destroy(); }
      const rejectedOwners = row.owners.filter(o => scopeProblem(o, text)).map(o => ({ id: o.id, role: o.role, reason: scopeProblem(o, text) }));
      return { state: "verified", ...proof, pages, transport, ...(migratedUrl ? { migratedUrl, apiFilename } : {}), ...(rejectedOwners.length ? { rejectedOwners } : {}), text: text.replace(/\s+/g, " ").slice(0, 1400), at };
    } catch (e) {
      const transient = /timeout|abort|fetch failed|socket|network|HTTP (?:429|5\d\d)/i.test(e.message);
      const state = e.code === "size-limit" ? "review" : transient ? "transient" : "invalid";
      return { state, reason: e.message, code: e.code || null, at };
    }
  }
  await Promise.all([...groups].map(async ([host, rows]) => {
    const concurrency = host === "legacy" ? 1 : /hscportal/.test(host) ? 4 : /archive.org|boardofstudies/.test(host) ? 2 : 3;
    const gap = host === "legacy" ? 1200 : /hscportal/.test(host) ? 220 : /thsconline.com.au/.test(host) ? 350 : 500;
    let i = 0, nextStart = 0;
    await Promise.all(Array.from({ length: concurrency }, async () => {
      while (i < rows.length) {
        const row = rows[i++], start = Math.max(Date.now(), nextStart); nextStart = start + gap;
        await new Promise(r => setTimeout(r, Math.max(0, start - Date.now())));
        let verdict = await probe(row);
        if (verdict.state === "transient") { await new Promise(r => setTimeout(r, 1500)); verdict = await probe(row); }
        state.entries[row.url] = verdict; done++; counters.set(verdict.state, (counters.get(verdict.state) || 0) + 1);
        if (done % 25 === 0 || i >= rows.length) { write(STATE, state); console.log(`${done}/${files.size} ${Math.round((Date.now()-t0)/1000)}s ${JSON.stringify(Object.fromEntries(counters))}`); }
      }
    }));
  }));
  write(STATE, state); console.log("AUDIT RESULT", JSON.stringify(summary(), null, 2));
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
