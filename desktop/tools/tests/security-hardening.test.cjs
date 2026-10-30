"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("fs"), path = require("path"), os = require("os");
const schema = require("../../ui/js/catalogue-schema.js"), migration = require("../../ui/js/migration-state.js");
const record = { id: "security-paper", subject: "Physics", school: "Example", year: 2025, type: "trial", title: "2025 Example Trial", url: "https://hscportal.pages.dev/test.pdf" };
const cat = row => ({ dataVersion: 2, papers: [row], recoveryPapers: [], idAliases: {} });
test("source attribution recognizes exact file hosts without changing delivery eligibility", () => {
  const policy = require("../../ui/js/source-policy.js");
  assert.deepEqual(policy.credit("https://hscportal.pages.dev/yr12/a.pdf"), { name: "HSC Portal", href: "https://www.hscportal.app/" });
  assert.equal(policy.credit("https://www.nsw.gov.au/a.pdf").name, "NESA");
  assert.equal(policy.credit("https://pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev/a.pdf").name, "HSCPapers");
  for (const url of [null, "", "file:///saved.pdf", "blob:https://hscpapers.com/abc", "https://hscportal.pages.dev.evil.test/a.pdf", "https://hscportal.pages.dev@evil.test/a.pdf", "https://user@hscportal.pages.dev/a.pdf", "https://hscportal.pages.dev:444/a.pdf", "https://unknown.test/a.pdf"]) assert.equal(policy.credit(url), null);
  assert.equal(policy.isFast("https://unknown.test/a.pdf"), false);
  assert.equal(policy.isFast("https://thsconline.github.io/s/d/1234/paper"), false);
});
test("catalogue rejects path/HTML years, CSS types, source schemes and poisoned filename history before client migration", () => {
  for (const change of [{ year: '../Startup' }, { year: 'x"><img src=x onerror=alert(1)>' }, { year: [2025] }, { year: 9999 }, { subject: ".." }, { school: "CON" }, { type: 'trial" onmouseover="alert(1)' }, { url: "javascript:alert(1)" }, { url: "https://user:secret@hscportal.pages.dev/a.pdf" }, { libraryAliases: [{ ...record, year: "../../" }] }, { fileVariants: [{ url: "data:text/html,test" }] }]) {
    const c = cat({ ...record, ...change }); assert.ok(schema.issues(c).length); assert.equal(migration.compatible(c), false);
  }
  for (const value of [[], {}, true, 0, -1, Infinity, "2025/../", " 2025 "]) assert.throws(() => schema.year(value));
  assert.equal(schema.year("2025"), 2025); assert.equal(schema.year(null), null);
});
test("current modern, compatibility and archived filename records pass strict metadata validation", () => {
  for (const file of ["papers-v2.json", "papers.json"]) assert.deepEqual(schema.issues(require("../../ui/data/" + file)), []);
});
test("production reconciliation rejects poisoned parsed-source metadata before matching", () => {
  assert.throws(() => require("../catalogue-pipeline.cjs").build([{ ...record, year: "../Startup" }], {}), /year before reconciliation/);
});
test("sparse exact-source mirror imports retain historical filename aliases without weakening complete-record validation", () => {
  const R = require("../catalogue-reconcile.cjs"), hash = "a".repeat(64);
  const owner = { ...record, viewno: "1234", linkText: "Example 2025", sha256: hash };
  const mirror = { ...record, id: "sparse-mirror", source: "test", url: "https://thsconline.com.au/pdf/sparse.pdf", school: null, year: null, listingKey: "1234|example 2025", sha256: hash, bytes: 200 };
  mirror.legacyRecord = R.legacyRecord(mirror);
  const result = R.applyImports([owner], { entries: [mirror] });
  assert.equal(result.report.merged.length, 1); assert.equal(result.aliases[mirror.id], owner.id);
  assert.ok(owner.libraryAliases.some(a => a.id === mirror.id && a.url === mirror.url));
  assert.ok(schema.metadataIssue({ ...record, school: null }));
  assert.ok(schema.metadataIssue({ school: ".." }, { partial: true }));
  assert.ok(schema.metadataIssue({ year: "../../" }, { partial: true }));
});
test("static generators reject poisoned years and safely escape text, attributes and JSON-LD", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hsc-security-html-"));
  try {
    fs.mkdirSync(path.join(dir, "data"));
    const file = path.join(dir, "data/papers-v2.json");
    fs.writeFileSync(path.join(dir, "index.html"), "<html><body></body></html>");
    fs.writeFileSync(file, JSON.stringify(cat({ ...record, year: 'x"><img src=x onerror=alert(1)>' })));
    await assert.rejects(require("../coverage-report.cjs")({ ui: dir }), /year/);
    await assert.rejects(require("../landing-pages.cjs")({ ui: dir }), /year/);
    assert.equal(fs.existsSync(path.join(dir, "coverage.html")), false);
    const subject = '</script><img src=x onerror="globalThis.injected=true">';
    fs.writeFileSync(file, JSON.stringify({ ...cat({ ...record, subject, title: subject }), generated: '<img src=x onerror="bad()">' }));
    await require("../coverage-report.cjs")({ ui: dir });
    await require("../landing-pages.cjs")({ ui: dir });
    const coverage = fs.readFileSync(path.join(dir, "coverage.html"), "utf8");
    const html = fs.readFileSync(path.join(dir, "subjects", require("../landing-pages.cjs").slugOf(subject), "index.html"), "utf8");
    for (const text of [coverage, html]) { assert.equal(text.includes('<img src=x'), false); assert.equal(text.includes('<script>'), false); }
    const json = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1];
    assert.equal(json.includes("</script>"), false); assert.equal(JSON.parse(json).itemListElement[2].name, subject);
    assert.ok(coverage.includes("&lt;/script&gt;"));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test("deployed header rules block inline/eval scripts and MIME sniffing on every HTML surface", () => {
  const { headersFor } = require("../security-headers.cjs");
  for (const url of ["/", "/coverage", "/coverage.html", "/subjects/physics/", "/demo-scroll.html"]) {
    const h = headersFor(url), scripts = h["Content-Security-Policy"].split(";").find(d => d.trim().startsWith("script-src ")).trim().split(/\s+/);
    assert.ok(scripts.includes("'self'")); assert.equal(scripts.includes("'unsafe-eval'"), false); assert.equal(scripts.includes("'unsafe-inline'"), false);
    assert.ok(scripts.includes("https://static.cloudflareinsights.com/beacon.min.js"));
    assert.equal(scripts.includes("https:"), false);
    assert.equal(h["X-Content-Type-Options"], "nosniff");
  }
});
