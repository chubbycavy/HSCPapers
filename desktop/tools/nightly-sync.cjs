// Reconcile generated upstream updates without checking out over the dirty candidate.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");
globalThis.crypto ||= crypto.webcrypto;
const root = path.resolve(__dirname, "../.."), cache = path.join(__dirname, ".cache/release-readiness/nightly-sync");
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
const load = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 1) + "\n");
const show = (sha, file) => JSON.parse(git("show", sha + ":" + file));
async function main() {
  if (process.argv.includes("--inspect")) {
    const base = git("rev-parse", "HEAD"), target = git("rev-parse", "origin/main");
    if (fs.existsSync(cache)) throw new Error("Nightly checkpoint exists; inspect it rather than replacing it");
    const files = git("diff", "--name-only", base + ".." + target).split("\n").filter(Boolean);
    const allowed = new Set(["desktop/tools/reconciliation-report.json", "desktop/tools/thsc-au-verified.json", "desktop/ui/coverage.html", "desktop/ui/data/papers.json", "desktop/ui/sitemap.xml"]);
    if (files.some(f => !allowed.has(f))) throw new Error("Upstream includes non-generated changes requiring review: " + files.join(", "));
    fs.mkdirSync(cache, { recursive: true });
    const before = path.join(cache, "candidate"); fs.mkdirSync(before);
    for (const file of ["desktop/ui/data/papers.json", "desktop/ui/data/papers-v2.json", "desktop/tools/catalogue-validation.json", "desktop/tools/catalogue-history.json", "desktop/tools/thsc-au-verified.json", "desktop/tools/release-readiness-artifact.json", "desktop/ui/js/app.js"]) {
      const dest = path.join(before, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(path.join(root, file), dest);
    }
    fs.copyFileSync(path.join(root, "desktop/src-tauri/target/release/bundle/nsis/HSCPapers_1.0.27_x64-setup.exe"), path.join(cache, "tested-1.0.27-86061df7.exe"));
    const previous = show(base, "desktop/ui/data/papers.json"), published = show(target, "desktop/ui/data/papers.json");
    const oldById = new Map(previous.papers.map(p => [p.id, p]));
    const changed = published.papers.filter(p => {
      const old = oldById.get(p.id); return !old || old.url !== p.url || old.solutionUrl !== p.solutionUrl;
    });
    const plan = { version: 1, base, target, files, commits: git("log", "--oneline", base + ".." + target).split("\n"), publishedRecords: published.papers.length, changed };
    write(path.join(cache, "plan.json"), plan); write(path.join(cache, "published.json"), published);
    write(path.join(cache, "upstream-mirror.json"), show(target, "desktop/tools/thsc-au-verified.json"));
    console.log(JSON.stringify({ ...plan, changed: changed.map(p => ({ id: p.id, url: p.url, sha256: p.sha256 })) }, null, 2)); return;
  }
  if (!process.argv.includes("--apply")) throw new Error("Use --inspect then --apply");
  const plan = JSON.parse(fs.readFileSync(path.join(cache, "plan.json"), "utf8"));
  if (git("rev-parse", "origin/main") !== plan.target) throw new Error("Remote tracking head changed; review the new delta first");
  const upstream = JSON.parse(fs.readFileSync(path.join(cache, "upstream-mirror.json"), "utf8"));
  const mirror = load("desktop/tools/thsc-au-verified.json"), registry = load("desktop/tools/catalogue-validation.json");
  const candidate = JSON.parse(fs.readFileSync(path.join(cache, "candidate/desktop/ui/data/papers-v2.json"), "utf8"));
  const oldEntries = new Map(mirror.entries.map(e => [e.key, e]));
  const delta = upstream.entries.filter(e => { const old = oldEntries.get(e.key); return !old || old.url !== e.url || old.sha256 !== e.sha256 || old.bytes !== e.bytes || old.pages !== e.pages; });
  const proofs = new Map();
  // All changes are established against both remote proof and our reviewed bytes.
  // Validate first; no registry/source edits are written on a partial failure.
  for (const entry of delta) {
    const reference = Object.values(registry.entries).find(p => p.state === "verified" && p.sha256 === entry.sha256);
    if (!reference) throw new Error("New mirror bytes require additional content review: " + entry.key);
    const verified = await require("./thsc-au.cjs").validate(entry);
    if (verified.sha256 !== entry.sha256) throw new Error("Mirror hash drift: " + entry.key);
    // validate() checked full bytes/page count; known reviewed SHA excludes errors.
    proofs.set(entry.url, { ...reference, state: "verified", transport: "direct-pdf", migratedUrl: undefined, proofSource: entry.key, at: verified.verifiedAt });
    oldEntries.set(entry.key, verified);
    console.log("Mirror matched reviewed bytes:", entry.key, entry.sha256, entry.bytes);
    await new Promise(r => setTimeout(r, 150));
  }
  const ledger = { version: 1, base: plan.base, sourceCommit: plan.target, commits: plan.commits, checkedAt: new Date().toISOString(), entries: [] };
  for (const published of plan.changed) {
    const canonicalId = candidate.idAliases[published.id] || published.id;
    const current = [...candidate.papers, ...candidate.recoveryPapers].find(p => p.id === canonicalId);
    if (!current) throw new Error("Newest publication identity is missing: " + published.id);
    const proof = proofs.get(published.url) || registry.entries[published.url];
    if (!proof || proof.sha256 !== published.sha256) throw new Error("Published source lacks matching reviewed proof: " + published.id);
    ledger.entries.push({ published, previousCandidate: current });
  }
  for (const [url, proof] of proofs) registry.entries[url] = proof;
  registry.nightlySync = { sourceCommit: plan.target, checkedAt: ledger.checkedAt, verifiedMirrorFiles: delta.length };
  write(path.join(__dirname, "catalogue-validation.json"), registry);
  write(path.join(__dirname, "thsc-au-verified.json"), { ...mirror, entries: [...oldEntries.values()].sort((a,b) => a.key.localeCompare(b.key)) });
  write(path.join(__dirname, "catalogue-publication-sync.json"), ledger);
  write(path.join(cache, "applied.json"), { sourceCommit: plan.target, verifiedMirrorFiles: delta.length, publishedSources: ledger.entries.length, at: ledger.checkedAt });
  console.log(`Reconciled ${delta.length} mirror proofs and ${ledger.entries.length} published source changes`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
