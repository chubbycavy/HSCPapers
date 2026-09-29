/* Nuclear tier: the standalone demo-scroll.html (the MIT techniques demo
   linked from READER-TECHNIQUES.md). Same lazy-render guarantees as the
   main reader must hold here too. */
const { test, expect } = require("@playwright/test");

test.describe("demo-scroll.html", () => {
  test("loads the default PDF, paints page 1, meta shows totals", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/demo-scroll.html");
    await expect(page.locator(".rpage.done").first()).toBeVisible({ timeout: 30_000 });
    const meta = await page.locator("#pageMeta").textContent();
    expect(meta).toMatch(/^page 1 \/ \d+ · \d+ rendered in memory$/);
  });

  test("deep scroll advances the counter and renders lazy pages", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/demo-scroll.html");
    await expect(page.locator(".rpage.done").first()).toBeVisible({ timeout: 30_000 });
    const total = parseInt(((await page.locator("#pageMeta").textContent()).match(/page 1 \/ (\d+)/) || [])[1], 10);
    await page.locator("#scroller").evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await expect.poll(async () => parseInt(((await page.locator("#pageMeta").textContent()).match(/page (\d+)/) || [])[1], 10), { timeout: 20_000 }).toBeGreaterThan(1);
    await expect(page.locator("#scroller .rpage.done").last()).toBeVisible({ timeout: 20_000 });
    // unload guard: on a long enough document, the first page gets swept
    test.skip(total < 8, "document too short to exercise the unload sweep");
    const firstStillRendered = await page.locator("#scroller .rpage").first().evaluate((el) => el.classList.contains("done"));
    expect(firstStillRendered).toBe(false);
  });

  test("keyboard jump works", async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto("/demo-scroll.html");
    await expect(page.locator(".rpage.done").first()).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press("ArrowRight");
    await expect.poll(async () => ((await page.locator("#pageMeta").textContent()).match(/page (\d+)/) || [])[1], { timeout: 10_000 }).toBe("2");
  });
});
