// Targeted operator tool; never overwrites an existing release checkpoint.
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto");
globalThis.crypto ||= crypto.webcrypto;
const tools = __dirname, root = path.resolve(tools, "../.."), dir = path.join(tools, ".cache/release-readiness");
const targets = [["5222", "Normanhurst Boys 2025 w. sol"], ["5331", "Caringbah 2024 w. sol"], ["5342", "Girraween 2024 w. sol"], ["5342", "Girraween 2025 w. sol"], ["5338", "Abbotsleigh 2022"], ["6528", "North Sydney Girls 2023 w. sol"]];
async function main() {
  fs.mkdirSync(dir, { recursive: true });
  if (process.argv.includes("--checkpoint")) {
    const dest = path.join(dir, "before-1.0.27");
    if (fs.existsSync(dest)) throw new Error("Checkpoint exists; refusing to replace it");
    fs.mkdirSync(dest);
    for (const relative of ["desktop/ui/data/papers.json", "desktop/tools/catalogue-validation.json", "desktop/tools/catalogue-history.json", "desktop/tools/catalogue-document-review.json", "desktop/tools/catalogue-metadata-corrections.json", "desktop/tools/reconciliation-report.json", "desktop/ui/js/app.js", "desktop/ui/sw.js", "desktop/src-tauri/src/main.rs"]) {
      const output = path.join(dest, relative); fs.mkdirSync(path.dirname(output), { recursive: true }); fs.copyFileSync(path.join(root, relative), output);
    }
    console.log("Candidate checkpoint:", dest); return;
  }
  if (process.argv.includes("--package-report")) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "desktop/package.json"), "utf8"));
    const lock = JSON.parse(fs.readFileSync(path.join(root, "desktop/package-lock.json"), "utf8"));
    const tauri = JSON.parse(fs.readFileSync(path.join(root, "desktop/src-tauri/tauri.conf.json"), "utf8"));
    const cargo = fs.readFileSync(path.join(root, "desktop/src-tauri/Cargo.toml"), "utf8").match(/^version = "([^"]+)"/m)?.[1];
    const cargoLock = fs.readFileSync(path.join(root, "desktop/src-tauri/Cargo.lock"), "utf8").match(/name = "hscpapes"\r?\nversion = "([^"]+)"/)?.[1];
    if ([lock.version, lock.packages[""].version, tauri.version, cargo, cargoLock].some(v => v !== pkg.version) || lock.name !== pkg.name || lock.packages[""].name !== pkg.name) throw new Error("Package version/name metadata differs");
    const filename = `HSCPapers_${pkg.version}_x64-setup.exe`, relative = `desktop/src-tauri/target/release/bundle/nsis/${filename}`;
    const installer = path.join(root, relative), executable = path.join(root, "desktop/src-tauri/target/release/hscpapes.exe");
    const bytes = fs.readFileSync(installer), exeBytes = fs.readFileSync(executable);
    function machine(buffer) {
      if (buffer.subarray(0,2).toString() !== "MZ") throw new Error("Artifact is not a Windows executable");
      const offset = buffer.readUInt32LE(0x3c);
      if (buffer.subarray(offset,offset+4).toString() !== "PE\0\0") throw new Error("Invalid PE header");
      return buffer.readUInt16LE(offset+4);
    }
    if (machine(exeBytes) !== 0x8664 || ![0x14c, 0x8664].includes(machine(bytes))) throw new Error("Unexpected installer/payload architecture");
    const inputFiles = ["desktop/ui/index.html", "desktop/ui/js/app.js", "desktop/ui/js/config.js", "desktop/ui/js/source-policy.js", "desktop/ui/js/migration-state.js", "desktop/ui/data/papers-v2.json", "desktop/ui/data/papers.json"];
    const builtAt = fs.statSync(executable).mtimeMs;
    if (inputFiles.some(f => fs.statSync(path.join(root,f)).mtimeMs > builtAt)) throw new Error("Frontend/catalogue changed after the executable was packaged");
    const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    const report = { version: pkg.version, generated: new Date().toISOString(), installer: relative, bytes: bytes.length, sha256, payloadMachine: "x64", installerMachine: "0x" + machine(bytes).toString(16), published: false, inputs: Object.fromEntries(inputFiles.map(f => [f, crypto.createHash("sha256").update(fs.readFileSync(path.join(root,f))).digest("hex")])) };
    fs.writeFileSync(installer + ".sha256", sha256 + "  " + filename + "\n");
    fs.writeFileSync(path.join(tools, "release-readiness-artifact.json"), JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report, null, 2)); return;
  }
  if (process.argv.includes("--check-delivery")) {
    const modern = JSON.parse(fs.readFileSync(path.join(tools, "../ui/data/papers-v2.json"), "utf8"));
    const compatibility = JSON.parse(fs.readFileSync(path.join(tools, "../ui/data/papers.json"), "utf8"));
    const feeds = require("./catalogue-feeds.cjs"), policy = require("../ui/js/source-policy.js");
    const errors = feeds.verify(modern, compatibility); if (errors.length) throw new Error(errors.join("\n"));
    const { createProxyHandler } = await import("../ui/_lib/pdf-proxy.mjs");
    const { pdfProof } = await import("../ui/_lib/thsc-fragments.mjs");
    const registry = JSON.parse(fs.readFileSync(path.join(tools, "catalogue-validation.json"), "utf8"));
    const fragmentPaper = modern.papers.find(p => policy.isFragment(p.url));
    const legacyPaper = modern.papers.find(p => policy.isLegacy(p.url));
    const solutions = modern.papers.find(p => policy.isFragment(p.solutionUrl) || policy.isFragment(p.solFallbackUrl));
    const jobs = [fragmentPaper && { p: fragmentPaper, source: fragmentPaper.url }, legacyPaper && { p: legacyPaper, source: legacyPaper.url }, solutions && { p: solutions, source: policy.isFragment(solutions.solutionUrl) ? solutions.solutionUrl : solutions.solFallbackUrl }].filter(Boolean);
    const results = [];
    for (const { p, source } of jobs) {
      const serve = createProxyHandler({ cache: null, fetchImpl: (url, init) => {
        if (policy.isFragment(source) && /script\.google/.test(url)) throw new Error("Migrated delivery attempted a legacy script");
        return fetch(url, init);
      } });
      const response = await serve({ request: new Request(feeds.bridge(source)) });
      if (!response.ok) throw new Error(`Bridge ${p.id}: HTTP ${response.status}: ${await response.text()}`);
      const proof = await pdfProof(new Uint8Array(await response.arrayBuffer()));
      if (proof.sha256 !== registry.entries[source]?.sha256) throw new Error("Bridge hash does not match reviewed evidence: " + p.id);
      results.push({ id: p.id, source, bridge: feeds.bridge(source), ...proof, at: new Date().toISOString() });
      console.log("Verified current-handler delivery:", JSON.stringify(results.at(-1)));
    }
    fs.writeFileSync(path.join(dir, "delivery-check.json"), JSON.stringify(results, null, 2) + "\n");
    return;
  }
  if (!process.argv.includes("--refresh-migrated")) throw new Error("Use --checkpoint, --refresh-migrated, --check-delivery or --package-report");
  const file = path.join(tools, "catalogue-validation.json"), registry = JSON.parse(fs.readFileSync(file, "utf8"));
  const { resolveFragments, fragmentUrl, sanitizeThscTitle, fragmentDescriptor } = await import("../ui/_lib/thsc-fragments.mjs");
  const pdfjs = await require("./pdfjs.cjs").load();
  const lookups = new Map(targets.map(([viewno, rawTitle]) => [viewno + "|" + rawTitle, { viewno, rawTitle }]));
  for (const [url, proof] of Object.entries(registry.entries)) if (proof.state === "verified" && proof.transport === "thsc-fragments") {
    const value = proof.migratedUrl || url;
    try { const d = fragmentDescriptor(value); if (d) lookups.set(d.viewno + "|" + d.rawTitle, { viewno: d.viewno, rawTitle: d.rawTitle }); } catch {}
  }
  const results = [];
  for (const { viewno, rawTitle } of lookups.values()) {
    const oldUrl = `https://thsconline.github.io/s/d/${viewno}/${encodeURIComponent(rawTitle)}`, url = fragmentUrl(viewno, rawTitle);
    const result = await resolveFragments({ viewno, title: sanitizeThscTitle(rawTitle) });
    const previous = registry.entries[url] || registry.entries[oldUrl];
    if (previous?.state === "verified" && previous.sha256 !== result.sha256) throw new Error("Hash drift requires review: " + url);
    const task = pdfjs.getDocument({ data: new Uint8Array(result.bytes), isEvalSupported: false, verbosity: 0 });
    let text = "", pages;
    try { const doc = await task.promise; pages = doc.numPages; for (let n = 1; n <= Math.min(2, pages); n++) text += (await (await doc.getPage(n)).getTextContent()).items.map(x => x.str).join(" ") + " "; }
    finally { await task.destroy(); }
    const proof = { state: "verified", sha256: result.sha256, bytes: result.byteLength, pages, text: text.replace(/\s+/g, " ").slice(0, 1400), transport: "thsc-fragments", apiFilename: result.metadata.originalFileName, at: new Date().toISOString() };
    const pdfDir = path.join(dir, "pdfs"); fs.mkdirSync(pdfDir, { recursive: true });
    fs.writeFileSync(path.join(pdfDir, `${viewno}-${rawTitle.replace(/[^a-z0-9]+/gi, "-")}.pdf`), result.bytes);
    registry.entries[oldUrl] = { ...proof, migratedUrl: url };
    registry.entries[url] = { ...proof, proofSource: oldUrl };
    results.push({ url, ...proof }); console.log(JSON.stringify(results.at(-1)));
  }
  registry.generated = new Date().toISOString();
  registry.releaseRefresh = { at: registry.generated, checked: results.length, reason: "Targeted migrated proof refresh for 1.0.27", urls: results.map(r => r.url) };
  fs.writeFileSync(file, JSON.stringify(registry, null, 1) + "\n");
  fs.writeFileSync(path.join(dir, "migrated-refresh.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`Refreshed ${results.length} migrated files; legacy scripts not used`);
}
main().catch(e => { console.error(e); process.exitCode = 1; });
