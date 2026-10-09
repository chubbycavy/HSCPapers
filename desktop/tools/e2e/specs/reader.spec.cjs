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

  test("timer: ⏱ dismiss then reopen shows a clean 00:00 (stale-start guard)", async ({ page }) => {
    test.setTimeout(90_000);
    await openPaper(page, r2Paper.title);
    await page.locator("#readerTimerBtn").click();
    await page.locator("#readerTimerPreset").selectOption("0"); // count up
    await expect(page.locator("#readerTimer")).toBeVisible();
    await expect.poll(async () => (await page.locator("#readerTimer").textContent()), { timeout: 10_000 }).not.toBe("00:00");
    await page.locator("#readerTimerBtn").click(); // dismiss
    await expect(page.locator("#readerTimerPause")).toBeHidden();
    await page.locator("#readerTimerBtn").click(); // reopen
    await expect(page.locator("#readerTimer")).toBeVisible();
    await expect(page.locator("#readerTimer")).toHaveText("00:00");
  });

  test("timer: pause freezes the count; resume continues from where it froze", async ({ page }) => {
    test.setTimeout(90_000);
    await openPaper(page, r2Paper.title);
    await page.locator("#readerTimerBtn").click();
    await page.locator("#readerTimerPreset").selectOption("0"); // count up
    await expect.poll(async () => (await page.locator("#readerTimer").textContent()), { timeout: 10_000 }).not.toBe("00:00");
    await page.locator("#readerTimerPause").click();
    await expect(page.locator("#readerTimerPause")).toHaveClass(/on/);
    // read AFTER pausing: while paused the display is genuinely stable — a
    // pre-pause read races the 500ms tick and snapshots the wrong second
    const frozen = await page.locator("#readerTimer").textContent();
    const frozenSec = frozen.split(":").reduce((a, t) => a * 60 + Number(t), 0);
    await page.waitForTimeout(1_400);
    expect(await page.locator("#readerTimer").textContent()).toBe(frozen);
    await page.locator("#readerTimerPause").click();
    await expect(page.locator("#readerTimerPause")).toHaveText("⏸");
    // the FIRST changed reading must sit one or two seconds past the
    // frozen value — a resume that restarts from zero dips below and fails
    let resumed = frozenSec;
    for (let i = 0; i < 20 && resumed === frozenSec; i++) {
      await page.waitForTimeout(300);
      resumed = (await page.locator("#readerTimer").textContent()).split(":").reduce((a, t) => a * 60 + Number(t), 0);
    }
    expect([frozenSec + 1, frozenSec + 2]).toContain(resumed);
  });

  test("timer: closing the reader pauses the session; it survives reopening", async ({ page }) => {
    test.setTimeout(90_000);
    const card = await openPaper(page, r2Paper.title);
    await page.locator("#readerTimerBtn").click();
    await page.locator("#readerTimerPreset").selectOption("0"); // count up
    await expect.poll(async () => (await page.locator("#readerTimer").textContent()), { timeout: 10_000 }).not.toBe("00:00");
    await page.keyboard.press("Escape"); // close the whole reader — session pauses
    await expect(page.locator("#reader")).toBeHidden();
    await page.waitForTimeout(1_400); // nothing keeps ticking while hidden
    // reopen via the SAME card (no page.goto — a navigation would start a
    // fresh app; the pause survives only within the page session)
    await card.locator("[data-read]").click();
    await expect(page.locator("#reader")).toBeVisible();
    await expect(page.locator("#readerTimer")).toBeVisible();
    const frozen = await page.locator("#readerTimer").textContent();
    const frozenSec = frozen.split(":").reduce((a, t) => a * 60 + Number(t), 0);
    await expect(page.locator("#readerTimerPause")).toHaveClass(/on/); // ▶ armed
    await page.locator("#readerTimerPause").click(); // resume
    await expect(page.locator("#readerTimerPause")).toHaveText("⏸");
    let resumed = frozenSec;
    for (let i = 0; i < 20 && resumed === frozenSec; i++) {
      await page.waitForTimeout(300);
      resumed = (await page.locator("#readerTimer").textContent()).split(":").reduce((a, t) => a * 60 + Number(t), 0);
    }
    expect([frozenSec + 1, frozenSec + 2]).toContain(resumed);
  });
});
