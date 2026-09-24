/* HSCPapers index builder (Phase 1).
 *
 * Merges THSC catalogue metadata into ONE catalogue for the desktop app:
 *   1. Listing pages  (yr9-yr12 trialpapers, hscpapers, assessment-tasks pages)
 *      -> school sections + pdf(this, <viewno>) links (via GitHub raw, CDN)
 *   2. HSCpapers.json (thsconline/json) -> direct NESA doc links per course/year
 * Local test folders are intentionally EXCLUDED here (desktop pulls live data).
 *
 * Usage:
 *   node desktop/tools/build-index.js [--no-cache] [--limit=N]
 *
 * Output: desktop/ui/data/papers.json  (+ console verification report)
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");          // repo root (HSCPapers/)
const DESKTOP = path.resolve(__dirname, "..");             // desktop/
const SOURCES = JSON.parse(fs.readFileSync(path.join(DESKTOP, "sources.json"), "utf8"));
const CACHE = path.join(__dirname, ".cache");
const OUT = path.join(DESKTOP, "ui", "data", "papers.json");
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

/* Takedown registry (see TAKEDOWN.md): papers removed on valid rights-holder
   request are excluded from EVERY rebuild — removed papers never reappear
   via the nightly build. Match by catalogue id, primary URL or fallback URL
   (the same paper can carry different ids across sources). */
const REMOVALS = { ids: new Set(), urls: new Set() };
try {
  const rj = JSON.parse(fs.readFileSync(path.join(__dirname, "removals.json"), "utf8"));
  for (const r of (rj.entries || [])) {
    if (r.id) REMOVALS.ids.add(r.id);
    if (r.url) REMOVALS.urls.add(r.url);
  }
} catch { /* no registry yet — nothing removed */ }

