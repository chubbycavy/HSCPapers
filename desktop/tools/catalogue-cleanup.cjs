"use strict";
const I = require("./catalogue-identity.cjs"), R = require("./catalogue-reconcile.cjs"), admission = require("./document-admission.cjs");
const reviewed = require("./reviewed-corrections.cjs");
function proofFor(p, url, role, validation) {
  const e = validation.entries[url];
  if (e?.state !== "verified") return null;
  const exclusion = validation.ownerExclusions?.[p.id];
  if (role === "primary" && exclusion && (!exclusion.url || exclusion.url === url) && (!exclusion.sha256 || exclusion.sha256 === e.sha256)) return null;
  if (admission.contextIssue(p, role, e.text, url)) return null;
  return e;
}
function schoolInFile(url) {
  try { const name = decodeURIComponent(new URL(url).pathname.split("/").pop()).replace(/[-_]/g, " "); const m = /^(.*?)\b(?:19|20)\d{2}\b/.exec(name); return m ? I.normalize(m[1]).replace(/\s+(?:high school|college|school)$/, "") : ""; } catch { return ""; }
}
function history(papers, input, validation) {
  const aliases = { "add-thsc-au-growth-db836e142c": "thsc-5338-abbotsleigh-2022-w-sol" }, changes = [];
  for (const h of input.identities || []) {
    const p = papers.find(p => p.id === h.currentId || p.id === h.id); if (!p) continue;
    // Cached listings may still contain the old name/copy. The reviewed history
    // carries the migrated identity explicitly; do not lose it on offline builds.
    const current = R.legacyRecord({ ...p, ...(h.current || {}) }), old = h.previous;
    p.id = h.id; aliases[h.currentId] = h.id;
    p.sourceKeys = [...new Set([...I.listingKeys(old), ...I.listingKeys(p), ...I.listingKeys(current)])];
    p.libraryAliases = [...(p.libraryAliases || []), R.legacyRecord(old)];
    const oldProof = proofFor(old, old.url, "primary", validation);
    const migrated = validation.entries[current.url];
    if (oldProof) {
      p.url = old.url; p.hasSolutions = old.hasSolutions; p.solutionUrl = old.solutionUrl || ""; p.mirror = old.mirror || "hscportal";
      p.fileVariants = [{ url: old.url, role: old.hasSolutions ? "combined" : "questions", label: old.hasSolutions ? "Questions + solutions (previous copy)" : "Questions (previous copy)", sha256: oldProof.sha256, pages: oldProof.pages, libraryRecord: R.legacyRecord(old) }];
    }
    if (migrated?.state === "verified" && migrated.migratedUrl) {
      validation.entries[migrated.migratedUrl] ||= { ...migrated, migratedUrl: undefined };
      const variant = { url: migrated.migratedUrl, role: h.migratedRole, label: h.migratedRole === "combined" ? "Questions + solutions (migrated copy)" : "Questions only (migrated copy)", sha256: migrated.sha256, pages: migrated.pages, libraryRecord: current };
      p.fileVariants ||= []; p.fileVariants.push(variant);
      if (oldProof && h.migratedRole === "combined") {
        p.solutionUrl = variant.url; p.hasSolutions = true;
        p.libraryAliases.push({ ...current, forKind: "solutions", savedKind: "paper" });
      } else if (oldProof) R.addAlternative(p, { ...variant, source: "thsc-fragments", bytes: migrated.bytes });
    }
    changes.push({ id: p.id, oldListingId: h.currentId, reason: h.reason });
  }
  return { aliases, changes };
}
function prepareMetadata(papers, corrections, validation) {
  const corrected = [];
  for (const p of papers) {
    const fix = corrections[p.id]; if (!fix) continue;
    const issue = reviewed.issue(p, fix, validation);
    if (issue) { reviewed.mark(p, "reviewedCorrectionIssue", issue); continue; }
    p.libraryAliases ||= [];
    p.libraryAliases.push({ ...R.legacyRecord(p), ...(fix.libraryRole ? { forKind: fix.libraryRole, savedKind: "paper" } : {}) });
    if (fix.fields.url && fix.fields.url !== p.url) { delete p.sha256; delete p.bytes; delete p.pages; }
    Object.assign(p, fix.fields); Object.defineProperty(p, "metadataCorrected", { value: true, enumerable: false });
    if (fix.when) reviewed.mark(p, "reviewedOwnerId", fix.canonicalId || p.id);
    corrected.push({ id: p.id, reason: fix.reason });
  }
  return corrected;
}
function apply(papers, validation, corrections = {}) {
  const recovery = [], rejectedSources = [], corrected = [], verified = validation.entries;
  for (const p of papers) {
    const fix = corrections[p.id];
    if (fix && !p.metadataCorrected) corrected.push(...prepareMetadata([p], corrections, validation));
    const held = reviewed.hold(p, validation);
    if (held) reviewed.mark(p, "reviewedHold", held);
    // Pin a reviewed identical mirror independently of the canonical public ID.
    if (p.reviewedOwnerId && fix?.primaryUrl && reviewed.sameBytes(validation, p.url, fix.primaryUrl)) {
      const before = R.legacyRecord(p);
      p.libraryAliases ||= []; p.libraryAliases.push(before);
      const previous = p.url; p.url = fix.primaryUrl; p.mirror = "thsc-au";
      R.addAlternative(p, { url: previous, source: "hscportal" });
    }
    const old = R.legacyRecord(p), candidates = [p.url, ...(p.alternateSources || []).map(x => x.url), p.fallbackUrl].filter(Boolean);
    const good = (held || p.reviewedCorrectionIssue) ? [] : candidates.filter(url => proofFor(p, url, "primary", validation));
    p.provenanceSources ||= [];
    const remember = (url, role, override) => {
      if (!url || p.provenanceSources.some(x => x.url === url && x.role === role)) return;
      const e = verified[url];
      const reason = held || p.reviewedCorrectionIssue || (e?.state === "verified" ? admission.contextIssue(p, role === "solutions" ? "solutions" : "primary", e.text, url) : e?.reason);
      p.provenanceSources.push({ url, role, reason: override || reason || "No current full-file proof; excluded from online actions" });
      rejectedSources.push({ id: p.id, url, role, reason: override || reason || "Unverified source" });
    };
    for (const url of candidates) if (!good.includes(url)) remember(url, "primary");
    if (!good.length) {
      p.libraryAliases ||= []; p.libraryAliases.push(old);
      p.availability = { state: held || p.reviewedCorrectionIssue ? "review" : "unavailable", reason: held || p.reviewedCorrectionIssue || p.provenanceSources[0]?.reason || "No verified replacement currently available" };
      p.url = ""; p.solutionUrl = ""; p.fallbackUrl = ""; p.solFallbackUrl = ""; p.alternateSources = [];
      recovery.push(p); continue;
    }
    const chosen = good.includes(p.url) ? p.url : good.find(I.isDirect) || good[0], e = verified[chosen];
    const target = e.migratedUrl || chosen;
    if (p.url !== target) {
      p.libraryAliases ||= [];
      if (!p.libraryAliases.some(a => a.url === old.url)) p.libraryAliases.push(old);
      p.url = target;
    }
    p.sha256 = e.sha256; p.bytes = e.bytes; p.pages = e.pages;
    if (p.reviewedOwnerId || validation.ownerExclusions?.[p.id]) for (const alias of p.libraryAliases || []) {
      if (!alias.forKind && !alias.variantOnly && !reviewed.sameBytes(validation, alias.url, p.url)) alias.variantOnly = true;
      if (alias.solutionUrl && !reviewed.sameBytes(validation, alias.solutionUrl, p.solutionUrl)) delete alias.solutionUrl;
    }
    const task = (e.text?.slice(0, 500).match(/\bassessment\s*(?:task\s*)?(\d+)\b/i) || [])[1];
    if (task) {
      p.examBlock = "Assessment Task " + task;
      if (!/HSC\s+trial|trial\s+exam/i.test(e.text || "")) p.type = "assessment";
    }
    if (p.type === "hsc" && p.school === "NESA" && I.documentRole(I.routeText(p)) !== "questions" && /marking guidelines/i.test(e.text?.slice(0, 400) || "")) {
      p.documentRole = "solutions"; p.title = `${p.year} ${p.subject} HSC Marking Guidelines`;
    }
    // Published headings establish missing official part metadata. Senior
    // Science's full exam is not two separately numbered papers.
    if (p.type === "hsc" && p.school === "NESA") {
      const part = (e.text?.slice(0, 700).match(/\bPaper\s*([12])\b/i) || [])[1];
      if (part && /^(ESL|English)/.test(p.subject) && !I.paperPart(p.title)) {
        p.title += ` (Paper ${part})`; p.paperPart = part;
      }
      if (p.subject === "Senior Science" && p.year === 2005 && /Senior Science/i.test(e.text || "")) {
        const view = p.viewno || I.listingKeys(p)[0]?.split("|")[0];
        p.title = "2005 Senior Science HSC Examination"; p.linkText = "2005 HSC";
        p.sourceKeys = view ? [view + "|2005 hsc"] : [];
      }
    }
    if (e.migratedUrl) verified[target] ||= { ...e, migratedUrl: undefined };
    const alt = good.filter(u => u !== chosen).map(u => {
      const pr = verified[u], url = pr.migratedUrl || u;
      if (pr.migratedUrl) verified[url] ||= { ...pr, migratedUrl: undefined };
      return { url, source: pr.transport || "verified-alternative", sha256: pr.sha256, bytes: pr.bytes, pages: pr.pages };
    });
    p.alternateSources = [...new Map(alt.filter(a => a.url !== p.url).map(a => [a.url, a])).values()];
    p.fallbackUrl = p.alternateSources[0]?.url || "";
    const sols = [p.solutionUrl, p.solFallbackUrl].filter(Boolean), validSols = [];
    for (const url of sols) {
      const solProof = proofFor(p, url, "solutions", validation);
      const school = schoolInFile(url), expected = I.normalize(p.school).replace(/\s+(?:high school|college|school)$/, "");
      const unrelated = p.school !== "NESA" && school && expected && school !== expected;
      if (!solProof || unrelated) remember(url, "solutions", unrelated ? "Solution belongs to another school/assessment" : undefined);
      else validSols.push(solProof.migratedUrl || url);
    }
    p.solutionUrl = validSols[0] || ""; p.solFallbackUrl = validSols[1] || "";
    if (sols.length && !validSols.length) p.hasSolutions = /w\.?\s*sol|solutions/i.test(p.linkText || "") || p.documentRole === "combined";
    p.fileVariants = (p.fileVariants || []).filter(v => proofFor(p, v.url, v.role === "solutions" ? "solutions" : "primary", validation));
  }
  const active = papers.filter(p => !p.availability);
  papers.splice(0, papers.length, ...active);
  return { recovery, rejectedSources, corrected };
}
function resolveAlias(id, aliases) {
  const seen = new Set(); while (aliases[id] && !seen.has(id)) { seen.add(id); id = aliases[id]; } return id;
}
function finalizeAliases(aliases, papers, recovery) {
  const ids = new Set([...papers, ...recovery].map(p => p.id)), out = {};
  for (const id of ids) delete aliases[id]; // a restored, distinct record outranks a stale historical alias
  for (const [from, to] of Object.entries(aliases)) { const target = resolveAlias(to, aliases); if (!ids.has(from) && target !== from && ids.has(target)) out[from] = target; }
  return out;
}
function restrictCopies(papers, validation) {
  const rejected = [];
  for (const p of papers) {
    p.alternateSources = (p.alternateSources || []).filter(a => {
      if (reviewed.sameBytes(validation, p.url, a.url)) return true;
      const reason = "Different/unproved source bytes require explicit version/role review, not an ordinary primary backup";
      p.provenanceSources ||= [];
      if (!p.provenanceSources.some(s => s.url === a.url && s.role === "primary")) p.provenanceSources.push({ url: a.url, role: "primary", reason });
      rejected.push({ id: p.id, url: a.url, reason }); return false;
    });
    p.fallbackUrl = p.alternateSources[0]?.url || "";
    for (const alias of p.libraryAliases || []) {
      const proof = validation.entries[alias.url];
      if (!alias.forKind && proof?.state === "verified" && proof.sha256 !== p.sha256) alias.variantOnly = true;
    }
  }
  return rejected;
}
module.exports = { apply, history, prepareMetadata, proofFor, schoolInFile, resolveAlias, finalizeAliases, restrictCopies };
