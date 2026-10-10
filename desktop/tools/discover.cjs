/* discover.cjs - candidate-only crawlers for the adds lanes.
   DISCOVERY NEVER WRITES THE CATALOGUE: each module produces
   tools/.cache/discover/<source>.candidates.json rows shaped like:
     { source, subject, school, year, type, kind, title, url, hints }
   The dedupe gate + the builder do the gating and the ingest.

   Modules:
     --source=acehsc      all subject trial-paper pages -> resource pages
                          -> one direct PDF each (aceh.b-cdn.net hosting)
     --source=4unitmaths  /exams.html direct pdfs (Ext-2 trials + old HSC
                          exams 1967-1994; listing page self-describes)
     --source=crest       cresteconomics.com free-resources page direct
                          pdfs (authored practice papers; Economics only)
     --source=mirror      thsc-au api/index + api/papers rows not already
                          in the catalogue (mirror-growth adds)
     --source=drive       recursive embeddedfolderview listing of the seed
                          folders (candidates get re-hosted by drive.cjs)
     --source=all         every module above (background-friendly)

   Politeness: 1 req/s per host; resumable per module via .cache state.

   Usage: node tools/discover.cjs --source=acehsc|4unitmaths|crest|mirror|drive|all [--limit=N] */
const fs = require("fs");
const path = require("path");

