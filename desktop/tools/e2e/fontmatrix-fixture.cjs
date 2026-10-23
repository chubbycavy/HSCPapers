// In-memory defensive regression derived from Codean Labs' published CVE PoC.
// Its font stays in memory; replace the original alert with a harmless marker.
// Do not serve the upstream document or execute it against an unpatched engine.
"use strict";
let ready;
module.exports = () => ready ||= (async () => {
  const source = "https://raw.githubusercontent.com/codean-labs/pocs/2d5764208dc7f30db744aea14f6a1b31e1ef1e0b/CVE-2024-4367%20(PDF.js)/poc_plaintext.pdf";
  const response = await fetch(source, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error("CVE fixture HTTP " + response.status);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (require("crypto").createHash("sha256").update(bytes).digest("hex") !== "aafcfd866c4b190aebe39453607eae41619ed15d52e00e26044eeb1d373b050b") throw new Error("CVE fixture source changed");
  const original = bytes.toString("latin1");
  const text = original.replace(/\/FontMatrix\s*\[[^\]]*\]/, "/FontMatrix [1 2 3 4 5 (1\\);globalThis.__hscFontMatrixExecuted=true;//)]");
  if (text === original || text.includes("window.origin") || text.includes("PDFViewerApplication.url")) throw new Error("Fixture payload was not safely replaced");
  const objects = [...text.matchAll(/(?:^|\n)(\d+) 0 obj\s*\n([\s\S]*?)\nendobj/g)].map(m => [Number(m[1]), m[2]]);
  if (objects.length !== 7) throw new Error("Unexpected CVE fixture structure");
  let pdf = "%PDF-1.7\n", offsets = new Map();
  for (const [id, object] of objects) { offsets.set(id, Buffer.byteLength(pdf, "latin1")); pdf += `${id} 0 obj\n${object}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf, "latin1"), count = Math.max(...offsets.keys()) + 1;
  pdf += `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let id = 1; id < count; id++) pdf += offsets.has(id) ? `${String(offsets.get(id)).padStart(10, "0")} 00000 n \n` : "0000000000 00000 f \n";
  pdf += `trailer\n<< /Root 1 0 R /Size ${count} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
})();
