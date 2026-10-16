// One-time repair publication binding. Normal nightly growth resumes only after
// the exact reviewed candidate passes a fresh CI run and this receipt is committed.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical).sort((a, b) => { const x = JSON.stringify(a), y = JSON.stringify(b); return x < y ? -1 : x > y ? 1 : 0; });
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(k => !["generated", "_comment", "at", "checkedAt"].includes(k)).map(k => [k, canonical(value[k])]));
  return value;
}
function digest(modern, legacy) { return crypto.createHash("sha256").update(JSON.stringify(canonical({ modern, legacy }))).digest("hex"); }
function verify(manifest, modern, legacy) {
  if (manifest.state === "completed") return [];
  if (manifest.state !== "pending" || !/^[a-f0-9]{64}$/.test(manifest.sha256 || "")) return ["Invalid publication-review manifest"];
  return digest(modern, legacy) === manifest.sha256 ? [] : ["Fresh candidate differs from the reviewed repair publication; stop before commit and review the candidate artifact"];
}
module.exports = { canonical, digest, verify };
if (require.main === module) {
  const file = path.join(__dirname, "catalogue-publication-review.json");
  const modern = JSON.parse(fs.readFileSync(path.join(__dirname, "../ui/data/papers-v2.json"), "utf8"));
  const legacy = JSON.parse(fs.readFileSync(path.join(__dirname, "../ui/data/papers.json"), "utf8"));
  if (process.argv.includes("--record")) {
    const manifest = { version: 1, state: "pending", purpose: "Reviewed 2026-10-16 nightly admission repair", sha256: digest(modern, legacy), active: modern.papers.length, recovery: modern.recoveryPapers.length, aliases: Object.keys(modern.idAliases).length };
    fs.writeFileSync(file, JSON.stringify(manifest, null, 1) + "\n"); console.log("Recorded reviewed candidate", manifest);
  } else {
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")), errors = verify(manifest, modern, legacy);
    if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
    else if (process.argv.includes("--complete") && manifest.state === "pending") {
      fs.writeFileSync(file, JSON.stringify({ ...manifest, state: "completed", workflowRun: process.env.GITHUB_RUN_ID || null }, null, 1) + "\n"); console.log("Exact reviewed candidate verified; publication receipt completed");
    } else console.log(manifest.state === "completed" ? "Repair publication already completed; normal nightly admission enabled" : "Fresh candidate matches reviewed publication");
  }
}
