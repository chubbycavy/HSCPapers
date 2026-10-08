/* Compatibility entry point. logo.cjs owns all brand assets so rebuilding
 * PWA icons cannot silently replace them with a different legacy mark. */
"use strict";
const { build } = require("./logo.cjs");
module.exports = build;
if (require.main === module) {
  build().catch((err) => { console.error(`Icon build failed: ${err.message}`); process.exitCode = 1; });
}
