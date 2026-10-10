"use strict";
const fs = require("fs"), path = require("path");
const read = f => JSON.parse(fs.readFileSync(path.join(__dirname, f), "utf8"));
const report = read("reconciliation-report.json"), catalogue = read("../ui/data/papers.json"), registry = read("catalogue-imports.json");
const rows = new Map(registry.entries.map(r => [r.id, r]));
const bySource = {};
for (const [name, ids] of [["merged", report.mergedImports.map(r => r.id)], ["added", report.genuinelyAdded], ["review", report.reviewQueue.map(r => r.id)]]) {
  for (const id of ids) { const source = rows.get(id)?.source || "unknown"; bySource[source] ||= { merged: 0, added: 0, review: 0 }; bySource[source][name]++; }
}
const text = ["# v1.0.26 catalogue reconciliation", "",
  "## Correction to earlier release claims", "",
  "The 10,368 figure counted listings, including mirror copies. v1.0.25 made URLs distinct but left duplicate cards. Its census iterated a Map with Object.entries(), so no SHA-confirmation candidates were processed. Its claim of catalogue-wide uniqueness is withdrawn.", "",
  "## Current accounting", "",
  `- Active catalogue entries: **${catalogue.papers.length}** (previously 10,368).`,
  `- Imported rows reconciled: ${report.importedRows}.`,
  `- Mirror/copy imports merged into existing entries: **${report.mergedImports.length}**.`,
  `- Added after metadata and identity checks: **${report.genuinelyAdded.length}**.`,
  `- Imports retained in the committed review registry, excluded from active totals: **${report.reviewQueue.length}**.`,
  `- Existing-copy merges: ${report.existingMerges.length}.`,
  `- Historical IDs resolving to active entries: ${Object.keys(catalogue.idAliases).length}.`, "",
  `- Direct-file pointers: ${report.directFilePointers}/${report.filePointers}; resolver primaries: ${report.resolverPrimaries}.`, "",
  "| Source | Merged | Added | Review |", "|---|---:|---:|---:|",
  ...Object.entries(bySource).sort(([a], [b]) => a.localeCompare(b)).map(([s, x]) => `| ${s} | ${x.merged} | ${x.added} | ${x.review} |`), "",
  "## Evidence and preservation rules", "",
  "Exact listing directory/name identifies a logical paper independent of its mirror URL. Matching full hashes plus semantic context also establish copies. School/year tuples alone are review hints, not proof. Paper numbers, document roles, provider, school level and exam blocks remain distinct.", "",
  "Canonical entries retain the original ID and richer metadata. Mirror URLs and their cached byte proofs are alternative sources; historical metadata is preserved for desktop library path recognition. Alias IDs are not separate cards. No files already downloaded by users are deleted or renamed.", "",
  "## Limits and remaining review", "",
  `Shared-URL groups with differing document metadata recorded for mapping review: ${report.sharedUrlMappingReview.length}. These are not silently merged or disguised by URL demotion.`,
  `Rejected official replacements recorded: ${report.correctedMappings.length} (trial/assessment, provider or paper-part mismatches).`,
  "The census now distinguishes full-file hash evidence from incomplete HEAD coverage. This report does not claim every historical PDF is byte-unique or every legacy mapping has been repaired. The unresolved queue and complete row-level decisions are in reconciliation-report.json and catalogue-imports.json.", "",
  "## Reproducible builds", "",
  "The catalogue reads committed catalogue-imports.json, never local dedupe acceptance/census state. The nightly build runs unit tests and verify-catalogue.cjs before publishing. Public counts derive from active canonical entries.", ""];
fs.writeFileSync(path.join(__dirname, "reconciliation-report.md"), text.join("\n"));
console.log("Human-readable reconciliation report written");
