"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path"), crypto = require("crypto");
const pipeline = require("../catalogue-pipeline.cjs"), { refresh } = require("../refresh-catalogue-proof.cjs"), reviewed = require("../reviewed-corrections.cjs"), R = require("../catalogue-reconcile.cjs"), C = require("../catalogue-cleanup.cjs"), V = require("../verify-catalogue.cjs"), F = require("../catalogue-feeds.cjs"), old = require("./released-library-v1.0.26.cjs"), publication = require("../catalogue-publication-review.cjs");
const pdf = require("../e2e/pdf-fixture.cjs");
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const groups = structuredClone(require("../catalogue-metadata-corrections.json").reviewedGroups), sources = [], entries = [], history = [], payloads = new Map(), proofs = {}, exclusions = {}, originalPortal = [];
  for (const g of groups) {
    const bytes = pdf(`${g.year} Sydney Boys Yearly Mathematics Accelerated`, 1), other = g.year === 2016 ? pdf(`${g.year} Sydney Boys Yearly Mathematics Accelerated previous representation`, 1) : bytes;
    const mirrorId = "add-thsc-au-growth-" + sha(bytes).slice(0, 10);
    g.sha256 = sha(bytes); if (g.year === 2016) { g.portalSha256 = sha(other); g.canonicalId = mirrorId; }
    payloads.set(g.mirrorUrl, bytes); payloads.set(g.portalUrl, other);
    const mirror = { id: mirrorId, source: "thsc-au-growth", url: g.mirrorUrl, subject: "Maths (Accelerated)", school: "Sydney Boys", year: g.year, type: "trial", level: "Preliminary", title: `Sydney Boys ${g.year} w. sol`, listingKey: `5278|sydney boys ${g.year} w. sol`, sha256: sha(bytes), bytes: bytes.length, hasSolutions: true };
    mirror.legacyRecord = R.legacyRecord(mirror); entries.push(mirror); history.push(structuredClone(mirror));
    proofs[g.mirrorUrl] = { state: "verified", sha256: sha(bytes), bytes: bytes.length, pages: 1, text: g.year === 2012 ? "" : `${g.year} Sydney Boys Year 11 Yearly Mathematics Accelerated` };
    for (const id of g.portalIds) {
      const viewno = id.split("-")[1];
      const p = { id, url: g.portalUrl, fallbackUrl: `https://thsconline.github.io/s/d/${viewno}/Sydney%20Boys%20${g.year}%20w.%20sol`, subject: "Mathematics Advanced", school: "Sydney Boys", year: g.year, type: "other", level: "Preliminary", title: `Sydney Boys ${g.year} w. sol`, viewno, linkText: `Sydney Boys ${g.year} w. sol`, hasSolutions: true };
      sources.push(p); originalPortal.push(R.legacyRecord(p));
    }
    if (g.year === 2016) exclusions[g.portalIds[0]] = { preMerge: true, url: g.portalUrl, sha256: g.portalSha256, reason: "Unresolved unequal 2016 bytes" };
  }
  const validation = { entries: proofs, ownerExclusions: exclusions };
  const options = { imports: { entries, proofs: {}, legacyRows: {}, previousPrimaries: {} }, validation, publishedHistory: { aliases: {}, identities: [], records: history }, metadataCorrections: reviewed.expand({ reviewedGroups: groups }), publicationSync: { entries: [] } };
  return { groups, sources, options, payloads, originalPortal };
}
function build(f, reverse = false) { const sources = structuredClone(f.sources); if (reverse) sources.reverse(); return pipeline.build(sources, structuredClone(f.options)); }
test("reviewed-only rebuild freezes source-ID drift, new imports/selfhost and recovery promotions without relaxing continuity", () => {
  const bytes = pdf("Biology trial questions", 1), hash = sha(bytes), url = "https://hscportal.pages.dev/biology.pdf", mirror = "https://thsconline.com.au/pdf/papers/biology.pdf";
  const p = { id: "published", url, subject: "Biology", school: "Ruse", year: 2025, type: "trial", level: "HSC", title: "2025 Biology Trial", sha256: hash, bytes: bytes.length, pages: 1 };
  const recovery = { ...p, id: "recover", url: "", availability: { state: "review", reason: "Unresolved version" } };
  const previous = { dataVersion: 2, papers: [p], recoveryPapers: [recovery], idAliases: { historical: "published" } };
  const options = { reviewedOnly: true, previous, previousReport: { activePapers: 1, importedRows: 0, mergedImports: [], genuinelyAdded: [], reviewQueue: [], unexpectedPrimaryDowngrades: [], cleanup: {} },
    imports: { entries: [{ ...p, id: "unadmitted-import", url: mirror }], primaryPreferences: [{ id: p.id, primaryUrl: url, sha256: hash, bytes: bytes.length, preferredUrl: mirror, previousRecord: R.legacyRecord(p) }] },
    validation: { entries: { [url]: { state: "verified", sha256: hash, bytes: bytes.length, pages: 1, text: "Biology trial questions" }, [mirror]: { state: "verified", sha256: hash, bytes: bytes.length, pages: 1, text: "Biology trial questions" } } }, publicationSync: { entries: [] } };
  const discovered = [{ ...p, id: "portal-prefix-changed", title: "Changed source title" }, { ...p, id: "selfhost-new" }, { ...p, id: "recover" }];
  const first = pipeline.build(discovered, options), c = first.modernCatalogue;
  assert.deepEqual(c.papers.map(p => p.id), [p.id]); assert.equal(c.papers[0].title, p.title);
  assert.equal(c.papers[0].url, mirror); assert.equal(c.papers[0].fallbackUrl, url);
  assert.deepEqual(c.idAliases, previous.idAliases); assert.deepEqual(c.recoveryPapers, previous.recoveryPapers);
  assert.equal(first.reconciliationReport.reviewQueue[0].id, "unadmitted-import");
  assert.deepEqual(V.verify(c, first.reconciliationReport, options.validation, previous, 0), []);
  const legacy = first.compatibility.legacy.papers[0];
  assert.ok(old.libraryCandidates(legacy, "paper").includes(old.libraryRel(p, "paper")));
  const second = pipeline.build([{ ...p, id: "another-source-id" }], { ...options, previous: c, previousReport: first.reconciliationReport });
  assert.equal(publication.digest(c, first.compatibility.legacy), publication.digest(second.modernCatalogue, second.compatibility.legacy));
  const drift = structuredClone(options); drift.validation.entries[mirror].sha256 = "f".repeat(64);
  assert.throws(() => pipeline.build(discovered, drift), /Reviewed source bindings changed/);
  assert.throws(() => pipeline.build(discovered, { ...options, previous: null }), /previous publication/);
});
test("the production pipeline retains exact alternatives without new IDs or primary changes", () => {
  const bytes = pdf("Biology trial questions", 1), hash = sha(bytes), url = "https://hscportal.pages.dev/biology.pdf", mirror = "https://thsconline.com.au/pdf/papers/biology.pdf";
  const p = { id: "existing", url, subject: "Biology", school: "Ruse", year: 2025, type: "trial", level: "HSC", title: "2025 Biology Trial" };
  const proof = { state: "verified", sha256: hash, bytes: bytes.length, pages: 1, text: "Biology trial questions" };
  const options = { imports: { entries: [], proofs: {}, legacyRows: {}, previousPrimaries: {}, exactAlternatives: [{ id: p.id, primaryUrl: url, sha256: hash, bytes: bytes.length, urls: [mirror] }] },
    validation: { entries: { [url]: proof, [mirror]: proof } }, publishedHistory: { records: [], aliases: {} }, metadataCorrections: {}, publicationSync: { entries: [] } };
  const result = pipeline.build([structuredClone(p)], options), modern = result.modernCatalogue;
  assert.deepEqual(modern.papers.map(p => p.id), ["existing"]); assert.deepEqual(modern.idAliases, {});
  assert.equal(modern.papers[0].url, url); assert.equal(modern.papers[0].fallbackUrl, mirror);
  assert.equal(modern.papers[0].alternateSources[0].sha256, hash);
  assert.equal(result.reconciliationReport.cleanup.exactAlternatives.added, 1);
  assert.deepEqual(V.verify(modern, result.reconciliationReport, options.validation, { papers: [p], recoveryPapers: [], idAliases: {} }, 0), []);
  const changed = structuredClone(options); changed.validation.entries[mirror].sha256 = "f".repeat(64);
  const held = pipeline.build([structuredClone(p)], changed);
  assert.equal(held.modernCatalogue.papers[0].alternateSources.length, 0);
  assert.equal(held.reconciliationReport.cleanup.exactAlternatives.rejected.length, 1);
});
test("reviewed different-byte representations survive the production pipeline only as proof-bound file versions", () => {
  const bytes = pdf("Biology trial questions", 1), other = Buffer.concat([bytes, Buffer.from("\n% alternate representation\n")]);
  const hash = sha(bytes), otherHash = sha(other), url = "https://hscportal.pages.dev/biology.pdf", mirror = "https://thsconline.com.au/pdf/papers/biology.pdf";
  const p = { id: "existing", url, subject: "Biology", school: "Ruse", year: 2025, type: "trial", level: "HSC", title: "2025 Biology Trial" };
  const proof = { state: "verified", sha256: hash, bytes: bytes.length, pages: 1, text: "Biology trial questions" };
  const variant = { url: mirror, sha256: otherHash, bytes: other.length, pages: 1, role: "questions", label: "Mirror PDF (same rendered content)",
    review: { method: "all-page-render-and-text", primarySha256: hash, variantSha256: otherHash, pages: 1, scale: 1.5 } };
  const options = { imports: { entries: [], proofs: {}, legacyRows: {}, previousPrimaries: {}, reviewedVariants: [{ id: p.id, primaryUrl: url, sha256: hash, bytes: bytes.length, reviewKey: require("../catalogue-identity.cjs").reviewKey(p), variants: [variant] }] },
    validation: { entries: { [url]: proof, [mirror]: { ...proof, sha256: otherHash, bytes: other.length } } }, publishedHistory: { records: [], aliases: {} }, metadataCorrections: {}, publicationSync: { entries: [] } };
  const next = pipeline.build([structuredClone(p)], options), record = next.modernCatalogue.papers[0];
  assert.equal(record.url, url); assert.equal(record.sha256, hash); assert.equal(record.fallbackUrl, ""); assert.deepEqual(record.alternateSources, []);
  assert.equal(record.fileVariants.length, 2); assert.deepEqual(next.modernCatalogue.idAliases, {});
  assert.deepEqual(V.verify(next.modernCatalogue, next.reconciliationReport, options.validation), []);
  record.fileVariants[1].sha256 = hash;
  assert.ok(V.verify(next.modernCatalogue, next.reconciliationReport, options.validation).some(e => e.startsWith("File version differs from its proof:")));
  const changed = structuredClone(options); changed.validation.entries[mirror].sha256 = "f".repeat(64);
  const held = pipeline.build([structuredClone(p)], changed);
  assert.equal(held.modernCatalogue.papers.length, 1); assert.equal(held.modernCatalogue.papers[0].fileVariants.length, 0);
  assert.equal(held.reconciliationReport.cleanup.reviewedVariants.rejected.length, 1);
});
test("production build -> real PDF proof admission -> rebuild -> verification preserves all seven dispositions and old filenames", async () => {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsc-admission-"));
  try {
    const initial = build(f), previous = structuredClone(initial.modernCatalogue);
    assert.equal(previous.papers.length, 7); assert.equal(previous.recoveryPapers.length, f.sources.length);
    const feed = path.join(dir, "papers-v2.json"), registry = path.join(dir, "validation.json");
    fs.writeFileSync(feed, JSON.stringify(previous)); fs.writeFileSync(registry, JSON.stringify(f.options.validation));
    const admitted = JSON.parse(fs.readFileSync(registry, "utf8"));
    await refresh(admitted, JSON.parse(fs.readFileSync(feed, "utf8")), { delayMs: 0, now: 0, resolveLegacy: async () => { throw new Error("Fixture legacy route is unmigrated"); }, fetch: async url => {
      assert.ok(f.payloads.has(url), "no unfixture network access"); return new Response(f.payloads.get(url), { headers: { "Content-Type": "application/pdf" } });
    } });
    f.options.validation = admitted;
    const unfixed = fixture(); unfixed.options.validation = admitted; unfixed.options.metadataCorrections = {};
    const broken = build(unfixed);
    assert.ok(V.verify(broken.modernCatalogue, broken.reconciliationReport, admitted, previous).some(e => e.startsWith("Repeated source listing:")), "fixture reproduces the previous fresh-admission failure without the repair");
    const next = build(f), c = next.modernCatalogue;
    assert.deepEqual(V.verify(c, next.reconciliationReport, admitted, previous), []);
    assert.deepEqual(F.verify(c, next.compatibility.legacy), []);
    assert.equal(c.papers.length, 7); assert.equal(c.recoveryPapers.length, 1);
    for (const g of f.groups) {
      const p = c.papers.find(p => p.id === g.canonicalId); assert.ok(p, `explicit owner ${g.year}`);
      assert.equal(p.url, g.mirrorUrl); assert.equal(p.type, "assessment"); assert.equal(p.examBlock, "Yearly");
      const mirrorId = "add-thsc-au-growth-" + g.sha256.slice(0, 10);
      assert.equal(c.idAliases[mirrorId] || mirrorId, g.canonicalId);
      if (g.year === 2016) {
        assert.equal(c.idAliases[g.portalIds[0]], undefined);
        const held = c.recoveryPapers.find(p => p.id === g.portalIds[0]); assert.equal(held.availability.state, "review"); assert.equal(held.subject, "Maths (Accelerated)");
        assert.equal(p.alternateSources.some(a => a.url === g.portalUrl), false);
      } else {
        assert.ok(p.alternateSources.some(a => a.url === g.portalUrl));
        for (const id of g.portalIds) assert.equal(c.idAliases[id] || id, g.canonicalId);
        const legacy = next.compatibility.legacy.papers.find(p => p.id === g.canonicalId);
        const saved = f.originalPortal.find(p => p.year === g.year);
        assert.ok(old.libraryCandidates(legacy, "paper").includes(old.libraryRel(saved, "paper")), "released consumer keeps original Advanced filename");
        assert.equal(old.libraryCandidates(legacy, "paper").includes(old.libraryRel({ ...saved, url: f.sources.find(p => p.year === g.year).fallbackUrl }, "paper")), false, "unverified 5228/5278 resolver bytes cannot satisfy primary");
      }
    }
    assert.equal(publication.digest(c, next.compatibility.legacy), publication.digest(build(f, true).modernCatalogue, build(f, true).compatibility.legacy), "row reorder is stable");
    assert.equal(publication.digest(c, next.compatibility.legacy), publication.digest(build(f).modernCatalogue, build(f).compatibility.legacy), "repeat build is stable");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("reviewed correction cannot relabel changed URLs/hashes in imports or historical restoration", () => {
  for (const drift of ["url", "sha256"]) {
    const f = fixture(), g = f.groups[0];
    f.options.validation.entries[g.portalUrl] = { ...f.options.validation.entries[g.mirrorUrl] };
    if (drift === "url") f.sources.find(p => p.id === g.canonicalId).url = "https://hscportal.pages.dev/changed.pdf";
    else f.options.validation.entries[g.portalUrl].sha256 = "f".repeat(64);
    const next = build(f), held = next.modernCatalogue.recoveryPapers.find(p => p.id === g.canonicalId);
    assert.equal(held.availability.state, "review"); assert.equal(held.subject, "Mathematics Advanced");
    const mirror = f.options.imports.entries[0], corrections = f.options.metadataCorrections;
    const v = structuredClone(f.options.validation); v.entries[mirror.url].sha256 = "f".repeat(64);
    assert.match(R.applyImports([], { entries: [mirror] }, { metadataCorrections: corrections, validation: v }).report.review[0].reason, /hash changed/);
    const restored = structuredClone(mirror); C.prepareMetadata([restored], corrections, v); assert.equal(restored.type, "trial");
  }
});
test("aligned-context 2016 remains held before existing-copy and import merges", () => {
  const f = fixture(), g = f.groups.find(g => g.year === 2016), p = structuredClone(f.sources.find(p => p.year === 2016));
  const v = f.options.validation; v.entries[g.portalUrl] = { ...v.entries[g.mirrorUrl], sha256: g.portalSha256 };
  C.prepareMetadata([p], f.options.metadataCorrections, v);
  const mirror = { ...f.options.imports.entries.find(p => p.year === 2016), subject: p.subject, type: p.type, examBlock: p.examBlock };
  const papers = [p, mirror]; R.coalesceExisting(papers, { validation: v }); assert.equal(papers.length, 2);
  const result = R.applyImports([p], { entries: [mirror] }, { metadataCorrections: f.options.metadataCorrections, validation: v });
  assert.equal(result.report.merged.length, 0); assert.equal(result.report.review.length, 1);
});
test("unproven cross-subject filenames and mismatched solutions never leak to the released consumer", () => {
  const p = { id: "owner", subject: "Maths (Accelerated)", year: 2011, school: "Sydney Boys", url: "https://test/primary.pdf", solutionUrl: "https://test/sol.pdf", libraryAliases: [
    { subject: "Mathematics Advanced", year: 2011, school: "Sydney Boys", url: "https://test/same.pdf", solutionUrl: "https://test/wrong-sol.pdf" },
    { subject: "Mathematics Advanced", year: 2011, school: "Sydney Boys", url: "https://test/unproven.pdf" },
  ] };
  const v = { entries: Object.fromEntries([[p.url, "a"], [p.solutionUrl, "b"], [p.libraryAliases[0].url, "a"], [p.libraryAliases[0].solutionUrl, "c"]].map(([url, hash]) => [url, { state: "verified", sha256: hash }])) };
  const { legacy } = F.prepare({ papers: [p] }, v); assert.equal(legacy.papers[0].libraryAliases.length, 2); // current record plus proven historical alias
  assert.ok(legacy.papers[0].libraryAliases.some(a => a.url === "https://test/same.pdf" && !a.solutionUrl));
  assert.equal(legacy.papers[0].libraryAliases.some(a => a.url === "https://test/unproven.pdf"), false);
});
test("a source-scoped review retains an established primary without treating the held bytes as a saved primary", () => {
  const p = { id: "owner", subject: "Biology", level: "Preliminary", school: "Sydney Tech", year: 2022, type: "other", url: "https://test/new.pdf", alternateSources: [{ url: "https://test/old.pdf" }] };
  const v = { entries: { [p.url]: { state: "verified", sha256: "a", text: "Biology" }, [p.alternateSources[0].url]: { state: "verified", sha256: "b", text: "Biology" } }, ownerExclusions: { owner: { url: p.url, sha256: "a", reason: "Unresolved new version" } } };
  const papers = [p]; C.apply(papers, v); assert.equal(papers.length, 1); assert.equal(p.url, "https://test/old.pdf");
  assert.equal(p.alternateSources.length, 0); assert.ok(p.libraryAliases.some(a => a.url === "https://test/new.pdf" && a.variantOnly));
  assert.equal(F.prepare({ papers }, v).legacy.papers[0].libraryAliases.some(a => a.url === "https://test/new.pdf"), false);
});
test("publication binding ignores timestamps/order, rejects changed identities/bytes, and completes once", () => {
  const modern = { generated: "before", papers: [{ id: "x", url: "https://test/x.pdf", sha256: "a" }], recoveryPapers: [], idAliases: {} }, legacy = { papers: modern.papers };
  const manifest = { state: "pending", sha256: publication.digest(modern, legacy) };
  assert.deepEqual(publication.verify(manifest, { ...modern, generated: "after" }, legacy), []);
  assert.equal(publication.verify(manifest, { ...modern, idAliases: { old: "x" } }, legacy).length, 1);
  assert.equal(publication.verify(manifest, { ...modern, papers: [{ ...modern.papers[0], sha256: "b" }] }, legacy).length, 1);
  assert.deepEqual(publication.verify({ ...manifest, state: "completed" }, { papers: [] }, legacy), []);
});
test("final source-copy gate retains explicit versions but never swaps their bytes as ordinary backups", () => {
  const p = { id: "p", url: "https://test/q.pdf", sha256: "a", alternateSources: [{ url: "https://test/copy.pdf" }, { url: "https://test/combined.pdf" }], fileVariants: [{ url: "https://test/combined.pdf", role: "combined", sha256: "b" }], libraryAliases: [{ url: "https://test/combined.pdf" }, { url: "https://test/combined.pdf", forKind: "solutions", savedKind: "paper" }] };
  const validation = { entries: Object.fromEntries([[p.url, "a"], ["https://test/copy.pdf", "a"], ["https://test/combined.pdf", "b"]].map(([url, sha256]) => [url, { state: "verified", sha256 }])) };
  assert.equal(C.restrictCopies([p], validation).length, 1);
  assert.deepEqual(p.alternateSources.map(a => a.url), ["https://test/copy.pdf"]);
  assert.equal(p.fileVariants.length, 1); assert.equal(p.libraryAliases[0].variantOnly, true); assert.equal(p.libraryAliases[1].variantOnly, undefined);
});

test("nightly new-active guard rejects new IDs but allows an existing identity to retarget", () => {
  const previous = { papers: [{ id: "old" }], recoveryPapers: [{ id: "recovery-old" }], idAliases: { "historical-old": "old" } };
  assert.deepEqual(V.newActiveIds({ papers: [{ id: "old" }, { id: "recovery-old" }], recoveryPapers: [], idAliases: {} }, previous), []);
  assert.deepEqual(V.newActiveIds({ papers: [{ id: "renamed" }], recoveryPapers: [], idAliases: { old: "renamed" } }, previous), []);
  assert.deepEqual(V.newActiveIds({ papers: [{ id: "new-card" }, { id: "renamed" }], recoveryPapers: [], idAliases: { old: "renamed" } }, previous), ["new-card"]);
});