const NO_CACHE = process.argv.includes("--no-cache");
const LIMIT = (() => {
  const m = process.argv.find((a) => a.startsWith("--limit="));
  return m ? Number(m.split("=")[1]) : Infinity;
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { "User-Agent": SOURCES.policy.userAgent };

async function cached(key, url, { api = false } = {}) {
  const file = path.join(CACHE, key);
  if (!NO_CACHE && fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  await sleep(SOURCES.policy.metaDelayMs);
  // Hard per-request timeout — web.archive.org can hang otherwise.
  const signal = typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined;
  const r = await fetch(url, { headers: api ? { ...UA, Accept: "application/vnd.github+json" } : UA, signal });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  const t = await r.text();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, t);
  return t;
}

/* ---------- subject / type / level from PATH ---------- */
const stripTags = (s) => String(s || "").replace(/<[^>]+>/g, "").replace(/&nbsp;?/g, " ").replace(/\s+/g, " ").trim();
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "x";
// dir name is the subject base; filename suffix refines it (robust —
// page <title> text is only a last-resort fallback).
const DIR_SUBJECT = {
  "maths": "Mathematics", "english": "English", "english ext 1": "English Extension 1",
  "biology": "Biology", "chemistry": "Chemistry", "physics": "Physics",
  "economics": "Economics", "engineering studies": "Engineering Studies",
  "agriculture": "Agriculture", "ancient history": "Ancient History",
  "business studies": "Business Studies", "earth & environmental science": "Earth & Environmental Science",
  "history extension": "History Extension", "ipt": "Information Processes & Technology",
  "investigating science": "Investigating Science", "legal studies": "Legal Studies",
  "modern history": "Modern History", "pdhpe": "PDHPE",
  "society & culture": "Society & Culture", "software": "Software Design & Development",
  "studies of religion": "Studies of Religion", "visual arts": "Visual Arts",
};
const LEVEL = { yr9: "Year 9", yr10: "Year 10", yr11: "Preliminary", yr12: "HSC" };
function subjectFromPath(pagePath, pageTitle) {
  const m = pagePath.match(/^(yr\d+)\/(.+?)\/([^/]+)\.html$/i);
  const file = (m ? m[3] : pagePath).toLowerCase();
  const dirRaw = m ? m[2] : "";
  const dirKey = dirRaw.toLowerCase();
  const level = (m && LEVEL[m[1].toLowerCase()]) || "";
  const S = (q) => ({ subject: q, level, via: "path" });

  if (dirKey === "maths") {
    if (level === "Year 9" || level === "Year 10") return S("Mathematics");
    if (/extension2/.test(file)) return S("Mathematics Extension 2");
    if (/extension1/.test(file)) return S("Mathematics Extension 1");
    if (/advanced|accelerated/.test(file)) return S("Mathematics Advanced");
    return S("Mathematics Standard"); // general / assessment default (pre-2019 General merged; noted in README)
  }
  if (dirKey === "english") {
    if (/paper2_standard/.test(file)) return S("English Standard");
    if (/paper2_advanced/.test(file)) return S("English Advanced");
    if (/paper1/.test(file)) return S("English Paper 1");
    return S("English");
  }
  if (dirKey === "lote/japanese") {
    if (/beginners/.test(file)) return S("Japanese Beginners");
    if (/extension/.test(file)) return S("Japanese Extension");
    return S("Japanese Continuers");
  }
  if (dirKey === "lote/latin") {
    if (/extension/.test(file)) return S("Latin Extension");
    return S("Latin Continuers");
  }
  if (dirKey === "studies of religion") {
    if (/sor1/.test(file)) return S("Studies of Religion I");
    if (/sor2/.test(file)) return S("Studies of Religion II");
    return S("Studies of Religion");
  }
  if (DIR_SUBJECT[dirKey]) return S(DIR_SUBJECT[dirKey]);

  // fallback: tidy the page title (careful: suffix patterns must not match mid-string)
  let t = (pageTitle || "")
    .replace(/^THSC\s*Online\s*[-–:]\s*/i, "")
    .replace(/\s*[-–:]\s*THSC\s*Online\s*$/i, "")
    .replace(/\s+(Trial Papers|Past Trials|HSC Papers|Past Assessment Tasks|Assessment Tasks|Trial Paper.+|Papers?)$/i, "")
    .replace(/^(HSC|Year \d+|Preliminary)\s+/i, "")
    .trim();
  return { subject: t || pageTitle || pagePath, level, via: "title-fallback" };
}

/* ---------- listing page parser ----------
   Handles BOTH site structures:
   A. <details><summary>School</summary> …pdf(this, N) links… </details>  (trial/hsc pages)
   B. <tr><td>School<br><span class="content"> …links… </span></td></tr>   (assessment pages)
   <h5> section headers (e.g. Half-Yearly Exams) are captured as examBlock. */
// Entities are decoded for DISPLAY titles only — linkText/id/url keep the
// raw text so resolution matches what the site's own resolver expects.
const decodeEnt = (s) => String(s || "")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");
function parseListing(pagePath, html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  const type = /trialpapers/i.test(pagePath) ? "trial"
    : /hscpapers/i.test(pagePath) ? "hsc"
    : /assessment-tasks/i.test(pagePath) ? "assessment" : "other";
  const { subject, level, via } = subjectFromPath(pagePath, stripTags(title));
  const typeLabel = type === "trial" ? "Trial" : type === "hsc" ? "HSC" : "Assessment";
  const entries = [];
  let oddAnchors = 0;

  const isYearGroup = (s) => /^\d{4}(\s*[–\-]\s*\d{2,4})?$/.test(s) || /syllabus|note:/i.test(s || "");
  const yearOf = (text) => {
    const ym = String(text || "").match(/\b((?:19|20)\d{2})\b/);
    return ym ? Number(ym[1]) : null;
  };
  const dlUrl = (viewno, linkText) =>
    SOURCES.trialPipeline.downloadEndpoint.replace("{viewno}", viewno).replace("{title}", encodeURIComponent(linkText));

  function makeEntry({ viewno, linkText, school, examBlock }) {
    const year = yearOf(linkText) || yearOf(school);
    const realSchool = isYearGroup(school) || !school ? "NESA" : school;
    const hasSolutions = /w\.\s*sol|solutions?|marking|guidelines|sample answers/i.test(linkText);
    const isSolDoc = realSchool === "NESA" && /marking|guidelines|sample|solutions|answers|notes/i.test(linkText);
    let display;
    if (isSolDoc) display = `${year ? year + " " : ""}${subject} ${typeLabel} Solutions`;
    else if (year && realSchool !== "NESA") display = `${year} ${realSchool} ${subject} ${typeLabel}`;
    else if (year) display = `${year} ${subject} ${typeLabel}`;
    else display = linkText;
    if (examBlock) display += ` (${examBlock})`;
    const schoolGuess = realSchool !== "NESA" && year && linkText.includes(String(year))
      ? linkText.slice(0, linkText.indexOf(String(year))).trim() || realSchool
      : realSchool;
    entries.push({
      viewno, linkText, title: decodeEnt(display), subject, level,
      school: schoolGuess, year, type, hasSolutions, examBlock: examBlock || "",
      url: dlUrl(viewno, linkText), source: "thsc-listing", page: pagePath,
    });
  }

  // Pass A: details blocks
  const spans = [...html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/gi)];
  for (const sp of spans) {
    const body = sp[0];
    const summary = stripTags((body.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [])[1] || "");
    for (const a of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
      const mm = a[1].match(/pdf\(this,\s*(\d+)\)/i);
      const text = stripTags(a[2]);
      if (!mm || !text) { if (text && text.length > 1) oddAnchors++; continue; }
      makeEntry({ viewno: mm[1], linkText: text, school: summary, examBlock: "" });
    }
  }

  // Pass B: blank out details, then walk <td>School<br> + <h5> markers in order
  let rest = html;
  for (let i = spans.length - 1; i >= 0; i--) {
    const sp = spans[i];
    rest = rest.slice(0, sp.index) + " ".repeat(sp[0].length) + rest.slice(sp.index + sp[0].length);
  }
  const markers = [];
  for (const m of rest.matchAll(/<h5[^>]*>([\s\S]*?)<\/h5>|<td[^>]*>\s*([^<>]{1,60})<br\s*\/?>/gi)) {
    const txt = stripTags(m[1] !== undefined ? m[1] : m[2]);
    if (!txt || /upload files|practice questions/i.test(txt)) continue;
    markers.push({ index: m.index, kind: m[1] !== undefined ? "section" : "school", text: txt });
  }
  const anchors = [];
  for (const a of rest.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const mm = a[1].match(/pdf\(this,\s*(\d+)\)/i);
    const text = stripTags(a[2]);
    if (!mm || !text) { if (text && text.length > 1 && /w\. sol|^\d{4}|trials?|hsc/i.test(text)) oddAnchors++; continue; }
    anchors.push({ index: a.index, viewno: mm[1], linkText: text });
  }
  let curSchool = "NESA", curSection = ""; // papers listed before any school header are board (NESA) papers
  let mi = 0;
  markers.sort((a, b) => a.index - b.index);
  for (const an of anchors) {
    while (mi < markers.length && markers[mi].index < an.index) {
      if (markers[mi].kind === "school") curSchool = markers[mi].text;
      else curSection = markers[mi].text.replace(/\s*(Exams?|Tests?)$/i, "");
      mi++;
    }
    makeEntry({ viewno: an.viewno, linkText: an.linkText, school: curSchool, examBlock: curSection });
  }

  return { subject, level, via, type, entries, oddAnchors, detailsBlocks: spans.length };
}

/* ---------- main ---------- */
if (require.main === module) {
(async () => {
  const report = { pages: [], unmappedSubjects: {}, oddAnchors: 0 };
  const papers = [];
  const seen = new Set();
  const push = (p) => {
    let id = p.id;
    let n = 2;
    while (seen.has(id)) id = `${p.id}-${n++}`;
    seen.add(id);
    papers.push({ ...p, id });
  };

  // 1. repo tree -> listing pages
  const treeRaw = await cached("tree.json", SOURCES.github.treeApi, { api: true });
  const tree = (JSON.parse(treeRaw).tree || []).map((e) => e.path);
  const pages = tree.filter((p) =>
    /^yr(9|10|11|12)\//.test(p) &&
    /(trialpapers|hscpapers|assessment-tasks).*\.html$/i.test(p)).sort();
  console.log(`listing pages found: ${pages.length}`);

  // 2. parse pages
  const targets = pages.slice(0, LIMIT);
  let done = 0;
  for (const page of targets) {
    const key = "pages-" + slug(page) + ".html";
    const html = await cached(key, `${SOURCES.github.rawBase}/${page}`);
    const r = parseListing(page, html);
    report.pages.push({ page, subject: r.subject, via: r.via, type: r.type, entries: r.entries.length });
    if (r.via === "title-fallback") report.unmappedSubjects[page] = r.subject;
    report.oddAnchors += r.oddAnchors;
    for (const e of r.entries) {
      push({
        id: `thsc-${e.viewno}-${slug(e.linkText)}`,
        subject: e.subject, level: e.level || undefined, examBlock: e.examBlock || undefined,
        year: e.year, school: e.school, type: e.type,
        title: e.title, url: e.url, solutionPath: "", size: "",
        hasSolutions: e.hasSolutions, source: e.source,
      });
    }
    if (++done % 25 === 0) console.log(`  parsed ${done}/${targets.length} pages...`);
  }

  // 3. HSCpapers.json (direct NESA links)
  const hscRaw = await cached("HSCpapers.json", SOURCES.hscIndex.raw);
  const hsc = JSON.parse(hscRaw);
  const nesaKeys = new Set();
  let nesaCount = 0;
  // subject|year -> {paperUrl, solKinds}, for deduping listing-hsc twins
  // (speed: matched papers skip the throttled THSC resolver entirely via
  // direct NESA URLs).
  const nesaIndex = new Map();
  const nesaKind = (n) =>
    /marking guideline/i.test(n) ? "mg" :
    /sample answer/i.test(n) ? "sa" :
    /notes|feedback/i.test(n) ? "nfc" : null;
  for (const course of hsc) {
    for (const pack of course.packs || []) {
      const year = Number(pack.year);
      const docs = pack.docs || [];
      const isPaper = (n) => /exam paper/i.test(n) && !/transcript|listening|oral|speaking|candidate|examiner/i.test(n);
      const isSol = (n) => /marking guidelines|sample answers|notes from the marking centre/i.test(n);
      const paperDocs = docs.filter((d) => isPaper(d.doc_name));
      const solDocs = docs.filter((d) => isSol(d.doc_name));
      for (const d of (paperDocs.length ? paperDocs : docs.slice(0, 1))) {
        const sol = solDocs[0];
        push({
          id: `hsc-${year || "na"}-${slug(course.course_name)}-${slug(d.doc_name)}`,
          subject: course.course_name, level: "HSC", year: year || null, school: "NESA", type: "hsc",
          title: `${pack.year} ${course.course_name} ${d.doc_name}`,
          url: d.doc_link, solutionUrl: sol ? sol.doc_link : "",
          solutionPath: "", size: "",
          hasSolutions: !!sol, source: "nesa",
        });
        nesaCount++;
        const key = `${course.course_name.toLowerCase()}|${year}`;
        if (!nesaIndex.has(key)) {
          nesaIndex.set(key, {
            paperUrl: paperDocs.length ? paperDocs[0].doc_link : "",
            solKinds: new Set(solDocs.map((x) => nesaKind(x.doc_name)).filter(Boolean)),
          });
        }
        nesaKeys.add(`${course.course_name}|${pack.year}`);
      }
    }
  }

  // (listing-hsc twin dedupe now runs AFTER the mirror layer — see step (vii)
  // below — so dropped listing twins can hand their fast mirror URLs to the
  // surviving NESA entry instead of losing them to a dead wcm primary.)

  /* 3c. Mirror layer — fast direct URLs for matched papers.
   * Priority: NESA direct (already in catalogue) > HSC Portal (hscportal.pages.dev,
   * matched via THSC viewno + link text) > PapersDB (cdn.papersdb.org, matched via
   * subject/school/year). Matched entries keep their THSC router URL as
   * `fallbackUrl` so the app can degrade to the slow-but-official path. */

  // (i) HSC Portal: one cached fetch, exact match on (viewno | normalised link text)
  const portalRaw = await cached("hscportal-papers.json", SOURCES.mirrors.hscportal.catalogue);
  const portal = JSON.parse(portalRaw);
  const normKey = (s) => String(s || "").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim().toLowerCase();
  const portalByKey = new Map();
  for (const e of (portal.papers || [])) {
    if (!e.v || !e.n || !e.cf) continue;
    const key = `${e.v}|${normKey(e.n)}`;
    if (!portalByKey.has(key)) portalByKey.set(key, e);
  }
  const portalUsedKeys = new Set();
  const linkPortal = (p, e) => {
    p.fallbackUrl = p.fallbackUrl || p.url;
    p.url = `https://hscportal.pages.dev/${e.cf.split("/").map(encodeURIComponent).join("/")}`;
    p.mirror = "hscportal";
  };
  let portalMatched = 0;
  for (const p of papers) {
    if (p.source !== "thsc-listing") continue;
    const m = (p.url || "").match(/\/s\/d\/(\d+)\/(.+)$/);
    if (!m) continue;
    let linkText;
    try { linkText = decodeURIComponent(m[2]); } catch { linkText = m[2]; }
    const key = `${m[1]}|${normKey(linkText)}`;
    const e = portalByKey.get(key);
    if (e) {
      linkPortal(p, e);
      portalUsedKeys.add(key);
      portalMatched++;
    }
  }
  console.log(`mirror-hscportal: ${portalMatched} papers -> direct CDN URLs (exact viewno+title match only)`);

  // (ii) PapersDB: crawl the server-rendered /browse tree — Trials, HSC and
  // Y11/Y12 Internals. Filenames follow THSC's Drive naming:
  // <School> <Year> <Subject> Trials[ & Solutions].pdf / HSC <Year> <Subject>[ & Solutions].pdf
  const PDB = SOURCES.mirrors.papersdb;
  const pdbTrials = new Map();    // normSubject|normSchool|year -> {url, sol}
  const pdbHSC = new Map();       // normSubject|year -> {url, sol}
  const pdbInternals = new Map(); // normSubject|normSchool|year -> {url, sol}
  const pdbSubjects = (PDB.subjects || []).filter((s) => s !== "Miscellaneous");
  const SCHOOL_ALIASES = {
    "pymble": ["presbyterian", "pymble ladies", "plc sydney"],
    "presbyterian": ["pymble"],
    "hurlstone": ["hurlstone agricultural high", "hurlstone ag"],
    "fort st": ["fort street", "fort street high", "fort st high"],
    "sydney tech": ["sydney technology high", "sydney technical high"],
    "james ruse": ["james ruse agricultural high"],
    "sydney boys": ["sydney boys high"],
    "sydney girls": ["sydney girls high"],
    "north sydney boys": ["north sydney boys high"],
    "north sydney girls": ["north sydney girls high"],
    "normanhurst boys": ["normanhurst boys high"],
    "st george girls": ["st george girls high"],
    "baulkham hills": ["baulkham hills high"],
    "cafs": ["community and family studies"],
  };
  const schoolKeys = (name) => {
    const k = normKey(name);
    const out = new Set([k]);
    for (const [base, list] of Object.entries(SCHOOL_ALIASES)) {
      if (k === base) list.forEach((x) => out.add(normKey(x)));
      else if (list.map(normKey).includes(k)) out.add(base);
    }
    return [...out];
  };
  const pdbFileUrl = (u) => {
    const fname = decodeURIComponent(u.split("?")[0].split("/").pop());
    return { fname, url: u };
  };
  for (const subject of pdbSubjects) {
    try {
      // Trials: type page -> school pages
      const trialsHtml = await cached("pdb-t-" + slug(subject) + ".html", `${PDB.base}/browse/${encodeURIComponent(subject)}/Trials`);
      const schools = [...trialsHtml.matchAll(/href="\/browse\/[^"]+\/Trials\/([^"]+)"/g)]
        .map((m2) => decodeURIComponent(m2[1].replace(/%20/g, " ")));
      for (const school of [...new Set(schools)]) {
        const schoolHtml = await cached(
          `pdb-ts-${slug(subject)}-${slug(school)}.html`,
          `${PDB.base}/browse/${encodeURIComponent(subject)}/Trials/${encodeURIComponent(school)}`
        );
        for (const a of schoolHtml.matchAll(/href="(https:\/\/cdn\.papersdb\.org\/[^"]+\.pdf)"/g)) {
          const { fname, url } = pdbFileUrl(a[1]);
          const fm = fname.match(/^(.+?)\s+((?:19|20)\d{2})\s+(.+?)\s+Trials(\s*&\s*Solutions)?\.pdf$/i);
          if (!fm) continue;
          pdbTrials.set(`${normKey(subject)}|${normKey(fm[1])}|${Number(fm[2])}`, { url, sol: !!fm[4] });
        }
      }
    } catch (e) { console.log(`  papersdb trials: skipped ${subject} (${e.message})`); }
    try {
      // HSC: files sit directly on the type page
      const hHtml = await cached("pdb-h-" + slug(subject) + ".html", `${PDB.base}/browse/${encodeURIComponent(subject)}/HSC`);
      for (const a of hHtml.matchAll(/href="(https:\/\/cdn\.papersdb\.org\/[^"]+\.pdf)"/g)) {
        const { fname, url } = pdbFileUrl(a[1]);
        const fm = fname.match(/^(?:(.+?)\s+)?((?:19|20)\d{2})\s+(.+?)\s+HSC(\s*&\s*Solutions)?\.pdf$/i);
        if (!fm) continue;
        const key = `${normKey(subject)}|${Number(fm[2])}`;
        if (!pdbHSC.has(key)) pdbHSC.set(key, { url, sol: !!fm[4] });
      }
    } catch (e) { console.log(`  papersdb hsc: skipped ${subject} (${e.message})`); }
    for (const [dir, level] of [["Y11 Internals", "Preliminary"], ["Y12 Internals", "HSC"]]) {
      try {
        const lvlKey = level === "Preliminary" ? "11" : "12";
        const tHtml = await cached(`pdb-i${lvlKey}-${slug(subject)}.html`, `${PDB.base}/browse/${encodeURIComponent(subject)}/${encodeURIComponent(dir)}`);
        const intSchools = [...tHtml.matchAll(new RegExp(`href="/browse/[^"]+/${dir.replace(/ /g, "%20")}/([^"]+)"`, "g"))]
          .map((m2) => decodeURIComponent(m2[1].replace(/%20/g, " ")));
        const pages = [...new Set(intSchools)].length
          ? [...new Set(intSchools)].map((school) => ({ school, html: null, url: `${PDB.base}/browse/${encodeURIComponent(subject)}/${encodeURIComponent(dir)}/${encodeURIComponent(school)}`, cacheKey: `pdb-i${lvlKey}-${slug(subject)}-${slug(school)}.html` }))
          : [{ school: "", html: tHtml, url: null, cacheKey: null }];
        for (const pg of pages) {
          const html = pg.html !== null ? pg.html : await cached(pg.cacheKey, pg.url);
          for (const a of html.matchAll(/href="(https:\/\/cdn\.papersdb\.org\/[^"]+\.pdf)"/g)) {
            const { fname, url } = pdbFileUrl(a[1]);
            const fm = fname.match(/^(?:(.+?)\s+)?((?:19|20)\d{2})\s+(.+?)\.pdf$/i);
            if (!fm) continue;
            const school2 = pg.school || (fm[1] && !/^(?:19|20)\d{2}$/.test(fm[1]) ? fm[1].trim() : "NESA");
            const key = `${normKey(subject)}|${normKey(school2)}|${Number(fm[2])}`;
            if (!pdbInternals.has(key)) pdbInternals.set(key, { url, sol: /&\s*solutions/i.test(fname), school2, subject, year: Number(fm[2]), level });
          }
        }
      } catch (e) { console.log(`  papersdb ${dir}: skipped ${subject} (${e.message})`); }
    }
  }

  // (iii) PapersDB matching: trials -> Trials, hsc -> HSC, assessment -> Internals
  const pdbUsedUrls = new Set();
  const tryMirror = (p, hit, name) => {
    if (!hit) return false;
    p.fallbackUrl = p.fallbackUrl || p.url;
    p.url = hit.url;
    p.mirror = name;
    pdbUsedUrls.add(hit.url);
    return true;
  };
  let pdbMatched = 0;
  for (const p of papers) {
    if (p.mirror || p.source !== "thsc-listing" || !p.year) continue;
    if (p.type === "trial") {
      for (const k of schoolKeys(p.school)) {
        const hit = pdbTrials.get(`${normKey(p.subject)}|${k}|${p.year}`);
        if (hit && tryMirror(p, hit, "papersdb")) { pdbMatched++; break; }
      }
    } else if (p.type === "hsc") {
      const hit = pdbHSC.get(`${normKey(p.subject)}|${p.year}`);
      if (hit && tryMirror(p, hit, "papersdb")) pdbMatched++;
    } else if (p.type === "assessment") {
      const dirs = p.level === "Preliminary" ? ["11"] : p.level === "HSC" ? ["12"] : ["11", "12"];
      for (const d of dirs) {
        for (const k of schoolKeys(p.school)) {
          const hit = pdbInternals.get(`${normKey(p.subject)}|${k}|${p.year}`);
          if (hit && tryMirror(p, hit, "papersdb")) { pdbMatched++; break; }
        }
        if (p.mirror) break;
      }
    }
  }
  console.log(`mirror-papersdb: ${pdbMatched} additional papers -> direct CDN URLs`);

  // (iv) Unique harvest — papers the mirrors hold that THSC's listing crawl
  // doesn't (portal's practice/other pages, PapersDB extras). These become
  // NEW catalogue entries with the THSC router URL kept as fallback.
  const haveKey = new Set(papers.map((p) => `${normKey(p.subject)}|${normKey(p.school)}|${p.year}|${p.type}`));
  const PORTAL_SUBJECT_MAP = {
    "maths 2u": "Mathematics Advanced", "maths (2u)": "Mathematics Advanced",
    "maths ext 1": "Mathematics Extension 1", "maths ext 2": "Mathematics Extension 2",
    "standard maths": "Mathematics Standard", "general maths": "Mathematics Standard",
    "english ext 1": "English Extension 1",
    "ipt": "Information Processes & Technology",
    "software engineering": "Software Design & Development",
    "studies of religion 1": "Studies of Religion I", "studies of religion 2": "Studies of Religion II",
  };
  const subjectsArr = portal.subjects || [];
  const schoolsArr = portal.schools || [];
  let addedPortal = 0;
  for (const e of (portal.papers || [])) {
    if (!e.v || !e.n || !e.cf) continue;
    const key = `${e.v}|${normKey(e.n)}`;
    if (portalUsedKeys.has(key)) continue;
    portalUsedKeys.add(key);
    let subject = subjectsArr[e.s] || "Miscellaneous";
    subject = PORTAL_SUBJECT_MAP[normKey(subject)] || subject;
    let school = Number.isInteger(e.h) ? (schoolsArr[e.h] || "") : "";
    if (!school) {
      const ym = String(e.y || "");
      const i = ym ? e.n.indexOf(ym) : -1;
      school = i > 0 ? e.n.slice(0, i).replace(/[-–,]\s*$/, "").trim() : "NESA";
    }
    if (/^(?:19|20)\d{2}\b/.test(school) || !school) school = "NESA";
    const type = e.c === "T" ? "trial" : e.c === "A" ? "assessment" : "other";
    const ukey = `${normKey(subject)}|${normKey(school)}|${e.y || "na"}|${type}`;
    if (haveKey.has(ukey)) continue;
    haveKey.add(ukey);
    push({
      id: `portal-${e.v}-${slug(e.n)}`,
      subject, level: e.l === 12 ? "HSC" : e.l === 11 ? "Preliminary" : undefined,
      year: e.y || null, school, type,
      title: decodeEnt(e.n),
      url: `https://hscportal.pages.dev/${e.cf.split("/").map(encodeURIComponent).join("/")}`,
      fallbackUrl: `${SOURCES.trialPipeline.downloadEndpoint.replace("{viewno}", e.v).replace("{title}", encodeURIComponent(e.n))}`,
      solutionPath: "", size: "", hasSolutions: e.w === 1,
      source: "hscportal-unique", mirror: "hscportal",
    });
    addedPortal++;
  }
  console.log(`unique-hscportal: +${addedPortal} papers (practice/other not in THSC listing crawl)`);

  // (ivb) Portal solutions harvest — the portal mirrors 5,161 "w. sol"
  // solution files that our catalogue only carries when THSC's listing shows
  // them inline. Sols already in the catalogue (own entry, any route) are
  // skipped. Otherwise: attach to the parent paper when the
  // (subject|school|year|type) relation is UNAMBIGUOUS (exactly one paper
  // candidate — no fuzzy matching); the rest become standalone entries
  // (cf-deduped, since the portal cross-lists files under several pages).
  const ourRouterKeys = new Set();
  for (const p of papers) {
    for (const u of [p.url, p.fallbackUrl, p.solutionUrl, p.solFallbackUrl]) {
      const m = (u || "").match(/\/s\/d\/(\d+)\/(.+)$/);
      if (!m) continue;
      let lt; try { lt = decodeURIComponent(m[2]); } catch { lt = m[2]; }
      ourRouterKeys.add(`${m[1]}|${normKey(lt)}`);
    }
  }
  const ourParentIndex = new Map(); // subject|school|year|type -> [entries]
  for (const p of papers) {
    if (!p.url || /w\.\s*sol/i.test(p.title || "")) continue;
    const k = `${normKey(p.subject)}|${normKey(p.school)}|${p.year}|${p.type}`;
    if (!ourParentIndex.has(k)) ourParentIndex.set(k, []);
    ourParentIndex.get(k).push(p);
  }
  const cdnFor = (e) => `https://hscportal.pages.dev/${e.cf.split("/").map(encodeURIComponent).join("/")}`;
  const routerFor = (e) => SOURCES.trialPipeline.downloadEndpoint.replace("{viewno}", e.v).replace("{title}", encodeURIComponent(e.n));
  const solTitleRe = /^(.*?)\s+((?:19|20)\d{2})\s+w\.\s*sol\s*$/i;
  let solAttached = 0, solStandalone = 0, solAlready = 0, solAmbiguous = 0;
  const solHaveKey = new Set();
  const solUrlSeen = new Set();
  for (const e of (portal.papers || [])) {
    if (!e.v || !e.n || !e.cf) continue;
    const sm = String(e.n).match(solTitleRe);
    if (!sm) continue;
    const url = cdnFor(e);
    if (ourRouterKeys.has(`${e.v}|${normKey(e.n)}`)) { solAlready++; continue; }
    let subject = subjectsArr[e.s] || "Miscellaneous";
    subject = PORTAL_SUBJECT_MAP[normKey(subject)] || subject;
    let school = Number.isInteger(e.h) ? (schoolsArr[e.h] || "") : "";
    if (!school) school = sm[1].replace(/[-–,]\s*$/, "").trim() || "NESA";
    if (/^(?:19|20)\d{2}\b/.test(school) || !school) school = "NESA";
    const type = e.c === "T" ? "trial" : e.c === "A" ? "assessment" : "other";
    const year = e.y || Number(sm[2]);
    // Attach: exactly one catalogue paper for (subject|school|year|type)
    // whose solution route is missing (empty) or dead (wcm).
    const cands = (ourParentIndex.get(`${normKey(subject)}|${normKey(school)}|${year}|${type}`) || [])
      .filter((p) => !p.solutionUrl || /educationstandards\.nsw\.edu\.au/.test(p.solutionUrl));
    if (cands.length === 1) {
      const p = cands[0];
      p.solutionUrl = url;
      p.hasSolutions = true;
      solAttached++;
      continue;
    }
    if (cands.length > 1) { solAmbiguous++; }
    if (solUrlSeen.has(url)) continue;
    solUrlSeen.add(url);
    const skey = `${normKey(subject)}|${normKey(school)}|${year}|${type}|SOL`;
    if (solHaveKey.has(skey)) continue;
    solHaveKey.add(skey);
    push({
      id: `portal-sol-${e.v}-${slug(e.n)}`,
      subject, level: e.l === 12 ? "HSC" : e.l === 11 ? "Preliminary" : undefined,
      year, school, type,
      title: decodeEnt(e.n),
      url,
      fallbackUrl: routerFor(e),
      solutionPath: "", size: "", hasSolutions: false,
      source: "hscportal-sol", mirror: "hscportal",
    });
    solStandalone++;
  }
  console.log(`unique-hscportal-sol: ${solAttached} attached to parent papers, +${solStandalone} standalone solution files (${solAlready} already in catalogue, ${solAmbiguous} ambiguous)`);

  let addedPdb = 0;
  for (const [key, hit] of [...pdbTrials, ...pdbHSC, ...pdbInternals]) {
    if (pdbUsedUrls.has(hit.url)) continue;
    const [nSubject, nSchool, nYear] = key.split("|");
    const subject = nSubject.replace(/\b\w/g, (c) => c.toUpperCase());
    const school = nSchool.replace(/\b\w/g, (c) => c.toUpperCase());
    const year = Number(nYear);
    const isTrial = pdbTrials.get(key) === hit;
    const type = isTrial ? "trial" : pdbHSC.get(key) === hit ? "hsc" : "assessment";
    const ukey = `${normKey(subject)}|${normKey(school)}|${year}|${type}`;
    if (haveKey.has(ukey)) continue;
    haveKey.add(ukey);
    pdbUsedUrls.add(hit.url);
    push({
      id: `pdb-${year || "na"}-${slug(subject)}-${slug(school)}`,
      subject, year, school, type,
      title: `${year} ${school} ${subject} ${type === "trial" ? "Trial" : type === "hsc" ? "HSC" : "Assessment"}`,
      url: hit.url, fallbackUrl: "", solutionPath: "", size: "",
      hasSolutions: !!hit.sol, source: "papersdb-unique", mirror: "papersdb",
    });
    addedPdb++;
  }
  console.log(`unique-papersdb: +${addedPdb} papers not present in the THSC listing crawl`);

  // (v) Board of Studies direct harvest (2000-2015) — THSC's own admin script
  // (admin_scripts/thsc_paper_update_json.ps1) builds its index JSONs by
  // scraping the same pages; the URLs are direct and unthrottled. Rows carry
  // the subject in the first cell in BOTH the 2011-table and 2013-anchor eras.
  const bosAliases = [
    [/^mathematics$/, "Mathematics Advanced"], [/^maths$/, "Mathematics Advanced"],
    [/^mathematics extension 1$/, "Mathematics Extension 1"],
    [/^mathematics extension 2$/, "Mathematics Extension 2"],
    [/^general mathematics$/, "Mathematics Standard"],
    [/^earth (and|&) environmental science$/, "Earth & Environmental Science"],
    [/^personal development, health and physical education$/, "PDHPE"],
    [/^software design and development$/, "Software Design & Development"],
    [/^information processes and technology$/, "Information Processes & Technology"],
    [/^studies of religion i$/, "Studies of Religion I"],
    [/^studies of religion ii$/, "Studies of Religion II"],
    [/^english( \(standard and advanced\))?$/, "English"],
    [/^english \(standard\)$/, "English Standard"],
    [/^english \(advanced\)$/, "English Advanced"],
    [/^english \(esl\)$/, "English ESL"],
  ];
  const bosSubjectFor = (() => {
    // NESA course names are legit BOS row labels — accept any of them.
    const nesaNames = new Set(papers.filter((p) => p.source === "nesa").map((p) => normKey(p.subject)));
    return (name) => {
      const n = String(name || "").replace(/[\u2013\u2014]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
      if (!n || /^(?:19|20)\d{2}$/.test(n)) return null;
      for (const [re, subj] of bosAliases) if (re.test(n)) return subj;
      // exact passthrough for known course names (e.g. "Aboriginal Studies", "Biology")
      for (const known of nesaNames) {
        if (n === known) return known; // canonical = NESA course name (normalised)
      }
      return null;
    };
  })();
  const bosKindFor = (text) =>
    /marking guideline/i.test(text) ? "mg" :
    /sample answer/i.test(text) ? "sa" :
    /notes from the marking centre/i.test(text) ? "nfc" :
    /transcript|audio|listening|oral|specimen|workbook/i.test(text) ? null : "paper";
  const bosMap = new Map(); // normSubject|year|kind -> {url, text}
  for (let year = 2000; year <= 2015; year++) {
    const roots = [
      `https://www.boardofstudies.nsw.edu.au/hsc_exams/hsc${year}exams/`,
      `https://www.boardofstudies.nsw.edu.au/hsc_exams/${year}/`,
    ];
    // Old-era (2000-2012) indexes are split across letter-range pages
    // (index.html = a-d, index2.html = e-h, index3.html = i-l, index4.html
    // = m-v). Every page must be fetched — parsing only index.html loses
    // every subject from Engineering Studies to Vietnamese.
    const suffixes = ["index.html", ...(year <= 2012 ? ["index2.html", "index3.html", "index4.html"] : [])];
    let got = 0;
    for (const root of roots) {
      for (const sfx of suffixes) {
        const key = `bos-${year}-${slug(root.slice(8, 60))}-${slug(sfx)}.html`;
        let html = null;
        try { html = await cached(key, root + sfx); } catch { continue; }
        // NESA's 2026 migration 301s some BOS letter-range pages to a JS-only
        // shell (same as the dead /wcm/connect links) while the PDFs on the
        // same server stay live. Fall back to the 2017 Wayback snapshot.
        if (!/\.pdf/.test(html)) {
          try {
            html = await cached(`bos-${year}-wayback-${slug(sfx)}.html`, `https://web.archive.org/web/20171230134701/${root}${sfx}`);
          } catch { continue; }
        }
        got++;
        for (const r of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
          const firstCell = stripTags((r[1].split(/<\/td>|<\/th>/i)[0] || ""));
          const subject = bosSubjectFor(firstCell) || firstCell.replace(/[\u2013\u2014]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
          if (!subject) continue;
          for (const a of r[1].matchAll(/<a\b[^>]*href="([^"]+\.pdf)"[^>]*>([\s\S]*?)<\/a>/gi)) {
            const kind = bosKindFor(stripTags(a[2]));
            if (!kind) continue;
            let abs;
            try { abs = new URL(a[1].replace(/^\/\//, "https://"), root + sfx).href; } catch { continue; }
            if (!/^https:/.test(abs)) continue;
            bosPrefer(`${normKey(subject)}|${year}|${kind}`, abs, stripTags(a[2]));
          }
        }
      }
      if (got) break; // year found on this root; don't hit the fallback host
    }
  }
  function bosPrefer(key, url, text) {
    const prev = bosMap.get(key);
    const likeP1 = /paper\s*1|standard and advanced/i.test(text);
    if (!prev || (likeP1 && !/paper\s*1|standard and advanced/i.test(prev.text))) bosMap.set(key, { url, text });
  }
  // Candidate subject keys: NESA course names don't always match BOS row
  // labels ("Studies of Religion" vs rows "studies of religion i/ii",
  // "X & Y" vs "X and Y", "Chinese and Literature/Chinese Background
  // Speakers" vs separate rows, "Mathematics General" vs "general
  // mathematics"). Lookups stay EXACT per (subject|year|kind) — no fuzzy
  // content matching — so this can't attach a wrong file.
  const subjectCands = (s) => {
    const raw = String(s || "");
    const base = normKey(raw);
    const out = new Set([base]);
    for (const seg of raw.split(/\s*\/\s*/)) { const k = normKey(seg); if (k) out.add(k); }
    out.add(base.replace(/\s*&\s*/g, " and "));
    out.add(base.replace(/\s+and\s+/g, " & "));
    if (base === "studies of religion") { out.add("studies of religion i"); out.add("studies of religion ii"); }
    if (base === "mathematics general" || base === "mathematics standard" || base === "general mathematics") {
      out.add("mathematics standard"); out.add("general mathematics"); out.add("mathematics");
    }
    if (base === "esl") { out.add("english esl"); out.add("english as a second language"); out.add("english as a second language (esl)"); }
    if (base === "english esl") { out.add("esl"); out.add("english as a second language"); out.add("english as a second language (esl)"); }
    return [...out].filter(Boolean);
  };
  let bosMatched = 0;
  for (const p of papers) {
    if (p.mirror || !p.year || p.type !== "hsc" || p.source !== "thsc-listing") continue;
    const isSolDoc = p.hasSolutions && /solutions/i.test(p.title);
    const kinds = isSolDoc ? ["mg", "sa", "nfc"] : ["paper"];
    for (const cand of subjectCands(p.subject)) {
      let done = false;
      for (const kind of kinds) {
        const hit = bosMap.get(`${cand}|${p.year}|${kind}`);
        if (hit) {
          p.fallbackUrl = p.fallbackUrl || p.url;
          p.url = hit.url;
          p.mirror = "boardofstudies";
          bosMatched++;
          done = true;
          break;
        }
      }
      if (done) break;
    }
  }
  console.log(`mirror-boardofstudies: ${bosMatched} listing papers -> direct BOS URLs`);

  // (vii) Dedupe listing-hsc twins — runs AFTER the mirror layer. The same
  // HSC paper often appears BOTH on THSC's hscpapers listing pages AND in
  // NESA's JSON. Where the twin exists, drop the listing copy and merge its
  // value into the NESA entry: a mirror URL transfers (fast primary kept,
  // router URL becomes the fallback); a plain listing twin contributes its
  // router URL as the NESA fallback (the resolver is the only working route
  // for dead /wcm/connect links).
  const nesaByDoc = new Map(); // "subject|year" -> {paper: entry|null, solEntry: entry|null}
  for (const ne of papers.filter((x) => x.source === "nesa")) {
    const k = `${ne.subject.toLowerCase()}|${ne.year}`;
    if (!nesaByDoc.has(k)) nesaByDoc.set(k, { paper: null, solEntry: null });
    const rec = nesaByDoc.get(k);
    if (ne.url && !rec.paper) rec.paper = ne;               // url is always the exam paper doc
    if (ne.solutionUrl && !rec.solEntry) rec.solEntry = ne; // solutionUrl is the MG/sol doc
  }
  const keep = [];
  let deduped = 0, transferred = 0, fbPaper = 0, fbSol = 0;
  for (const p of papers) {
    if (p.source === "thsc-listing" && p.type === "hsc" && p.year) {
      const rec = nesaByDoc.get(`${String(p.subject).toLowerCase()}|${p.year}`);
      if (rec) {
        const isSolDoc = /solutions$|marking guideline|sample answer|notes|feedback/i.test(p.title);
        if (isSolDoc && rec.solEntry) {
          if (p.mirror && !rec.solEntry.mirror) {
            rec.solEntry.solutionUrl = p.url;
            rec.solEntry.solFallbackUrl = p.fallbackUrl || rec.solEntry.solFallbackUrl || "";
            rec.solEntry.mirror = p.mirror;
            transferred++;
          } else if (!rec.solEntry.solFallbackUrl) {
            rec.solEntry.solFallbackUrl = p.url;
            fbSol++;
          }
          deduped++;
          continue;
        }
        if (!isSolDoc && rec.paper) {
          if (p.mirror && !rec.paper.mirror) {
            rec.paper.fallbackUrl = p.fallbackUrl || rec.paper.fallbackUrl || "";
            rec.paper.url = p.url;
            rec.paper.mirror = p.mirror;
            transferred++;
          } else if (!rec.paper.fallbackUrl) {
            rec.paper.fallbackUrl = p.url;
            fbPaper++;
          }
          deduped++;
          continue;
        }
      }
    }
    keep.push(p);
  }
  console.log(`deduped ${deduped} listing-hsc twins (mirror transfers: ${transferred}, router fallbacks: paper ${fbPaper}, sol ${fbSol})`);
  papers.length = 0;
  papers.push(...keep);

  // (viii) Portal for NESA twins — NESA entries whose router fallback exists
  // on the portal CDN get a fast primary too (exact viewno+title match only).
  let portalNesa = 0;
  for (const p of papers) {
    if (p.mirror || p.source !== "nesa") continue;
    const m = (p.fallbackUrl || "").match(/\/s\/d\/(\d+)\/(.+)$/);
    if (!m) continue;
    let linkText;
    try { linkText = decodeURIComponent(m[2]); } catch { linkText = m[2]; }
    const e = portalByKey.get(`${m[1]}|${normKey(linkText)}`);
    if (e) { linkPortal(p, e); portalNesa++; }
  }
  console.log(`mirror-hscportal(nesa twins): ${portalNesa} NESA entries -> direct CDN URLs`);

  // (ix) BOS for still-mirrorless NESA entries — dead wcm primaries swap to
  // direct BOS URLs (2000-2015). The router fallback (if dedupe attached one)
  // is preserved; no wcm links are kept as fallbacks (they're all dead).
  let bosNesaPapers = 0, bosNesaSol = 0;
  for (const p of papers) {
    if (p.mirror || p.source !== "nesa" || !p.year || p.type !== "hsc") continue;
    for (const cand of subjectCands(p.subject)) {
      const hit = bosMap.get(`${cand}|${p.year}|paper`);
      if (hit) { p.url = hit.url; p.mirror = "boardofstudies"; bosNesaPapers++; break; }
    }
    if (p.solutionUrl) {
      for (const cand of subjectCands(p.subject)) {
        let replaced = false;
        for (const kind of ["mg", "sa", "nfc"]) {
          const hit = bosMap.get(`${cand}|${p.year}|${kind}`);
          if (hit) { p.solutionUrl = hit.url; bosNesaSol++; replaced = true; break; }
        }
        if (replaced) break;
      }
    }
  }
  console.log(`mirror-boardofstudies(nesa): ${bosNesaPapers} papers, ${bosNesaSol} solutions -> direct BOS URLs`);

  // (vi) URL dedupe — the same file can be listed on several THSC pages; it
  // must occupy exactly ONE catalogue entry/relpath (double-counted entries
  // otherwise inflate totals and share one library file).
  const seenUrls = new Set();
  const urlDeduped = [];
  let urlDups = 0;
  for (const p of papers) {
    if (p.url && seenUrls.has(p.url)) { urlDups++; continue; }
    if (p.url) seenUrls.add(p.url);
    urlDeduped.push(p);
  }
  if (urlDups) {
    console.log(`url-dedupe: removed ${urlDups} duplicate-URL entries`);
    papers.length = 0;
    papers.push(...urlDeduped);
  }
  // Takedowns: filter AFTER dedupe so the registry has final say.
  if (REMOVALS.ids.size || REMOVALS.urls.size) {
    const kept = papers.filter((p) =>
      !REMOVALS.ids.has(p.id) && !REMOVALS.urls.has(p.url) && !REMOVALS.urls.has(p.fallbackUrl));
    const removedN = papers.length - kept.length;
    if (removedN) console.log(`takedowns: excluded ${removedN} paper(s) per removals.json (permanent)`);
    papers.length = 0;
    papers.push(...kept);
  }
  const fastN = papers.filter((p) => p.mirror).length;
  const scriptN = papers.filter((p) => !p.mirror && /\/s\/d\//.test(p.url || "")).length;
  const deadN = papers.filter((p) => !p.mirror && /educationstandards\.nsw\.edu\.au/.test(p.url || "")).length;
  console.log(`routes: fast ${fastN} · script ${scriptN} · dead wcm ${deadN} · total ${papers.length}`);
  const isFastHost = (u) => /hscportal\.pages\.dev|cdn\.papersdb\.org|boardofstudies\.nsw\.edu\.au/.test(u || "");
  const fastFiles = papers.reduce((n, p) => n + (p.url && isFastHost(p.url) ? 1 : 0) + (p.solutionUrl && isFastHost(p.solutionUrl) ? 1 : 0), 0);
  const totalFiles = papers.reduce((n, p) => n + (p.url ? 1 : 0) + (p.solutionUrl ? 1 : 0), 0);
  console.log(`files: ${fastFiles}/${totalFiles} fast (papers + solutions)`);

  // 4. write catalogue
  const generated = new Date().toISOString();
  fs.writeFileSync(OUT, JSON.stringify({
    _comment: "Generated by desktop/tools/build-index.cjs. Sources: THSCOnline listings (official resolver, kept as fallbackUrl) + NESA direct + community mirrors acknowledged on THSC's homepage (HSC Portal hscportal.app, PapersDB papersdb.org). Papers belong to their schools/authors and NESA; mirrors are credited in-app.",
    generated, sources: "desktop/sources.json",
    papers,
  }, null, 1) + "\n");

  // 5. report
  const byType = {}, bySource = {}, bySubject = {};
  for (const p of papers) {
    byType[p.type] = (byType[p.type] || 0) + 1;
    bySource[p.source] = (bySource[p.source] || 0) + 1;
    bySubject[p.subject] = (bySubject[p.subject] || 0) + 1;
  }
  console.log("\n==== BUILD REPORT ====");
  console.log(`pages parsed: ${targets.length}/${pages.length} | papers: ${papers.length} | nesa docs: ${nesaCount}`);
  console.log("byType:", JSON.stringify(byType));
  console.log("bySource:", JSON.stringify(bySource));
  console.log(`subjects: ${Object.keys(bySubject).length} | odd anchors skipped: ${report.oddAnchors}`);
  console.log("top subjects:", Object.entries(bySubject).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${k} (${v})`).join(", "));
  const fallbacks = Object.entries(report.unmappedSubjects);
  console.log(`title-fallback pages needing review: ${fallbacks.length}`);
  for (const [pg, sj] of fallbacks.slice(0, 25)) console.log(`  ? ${pg} -> "${sj}"`);
  console.log("page map:");
  for (const p of report.pages) console.log(`  [${p.type}/${p.via}] ${p.page} -> "${p.subject}" (${p.entries})`);
  console.log("sample:", JSON.stringify(papers.slice(0, 2), null, 1).slice(0, 900));
  console.log(`wrote ${OUT}`);
})().catch((e) => { console.error("BUILD FAILED:", e.message); process.exit(1); });
}

module.exports = { parseListing, subjectFromPath, stripTags, slug };
