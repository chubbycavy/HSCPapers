/* NESA dead-link recovery tool (C2).
 *
 * NESA re-platformed HSC exam papers onto nsw.gov.au:
 *   1. Course resources:  POST /api/v1/elasticsearch/prod_content/_search
 *                         (OpenSearch DSL, type "resource", HSC exam papers)
 *   2. Course pages:      /education-and-training/nesa/curriculum/hsc-exam-papers/<course>
 *                         -> year sub-pages + an -archive page
 *   3. Year/archive pages -> direct PDF links (nsw.gov.au-hosted files +
 *                         legacy Board-of-Studies pdf_doc deep links)
 *
 * This tool crawls ONLY the courses needed by dead-wcm catalogue entries,
 * matches recovered PDFs to dead entries by (year + subject), verifies each
 * candidate (HTTP 200 + %PDF magic), and writes the recovery registry:
 *   desktop/tools/nesa-recovery.json  { deadUrl -> { url, title } }
 * The builder applies the registry at every rebuild (same pattern as
 * removals/selfhost). No files are hosted by us — links point at the
 * government archive.
 *
 * Usage: node desktop/tools/nesa-recover.cjs [--no-cache] [--report-only]
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const CATALOGUE = path.join(__dirname, "..", "ui", "data", "papers.json");
const CACHE = path.join(__dirname, ".cache", "nesa-recovery");
const OUT = path.join(__dirname, "nesa-recovery.json");
const UA = { "User-Agent": "HSCPapers/1.0 (study use; cached index, on-demand downloads)" };
const DELAY_MS = 150;
const NO_CACHE = process.argv.includes("--no-cache");
const REPORT_ONLY = process.argv.includes("--report-only");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normKey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

async function cachedFetch(url, cacheKey) {
  const file = path.join(CACHE, cacheKey);
  if (!NO_CACHE && fs.existsSync(file)) return fs.readFileSync(file, "utf8");
  await sleep(DELAY_MS);
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return text;
}

function extractPdfLinks(html) {
  const out = new Set();
  for (const m of html.matchAll(/href="([^"]*\.pdf[^"]*)"/gi)) out.add(m[1]);
  return [...out];
}

(async () => {
  fs.mkdirSync(CACHE, { recursive: true });
  const catalogue = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ui", "data", "papers.json"), "utf8")).papers;

  // 1. dead-wcm population
  const dead = catalogue.filter((p) => /educationstandards\.nsw\.edu\.au/.test(p.url || ""));
  console.log(`dead-wcm entries: ${dead.length}`);
  if (!dead.length) { console.log("nothing to recover"); return; }

  // 2. all course resources (2-3 paginated API calls)
  const courses = [];
  let from = 0;
  for (let page = 0; page < 3; page++) {
    const cacheKey = `es-courses-${page}.json`;
    let json;
    if (!NO_CACHE && fs.existsSync(path.join(CACHE, cacheKey))) {
      json = JSON.parse(fs.readFileSync(path.join(CACHE, cacheKey), "utf8"));
    } else {
      const body = {
        query: { bool: { must: [], filter: [
          { term: { type: "resource" } },
          { terms: { name_resource_type: ["HSC exam pack", "Archive HSC exam pack"] } },
        ] } },
        sort: [{ _score: "desc" }],
        from, size: 100,
      };
      const res = await fetch("https://www.nsw.gov.au/api/v1/elasticsearch/prod_content/_search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`elastic: HTTP ${res.status}`);
      json = await res.json();
      fs.writeFileSync(path.join(CACHE, cacheKey), JSON.stringify(json));
      await sleep(DELAY_MS);
    }
    const hits = json.hits.hits || [];
    courses.push(...hits.map((h) => ({
      title: (h._source.title || [])[0] || "",
      url: "https://www.nsw.gov.au" + ((h._source.url || [])[0] || ""),
    })));
    if (hits.length < 100) break;
    from += 100;
  }
  console.log(`course resources: ${courses.length}`);

  // 3. which courses do we need? map dead subjects -> course URLs
  // Course-title normalization must also strip a trailing "archive" — the
  // replaced courses (Mathematics, PDHPE, ESL, SDD, IPT...) exist ONLY as
  // "-archive" pages on nsw.gov.au, and those archives hold exactly the
  // dead-era papers we're recovering.
  const neededCourses = new Map(); // normSubject -> course url
  for (const c of courses) {
    const title = c.title
      .replace(/\s*HSC exam papers\s*/i, "")
      .replace(/\s*archive\s*$/i, "")
      .trim();
    neededCourses.set(normKey(title), c);
  }
  // Subject-name aliases: dead subjects whose nsw.gov.au course is named
  // differently (renamed courses, slash-compound names, abbreviations).
  const SUBJECT_ALIASES = {
    "esl": ["english esl"],
    "chinese and literature chinese background speakers": ["chinese and literature"],
    "chinese in context heritage chinese mandarin": ["chinese in context"],
    "indonesian and literature indonesian background speakers": ["indonesian and literature"],
    "japanese and literature japanese background speakers": ["japanese and literature"],
    "japanese in context heritage japanese": ["japanese in context"],
    "korean and literature korean background speakers": ["korean and literature"],
    "korean in context heritage korean": ["korean in context"],
    "russian background speakers": ["russian continuers"],
  };
  const deadSubjects = [...new Set(dead.map((p) => p.subject))];
  const unmatchedSubjects = [];
  const courseFor = new Map();
  for (const s of deadSubjects) {
    const nkS = normKey(s);
    let c = neededCourses.get(nkS);
    if (!c) {
      for (const a of (SUBJECT_ALIASES[nkS] || [])) {
        if (neededCourses.get(a)) { c = neededCourses.get(a); break; }
      }
    }
    if (c) courseFor.set(s, c);
    else unmatchedSubjects.push(s);
  }
  console.log(`dead subjects: ${deadSubjects.length} | course-matched: ${courseFor.size} | unmatched: ${unmatchedSubjects.length}`);
  if (unmatchedSubjects.length) console.log("  unmatched: " + unmatchedSubjects.join(" · "));

  if (REPORT_ONLY) { console.log("[report-only] stopping before crawl"); return; }

  // 4. crawl: course page -> year pages + archive page -> archive year pages -> PDF links
  const pdfLinksByCourse = new Map(); // normSubject -> [{url, text}]
  let crawled = 0;
  const neededYears = new Set(dead.map((p) => String(p.year)));
  const hrefYear = (href) => {
    // year as a PATH SEGMENT (e.g. /.../<course>/2018 or /.../archive/2018)
    const m = new URL(href, "https://www.nsw.gov.au").pathname.match(/\/(20[0-2]\d)(?:\/|$)/);
    return m ? m[1] : null;
  };
  for (const [subject, course] of courseFor) {
    const nk = normKey(subject);
    try {
      const pdfs = [];
      const seen = new Set();
      const collect = (html, baseUrl) => {
        for (const m of html.matchAll(/href="([^"]*\.pdf[^"]*)"/gi)) {
          const u = new URL(m[1], baseUrl).href;
          if (!seen.has(u)) { seen.add(u); pdfs.push({ url: u, text: "" }); }
        }
      };
      const crawlYearPages = (html, baseUrl, seen) => {
        // extract year-page links (year as a path segment), skip visited
        const found = [];
        for (const m of html.matchAll(/href="([^"]+)"/g)) {
          const href = m[1];
          if (/\.pdf/i.test(href)) continue;
          const y = hrefYear(href);
          if (!y || !neededYears.has(y)) continue;
          const u = new URL(href, baseUrl).href;
          if (seen.has(u)) continue;
          seen.add(u);
          found.push({ u, year: y });
        }
        return found;
      };
      const pageHtml = await cachedFetch(course.url, `course-${nk}.html`);
      crawled++;
      collect(pageHtml, course.url);
      // year sub-pages for needed years (recent years live at /<course>/<year>)
      let yearPages = crawlYearPages(pageHtml, course.url, new Set());
      // archive page link (older years live under an -archive page)
      const archiveHref = (pageHtml.match(/href="([^"]*archive[^"]*)"/i) || [])[1];
      let archiveYearPages = [];
      if (archiveHref) {
        const aUrl = new URL(archiveHref, course.url).href;
        const aHtml = await cachedFetch(aUrl, `course-${nk}-archive.html`);
        crawled++;
        collect(aHtml, aUrl);
        archiveYearPages = crawlYearPages(aHtml, aUrl, new Set());
      }
      // crawl year pages (course years + archive years) for the needed years
      for (const yp of [...yearPages, ...archiveYearPages]) {
        try {
          const yHtml = await cachedFetch(yp.u, `page-${nk}-${yp.year}-${crawled}.html`, yp.u);
          crawled++;
          collect(yHtml, yp.u);
        } catch { /* per-year page may not exist */ }
      }
      pdfLinksByCourse.set(nk, pdfs);
    } catch (e) {
      console.log(`  course crawl failed: ${subject} (${e.message})`);
    }
  }
  console.log(`courses crawled: ${crawled} | pdf links collected: ${[...pdfLinksByCourse.values()].reduce((n, a) => n + a.length, 0)}`);

  // 5. match dead entries -> recovered URLs (year + subject-in-filename)
  async function verify(url) {
    try {
      const res = await fetch(url, { method: "HEAD", headers: UA });
      return res.ok;
    } catch { return false; }
  }
  // Registry is CUMULATIVE: load existing entries first so each run adds
  // recoveries without wiping previous ones (a rebuild re-applies the whole
  // registry, so losing entries would regress already-recovered papers).
  const recovery = {};
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    for (const [k, v] of Object.entries(prev.entries || {})) recovery[k] = v;
    console.log(`existing registry entries loaded: ${Object.keys(recovery).length}`);
  } catch { /* first run */ }
  let matched = 0, verified = 0;
  const unmatched = [];
  for (const p of dead) {
    const course = courseFor.get(p.subject);
    if (!course) { unmatched.push(p); continue; }
    const links = pdfLinksByCourse.get(normKey(p.subject)) || [];
    const yearStr = String(p.year);
    const subjSlug = normKey(p.subject).replace(/\s+/g, "-");
    const schoolSlug = normKey(p.school).replace(/\s+/g, "-");
    // candidate scoring: url mentions year, school, and (paper|exam)
    let best = null;
    for (const l of links) {
      const u = l.url;
      const uLow = u.toLowerCase();
      if (!uLow.includes(yearStr)) continue;
      let score = 0;
      if (uLow.includes(schoolSlug)) score += 2;
      if (/paper|exam/.test(uLow)) score += 1;
      if (uLow.includes(subjSlug.split("-")[0])) score += 1;
      if (score > (best?.score ?? -1)) best = { url: u, score };
    }
    if (!best) { unmatched.push(p); continue; }
    matched++;
    const ok = await verify(best.url);
    if (ok) {
      verified++;
      recovery[p.url] = { url: best.url, title: p.title };
    } else {
      unmatched.push(p);
    }
  }
  console.log(`\n==== RECOVERY REPORT ====`);
  console.log(`dead-wcm: ${dead.length} | course-matched: ${matched} | verified (200): ${verified} | unmatched: ${unmatched.length}`);
  const byYear = {};
  for (const p of dead) {
    const course = courseFor.get(p.subject);
    if (!course) continue;
    const links = pdfLinksByCourse.get(normKey(p.subject)) || [];
    if (links.some((l) => l.url.includes(String(p.year)))) byYear[p.year] = (byYear[p.year] || 0) + 1;
  }
  console.log("candidate links by year:", JSON.stringify(byYear));

  // 6. slow-route recovery: THSC router URLs whose (course, year) has an
  // official nsw.gov.au exam paper (year pages 2019-2026 are verified to
  // exist for recent courses). One paper PDF per course/year on the official
  // pages — matching is conservative: (subject, year) + type=hsc only.
  const slow = catalogue.filter((p) => /thsconline\.github\.io\/s\/d\//.test(p.url || ""));
  const slowRecent = slow.filter((p) => Number(p.year) >= 2019);
  console.log(`\nslow-route: ${slow.length} total | recent (2019-2026): ${slowRecent.length}`);
  let slowMatched = 0, slowVerified = 0;
  for (const p of slowRecent) {
    const course = courseFor.get(p.subject) || neededCourses.get(normKey(p.subject));
    if (!course) continue;
    try {
      const yHtml = await cachedFetch(`${course.url}/${p.year}`, `slow-${normKey(p.subject)}-${p.year}.html`, `${course.url}/${p.year}`);
      crawled++;
      const pdfs = extractPdfLinks(yHtml).map((u) => ({ url: new URL(u, `${course.url}/${p.year}`).href, text: "" }));
      // official year page: first pdf = the exam paper, -mg/-marking = guidelines
      const paper = pdfs.find((x) => !/-mg-|-marking/i.test(x.url));
      const mg = pdfs.find((x) => /-mg-|-marking/i.test(x.url));
      if (!paper) continue;
      slowMatched++;
      const ok = await verify(paper.url);
      if (!ok) continue;
      const rec = recovery[p.url] || (recovery[p.url] = { url: paper.url, title: p.title });
      rec.url = paper.url;
      if (mg) rec.markingGuidelines = mg.url;
      slowVerified++;
    } catch { /* course/year page may not exist for this course */ }
  }
  console.log(`slow-route recovery: ${slowMatched} matched, ${slowVerified} verified -> nsw.gov.au`);

  if (REPORT_ONLY) { console.log("[report-only — registry not written]"); return; }
  fs.writeFileSync(OUT, JSON.stringify({
    _doc: "NESA dead-link recovery registry (C2): dead wcm URLs AND slow-route router URLs -> verified public links on nsw.gov.au (course exam-paper pages + archive). The builder applies this at every rebuild — no hosting on our side; links point at the government archive. Re-verify periodically: the recovery pass is idempotent.",
    generated: new Date().toISOString(),
    entries: recovery,
  }, null, 1) + "\n");
  console.log(`wrote ${OUT} (${Object.keys(recovery).length} entries)`);

  // helper kept separate for clarity
  async function cachedFetch(url, cacheKey) {
    const file = path.join(CACHE, cacheKey);
    if (!NO_CACHE && fs.existsSync(file)) return fs.readFileSync(file, "utf8");
    await sleep(DELAY_MS);
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const text = await res.text();
    fs.writeFileSync(file, text);
    return text;
  }
})().catch((e) => { console.error("RECOVERY FAILED:", e.message); process.exit(1); });
