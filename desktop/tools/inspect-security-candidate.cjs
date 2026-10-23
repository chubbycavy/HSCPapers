// Local review receipt: check the actual candidate, vendor inventory and data.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), { execFileSync } = require("child_process");
const desktop = path.join(__dirname, "..");
function hash(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function main() {
  const release = process.argv.includes("--release");
  const pkg = require("../package.json"), conf = require("../src-tauri/tauri.conf.json");
  const cargo = fs.readFileSync(path.join(desktop, "src-tauri/Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)[1];
  if (pkg.version !== conf.version || pkg.version !== cargo) throw new Error("Application versions disagree");
  const pdfVersion = require("./vendor-pdfjs.cjs").VERSION, root = path.join(desktop, "ui/pdfjs", pdfVersion), vendor = JSON.parse(fs.readFileSync(path.join(root, "vendor.json"), "utf8"));
  if (vendor.version !== pdfVersion || require("pdfjs-dist/package.json").version !== pdfVersion || vendor.integrity !== require("../package-lock.json").packages["node_modules/pdfjs-dist"].integrity) throw new Error("PDF.js dependency/vendor identity mismatch");
  for (const [file, expected] of Object.entries(vendor.hashes)) if (hash(path.join(root, file)) !== expected) throw new Error("Vendored PDF.js asset changed: " + file);
  for (const file of ["pdf.min.js", "pdf.worker.min.js"]) if (fs.existsSync(path.join(desktop, "ui/pdfjs", file))) throw new Error("Obsolete vulnerable reader asset remains");
  const data = ["ui/data/papers-v2.json", "ui/data/papers.json", "tools/catalogue-validation.json", "tools/catalogue-history.json", "tools/catalogue-publication-sync.json"];
  execFileSync("git", ["diff", "--exit-code", "HEAD", "--", ...data.map(f => "desktop/" + f)], { cwd: path.join(desktop, ".."), stdio: "pipe" });
  if (release) execFileSync("git", ["diff", "--exit-code", "HEAD", "--", "desktop", "serve.js", ".github/workflows"], { cwd: path.join(desktop, ".."), stdio: "pipe" });
  const installer = path.join(desktop, "src-tauri/target/release/bundle/nsis", `HSCPapers_${pkg.version}_x64-setup.exe`);
  const fd = fs.openSync(installer, "r"), magic = Buffer.alloc(2); try { fs.readSync(fd, magic, 0, 2, 0); } finally { fs.closeSync(fd); }
  if (magic.toString() !== "MZ") throw new Error("Installer is not a Windows executable");
  const c = require("../ui/data/papers-v2.json");
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: desktop, encoding: "utf8" }).trim();
  const receipt = { at: new Date().toISOString(), state: release ? "release-candidate" : "local-review-only", sourceCommit, version: pkg.version, installer, bytes: fs.statSync(installer).size, sha256: hash(installer), pdfjs: pdfVersion, verifiedVendorFiles: Object.keys(vendor.hashes).length, catalogueUnchanged: true, active: c.papers.length, recovery: c.recoveryPapers.length, aliases: Object.keys(c.idAliases).length };
  const out = path.join(__dirname, ".cache/security-verification.json"); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify(receipt, null, 2));
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
