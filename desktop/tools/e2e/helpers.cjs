/* Shared E2E helpers: catalogue access + paper pickers (R2 politeness rule:
   reader tests must load bytes from OUR bucket, never third-party hosts). */
const fs = require("fs");
const path = require("path");

const papers = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "ui", "data", "papers.json"), "utf8")).papers;
const FAST = /hscportal\.pages\.dev|pub-ec23c9b69d2544938d816ad28ee491fd\.r2\.dev|www\.nsw\.gov\.au|www\.boardofstudies\.nsw\.edu\.au/;

module.exports = {
  papers,
  r2Paper: papers.find((p) => (p.url || "").startsWith("https://pub-ec23")),
  solPaper: papers.find((p) => p.hasSolutions && /^https:\/\/(pub-ec23|hscportal\.pages\.dev)/.test(p.solutionUrl || "")),
  noSolPaper: papers.find((p) => FAST.test(p.url || "") && !p.hasSolutions && !p.solutionUrl && !p.solutionPath),
  manyTagsPaper: papers.find((p) => p.hasSolutions && p.year >= 2019 && (p.url || "").startsWith("https://pub-ec23")) || papers.find((p) => p.hasSolutions),
};
