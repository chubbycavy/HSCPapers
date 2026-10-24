"use strict";
const fs = require("fs"), path = require("path"), I = require("./catalogue-identity.cjs");
function newActiveIds(catalogue, previous) {
  if (!previous) return [];
  const previousIds = new Set([...(previous.papers || []), ...(previous.recoveryPapers || [])].map(p => p.id));
  const allowed = new Set(previousIds);
  for (const id of previousIds) {
    const target = catalogue.idAliases?.[id];
    if (target) allowed.add(target);
  }
  for (const id of Object.keys(previous.idAliases || {})) {
    const target = catalogue.idAliases?.[id] || id;
    if (target) allowed.add(target);
  }
  return (catalogue.papers || []).filter(p => !allowed.has(p.id)).map(p => p.id);
}
function verify(catalogue, report, validation, previous, maxNew = null) {
  const errors = require("../ui/js/catalogue-schema.js").issues(catalogue), papers = catalogue.papers || [], ids = new Set(papers.map(p => p.id));
  const recovery = catalogue.recoveryPapers || [], allIds = new Set([...ids, ...recovery.map(p => p.id)]);
  if (allIds.size !== papers.length + recovery.length) errors.push("Duplicate active/recovery IDs");
  if (ids.size !== papers.length) errors.push("Duplicate active IDs");
  const keys = new Map(), hashes = new Map();
  for (const p of papers) {
    if (validation) {
      const cleanup = require("./catalogue-cleanup.cjs");
      for (const [url, role] of [[p.url, "primary"], [p.solutionUrl, "solutions"], [p.fallbackUrl, "primary"], [p.solFallbackUrl, "solutions"], ...(p.alternateSources || []).map(a => [a.url, "primary"]), ...(p.fileVariants || []).map(v => [v.url, v.role === "solutions" ? "solutions" : "primary"])]) {
        if (url && !cleanup.proofFor(p, url, role, validation)) errors.push("Unverified/invalid active source: " + p.id + " " + url);
      }
      if (!p.url) errors.push("Active paper has no file: " + p.id);
      for (const url of [p.fallbackUrl, ...(p.alternateSources || []).map(a => a.url)].filter(Boolean)) if (!require("./reviewed-corrections.cjs").sameBytes(validation, p.url, url)) errors.push("Unequal primary backup requires version review: " + p.id + " " + url);
    }
    for (const k of I.listingKeys(p)) {
      const other = keys.get(k);
      if (other && other.id !== p.id) errors.push("Repeated source listing: " + k + " " + JSON.stringify([other, p].map(row => ({ id: row.id, subject: row.subject, level: row.level, role: I.sourceContext(row).split("|")[2], url: row.url }))));
      keys.set(k, p);
    }
    if (p.sha256) {
      const k = p.sha256 + "|" + I.reviewKey(p);
      if (hashes.has(k)) errors.push("Same proven bytes and semantic context: " + p.id + " / " + hashes.get(k));
      hashes.set(k, p.id);
    }
  }
  for (const [alias, target] of Object.entries(catalogue.idAliases || {})) if (allIds.has(alias) || !allIds.has(target) || alias === target) errors.push("Invalid alias: " + alias);
  for (const p of recovery) if (p.url || p.solutionUrl || p.fallbackUrl || p.solFallbackUrl || p.alternateSources?.length) errors.push("Recovery record advertises online action: " + p.id);
  for (const p of papers) {
    if (/^unspecified(?:\s+school)?$/i.test(String(p.school || "").trim())) errors.push("Unidentified school in active catalogue: " + p.id);
    const officialSolutions = p.school === "NESA" && p.type === "hsc";
    if (p.documentRole === "solutions" && !officialSolutions) errors.push("Unpaired solution-only active record: " + p.id);
  }
  if (previous) {
    const removed = require("./removals.json").entries || [];
    let withdrawals = [];
    try { withdrawals = JSON.parse(fs.readFileSync(path.join(__dirname, "catalogue-withdrawals.json"), "utf8")).entries || []; }
    catch { /* no quality quarantine registry yet */ }
    const exceptions = new Set([...removed, ...withdrawals].map(r => r.id));
    for (const id of [...(previous.papers || []), ...(previous.recoveryPapers || [])].map(p => p.id).concat(Object.keys(previous.idAliases || {}))) {
      const target = catalogue.idAliases?.[id] || id;
      if (!allIds.has(target) && !exceptions.has(id)) errors.push("Published identity disappeared without disposition: " + id);
    }
    if (maxNew != null) {
      const added = newActiveIds(catalogue, previous);
      if (added.length > maxNew) errors.push(`Unexpected new active IDs (${added.length} > ${maxNew}): ${added.slice(0, 20).join(", ")}${added.length > 20 ? ", …" : ""}`);
    }
  }
  if (report.activePapers !== papers.length) errors.push("Audit count differs from the active catalogue");
  if (report.mergedImports.length + report.genuinelyAdded.length + report.reviewQueue.length !== report.importedRows) errors.push("Imports are not fully accounted for");
  if (report.unexpectedPrimaryDowngrades.length) errors.push("Unexpected primary downgrade: " + report.unexpectedPrimaryDowngrades.join(", "));
  return errors;
}
module.exports = { verify, newActiveIds };
if (require.main === module) {
  const catalogue = JSON.parse(fs.readFileSync(path.join(__dirname, "../ui/data/papers-v2.json"), "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, "reconciliation-report.json"), "utf8"));
  const validation = JSON.parse(fs.readFileSync(path.join(__dirname, "catalogue-validation.json"), "utf8"));
  validation.ownerExclusions = JSON.parse(fs.readFileSync(path.join(__dirname, "catalogue-document-review.json"), "utf8")).entries;
  const arg = process.argv.find(a => a.startsWith("--previous="));
  const previous = arg ? JSON.parse(fs.readFileSync(arg.slice(11), "utf8")) : null;
  const maxArg = process.argv.find(a => a.startsWith("--max-new="));
  const maxNew = maxArg ? Number(maxArg.slice("--max-new=".length)) : null;
  const summaryArg = process.argv.find(a => a.startsWith("--summary="));
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, "../ui/data/papers.json"), "utf8"));
  const publication = require("./catalogue-publication-review.cjs");
  const publicationSync = JSON.parse(fs.readFileSync(path.join(__dirname, "catalogue-publication-sync.json"), "utf8"));
  const errors = [...verify(catalogue, report, validation, previous, maxNew), ...require("./catalogue-feeds.cjs").verify(catalogue, legacy), ...require("./publication-continuity.cjs").verify(catalogue, publicationSync, validation)];
  const previousIds = new Set((previous?.papers || []).map(p => p.id));
  const currentIds = new Set((catalogue.papers || []).map(p => p.id));
  const summary = {
    generated: new Date().toISOString(),
    maxNew,
    active: catalogue.papers.length,
    recovery: (catalogue.recoveryPapers || []).length,
    aliases: Object.keys(catalogue.idAliases || {}).length,
    imports: report.importedRows,
    previousActive: previous ? (previous.papers || []).length : null,
    newActiveIds: previous ? newActiveIds(catalogue, previous) : [],
    removedActiveIds: previous ? [...previousIds].filter(id => !currentIds.has(id)) : [],
    digest: publication.digest(catalogue, legacy),
    errors
  };
  if (summaryArg) fs.writeFileSync(summaryArg.slice("--summary=".length), JSON.stringify(summary, null, 1) + "\n");
  if (process.argv.includes("--digest-only")) { console.log(summary.digest); process.exit(0); }
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log(`Catalogue verified: ${catalogue.papers.length} active entries, ${Object.keys(catalogue.idAliases).length} historical aliases, all ${report.importedRows} imports accounted for`);
}
