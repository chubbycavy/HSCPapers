const { test, expect } = require("@playwright/test");
function pdf(text) {
  const stream = `BT /F1 18 Tf 40 150 Td (${text}) Tj ET`;
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let body = "%PDF-1.4\n", offsets = [0];
  objects.forEach((o,i) => { offsets.push(Buffer.byteLength(body)); body += `${i+1} 0 obj\n${o}\nendobj\n`; });
  const start = Buffer.byteLength(body); body += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => String(n).padStart(10,"0")+" 00000 n \n").join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(body);
}
const bytes = pdf("Migrated THSC paper");
const record = { id: "migration-paper", subject: "Mathematics Advanced", school: "Example", year: 2025, level: "HSC", type: "trial", title: "2025 Example Mathematics Trial", url: "https://www.thsconline.net/s/v/5338/Example%202025", hasSolutions: false };
async function fixture(page, papers = [record], recoveryPapers = []) {
  await page.route("**/data/papers-v2.json**", route => route.fulfill({ json: { dataVersion: 2, papers, recoveryPapers, idAliases: { "previous-paper": "migration-paper" } } }));
}
test("migrated descriptor stays in Slow route, opens in reader and downloads a real PDF", async ({ page }) => {
  await fixture(page);
  await page.route("**/proxy?**", route => {
    const u = new URL(route.request().url()); expect(u.searchParams.get("url")).toBe(record.url);
    return route.fulfill({ body: bytes, contentType: "application/pdf" });
  });
  await page.goto("/"); await expect(page.locator("#cards .card")).toHaveCount(0);
  await page.locator("#slowRoute").evaluate(el => el.click()); const card = page.locator('[data-id="migration-paper"]'); await expect(card).toBeVisible();
  await card.locator("[data-read]").click(); await expect(page.locator("#numPaper")).toContainText("1 / 1"); await expect(page.locator("#readerErr")).toBeHidden();
  await page.keyboard.press("Escape");
  const downloadPromise = page.waitForEvent("download"); await card.locator("a[data-dl]").first().click(); const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
});
test("archived shared IDs retain metadata/bookmarks without creating a download action", async ({ page }) => {
  const archived = { ...record, id: "archived", url: "", availability: { state: "unavailable", reason: "Awaiting replacement" }, libraryAliases: [record] };
  await fixture(page, [], [archived]);
  await page.goto("/?sel=archived"); await expect(page.locator("#recoveryPanel")).toHaveJSProperty("open", true);
  await expect(page.locator("#recoveryCards")).toContainText(record.title);
  await expect(page.locator("#recoveryCards a[download]")).toHaveCount(0);
  await page.getByRole("button", { name: "☆ Bookmark", exact: true }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("hsc-bookmarked")))).toContain("archived");
});
