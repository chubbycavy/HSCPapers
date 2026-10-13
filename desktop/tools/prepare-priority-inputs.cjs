// Capture explicit published-ID continuity and reclassify audit dispositions.
// This does not upload any file or infer identical variants from school/year.
"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
globalThis.crypto ||= require("crypto").webcrypto;
const R = require("./catalogue-reconcile.cjs"), admission = require("./document-admission.cjs");
const tools = __dirname, dir = path.join(tools, ".cache/priority-audit");
const read = p => JSON.parse(fs.readFileSync(p, "utf8"));
const write = (p, j) => fs.writeFileSync(p, JSON.stringify(j, null, 1) + "\n");
const baseline = read(path.join(dir, "baseline.json")), state = read(path.join(dir, "state.json"));
const old = JSON.parse(execFileSync("git", ["show", "08f9c0a:desktop/ui/data/papers.json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
const renames = [
  ["thsc-5338-abbotsleigh-2022-w-sol", "thsc-5338-abbotsleigh-2022", "questions"],
  ["thsc-6528-north-sydney-girls-2023", "thsc-6528-north-sydney-girls-2023-w-sol", "combined"],
];
const identities = renames.map(([id, currentId, migratedRole]) => {
  const previous = old.papers.find(p => p.id === id), current = baseline.papers.find(p => p.id === currentId);
  if (!previous || !current) throw new Error("Missing rename evidence " + id);
  return { id, currentId, previous, current: R.legacyRecord(current), migratedRole,
    reason: "Reviewed same assessment covers/opening questions; different question/combined variants are preserved", source: "v1.0.26 published catalogue plus inspected migrated PDFs" };
});
const records = baseline.papers.map(p => ({ ...R.legacyRecord(p), level: p.level, hasSolutions: p.hasSolutions, source: p.source,
  viewno: p.viewno, linkText: p.linkText, examBlock: p.examBlock, sourceKeys: require("./catalogue-identity.cjs").listingKeys(p), alternateSources: p.alternateSources }));
write(path.join(tools, "catalogue-history.json"), { version: 1, identities, records, aliases: { ...baseline.idAliases, "add-thsc-au-growth-db836e142c": renames[0][0] } });
const corrections = {
  "add-acehsc-511ff93752": { fields: { subject: "English Advanced" }, reason: "Verified identical Advanced Paper 2 bytes and explicit document heading; original ACE subject was incorrect" },
  "portal-5228-abbotsleigh-2024": { fields: { school: "Abbotsleigh", type: "assessment", examBlock: "Assessment Task 3", solutionUrl: "", hasSolutions: false }, reason: "Verified Advanced Task 3 heading; detached unrelated Barker solutions" },
  "portal-5238-abbotsleigh-2024": { fields: { school: "Abbotsleigh", subject: "Mathematics Advanced", type: "assessment", examBlock: "Assessment Task 3", viewno: "5228", sourceKeys: ["5228|abbotsleigh 2024"], solutionUrl: "", hasSolutions: false, fallbackUrl: "" }, reason: "Published cross-list is an identical Advanced assessment, not an Extension 1 exam; detached unrelated half-yearly solutions" },
  "hsc-2017-mathematics-hsc-exam-paper": { fields: { url: "https://www.nsw.gov.au/sites/default/files/noindex/2025-05/2017-hsc-maths.pdf", viewno: "5320", linkText: "2017 HSC", sourceKeys: ["5320|2017 hsc"], fallbackUrl: "", documentRole: "questions" }, libraryRole: "solutions", reason: "Exact 2017 official exam bytes already verified; marking guidelines remain the separate solutions file" },
};
write(path.join(tools, "catalogue-metadata-corrections.json"), { version: 1, entries: corrections });
const exclusionIds = [
  "thsc-5320-2001-quick-answers", "thsc-5320-2002-quick-answers", "thsc-5320-2003-quick-answers", "thsc-5320-2004-quick-answers",
  "thsc-5310-2002-quick-answers", "thsc-5310-2003-quick-answers", "thsc-5310-2004-quick-answers",
  "hsc-2014-mathematics-general-2-specimen-exam-paper-worked-solutions", "thsc-5320-2009-jan-hansen-s-solutions",
  "thsc-5321-killara-2023-w-sol", "thsc-5328-killara-2023-w-sol"
];
const ownerExclusions = {};
for (const id of exclusionIds) {
  const p = baseline.papers.find(p => p.id === id); if (!p) continue;
  const e = state.entries[p.url];
  ownerExclusions[id] = { sha256: e?.sha256, reason: /killara/.test(id) ? "Cover identifies a 2022 task dated December 2022; advertised 2023 association requires publisher-supported review" : "Verified bytes contradict the advertised answers/specimen/provider document identity" };
}
write(path.join(tools, "catalogue-document-review.json"), { version: 1, entries: ownerExclusions });
let accessReview = 0;
for (const record of Object.values(state.entries)) {
  if (record.state === "invalid" && /HTTP (401|403)|incomplete PDF/i.test(record.reason || "")) {
    record.state = "review"; record.reason = "Access/integrity outcome needs revalidation, not a claim of an invalid paper: " + record.reason; accessReview++;
  }
}
for (const p of baseline.papers) {
  for (const [url, role] of [[p.url, "primary"], [p.solutionUrl, "solutions"]]) {
    const record = state.entries[url]; if (record?.state !== "verified") continue;
    const issue = admission.contextIssue(p, role, record.text, url); if (!issue) continue;
    record.rejectedOwners ||= [];
    if (!record.rejectedOwners.some(x => x.id === p.id && x.role === role)) record.rejectedOwners.push({ id: p.id, role, reason: issue });
  }
}
const drivePath = path.join(tools, "drive-verified.json"), drive = read(drivePath);
for (const row of Object.values(drive.entries)) {
  row.disposition = "review"; row.reviewReason = "Source collection is university MATH3202; NSW school subject/level/provider have not been established";
}
write(drivePath, drive);
const manifestPath = path.join(tools, "drive-upload-manifest.json"), manifest = read(manifestPath);
manifest.quarantinedUploads = [...(manifest.quarantinedUploads || []), ...manifest.uploads]; manifest.uploads = [];
write(manifestPath, manifest);
console.log(`Stored ${identities.length} explicit ID/variant histories; ${accessReview} access outcomes retained in review; Drive uploads quarantined`);
(async () => {
  const { pdfProof, readBounded } = await import("../ui/_lib/thsc-fragments.mjs");
  const pdfjs = require("../ui/pdfjs/pdf.min.js"); pdfjs.GlobalWorkerOptions.workerSrc = require.resolve("../ui/pdfjs/pdf.worker.min.js");
  for (const h of identities) {
    const url = h.previous.url; if (state.entries[url]?.state === "verified") continue;
    const response = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { "User-Agent": "HSCPapers/1.0 (published variant continuity)" } });
    if (!response.ok) throw new Error("Historical variant HTTP " + response.status);
    const bytes = await readBounded(response, 32 * 1024 * 1024), proof = await pdfProof(bytes);
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 });
    const doc = await task.promise, text = (await (await doc.getPage(1)).getTextContent()).items.map(x => x.str).join(" ");
    state.entries[url] = { state: "verified", ...proof, pages: doc.numPages, text, transport: "direct-pdf", at: new Date().toISOString() };
    await task.destroy();
  }
  write(path.join(dir, "state.json"), state);
})().catch(e => { console.error(e); process.exitCode = 1; });
