/* Nuclear reader tier: continuous scroll, solutions gating, sync, print,
   keyboard — PDF bytes only from our own R2 bucket (politeness rule). */
const { test, expect } = require("@playwright/test");
const { r2Paper, solPaper, noSolPaper } = require("../helpers.cjs");

async function openPaper(page, title) {
  await page.goto("/");
  await page.waitForSelector("#cards .card", { timeout: 30_000 });
  await page.fill("#q", title.slice(0, 60));
  await page.locator("#searchForm button[type=submit]").click();
  const card = page.locator("#cards .card").filter({ hasText: title.slice(0, 60) }).first();
  await card.waitFor({ timeout: 20_000 });
  await card.locator("[data-read]").click();
  await expect(page.locator("#reader")).toBeVisible();
  return card;
}

test.describe("reader (continuous scroll)", () => {
  test("opens paper-only; pages render; scroll advances the counter", async ({ page }) => {
    test.setTimeout(90_000);
    await openPaper(page, r2Paper.title);
    // paper-only: the solutions pane is hidden (computed style, not just attribute)
    await expect(page.locator("#paneSol")).toBeHidden();
    expect(await page.locator("#paneSol").evaluate((el) => getComputedStyle(el).display)).toBe("none");
    // pages actually paint (the blank-page regression guard)
    await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    const total = await page.locator("#numPaper").textContent();
    expect(total).toMatch(/^1 \/ \d+$/);
    // scroll deep — lazy pages render and the counter follows
    await page.locator("#scrollPaper").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => parseInt((await page.locator("#numPaper").textContent()).split(" / ")[0], 10), { timeout: 20_000 }).toBeGreaterThan(1);
    // lazy render kicked in near the bottom
    await expect(page.locator("#panePaper .rpage.done").last()).toBeVisible({ timeout: 20_000 });
  });

  test("keyboard arrows jump pages; Escape closes", async ({ page }) => {
    test.setTimeout(90_000);
    await openPaper(page, r2Paper.title);
    await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("ArrowRight");
    await expect(page.locator("#numPaper")).toHaveText(/^2 \/ /);
    await page.keyboard.press("Escape");
    await expect(page.locator("#reader")).toBeHidden();
  });

  test("＋ Solutions: enabled for papers with solutions, renders; disabled+tooltip otherwise", async ({ page }) => {
    test.setTimeout(90_000);
    // with solutions (fast-hosted)
    await openPaper(page, solPaper.title);
    const addSol = page.locator("#readerAddSol");
    await expect(addSol).toBeEnabled();
    await addSol.click();
    await expect(page.locator("#paneSol")).toBeVisible();
    await expect(page.locator("#scrollSol .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("Escape");

    // without solutions
    await openPaper(page, noSolPaper.title);
    await expect(page.locator("#readerAddSol")).toBeDisabled();
    await expect(page.locator("#readerAddSol")).toHaveAttribute("title", "No solutions file available for this paper");
  });

  test("page-follow sync turns the solutions with the paper", async ({ page }) => {
    test.setTimeout(120_000);
    await openPaper(page, solPaper.title);
    await expect(page.locator("#scrollPaper .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await page.locator("#readerAddSol").click();
    await expect(page.locator("#scrollSol .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await page.locator("#readerSyncBtn").click();
    await expect(page.locator("#readerSyncBtn")).toHaveClass(/on/);
    // advance the paper a page; the solutions counter follows (clamped)
    await page.locator("#panePaper .pane-nav").nth(1).click();
    await expect.poll(async () => (await page.locator("#numSol").textContent()).split(" / ")[0], { timeout: 10_000 }).toBe("2");
  });

  test("print opens a print-ready popup", async ({ page }) => {
    test.setTimeout(90_000);
    const ctx = page.context();
    await openPaper(page, r2Paper.title);
    await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    const popupPromise = ctx.waitForEvent("page");
    await page.locator("#panePaper .pane-print").click();
    const popup = await popupPromise;
    await expect.poll(async () => (await popup.locator("body").innerHTML()).includes("page 1"), { timeout: 20_000 }).toBe(true);
    await popup.close();
  });
});
