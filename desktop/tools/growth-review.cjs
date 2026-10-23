// Reviewed growth classification: normalizes feed metadata and classifies each
// verified candidate against the published catalogue. It never writes imports.
"use strict";
const fs = require("fs");
const path = require("path");
const I = require("./catalogue-identity.cjs");

const DESKTOP = path.resolve(__dirname, "..");
const CACHE = path.join(__dirname, ".cache", "growth");
const CATALOGUE = path.join(DESKTOP, "ui", "data", "papers-v2.json");
const candidates = [
  ...(JSON.parse(fs.readFileSync(path.join(CACHE, "hscportal.candidates.json"), "utf8")).candidates || []),
  ...(JSON.parse(fs.readFileSync(path.join(CACHE, "thsc-feed.candidates.json"), "utf8")).candidates || []),
];
const catalogue = JSON.parse(fs.readFileSync(CATALOGUE, "utf8"));
const existing = [...(catalogue.papers || []), ...(catalogue.recoveryPapers || [])];

const norm = (s) => String(s || "").toLowerCase().replace(/&amp;/gi, "&").replace(/[^a-z0-9]+/g, " ").trim();
const yearOf = (s) => { const m = String(s || "").match(/\b((?:19|20)\d{2})\b/); return m ? Number(m[1]) : null; };
const typeLabel = (t) => t === "trial" ? "Trial" : t === "hsc" ? "HSC" : "Assessment";

function normalize(c) {
  const out = { ...c };
  const file = c.proof?.metadata?.originalFileName || c.hints?.cf || "";
  const f = String(file);
  if (c.viewno === "5098" || /year\s*9/i.test(f)) { out.subject = "Mathematics"; out.level = "Year 9"; }
  else if (c.viewno === "5108" || /year\s*10/i.test(f)) { out.subject = "Mathematics"; out.level = "Year 10"; }
  if (out.level === "Year 9" || out.level === "Year 10") out.type = "assessment";
  if (/prelim/i.test(f)) out.level = "Preliminary";
  if (/trials?/i.test(f)) out.type = "trial";
  else if (/\b(?:CT|PT)\d+\b|yearly|prelim|half[- ]?year|task|assessment/i.test(f)) out.type = "assessment";
  if (out.type === "other" && /hsc/i.test(f) && !/prelim/i.test(f)) out.type = "hsc";
  const role = c.role || (/(?:&\s*solutions|w\.\s*sol)/i.test(c.title || "") ? "combined" : /solutions/i.test(c.title || "") ? "solutions" : "questions");
  out.role = role;
  out.documentRole = role === "combined" ? "combined" : role;
  out.hasSolutions = c.hasSolutions ?? role !== "questions";
  out.solutionOnly = role === "solutions";
  const preserveSourceTitle = /solutions?|feedback|marking guidelines|task|test|trial|assessment/i.test(out.title || "");
  if ((out.level === "Year 9" || out.level === "Year 10") && !preserveSourceTitle) {
    out.title = `${out.year || ""} ${out.school || ""} Mathematics ${out.level} Yearly`.replace(/\s+/g, " ").trim();
  } else if (out.subject === "Miscellaneous" && out.type === "other") {
    out.title = `${out.year || ""} ${out.school || ""} ${out.subject} ${typeLabel(out.type)}`.replace(/\s+/g, " ").trim();
  }
  return out;
}

const shaMap = new Map();
const rkMap = new Map();
for (const p of existing) {
  if (p.sha256) {
    if (!shaMap.has(p.sha256)) shaMap.set(p.sha256, []);
    shaMap.get(p.sha256).push(p);
  }
  const rk = I.reviewKey(p);
  if (!rkMap.has(rk)) rkMap.set(rk, []);
  rkMap.get(rk).push(p);
}

const rows = candidates.map((original) => {
  const c = normalize(original);
  const shaMatches = c.proof?.sha256 ? (shaMap.get(c.proof.sha256) || []) : [];
  const rk = I.reviewKey(c);
  const rkMatches = rkMap.get(rk) || [];
  let disposition = "new";
  if (shaMatches.length && rkMatches.length) disposition = "duplicate";
  else if (shaMatches.length) disposition = "hold-sha-context";
  else if (rkMatches.length) disposition = "version-review";
  const matched = [...new Set([...shaMatches, ...rkMatches].map((p) => p.id))];
  return { ...c, reviewKey: rk, disposition, matchedIds: matched };
});

const counts = {};
for (const r of rows) {
  const k = `${r.source}:${r.disposition}`;
  counts[k] = (counts[k] || 0) + 1;
}
const out = { generated: new Date().toISOString(), counts, rows };
fs.mkdirSync(CACHE, { recursive: true });
const file = path.join(CACHE, "review.json");
fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");
console.log(JSON.stringify({ counts, file }, null, 2));
console.log("--- duplicate/version/hold ---");
for (const r of rows.filter((x) => x.disposition !== "new")) {
  console.log([r.source, r.disposition, r.id, "=>", r.matchedIds.slice(0, 4).join(",")].join(" | "));
}
