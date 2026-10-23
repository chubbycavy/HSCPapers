// Security-only static regeneration: use the existing reviewed feeds, no crawl.
"use strict";
(async () => {
  await require("./coverage-report.cjs")();
  const result = await require("./landing-pages.cjs")();
  console.log("Regenerated existing-catalogue pages:", result);
})().catch(error => { console.error(error); process.exitCode = 1; });
