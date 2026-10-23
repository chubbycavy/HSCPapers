// Full ingestion/schema side-effect check from cached inputs in a throwaway
// sandbox. Network is forbidden and the workspace's reviewed feeds stay intact.
"use strict";
const fs = require("fs"), path = require("path"), os = require("os"), { execFileSync } = require("child_process");
async function main() {
  const source = path.join(__dirname, ".."), root = fs.mkdtempSync(path.join(os.tmpdir(), "hsc-security-rebuild-"));
  const desktop = path.join(root, "desktop"), tools = path.join(desktop, "tools"), ui = path.join(desktop, "ui"), modules = path.join(desktop, "node_modules");
  const log = path.join(__dirname, ".cache/security-offline-build.log");
  try {
    fs.mkdirSync(desktop);
    fs.cpSync(__dirname, tools, { recursive: true, filter: file => {
      const relative = path.relative(__dirname, file).replace(/\\/g, "/");
      return ![".cache", "e2e/artifacts", "logo-previews"].some(prefix => relative === prefix || relative.startsWith(prefix + "/"));
    } });
    fs.cpSync(path.join(source, "ui"), ui, { recursive: true });
    fs.copyFileSync(path.join(source, "sources.json"), path.join(desktop, "sources.json"));
    fs.copyFileSync(path.join(source, "package.json"), path.join(desktop, "package.json"));
    fs.copyFileSync(path.join(source, "../README.md"), path.join(root, "README.md"));
    fs.symlinkSync(path.join(source, "node_modules"), modules, "junction");
    const cache = path.join(tools, ".cache"); fs.mkdirSync(cache);
    for (const file of fs.readdirSync(path.join(__dirname, ".cache"))) {
      if (/^(?:tree\.json|HSCpapers\.json|hscportal-papers\.json|pages-.*\.html|bos-.*\.html|thsc-index-.*\.json|au-.*\.json)$/.test(file)) fs.copyFileSync(path.join(__dirname, ".cache", file), path.join(cache, file));
    }
    const noNetwork = path.join(root, "no-network.cjs");
    fs.writeFileSync(noNetwork, "globalThis.fetch = async () => { throw new Error('Network forbidden in security rebuild'); };\n");
    const previous = path.join(root, "previous.json"); fs.copyFileSync(path.join(ui, "data/papers-v2.json"), previous);
    let output;
    try {
      output = execFileSync(process.execPath, ["--require", noNetwork, "--require", path.join(tools, "tests/no-local-ingest.cjs"), path.join(tools, "build-index.cjs"), "--offline", "--quiet"], { cwd: desktop, encoding: "utf8", env: { ...process.env, CI: "true" }, maxBuffer: 8 * 1024 * 1024, timeout: 180000 });
    } catch (error) { fs.writeFileSync(log, String(error.stdout || "") + String(error.stderr || "")); throw error; }
    fs.writeFileSync(log, output);
    console.log(execFileSync(process.execPath, [path.join(tools, "verify-catalogue.cjs"), "--previous=" + previous], { cwd: desktop, encoding: "utf8", timeout: 60000 }));
    const feeds = dir => ["papers-v2.json", "papers.json"].map(file => JSON.parse(fs.readFileSync(path.join(dir, "data", file), "utf8")));
    const { digest, canonical } = require("./catalogue-publication-review.cjs");
    const original = feeds(path.join(source, "ui")), rebuilt = feeds(ui);
    const before = digest(...original), after = digest(...rebuilt);
    const result = { network: "forbidden", previous: before, rebuilt: after, semanticCatalogueUnchanged: before === after, log };
    console.log(JSON.stringify(result, null, 2));
    if (before !== after) {
      const differences = [], equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
      for (let i = 0; i < 2; i++) for (const key of ["papers", "recoveryPapers", "idAliases"]) {
        if (equal(original[i][key], rebuilt[i][key])) continue;
        if (key === "idAliases") { differences.push({ feed: i, key, original: original[i][key], rebuilt: rebuilt[i][key] }); continue; }
        const old = new Map((original[i][key] || []).map(p => [p.id, p])), next = new Map((rebuilt[i][key] || []).map(p => [p.id, p]));
        for (const id of new Set([...old.keys(), ...next.keys()])) {
          const a = old.get(id), b = next.get(id); if (equal(a, b)) continue;
          const fields = Object.fromEntries([...new Set([...Object.keys(a || {}), ...Object.keys(b || {})])].filter(k => !equal(a?.[k], b?.[k])).map(k => [k, { original: a?.[k] ?? "[missing/null]", rebuilt: b?.[k] ?? "[missing/null]" }]));
          differences.push({ feed: i, key, id, fields });
        }
      }
      const file = path.join(__dirname, ".cache/security-offline-diff.json"); fs.writeFileSync(file, JSON.stringify(differences, null, 2) + "\n");
      console.log(JSON.stringify({ changedRecords: differences.length, details: file }));
      throw new Error("Cached source rebuild differs from the reviewed catalogue; inspect the offline diff before changing any publication");
    }
    fs.writeFileSync(path.join(__dirname, ".cache/security-offline-build.json"), JSON.stringify(result, null, 2) + "\n");
  } finally {
    if (fs.existsSync(modules)) fs.unlinkSync(modules); // remove junction, never its target
    fs.rmSync(root, { recursive: true, force: true });
  }
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
