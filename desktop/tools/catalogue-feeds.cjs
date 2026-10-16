// The unversioned endpoint is reserved for released consumers that ignore schema tags.
"use strict";
const I = require("./catalogue-identity.cjs"), R = require("./catalogue-reconcile.cjs");
const policy = require("../ui/js/source-policy.js");
const reviewed = require("./reviewed-corrections.cjs");
const BRIDGE = "https://hscpapers.com/proxy";
function bridge(url) { return policy.deliveryHref(url, BRIDGE); }
function prepare(modern, validation) {
  const papers = [], stats = { bridgedPrimaries: 0, bridgedSolutions: 0, excludedRoleAliases: 0 };
  for (const p of modern.papers) {
    const before = R.legacyRecord(p);
    const historical = [before, ...(p.libraryAliases || [])];
    const row = { ...p, url: bridge(p.url), solutionUrl: p.solutionUrl ? bridge(p.solutionUrl) : "", fallbackUrl: "", solFallbackUrl: "" };
    if (row.url !== p.url) stats.bridgedPrimaries++;
    if (row.solutionUrl !== (p.solutionUrl || "")) stats.bridgedSolutions++;
    row.libraryAliases = historical.filter(a => {
      const safe = !a.forKind && !a.savedKind && !a.variantOnly && (I.compatibleSourceContext(p, a) || reviewed.sameBytes(validation, p.url, a.url));
      if (!safe) stats.excludedRoleAliases++;
      return safe;
    }).map(a => {
      const alias = { ...a };
      if (validation && alias.solutionUrl && !reviewed.sameBytes(validation, p.solutionUrl, alias.solutionUrl)) delete alias.solutionUrl;
      return alias;
    });
    // Old clients treat every alias as both paper and solution; decorated role
    // aliases must never leak into this projection.
    delete row.alternateSources; delete row.fileVariants; delete row.provenanceSources;
    const bridgeRows = historical.map(a => ({ ...a, url: bridge(a.url), ...(a.solutionUrl ? { solutionUrl: bridge(a.solutionUrl) } : {}) }))
      .filter((a, i) => a.url !== historical[i].url || a.solutionUrl !== historical[i].solutionUrl);
    p.libraryAliases = [...new Map([...(p.libraryAliases || []), ...bridgeRows].map(a => [JSON.stringify(a), a])).values()];
    papers.push(row);
  }
  return { legacy: { _comment: "Compatibility projection for v1.0.26: supported PDF URLs, no role-dependent aliases or raw router descriptors. Modern consumers use papers-v2.json.", generated: modern.generated, dataVersion: 1, idAliases: modern.idAliases, papers }, stats };
}
function verify(modern, legacy) {
  const errors = [];
  if (modern.dataVersion !== 2 || legacy.dataVersion !== 1) errors.push("Wrong catalogue schema/version");
  if (modern.papers.length !== legacy.papers.length) errors.push("Compatibility projection lost available records");
  const byId = new Map(modern.papers.map(p => [p.id, p]));
  for (const p of legacy.papers) {
    const original = byId.get(p.id);
    if (!original || p.url !== bridge(original.url) || (p.solutionUrl || "") !== bridge(original.solutionUrl || "")) errors.push("Compatibility delivery differs: " + p.id);
    if (policy.isLegacy(p.url) || policy.isFragment(p.url) || policy.isLegacy(p.solutionUrl) || policy.isFragment(p.solutionUrl)) errors.push("Raw descriptor in compatibility feed: " + p.id);
    if ((p.libraryAliases || []).some(a => a.forKind || a.savedKind || a.variantOnly)) errors.push("Role-dependent alias exposed to old consumer: " + p.id);
    if (p.fallbackUrl || p.solFallbackUrl) errors.push("Old resolver fallback exposed: " + p.id);
  }
  return errors;
}
module.exports = { bridge, prepare, verify };
