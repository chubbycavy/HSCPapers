/* Nuclear production tier: verify what USERS receive from the live site.
   Politeness rule: PDF bytes only from our own R2 bucket. Run standalone:
   node desktop/tools/e2e/live-check.cjs */
const fs = require("fs");
const path = require("path");
const { chromium } = require("@playwright/test");

const BASE = "https://hscpapers.pages.dev/";
let fails = 0, passes = 0;
const pass = (s) => { passes++; console.log(`  PASS  ${s}`); };
const fail = (s) => { fails++; console.log(`  FAIL  ${s}`); };

(async () => {
  // 1. plain HTTP checks
  const papers = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "ui", "data", "papers.json"), "utf8")).papers;
  const live = await (await fetch(BASE + "data/papers.json?cb=" + Date.now(), { redirect: "follow", signal: AbortSignal.timeout(20000) })).json();
  const n = (live.papers || []).length;
  const nsw = (live.papers || []).filter((p) => (p.url || "").includes("www.nsw.gov.au")).length;
  const r2 = (live.papers || []).filter((p) => (p.url || "").includes("pub-ec23")).length;
  // floors track the current baseline: 6,975 papers after the same-file
  // dedupe collapse; 319 nsw.gov.au primaries after dan's index transfers
  // moved some to his GitHub hosting
  if (n >= 6900 && nsw >= 310 && r2 >= 70) pass(`catalogue: ${n} papers | nsw ${nsw} | r2 ${r2}`);
  else fail(`catalogue markers drifted: ${n}/${nsw}/${r2}`);

  for (const f of ["sw.js", "manifest.webmanifest", "og-card.png", "robots.txt", "sitemap.xml", "icon-192.png", "coverage"]) {
    const r = await fetch(BASE + f + "?cb=" + Date.now(), { redirect: "follow", signal: AbortSignal.timeout(20000) });
    if (r.ok) pass(`${f} -> ${r.status}`);
    else fail(`${f} -> ${r.status}`);
  }
  const swHead = await fetch(BASE + "sw.js", { redirect: "follow", signal: AbortSignal.timeout(20000) });
  const cc = swHead.headers.get("cache-control") || "";
  if (cc.includes("no-cache")) pass("sw served with no-cache (updates always land)");
  else fail("sw cache-control missing no-cache");

  // 2. browser checks (rendering-level — the classes our static tests miss)
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE, { waitUntil: "load", timeout: 60_000 });
  // The SW takeover-reload (fresh profile -> clientsClaim -> controllerchange
  // -> one-time reload) can land between the cards rendering and the count —
  // the same race the og/canonical check dodges via fetch. Reload-tolerant
  // retry here.
  let cards = 0;
  for (let attempt = 0; attempt < 2 && cards === 0; attempt++) {
    try { await page.waitForSelector("#cards .card", { timeout: 30_000 }); } catch { /* navigation raced */ }
    cards = await page.locator("#cards .card").count();
    if (cards === 0 && attempt === 0) await page.reload({ waitUntil: "load", timeout: 60_000 });
  }
  if (cards > 0) pass(`live catalogue renders (${cards} cards on page 1)`);
  else fail("live catalogue renders no cards");
  const ogHtml = await (await fetch(BASE + "?cb=" + Date.now(), { redirect: "follow", signal: AbortSignal.timeout(20000) })).text();
  if (ogHtml.includes("og:title") && ogHtml.includes("canonical")) pass("og/canonical present");
  else fail("og/canonical missing");

  // coverage page (server-rendered content assertions; the hover journey
  // runs in the local suite — production 308s abort browser navigation)
  const cov = await (await fetch(BASE + "coverage?cb=" + Date.now(), { redirect: "follow", signal: AbortSignal.timeout(20000) })).text();
  if (cov.includes("data-label") && cov.includes("covtip") && cov.includes("Subjects")) pass("coverage page carries the live matrix + instant tooltip");
  else fail("coverage page markers missing");

  // landing pages (Phase C): the hub + one subject page, real content
  const papersLocal = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "ui", "data", "papers.json"), "utf8")).papers;
  const sample = papersLocal.find((p) => p.subject === "Chemistry") ? "chemistry" : null;
  const hub = await (await fetch(BASE + "subjects/?cb=" + Date.now(), { redirect: "follow", signal: AbortSignal.timeout(20000) })).text();
  if (hub.includes("Browse NSW HSC papers by subject") && hub.includes("/subjects/")) pass("subjects hub live");
  else fail("subjects hub missing");
  const sitemapTxt = await (await fetch(BASE + "sitemap.xml?cb=" + Date.now(), { redirect: "follow", signal: AbortSignal.timeout(20000) })).text();
  const nUrls = (sitemapTxt.match(/<loc>/g) || []).length;
  if (nUrls >= 100 && sitemapTxt.includes("/subjects/")) pass(`sitemap live with subject pages (${nUrls} urls)`);
  else fail(`sitemap under-covers (${nUrls} urls)`);
  if (sample) {
    const sp = await (await fetch(BASE + "subjects/" + sample + "/?cb=" + Date.now(), { redirect: "follow", signal: AbortSignal.timeout(20000) })).text();
    if (sp.includes("past papers") && sp.includes("papers indexed") && sp.includes("Open")) pass("sample subject page live with the paper table");
    else fail("sample subject page missing/incomplete");
  }

  // 3. reader journey on OUR bucket only
  const r2Paper = (live.papers || []).find((p) => (p.url || "").startsWith("https://pub-ec23"));
  if (r2Paper) {
    await page.goto(BASE, { waitUntil: "load" });
    await page.fill("#q", r2Paper.title.slice(0, 40));
    await page.locator("#searchForm button[type=submit]").click();
    const card = page.locator("#cards .card").filter({ hasText: r2Paper.title.slice(0, 40) }).first();
    await card.locator("[data-read]").click();
    await page.waitForSelector("#reader:not([hidden])", { timeout: 30_000 });
    try {
      await page.waitForSelector("#panePaper .rpage.done", { timeout: 30_000 });
      pass("live reader renders an R2-hosted paper (real bytes, real browser)");
    } catch { fail("live reader did not render an R2 paper"); }
    await page.keyboard.press("Escape");
  }
  await browser.close();

  console.log(`\n==== LIVE CHECK ====`);
  console.log(`PASS ${passes} | FAIL ${fails}`);
  process.exitCode = fails ? 1 : 0;
})();
