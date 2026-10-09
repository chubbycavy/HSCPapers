const assert = require("node:assert/strict");

async function freezeTimerClock(page) {
  const start = new Date("2026-10-09T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
}

async function checkTimerToggleJourney(page) {
  await freezeTimerClock(page);
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.locator("#readerTimerBtn").click();
    assert.equal(await page.locator("#readerTimerPreset").inputValue(), "0");
    assert.equal(await page.locator("#readerTimer").getAttribute("data-state"), "running");
    assert.equal(await page.locator("#readerTimer").textContent(), "00:00");
    await page.clock.runFor(3000);
    assert.equal(await page.locator("#readerTimer").textContent(), "00:03");
    assert.equal(await page.locator("#readerTimerPause").getAttribute("aria-label"), "Pause timer");
    assert.equal(await page.locator("#panePaper").evaluate((el) => getComputedStyle(el, "::before").boxShadow), "none");

    if (cycle === 0) {
      await page.locator("#readerTimerPreset").selectOption("1800");
      await page.clock.runFor(1000);
      assert.equal(await page.locator("#readerTimer").textContent(), "29:59");
    } else if (cycle === 1) {
      await page.locator("#readerTimerPreset").selectOption("custom");
      assert.equal(await page.locator("#readerTimer").getAttribute("data-state"), "setup");
      assert.equal(await page.locator("#readerTimerPause").isVisible(), false);
      await page.clock.runFor(3000);
      assert.equal(await page.locator("#readerTimer").textContent(), "00:00");
      await page.locator("#readerTimerCustom").fill("2");
      await page.locator("#readerTimerStart").click();
      await page.clock.runFor(1000);
      assert.equal(await page.locator("#readerTimer").textContent(), "01:59");
    }

    await page.locator("#readerTimerBtn").click();
    for (const id of ["readerTimer", "readerTimerPreset", "readerTimerPause", "readerTimerCustomWrap", "readerTimerStart"]) {
      assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} must hide on dismiss`);
    }
    assert.equal(await page.locator("#readerTimerPreset").inputValue(), "0");
    assert.equal(await page.locator("#readerTimerCustom").inputValue(), "");
    await page.clock.runFor(5000);
    assert.equal(await page.locator("#readerTimer").textContent(), "00:00");
  }
}

async function checkTimerIconAlignment(page) {
  const button = await page.locator("#readerTimerPause").boundingBox();
  const icon = await page.locator("#readerTimerPause svg:not([hidden])").boundingBox();
  assert.ok(button && icon, "timer control and its SVG must be visible");
  assert.equal(await page.locator("#readerTimerPause svg:not([hidden])").count(), 1);
  assert.equal(button.width, 32);
  assert.equal(button.height, 32);
  assert.equal(icon.width, 16);
  assert.equal(icon.height, 16);
  assert.ok(Math.abs(button.x + button.width / 2 - icon.x - icon.width / 2) <= 0.5, "timer icon must be horizontally centered");
  assert.ok(Math.abs(button.y + button.height / 2 - icon.y - icon.height / 2) <= 0.5, "timer icon must be vertically centered");
}

module.exports = { freezeTimerClock, checkTimerToggleJourney, checkTimerIconAlignment };
