"use strict";
const fs = require("fs"), path = require("path"), I = require("./catalogue-identity.cjs");
function verify(catalogue, report) {
  const errors = [], papers = catalogue.papers || [], ids = new Set(papers.map(p => p.id));
  if (ids.size !== papers.length) errors.push("Duplicate active IDs");
  const keys = new Map(), hashes = new Map();
  for (const p of papers) {
    for (const k of I.listingKeys(p)) {
      if (keys.has(k) && keys.get(k) !== p.id) errors.push("Repeated source listing: " + k);
      keys.set(k, p.id);
    }
    if (p.sha256) {
      const k = p.sha256 + "|" + I.reviewKey(p);
      if (hashes.has(k)) errors.push("Same proven bytes and semantic context: " + p.id + " / " + hashes.get(k));
      hashes.set(k, p.id);
    }
  }
  for (const [alias, target] of Object.entries(catalogue.idAliases || {})) if (ids.has(alias) || !ids.has(target) || alias === target) errors.push("Invalid alias: " + alias);
  if (report.activePapers !== papers.length) errors.push("Audit count differs from the active catalogue");
  if (report.mergedImports.length + report.genuinelyAdded.length + report.reviewQueue.length !== report.importedRows) errors.push("Imports are not fully accounted for");
  if (report.unexpectedPrimaryDowngrades.length) errors.push("Unexpected primary downgrade: " + report.unexpectedPrimaryDowngrades.join(", "));
  return errors;
}
module.exports = { verify };
if (require.main === module) {
  const catalogue = JSON.parse(fs.readFileSync(path.join(__dirname, "../ui/data/papers.json"), "utf8"));
  const report = JSON.parse(fs.readFileSync(path.join(__dirname, "reconciliation-report.json"), "utf8"));
  const errors = verify(catalogue, report);
  if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
  else console.log(`Catalogue verified: ${catalogue.papers.length} active entries, ${Object.keys(catalogue.idAliases).length} historical aliases, all ${report.importedRows} imports accounted for`);
}
