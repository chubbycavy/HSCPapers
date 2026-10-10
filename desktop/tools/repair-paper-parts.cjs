/* Targeted correction of explicit Paper-1/Paper-2 URL mismatches. Only
   course/year-specific cached official pack anchors are candidates. */
"use strict";
const fs = require("fs"), path = require("path"), crypto = require("crypto"), I = require("./catalogue-identity.cjs");
const tools = __dirname, load = f => JSON.parse(fs.readFileSync(f, "utf8"));
const catalogue = load(path.join(tools, "../ui/data/papers.json"));
const proofs = load(path.join(tools, "catalogue-imports.json")).proofs;
const wrong = catalogue.papers.filter(p => {
  const wanted = I.paperPart(I.routeText(p)); let file; try { file = decodeURIComponent(new URL(p.url).pathname.split("/").pop()); } catch { return false; }
  return wanted && I.paperPart(file) && wanted !== I.paperPart(file);
});
(async () => {
  const entries = {}, unresolved = [];
  for (const p of wrong) {
    const nk = I.normalize(p.subject), candidates = new Map();
    for (const [subdir, nameTest] of [
      [".cache/nesa-archive/pages", f => f.startsWith("pack-" + nk.replace(/ /g, "-") + "-") && f.includes("_" + p.year)],
      [".cache/nesa-recovery", f => f.startsWith("page-" + nk + "-" + p.year + "-")],
    ]) {
      const dir = path.join(tools, subdir); if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter(nameTest)) {
        const html = fs.readFileSync(path.join(dir, f), "utf8");
        for (const m of html.matchAll(/<a\b[^>]*href="([^"]+\.pdf[^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
          const label = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
          if (I.paperPart(label) !== I.paperPart(I.routeText(p)) || I.documentRole(label) !== I.documentRole(I.routeText(p))) continue;
          if (/writing booklet|sample writing|transcript|listening/i.test(label)) continue;
          let url; try { url = new URL(m[1].replace(/&amp;/g, "&"), "https://www.nsw.gov.au").href; } catch { continue; }
          if (!url.startsWith("https://www.nsw.gov.au/") || !url.includes(String(p.year))) continue;
          candidates.set(url, label);
        }
      }
    }
    if (candidates.size !== 1) { unresolved.push({ id: p.id, candidates: [...candidates.keys()] }); continue; }
    const [url, label] = [...candidates][0]; let proof = proofs[url];
    if (!proof) {
      const res = await fetch(url, { headers: { "User-Agent": "HSCPapers/1.0 (targeted paper-number repair)" }, signal: AbortSignal.timeout(30000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok || !/^application\/pdf/i.test(res.headers.get("content-type") || "") || buf.subarray(0, 5).toString() !== "%PDF-") { unresolved.push({ id: p.id, reason: "Candidate not a full PDF" }); continue; }
      proof = { sha256: crypto.createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
      await new Promise(r => setTimeout(r, 1100));
    }
    entries[p.id] = { url, ...proof, packText: label, replaced: p.url, reason: "Explicit paper-number mismatch repaired from course/year-specific official pack" };
    console.log("CORRECT", p.id, "->", url);
  }
  fs.writeFileSync(path.join(tools, "catalogue-mapping-corrections.json"), JSON.stringify({ version: 1, entries, unresolved }, null, 1) + "\n");
  console.log(`Targeted part repair: ${Object.keys(entries).length} corrected, ${unresolved.length} unresolved`);
})().catch(e => { console.error(e); process.exitCode = 1; });
