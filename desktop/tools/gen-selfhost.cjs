/* selfhost.json generator (Phase-2-lite).
 *
 * Builds the self-host registry from the last committed catalogue: every
 * PapersDB-origin entry becomes a metadata record { key, subject, year,
 * school, type, ... } whose bytes are hash-verified against the local
 * library. The builder then rewrites matching papers to R2 URLs (or adds
 * new entries for papers that exist nowhere else) at every rebuild — fully
 * independent of whether the PapersDB mirror is enabled.
 *
 * Reads the committed catalogue (git show HEAD:desktop/ui/data/papers.json)
 * so a mid-rebuild catalogue state can't corrupt the registry.
 *
 * Usage: node desktop/tools/gen-selfhost.cjs
 * Output: desktop/tools/selfhost.json  (committed — public URLs only)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

function hash6(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h.toString(36).padStart(10, "0").slice(0, 10);
}
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

let papers;
try {
  papers = JSON.parse(
    execSync("git show HEAD:desktop/ui/data/papers.json", {
      encoding: "utf8",
      cwd: path.resolve(__dirname, "..", ".."),
      maxBuffer: 64 * 1024 * 1024,
    }),
  ).papers;
  console.log("source: committed catalogue (git HEAD)");
} catch {
  papers = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ui", "data", "papers.json"), "utf8")).papers;
  console.log("source: working-tree catalogue");
}

const pdb = papers.filter((p) => /cdn\.papersdb\.org/.test(p.url || ""));
const LIBRARY = path.resolve(__dirname, "..", "..", "HSCPapersDatabase");

const entries = [];
let missing = 0;
let totalBytes = 0;
const missingList = [];
for (const p of pdb) {
  const file = `${p.year}-${slug(p.subject)}-${slug(p.school)}-paper-${hash6(p.url)}.pdf`;
  const key = `papers/${p.subject}/${p.year}/${file}`;
  const local = path.join(LIBRARY, String(p.subject), String(p.year), file);
  if (!fs.existsSync(local)) {
    missing++;
    missingList.push(local);
    continue;
  }
  totalBytes += fs.statSync(local).size;
  entries.push({
    key,
    url: p.url,
    subject: p.subject,
    level: p.level || undefined,
    year: p.year,
    school: p.school,
    type: p.type,
    hasSolutions: !!p.hasSolutions,
    fallbackUrl: p.fallbackUrl || "",
  });
}

fs.writeFileSync(
  path.join(__dirname, "selfhost.json"),
  JSON.stringify(
    {
      _doc:
        "Self-hosted remirror registry (Phase-2-lite, 2026-09-25): PapersDB-origin papers now served from our own R2 bucket. The builder matches these records by (subject, year, school, type) and rewrites/creates catalogue entries to the R2 URL at every rebuild — independent of any mirror's availability. New self-hosted papers: upload the file to the bucket + append a record here.",
      base: "https://pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev",
      entries,
    },
    null,
    1,
  ) + "\n",
);

console.log(
  `mapped: ${entries.length} of ${pdb.length} pdb URLs | missing: ${missing} | total: ${(totalBytes / 1048576).toFixed(1)} MB`,
);
if (missing) console.log(missingList.join("\n"));
