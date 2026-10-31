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
test("review bookmarks remain stored without becoming active selections", () => {
  const active = new Set(["paper"]), aliases = { old: "paper" };
  assert.deepEqual(A.remap(["old", "pending"], aliases, active, true), ["paper", "pending"]);
  assert.deepEqual(A.remap(["old", "pending"], aliases, active), ["paper"]);
});
const C = require("../catalogue-cleanup.cjs"), D = require("../document-admission.cjs");
test("exact alternative bindings preserve identity and primary, and are idempotent", () => {
  const p = { ...original(), sha256: hash, bytes: 100 }, url = "https://thsconline.com.au/pdf/papers/copy.pdf";
  const proof = { state: "verified", sha256: hash, bytes: 100, pages: 2, text: "Mathematics Extension 1" };
  const v = { entries: { [p.url]: proof, [url]: proof } };
  const registry = { exactAlternatives: [{ id: p.id, primaryUrl: p.url, sha256: hash, bytes: 100, urls: [url] }] };
  assert.deepEqual(R.attachExactAlternatives([p], registry, v), { bindings: 1, added: 1, rejected: [] });
  assert.equal(p.id, original().id); assert.equal(p.url, original().url);
  assert.equal(p.fallbackUrl, url); assert.equal(p.alternateSources[0].url, url);
  assert.equal(R.attachExactAlternatives([p], registry, v).added, 0);
  assert.equal(p.alternateSources.length, 1); assert.equal(p.libraryAliases, undefined);
});
test("alternative bindings reject changed identity, hash, length, unverified or conflicting sources", () => {
  const p = { ...original(), sha256: hash, bytes: 100 }, url = "https://thsconline.com.au/pdf/papers/copy.pdf";
  const proof = { state: "verified", sha256: hash, bytes: 100, text: "Mathematics Extension 1" };
  const binding = { id: p.id, primaryUrl: p.url, sha256: hash, bytes: 100, urls: [url] };
  for (const replacement of [{ ...proof, sha256: hash2 }, { ...proof, bytes: 101 }, { ...proof, state: "review" }, { ...proof, text: "Chemistry" }]) {
    const copy = structuredClone(p), result = R.attachExactAlternatives([copy], { exactAlternatives: [binding] }, { entries: { [p.url]: proof, [url]: replacement } });
    assert.equal(result.rejected.length, 1); assert.equal(result.added, 0); assert.equal(copy.alternateSources, undefined);
  }
  for (const fix of [{ id: "missing" }, { sha256: hash2 }, { bytes: 101 }]) {
    assert.equal(R.attachExactAlternatives([structuredClone(p)], { exactAlternatives: [{ ...binding, ...fix }] }, { entries: { [p.url]: proof, [url]: proof } }).added, 0);
  }
});
test("reviewed PDF representations remain explicit versions, preserve primary and never become backups", () => {
  const p = { ...original(), sha256: hash, bytes: 100, pages: 2 }, url = "https://thsconline.com.au/pdf/papers/representation.pdf";
  const proof = { state: "verified", sha256: hash2, bytes: 90, pages: 2, text: "Mathematics Extension 1" };
  const validation = { entries: { [p.url]: { ...proof, sha256: hash, bytes: 100 }, [url]: proof } };
  const variant = { url, sha256: hash2, bytes: 90, pages: 2, role: "combined", label: "Mirror PDF (same rendered content)",
    review: { method: "all-page-render-and-text", primarySha256: hash, variantSha256: hash2, pages: 2, scale: 1.5 } };
  const binding = { id: p.id, primaryUrl: p.url, sha256: hash, bytes: 100, reviewKey: I.reviewKey(p), variants: [variant] };
  const registry = { reviewedVariants: [binding] };
  assert.deepEqual(R.attachReviewedVariants([p], registry, validation), { bindings: 1, added: 1, rejected: [] });
  assert.equal(p.url, original().url); assert.equal(p.sha256, hash); assert.equal(p.fallbackUrl, undefined); assert.equal(p.alternateSources, undefined);
  assert.deepEqual(p.fileVariants.map(v => v.url), [p.url, url]);
  assert.equal(R.attachReviewedVariants([p], registry, validation).added, 0);
  for (const changed of [{ sha256: "c".repeat(64) }, { bytes: 91 }, { pages: 3 }, { state: "review" }]) {
    const copy = { ...p, fileVariants: [] }, bad = { entries: { ...validation.entries, [url]: { ...proof, ...changed } } };
    assert.equal(R.attachReviewedVariants([copy], registry, bad).added, 0); assert.equal(copy.fileVariants.length, 0);
  }
  for (const changed of [{ role: "solutions" }, { review: { ...variant.review, pages: 1 } }, { review: { ...variant.review, primarySha256: hash2 } }]) {
    assert.equal(R.attachReviewedVariants([{ ...p, fileVariants: [] }], { reviewedVariants: [{ ...binding, variants: [{ ...variant, ...changed }] }] }, validation).added, 0);
  }
  assert.equal(R.attachReviewedVariants([{ ...p, year: 2024, fileVariants: [] }], registry, validation).added, 0);
});
test("exact source promotion pins the mirror while preserving published Portal filenames and backup bytes", () => {
  const p = { ...original(), sha256: hash, bytes: 100, pages: 2 }, mirrorUrl = "https://thsconline.com.au/pdf/papers/exact.pdf";
  const proof = { state: "verified", sha256: hash, bytes: 100, pages: 2, text: "Mathematics Extension 1" };
  const validation = { entries: { [p.url]: proof, [mirrorUrl]: proof } };
  const binding = { id: p.id, primaryUrl: p.url, sha256: hash, bytes: 100, reviewKey: I.reviewKey(p), preferredUrl: mirrorUrl, previousRecord: R.legacyRecord(p) };
  const registry = { primaryPreferences: [binding] };
  assert.deepEqual(R.preferExactSources([p], registry, validation), { bindings: 1, promoted: 1, rejected: [] });
  assert.equal(p.id, original().id); assert.equal(p.url, mirrorUrl); assert.equal(p.sha256, hash);
  assert.equal(p.fallbackUrl, original().url); assert.equal(p.alternateSources[0].url, original().url);
  assert.ok(p.libraryAliases.some(a => a.url === original().url && a.subject === original().subject));
  const once = JSON.stringify(p);
  assert.deepEqual(R.preferExactSources([p], registry, validation), { bindings: 1, promoted: 0, rejected: [] });
  assert.equal(JSON.stringify(p), once);
  for (const changed of [{ sha256: hash2 }, { bytes: 101 }, { pages: 3 }, { state: "review" }]) {
    const copy = { ...original(), sha256: hash, bytes: 100, pages: 2 };
    const result = R.preferExactSources([copy], registry, { entries: { ...validation.entries, [mirrorUrl]: { ...proof, ...changed } } });
    assert.equal(result.promoted, 0); assert.equal(result.rejected.length, 1); assert.equal(copy.url, original().url);
  }
});
test("invalid primary is replaced by a proved alternative and unverified actions become provenance", () => {
  const p = original(), good = "https://thsconline.com.au/good.pdf", papers = [{ ...p, alternateSources: [{ url: good }] }];
  const v = { entries: { [p.url]: { state: "invalid", reason: "HTML" }, [good]: { state: "verified", sha256: hash, bytes: 100, pages: 2, text: "" } } };
  const result = C.apply(papers, v); assert.equal(papers[0].url, good); assert.equal(result.recovery.length, 0); assert.equal(papers[0].provenanceSources[0].url, p.url);
});
test("unavailable records preserve historical identity without online download actions", () => {
  const p = original(), papers = [p]; const result = C.apply(papers, { entries: {} });
  assert.equal(papers.length, 0); assert.equal(result.recovery[0].id, p.id); assert.equal(result.recovery[0].url, "");
  assert.equal(result.recovery[0].libraryAliases[0].url, original().url);
  assert.deepEqual(C.finalizeAliases({ old: p.id }, papers, result.recovery), { old: p.id });
});
test("a solution bundle from a different school is detached, not published as correct solutions", () => {
  const p = { ...original(), school: "Abbotsleigh", solutionUrl: "https://hscportal.pages.dev/Barker%202025%20w.%20sol.pdf" }, papers = [p];
  const e = { state: "verified", sha256: hash, bytes: 100, text: "" };
  C.apply(papers, { entries: { [p.url]: e, [p.solutionUrl]: e } }); assert.equal(p.solutionUrl, "");
});
test("verified question/combined versions consolidate without discarding the older file", () => {
  const a = { ...original(), linkText: "Ruse 2025", url: "https://hscportal.pages.dev/q.pdf", sha256: hash };
  const b = { ...a, id: "combined", linkText: "Ruse 2025 w. sol", url: "https://hscportal.pages.dev/combined.pdf", sha256: hash2 };
  const text = "Ruse High School 2025 Mathematics Extension 1 Trial Examination General Instructions Working Time Two Hours Total Marks Seventy Questions One Two Three Four Five Six Seven Eight Nine Ten";
  const v = { entries: { [a.url]: { state: "verified", text }, [b.url]: { state: "verified", text } } }, papers = [a,b];
  const result = R.coalesceVersions(papers, v); assert.equal(papers.length, 1); assert.equal(result.aliases.combined, a.id);
  assert.equal(papers[0].fileVariants.length, 2); assert.equal(papers[0].url, b.url);
});
test("curriculum gate rejects university exams and detects explicit wrong-course headings", () => {
  assert.match(D.curriculumIssue({ title: "MATH3202 final exam" }), /University/);
  assert.match(D.contextIssue({ ...original(), subject: "English Standard" }, "primary", "English Advanced Paper 2 Modules", "https://test/q.pdf"), /not english standard/);
});
test("a solutions document already attached to its question paper is one assessment card", () => {
  const q = { ...original(), id: "exam", school: "NESA", type: "hsc", linkText: "2025 HSC", solutionUrl: "https://test/mg.pdf", sha256: hash2 };
  const mg = { ...q, id: "mg", linkText: "2025 Marking Guidelines", url: q.solutionUrl, solutionUrl: "", sha256: hash };
  const papers = [q, mg], result = R.coalesceAttachedDocuments(papers, { entries: { [mg.url]: { state: "verified", sha256: hash } } });
  assert.equal(papers.length, 1); assert.equal(result.aliases.mg, "exam");
  assert.equal(papers[0].libraryAliases[0].forKind, "solutions");
  assert.equal(papers[0].fileVariants[0].role, "solutions");
});
