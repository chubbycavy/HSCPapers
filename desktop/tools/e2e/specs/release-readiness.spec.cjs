const { test, expect } = require("@playwright/test");
const pdf = require("../pdf-fixture.cjs")("Release readiness");
const JSZip = require("../../../ui/vendor/jszip.min.js");
const fast = "https://hscportal.pages.dev/release-paper.pdf";
const alt = "https://hscportal.pages.dev/release-backup.pdf";
const legacy = "https://thsconline.github.io/s/d/6528/Example%202025";
const fragment = "https://www.thsconline.net/s/v/6528/Example%202025";
const record = { id: "release-paper", subject: "Physics", school: "Example", year: 2025, type: "trial", level: "HSC", title: "2025 Example Physics Trial", url: fast, hasSolutions: false };
const cat = papers => ({ dataVersion: 2, papers, recoveryPapers: [], idAliases: { "previous-paper": "release-paper" } });
async function fixture(page, p, sources) {
  await page.route("**/data/papers-v2.json**", route => route.fulfill({ json: cat([p]) }));
  const requests = [];
  await page.route("**/*", route => {
    const u = new URL(route.request().url()), source = u.pathname === "/proxy" ? u.searchParams.get("url") : u.href;
    if (!sources.has(source)) return route.fallback();
    requests.push(source);
    return route.fulfill(sources.get(source) ? { body: pdf, contentType: "application/pdf" } : { status: 404, body: "Unavailable" });
  });
  return requests;
}
async function native(page, initial = {}) {
  await page.addInitScript(initial => {
    for (const [k,v] of Object.entries(initial)) localStorage.setItem(k, v);
    window.nativeJobs = [];
    window.__TAURI__ = {
      core: { invoke: async (cmd, args) => {
        if (cmd === "saved_paths") return args.relpaths.map(() => null);
        if (cmd === "get_library_config") return { library: "C:/fixture", is_default: true };
        if (cmd === "update_check") return { update_available: false };
        if (cmd === "download_paper") { window.nativeJobs.push(args); return "C:/fixture/paper.pdf"; }
        return null;
      } }, event: { listen: async () => () => {} },
    };
  }, initial);
}
test("web download rejects invalid primary and uses fast backup with Slow route off", async ({ page }) => {
  const calls = await fixture(page, { ...record, alternateSources: [{ url: alt }] }, new Map([[fast, false], [alt, true]]));
  await page.goto("/"); const download = page.waitForEvent("download");
  await page.locator("a[data-dl][data-kind=paper]").click(); await download;
  expect(calls).toEqual([fast, alt]);
});
test("legacy backup is attempted only with Slow route enabled", async ({ page }) => {
  const calls = await fixture(page, { ...record, fallbackUrl: legacy }, new Map([[fast, false], [legacy, true]]));
  await page.goto("/"); await page.locator("a[data-dl][data-kind=paper]").click();
  await expect(page.locator("#zipProgress")).toContainText("Download failed"); expect(calls).toEqual([fast]);
  await page.locator("#slowRoute").evaluate(el => el.click());
  const download = page.waitForEvent("download"); await page.locator("a[data-dl][data-kind=paper]").click(); await download;
  expect(calls).toEqual([fast, fast, legacy]);
});
test("fragment failure cannot issue its catalogue legacy backup even with Slow route on", async ({ page }) => {
  const calls = await fixture(page, { ...record, url: fragment, fallbackUrl: legacy }, new Map([[fragment, false], [legacy, true]]));
  await page.goto("/"); await page.locator("#slowRoute").evaluate(el => el.click());
  await page.locator("a[data-dl][data-kind=paper]").click(); await expect(page.locator("#zipProgress")).toContainText("Download failed");
  expect(calls).toEqual([fragment]);
});
test("ZIP retains a fast solutions backup when Slow route is off", async ({ page }) => {
  const sol = "https://hscportal.pages.dev/release-sol.pdf", solAlt = "https://hscportal.pages.dev/release-sol-backup.pdf";
  const calls = await fixture(page, { ...record, solutionUrl: sol, solFallbackUrl: solAlt, hasSolutions: true }, new Map([[fast, true], [sol, false], [solAlt, true]]));
  await page.goto("/"); await page.locator("#cards .card input").check();
  const pending = page.waitForEvent("download"); await page.locator("#zipBtn").click(); const download = await pending;
  const chunks = []; for await (const part of await download.createReadStream()) chunks.push(part);
  const zip = await JSZip.loadAsync(Buffer.concat(chunks));
  expect(Object.values(zip.files).filter(f => !f.dir)).toHaveLength(2);
  expect(calls).toEqual([fast, sol, solAlt]);
});
test("explicit alternate version cannot fall back to the canonical document", async ({ page }) => {
  const p = { ...record, alternateSources: [{ url: alt }], fileVariants: [{ url: fast, role: "combined", pages: 3 }, { url: fragment, role: "questions", label: "Questions only", pages: 1 }] };
  const calls = await fixture(page, p, new Map([[fragment, false], [alt, true], [fast, true]]));
  await page.goto("/"); await page.locator("#slowRoute").evaluate(el => el.click());
  await page.locator("#cards details summary").click(); await page.getByRole("button", { name: "Questions only (1 pages)" }).click();
  await expect(page.locator("#readerErr")).toBeVisible(); expect(calls).toEqual([fragment]);
});
test("promoted mirror fails over to its identical Portal backup for save and reader without Slow route", async ({ page }) => {
  const catalogue = require("../../../ui/data/papers-v2.json"), pref = require("../../../tools/catalogue-imports.json").primaryPreferences[0];
  const p = catalogue.papers.find(p => p.id === pref.id);
  expect(p.url).toBe(pref.preferredUrl); expect(p.fallbackUrl).toBe(pref.primaryUrl);
  const calls = await fixture(page, p, new Map([[p.url, false], [pref.primaryUrl, true]]));
  await page.goto("/");
  const pending = page.waitForEvent("download"); await page.locator("a[data-dl][data-kind=paper]").click(); await pending;
  expect(calls).toEqual([p.url, pref.primaryUrl]);
  await page.locator("[data-read]").click(); await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible();
  await expect(page.locator("#paperSourceCredit")).toContainText("HSC Portal");
  await expect(page.locator(".card-source")).toContainText("independent THSC mirror");
  expect(calls).toEqual([p.url, pref.primaryUrl, p.url, pref.primaryUrl]);
});
test("reviewed mirror representation from the real catalogue keeps its own reader failure isolated", async ({ page }) => {
  const p = require("../../../ui/data/papers-v2.json").papers.find(p => p.fileVariants?.some(v => v.label === "Mirror PDF (same rendered content)"));
  expect(p).toBeTruthy();
  const v = p.fileVariants.find(v => v.label === "Mirror PDF (same rendered content)");
  const sources = new Map([[p.url, true], ...[p.fallbackUrl, ...(p.alternateSources || []).map(a => a.url)].filter(Boolean).map(url => [url, true]), [v.url, false]]);
  const calls = await fixture(page, p, sources);
  await page.goto("/");
  const card = page.locator(`[data-id="${p.id}"]`);
  await card.locator("details summary").click();
  await card.getByRole("button", { name: /Mirror PDF \(same rendered content\)/ }).click();
  await expect(page.locator("#readerErr")).toBeVisible(); expect(calls).toEqual([v.url]);
});
test("slow solutions on a fast-paper card require the switch for online actions", async ({ page }) => {
  const calls = await fixture(page, { ...record, solutionUrl: fragment, hasSolutions: true }, new Map([[fast, true], [fragment, true]]));
  await page.goto("/"); const solution = page.locator("a[data-kind=solutions]");
  await expect(solution).toHaveAttribute("aria-disabled", "true"); expect(await solution.getAttribute("href")).toBeNull();
  await solution.click({ force: true }); expect(calls).toEqual([]);
  await page.locator("[data-read]").click(); await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible();
  await expect(page.locator("#numPaper")).toContainText("1 / 3");
  await expect(page.locator("#readerAddSol")).toBeDisabled(); await expect(page.locator("#readerAddSol")).toHaveAttribute("title", /Enable Slow route/);
  await page.keyboard.press("Escape"); await page.locator("#slowRoute").evaluate(el => el.click());
  const pending = page.waitForEvent("download"); await page.locator("a[data-kind=solutions]").click(); await pending;
  expect(calls).toEqual([fast, fragment]);
});
test("native descriptor card links use the public PDF gateway", async ({ page }) => {
  await native(page, { "hsc-state-v1": JSON.stringify({ includeSlowRoute: true }) });
  await fixture(page, { ...record, url: fragment }, new Map()); await page.goto("/");
  const link = page.locator("#cards a.go"); await expect(link).toBeVisible();
  const u = new URL(await link.getAttribute("href")); expect(u.origin + u.pathname).toBe("https://hscpapers.com/proxy");
  expect(u.searchParams.get("url")).toBe(fragment); expect(u.searchParams.get("dl")).toBe("1");
});
for (const liveVersion of [1, 3, "offline"]) test(`native incompatible live ${liveVersion} falls back to the modern bundled feed`, async ({ page }) => {
  await native(page);
  await page.route("https://hscpapers.com/data/papers-v2.json**", route => liveVersion === "offline" ? route.abort("failed") : route.fulfill({ json: { dataVersion: liveVersion, papers: [{ ...record, id: "wrong-live" }] } }));
  await page.route(test.info().project.use.baseURL + "/data/papers-v2.json**", route => route.fulfill({ json: cat([record]) }));
  await page.goto("/"); await expect(page.locator('[data-id="release-paper"]')).toBeVisible();
  await expect(page.locator('[data-id="wrong-live"]')).toHaveCount(0);
});
test("raw state is checkpointed before alias remapping and retained after reload", async ({ page }) => {
  await page.addInitScript(() => { if (!localStorage.getItem("seeded")) { localStorage.setItem("seeded", "1"); localStorage.setItem("hsc-bookmarked", '["previous-paper"]'); localStorage.setItem("hsc-queue", '{"files":[{"id":"previous-paper","url":"old-url"}]}'); } });
  await fixture(page, record, new Map()); await page.goto("/"); await expect(page.locator("#cards .card")).toHaveCount(1);
  const before = await page.evaluate(() => localStorage.getItem("hsc-state-before-migration-v2"));
  expect(JSON.parse(before).values["hsc-bookmarked"]).toBe('["previous-paper"]');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("hsc-bookmarked")))).toEqual([record.id]);
  await page.reload(); await expect(page.locator("#cards .card")).toHaveCount(1);
  expect(await page.evaluate(() => localStorage.getItem("hsc-state-before-migration-v2"))).toBe(before);
});
test("native resumed queues resolve current fragment source and exclude legacy fallback", async ({ page }) => {
  await native(page, { "hsc-state-v1": JSON.stringify({ includeSlowRoute: true }), "hsc-queue": JSON.stringify({ files: [{ id: "previous-paper", kind: "paper", url: legacy, relpath: "old.pdf" }] }) });
  await fixture(page, { ...record, url: fragment, fallbackUrl: legacy }, new Map()); await page.goto("/");
  await page.locator("#resumeBarBtn").click();
  await expect.poll(() => page.evaluate(() => window.nativeJobs.length)).toBe(1);
  expect(await page.evaluate(() => window.nativeJobs[0])).toMatchObject({ id: record.id, url: fragment, fallback: null });
});
