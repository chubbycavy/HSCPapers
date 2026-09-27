/* legacy-probe.cjs — A2 probe-first diagnostic (2001–2018 dead-wcm pool).
   Parses the builder's cached BOS index pages (live fetches + 2017 Wayback
   snapshots already on disk), builds the full (subject|year|kind) inventory,
   then matches each dead-wcm paper and HEAD-probes its candidate URL LIVE.
   Output: a yield report — how many dead papers have live BOS equivalents.
   NO changes made; the report gates any registry write. */
const fs = require("fs");
const path = require("path");

const CACHE = path.join(__dirname, ".cache");
const papers = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ui", "data", "papers.json"), "utf8")).papers;
const dead = papers.filter(p => (p.url || "").includes("wcm"));
const normKey = (s) => (s ?? "").toString().toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const stripTags = (s) => s.replace(/<[^>]*>/g, " ").replace(/&[a-z]+;/gi, " ");
const bosKindFor = (text) =>
  /marking guideline/i.test(text) ? "mg" :
  /sample answer/i.test(text) ? "sa" :
  /notes from the marking centre/i.test(text) ? "nfc" :
  /transcript|audio|listening|oral|specimen|workbook/i.test(text) ? null : "paper";

// 1. build the inventory from every cached BOS page
const bosMap = new Map(); // normSubject|year|kind -> {url,text}
let filesSeen = 0;
for (const f of fs.readdirSync(CACHE)) {
  const m = f.match(/^bos-(\d{4})-(?:wayback-)?(.+)-html\.html$/);
  if (!m) continue;
  const year = Number(m[1]);
  const html = fs.readFileSync(path.join(CACHE, f), "utf8");
  for (const r of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const firstCell = stripTags((r[1].split(/<\/td>|<\/th>/i)[0] || "")).replace(/[\u2013\u2014]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
    const subject = normKey(firstCell);
    if (!subject) continue;
    for (const a of r[1].matchAll(/<a\b[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
      const kind = bosKindFor(stripTags(a[2]));
      if (!kind) continue;
      let abs;
      try { abs = new URL(a[1].replace(/^\/\//, "https://"), "https://www.boardofstudies.nsw.edu.au/").href; } catch { continue; }
      if (!/^https:/.test(abs)) continue;
      const key = `${subject}|${year}|${kind}`;
      if (!bosMap.has(key)) bosMap.set(key, { url: abs, text: stripTags(a[2]).trim() });
      filesSeen++;
    }
  }
}
console.log(`inventory: ${filesSeen} pdf links -> ${bosMap.size} (subject|year|kind) keys`);

// 2. match dead papers: primary paper, then solutions (kind mg/sa/nfc)
async function head(url) {
  try {
    const res = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(15000) });
    return { status: res.status, type: res.headers.get("content-type") || "" };
  } catch { return { status: 0, type: "" }; }
}
(async () => {
  let matched = 0, liveOk = 0, solMatched = 0;
  const registry = {}; // deadUrl -> live BOS url (candidates)
  const absentSubjects = new Map();
  for (const p of dead) {
    const nk = normKey(p.subject);
    const paperHit = bosMap.get(`${nk}|${p.year}|paper`);
    if (!paperHit) {
      absentSubjects.set(p.subject, (absentSubjects.get(p.subject) || 0) + 1);
      continue;
    }
    matched++;
    const ok = await head(paperHit.url);
    if (ok.status === 200 && /pdf/.test(ok.type)) {
      liveOk++;
      registry[p.url] = paperHit.url;
      // solutions: marking guidelines are the closest companion on BOS
      const sol = p.solutionUrl && (p.solutionUrl || "").includes("wcm") ? p.solutionUrl : null;
      if (sol) {
        const mg = bosMap.get(`${nk}|${p.year}|mg`) || bosMap.get(`${nk}|${p.year}|sa`) || bosMap.get(`${nk}|${p.year}|nfc`);
        if (mg) { solMatched++; registry[sol] = mg.url; }
      }
    }
  }
  const byYear = {};
  for (const p of dead) {
    if (!registry[p.url]) continue;
    byYear[p.year] = (byYear[p.year] || 0) + 1;
  }
  console.log(`dead-wcm: ${dead.length}`);
  console.log(`(subject,year) matched in inventory: ${matched} · live-verified: ${liveOk}`);
  console.log(`solutions companions matched: ${solMatched}`);
  console.log(`by year of verified: ${JSON.stringify(byYear)}`);
  const top = [...absentSubjects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
  console.log(`absent (subject|year not in BOS inventory) top: ${JSON.stringify(top)}`);
  fs.writeFileSync(path.join(CACHE, "legacy-probe-report.json"), JSON.stringify({
    generated: new Date().toISOString(),
    dead: dead.length, inventoryKeys: bosMap.size,
    matched, liveOk, solMatched, byYear,
    absent: [...absentSubjects.entries()].sort((a, b) => b[1] - a[1]),
    registry,
  }, null, 1));
  console.log("report: desktop/tools/.cache/legacy-probe-report.json");
})();
