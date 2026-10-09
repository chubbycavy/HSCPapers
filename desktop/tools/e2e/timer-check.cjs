const assert = require("node:assert/strict");

async function freezeTimerClock(page) {
  const start = new Date("2026-10-09T12:00:00Z");
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 1000));
}

async function checkTimerToggleJourney(page) {
  await freezeTimerClock(page);
  await page.locator("#readerTimerBtn").click();
  assert.equal(await page.locator("#readerTimerPreset").inputValue(), "0");
  await page.clock.runFor(3000);
  assert.equal(await page.locator("#readerTimer").textContent(), "00:03");
  for (const [preset, full, ticked] of [["10800", "3:00:00", "2:59:59"], ["custom", "02:00", "01:59"], ["0", "00:00", "00:01"]]) {
    assert.equal(await page.locator("#panePaper").evaluate((el) => getComputedStyle(el, "::before").boxShadow), "none");
    await page.locator("#readerTimerPreset").selectOption(preset);
    if (preset === "custom") {
      assert.equal(await page.locator("#readerTimer").getAttribute("data-state"), "setup");
      assert.equal(await page.locator("#readerTimerPause").isVisible(), false);
      await page.clock.runFor(3000);
      assert.equal(await page.locator("#readerTimer").textContent(), "00:00");
      await page.locator("#readerTimerCustom").fill("2");
      await page.locator("#readerTimerStart").click();
    }
    assert.equal(await page.locator("#readerTimer").textContent(), full);
    await checkTimerIconAlignment(page, "pause");
    await page.clock.runFor(1000);
    assert.equal(await page.locator("#readerTimer").textContent(), ticked);
    await page.locator("#readerTimerBtn").click();
    for (const id of ["readerTimer", "readerTimerPreset", "readerTimerPause", "readerTimerCustomWrap", "readerTimerStart"]) {
      assert.equal(await page.locator(`#${id}`).isVisible(), false, `${id} must hide on dismiss`);
    }
    assert.equal(await page.locator("#readerTimerPreset").inputValue(), preset);
    await page.clock.runFor(5000);
    assert.equal(await page.locator("#readerTimer").textContent(), "00:00");
    await page.locator("#readerTimerBtn").click();
    assert.equal(await page.locator("#readerTimerPreset").inputValue(), preset);
    assert.equal(await page.locator("#readerTimer").textContent(), full);
    assert.equal(await page.locator("#readerTimer").getAttribute("data-state"), "running");
    if (preset === "custom") assert.equal(await page.locator("#readerTimerCustom").inputValue(), "2");
    await page.clock.runFor(1000);
    assert.equal(await page.locator("#readerTimer").textContent(), ticked);
  }
  await page.locator("#readerTimerBtn").click();
}

async function checkTimerReloadJourney(page, reopenReader) {
  await page.locator("#readerTimerBtn").click();
  for (const [preset, full] of [["10800", "3:00:00"], ["custom", "1:15:00"], ["0", "00:00"]]) {
    await page.locator("#readerTimerPreset").selectOption(preset);
    if (preset === "custom") {
      await page.locator("#readerTimerCustom").fill("75");
      await page.locator("#readerTimerStart").click();
    }
    await page.clock.runFor(3000);
    await page.locator("#readerTimerPause").click();
    await checkTimerIconAlignment(page, "resume");
    await page.reload({ waitUntil: "load", timeout: 60_000 });
    await reopenReader();
    assert.equal(await page.locator("#readerTimer").isVisible(), false);
    await page.locator("#readerTimerBtn").click();
    assert.equal(await page.locator("#readerTimerPreset").inputValue(), preset);
    assert.equal(await page.locator("#readerTimer").textContent(), full);
    assert.equal(await page.locator("#readerTimer").getAttribute("data-state"), "running");
    await checkTimerIconAlignment(page, "pause");
    if (preset === "custom") {
      assert.equal(await page.locator("#readerTimerCustom").inputValue(), "75");
      await page.locator("#readerTimerCustom").fill("120");
      await page.locator("#readerTimerBtn").click();
      await page.locator("#readerTimerBtn").click();
      assert.equal(await page.locator("#readerTimerCustom").inputValue(), "75", "unstarted drafts must not replace the saved duration");
      assert.equal(await page.locator("#readerTimer").textContent(), full);
    }
  }
  await page.locator("#readerTimerBtn").click();
}

async function checkTimerIconAlignment(page, action) {
  assert.ok(["pause", "resume"].includes(action), "expected timer action must be explicit");
  const expectedIcon = action === "resume" ? "readerTimerResumeIcon" : "readerTimerPauseIcon";
  const otherIcon = action === "resume" ? "readerTimerPauseIcon" : "readerTimerResumeIcon";
  assert.equal(await page.locator(`#${expectedIcon}`).isVisible(), true, `${action} icon must be visible`);
  assert.equal(await page.locator(`#${otherIcon}`).isVisible(), false, "the other timer icon must be hidden");
  assert.equal(await page.locator("#readerTimerPause").getAttribute("aria-label"), action === "resume" ? "Resume timer" : "Pause timer");
  const button = await page.locator("#readerTimerPause").boundingBox();
  const icon = await page.locator(`#${expectedIcon}`).boundingBox();
  assert.ok(button && icon, "timer control and its SVG must be visible");
  assert.equal(await page.locator("#readerTimerPause svg:not([hidden])").count(), 1);
  assert.equal(button.width, 32);
  assert.equal(button.height, 32);
  assert.equal(icon.width, 16);
  assert.equal(icon.height, 16);
  assert.ok(Math.abs(button.x + button.width / 2 - icon.x - icon.width / 2) <= 0.5, "timer icon must be horizontally centered");
  assert.ok(Math.abs(button.y + button.height / 2 - icon.y - icon.height / 2) <= 0.5, "timer icon must be vertically centered");
}

module.exports = { freezeTimerClock, checkTimerToggleJourney, checkTimerReloadJourney, checkTimerIconAlignment };
