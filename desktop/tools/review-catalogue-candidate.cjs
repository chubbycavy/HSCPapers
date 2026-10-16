// Review every identity/source transition against an immutable Git publication.
"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process"), I = require("./catalogue-identity.cjs"), P = require("./catalogue-publication-review.cjs");
function main() {
  const revision = process.argv.find(a => a.startsWith("--previous="))?.slice(11) || "7a3f544e20418e73f51bf0212b0513af739ba306";
  const previous = JSON.parse(execFileSync("git", ["show", revision + ":desktop/ui/data/papers-v2.json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const catalogue = require("../ui/data/papers-v2.json"), legacy = require("../ui/data/papers.json"), validation = require("./catalogue-validation.json");
  validation.ownerExclusions = require("./catalogue-document-review.json").entries;
  const errors = require("./verify-catalogue.cjs").verify(catalogue, require("./reconciliation-report.json"), validation, previous);
  const activeBefore = new Map(previous.papers.map(p => [p.id, p])), activeAfter = new Map(catalogue.papers.map(p => [p.id, p]));
  const recoveryBefore = new Map(previous.recoveryPapers.map(p => [p.id, p]));
  const promotions = [], changes = [], dispositions = [], aliases = [], recoveryChanges = [], recoveryDispositions = [];
  for (const p of catalogue.papers) {
    const before = activeBefore.get(p.id);
    if (before?.sha256 && p.sha256 !== before.sha256) errors.push("Established primary bytes changed without version disposition: " + p.id);
    for (const alt of p.alternateSources || []) if (alt.sha256 && alt.sha256 !== p.sha256 && !(before?.alternateSources || []).some(a => a.url === alt.url && a.sha256 === alt.sha256)) errors.push("New unequal file advertised as ordinary backup: " + p.id + " " + alt.url);
    for (const alias of p.libraryAliases || []) {
      const proof = validation.entries[alias.url];
      if (!alias.variantOnly && !alias.forKind && proof?.state === "verified" && proof.sha256 !== p.sha256 && !(before?.libraryAliases || []).some(a => a.url === alias.url && !a.variantOnly && !a.forKind)) errors.push("New unequal saved file satisfies primary: " + p.id + " " + alias.url);
    }
    if (!before) {
      const proof = validation.entries[p.url], issue = require("./document-admission.cjs").contextIssue(p, "primary", proof?.text, p.url);
      if (issue) errors.push(p.id + ": " + issue);
      promotions.push({ id: p.id, previousState: recoveryBefore.has(p.id) ? "recovery" : "not-active", subject: p.subject, year: p.year, school: p.school, type: p.type, keys: I.listingKeys(p), url: p.url, sha256: proof?.sha256, pages: proof?.pages, heading: proof?.text?.slice(0, 260) || "[scanned/no extracted heading]" });
    } else if (JSON.stringify(P.canonical(before)) !== JSON.stringify(P.canonical(p))) {
      changes.push({ id: p.id, fields: [...new Set([...Object.keys(before), ...Object.keys(p)])].filter(k => JSON.stringify(P.canonical(before[k])) !== JSON.stringify(P.canonical(p[k]))), before, after: p });
    }
  }
  for (const p of previous.papers) if (!activeAfter.has(p.id)) dispositions.push({ id: p.id, alias: catalogue.idAliases[p.id], recovery: catalogue.recoveryPapers.some(r => r.id === p.id) });
  const recoveryAfter = new Map(catalogue.recoveryPapers.map(p => [p.id, p]));
  for (const p of previous.recoveryPapers) {
    const after = recoveryAfter.get(p.id), target = catalogue.idAliases[p.id] || p.id;
    if (!after) recoveryDispositions.push({ id: p.id, target, active: activeAfter.has(target), recovery: recoveryAfter.has(target) });
    else if (JSON.stringify(P.canonical(p)) !== JSON.stringify(P.canonical(after))) recoveryChanges.push({ id: p.id, before: p, after });
  }
  for (const id of new Set([...Object.keys(previous.idAliases), ...Object.keys(catalogue.idAliases)])) if (previous.idAliases[id] !== catalogue.idAliases[id]) aliases.push({ id, before: previous.idAliases[id], after: catalogue.idAliases[id] });
  const fieldChanges = {}; for (const row of changes) for (const field of row.fields) fieldChanges[field] = (fieldChanges[field] || 0) + 1;
  const rejectedSourceCopies = require("./reconciliation-report.json").cleanup.rejectedSourceCopies;
  const summary = { revision, previousActive: previous.papers.length, active: catalogue.papers.length, previousRecovery: previous.recoveryPapers.length, recovery: catalogue.recoveryPapers.length, promotions: promotions.length, changedExistingActive: changes.length, activeDispositions: dispositions.length, aliasChanges: aliases.length, changedExistingRecovery: recoveryChanges.length, recoveryDispositions: recoveryDispositions.length, unresolvedRecoveryDispositions: recoveryDispositions.filter(r => !r.active && !r.recovery).length, fieldChanges, rejectedSourceCopies, sha256: P.digest(catalogue, legacy), errors };
  const out = path.join(__dirname, ".cache", "catalogue-candidate-review.json");
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify({ summary, promotions, changes, dispositions, aliases, recoveryChanges, recoveryDispositions }, null, 1) + "\n");
  console.log(JSON.stringify({ ...summary, rejectedSourceCopies: rejectedSourceCopies.length }, null, 2));
  if (process.argv.includes("--details")) console.log("Existing active changes:", JSON.stringify(changes.map(({ id, fields }) => ({ id, fields })), null, 1));
  console.log("Active dispositions:", JSON.stringify(dispositions, null, 1));
  console.log("Alias changes:", JSON.stringify(aliases, null, 1));
  const rows = promotions.map(p => `${p.year} | ${p.subject} | ${p.school} | ${p.type} | ${p.keys.join(",")} | ${p.pages}p | ${p.heading.replace(/\s+/g, " ")}`);
  fs.writeFileSync(path.join(__dirname, ".cache", "catalogue-candidate-promotions.txt"), rows.join("\n") + "\n");
  console.log("Full review:", out);
  if (errors.length) process.exitCode = 1;
}
if (require.main === module) main();
