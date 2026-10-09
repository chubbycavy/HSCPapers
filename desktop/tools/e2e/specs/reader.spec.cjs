/* Nuclear reader tier: continuous scroll, solutions gating, sync, print,
   keyboard — PDF bytes only from our own R2 bucket (politeness rule). */
const { test, expect } = require("@playwright/test");
const { r2Paper, solPaper, noSolPaper } = require("../helpers.cjs");
const { freezeTimerClock, checkTimerToggleJourney, checkTimerReloadJourney, checkTimerIconAlignment } = require("../timer-check.cjs");

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

  test("timer: dismissal resets elapsed time and reopening restarts the saved preset", async ({ page }) => {
    test.setTimeout(90_000);
    await openPaper(page, r2Paper.title);
    await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await checkTimerToggleJourney(page);
  });

  test("timer: preset/custom/count-up preferences survive refresh and restart from their full duration", async ({ page }) => {
    test.setTimeout(90_000);
    const card = await openPaper(page, r2Paper.title);
    await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await freezeTimerClock(page);
    await checkTimerReloadJourney(page, async () => {
      await page.waitForSelector("#cards .card", { timeout: 30_000 });
      await card.locator("[data-read]").click();
      await expect(page.locator("#reader")).toBeVisible();
    });
  });

  test("timer: repeated pauses preserve fractional seconds in both count-up and countdown", async ({ page }) => {
    test.setTimeout(90_000);
    await openPaper(page, r2Paper.title);
    await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await freezeTimerClock(page);
    await page.locator("#readerTimerBtn").click();
    for (const [preset, first, second, third] of [["0", "00:01", "00:02", "00:03"], ["1800", "29:59", "29:58", "29:57"]]) {
      if (preset !== "0") await page.locator("#readerTimerPreset").selectOption(preset);
      await page.clock.runFor(1250);
      await page.locator("#readerTimerPause").click();
      await expect(page.locator("#readerTimer")).toHaveText(first);
      await page.clock.runFor(10_000);
      await expect(page.locator("#readerTimer")).toHaveText(first);
      for (let cycle = 0; cycle < 6; cycle++) {
        await page.locator("#readerTimerPause").click();
        await page.clock.runFor(125);
        await page.locator("#readerTimerPause").click();
        await page.clock.runFor(1000);
      }
      await expect(page.locator("#readerTimer")).toHaveText(second);
      await expect(page.locator("#readerTimerPause")).toHaveAttribute("aria-label", "Resume timer");
      await page.locator("#readerTimerPause").click();
      await page.clock.runFor(1000);
      await expect(page.locator("#readerTimer")).toHaveText(third);
      await expect(page.locator("#readerTimer")).toHaveAttribute("data-state", "running");
    }
  });

  test("timer: closing the reader pauses the session; it survives reopening", async ({ page }) => {
    test.setTimeout(90_000);
    const card = await openPaper(page, r2Paper.title);
    await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await freezeTimerClock(page);
    await page.locator("#readerTimerBtn").click();
    await page.clock.runFor(2500);
    await page.keyboard.press("Escape");
    await expect(page.locator("#reader")).toBeHidden();
    await page.clock.runFor(10_000);
    await expect(page.locator("#readerTimer")).toHaveText("00:02");
    await card.locator("[data-read]").click();
    await expect(page.locator("#reader")).toBeVisible();
    await expect(page.locator("#readerTimer")).toBeVisible();
    await expect(page.locator("#readerTimer")).toHaveAttribute("data-state", "paused");
    await expect(page.locator("#readerTimerPause")).toHaveAttribute("aria-label", "Resume timer");
    await page.clock.runFor(10_000);
    await expect(page.locator("#readerTimer")).toHaveText("00:02");
    await page.locator("#readerTimerPause").click();
    await page.clock.runFor(500);
    await expect(page.locator("#readerTimer")).toHaveText("00:03");
  });

  test("timer: custom countdown finishes once, stays at zero and can restart", async ({ page }) => {
    test.setTimeout(90_000);
    await openPaper(page, r2Paper.title);
    await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await freezeTimerClock(page);
    await page.locator("#readerTimerBtn").click();
    await page.locator("#readerTimerPreset").selectOption("custom");
    await page.locator("#readerTimerCustom").fill("1");
    await page.locator("#readerTimerStart").click();
    await page.clock.runFor(1250);
    await page.locator("#readerTimerPause").click();
    await page.clock.runFor(10_000);
    await expect(page.locator("#readerTimer")).toHaveText("00:59");
    await page.locator("#readerTimerPause").click();
    await page.clock.runFor(58_750);
    await expect(page.locator("#readerTimer")).toHaveText("00:00");
    await expect(page.locator("#readerTimer")).toHaveAttribute("data-state", "finished");
    await expect(page.locator("#readerTimer")).toHaveClass(/done/);
    await expect(page.locator("#readerTimerPause")).toBeHidden();
    await page.clock.runFor(60_000);
    await expect(page.locator("#readerTimer")).toHaveText("00:00");
    await page.locator("#readerTimerStart").click();
    await expect(page.locator("#readerTimer")).toHaveText("01:00");
    await expect(page.locator("#readerTimer")).toHaveAttribute("data-state", "running");
    await expect(page.locator("#readerTimerPause")).toBeVisible();
  });

  test("timer: pause and resume icons stay centered in light/dark and narrow toolbars", async ({ page }) => {
    test.setTimeout(90_000);
    await openPaper(page, r2Paper.title);
    await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await freezeTimerClock(page);
    for (const theme of ["light", "dark"]) {
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
        await page.locator("#readerTimerBtn").click();
        await checkTimerIconAlignment(page, "pause");
        await page.locator("#readerTimerPause").click();
        await checkTimerIconAlignment(page, "resume");
        await page.locator("#readerTimerPause").click();
        await checkTimerIconAlignment(page, "pause");
        await page.locator("#readerTimerBtn").click();
      }
    }
  });
});
