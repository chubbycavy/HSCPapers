// Catalogue quality audit: solution-only records without a parent question and
// records with no usable school identity. Read-only; safe to run in CI.
"use strict";
const fs = require("fs");
const path = require("path");

const cataloguePath = path.join(__dirname, "../ui/data/papers-v2.json");
const candidatePath = path.join(__dirname, ".cache/growth/hscportal.candidates.json");
const withdrawalPath = path.join(__dirname, "catalogue-withdrawals.json");
const catalogue = JSON.parse(fs.readFileSync(cataloguePath, "utf8"));
const active = catalogue.papers || [];

const officialSolutions = (p) => p.school === "NESA" && p.type === "hsc";
const solutionOnly = active.filter((p) => p.documentRole === "solutions" && !officialSolutions(p));
const unknownSchool = active.filter((p) => /^unspecified(?:\s+school)?$/i.test(String(p.school || "").trim()));
let withdrawals = [];
try { withdrawals = JSON.parse(fs.readFileSync(withdrawalPath, "utf8")).entries || []; } catch { /* optional */ }

let sourceSolutions = [];
let sourceUnknown = [];
let sourceAvailable = false;
try {
  const source = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  sourceAvailable = true;
  const rows = source.candidates || [];
  sourceSolutions = rows.filter((r) => r.role === "solutions");
  sourceUnknown = rows.filter((r) => /^unspecified(?:\s+school)?$/i.test(String(r.school || "").trim()));
} catch { /* source snapshot not present */ }

const activeWithdrawalIds = new Set(active.map((p) => p.id));
const leakedWithdrawals = withdrawals.filter((w) => activeWithdrawalIds.has(w.id));

console.log(JSON.stringify({
  activePapers: active.length,
  activeSolutionOnly: solutionOnly.length,
  activeUnknownSchool: unknownSchool.length,
  withdrawals: withdrawals.length,
  leakedWithdrawals: leakedWithdrawals.length,
  sourceAvailable,
  sourceSolutionUploads: sourceSolutions.length,
  sourceUnknownSchool: sourceUnknown.length,
}, null, 2));

for (const p of solutionOnly) console.log("SOLUTION_ONLY", p.id, "|", p.school, "|", p.title);
for (const p of unknownSchool) console.log("UNKNOWN_SCHOOL", p.id, "|", p.title);
for (const p of leakedWithdrawals) console.log("WITHDRAWAL_ACTIVE", p.id);
if (sourceAvailable) {
  for (const r of sourceSolutions) console.log("SOURCE_SOLUTION", r.id, "|", r.school, "|", r.title);
  for (const r of sourceUnknown) console.log("SOURCE_UNKNOWN", r.id, "|", r.title);
}

if (solutionOnly.length || unknownSchool.length || leakedWithdrawals.length) process.exitCode = 1;
