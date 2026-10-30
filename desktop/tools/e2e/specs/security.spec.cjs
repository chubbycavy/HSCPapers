const { test, expect } = require("@playwright/test");
const record = { id: "security-paper", subject: "Physics", school: "Example", year: 2025, type: "trial", title: "Security reader fixture", url: "https://hscportal.pages.dev/security-fontmatrix.pdf", hasSolutions: false };
const cat = row => ({ dataVersion: 2, papers: [row], recoveryPapers: [], idAliases: {} });
for (const lane of ["direct", "proxy"]) test(`patched reader safely renders a real FontMatrix CVE regression through ${lane}`, async ({ page }) => {
  const bytes = await require("../fontmatrix-fixture.cjs")();
  const p = { ...record, url: lane === "direct" ? record.url : "https://www.nsw.gov.au/security-fontmatrix.pdf" };
  await page.route("**/data/papers-v2.json**", route => route.fulfill({ json: cat(p) }));
  await page.route(lane === "direct" ? p.url : "**/proxy?**", route => route.fulfill({ body: bytes, contentType: "application/pdf" }));
  await page.addInitScript(() => { window.__hscFontMatrixExecuted = false; });
  const oldAssets = []; page.on("request", req => { if (/\/pdfjs\/pdf(?:\.worker)?\.min\.js/.test(req.url())) oldAssets.push(req.url()); });
  await page.goto("/"); await page.locator("[data-read]").click();
  await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible();
  expect(await page.evaluate(() => window.__hscFontMatrixExecuted)).toBe(false);
  expect(await page.evaluate(() => window.pdfjsLib.version)).toBe("6.4.299");
  expect(oldAssets).toEqual([]);
});
test("CSP permits the analytics beacon but blocks inline handlers, eval and other external scripts", async ({ page }) => {
  await page.route("**/security-eval-fixture.js", route => route.fulfill({ contentType: "text/javascript", body: "try { new Function('window.evalExecuted=true')(); } catch(e) { window.evalBlocked=e instanceof EvalError; }" }));
  await page.route("https://security.invalid/fixture.js", route => route.fulfill({ contentType: "text/javascript", body: "window.externalExecuted=true" }));
  await page.route("https://static.cloudflareinsights.com/beacon.min.js", route => route.fulfill({ contentType: "text/javascript", body: "window.analyticsBeaconLoaded=true" }));
  const response = await page.goto("/"); expect(response.headers()["content-security-policy"]).toContain("script-src-attr 'none'");
  await page.waitForSelector("#cards .card");
  await page.evaluate(() => {
    document.addEventListener("securitypolicyviolation", event => { if (event.blockedURI === "https://security.invalid/fixture.js") window.externalBlocked = true; });
    const script = document.createElement("script"); script.textContent = "window.inlineExecuted=true"; document.body.append(script);
    const image = document.createElement("img"); image.setAttribute("onerror", "window.handlerExecuted=true"); image.src = "/missing-security-image"; document.body.append(image);
    const external = document.createElement("script"); external.src = "/security-eval-fixture.js"; document.body.append(external);
    const foreign = document.createElement("script"); foreign.src = "https://security.invalid/fixture.js"; document.body.append(foreign);
    const analytics = document.createElement("script"); analytics.src = "https://static.cloudflareinsights.com/beacon.min.js"; document.body.append(analytics);
  });
  await expect.poll(() => page.evaluate(() => window.evalBlocked)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.externalBlocked)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.analyticsBeaconLoaded)).toBe(true);
  expect(await page.evaluate(() => [window.inlineExecuted, window.handlerExecuted, window.evalExecuted, window.externalExecuted].some(Boolean))).toBe(false);
  await page.locator("#themeBtn").click(); await expect(page.locator("#cards .card").first()).toBeVisible();
});
test("malformed live metadata is rejected before stored bookmarks or queues are migrated", async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem("hsc-bookmarked", '["keep-me"]'); localStorage.setItem("hsc-queue", '{"files":[{"id":"keep-me"}]}'); });
  await page.route("**/data/papers-v2.json**", route => route.fulfill({ json: cat({ ...record, year: "../../Startup" }) }));
  await page.goto("/"); await expect(page.locator("#cards")).toContainText("Couldn't load the compatible catalogue");
  expect(await page.evaluate(() => localStorage.getItem("hsc-bookmarked"))).toBe('["keep-me"]');
  expect(await page.evaluate(() => localStorage.getItem("hsc-queue"))).toBe('{"files":[{"id":"keep-me"}]}');
  expect(await page.evaluate(() => localStorage.getItem("hsc-state-before-migration-v2"))).toBeNull();
});
test("worker upgrade removes old executable caches while preserving offline PDFs and bookmarks", async ({ page }) => {
  const bookmark = require("../../../ui/data/papers-v2.json").papers[0].id;
  const bytes = [...require("../pdf-fixture.cjs")("Preserved offline paper", 1)];
  await page.route("**/cache-upgrade-fixture", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Seed existing cache</title>" }));
  await page.goto("/cache-upgrade-fixture");
  await page.evaluate(async ({ bookmark, bytes }) => {
    await (await caches.open("hsc-shell-v6")).put("/pdfjs/pdf.min.js", new Response("obsolete reader"));
    await (await caches.open("hsc-pdfs-v6")).put("/preserved-offline.pdf", new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/pdf" } }));
    await caches.open("hsc-pages-v6");
    localStorage.setItem("hsc-bookmarked", JSON.stringify([bookmark]));
  }, { bookmark, bytes });
  await page.goto("/"); await page.waitForSelector("#cards .card");
  // Production auto-registers on HTTPS. Loopback is a secure test context, but
  // registration is explicit here because the app intentionally skips HTTP.
  await page.evaluate(async () => { await navigator.serviceWorker.register("/sw.js"); await navigator.serviceWorker.ready; });
  await expect.poll(() => page.evaluate(async () => (await caches.keys()).includes("hsc-shell-v6"))).toBe(false);
  expect(await page.evaluate(async () => (await caches.keys()).includes("hsc-shell-v8-source-credit"))).toBe(true);
  expect(await page.evaluate(async () => [...new Uint8Array(await (await (await caches.open("hsc-pdfs-v6")).match("/preserved-offline.pdf")).arrayBuffer())])).toEqual(bytes);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("hsc-bookmarked")))).toEqual([bookmark]);
});
