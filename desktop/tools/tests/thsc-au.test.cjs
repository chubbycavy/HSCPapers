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
