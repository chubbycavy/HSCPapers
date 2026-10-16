// Full-byte bindings preserve filenames without conflating question/combined versions.
"use strict";
const R = require("./catalogue-reconcile.cjs"), cleanup = require("./catalogue-cleanup.cjs"), policy = require("../ui/js/source-policy.js");
function add(rows, row) { if (!rows.some(a => JSON.stringify(a) === JSON.stringify(row))) rows.push(row); }
function proofHash(validation, url) { const p = validation.entries[url]; return p?.state === "verified" ? p.sha256 : null; }
function primaryAlias(p, row, validation) {
  const alias = R.legacyRecord(row);
  if (proofHash(validation, alias.solutionUrl) !== proofHash(validation, p.solutionUrl)) delete alias.solutionUrl;
  p.libraryAliases ||= []; add(p.libraryAliases, alias);
}
function solutionAlias(p, row, savedKind) {
  p.libraryAliases ||= [];
  add(p.libraryAliases, { ...R.legacyRecord(row), forKind: "solutions", savedKind });
}
function apply(papers, ledger, validation, aliases) {
  const ids = new Map(papers.map(p => [p.id, p])), bindings = [];
  for (const { published, previousCandidate } of ledger.entries) {
    const id = cleanup.resolveAlias(published.id, aliases), p = ids.get(id);
    if (!p) throw new Error("Published source has no active reviewed owner: " + published.id);
    const sha = proofHash(validation, published.url);
    if (!sha || sha !== published.sha256) throw new Error("Published source proof changed: " + published.id);
    let role = null;
    if (proofHash(validation, p.url) === sha) {
      if (!cleanup.proofFor(p, published.url, "primary", validation)) throw new Error("Mirror context conflicts with primary: " + p.id);
      primaryAlias(p, published, validation);
      if (previousCandidate && proofHash(validation, previousCandidate.url) === sha) primaryAlias(p, previousCandidate, validation);
      if (!policy.isFast(p.url) && policy.isFast(published.url)) {
        const previous = p.url; primaryAlias(p, p, validation);
        p.url = published.url; p.mirror = "thsc-au";
        const proof = validation.entries[previous];
        R.addAlternative(p, { url: previous, sha256: proof.sha256, bytes: proof.bytes, pages: proof.pages, source: proof.transport || "verified-alternative" });
      }
      role = "primary";
    }
    if (proofHash(validation, p.solutionUrl) === sha) {
      if (!cleanup.proofFor(p, published.url, "solutions", validation)) throw new Error("Mirror context conflicts with solutions: " + p.id);
      solutionAlias(p, published, "paper");
      if (previousCandidate?.solutionUrl && proofHash(validation, previousCandidate.solutionUrl) === sha) solutionAlias(p, previousCandidate, "solutions");
      if (!policy.isFast(p.solutionUrl) && policy.isFast(published.url)) {
        p.solFallbackUrl ||= p.solutionUrl; p.solutionUrl = published.url;
      }
      role ||= "solutions";
    }
    for (const v of p.fileVariants || []) if (v.sha256 === sha) {
      v.libraryAliases ||= [];
      add(v.libraryAliases, { ...R.legacyRecord(published), savedKind: "paper" });
      add(v.libraryAliases, { ...R.legacyRecord(p), url: v.url, solutionUrl: v.url, savedKind: v.role === "solutions" ? "solutions" : "paper" });
      for (const old of previousCandidate?.fileVariants || []) if (old.sha256 === sha) {
        add(v.libraryAliases, { ...R.legacyRecord(previousCandidate), url: old.url, solutionUrl: old.url, savedKind: old.role === "solutions" ? "solutions" : "paper" });
        if (old.libraryRecord) add(v.libraryAliases, { ...old.libraryRecord, savedKind: "paper" });
        for (const alias of old.libraryAliases || []) add(v.libraryAliases, alias);
      }
      if (!policy.isFast(v.url) && policy.isFast(published.url)) v.url = published.url;
      if (!role) {
        p.libraryAliases ||= []; add(p.libraryAliases, { ...R.legacyRecord(published), variantOnly: true });
        role = "variant";
      }
    }
    if (!role) throw new Error("Published bytes do not match a reviewed file role/version: " + published.id);
    p.alternateSources = (p.alternateSources || []).filter(a => a.url !== p.url);
    p.fallbackUrl = p.alternateSources[0]?.url || "";
    bindings.push({ publishedId: published.id, canonicalId: p.id, url: published.url, sha256: sha, role });
  }
  return bindings;
}
function sameFile(a, b, kind = "paper") {
  return ["subject", "year", "school"].every(k => a[k] === b[k]) &&
    (kind === "paper" ? a.url === b.url : (a.solutionUrl || "") === (b.solutionUrl || ""));
}
function verify(catalogue, ledger, validation) {
  const errors = [], ids = new Map(catalogue.papers.map(p => [p.id, p]));
  for (const { published, previousCandidate } of ledger.entries) {
    const p = ids.get(catalogue.idAliases[published.id] || published.id), sha = published.sha256;
    if (!p) { errors.push("Lost synced identity: " + published.id); continue; }
    const primary = proofHash(validation, p.url) === sha;
    const solution = proofHash(validation, p.solutionUrl) === sha;
    const variants = (p.fileVariants || []).filter(v => v.sha256 === sha);
    if (primary && ![p, ...(p.libraryAliases || []).filter(a => !a.variantOnly && (!a.forKind || a.forKind === "paper"))].some(a => sameFile(a, published))) errors.push("Missing published primary filename: " + p.id);
    if (solution && !(p.libraryAliases || []).some(a => a.forKind === "solutions" && a.savedKind === "paper" && sameFile(a, published))) errors.push("Missing published solutions filename: " + p.id);
    if (!primary && !solution && !variants.length) errors.push("Synced file version disappeared: " + p.id);
    if (!primary && (p.libraryAliases || []).some(a => !a.variantOnly && (!a.forKind || a.forKind === "paper") && sameFile(a, published))) errors.push("Non-primary version satisfies primary library lookup: " + p.id);
    if (!primary && !solution && !variants.some(v => (v.libraryAliases || []).some(a => sameFile(a, published)))) errors.push("Missing published variant filename: " + p.id);
    if (previousCandidate && proofHash(validation, previousCandidate.url) === proofHash(validation, p.url) &&
      ![p, ...(p.libraryAliases || []).filter(a => !a.variantOnly && (!a.forKind || a.forKind === "paper"))].some(a => sameFile(a, previousCandidate))) errors.push("Missing tested candidate's primary filename: " + p.id);
    if (previousCandidate?.solutionUrl && proofHash(validation, previousCandidate.solutionUrl) === proofHash(validation, p.solutionUrl) &&
      ![p, ...(p.libraryAliases || []).filter(a => !a.variantOnly && (!a.forKind || a.forKind === "solutions"))].some(a => {
        const storedKind = a.savedKind || "solutions";
        return ["subject", "year", "school"].every(k => a[k] === previousCandidate[k]) &&
          (storedKind === "paper" ? a.url : a.solutionUrl) === previousCandidate.solutionUrl;
      })) errors.push("Missing tested candidate's solutions filename: " + p.id);
  }
  return errors;
}
module.exports = { apply, verify };
