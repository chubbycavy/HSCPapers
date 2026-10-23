// Build the reviewed R2 intake manifest from the THSC growth review.
// Only new, B2-only records are eligible; duplicates and version conflicts are
// deliberately excluded.
"use strict";
const fs = require("fs");
const path = require("path");

const DESKTOP = path.resolve(__dirname, "..");
const CACHE = path.join(__dirname, ".cache", "growth");
const review = JSON.parse(fs.readFileSync(path.join(CACHE, "review.json"), "utf8"));
const selfhost = JSON.parse(fs.readFileSync(path.join(__dirname, "selfhost.json"), "utf8"));
const base = selfhost.base;
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";

const rows = review.rows
  .filter((r) => r.source === "thsc-feed" && r.disposition === "new" && r.r2Upload && r.proof?.file)
  .map((r) => {
    const key = `papers/${r.subject}/${r.year}/${r.year}-${slug(r.subject)}-${slug(r.school)}-paper-${r.proof.sha256.slice(0, 12)}.pdf`;
    const fallbackUrl = r.url;
    return {
      id: r.id,
      key,
      url: base + "/" + encodeURI(key),
      file: r.proof.file,
      sha256: r.proof.sha256,
      bytes: r.proof.bytes,
      pages: r.proof.pages,
      text: r.proof.text,
      subject: r.subject,
      level: r.level,
      year: r.year,
      school: r.school,
      type: r.type,
      title: r.title,
      linkText: r.linkText,
      viewno: r.viewno,
      hasSolutions: !!r.hasSolutions,
      fallbackUrl,
      sourceKeys: r.sourceKeys || [`${r.viewno}|${String(r.linkText || r.title).toLowerCase()}`],
      hints: r.hints || {},
      selfhost: {
        key, subject: r.subject, level: r.level, year: r.year, school: r.school,
        type: r.type, hasSolutions: !!r.hasSolutions, fallbackUrl, autoAdd: false,
      },
    };
  });

const manifest = {
  generated: new Date().toISOString(),
  bucket: "hscpapers-files",
  base,
  total: rows.length,
  bytes: rows.reduce((n, r) => n + r.bytes, 0),
  entries: rows,
};
fs.writeFileSync(path.join(CACHE, "thsc-r2-manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
console.log(JSON.stringify({ total: manifest.total, bytes: manifest.bytes, file: path.join(CACHE, "thsc-r2-manifest.json") }, null, 2));
