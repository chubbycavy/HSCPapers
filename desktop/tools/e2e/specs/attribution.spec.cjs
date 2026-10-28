/* Source labels use actual file URLs, including fallbacks and explicit versions.
   All document bytes are local fixtures: these tests never fetch source PDFs. */
const { test, expect } = require("@playwright/test");
const pdf = require("../pdf-fixture.cjs")("Source attribution fixture");
const PORTAL = "https://hscportal.pages.dev/credit-";
const R2 = "https://pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev/credit-";
const NESA = "https://www.nsw.gov.au/credit-";
const row = (id, fields = {}) => ({ id, title: `2026 ${id} source fixture`, subject: "Physics", school: "Example", year: 2026, type: "trial", level: "HSC", url: PORTAL + id + ".pdf", hasSolutions: false, source: "thsc-listing", ...fields });
const records = [
  row("portal", { mirror: "selfhost" }),
  row("mixed", { hasSolutions: true, solutionUrl: R2 + "mixed-sol.pdf" }),
  row("official", { url: NESA + "official.pdf", mirror: "hscportal", source: "hscportal-unique" }),
  row("fallback", { fallbackUrl: R2 + "fallback.pdf", hasSolutions: true, solutionUrl: PORTAL + "fallback-sol.pdf", solFallbackUrl: NESA + "fallback-sol.pdf" }),
  row("variant", { fileVariants: [{ url: PORTAL + "variant.pdf", role: "questions", label: "Questions only", pages: 3 }, { url: NESA + "variant-combined.pdf", role: "combined", label: "Combined version", pages: 3 }] }),
];

test.beforeEach(async ({ page }) => {
  await page.route("**/data/papers-v2.json**", route => route.fulfill({ json: { dataVersion: 2, papers: records, recoveryPapers: [], idAliases: {} } }));
  await page.route(PORTAL + "*", route => /credit-fallback(?:-sol)?\.pdf$/.test(route.request().url())
    ? route.fulfill({ status: 410, body: "Unavailable" })
    : route.fulfill({ body: pdf, contentType: "application/pdf" }));
  await page.route(R2 + "*", route => route.fulfill({ body: pdf, contentType: "application/pdf" }));
  await page.route("**/proxy?**", route => route.fulfill({ body: pdf, contentType: "application/pdf" }));
  await page.goto("/");
  await page.waitForSelector("#cards .card");
});

test("browse credit explains catalogue/hosting and cards ignore stale source metadata", async ({ page }) => {
  await expect(page.locator(".hero .portal-credit")).toContainText("public paper catalogue and file links");
  await expect(page.locator(".hero .credit-visit")).toHaveAttribute("href", "https://www.hscportal.app/");
  await expect(page.locator('.card[data-id="portal"] .card-source')).toContainText("PDF hosted by HSC Portal");
  await expect(page.locator('.card[data-id="official"] .card-source')).toContainText("PDF hosted by NESA");
  await expect(page.locator('.card[data-id="official"] .card-source')).not.toContainText("HSC Portal");
  const mixed = page.locator('.card[data-id="mixed"] .card-source');
  await expect(mixed).toContainText("Paper hosted by HSC Portal");
  await expect(mixed).toContainText("Solutions hosted by HSCPapers");
  // An ordinary source-link click must navigate, not select the paper card.
  await page.context().route("https://www.hscportal.app/", route => route.fulfill({ contentType: "text/html", body: "<title>Source link fixture</title>" }));
  const popup = page.waitForEvent("popup");
  await page.locator('.card[data-id="portal"] .source-link').click();
  await (await popup).close();
  await expect(page.locator('.card[data-id="portal"] input[type="checkbox"]')).not.toBeChecked();
  await expect(page.locator("#sources")).toContainText("match file links to our index");
});

test("reader labels both documents independently and retains usable split panes on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.card[data-id="mixed"] [data-read]').click();
  await expect(page.locator("#paperSourceCredit")).toHaveText("Paper hosted by HSC Portal ↗");
  await page.locator("#readerAddSol").click();
  await expect(page.locator("#solSourceCredit")).toHaveText("Solutions hosted by HSCPapers ↗");
  await expect(page.locator("#scrollSol .rpage.done").first()).toBeVisible();
  for (const selector of ["#paperSourceCredit", "#solSourceCredit"]) {
    const box = await page.locator(selector).boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(844);
  }
  await page.keyboard.press("Escape");
  await expect(page.locator("#paperSourceCredit")).toBeHidden();
});

test("successful fallbacks replace reader credit without relabelling the preferred card source", async ({ page }) => {
  await page.locator('.card[data-id="fallback"] [data-read]').click();
  await expect(page.locator("#paperSourceCredit")).toHaveText("Paper hosted by HSCPapers ↗");
  await page.locator("#readerAddSol").click();
  await expect(page.locator("#solSourceCredit")).toHaveText("Solutions hosted by NESA ↗");
  await page.keyboard.press("Escape");
  await expect(page.locator('.card[data-id="fallback"] .card-source')).toContainText("PDFs hosted by HSC Portal");
  await page.locator('.card[data-id="official"] [data-read]').click();
  await expect(page.locator("#paperSourceCredit")).toHaveText("Paper hosted by NESA ↗");
});

test("explicit file versions get their own source credit", async ({ page }) => {
  const card = page.locator('.card[data-id="variant"]');
  await card.locator("summary").click();
  await card.getByRole("button", { name: "Combined version (3 pages)" }).click();
  await expect(page.locator("#paperSourceCredit")).toHaveText("Paper hosted by NESA ↗");
  await expect(card.locator(".card-source")).toContainText("PDF hosted by HSC Portal");
});

test("credit remains readable without horizontal overflow in light/dark mobile and compact views", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const theme of ["light", "dark"]) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator(".hero .portal-credit").scrollIntoViewIfNeeded();
    await expect(page.locator(".hero .credit-visit")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.locator("#densityBtn").click();
  await expect(page.locator('.card[data-id="portal"] .card-source')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto("/#sources");
  await page.waitForSelector("#cards .card");
  await expect.poll(() => page.evaluate(() => {
    const heading = document.querySelector("#sourcesTitle").getBoundingClientRect().top;
    const stickyBottom = document.querySelector(".strip-bar").getBoundingClientRect().bottom;
    return heading >= stickyBottom && heading < innerHeight;
  })).toBe(true);
});

test("subject landing pages retain generated host credits and an explanatory acknowledgement", async ({ page }) => {
  await page.goto("/subjects/chemistry/index.html");
  await expect(page.getByRole("region", { name: "HSC Portal acknowledgement" })).toContainText("public paper catalogue");
  const rows = page.locator("table.papers tbody tr");
  await expect(rows.first()).toBeVisible();
  expect(await page.locator("td.p-source .source-link", { hasText: "HSC Portal" }).count()).toBeGreaterThan(0);
  await expect(page.locator('footer a[href="/#sources"]')).toBeVisible();
});
