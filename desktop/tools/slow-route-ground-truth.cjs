/* Phase H ground-truth pass: resolve every slow-route router URL through the
   PRODUCTION proxy handler, recording bytes + SHA-256 + length + status.
   Resumable; output: desktop/tools/slow-route-truth.json

   v2 semantics (2026-10-10):
   - A 503 with Retry-After means the resolver POOL is cooling down (dan-side
     throttle or our own 60s cooldown); we WAIT it out and retry WITHOUT
     burning an attempt. Genuine errors burn attempts (max 3).
   - The proxy's "file withheld" 503 (fileref-collision / collapsed-sha
     guards) is TERMINAL for that listing. Both guards return identical
     message text, so classification uses the telemetry tee: when the
     upstream document's sha is a known collapsed hash → "collapsed"; when
     the guard trip came with a fileref on the same viewno → "fileref";
     otherwise "unknown" (logged loudly — should not happen).
   - Telemetry tee: every Apps Script response is cloned and inspected below
     the guards — capture fileref, decoded byte count and upstream SHA per
     (viewno, title), regardless of whether the guard then withholds.
   - Entries whose stored sha256 is a known collapsed hash are auto-refetched
     on every run (they were recorded BEFORE the guards existed and are
     worthless as "ok" bytes).

   Usage: node tools/slow-route-ground-truth.cjs [--limit=N] [--refetch=id,id2] */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createProxyHandler, KNOWN_COLLAPSED_SHAS } = require("../ui/_lib/pdf-proxy.mjs");

