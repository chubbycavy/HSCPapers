// Shared production build/admission reconciliation stage. Tests exercise this
// exact pipeline with deterministic parsed-source fixtures, not a second model.
"use strict";
const identity = require("./catalogue-identity.cjs"), reconciliation = require("./catalogue-reconcile.cjs"), cleanup = require("./catalogue-cleanup.cjs");
function build(papers, { imports, validation, publishedHistory, metadataCorrections, publicationSync, correctedMappings = [], removals = { ids: new Set(), urls: new Set() }, isFastHost = require("../ui/js/source-policy.js").isFast }) {
  const schema = require("../ui/js/catalogue-schema.js");
  for (const p of papers) { const issue = schema.metadataIssue(p); if (issue) throw new Error(issue + " before reconciliation"); }
  for (const p of papers) {
    const proof = imports.proofs[p.url];
    if (proof) Object.assign(p, proof);
    if (imports.legacyRows[p.id]) p.libraryAliases = imports.legacyRows[p.id].filter(r => {
      const official = /(?:nsw\.gov\.au|boardofstudies\.nsw\.edu\.au|web\.archive\.org)/.test(r.url || "");
      return r.url === p.url || !official || identity.officialReplacementAllowed(p, { url: r.url });
    });
  }
  const metadataChanges = cleanup.prepareMetadata(papers, metadataCorrections, validation);
  const migratedHistory = cleanup.history(papers, publishedHistory, validation);
  const originals = reconciliation.coalesceExisting(papers, { validation });
  const eligibleImports = { ...imports, entries: imports.entries.filter(r => !removals.ids.has(r.id) && !removals.urls.has(r.url)) };
  const reconciled = reconciliation.applyImports(papers, eligibleImports, { metadataCorrections, validation });
  const aliasGraph = { ...publishedHistory.aliases, ...originals.aliases, ...reconciled.aliases, ...migratedHistory.aliases };
  const present = new Set(papers.map(p => p.id));
  for (const old of publishedHistory.records || []) {
    if (present.has(cleanup.resolveAlias(old.id, aliasGraph)) || removals.ids.has(old.id) || removals.urls.has(old.url)) continue;
    const restored = structuredClone(old); cleanup.prepareMetadata([restored], metadataCorrections, validation); papers.push(restored); present.add(restored.id);
  }
  const cleaned = cleanup.apply(papers, validation, metadataCorrections);
  const classificationCopies = reconciliation.coalesceClassificationCopies(papers, validation);
  Object.assign(aliasGraph, classificationCopies.aliases);
  const provedCopies = reconciliation.coalesceExisting(papers, { validation });
  Object.assign(aliasGraph, provedCopies.aliases);
  const versions = reconciliation.coalesceVersions(papers, validation);
  Object.assign(aliasGraph, versions.aliases);
  const attachedDocs = reconciliation.coalesceAttachedDocuments(papers, validation);
  Object.assign(aliasGraph, attachedDocs.aliases);
  const sharedEnglish = reconciliation.coalesceSharedEnglish(papers, validation);
  Object.assign(aliasGraph, sharedEnglish.aliases);
  const sharedFiles = new Map();
  for (const p of papers) { if (!sharedFiles.has(p.url)) sharedFiles.set(p.url, []); sharedFiles.get(p.url).push(p); }
  const mappingReview = [], disputed = new Set();
  for (const [url, rows] of sharedFiles) {
    if (rows.length < 2 || new Set(rows.map(identity.semanticFileKey)).size < 2) continue;
    mappingReview.push({ url, ids: rows.map(p => p.id), reason: "Same primary file is advertised under differing assessment/document contexts; awaiting reviewed mapping" });
    for (const p of rows) {
      disputed.add(p.id); p.libraryAliases ||= []; p.libraryAliases.push(reconciliation.legacyRecord(p));
      p.provenanceSources ||= []; p.provenanceSources.push({ url, role: "primary", reason: "Document relationship requires mapping review" });
      p.availability = { state: "review", reason: "Verified PDF, but its assessment/part/role mapping is not established" };
      p.url = ""; p.solutionUrl = ""; p.fallbackUrl = ""; p.solFallbackUrl = ""; p.alternateSources = []; p.fileVariants = [];
      cleaned.recovery.push(p);
    }
  }
  papers.splice(0, papers.length, ...papers.filter(p => !disputed.has(p.id)));
  reconciled.report.added = reconciled.report.added.filter(id => {
    const target = cleanup.resolveAlias(id, aliasGraph);
    if (target === id) return true;
    reconciled.report.merged.push({ id, canonicalId: target, reason: "fresh-full-sha-and-semantic-context" }); return false;
  });
  const currentMerges = { ...originals.aliases, ...reconciled.aliases, ...classificationCopies.aliases, ...provedCopies.aliases, ...versions.aliases, ...attachedDocs.aliases, ...sharedEnglish.aliases, ...migratedHistory.aliases };
  const recoveryPapers = cleaned.recovery.filter(p => !currentMerges[p.id]);
  const recoveryCopies = reconciliation.coalesceExisting(recoveryPapers, { validation });
  Object.assign(aliasGraph, recoveryCopies.aliases);
  const idAliases = cleanup.finalizeAliases(aliasGraph, papers, recoveryPapers);
  const publicationBindings = require("./publication-continuity.cjs").apply(papers, publicationSync, validation, idAliases);
  const rejectedSourceCopies = cleanup.restrictCopies(papers, validation);
  const correctionIds = new Set(correctedMappings.map(r => r.id));
  const unexpectedPrimaryDowngrades = papers.filter(p => imports.previousPrimaries[p.id] && identity.isDirect(imports.previousPrimaries[p.id]) && !identity.isDirect(p.url) && !correctionIds.has(p.id)).map(p => p.id);
  const finalFileCount = papers.reduce((n, p) => n + Number(!!p.url) + Number(!!p.solutionUrl), 0);
  const finalDirectCount = papers.reduce((n, p) => n + Number(!!isFastHost(p.url)) + Number(!!isFastHost(p.solutionUrl)), 0);
  const reconciliationReport = {
    version: 1, previousPublishedListings: 10368, activePapers: papers.length, importedRows: imports.entries.length,
    mergedImports: reconciled.report.merged, genuinelyAdded: reconciled.report.added, reviewQueue: reconciled.report.review, existingMerges: originals.report.merged,
    sharedUrlMappingReview: mappingReview, correctedMappings, unexpectedPrimaryDowngrades,
    limitations: "Exact source-listing identities establish logical copies. Shared hashes/URLs with different semantic contexts are not merged. Unresolved imports remain in review, not in the active count.",
    filePointers: finalFileCount, directFilePointers: finalDirectCount,
    resolverPrimaries: papers.filter(p => identity.routerKey(p.url) && !/thsconline\.net/.test(p.url)).length,
    fragmentPrimaries: papers.filter(p => /thsconline\.net\/s\/v\//.test(p.url)).length,
    recoveryPapers: recoveryPapers.length,
    publicationSync: { sourceCommit: publicationSync.sourceCommit, bindings: publicationBindings },
    cleanup: { metadataChanges, identityChanges: migratedHistory.changes, classificationMerges: classificationCopies.merged, fullByteMerges: provedCopies.report.merged, versionMerges: versions.merged, attachedDocumentMerges: attachedDocs.merged, sharedEnglishMerges: sharedEnglish.merged, rejectedSources: cleaned.rejectedSources, rejectedSourceCopies, auditCoverage: validation.coverage },
  };
  const modernCatalogue = { generated: new Date().toISOString(), dataVersion: 2, sources: "desktop/sources.json", idAliases, recoveryPapers, papers };
  schema.assert(modernCatalogue);
  const compatibility = require("./catalogue-feeds.cjs").prepare(modernCatalogue, validation);
  const errors = require("./catalogue-feeds.cjs").verify(modernCatalogue, compatibility.legacy);
  if (errors.length) throw new Error(errors.join("\n"));
  return { modernCatalogue, compatibility, reconciliationReport, finalFileCount, finalDirectCount };
}
module.exports = { build };
