// Reviewed metadata is conditional on a particular source and full-file proof.
"use strict";
function issue(p, fix, validation) {
  if (!fix?.when) return null;
  if (p.url !== fix.when.url) return "Reviewed metadata source URL changed";
  const proof = validation?.entries?.[p.url];
  if (proof?.state !== "verified") return "Reviewed metadata awaits verified source proof";
  if (proof.sha256 !== fix.when.sha256) return "Reviewed metadata source hash changed";
  return null;
}
function hold(p, validation) {
  if (p.reviewedHold) return p.reviewedHold;
  const entry = validation?.ownerExclusions?.[p.id];
  if (!entry?.preMerge || (entry.url && entry.url !== p.url)) return null;
  const proof = validation?.entries?.[p.url];
  return proof?.state === "verified" && (!entry.sha256 || entry.sha256 === proof.sha256) ? entry.reason : null;
}
function mark(p, key, value) { Object.defineProperty(p, key, { value, configurable: true, enumerable: false }); }
function sameBytes(validation, a, b) {
  const x = validation?.entries?.[a], y = validation?.entries?.[b];
  return !!x?.sha256 && x.state === "verified" && y?.state === "verified" && x.sha256 === y.sha256;
}
function expand(registry) {
  const entries = { ...registry.entries };
  for (const group of registry.reviewedGroups || []) {
    const mirrorId = "add-thsc-au-growth-" + group.sha256.slice(0, 10);
    for (const id of [...group.portalIds, mirrorId]) entries[id] = {
      when: { url: id === mirrorId ? group.mirrorUrl : group.portalUrl, sha256: id === mirrorId ? group.sha256 : group.portalSha256 || group.sha256 },
      canonicalId: group.canonicalId,
      ...(group.disposition !== "review-portal" ? { primaryUrl: group.mirrorUrl } : {}),
      fields: { subject: "Maths (Accelerated)", level: "Preliminary", type: "assessment", examBlock: "Yearly", title: `${group.year} Sydney Boys Mathematics Accelerated Yearly Examination` },
      reason: group.reason || "Reviewed exact portal/mirror bytes and source-supported Year 11 accelerated yearly classification; not a global curriculum normalization",
    };
  }
  return entries;
}
module.exports = { issue, hold, mark, sameBytes, expand };
