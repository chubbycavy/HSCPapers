/* landing-pages.cjs — Phase C: per-subject static landing pages.
 *
 * Generates ui/subjects/<slug>/index.html for every catalogue subject, the
 * /subjects/ hub page, and regenerates ui/sitemap.xml — so Google (and users
 * arriving from search) get real, crawlable content: per-subject counts,
 * year ranges, school coverage and the full paper table, all straight from
 * the catalogue (numbers contract). Each page links into the reader view
 * (?subject=<name>) and back to the index. Runs nightly after the build;
 * the sweep cross-checks the counts, so a generator bug can't ship silently.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SITE = "https://hscpapers.pages.dev";
const UI = path.join(__dirname, "..", "ui");

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const slugOf = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const typeLabel = (t) => ({ hsc: "HSC exam", trial: "Trial paper", assessment: "Assessment task", internal: "Internal" }[t] || "Other");

const ICON = `<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%234f46e5'/><text x='50' y='68' font-size='52' text-anchor='middle' fill='white' font-family='Arial' font-weight='bold'>H</text></svg>">`;
const THEME = `<script>try{document.documentElement.dataset.theme=localStorage.getItem("hsc-theme")||"light"}catch(e){}</script>`;
const NAV = `<header><nav class="nav"><a class="logo" href="/"><span class="logo-mark">H</span><span>HSCPapers<small>Free NSW HSC paper index</small></span></a><div class="nav-links"><a href="/">Browse the index</a><a href="/coverage">Coverage</a></div></nav></header>`;
const LEGAL = `<footer><b>HSCPapers</b> · Independent paper index · Not affiliated with NESA · <a href="/">← Back to the papers</a><br>Papers belong to their respective schools/authors and NESA. Catalogue + resolver: <a href="https://thsconline.github.io/s/" target="_blank" rel="noopener">THSCOnline</a>. Fast mirrors: <a href="https://www.hscportal.app/" target="_blank" rel="noopener">HSC Portal</a>, Board of Studies archive, official NESA releases.</footer>`;

const STYLE = `
  main.landing { max-width: 980px; margin: 0 auto; padding: 1.5rem 1.2rem 3rem; }
  .l-stats { display: flex; gap: 1.2rem; flex-wrap: wrap; margin: 1rem 0 1.4rem; }
  .l-stats .stat { background: var(--surface, #fff); border: 1px solid var(--border, #e5e7f0); border-radius: 12px; padding: .7rem 1.1rem; }
  .l-stats b { font-size: 1.2rem; display: block; }
  .l-stats span { color: var(--muted, #6b7280); font-size: .78rem; font-weight: 600; }
  .l-cta { display: inline-block; background: #4f46e5; color: #fff; padding: .55rem 1.1rem; border-radius: 10px; font-weight: 600; text-decoration: none; }
  .l-cta:hover { filter: brightness(1.08); }
  .yearblock { margin: 1.4rem 0 .6rem; }
  .yearblock h3 { font-size: 1rem; margin: 0 0 .4rem; }
  table.papers { border-collapse: collapse; width: 100%; font-size: .85rem; }
  table.papers th { text-align: left; padding: .35rem .5rem; background: var(--surface-2, #f4f5fa); border-bottom: 2px solid var(--border, #e5e7f0); }
  table.papers td { padding: .35rem .5rem; border-bottom: 1px solid var(--border, #eef0f6); vertical-align: top; }
  td.p-school { color: var(--muted, #6b7280); white-space: nowrap; }
  td.p-type { color: var(--muted, #6b7280); white-space: nowrap; font-size: .78rem; }
  .siblings { margin-top: 2rem; padding: 1rem 1.2rem; border: 1px solid var(--border, #e5e7f0); border-radius: 12px; }
  .siblings .slist { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: .2rem .9rem; font-size: .82rem; }
  .hub-list { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: .35rem 1.2rem; margin: 1.2rem 0; }
  .hub-list a { display: flex; justify-content: space-between; gap: .8rem; padding: .45rem .7rem; border: 1px solid var(--border, #e5e7f0); border-radius: 10px; text-decoration: none; }
  .hub-list a:hover { border-color: #4f46e5; }
  .hub-list small { color: var(--muted, #6b7280); }
`;

function page(title, desc, canonical, body, breadcrumb) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<meta name="description" content="${desc}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="HSCPapers">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${desc}">
<meta property="og:url" content="${canonical}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${desc}">
${breadcrumb ? `<script type="application/ld+json">${breadcrumb}</script>` : ""}
${ICON}
<link rel="stylesheet" href="/css/styles.css">
<style>${STYLE}</style>
</head>
<body>
${THEME}
${NAV}
<main class="landing">
${body}
</main>
${LEGAL}
</body>
</html>
`;
}

module.exports = async function generate() {
  const { papers } = JSON.parse(fs.readFileSync(path.join(UI, "data", "papers.json"), "utf8"));
  const bySubject = new Map();
  for (const p of papers) {
    if (!bySubject.has(p.subject)) bySubject.set(p.subject, []);
    bySubject.get(p.subject).push(p);
  }
  const subjects = [...bySubject.keys()].sort((a, b) => a.localeCompare(b));
  const root = path.join(UI, "subjects");
  fs.mkdirSync(root, { recursive: true });

  const breadcrumb = (name, canonical) => JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "HSCPapers", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name: "Subjects", item: SITE + "/subjects/" },
      { "@type": "ListItem", position: 3, name, item: canonical },
    ],
  });

  for (const subject of subjects) {
    const list = bySubject.get(subject);
    const slug = slugOf(subject);
    const yearsAll = list.map((p) => p.year).filter(Boolean);
    const yMin = yearsAll.length ? Math.min(...yearsAll) : "";
    const yMax = yearsAll.length ? Math.max(...yearsAll) : "";
    const schools = [...new Set(list.map((p) => p.school).filter(Boolean))];
    const range = yearsAll.length ? ` (${yMin}–${yMax})` : "";
    const canonical = `${SITE}/subjects/${slug}/`;
    const url = path.join(root, slug, "index.html");

    const byYear = new Map();
    for (const p of list) {
      const y = p.year == null ? "Undated" : String(p.year);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(p);
    }
    const yearKeys = [...byYear.keys()].filter((k) => k !== "Undated").sort((a, b) => Number(b) - Number(a));
    if (byYear.has("Undated")) yearKeys.push("Undated");

    const blocks = yearKeys.map((y) => {
      const rows = byYear.get(y)
        .sort((a, b) => String(a.title).localeCompare(String(b.title)))
        .map((p) => `<tr><td>${esc(p.title)}</td><td class="p-school">${esc(p.school || "—")}</td><td class="p-type">${esc(typeLabel(p.type))}</td></tr>`)
        .join("\n");
      return `<div class="yearblock"><h3>${esc(y)}</h3><table class="papers"><thead><tr><th>Paper</th><th>School</th><th>Type</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }).join("\n");

    const title = `HSC ${esc(subject)} Past Papers &amp; Trial Papers${range} | HSCPapers`;
    const desc = `Browse ${list.length} HSC ${subject} papers${range}: every NSW HSC exam, trial paper and school assessment for ${subject}, free to read in-browser with year and school filters, plus bulk ZIP downloads.`;
    const body = `
  <h1>NSW HSC ${esc(subject)} past papers</h1>
  <div class="l-stats">
    <div class="stat"><b>${list.length}</b><span>papers indexed</span></div>
    <div class="stat"><b>${yearsAll.length ? `${yMin}–${yMax}` : "—"}</b><span>years covered</span></div>
    <div class="stat"><b>${schools.length}</b><span>schools + NESA</span></div>
  </div>
  <p>Every NSW HSC ${esc(subject)} paper we have — HSC exams, trial papers and assessment tasks — searchable and filterable in the full index, with paper and solutions readable side by side and up to 200 papers in one structured ZIP. Free, no sign-up, no ads.</p>
  <p><a class="l-cta" href="/?subject=${encodeURIComponent(subject)}">Open ${esc(subject)} in the reader →</a></p>
  ${blocks}
  <div class="siblings">
    <h2>More subjects</h2>
    <div class="slist">${subjects.filter((s) => s !== subject).map((s) => `<a href="/subjects/${slugOf(s)}/">${esc(s)}</a>`).join("")}</div>
  </div>`;
    fs.mkdirSync(path.dirname(url), { recursive: true });
    fs.writeFileSync(url, page(title, esc(desc), canonical, body, breadcrumb(subject, canonical)));
  }

  // the hub: /subjects/
  const hubTitle = "Browse HSC Papers by Subject | HSCPapers";
  const hubDesc = "Every subject in the HSCPapers catalogue — NSW HSC exams, trial papers and school assessments, free to read and download.";
  const hubCanonical = `${SITE}/subjects/`;
  const hubBody = `
  <h1>Browse NSW HSC papers by subject</h1>
  <p>${subjects.length} subjects — every NSW HSC exam, trial paper and school assessment in one free index. Pick a subject to see its papers, or <a href="/">search the full catalogue</a>.</p>
  <div class="hub-list">${subjects.map((s) => `<a href="/subjects/${slugOf(s)}/"><span>${esc(s)}</span><small>${bySubject.get(s).length} papers</small></a>`).join("")}</div>`;
  fs.writeFileSync(path.join(root, "index.html"), page(hubTitle, esc(hubDesc), hubCanonical, hubBody, breadcrumb("Subjects", hubCanonical)));

  // the sitemap (the generator owns it now)
  const urls = [
    { loc: `${SITE}/`, freq: "daily" },
    { loc: `${SITE}/coverage`, freq: "daily" },
    { loc: `${SITE}/demo-scroll`, freq: "monthly" },
    { loc: `${SITE}/subjects/`, freq: "weekly" },
    ...subjects.map((s) => ({ loc: `${SITE}/subjects/${slugOf(s)}/`, freq: "weekly" })),
  ];
  fs.writeFileSync(path.join(UI, "sitemap.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url>
    <loc>${u.loc}</loc>
    <changefreq>${u.freq}</changefreq>
  </url>`).join("\n")}
</urlset>
`);

  return { subjects: subjects.length, pages: subjects.length + 1, sitemapUrls: urls.length };
};
