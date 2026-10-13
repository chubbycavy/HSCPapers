"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const policy = require("../../ui/js/source-policy.js"), migration = require("../../ui/js/migration-state.js"), feeds = require("../catalogue-feeds.cjs");
const old = require("./released-library-v1.0.26.cjs");
const fast = "https://hscportal.pages.dev/paper.pdf", backup = "https://thsconline.com.au/pdf/papers/paper.pdf";
const legacy = "https://thsconline.github.io/s/d/5338/Example%202025", fragment = "https://www.thsconline.net/s/v/5338/Example%202025";
test("slow switch gates resolver backups but retains fast paper and solution backups", () => {
  const p = { alternateSources: [{ url: backup }, { url: fragment }], fallbackUrl: legacy, solFallbackUrl: backup };
  assert.deepEqual(policy.candidates(p, "paper", fast, false), [fast, backup]);
  assert.deepEqual(policy.candidates(p, "paper", fast, true), [fast, backup, fragment, legacy]);
  assert.deepEqual(policy.candidates(p, "solutions", fast, false), [fast, backup]);
});
test("fragment failures cannot select legacy but can select a verified fast alternative", () => {
  const p = { alternateSources: [{ url: legacy }, { url: backup }], fallbackUrl: legacy };
  assert.deepEqual(policy.candidates(p, "paper", fragment, true), [fragment, backup]);
});
test("explicit versions never inherit another version's backups", () => {
  assert.deepEqual(policy.candidates({ alternateSources: [{ url: backup }] }, "paper", fragment, true, true, fast), [fragment]);
});
test("slow primaries including solutions require the switch before any candidate is selected", () => {
  assert.deepEqual(policy.candidates({ solFallbackUrl: backup }, "solutions", legacy, false), []);
  assert.deepEqual(policy.candidates({}, "solutions", fragment, false), []);
  assert.deepEqual(policy.candidates({}, "solutions", fragment, true), [fragment]);
});
test("descriptor link wrapping keeps the raw identity and is stable across rebuilds", () => {
  const wrapped = feeds.bridge(fragment);
  assert.equal(new URL(wrapped).searchParams.get("url"), fragment);
  assert.equal(feeds.bridge(wrapped), wrapped);
  assert.equal(feeds.bridge(fast), fast);
});
test("old consumer never mistakes a solutions-only alias for saved questions", () => {
  const p = { id: "exam", subject: "Physics", school: "NESA", level: "HSC", type: "hsc", year: 2025, title: "2025 Physics HSC Exam Paper", url: fragment, solutionUrl: backup, libraryAliases: [{ id: "old-mg", subject: "Physics", school: "NESA", year: 2025, type: "hsc", title: "Marking Guidelines", url: "https://www.nsw.gov.au/old-mg.pdf", forKind: "solutions", savedKind: "paper" }] };
  const wrong = old.libraryRel(p.libraryAliases[0], "paper");
  assert.ok(old.libraryCandidates(p, "paper").includes(wrong));
  const modern = { dataVersion: 2, generated: "fixture", papers: [p], recoveryPapers: [], idAliases: {} };
  const { legacy: compat } = feeds.prepare(modern);
  assert.deepEqual(feeds.verify(modern, compat), []);
  assert.equal(old.libraryCandidates(compat.papers[0], "paper").includes(wrong), false);
  assert.ok(old.libraryCandidates(compat.papers[0], "paper").includes(old.libraryRel(p, "paper")));
  assert.ok(p.libraryAliases.some(a => a.url === compat.papers[0].url));
  assert.ok(p.libraryAliases.some(a => a.forKind === "solutions" && a.savedKind === "paper"));
});
test("checkpoint retains exact raw strings and survives repeated migrations", () => {
  const map = new Map([["hsc-bookmarked", '["old-id"]'], ["hsc-queue", '{"files":[{"url":"old-source"}]}']]);
  const storage = { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v) };
  migration.checkpoint(storage);
  const before = map.get(migration.BACKUP_KEY);
  assert.equal(JSON.parse(before).values["hsc-bookmarked"], '["old-id"]');
  map.set("hsc-bookmarked", '["canonical-id"]'); migration.checkpoint(storage);
  assert.equal(map.get(migration.BACKUP_KEY), before);
});
test("checkpoint failure is observable before state can be rewritten", () => {
  assert.throws(() => migration.checkpoint({ getItem: () => null, setItem: () => { throw new Error("quota"); } }), /quota/);
});
test("new consumer rejects old and future unsupported schema versions", () => {
  for (const dataVersion of [undefined, 1, 3]) assert.equal(migration.compatible({ dataVersion, papers: [] }), false);
  assert.equal(migration.compatible({ dataVersion: 2, papers: [], recoveryPapers: [] }), true);
});
test("offline old listings still expose a recovered combined version under the original ID", () => {
  const cleanup = require("../catalogue-cleanup.cjs");
  const previous = { id: "old-name", subject: "Physics", school: "Example", year: 2025, level: "HSC", type: "trial", title: "2025 Example Physics Trial", url: fast, hasSolutions: false };
  const current = { ...previous, id: "new-name", url: legacy };
  const validation = { entries: { [fast]: { state: "verified", sha256: "a", pages: 10, text: "Physics" }, [legacy]: { state: "verified", sha256: "b", pages: 20, text: "Physics", migratedUrl: fragment } } };
  const papers = [{ ...previous }];
  cleanup.history(papers, { identities: [{ id: previous.id, currentId: current.id, previous, current, migratedRole: "combined" }] }, validation);
  assert.equal(papers[0].id, previous.id); assert.equal(papers[0].url, fast);
  assert.equal(papers[0].solutionUrl, fragment);
  assert.equal(papers[0].fileVariants[1].libraryRecord.url, legacy);
  assert.ok(papers[0].sourceKeys.includes("5338|example 2025"));
});
const continuity = require("../publication-continuity.cjs");
const questionSha = "a".repeat(64), combinedSha = "b".repeat(64);
const owner = { id: "owner", subject: "Physics", school: "Example", year: 2025, type: "trial", level: "HSC", title: "2025 Physics Trial", url: fast, sha256: questionSha };
const validation = { entries: { [fast]: { state: "verified", sha256: questionSha, text: "Physics" }, [fragment]: { state: "verified", sha256: combinedSha, text: "Physics" }, [backup]: { state: "verified", sha256: combinedSha, text: "Physics" } } };
test("a newly published combined file is recognized as solutions without satisfying saved questions", () => {
  const p = { ...owner, solutionUrl: fragment, fileVariants: [{ url: fragment, role: "combined", sha256: combinedSha }] };
  const published = { ...owner, id: "combined-name", url: backup, sha256: combinedSha }, ledger = { entries: [{ published, previousCandidate: structuredClone(p) }] };
  continuity.apply([p], ledger, validation, { "combined-name": p.id });
  assert.equal(p.url, fast); assert.equal(p.solutionUrl, backup); assert.equal(p.solFallbackUrl, fragment);
  assert.ok(p.libraryAliases.some(a => a.url === backup && a.forKind === "solutions" && a.savedKind === "paper"));
  assert.equal(p.libraryAliases.some(a => a.url === backup && !a.forKind && !a.variantOnly), false);
  assert.ok(p.fileVariants[0].libraryAliases.some(a => a.url === fragment && a.savedKind === "paper"));
  assert.deepEqual(continuity.verify({ papers: [p], idAliases: { "combined-name": p.id } }, ledger, validation), []);
});
test("a questions-only published version cannot satisfy a combined-primary saved-file lookup", () => {
  const p = { ...owner, sha256: combinedSha, fileVariants: [{ url: fragment, role: "questions", sha256: questionSha }] };
  const v = { entries: { [fast]: { state: "verified", sha256: combinedSha }, [fragment]: { state: "verified", sha256: questionSha }, [backup]: { state: "verified", sha256: questionSha } } };
  const published = { ...owner, url: backup }, ledger = { entries: [{ published, previousCandidate: structuredClone(p) }] };
  continuity.apply([p], ledger, v, {});
  assert.equal(p.url, fast); assert.equal(p.fileVariants[0].url, backup);
  assert.ok(p.libraryAliases.some(a => a.url === backup && a.variantOnly));
  assert.deepEqual(continuity.verify({ papers: [p], idAliases: {} }, ledger, v), []);
});
test("syncing a fast identical primary preserves the tested fragment filename and backup", () => {
  const p = { ...owner, url: fragment, sha256: combinedSha }, published = { ...owner, url: backup, sha256: combinedSha };
  const ledger = { entries: [{ published, previousCandidate: structuredClone(p) }] };
  continuity.apply([p], ledger, validation, {});
  assert.equal(p.url, backup); assert.ok(p.libraryAliases.some(a => a.url === fragment && !a.variantOnly));
  assert.ok(p.alternateSources.some(a => a.url === fragment));
  assert.deepEqual(continuity.verify({ papers: [p], idAliases: {} }, ledger, validation), []);
});
