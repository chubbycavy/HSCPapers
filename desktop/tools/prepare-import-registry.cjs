/* One-time import/review preparation using existing proof caches. The builder
   subsequently reads ONLY the committed registry, never these local caches. */
"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const I = require("./catalogue-identity.cjs");
const { legacyRecord } = require("./catalogue-reconcile.cjs");
const load = file => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const read = name => load(path.join(__dirname, name));
const catalogue = JSON.parse(execFileSync("git", ["show", "04c5584:desktop/ui/data/papers.json"], { maxBuffer: 64 * 1024 * 1024 }).toString());
const accepted = read(".cache/dedupe/accepted.json").accepted;
const base = catalogue.papers.filter(p => !p.id.startsWith("add-"));
const oldById = new Map(catalogue.papers.map(p => [p.id, p]));
const schools = [...new Set(base.map(p => p.school).filter(s => s && I.normalize(s) !== "nesa"))];
const compact = s => I.normalize(s).replace(/ /g, "");
function schoolFrom(text) {
  const t = compact(text);
  const found = schools.filter(s => t.includes(compact(s))).sort((a, b) => compact(b).length - compact(a).length);
  return found[0] || null;
}
function prepare(c) {
  const id = I.importId(c), prev = oldById.get(id);
  const row = { ...c, id, subject: I.canonicalSubject(c.subject),
    legacyRecord: prev ? legacyRecord(prev) : null };
  if (c.source === "thsc-au-growth") {
    row.listingKey = I.mirrorKey(c.hints?.mirrorRow);
    const u = new URL(c.url), text = I.routeText(row);
    row.level = /\/yr12\//.test(u.pathname) ? "HSC" : /\/yr11\//.test(u.pathname) ? "Preliminary" : /\/yr10\//.test(u.pathname) ? "Year 10" : /\/yr9\//.test(u.pathname) ? "Year 9" : null;
    row.type = /assessment/.test(u.pathname) ? "assessment" : /trialpapers/.test(u.pathname) ? "trial" : /hscpapers/.test(u.pathname) ? "hsc" : c.type;
    if (/half.yearly/.test(u.pathname)) row.examBlock = "Half-Yearly";
    if (/^(?:19|20)\d{2}\b/.test(text)) row.school = "NESA";
    row.hasSolutions = /w\.\s*sol/.test(text);
    if (!row.listingKey) { row.disposition = "review"; row.reviewReason = "Mirror row lacks an exact source-listing ID"; }
  } else if (["4unitmaths", "acehsc"].includes(c.source)) {
    const filename = decodeURIComponent(new URL(c.url).pathname.split("/").pop()).replace(/\.pdf$/i, "");
    row.year = Number((filename.match(/(?:19|20)\d{2}/) || [])[0]) || c.year || null;
    row.school = schoolFrom(filename) || (c.school && !/\d/.test(c.school) ? c.school : null);
    row.level = "HSC";
    row.type = "trial";
    row.title = filename.replace(/_/g, " ").replace(/-+/g, " ").replace(/\s+/g, " ").trim();
    row.hasSolutions = /solutions|\bw\.?\s*sol\b/i.test(filename);
    if (!row.year || !row.school || /\b(?:batch|collection|bundle|papers)\b/i.test(filename)) {
      row.disposition = "review"; row.reviewReason = "School/year or single-paper identity is not established";
    }
  } else {
    row.disposition = "review";
    row.reviewReason = c.source === "crest" ? "Free-resource PDFs need paper-vs-essay classification" : "Source requires reviewed metadata";
  }
  return row;
}
const proofs = {};
function proof(url, p) {
  if (!url || !/^[a-f0-9]{64}$/.test(p.sha256 || "") || !Number.isInteger(p.bytes) || p.bytes <= 0) return;
  if (proofs[url] && proofs[url].sha256 !== p.sha256) throw new Error("Conflicting cached byte proofs: " + url);
  proofs[url] = { sha256: p.sha256, bytes: p.bytes, ...(p.pages ? { pages: p.pages } : {}) };
}
for (const p of catalogue.papers) proof(p.url, p);
for (const [url, p] of Object.entries(read(".cache/dedupe/probes.json"))) if (p.cls === "pdf") proof(url, p);
for (const [url, p] of Object.entries(read("nesa-recovery.json").entries)) proof(p.url, { sha256: p.lastSha256, bytes: p.lastBytes });
for (const p of Object.values(read("slow-route-truth.json").entries)) if (p.ok) proof(p.url, p);
const baseline = JSON.parse(execFileSync("git", ["show", "d18474a:desktop/ui/data/papers.json"], { maxBuffer: 64 * 1024 * 1024 }).toString());
// Preserve the old desktop paths for originals whose URLs changed in the demotion workaround.
const legacyRows = {};
for (const p of baseline.papers.filter(p => !p.id.startsWith("add-"))) {
  const prev = oldById.get(p.id);
  if (prev && prev.url !== p.url) legacyRows[p.id] = [legacyRecord(prev), legacyRecord(p)];
}
const registry = { version: 1, _doc: "Reviewed import inputs, source identities, cached full-file proofs and historical IDs. Reconciled by catalogue-reconcile.cjs; no local-cache dependency in builds.",
  entries: accepted.map(prepare), proofs, legacyRows,
  previousPrimaries: Object.fromEntries(catalogue.papers.map(p => [p.id, p.url])) };
fs.writeFileSync(path.join(__dirname, "catalogue-imports.json"), JSON.stringify(registry, null, 1) + "\n");
console.log(`Committed-input registry prepared: ${registry.entries.length} imports, ${Object.keys(proofs).length} byte proofs, ${Object.keys(legacyRows).length} original path histories`);
