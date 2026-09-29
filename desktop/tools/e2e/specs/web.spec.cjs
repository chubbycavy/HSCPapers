/* Nuclear web tier: catalogue render, search/facets, share round-trip,
   shelf (bookmarks), compact/theme, star-tag overlap, coverage tooltips.
   App-readiness convention: always wait for the first card render before
   interacting (app.js wires listeners during its async load()). */
const { test, expect } = require("@playwright/test");
const { papers, solPaper, noSolPaper } = require("../helpers.cjs");

const ready = async (page) => {
  await page.goto("/");
  await page.waitForSelector("#cards .card", { timeout: 30_000 });
};

test.describe("catalogue", () => {
  test("renders with internally consistent counts", async ({ page }) => {
    await ready(page);
    const stat = parseInt(await page.locator("#statPapers").textContent(), 10);
    const shown = parseInt((await page.locator("#resultsCount").textContent()).match(/^([\d,]+) papers/)[1].replace(/,/g, ""), 10);
    expect(stat).toBeGreaterThan(0);
    expect(stat).toBeLessThanOrEqual(papers.length);
    expect(shown).toBe(stat); // no filters: grid count == stats row
  });

  test("search narrows the view", async ({ page }) => {
    await ready(page);
    await page.fill("#q", "penrith mathematics 2018");
    await page.locator("#searchForm button[type=submit]").click();
    const n = parseInt((await page.locator("#resultsCount").textContent()).match(/^([\d,]+) papers/)[1].replace(/,/g, ""), 10);
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThan(papers.length);
    expect(await page.locator("#cards .card").count()).toBe(Math.min(n, 120));
  });

  test("facets recount and chips appear", async ({ page }) => {
    await ready(page);
    await page.locator("#panelSubject summary").click(); // details is closed by default
    const before = await page.locator("#resultsCount").textContent();
    await page.locator("#subjectList .check input").first().check();
    await expect(page.locator("#chipsRow .chip").first()).toBeVisible();
    const after = await page.locator("#resultsCount").textContent();
    expect(after).not.toBe(before);
  });

  test("stacked filters keep both pills lit (solutions-only + type)", async ({ page }) => {
    await ready(page);
    await page.locator('#typePills [data-type="solutions"]').click();
    await page.locator('#typePills [data-type="trial"]').click();
    await expect(page.locator('#typePills [data-type="trial"]')).toHaveClass(/on/);
    await expect(page.locator('#typePills [data-type="solutions"]')).toHaveClass(/on/);
    // the sidebar Type segment agrees
    await expect(page.locator('#typeSeg [data-type="trial"]')).toHaveClass(/on/);
    // the all-pill stays unlit (restrictions are active)
    await expect(page.locator('#typePills [data-type="all"]')).not.toHaveClass(/on/);
  });

  test("star/tag bounding boxes never overlap (B5 regression guard)", async ({ page }) => {
    await ready(page);
    const idx = await page.evaluate(() => {
      const cards = [...document.querySelectorAll("#cards .card")];
      for (let i = 0; i < cards.length; i++) {
        if (cards[i].querySelectorAll(".card-top .tag").length >= 2) return i;
      }
      return -1;
    });
    test.skip(idx < 0, "no tag-heavy card on the first page");
    const overlap = await page.evaluate((i) => {
      const card = document.querySelectorAll("#cards .card")[i];
      const star = card.querySelector(".star-btn").getBoundingClientRect();
      for (const t of card.querySelectorAll(".card-top .tag")) {
        const r = t.getBoundingClientRect();
        const ix = Math.max(0, Math.min(star.right, r.right) - Math.max(star.left, r.left));
        const iy = Math.max(0, Math.min(star.bottom, r.bottom) - Math.max(star.top, r.top));
        if (ix > 1 && iy > 1) return true;
      }
      return false;
    }, idx);
    expect(overlap).toBe(false);
  });
});

test.describe("share round-trip", () => {
  test("share link restores the exact selection", async ({ browser }) => {
    const ctx = await browser.newContext();
    await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:8000" });
    const page = await ctx.newPage();
    await ready(page);
    await page.locator("#cards .card input[type=checkbox]").nth(0).check();
    await page.locator("#cards .card input[type=checkbox]").nth(1).check();
    await page.locator("#shareBtn").click();
    await expect(page.locator("#zipProgress")).toContainText("Share link copied");
    const link = await page.evaluate(() => navigator.clipboard.readText());
    const sel = new URL(link).searchParams.get("sel");
    expect(sel).toBeTruthy();
    await page.goto(`/?sel=${encodeURIComponent(sel)}`);
    await page.waitForSelector("#cards .card", { timeout: 30_000 });
    await expect(page.locator("#bulkbar")).toContainText("2 paper");
    await ctx.close();
  });
});

test.describe("shelf (F2)", () => {
  test("empty shelf honest state; a star fills the shelf; star is not select", async ({ page }) => {
    await ready(page);
    const pill = page.locator('#typePills [data-type="mine"]');
    await pill.scrollIntoViewIfNeeded();
    await pill.click();
    await expect(page.locator(".empty")).toContainText("Nothing on your shelf yet");
    // back to the full view, star a paper, then the shelf shows it
    await page.locator('#typePills [data-type="all"]').click();
    await page.waitForSelector("#cards .card", { timeout: 20_000 });
    await page.locator("#cards .card .star-btn").first().click();
    await expect(page.locator("#bulkbar")).not.toHaveClass(/show/); // star is not select
    await pill.click();
    await expect(page.locator("#cards .card").first()).toBeVisible();
  });
});

test.describe("chrome", () => {
  test("compact density changes the grid", async ({ page }) => {
    await ready(page);
    const before = await page.locator(".grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    await page.locator("#densityBtn").click();
    await expect(page.locator("body")).toHaveClass(/compact/);
    const after = await page.locator(".grid").evaluate((el) => getComputedStyle(el).gridTemplateColumns);
    expect(after).not.toBe(before);
  });

  test("theme toggles", async ({ page }) => {
    await ready(page);
    const t0 = await page.locator("html").getAttribute("data-theme");
    await page.locator("#themeBtn").click();
    const t1 = await page.locator("html").getAttribute("data-theme");
    expect(t1).not.toBe(t0);
  });

  test("coverage tooltips appear instantly on hover", async ({ page }) => {
    await page.goto("/coverage.html");
    const cell = page.locator("table.matrix td[data-label]").first();
    await cell.hover();
    await expect(page.locator("#covtip")).toBeVisible();
    await expect(page.locator("#covtip")).not.toHaveText("");
  });
});