const TOOLS = __dirname;
const DISCOVER = path.join(TOOLS, ".cache", "discover");
const UA = { "User-Agent": "HSCPapers/1.0 (discover pass)", "Accept-Encoding": "identity" };
const TR = "1Eb1-o3BfmtgEpZCTsk5j1DHV_KcvLram"; // the known public community folder (nested year sub-folders)

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const WHICH = argValue("--source") || "";
const LIMIT = Number(argValue("--limit") || 0);
if (!WHICH) { console.error("usage: node tools/discover.cjs --source=acehsc|4unitmaths|crest|mirror|drive|all [--limit=N]"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normKey = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/* polite fetch cache: same-key html forever cached */
let lastHostCall = new Map();
async function fetchDoc(url, cacheKey) {
  const file = path.join(DISCOVER, "html", cacheKey + ".html");
  fs.mkdirSync(path.join(DISCOVER, "html"), { recursive: true });
  if (fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  const host = new URL(url).host;
  const gap = (lastHostCall.get(host) || 0) + 1100 - Date.now();
  if (gap > 0) await sleep(gap);
  let res;
  try { res = await fetch(url, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(45000) }); }
  catch (e) { throw new Error(String(e && e.message).slice(0, 60)); }
  lastHostCall.set(host, Date.now());
  if (!res.ok) { if (res.body) try { await res.body.cancel(); } catch { /* ok */ } throw new Error("HTTP " + res.status + " for " + url); }
  const html = await res.text();
  fs.writeFileSync(file, html);
  await sleep(900);
  return html;
}

const yearOf = (t) => { const m = String(t).match(/\b(19\d{2}|20\d{2})\b/); return m ? Number(m[1]) : null; };

/* ══ module: acehsc ══ */
function acehSubjectPages(hubHtml) {
  const set = new Set();
  for (const m of hubHtml.matchAll(/href="(https:\/\/www\.acehsc\.net\/[a-z0-9-]+(?!-trial-paper-with)?-trial-papers\/?)"/gi)) {
    const u = m[1].replace(/&amp;/g, "&");
    if (/category|past-trial-papers/i.test(u)) continue;
    set.add(u.endsWith("/") ? u : u + "/");
  }
  return [...set];
}
function acehSubjectName(pageHtml, url) {
  const m = pageHtml.match(/<h1[^>]*>([^<]*?)<\/h1>/i) || pageHtml.match(/<title>([^<#]*?)(?:\s*\|[^<]*)?<\/title>/i);
  const name = (m ? m[1] : "") || "";
  const cleaned = name.replace(/(?:HSC\s+)?(.+?)\s*Trial Papers.*/i, "$1").replace(/\s*-\s*AceHSC\s*$/i, "").replace(/Downloadable.*$/i, "").trim();
  return cleaned;
}
async function runAcehsc() {
  const hub = await fetchDoc("https://www.acehsc.net/category/past-trial-papers/", "aceh-hub");
  const pages = acehSubjectPages(hub);
  console.log(`acehsc: ${pages.length} subject trial pages`);
  const cands = [];
  for (const page of pages) {
    if (LIMIT && cands.length >= LIMIT) break;
    let html;
    try { html = await fetchDoc(page, "aceh-" + normKey(page.replace(/https:\/\/www\.acehsc\.net\//, ""))); }
    catch (e) { console.log(`  subject page fail: ${page.slice(-40)} (${e.message})`); continue; }
    const subject = acehSubjectName(html, page);
    const resLinks = [...html.matchAll(/href="(https:\/\/www\.acehsc\.net\/resource\/[^"]+)"/gi)].map((m) => m[1]);
    for (const rl of resLinks) {
      if (LIMIT && cands.length >= LIMIT) break;
      try {
        const rhtml = await fetchDoc(rl, "aceh-r-" + normKey(rl.replace(/https:\/\/www\.acehsc\.net\/resource\//, "").replace(/\/$/, "")));
        const pdf = [...rhtml.matchAll(/(?:href=["'])(https?:\/\/[^"']+\.pdf[^"']*)["']/gi)].map((m) => m[1])[0];
        if (!pdf) continue;
        const base = decodeURIComponent(String(pdf.split("/").pop() || "").replace(/\.pdf$/i, "").replace(/_/g, " "));
        cands.push({
          source: "acehsc", subject, school: null, year: yearOf(base) || yearOf(rl), type: "trial",
          title: normKey(base).replace(/\b\w/g, (c) => c.toUpperCase()),
          url: pdf, hints: { resourcePage: rl, subjectPage: page },
        });
      } catch (e) { console.log(`  resource fail: ${rl.slice(-44)} (${String(e && e.message).slice(0, 40)})`); }
    }
    console.log(`  ${subject}: +${resLinks.length} resources so far total ${cands.length}`);
    fs.mkdirSync(DISCOVER, { recursive: true });
    fs.writeFileSync(path.join(DISCOVER, "acehsc.candidates.json"), JSON.stringify({ source: "acehsc", candidates: cands }, null, 1) + "\n");
  }
  console.log(`acehsc done: ${cands.length} candidates`);
}

/* ══ module: 4unitmaths ══ */
async function run4Unit() {
  const html = await fetchDoc("http://4unitmaths.com/exams.html", "4unit-exams");
  const cands = [];
  const stripTokens = (u) => decodeURIComponent(u.split("/").pop() || "").replace(/\.pdf$/i, "");
  for (const m of html.matchAll(/href="([^"]+\.pdf[^"]*)"/gi)) {
    try {
      // the listing is served over http but the host also carries TLS - the
      // catalogue only points at https (the mixed-content-safe form)
      const u = new URL(m[1], "https://4unitmaths.com/exams.html").href.replace(/^http:/, "https:");
      const base = normKey(stripTokens(u));
      if (!base) continue;
      const year = yearOf(base) || null;
      // the fixtures pattern: school tokens run before the year token
      let school = base.replace(String(year || ""), "").replace(/\s+/g, " ").trim() || null;
      const isOldHsc = /hsc\s*(19|20)?\d\d|^old\b|older/i.test(base) && !school.slice(0, 3).toLowerCase().match(/st |new|bark|pym|sho/);
      cands.push({
        source: "4unitmaths", subject: "Mathematics Extension 2", school: school || null, year, type: year && year >= 2001 ? "trial" : "hsc",
        title: base.replace(/\b\w/g, (c) => c.toUpperCase()), url: u, hints: { listing: "exams.html", isOldHsc },
      });
    } catch { /* bad href */ }
  }
  fs.mkdirSync(DISCOVER, { recursive: true });
  fs.writeFileSync(path.join(DISCOVER, "4unitmaths.candidates.json"), JSON.stringify({ source: "4unitmaths", candidates: cands }, null, 1) + "\n");
  console.log(`4unitmaths done: ${cands.length} candidates (old-era ${cands.filter((c) => c.hints.isOldHsc).length})`);
}

/* ══ module: crest ══ */
async function runCrest() {
  const html = await fetchDoc("https://www.cresteconomics.com/free-resources", "crest-resources");
  const cands = [];
  for (const m of html.matchAll(/href="([^"]+\.pdf[^"]*)"/gi)) {
    try {
      const u = new URL(m[1], "https://www.cresteconomics.com/free-resources").href;
      const base = normKey(decodeURIComponent(u.split("/").pop() || "").replace(/\.pdf$/i, ""));
      cands.push({
        source: "crest", subject: "Economics", school: "CREST", year: yearOf(base), type: "practice",
        title: base.replace(/\b\w/g, (c) => c.toUpperCase()), url: u, hints: { listing: "free-resources" },
      });
    } catch { /* skip */ }
  }
  fs.mkdirSync(DISCOVER, { recursive: true });
  fs.writeFileSync(path.join(DISCOVER, "crest.candidates.json"), JSON.stringify({ source: "crest", candidates: cands }, null, 1) + "\n");
  console.log(`crest done: ${cands.length} candidates`);
}

/* ══ module: mirror re-scan (thsc-au growth) ══ */
async function runMirror() {
  // the builder's au-refresh covers registrations; this module *only* adds
  // rows that show up in the mirror but not in our catalogue as tuples
  const auBase = "https://thsconline.com.au";
  const index = JSON.parse(await fetchDoc(auBase + "/api/index", "au-index"));
  const cands = [];
  const catalogue = require("../ui/data/papers.json").papers;
  const known = new Set(catalogue.map((p) => `${normKey(p.subject)}|${normKey(p.school)}|${p.year}|${p.type}`));
  for (const level of index.levels || []) for (const course of level.courses || []) {
    const slug = course.course.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    let lists;
    try { lists = JSON.parse(await fetchDoc(auBase + `/api/papers?level=${encodeURIComponent(level.level)}&course=${encodeURIComponent(course.course)}`, `au-${slug}-${normKey(level.level)}`)); }
    catch (e) { console.log(`  mirror fetch fail: ${course.course} (${String(e && e.message).slice(0, 36)})`); continue; }
    for (const row of lists.papers || []) {
      const year = Number(String(row.id || "").match(/\b(19\d{2}|20\d{2})\b/) || 0) || row.year || null;
      const title = String(row.id || "").replace(/^\d+\//, "");
      const school = title.replace(new RegExp(`\\s*${year ? year : ""}.*$`), "").trim() || null;
      const type = /hsc|exam/i.test(title) ? "hsc" : "trial";
      const t = `${normKey(course.course)}|${normKey(school || "")}|${year}|${type}`;
      if (known.has(t)) continue;
      if (!row.r2_key) continue;
      const url = auBase + "/pdf/" + String(row.r2_key).split("/").map(encodeURIComponent).join("/");
      cands.push({ source: "thsc-au-growth", subject: course.course, school, year, type, title, url, hints: { mirrorRow: row.id, bytes: row.bytes, pages: row.pages } });
    }
    console.log(`  mirror ${course.course}: +${cands.length} total`);
    fs.mkdirSync(DISCOVER, { recursive: true });
    fs.writeFileSync(path.join(DISCOVER, "thsc-au-growth.candidates.json"), JSON.stringify({ source: "thsc-au-growth", candidates: cands }, null, 1) + "\n");
  }
  console.log(`mirror done: ${cands.length} candidates`);
}

/* ══ module: drive (recursive listing; re-host happens in drive.cjs) ══ */
async function runDrive() {
  const seeds = [TR];
  const cands = [];
  const seenFolders = new Set();
  const queue = [...seeds];
  while (queue.length) {
    const folderId = queue.shift();
    if (seenFolders.has(folderId)) continue;
    seenFolders.add(folderId);
    let html;
    try { html = await fetchDoc(`https://drive.google.com/embeddedfolderview?id=${folderId}#list`, "drive-" + folderId); }
    catch (e) { console.log(`  drive folder fail: ${folderId} (${String(e && e.message).slice(0, 36)})`); continue; }
    // entries: <div class="flip-entry" id="entry-<id>">...<a href=".../folders/<id>">
    //          or ".../file/d/<id>" ... <div class="flip-entry-title">NAME</div></a>
    const entryRe = /<div class="flip-entry" id="entry-([A-Za-z0-9_-]+)"[\s\S]*?href="https:\/\/drive\.google\.com\/(?:drive\/)?(file\/d\/|folders\/)([A-Za-z0-9_-]+)[^"]*"[^>]*>[\s\S]*?<div class="flip-entry-title">([^<]+)<\/div>/g;
    let found = 0;
    for (const m of html.matchAll(entryRe)) {
      const isFile = m[2] === "file/d/";
      const id = m[3], name = m[4].trim();
      found++;
      if (!isFile) queue.push(id);
      else {
        const parsed = parseDriveName(name);
        cands.push({
          source: "drive", subject: parsed.subject, school: parsed.school, year: parsed.year, type: parsed.type,
          title: name, url: `https://drive.google.com/file/d/${id}/view`, hints: { driveFileId: id },
        });
      }
    }
    console.log(`  drive folder ${folderId.slice(0, 8)}...: +${found} entries (queue ${queue.length}, files total ${cands.length})`);
    fs.mkdirSync(DISCOVER, { recursive: true });
    fs.writeFileSync(path.join(DISCOVER, "drive.candidates.json"), JSON.stringify({ source: "drive", candidates: cands }, null, 1) + "\n");
  }
  console.log(`drive done: ${cands.length} candidates (folders walked: ${seenFolders.size})`);
}
function parseDriveName(name) {
  const base = normKey(name.replace(/\.pdf$/i, ""));
  const year = yearOf(base) || null;
  const type = /trial/i.test(base) ? "trial" : /internal(?! type)|assessment/i.test(base) ? "assessment" : year && year >= 1967 ? "hsc" : "other";
  const school = /trial|assessment|internal/.test(base) ? base.replace(String(year || ""), "").replace(/trial( paper(s)?)?|internal|assessment|-?\s*w\.?\s*?(sol(utions)?)?\b/gi, "").trim().replace(/\s+/g, " ") || null : null;
  let subject = null;
  const sub = { "mext1": "Mathematics Extension 1", "mext2": "Mathematics Extension 2", "adv": "Mathematics Advanced", "std": "Mathematics Standard", "ext1": "Maths Extension 1", "ext2": "Maths Extension 2", "chem": "Chemistry", "phys": "Physics", "bio": "Biology", "ees": "Earth and Environmental Science", "std2": "Mathematics Standard 2", "4u": "Mathematics Extension 2", "3u": "Mathematics Extension 1", "adv2u": "Mathematics Advanced" };
  for (const [token, nameNow] of Object.entries(sub)) if (new RegExp(`(^|[\\s.-])${token}([\\s.-]|$)`, "i").test(base)) { subject = nameNow; break; }
  return { year, type, school, subject: subject || (school && school.split(/\s+/)[0]) || null };
}

(async () => {
  const t0 = Date.now();
  const runners = { acehsc: runAcehsc, "4unitmaths": run4Unit, crest: runCrest, mirror: runMirror, drive: runDrive };
  const which = WHICH === "all" ? ["drive", "4unitmaths", "crest", "mirror", "acehsc"] : [WHICH];
  for (const nameNow of which) {
    console.log(`=== discover ${nameNow} ===`);
    try { await runners[nameNow](); }
    catch (e) { console.error(`discover ${nameNow} crashed: ${e && e.message}`); }
  }
  console.log(`elapsed ${Math.round((Date.now() - t0) / 1000)}s`);
})();
