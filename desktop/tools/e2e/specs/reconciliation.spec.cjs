const { test, expect } = require("@playwright/test");
const catalogue = require("../../../ui/data/papers-v2.json");
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
test("unresolved bookmarks are preserved but do not create ghost cards", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("hsc-bookmarked", JSON.stringify(["pending-review-id"])));
  await page.goto("/"); await page.waitForSelector("#cards .card");
  await page.locator('#typePills [data-type="mine"]').click();
  await expect(page.locator("#cards .card")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("hsc-bookmarked")))).toEqual(["pending-review-id"]);
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
  await page.route("**/data/papers-v2.json**", route => route.fulfill({ json: catalogue }));
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

const publication = require("../../../tools/catalogue-publication-sync.json");
async function publicationLibrary(page, savedRel) {
  await page.route("**/data/papers-v2.json**", route => route.fulfill({ json: catalogue }));
  await page.route("**/existing-publication.pdf", route => route.fulfill({ body: require("../pdf-fixture.cjs")("Existing publication file"), contentType: "application/pdf" }));
  await page.addInitScript(savedRel => {
    window.downloadRequests = []; window.lookupPaths = [];
    window.__TAURI__ = {
      core: {
        convertFileSrc: () => location.origin + "/existing-publication.pdf",
        invoke: async (command, args) => {
          if (command === "saved_paths") { window.lookupPaths.push(...args.relpaths); return args.relpaths.map(r => r === savedRel ? "C:/fixture/existing.pdf" : null); }
          if (command === "get_library_config") return { library: "C:/fixture", is_default: true };
          if (command === "update_check") return { update_available: false };
          if (command === "download_paper") { window.downloadRequests.push(args); throw new Error("Existing file should not be downloaded again"); }
          return null;
        },
      }, event: { listen: async () => () => {} },
    };
  }, savedRel);
}
function synced(id) {
  const entry = publication.entries.find(e => e.published.id === id);
  const canonical = catalogue.idAliases[id] || id;
  return { entry, p: catalogue.papers.find(p => p.id === canonical) };
}
test("mirror promotion recognizes the fragment file saved with the tested installer", async ({ page }) => {
  const { entry, p } = synced("thsc-5222-normanhurst-boys-2025-w-sol");
  await publicationLibrary(page, oldLibraryRel(entry.previousCandidate));
  await page.goto(`/?q=${encodeURIComponent(`${p.school} ${p.subject} ${p.year}`)}`);
  await expect(page.locator(`[data-id="${p.id}"] a.go`)).toContainText("View");
  expect(await page.evaluate(() => window.downloadRequests)).toEqual([]);
});
test("latest public combined filename satisfies solutions but not the question-only primary", async ({ page }) => {
  const { entry, p } = synced("thsc-6528-north-sydney-girls-2023-w-sol");
  await publicationLibrary(page, oldLibraryRel(entry.published));
  await page.goto(`/?q=${encodeURIComponent(`${p.school} ${p.subject} ${p.year}`)}`);
  const card = page.locator(`[data-id="${p.id}"]`);
  await expect(card.locator("a.go")).toContainText("Paper");
  await expect(card.locator(".card-actions a").nth(1)).toContainText("View");
  expect(await page.evaluate(() => window.downloadRequests)).toEqual([]);
});
test("latest public questions-only filename opens its exact version without replacing the combined primary", async ({ page }) => {
  const { entry, p } = synced("thsc-5338-abbotsleigh-2022");
  const rel = oldLibraryRel(entry.published); await publicationLibrary(page, rel);
  await page.goto(`/?q=${encodeURIComponent(`${p.school} ${p.subject} ${p.year}`)}`);
  const card = page.locator(`[data-id="${p.id}"]`);
  await expect(card.locator("a.go")).toContainText("Paper");
  await card.locator("details summary").click(); await card.getByRole("button", { name: /Questions only/ }).click();
  await expect(page.locator("#panePaper .rpage.done").first()).toBeVisible();
  expect(await page.evaluate(() => window.lookupPaths)).toContain(rel);
  expect(await page.evaluate(() => window.downloadRequests)).toEqual([]);
});

