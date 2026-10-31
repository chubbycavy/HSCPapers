const test = require("node:test");
const assert = require("node:assert/strict");
const { routerKey, candidates, applyVerified, validate } = require("../thsc-au.cjs");
const url = "https://thsconline.github.io/s/d/5106/Sydney%20Boys%202004";
const proof = { key: routerKey(url), url: "https://thsconline.com.au/pdf/papers/exam.pdf", bytes: 100, pages: 1, sha256: "a".repeat(64) };
test("same school/year but another route is not treated as the same exam", () => {
  const papers = [{ id: "one", url, subject: "Mathematics", year: 2004, school: "Sydney Boys" }];
  const wrong = { ...proof, key: "5108|sydney boys 2004" };
  assert.equal(applyVerified(papers, { entries: [wrong] }), 0);
  assert.equal(papers[0].url, url);
  assert.equal(applyVerified(papers, { entries: [proof] }), 1);
  assert.equal(papers[0].id, "one");
  assert.equal(papers[0].fallbackUrl, url);
});
test("ambiguous exact IDs are refused rather than overwritten", () => {
  const row = { id: "5106/Sydney Boys 2004", r2_key: "papers/a.pdf", bytes: 100, pages: 1 };
  const result = candidates([{ papers: [row, { ...row, r2_key: "papers/b.pdf" }] }]);
  assert.equal(result.byKey.size, 0);
  assert.equal(result.ambiguous.size, 1);
});
test("title equality alone never removes distinct catalogue entries", () => {
  const papers = [{ id: "paper", title: "2004 English HSC", url }, { id: "answers", title: "2004 English HSC", url: "https://www.nsw.gov.au/answers.pdf" }];
  applyVerified(papers, { entries: [] });
  assert.deepEqual(papers.map(p => p.id), ["paper", "answers"]);
});
test("unverified registry rows cannot introduce replacement URLs", () => {
  const papers = [{ id: "one", url }];
  assert.equal(applyVerified(papers, { entries: [{ ...proof, sha256: "" }] }), 0);
});
test("PDF validation rejects HTML and declared-length mismatches", async () => {
  await assert.rejects(validate(proof, { fetchImpl: async () => new Response("<html>error</html>", { headers: { "content-type": "text/html" } }) }), /not a direct PDF/);
  await assert.rejects(validate(proof, { fetchImpl: async () => new Response("%PDF-1.4\ntruncated", { headers: { "content-type": "application/pdf" } }) }), /byte length mismatch/);
});
test("mirror verification bounds downloads and returns first-page evidence on request", async () => {
  const bytes = require("../e2e/pdf-fixture.cjs")("Biology trial questions", 1);
  const item = { ...proof, bytes: bytes.length };
  const result = await validate(item, { includeText: true, fetchImpl: async () => new Response(bytes, { headers: { "content-type": "application/pdf" } }) });
  assert.equal(result.pages, 1); assert.match(result.text, /Biology trial questions/);
  assert.equal(result.sha256, require("crypto").createHash("sha256").update(bytes).digest("hex"));
  await assert.rejects(validate(item, { fetchImpl: async () => new Response(bytes, { headers: { "content-type": "application/pdf", "content-length": String(33 * 1024 * 1024) } }) }), /byte limit/);
});
test("normal anti-rot coverage includes every published primary preference and reviewed PDF version", () => {
  const imports = require("../catalogue-imports.json"), catalogue = require("../../ui/data/papers-v2.json");
  const active = new Set(catalogue.papers.map(p => p.id));
  const { rows } = require("../validate-registry.cjs").loadEntries({ name: "catalogue-imports", file: require("path").join(__dirname, "../catalogue-imports.json") });
  const byUrl = new Map();
  for (const row of rows) { if (!byUrl.has(row.url)) byUrl.set(row.url, []); byUrl.get(row.url).push(row); }
  let checked = 0;
  for (const binding of imports.primaryPreferences || []) if (active.has(catalogue.idAliases[binding.id] || binding.id)) {
    assert.ok(byUrl.get(binding.preferredUrl)?.some(row => row.sha256 === binding.sha256 && row.bytes === binding.bytes), binding.id + " missing preferred-source health probe"); checked++;
  }
  for (const binding of imports.reviewedVariants || []) if (active.has(catalogue.idAliases[binding.id] || binding.id)) for (const v of binding.variants || []) {
    assert.ok(byUrl.get(v.url)?.some(row => row.sha256 === v.sha256 && row.bytes === v.bytes && row.pages === v.pages), binding.id + " missing version health probe"); checked++;
  }
  assert.ok(checked > 0, "published source bindings must exercise the health loader");
});
