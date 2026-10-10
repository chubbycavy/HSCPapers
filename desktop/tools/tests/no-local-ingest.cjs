/* Preload for clean-input build checks: source-page caches remain available
   to --offline, but local acceptance/census/discovery output must never be read. */
const fs = require("fs");
const read = fs.readFileSync;
fs.readFileSync = function (file, ...args) {
  if (typeof file === "string" && /[\\/]\.cache[\\/](?:dedupe|census|discover)[\\/]/i.test(file)) {
    throw new Error("Build attempted to depend on local ingestion state: " + file);
  }
  return read.call(this, file, ...args);
};
