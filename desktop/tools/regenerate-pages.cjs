// UI-only static regeneration: use the existing reviewed feeds, no crawl.
// Preserve existing routes; source/catalogue maintenance owns retired-page pruning.
"use strict";
(async () => {
  await require("./coverage-report.cjs")();
  const result = await require("./landing-pages.cjs")({ pruneRetired: false });
  console.log("Regenerated existing-catalogue pages:", result);
})().catch(error => { console.error(error); process.exitCode = 1; });
