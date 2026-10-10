/* HEAD only shortlists candidates. Missing lengths/MIME and unconfirmed pairs
   are explicit; full-file hashes participate in comparisons. --report is read-only. */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
function collectEvidence(papers, state = {}, proofs = {}) {
  const files = new Map();
  function add(url, owner, proof) {
    if (!url) return;
    const f = files.get(url) || { url, owners: [], sha256: null, bytes: null };
    if (!f.owners.some(x => x.id === owner.id && x.role === owner.role)) f.owners.push(owner);
    if (proof && /^[a-f0-9]{64}$/.test(proof.sha256 || "") && proof.bytes > 0) { f.sha256 = proof.sha256; f.bytes = proof.bytes; }
    files.set(url, f);
  }
  for (const p of papers) {
    add(p.url, { id: p.id, role: "primary" }, p.sha256 ? p : proofs[p.url]);
    add(p.solutionUrl, { id: p.id, role: "solutions" }, proofs[p.solutionUrl]);
    for (const alt of p.alternateSources || []) add(alt.url, { id: p.id, role: "alternate" }, alt);
  }
  const byHash = new Map(), byLength = new Map();
  const coverage = { urls: files.size, fullHashes: 0, headerOnly: 0, incomplete: 0 };
  for (const f of files.values()) {
    const verified = state.verified?.[f.url];
    if (!f.sha256 && verified && /^[a-f0-9]{64}$/.test(verified.sha || "")) { f.sha256 = verified.sha; f.bytes = verified.bytes || f.bytes; }
    const head = state.heads?.[f.url];
    if (f.sha256) {
      coverage.fullHashes++;
      if (!byHash.has(f.sha256)) byHash.set(f.sha256, []);
      byHash.get(f.sha256).push(f);
    } else if (head?.status === 200 && head.len > 0 && /^application\/pdf\b/i.test(head.contentType || "")) coverage.headerOnly++;
    else coverage.incomplete++;
    const len = f.bytes || (head?.status === 200 && /^application\/pdf\b/i.test(head.contentType || "") ? head.len : 0);
    if (len > 0) { if (!byLength.has(len)) byLength.set(len, []); byLength.get(len).push(f); }
  }
  const candidateGroups = [...byLength.entries()].filter(([, rows]) => rows.length > 1 && rows.some(f => !f.sha256));
  const byteDuplicateGroups = [...byHash.entries()].filter(([, rows]) => rows.length > 1);
  return { coverage, candidateGroups, byteDuplicateGroups, complete: coverage.fullHashes === coverage.urls,
    conclusion: coverage.fullHashes === coverage.urls ? "Full hash coverage" : "Incomplete byte coverage; no catalogue-wide uniqueness claim" };
}
module.exports = { collectEvidence };
if (require.main === module) (async () => {
  const dir = path.join(__dirname, ".cache", "census"), file = path.join(dir, "state.json");
  const read = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return fallback; } };
  const state = read(file, { heads: {}, verified: {} });
  const catalogue = read(path.join(__dirname, "..", "ui", "data", "papers.json"), { papers: [] });
  const imports = read(path.join(__dirname, "catalogue-imports.json"), { proofs: {} });
  let result = collectEvidence(catalogue.papers, state, imports.proofs);
  console.log(JSON.stringify({ ...result.coverage, unconfirmedLengthGroups: result.candidateGroups.length,
    provedSameByteGroups: result.byteDuplicateGroups.length, complete: result.complete, conclusion: result.conclusion }, null, 2));
  if (!process.argv.includes("--verify")) return;
  const arg = process.argv.find(a => a.startsWith("--limit="));
  const limit = arg ? Number(arg.slice(8)) : 25;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a positive integer");
  const pending = [...new Set(result.candidateGroups.flatMap(([, rows]) => rows.filter(r => !r.sha256).map(r => r.url)))].slice(0, limit);
  fs.mkdirSync(dir, { recursive: true }); state.verified ||= {};
  for (const url of pending) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "HSCPapers/1.0 (targeted content verification)", "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(30000) });
      const bytes = Buffer.from(await res.arrayBuffer());
      if (res.status !== 200 || bytes.subarray(0, 5).toString() !== "%PDF-") throw new Error("Not a full PDF: " + res.status);
      state.verified[url] = { sha: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, at: new Date().toISOString() };
    } catch (e) { state.verified[url] = { error: e.message, at: new Date().toISOString() }; }
    fs.writeFileSync(file, JSON.stringify(state, null, 1) + "\n");
    await new Promise(r => setTimeout(r, 1100));
  }
  result = collectEvidence(catalogue.papers, state, imports.proofs); console.log(result.conclusion);
})().catch(e => { console.error(e); process.exitCode = 1; });