const OUT = path.join(__dirname, "slow-route-truth.json");
const papers = require("../ui/data/papers.json").papers;
const argValue = (name) => {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const refetchIds = new Set(process.argv.includes("--refetch") ? argValue("--refetch").split(",") : []);
const limit = Number(argValue("--limit") || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const KNOWN_COLLAPSED = new Set(KNOWN_COLLAPSED_SHAS); // live list from the module — the runner auto-refetches anything on it

const slow = papers.filter((p) => p.url && /\/s\/[dvfz]\//.test(p.url));
let truth = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, "utf8")) : {
  _doc: "Ground truth: every slow-route paper resolved through the production proxy handler at hunt time. sha256 + fileref + upstreamBytes = the evidence trail for re-pointing AND the dan report. Regenerate or refetch individual ids; do not hand-edit.",
  _v: 2, generated: null, entries: {},
};
truth._v = 2;

// Telemetry from below the guards: the handler serializes Apps Script calls
// through its gap queue and this runner awaits one paper at a time, so the
// most recent script.google.com response belongs to the paper being resolved.
let lastTelemetry = null;
const handler = createProxyHandler({
  fetchImpl: async (...args) => {
    const res = await fetch(...args);
    try {
      const url = typeof args[0] === "string" ? args[0] : String(args[0]);
      if (res.ok && url.includes("script.google.com")) {
        const text = await res.clone().text();
        const m = text.match(/^\s*downloadfile\(([\s\S]*)\)\s*;?\s*$/);
        if (m) {
          const record = JSON.parse(m[1]);
          if (record && typeof record.data === "string") {
            const decoded = Buffer.from(record.data.replace(/\s/g, ""), "base64");
            lastTelemetry = {
              upstreamBytes: decoded.length,
              upstreamSha256: crypto.createHash("sha256").update(decoded).digest("hex"),
              fileref: record.fileref == null ? null : String(record.fileref),
            };
          }
        }
      }
    } catch { /* telemetry is best-effort; never break the run */ }
    return res;
  },
  cache: () => null, // ground truth must read the POOL, not any cache layer
});

let done = 0, withheld = 0, failed = 0;
let coolUntil = 0;

async function waitOutCooldown() {
  const remain = coolUntil - Date.now();
  if (remain > 0) await sleep(remain);
}

(async () => {
  const t0 = Date.now();
  const MAX_THROTTLE_WAITS = 8; // per paper; beyond → record + move on (a later run refetches)
  // auto-refetch every pre-guard byte-poisoned entry once
  for (const key of Object.keys(truth.entries)) {
    const e = truth.entries[key];
    if (e.ok && KNOWN_COLLAPSED.has(e.sha256)) refetchIds.add(key);
    else if (e.withheld === true && !e.guardKind) refetchIds.add(key); // legacy unclassified verdicts
  }
  const queue = slow.filter((p) => {
    const existing = truth.entries[p.id];
    if (existing && existing.ok && existing.sha256 && !refetchIds.has(p.id)) return false;
    if (existing && existing.withheld && existing.guardKind && existing.guardKind !== "unknown" && !refetchIds.has(p.id)) return false;
    return true;
  });
  const work = limit ? queue.slice(0, limit) : queue;
  const skipped = slow.length - queue.length;
  console.log(`sweep: ${work.length}/${slow.length} slow-route papers to resolve${limit ? " (limited)" : ""} | ${skipped} already settled | ${refetchIds.size} forced refetches`);
  if (!work.length) {
    console.log("nothing to do");
    return;
  }

  for (const p of work) {
    await waitOutCooldown();
    let attempt = 0, throttleWaits = 0, ok = false, terminal = false, lastErr = "";
    const entry = Object.assign({ url: p.url, title: p.title },
      truth.entries[p.id] && truth.entries[p.id].ok ? {} : (truth.entries[p.id] || {}));
    while (attempt < 3 && !ok && !terminal) {
      lastTelemetry = null;
      try {
        await waitOutCooldown();
        const reqUrl = "https://hscpapers.pages.dev/proxy?url=" + encodeURIComponent(p.url);
        const res = await handler({ request: new Request(reqUrl, { headers: { range: "bytes=0-999999999" } }) });
        if (res.status === 503) {
          const body = await res.clone().text();
          if (body.includes("withheld")) {
            const up = lastTelemetry ? Object.assign({}, lastTelemetry) : {};
            const guardKind = up.upstreamSha256 && KNOWN_COLLAPSED.has(up.upstreamSha256) ? "collapsed"
              : up.fileref ? "fileref" : "unknown";
            Object.assign(entry, up, {
              ok: false, sha256: null, bytes: null, withheld: true, guardKind, err: "withheld (" + guardKind + ")",
              attempt, at: new Date().toISOString(),
            });
            if (guardKind === "unknown") console.log(`  !! unclassified withheld verdict for ${p.id} — telem: ${JSON.stringify(up)}`);
            withheld++; terminal = true; break;
          }
          const retryAfter = Number(res.headers.get("retry-after") || 0) || 60;
          if (++throttleWaits > MAX_THROTTLE_WAITS) {
            Object.assign(entry, { ok: false, err: `throttle-capped after ${MAX_THROTTLE_WAITS} waits`, attempt, at: new Date().toISOString() });
            failed++; terminal = true; break;
          }
          coolUntil = Date.now() + retryAfter * 1000 + 5000;
          fs.writeFileSync(OUT, JSON.stringify(truth, null, 1)); // checkpoint before a long wait
          continue; // cooldown wait is NOT an attempt burn
        }
        if (!res.ok) throw new Error("status " + res.status);
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.subarray(0, 5).toString().startsWith("%PDF-")) throw new Error("not a PDF (%PDF- missing)");
        Object.assign(entry, lastTelemetry || {}, {
          sha256: crypto.createHash("sha256").update(buf).digest("hex"),
          bytes: buf.length,
          eof: buf.subarray(-2048).toString("binary").includes("%%EOF"),
          ok: true, withheld: false, guardKind: null,
          err: null, attempt, at: new Date().toISOString(),
        });
        ok = true; done++;
      } catch (e) {
        lastErr = String((e && e.message) || e).slice(0, 120);
        attempt++;
        Object.assign(entry, { ok: false, err: lastErr, attempt, at: new Date().toISOString() });
        if (attempt < 3) await sleep(4000);
      }
    }
    if (!ok && !terminal) failed++;
    truth.entries[p.id] = entry;
    truth.generated = new Date().toISOString();
    if ((done + failed + withheld) % 3 === 0) fs.writeFileSync(OUT, JSON.stringify(truth, null, 1));
    const tag = ok ? "OK" : entry.withheld ? "WITHHELD(" + entry.guardKind + ")" : "FAIL";
    const detail = ok
      ? entry.sha256.slice(0, 12) + " " + entry.bytes + "B" + (entry.fileref ? " ref=" + String(entry.fileref).slice(0, 12) : "")
      : entry.withheld
        ? "up " + (entry.upstreamSha256 || "?").slice(0, 12) + " " + (entry.upstreamBytes == null ? "?" : entry.upstreamBytes) + "B" + (entry.fileref ? " ref=" + String(entry.fileref).slice(0, 12) : "")
        : entry.err;
    console.log(`[${done + withheld + failed}/${work.length}] ${tag} ${p.id} ${detail} (${Math.round((Date.now() - t0) / 1000)}s)`);
  }
  fs.writeFileSync(OUT, JSON.stringify(truth, null, 1));
  const all = Object.values(truth.entries);
  const summarize = (pred) => all.filter(pred).length;
  console.log(`\nDONE: ok=${summarize((e) => e.ok)} withheld=${summarize((e) => e.withheld)} (collapsed=${summarize((e) => e.withheld && e.guardKind === "collapsed")}, fileref=${summarize((e) => e.withheld && e.guardKind === "fileref")}, unknown=${summarize((e) => e.withheld && (!e.guardKind || e.guardKind === "unknown"))}) fail=${summarize((e) => !e.ok && !e.withheld)} skipped=${skipped} elapsed=${Math.round((Date.now() - t0) / 1000)}s`);
})();
