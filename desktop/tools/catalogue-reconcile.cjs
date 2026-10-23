"use strict";
const I = require("./catalogue-identity.cjs");
const reviewed = require("./reviewed-corrections.cjs");

function legacyRecord(p) {
  const out = {};
  for (const key of ["id", "url", "solutionUrl", "subject", "school", "year", "type", "title"])
    if (p[key] != null) out[key] = p[key];
  return out;
}
function addAlternative(p, row) {
  if (!row.url || row.url === p.url) return;
  p.alternateSources ||= [];
  if (!p.alternateSources.some(x => x.url === row.url)) {
    const out = { url: row.url, source: row.source || row.mirror || "mirror" };
    for (const key of ["sha256", "bytes", "pages", "role"]) if (row[key] != null) out[key] = row[key];
    p.alternateSources.push(out);
  }
}
function indexRows(papers) {
  const index = { keys: new Map(), urls: new Map(), hashes: new Map(), reviews: new Map() };
  for (const p of papers) indexRow(index, p);
  return index;
}
function indexRow(index, p) {
  const add = (map, key) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    if (!map.get(key).includes(p)) map.get(key).push(p);
  };
  for (const k of I.listingKeys(p)) add(index.keys, k);
  add(index.urls, p.url); add(index.hashes, p.sha256); add(index.reviews, I.reviewKey(p));
}
function merge(p, row, aliases, reason, report) {
  const id = I.importId(row);
  p.sourceKeys = [...new Set([...I.listingKeys(p), ...I.listingKeys(row)])];
  if (id !== p.id) aliases[id] = p.id;
  if (row.legacyRecord) {
    p.libraryAliases ||= [];
    if (!p.libraryAliases.some(x => x.id === id && x.url === row.legacyRecord.url)) p.libraryAliases.push(row.legacyRecord);
  }
  addAlternative(p, row);
  if (!p.solutionUrl && row.solutionUrl) { p.solutionUrl = row.solutionUrl; p.hasSolutions = true; }
  if (row.fileVariants?.length) p.fileVariants = [...(p.fileVariants || []), ...row.fileVariants];
  // Keep existing fast primaries. An exact listing match can replace a resolver/dead URL.
  if (!I.isDirect(p.url) && I.isDirect(row.url) && I.validProof(row)) {
    p.libraryAliases ||= [];
    p.libraryAliases.push(legacyRecord(p));
    p.fallbackUrl = p.fallbackUrl || p.url;
    p.url = row.url; p.sha256 = row.sha256; p.bytes = row.bytes; p.mirror = row.source;
    p.alternateSources = p.alternateSources.filter(x => x.url !== p.url);
  }
  report.merged.push({ id, canonicalId: p.id, reason });
}
function applyImports(papers, registry, options = {}) {
  const aliases = { ...(registry.aliases || {}) }, report = { merged: [], added: [], review: [] };
  let index = indexRows(papers);
  for (const originalRow of registry.entries || []) {
    const fix = options.metadataCorrections?.[originalRow.id];
    const correctionIssue = reviewed.issue(originalRow, fix, options.validation);
    if (correctionIssue) { report.review.push({ id: I.importId(originalRow), reason: correctionIssue }); continue; }
    const row = { ...originalRow, ...(fix?.fields || {}) };
    const id = I.importId(row);
    const metadataIssue = require("../ui/js/catalogue-schema.js").metadataIssue(row, { partial: true });
    if (metadataIssue) { report.review.push({ id, reason: metadataIssue }); continue; }
    if (reviewed.hold(row, options.validation)) { report.review.push({ id, reason: reviewed.hold(row, options.validation) }); continue; }
    const issue = require("./document-admission.cjs").curriculumIssue(row);
    if (issue) { report.review.push({ id, reason: issue }); continue; }
    if (row.disposition === "review") { report.review.push({ id, reason: row.reviewReason }); continue; }
    if (!I.validProof(row)) { report.review.push({ id, reason: "Missing full-file proof" }); continue; }
    const sourceMatches = [...new Set(I.listingKeys(row).flatMap(k => index.keys.get(k) || []))];
    let matches = sourceMatches.filter(p => !reviewed.hold(p, options.validation) && !p.reviewedCorrectionIssue && I.compatibleSourceContext(p, row));
    if (sourceMatches.length && !matches.length) { report.review.push({ id, reason: "Source listing has conflicting course/level/document-role metadata", candidates: sourceMatches.map(p => p.id) }); continue; }
    let reason = "exact-source-listing";
    if (!matches.length) { matches = (index.urls.get(row.url) || []).filter(p => !reviewed.hold(p, options.validation) && !p.reviewedCorrectionIssue && I.reviewKey(p) === I.reviewKey(row)); reason = "same-primary-url-and-context"; }
    if (!matches.length) { matches = (index.hashes.get(row.sha256) || []).filter(p => !reviewed.hold(p, options.validation) && !p.reviewedCorrectionIssue && I.reviewKey(p) === I.reviewKey(row)); reason = "same-sha-and-context"; }
    if (matches.length === 1) { merge(matches[0], row, aliases, reason, report); indexRow(index, matches[0]); continue; }
    if (matches.length > 1) { report.review.push({ id, reason: "Ambiguous source identity", candidates: matches.map(x => x.id) }); continue; }
    const possible = index.reviews.get(I.reviewKey(row)) || [];
    if (possible.length) { report.review.push({ id, reason: "Same metadata, unconfirmed file identity", candidates: possible.map(x => x.id) }); continue; }
    if (!row.subject || !row.year || !row.school || !row.type || !row.level) {
      report.review.push({ id, reason: "Incomplete paper metadata" }); continue;
    }
    const p = { id, subject: I.canonicalSubject(row.subject), level: row.level, year: row.year,
      school: row.school, type: row.type, title: row.title,
      url: row.url, solutionPath: "", size: "", hasSolutions: !!row.hasSolutions,
      source: row.source, mirror: row.source, sha256: row.sha256, bytes: row.bytes,
      ...(row.listingKey ? { listingKey: row.listingKey } : {}),
      ...(row.examBlock ? { examBlock: row.examBlock } : {}) };
    if (row.legacyRecord) p.libraryAliases = [row.legacyRecord];
    papers.push(p); report.added.push(id); indexRow(index, p);
  }
  // Validate every alias against the final active catalogue, not against an old snapshot.
  const ids = new Set(papers.map(p => p.id));
  for (const [from, to] of Object.entries(aliases)) if (from === to || ids.has(from) || !ids.has(to)) delete aliases[from];
  return { aliases, report };
}

