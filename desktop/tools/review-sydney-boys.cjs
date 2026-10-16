// Recheck only the fourteen reviewed files; no PDFs are retained on disk.
"use strict";
const fs = require("fs"), path = require("path");
async function main() {
  const groups = require("./catalogue-metadata-corrections.json").reviewedGroups;
  const file = path.join(__dirname, "catalogue-validation.json"), validation = JSON.parse(fs.readFileSync(file, "utf8"));
  const pdfjs = require("../ui/pdfjs/pdf.min.js"); pdfjs.GlobalWorkerOptions.workerSrc = require.resolve("../ui/pdfjs/pdf.worker.min.js");
  const { readBounded, pdfProof } = await import("../ui/_lib/thsc-fragments.mjs");
  const checked = [];
  for (const g of groups) for (const [url, expected] of [[g.mirrorUrl, g.sha256], [g.portalUrl, g.portalSha256 || g.sha256]]) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`${response.status}: ${url}`);
    const bytes = await readBounded(response, 32 * 1024 * 1024), proof = await pdfProof(bytes);
    if (proof.sha256 !== expected) throw new Error(`Reviewed source drift: ${url} ${proof.sha256}`);
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }), doc = await task.promise;
    const text = (await (await doc.getPage(1)).getTextContent()).items.map(x => x.str).join(" ").slice(0, 1400);
    checked.push([url, { state: "verified", ...proof, pages: doc.numPages, text, transport: "direct-pdf", at: new Date().toISOString() }]);
    console.log(`${g.year}: ${proof.bytes} bytes; ${doc.numPages} pages; SHA ${proof.sha256}; ${url === g.mirrorUrl ? "mirror" : "portal"}`);
    await task.destroy();
  }
  if (process.argv.includes("--record")) { for (const [url, proof] of checked) validation.entries[url] = proof; fs.writeFileSync(file, JSON.stringify(validation, null, 1) + "\n"); }
  console.log(`All ${checked.length} reviewed full-file hashes matched`);
}
if (require.main === module) main().catch(e => { console.error(e); process.exitCode = 1; });
