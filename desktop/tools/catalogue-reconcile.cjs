"use strict";
const I = require("./catalogue-identity.cjs");

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
    for (const key of ["sha256", "bytes", "pages"]) if (row[key] != null) out[key] = row[key];
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
  for (const row of registry.entries || []) {
    const id = I.importId(row);
    if (row.disposition === "review") { report.review.push({ id, reason: row.reviewReason }); continue; }
    if (!I.validProof(row)) { report.review.push({ id, reason: "Missing full-file proof" }); continue; }
    let matches = [...new Set(I.listingKeys(row).flatMap(k => index.keys.get(k) || []))];
    let reason = "exact-source-listing";
    if (!matches.length) { matches = (index.urls.get(row.url) || []).filter(p => I.reviewKey(p) === I.reviewKey(row)); reason = "same-primary-url-and-context"; }
    if (!matches.length) { matches = (index.hashes.get(row.sha256) || []).filter(p => I.reviewKey(p) === I.reviewKey(row)); reason = "same-sha-and-context"; }
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
function coalesceExisting(papers) {
  const aliases = {}, kept = [], seen = new Map(), report = { merged: [], sharedUrls: [] };
  for (const p of papers) {
    const keys = [...I.listingKeys(p).map(k => "source:" + k),
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
module.exports = { applyImports, coalesceExisting, indexRows, legacyRecord, addAlternative };
