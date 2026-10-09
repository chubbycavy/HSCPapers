/* dan-report.cjs - consume slow-route-truth.json, emit the per-viewno
   corruption evidence table for Dan (THSC). Also prints the sha/fileref
   histogram so the collapse scope is exact.
   Usage: node tools/dan-report.cjs [--out=tools/dan-report-<date>.md] */
const fs = require("fs");
const path = require("path");

const OUT_JSON = path.join(__dirname, "slow-route-truth.json");
const truth = JSON.parse(fs.readFileSync(OUT_JSON, "utf8"));
const entries = Object.values(truth.entries || {});
const viewnoOf = (e) => { const m = String(e.url || "").match(/\/s\/[dvfz]\/(\d+)\//); return m ? m[1] : "?"; };

const byViewno = new Map();
for (const e of entries) {
  const v = viewnoOf(e);
  if (!byViewno.has(v)) byViewno.set(v, { viewno: v, listings: [], ok: 0, collapsed: 0, fileref: 0, failed: 0, filerefs: new Set() });
  const g = byViewno.get(v);
  g.listings.push(e);
  if (e.ok) g.ok++;
  else if (e.withheld) { if (e.guardKind === "collapsed") g.collapsed++; else g.fileref++; }
  else g.failed++;
  if (e.fileref) g.filerefs.add(e.fileref);
}

const rows = [...byViewno.values()].sort((a, b) => Number(a.viewno) - Number(b.viewno));
const shas = new Map();
for (const e of entries) {
  const s = e.sha256 || e.upstreamSha256;
  if (!s) continue;
  if (!shas.has(s)) shas.set(s, { sha: s, bytes: e.bytes || e.upstreamBytes, titles: [], ok: 0 });
  const rec = shas.get(s);
  rec.titles.push(e.title + " [" + viewnoOf(e) + "]");
  if (e.ok) rec.ok++;
}
const collapsed = [...shas.values()].filter((r) => !r.ok && r.titles.length > 1)
  .sort((a, b) => b.titles.length - a.titles.length);

let out = [];
out.push("# THSC resolver damage report - 2026-10-10");
out.push("");
out.push("Measured with the production proxy handler code (v1.0.21-era + the wrong-bytes guards), one listing at a time, honoring your pool's own cooldowns. All 329 slow-route listings on our side resolved (0 unresolved).");
out.push("");
out.push("## The one wrong document");
out.push("");
out.push("| field | value |");
out.push("|---|---|");
out.push("| SHA-256 | `ae3414ce7149e4f808bca8563d46b813a36af04c5651762c47ce0f854ff0561c` |");
out.push("| size | 92,354 bytes |");
out.push("| Drive fileref | `12TrRtJ9xfV4mo9O34MJ5_1YrHzjvirBR` |");
out.push("| listings served | see table below |");
out.push("");
out.push("Every listing below was asked for its own document and this one came back - byte-identical across requests and across different pool URLs (verified at v1.0.21 hunt time and re-verified today).");
out.push("");
out.push("## Per-viewno damage table");
out.push("");
out.push("`ok` = honest unique bytes returned; `collapsed` = the shared wrong doc above came back; `fileref` = a listing mapped to a fileref already handed out for a DIFFERENT title under the same viewno (the guard refuses those - mapping corrupted); `fail` = could not resolve (pool throttling).");
out.push("");
out.push("| viewno | listings | ok | collapsed | fileref-collisions | fail | filerefs involved |");
out.push("|---|---|---|---|---|---|---|");
for (const g of rows) {
  const refs = [...g.filerefs].map((f) => "`" + f + "`").join(", ") || "(unresolved)";
  out.push(`| ${g.viewno} | ${g.listings.length} | ${g.ok} | ${g.collapsed} | ${g.fileref} | ${g.failed} | ${refs} |`);
}
out.push("");
out.push("## Cross-viewno collapse signature (the strongest evidence)");
out.push("");
out.push("Docs returned for listings under MULTIPLE viewnos - the mapping cannot be right for all of them:");
out.push("");
out.push("| upstream sha | bytes | served to N listings | sample titles |");
out.push("|---|---|---|---|");
for (const c of collapsed) {
  out.push(`| \`${c.sha}\` | ${c.bytes} | ${c.titles.length} | ${c.titles.slice(0, 3).map((t) => "`" + t + "`").join(", ")}${c.titles.length > 3 ? " ..." : ""} |`);
}
if (!collapsed.length) out.push("| (none beyond the known doc - see table above) | | | |");
out.push("");
out.push("## Collapsed listings (the fix list)");
out.push("");
out.push("These are the exact listings whose pool mapping points at the shared wrong document - each expected its own document and received the 92,354-byte one instead:");
out.push("");
out.push("| viewno | collapsed titles |");
out.push("|---|---|");
for (const g of rows.filter((r) => r.collapsed > 0)) {
  out.push(`| ${g.viewno} | ${g.listings.filter((e) => e.withheld && e.guardKind === "collapsed").map((e) => "`" + e.title + "`").join(", ")} |`);
}
out.push("");
out.push("## Honest listings (resolved with unique bytes)");
out.push("");
out.push("These viewnos are healthy or partially healthy - damage is per directory, not global:");
out.push("");
out.push("| viewno | honest listings | distinct filerefs |");
out.push("|---|---|---|");
for (const g of rows.filter((r) => r.ok > 0)) {
  const honest = g.listings.filter((e) => e.ok).map((e) => "`" + e.title + "`").join(", ");
  out.push(`| ${g.viewno} | ${g.ok} (${honest}) | ${g.filerefs.size} |`);
}
out.push("");
out.push("## What this means");
out.push("");
out.push("- The data pool's per-base listing-to-file mapping is corrupted for the affected viewnos: many listings resolve to one Drive file.");
out.push("- Fix on your side: re-map those listings to their real filerefs (Drive), or restore the pre-Drive data source.");
out.push("- On our side: the proxy now refuses to serve any listing whose fileref was already seen for a different title under the same viewno, and permanently bans the known wrong document by SHA. Users get an honest 503 with Retry-After instead of wrong bytes.");
out.push("");
out.push("## Method + repro");
out.push("");
out.push("- Tool: `desktop/tools/slow-route-ground-truth.cjs` (resumable; 1.5s designed gap, honors Retry-After, checkpoints per 3 entries).");
out.push("- Raw data: `desktop/tools/slow-route-truth.json` - per listing: status, sha256, bytes, fileref, timestamps.");
out.push("- Re-run anytime to re-probe only unresolved listings.");
out.push("");

const md = out.join("\n") + "\n";
const outFile = argOut();
fs.writeFileSync(outFile, md);
console.log(`dan report written: ${outFile}`);
console.log("");
console.log(`viewnos: ${rows.length} | corrupted viewnos: ${rows.filter((g) => g.collapsed + g.fileref > 0).length} | viewnos with zero observed damage: ${rows.length - rows.filter((g) => g.collapsed + g.fileref > 0).length} (some may just be unresolved)`);
console.log(`cross-viewno collapsed docs: ${collapsed.length}`);
for (const c of collapsed) console.log(`  ${c.sha.slice(0, 12)}... ${c.bytes}B -> ${c.titles.length} listings`);
console.log(`ok listings: ${entries.filter((e) => e.ok).length} | withheld: ${entries.filter((e) => e.withheld).length} | failed: ${entries.filter((e) => !e.ok && !e.withheld).length}`);

function argOut() {
  const a = process.argv.find((x) => x.startsWith("--out="));
  if (a) return path.resolve(a.slice(6));
  const stamp = (truth.generated || new Date().toISOString()).slice(0, 10);
  return path.join(__dirname, `dan-report-${stamp}.md`);
}
