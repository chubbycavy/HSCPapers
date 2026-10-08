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

  test("reset recounts the level-seg counts (stale-count guard)", async ({ page }) => {
    await ready(page);
    await page.goto("/?subject=Chemistry");
    await page.waitForSelector("#cards .card", { timeout: 30_000 });
    const chem = parseInt((await page.locator("#resultsCount").textContent()).match(/^([\d,]+) papers/)[1].replace(/,/g, ""), 10);
    expect(chem).toBeGreaterThan(0);
    // the level counts are subject-faceted while the filter is on
    await expect(page.locator('#levelSeg button[data-level="all"]')).toContainText(String(chem));
    // reset the subject filter — every count surface must follow
    await page.locator("#panelSubject summary").click();
    await page.locator('[data-clear="subject"]').click();
    await page.waitForTimeout(600); // scheduleRender + the recounts
    const total = parseInt((await page.locator("#resultsCount").textContent()).match(/^([\d,]+) papers/)[1].replace(/,/g, ""), 10);
    expect(total).toBeGreaterThan(chem);
    // THE FIX: the level seg's counts recounted with the reset
    await expect(page.locator('#levelSeg button[data-level="all"]')).toContainText(String(total));
  });

  test("comma-bearing subject CTA filters correctly (PDHPE)", async ({ page }) => {
    await page.goto("/?subject=" + encodeURIComponent("Personal Development, Health and Physical Education"));
    await page.waitForSelector("#cards .card", { timeout: 30_000 });
    const n = parseInt((await page.locator("#resultsCount").textContent()).match(/^([\d,]+) papers/)[1].replace(/,/g, ""), 10);
    expect(n).toBeGreaterThan(0); // the comma-split produced 0 before the fix
    const chip = await page.locator("#chipsRow .chip span").first().textContent();
    expect(chip).toContain("Personal Development, Health");
    expect(await page.locator("#subjectList .check input:checked").count()).toBe(1);
    // the level filter works after a CTA arrival
    await page.locator('#levelSeg button[data-level="hsc"]').click();
    await page.waitForTimeout(500);
    const n2 = parseInt((await page.locator("#resultsCount").textContent()).match(/^([\d,]+) papers/)[1].replace(/,/g, ""), 10);
    expect(n2).toBeGreaterThan(0);
    expect(n2).toBeLessThanOrEqual(n);
    // the reload round-trip: the comma-bearing name survives writeURL→readURL
    await page.reload();
    await page.waitForSelector("#cards .card", { timeout: 30_000 });
    const n3 = parseInt((await page.locator("#resultsCount").textContent()).match(/^([\d,]+) papers/)[1].replace(/,/g, ""), 10);
    expect(n3).toBe(n2);
  });

  test("rapid filter toggling never desyncs state (Bug 2 race guard)", async ({ page }) => {
    await ready(page);
    await page.locator("#panelSubject summary").click();
    const subjInput = page.locator("#subjectList .check input").first();
    const label = page.locator("#subjectList .check").first();
    const value = await label.getAttribute("data-value");
    // rapid alternating toggles — clicks must always land on live elements
    for (let i = 0; i < 6; i++) {
      await subjInput.click();
      await page.locator('#typePills [data-type="mine"]').click();
      await page.locator('#typePills [data-type="all"]').click();
    }
    // after the storm: the last toggle ON must be reflected in state
    await subjInput.click();
    const chip = await page.locator("#chipsRow .chip span").first().textContent();
    expect(chip).toBe(value); // the exact subject is selected, once, correctly
    // the checkbox visual agrees with state
    await expect(subjInput).toBeChecked();
  });

  test("clear-all restores the slow-route default (B1: 🐢 toggle + selection pruned)", async ({ page }) => {
    const { slowPaper } = require("../helpers.cjs");
    test.skip(!slowPaper, "no slow-route papers in catalogue");
    await ready(page);
    // 1. 🐢 toggle FIRST: slow papers are hidden from the effective view,
    //    so the search for one is empty until slow-route is included
    await page.locator("#slowRoute").evaluate((el) => el.click());
    await page.waitForSelector("#cards .card", { timeout: 20_000 });
    // 2. bring the slow paper forward by search
    await page.fill("#q", slowPaper.title.slice(0, 40));
    await page.locator("#searchForm button[type=submit]").click();
    await page.waitForSelector("#cards .card", { timeout: 20_000 });
    const slowCard = page.locator(`#cards .card[data-id="${slowPaper.id}"]`);
    if (await slowCard.count() === 0) test.skip(true, "slow paper not surfaced by this search");
    await slowCard.locator('input[type="checkbox"]').check();
    expect(await page.locator("#bulkbar").getAttribute("class")).toMatch(/show/);
    // 2. chips >= 2 so the Clear-all chip renders
    await page.locator("#panelSubject summary").click();
    await page.locator("#subjectList .check input").first().check();
    expect(await page.locator("#chipsRow .chip").count()).toBeGreaterThanOrEqual(2);
    // 3. Clear all ✕
    await page.locator("#chipsRow .chip-all").click();
    // 4. 🐢 restored to default-off; the slow selection pruned (bulkbar
    //    collapses); no chips remain; the view = full default set
    const slowOff = await page.locator("#slowRoute").evaluate((el) => el.checked === false);
    expect(slowOff).toBe(true);
    await expect(page.locator("#bulkbar")).not.toHaveClass(/show/);
    await expect(page.locator("#chipsRow .chip")).toHaveCount(0);
    const results = parseInt((await page.locator("#resultsCount").textContent()).match(/^([\d,]+) papers/)[1].replace(/,/g, ""), 10);
    expect(results).toBe(parseInt(await page.locator("#statPapers").textContent(), 10));
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

  test("first visit follows the system color scheme (B3, no light-lock)", async ({ page, browser }) => {
    // dark system + clean storage → the pre-paint script resolves dark
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const p = await ctx.newPage();
    await p.goto("/");
    await p.waitForSelector("#cards .card", { timeout: 30_000 });
    expect(await p.locator("html").getAttribute("data-theme")).toBe("dark");
    await ctx.close();
    // light system + clean storage → light
    const ctx2 = await browser.newContext({ colorScheme: "light" });
    const p2 = await ctx2.newPage();
    await p2.goto("/");
    await p2.waitForSelector("#cards .card", { timeout: 30_000 });
    expect(await p2.locator("html").getAttribute("data-theme")).toBe("light");
    // manual override still persists over the system preference
    await p2.locator("#themeBtn").click();
    expect(await p2.locator("html").getAttribute("data-theme")).toBe("dark");
    await p2.reload();
    expect(await p2.locator("html").getAttribute("data-theme")).toBe("dark");
    await ctx2.close();
  });

  test("coverage tooltips appear instantly on hover", async ({ page }) => {
    await page.goto("/coverage.html");
    const cell = page.locator("table.matrix td[data-label]").first();
    await cell.hover();
    await expect(page.locator("#covtip")).toBeVisible();
    await expect(page.locator("#covtip")).not.toHaveText("");
  });

  test("dark-mode text contrast: zero elements below AA (B3.1 guard)", async ({ browser }) => {
    const ctx = await browser.newContext({ colorScheme: "dark" });
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto("/");
    await page.waitForSelector("#cards .card", { timeout: 30_000 });
    await page.waitForTimeout(800);
    const failures = await page.evaluate(() => {
      const lum = (r, g, b) => {
        const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const parse = (s) => {
        const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
        return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
      };
      const bgOf = (el) => {
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const c = parse(getComputedStyle(n).backgroundColor);
          if (c && c.a > 0.85) return c;
        }
        return { r: 14, g: 17, b: 22, a: 1 };
      };
      const relLum = (c) => lum(c.r, c.g, c.b);
      const ratio = (a, b) => (Math.max(relLum(a), relLum(b)) + 0.05) / (Math.min(relLum(a), relLum(b)) + 0.05);
      const out = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const seen = new Set();
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent.trim();
        if (!text) continue;
        const el = node.parentElement;
        if (!el || seen.has(el)) continue;
        seen.add(el);
        const st = getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden" || +st.opacity < 0.05) continue;
        if (st.backgroundClip === "text" || (st.webkitBackgroundClip || "").includes("text")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.bottom < 0 || rect.top > innerHeight) continue;
        const fg = parse(st.color);
        if (!fg) continue;
        const bg = bgOf(el);
        const cr = ratio(fg, bg);
        if (cr < 4.5) out.push({ cr: +cr.toFixed(2), text: text.slice(0, 40), cls: (el.className || "").toString().slice(0, 30) });
      }
      return out;
    });
    expect(failures, `sub-AA dark text: ${failures.map((f) => `${f.cr} "${f.text}"[${f.cls}]`).join(", ")}`).toHaveLength(0);
    await ctx.close();
  });
});