const acceleratedGroups = require("../../../tools/catalogue-metadata-corrections.json").reviewedGroups;
for (const group of acceleratedGroups.filter(g => g.disposition !== "review-portal")) {
  test(`accelerated ${group.year}: old Advanced portal filename and mirror bookmark resolve to the reviewed owner`, async ({ page }) => {
    const p = catalogue.papers.find(p => p.id === group.canonicalId);
    expect(p.url).toBe(group.mirrorUrl);
    const saved = p.libraryAliases.find(a => a.subject === "Mathematics Advanced" && a.url === group.portalUrl && !a.variantOnly);
    expect(saved).toBeTruthy();
    await publicationLibrary(page, oldLibraryRel(saved));
    const mirrorId = "add-thsc-au-growth-" + group.sha256.slice(0, 10);
    await page.addInitScript(id => localStorage.setItem("hsc-bookmarked", JSON.stringify([id])), mirrorId);
    await page.goto(`/?q=${encodeURIComponent(`Sydney Boys Maths Accelerated ${group.year}`)}&sel=${encodeURIComponent(mirrorId)}`);
    await expect(page.locator(`[data-id="${p.id}"] a.go`)).toContainText("View");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("hsc-bookmarked")))).toEqual([p.id]);
    expect(await page.evaluate(() => window.downloadRequests)).toEqual([]);
  });
}
test("held 2016 portal file cannot satisfy the mirror primary's saved-file lookup", async ({ page }) => {
  const group = acceleratedGroups.find(g => g.year === 2016), p = catalogue.papers.find(p => p.id === group.canonicalId);
  const held = catalogue.recoveryPapers.find(p => p.id === group.portalIds[0]);
  expect(held.availability.state).toBe("review");
  expect(catalogue.idAliases[held.id]).toBeUndefined();
  await publicationLibrary(page, oldLibraryRel(held.libraryAliases.find(a => a.url === group.portalUrl)));
  await page.goto(`/?q=${encodeURIComponent("Sydney Boys Maths Accelerated 2016")}`);
  await expect(page.locator(`[data-id="${p.id}"] a.go`)).toContainText("Paper");
  await expect(page.locator(`.card[data-id="${held.id}"] a.go`)).toHaveCount(0);
});

for (const id of ["thsc-5276-sydney-boys-2005", "thsc-5226-sydney-boys-2005-w-sol"]) {
  test(`accelerated 2005 ${id}: corrected metadata retains the Advanced saved filename and published ID`, async ({ page }) => {
    const p = catalogue.papers.find(p => p.id === id);
    expect(p.subject).toBe("Maths (Accelerated)");
    const originalUrl = require("../../../tools/catalogue-metadata-corrections.json").entries[id].when.url;
    const saved = p.libraryAliases.find(a => a.subject === "Mathematics Advanced" && a.url === originalUrl && !a.variantOnly);
    expect(saved).toBeTruthy();
    await publicationLibrary(page, oldLibraryRel(saved));
    await page.goto(`/?q=${encodeURIComponent("Sydney Boys Maths Accelerated 2005")}&sel=${encodeURIComponent(id)}`);
    const card = page.locator(`[data-id="${id}"]`);
    await expect(card.locator("a.go")).toContainText("View");
    await expect(card.locator(".meta")).toContainText("Maths (Accelerated)");
    await expect(page.locator("#bulkbar")).toContainText("1 paper");
    expect(await page.evaluate(() => window.downloadRequests)).toEqual([]);
  });
}

test("a reviewed mirror representation cannot reuse the saved primary's different PDF bytes", async ({ page }) => {
  const p = catalogue.papers.find(p => p.fileVariants?.some(v => v.label === "Mirror PDF (same rendered content)"));
  expect(p).toBeTruthy();
  const v = p.fileVariants.find(v => v.label === "Mirror PDF (same rendered content)");
  expect(v.sha256).not.toBe(p.sha256);
  const savedRel = oldLibraryRel(p);
  await publicationLibrary(page, savedRel);
  await page.goto(`/?q=${encodeURIComponent(`${p.school} ${p.subject} ${p.year}`)}`);
  const card = page.locator(`[data-id="${p.id}"]`);
  await expect(card.locator("a.go")).toContainText("View");
  await card.locator("details summary").click();
  await card.getByRole("button", { name: /Mirror PDF \(same rendered content\)/ }).click();
  await expect.poll(() => page.evaluate(() => window.downloadRequests.length)).toBe(1);
  const jobs = await page.evaluate(() => window.downloadRequests);
  expect(jobs[0].url).toBe(v.url); expect(jobs[0].relpath).not.toBe(savedRel);
  expect(jobs[0].fallback).toBeNull();
});

const preferences = require("../../../tools/catalogue-imports.json").primaryPreferences || [];
const promotedCases = new Map();
for (const select of [p => !p.hasSolutions, p => p.hasSolutions, p => !!p.solutionUrl, p => p.fileVariants?.some(v => v.sha256 !== p.sha256), p => p.pages >= 60]) {
  const pref = preferences.find(b => select(catalogue.papers.find(p => p.id === b.id)));
  if (pref) promotedCases.set(pref.id, pref);
}
for (const pref of promotedCases.values()) test(`promoted mirror ${pref.id}: saved Portal file remains usable without a new download`, async ({ page }) => {
  const p = catalogue.papers.find(p => p.id === pref.id);
  expect(p.url).toBe(pref.preferredUrl); expect(p.fallbackUrl).toBe(pref.primaryUrl);
  await publicationLibrary(page, oldLibraryRel(pref.previousRecord));
  await page.goto(`/?q=${encodeURIComponent(`${p.school} ${p.subject} ${p.year}`)}&sel=${encodeURIComponent(p.id)}`);
  const card = page.locator(`[data-id="${p.id}"]`);
  await expect(card.locator("a.go")).toContainText("View");
  await expect(page.locator("#bulkbar")).toContainText("1 paper");
  expect(await page.evaluate(() => window.downloadRequests)).toEqual([]);
});