/* Coalesce existing copies only when their source identity is exact, or when
   URL/hash AND complete semantic context agree. Shared URLs with conflicting
   years, schools, roles or paper numbers are mapping problems, not merges. */
function coalesceExisting(papers, options = {}) {
  const aliases = {}, kept = [], seen = new Map(), report = { merged: [], sharedUrls: [] };
  // Only evidence-bound designated owners get priority; unrelated rows retain order.
  const ordered = [...papers].sort((a, b) => Number(b.id === b.reviewedOwnerId) - Number(a.id === a.reviewedOwnerId));
  for (const p of ordered) {
    const held = reviewed.hold(p, options.validation);
    if (held) reviewed.mark(p, "reviewedHold", held);
    if (held || p.reviewedCorrectionIssue) { kept.push(p); continue; }
    const keys = [...I.listingKeys(p).map(k => "source:" + k + "|" + I.sourceContext(p)),
      ...(p.url ? ["file:" + p.url + "|" + I.semanticFileKey(p)] : []),
      ...(p.sha256 ? ["hash:" + p.sha256 + "|" + I.semanticFileKey(p)] : [])];
    const old = keys.map(k => seen.get(k)).find(Boolean);
    if (old && old.id !== p.id) {
      merge(old, { ...p, legacyRecord: legacyRecord(p) }, aliases, "existing-copy", report);
      if (old.subject !== p.subject) {
        old.relatedSubjects = [...new Set([...I.subjectsOf(old), ...I.subjectsOf(p)])];
        if (I.semanticFileKey(old).startsWith("shared-english-paper-1")) old.title = `${old.year} English Standard & Advanced HSC Paper 1`;
      }
      continue;
    }
    kept.push(p); for (const key of keys) seen.set(key, p);
  }
  papers.splice(0, papers.length, ...kept);
  const urls = new Map(); for (const p of papers) { if (!urls.has(p.url)) urls.set(p.url, []); urls.get(p.url).push(p); }
  for (const [url, rows] of urls) if (rows.length > 1) report.sharedUrls.push({ url, ids: rows.map(p => p.id), reason: "Different advertised documents; requires mapping review" });
  return { aliases, report };
}
function coalesceVersions(papers, validation) {
  const aliases = {}, seen = new Map(), kept = [], merged = [];
  for (const p of papers) {
    const listing = (p.viewno && p.linkText ? p.viewno + "|" + I.listingName(p.linkText) : p.listingKey || I.listingKeys(p)[0]) || "";
    const combined = /\bw\.?\s*sol\.?\s*$/.test(listing);
    const base = listing.replace(/\s+w\.?\s*sol\.?\s*$/, "");
    const parts = I.reviewKey(p).split("|");
    const key = base + "|" + [parts[0], parts[1], parts[2], parts[4], parts[5], parts[6], parts[7]].join("|");
    const peer = base && seen.get(key);
    const currentProof = validation.entries[p.url], peerProof = peer && validation.entries[peer.p.url];
    const words = text => new Set(I.normalize(text).split(" ").filter(w => w.length > 2));
    const a = words(currentProof?.text || ""), b = words(peerProof?.text || "");
    const common = [...a].filter(w => b.has(w)).length;
    const task = text => (String(text || "").match(/assessment\s*task\s*(\d+)/i) || [])[1];
    const taskA = task(currentProof?.text), taskB = task(peerProof?.text);
    const similar = !(taskA && taskB && taskA !== taskB) && Math.min(a.size, b.size) > 15 && common / Math.min(a.size, b.size) >= 0.9;
    if (peer && combined !== peer.combined && currentProof?.state === "verified" && peerProof?.state === "verified" && similar) {
      const old = peer.p;
      const variant = row => ({ url: row.url, role: /\bw\.?\s*sol/.test(I.routeText(row)) ? "combined" : "questions", label: /\bw\.?\s*sol/.test(I.routeText(row)) ? "Questions + solutions" : "Questions only", sha256: row.sha256, pages: row.pages, libraryRecord: legacyRecord(row) });
      old.fileVariants = [...new Map([...(old.fileVariants || []), variant(old), variant(p)].map(v => [v.url, v])).values()];
      old.libraryAliases ||= []; old.libraryAliases.push(legacyRecord(p));
      old.sourceKeys = [...new Set([...I.listingKeys(old), ...I.listingKeys(p)])]; aliases[p.id] = old.id;
      if (combined && I.isDirect(p.url)) { old.url = p.url; old.sha256 = p.sha256; old.bytes = p.bytes; old.pages = p.pages; old.documentRole = "combined"; old.hasSolutions = true; }
      for (const r of old.libraryAliases) {
        const proof = validation.entries[r.url]; if (proof?.sha256 && proof.sha256 !== old.sha256 && !r.forKind) r.variantOnly = true;
      }
      // Different question/combined versions are not interchangeable source copies.
      old.alternateSources = (old.alternateSources || []).filter(s => validation.entries[s.url]?.sha256 === old.sha256);
      old.fallbackUrl = old.alternateSources[0]?.url || "";
      merged.push({ id: p.id, canonicalId: old.id, reason: "Same publisher assessment with verified question/combined document variants" });
      continue;
    }
    kept.push(p); if (base) seen.set(key, { p, combined });
  }
  papers.splice(0, papers.length, ...kept); return { aliases, merged };
}
function coalesceAttachedDocuments(papers, validation) {
  const aliases = {}, removed = new Set(), merged = [];
  for (const parent of papers) {
    if (!parent.solutionUrl || I.reviewKey(parent).split("|")[6] !== "questions") continue;
    const proof = validation.entries[parent.solutionUrl]; if (proof?.state !== "verified") continue;
    const x = I.reviewKey(parent).split("|");
    for (const doc of papers) {
      if (doc.id === parent.id || removed.has(doc.id) || doc.sha256 !== proof.sha256) continue;
      const y = I.reviewKey(doc).split("|");
      if ([0,1,2,4].some(i => x[i] !== y[i]) || (x[7] && y[7] && x[7] !== y[7])) continue;
      if (y[6] === "questions" && !/w\.?\s*sol/.test(I.routeText(doc)) && doc.documentRole !== "combined") continue;
      parent.libraryAliases ||= [];
      parent.libraryAliases.push({ ...legacyRecord(doc), forKind: "solutions", savedKind: "paper" });
      parent.fileVariants ||= [];
      if (!parent.fileVariants.some(v => v.url === doc.url)) parent.fileVariants.push({ url: doc.url, role: "solutions", label: "Solutions / marking material", sha256: doc.sha256, pages: doc.pages, libraryRecord: legacyRecord(doc) });
      aliases[doc.id] = parent.id; removed.add(doc.id);
      merged.push({ id: doc.id, canonicalId: parent.id, reason: "Verified document already attached as this assessment's solutions" });
    }
  }
  papers.splice(0, papers.length, ...papers.filter(p => !removed.has(p.id)));
  return { aliases, merged };
}
function coalesceClassificationCopies(papers, validation) {
  const aliases = {}, seen = new Map(), kept = [], merged = [];
  for (const p of papers) {
    const context = I.reviewKey(p).split("|"); context.splice(3, 1); // classification alone cannot create another copy of the same document
    const key = p.sha256 && p.sha256 + "|" + context.join("|");
    const old = key && seen.get(key);
    if (old && old.id !== p.id) {
      const text = validation.entries[p.url]?.text || "";
      const type = /trial\s+(?:exam|examination)|HSC\s+trial/i.test(text) ? "trial" :
        /assessment\s*task|yearly\s+(?:exam|examination)|half.yearly|semester\s+exam|annual\s+(?:exam|examination)|course\s+examination|\btask\s*\d/i.test(text) ? "assessment" :
          p.school === "NESA" && (old.type === "hsc" || p.type === "hsc") ? "hsc" : "other";
      old.libraryAliases ||= []; old.libraryAliases.push(legacyRecord(p));
      addAlternative(old, p); if (!old.solutionUrl && p.solutionUrl) old.solutionUrl = p.solutionUrl;
      old.type = type;
      if (type === "other") { old.typeReview = true; old.title = `${old.year} ${old.school} ${old.subject} — verified document`; }
      else old.title = old.title.replace(/\b(?:Trial|Assessment)\b/g, type === "trial" ? "Trial" : type === "assessment" ? "Assessment" : "HSC");
      old.sourceKeys = [...new Set([...I.listingKeys(old), ...I.listingKeys(p)])];
      aliases[p.id] = old.id; merged.push({ id: p.id, canonicalId: old.id, reason: "Identical full bytes and assessment context; source classifications normalized from evidence" });
      continue;
    }
    kept.push(p); if (key) seen.set(key, p);
  }
  papers.splice(0, papers.length, ...kept); return { aliases, merged };
}
function coalesceSharedEnglish(papers, validation) {
  const seen = new Map(), aliases = {}, kept = [], merged = [];
  for (const p of papers) {
    const text = validation.entries[p.url]?.text || "";
    const common = p.type === "hsc" && p.school === "NESA" && /^English (Standard|Advanced)$/.test(p.subject) &&
      /english[\s\S]{0,80}standard[\s\S]{0,30}advanced/i.test(text) && /paper\s*1/i.test(text);
    const key = common && p.sha256 + "|" + p.year + "|" + p.level + "|" + I.reviewKey(p).split("|")[6];
    const old = key && seen.get(key);
    if (old) {
      old.relatedSubjects = [...new Set([...I.subjectsOf(old), ...I.subjectsOf(p)])];
      old.title = `${old.year} English Standard & Advanced HSC Paper 1`;
      old.libraryAliases ||= []; old.libraryAliases.push(legacyRecord(p)); addAlternative(old, p);
      aliases[p.id] = old.id; merged.push({ id: p.id, canonicalId: old.id, reason: "Explicit shared Standard/Advanced Paper 1 heading and identical full bytes" }); continue;
    }
    kept.push(p); if (key) seen.set(key, p);
  }
  papers.splice(0, papers.length, ...kept); return { aliases, merged };
}
module.exports = { applyImports, coalesceExisting, coalesceVersions, coalesceAttachedDocuments, coalesceClassificationCopies, coalesceSharedEnglish, indexRows, legacyRecord, addAlternative };
