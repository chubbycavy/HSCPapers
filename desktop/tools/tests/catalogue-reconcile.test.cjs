"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const I = require("../catalogue-identity.cjs");
const R = require("../catalogue-reconcile.cjs");
const { collectEvidence } = require("../content-census.cjs");
const A = require("../../ui/js/catalogue-aliases.js");
const hash = "a".repeat(64), hash2 = "b".repeat(64);
function original() { return { id: "thsc-5333-ruse-2025", viewno: "5333", linkText: "Ruse 2025 w. sol", subject: "Mathematics Extension 1", school: "Ruse", year: 2025, level: "HSC", type: "assessment", title: "2025 Ruse Assessment", url: "https://hscportal.pages.dev/original.pdf" }; }
function mirror() { return { id: "add-test", source: "thsc-au-growth", hints: { mirrorRow: "5333/Ruse 2025 w. sol" }, subject: "Maths Extension 1", school: "Ruse", year: 2025, level: null, type: "trial", title: "Ruse 2025", url: "https://thsconline.com.au/pdf/papers/yr12/maths/assessment-tasks-extension1/ruse.pdf", sha256: hash, bytes: 100, pages: 2 }; }
test("exact source ID merges a mirror without replacing the original's type, level or fast primary", () => {
  const papers = [original()]; const row = { ...mirror(), legacyRecord: R.legacyRecord(mirror()) };
  const result = R.applyImports(papers, { entries: [row] });
  assert.equal(papers.length, 1); assert.equal(papers[0].type, "assessment"); assert.equal(papers[0].level, "HSC");
  assert.equal(papers[0].url, original().url); assert.equal(papers[0].alternateSources[0].url, row.url);
  assert.deepEqual(result.aliases, { "add-test": original().id }); assert.equal(papers[0].libraryAliases[0].id, "add-test");
});
test("source metadata canonicalization fixes assessment and school level before the import gate", () => {
  const row = I.candidateMetadata(mirror());
  assert.equal(row.subject, "Mathematics Extension 1"); assert.equal(row.type, "assessment"); assert.equal(row.level, "HSC");
  assert.equal(I.listingKeys(row)[0], I.listingKeys(original())[0]);
});
test("incremental indexing recognizes a further copy after a dead primary is replaced", () => {
  const p = { ...original(), url: "https://thsconline.github.io/s/d/5333/Ruse%202025%20w.%20sol" };
  const a = mirror(), b = { ...a, id: "second-copy", hints: {}, source: "another", subject: p.subject, level: p.level, type: p.type };
  const papers = [p], result = R.applyImports(papers, { entries: [a, b] });
  assert.equal(papers.length, 1); assert.equal(result.aliases['second-copy'], p.id);
  assert.equal(p.url, a.url);
});
test("equal school/year tuples do not merge independent assessments", () => {
  const p = original(); p.sha256 = hash2;
  const row = { ...mirror(), hints: {}, id: "parallel", listingKey: null, type: "assessment", subject: p.subject, level: p.level };
  const result = R.applyImports([p], { entries: [row] });
  assert.equal(result.report.review.length, 1); assert.deepEqual(result.aliases, {});
});
test("Paper 1/2 and questions/solutions remain distinct even when a shared URL is advertised", () => {
  const papers = [1,2].map(n => ({ ...original(), id: "p"+n, viewno: "2720", linkText: "2020 HSC Paper " + n, type: "hsc", school: "NESA", url: "https://example.test/combined.pdf" }));
  const result = R.coalesceExisting(papers);
  assert.equal(papers.length, 2); assert.equal(result.report.sharedUrls.length, 1);
  assert.notEqual(I.reviewKey(papers[0]), I.reviewKey({ ...papers[0], linkText: "2020 Marking Guidelines Paper 1" }));
});
test("URL plus matching context merges actual copies while preserving historical IDs", () => {
  const papers = [original(), { ...original(), id: "copy", viewno: null, linkText: null }];
  const result = R.coalesceExisting(papers);
  assert.equal(papers.length, 1); assert.equal(result.aliases.copy, original().id);
});
test("the explicitly shared English Paper 1 is one card accessible through both courses", () => {
  const url = "https://www.nsw.gov.au/2018-hsc-english-std-adv-p1.pdf";
  const papers = ["English Standard", "English Advanced"].map((subject, n) => ({ id: "course"+n, subject, school: "NESA", type: "hsc", level: "HSC", year: 2018, title: "2018 HSC Exam Paper 1", url }));
  const result = R.coalesceExisting(papers);
  assert.equal(papers.length, 1); assert.equal(result.aliases.course1, "course0");
  assert.deepEqual(I.subjectsOf(papers[0]).sort(), ["English Advanced", "English Standard"]);
});
test("explicit English Paper 2 course markers reconcile with NESA's course vocabulary", () => {
  const a = { ...original(), subject: "English", school: "NESA", type: "hsc", linkText: "2018 HSC Paper 2 (Advanced)" };
  const b = { ...a, subject: "English Advanced", linkText: "2018 HSC Paper 2" };
  assert.equal(I.reviewKey(a), I.reviewKey(b));
  assert.notEqual(I.reviewKey(a), I.reviewKey({ ...a, linkText: "2018 HSC Paper 2 (Standard)" }));
});
test("an official exam cannot replace a trial, or Paper 2 replace Paper 1", () => {
  assert.equal(I.officialReplacementAllowed({ ...original(), type: "trial" }, { url: "https://www.nsw.gov.au/2025-hsc.pdf" }), false);
  const p = { ...original(), type: "hsc", school: "NESA", linkText: "2020 HSC Paper 1" };
  assert.equal(I.officialReplacementAllowed(p, { docName: "HSC Exam Paper 2" }), false);
  assert.equal(I.officialReplacementAllowed(p, { docName: "HSC Exam Paper 1" }), true);
});
test("census iterates real Map entries and includes known hashes against unknown same-length files", () => {
  const papers = [{ id: "a", url: "https://test/a.pdf", sha256: hash, bytes: 100 }, { id: "b", url: "https://test/b.pdf" }];
  const state = { heads: { "https://test/b.pdf": { status: 200, len: 100, contentType: "application/pdf" } } };
  const result = collectEvidence(papers, state);
  assert.equal(result.candidateGroups.length, 1); assert.equal(result.complete, false);
  state.verified = { "https://test/b.pdf": { sha: hash, bytes: 100 } };
  assert.equal(collectEvidence(papers, state).byteDuplicateGroups.length, 1);
});
test("missing lengths and failed proofs cannot claim full census coverage", () => {
  const result = collectEvidence([{ id: "x", url: "https://test/x" }], { heads: { "https://test/x": { status: 200, len: 0 } }, verified: { "https://test/x": { error: "timeout" } } });
  assert.equal(result.complete, false); assert.equal(result.coverage.incomplete, 1);
});
test("aliases deduplicate saved/shared IDs; missing targets and cycles fail closed", () => {
  const active = new Set(["paper"]), aliases = { old: "paper", cycle1: "cycle2", cycle2: "cycle1", gone: "missing" };
  assert.deepEqual(A.remap(["old", "paper", "gone", "cycle1"], aliases, active), ["paper"]);
});
