// Reproducible vendoring from the integrity-locked official npm dependency.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
const VERSION = "6.4.299";
function vendor() {
  const source = path.dirname(require.resolve("pdfjs-dist/package.json"));
  if (require(path.join(source, "package.json")).version !== VERSION) throw new Error("Unexpected PDF.js dependency version");
  const root = path.join(__dirname, "../ui/pdfjs"), dest = path.join(root, VERSION);
  fs.mkdirSync(dest, { recursive: true });
  const files = ["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "LICENSE"];
  for (const file of files) fs.copyFileSync(path.join(source, file), path.join(dest, path.basename(file)));
  for (const dir of ["cmaps", "standard_fonts", "wasm"]) fs.cpSync(path.join(source, dir), path.join(dest, dir), { recursive: true });
  const hashes = {};
  function inventory(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name), relative = path.relative(dest, file).replace(/\\/g, "/");
      if (entry.isSymbolicLink()) throw new Error("Unexpected symlink in vendored PDF.js");
      if (entry.isDirectory()) inventory(file);
      else if (relative !== "vendor.json") hashes[relative] = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  }
  inventory(dest);
  const integrity = require("../package-lock.json").packages["node_modules/pdfjs-dist"].integrity;
  fs.writeFileSync(path.join(dest, "vendor.json"), JSON.stringify({ package: "pdfjs-dist", version: VERSION, source: `https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-${VERSION}.tgz`, integrity, hashes }, null, 2) + "\n");
  console.log(`Vendored official pdfjs-dist ${VERSION} with worker, CMaps, standard fonts and WASM decoders`);
}
if (require.main === module) vendor();
module.exports = { VERSION, vendor };
