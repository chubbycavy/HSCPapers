const { test, expect } = require("@playwright/test");
const catalogue = require("../../../ui/data/papers.json");
const pair = Object.entries(catalogue.idAliases || {}).find(([id, target]) => id.startsWith("add-thsc-au-growth-") && catalogue.papers.some(p => p.id === target && p.libraryAliases?.some(r => r.id === id)));
if (!pair) throw new Error("The duplicate regression fixture must exist in the generated catalogue");
const [oldId, canonicalId] = pair;
const paper = catalogue.papers.find(p => p.id === canonicalId);
const oldRecord = paper.libraryAliases.find(p => p.id === oldId);
const query = encodeURIComponent(`${paper.school} ${paper.subject} ${paper.year}`);
function oldLibraryRel(p) {
  const segment = s => String(s ?? "unsorted").replace(/[\\/:*?"<>|]/g, "-").trim() || "unsorted";
  const name = `${p.year ?? "na"}-${p.subject}-${p.school}-paper`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90);
  let hash = 0; for (let i = 0; i < p.url.length; i++) hash = (hash * 31 + p.url.charCodeAt(i)) >>> 0;
  return `${segment(p.subject)}/${p.year || "unknown"}/${name}-${hash.toString(36).padStart(10, "0").slice(0, 10)}.pdf`;
}
test("old and canonical shared IDs restore one selected card", async ({ page }) => {
  await page.goto(`/?q=${query}&sel=${encodeURIComponent(oldId + "," + canonicalId)}`);
  await page.waitForSelector("#cards .card");
  await expect(page.locator("#bulkbar")).toContainText("1 paper");
  await expect(page.locator(`.card[data-id="${oldId}"]`)).toHaveCount(0);
  await expect(page.locator(`.card[data-id="${canonicalId}"]`)).toHaveCount(1);
});
test("bookmarks on duplicate IDs migrate to one shelf entry", async ({ page }) => {
  await page.addInitScript(({ oldId, canonicalId }) => localStorage.setItem("hsc-bookmarked", JSON.stringify([oldId, canonicalId])), { oldId, canonicalId });
  await page.goto("/"); await page.waitForSelector("#cards .card");
  await page.locator('#typePills [data-type="mine"]').click();
  await expect(page.locator("#cards .card")).toHaveCount(1);
  await expect(page.locator(`.card[data-id="${canonicalId}"]`)).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("hsc-bookmarked")))).toEqual([canonicalId]);
});
test("the shared English Paper 1 has one card under either course filter", async ({ page }) => {
  const common = catalogue.papers.find(p => p.relatedSubjects?.includes("English Standard") && p.relatedSubjects.includes("English Advanced"));
  if (!common) throw new Error("A shared Paper-1 regression fixture is required");
  for (const subject of ["English Standard", "English Advanced"]) {
    await page.goto(`/?subject=${encodeURIComponent(subject)}&q=${common.year}`);
    await page.waitForSelector("#cards .card");
    await expect(page.locator(`.card[data-id="${common.id}"]`)).toHaveCount(1);
  }
});
test("desktop recognizes the file saved under the duplicate mirror's old path", async ({ page }) => {
  const legacyRel = oldLibraryRel(oldRecord);
  await page.route("**/data/papers.json**", route => route.fulfill({ json: catalogue }));
  await page.addInitScript(({ legacyRel }) => {
    window.__TAURI__ = {
      core: { invoke: async (command, args) => {
        if (command === "saved_paths") return args.relpaths.map(p => p === legacyRel ? "C:/test-library/legacy.pdf" : null);
        if (command === "get_library_config") return { library: "C:/test-library", is_default: true };
        if (command === "update_check") return { update_available: false };
        if (command === "preflight") {
          window.checkedPreflightPaths = args.files.map(f => f.relpath);
          return { to_fetch: args.files.some(f => f.relpath !== legacyRel) ? 1 : 0, saved_bytes: 100, est_bytes: 0, sampled: 0 };
        }
        return null;
      } },
      event: { listen: async () => () => {} },
    };
  }, { legacyRel });
  await page.goto(`/?q=${query}&sel=${encodeURIComponent(oldId)}`);
  const card = page.locator(`.card[data-id="${canonicalId}"]`);
  await expect(card).toBeVisible();
  await expect(card.locator('a[data-rel]').filter({ hasText: "View" })).toHaveCount(1);
  await page.locator("#zipBtn").click();
  await expect(page.locator("#zipProgress")).toContainText("already on disk");
  expect(await page.evaluate(() => window.checkedPreflightPaths)).toContain(legacyRel);
});
