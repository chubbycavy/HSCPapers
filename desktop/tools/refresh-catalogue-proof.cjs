// Nightly admission: new URLs plus a bounded rotating migrated-transport check.
// No routine Apps Script calls and no uploads. Byte/version drift stays in review.
"use strict";
const fs = require("fs"), path = require("path");
globalThis.crypto ||= require("crypto").webcrypto;
(async () => {
  const file = path.join(__dirname, "catalogue-validation.json"), registry = JSON.parse(fs.readFileSync(file, "utf8"));
  const catalogue = JSON.parse(fs.readFileSync(path.join(__dirname, "../ui/data/papers-v2.json"), "utf8"));
  const { readBounded, pdfProof, resolveFragments, fragmentUrl, sanitizeThscTitle } = await import("../ui/_lib/thsc-fragments.mjs");
  const { isLegacy } = require("./priority-audit.cjs"), urls = new Map();
  for (const p of [...catalogue.papers, ...(catalogue.recoveryPapers || [])]) {
    for (const url of [p.url, p.solutionUrl, ...(p.alternateSources || []).map(a => a.url), ...(p.provenanceSources || []).map(a => a.url)].filter(Boolean)) if (!urls.has(url)) urls.set(url, p);
  }
  const unknown = [...urls].filter(([url]) => !registry.entries[url] && !isLegacy(url));
  const legacy = [...urls].filter(([url]) => isLegacy(url));
  const offset = Math.floor(Date.now() / 86400000) * 25 % Math.max(1, legacy.length);
  const selected = [...unknown, ...Array.from({ length: Math.min(25, legacy.length) }, (_, i) => legacy[(offset+i)%legacy.length])];
  const pdfjs = require("../ui/pdfjs/pdf.min.js"); pdfjs.GlobalWorkerOptions.workerSrc = require.resolve("../ui/pdfjs/pdf.worker.min.js");
  for (const [url] of selected) {
    try {
      let bytes, migratedUrl, transport = "direct-pdf";
      if (isLegacy(url)) {
        const m = new URL(url).pathname.match(/\/s\/(?:d|v|fz|f|z)\/(\d+)\/(.+)/), raw = decodeURIComponent(m[2]);
        const result = await resolveFragments({ viewno: m[1], title: sanitizeThscTitle(raw) });
        bytes = result.bytes; migratedUrl = fragmentUrl(m[1], raw); transport = "thsc-fragments";
      } else {
        const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "User-Agent": "HSCPapers/1.0 (nightly admission)" } });
        if (!r.ok) throw new Error("Source HTTP " + r.status);
        bytes = await readBounded(r, 32 * 1024 * 1024);
      }
      const proof = await pdfProof(bytes), old = registry.entries[url];
      if (old?.state === "verified" && old.sha256 !== proof.sha256) { registry.entries[url] = { ...old, state: "review", reason: "Changed source version requires identity/role review", pendingVersionReview: { ...proof, at: new Date().toISOString() } }; continue; }
      const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }), doc = await task.promise;
      const text = (await (await doc.getPage(1)).getTextContent()).items.map(x => x.str).join(" ").slice(0, 1400);
      const record = { state: "verified", ...proof, pages: doc.numPages, text, transport, migratedUrl, at: new Date().toISOString() };
      await task.destroy(); registry.entries[url] = record;
      if (migratedUrl) registry.entries[migratedUrl] = { ...record, migratedUrl: undefined, proofSource: url };
    } catch (e) {
      if (!registry.entries[url]) registry.entries[url] = { state: "review", reason: e.message, at: new Date().toISOString() };
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  fs.writeFileSync(file, JSON.stringify(registry, null, 1) + "\n");
  console.log(`Nightly proof admission checked ${selected.length} sources; Apps Script not used`);
})().catch(e => { console.error(e); process.exitCode = 1; });
