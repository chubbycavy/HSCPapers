/* coverage-report.cjs — F7: build-time public coverage dashboard.
   Derives EVERYTHING from ui/data/papers.json (the numbers contract:
   generated numbers can never drift from the catalogue). Called by
   build-index.cjs after every rebuild (incl. the nightly bot) and
   runnable standalone: node desktop/tools/coverage-report.cjs */
const fs = require("fs");
const path = require("path");
const { slugOf } = require("./landing-pages.cjs");

const SITE = "https://hscpapers.com";

const FAST_HOSTS = /hscportal\.pages\.dev|pub-ec23c9b69d2544938d816ad28ee491fd\.r2\.dev|www\.nsw\.gov\.au|www\.boardofstudies\.nsw\.edu\.au/;
const esc = (s) => (s ?? "").toString().replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

module.exports = async function run() {
  const ui = path.join(__dirname, "..", "ui");
  const cat = JSON.parse(fs.readFileSync(path.join(ui, "data", "papers.json"), "utf8"));
  const papers = cat.papers || [];
  // cov-note carries the CATALOGUE's build stamp (not the render time) — the
  // page's freshness = the data's freshness, so the committed artifact is
  // byte-stable per catalogue version (no timestamp-churn commits nightly)
  const generatedAt = String(cat.generated || "unknown").replace("T", " ").slice(0, 16);
  const isFast = (u) => FAST_HOSTS.test(u || "");
  const totalFiles = papers.reduce((n, p) => n + (p.url ? 1 : 0) + (p.solutionUrl ? 1 : 0), 0);
  const fastFiles = papers.reduce((n, p) => n + (p.url && isFast(p.url) ? 1 : 0) + (p.solutionUrl && isFast(p.solutionUrl) ? 1 : 0), 0);
  const withSol = papers.filter(p => p.hasSolutions).length;
  const subjects = new Map(), years = new Map(), schools = new Map();
  const grid = new Map(); // "subject|year" -> count
  for (const p of papers) {
    subjects.set(p.subject, (subjects.get(p.subject) || 0) + 1);
    if (p.year) years.set(p.year, (years.get(p.year) || 0) + 1);
    schools.set(p.school, (schools.get(p.school) || 0) + 1);
    const k = `${p.subject}|${p.year}`;
    grid.set(k, (grid.get(k) || 0) + 1);
  }
  const yearList = [...years.keys()].sort((a, b) => a - b);
  const subjList = [...subjects.keys()].sort((a, b) => a.localeCompare(b));
  const schoolList = [...schools.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const bucket = (n) => !n ? "" : n >= 10 ? "c4" : n >= 3 ? "c3" : n >= 1 ? "c2" : "";

  const matrixHead = `<tr><th class="subj-col">Subject</th>${yearList.map(y => `<th>${String(y).slice(2)}</th>`).join("")}</tr>`;
  const matrixBody = subjList.map(s =>
    `<tr><th class="subj-col">${esc(s)} <i>${subjects.get(s)}</i></th>` +
    yearList.map(y => {
      const n = grid.get(`${s}|${y}`) || 0;
      return `<td class="${bucket(n)}" ${n ? `data-label="${esc(s)} · ${y}: ${n} paper${n === 1 ? "" : "s"}"` : ""}></td>`;
    }).join("") + "</tr>"
  ).join("");
  const schoolRows = schoolList.map(([s, n], i) =>
    `<tr><td>${i + 1}</td><td>${esc(s)}</td><td>${n}</td></tr>`).join("");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Coverage — HSCPapers</title>
<meta name="description" content="What HSCPapers actually has: the live coverage matrix — subjects × years, schools, and file counts, generated straight from the catalogue.">
<meta name="robots" content="index,follow">
<link rel="canonical" href="${SITE}/coverage">
<link rel="icon" href="/logo.svg" type="image/svg+xml">
<script>try{document.documentElement.dataset.theme=localStorage.getItem("hsc-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}catch(e){}</script>
<link rel="stylesheet" href="css/styles.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><rect width='100' height='100' rx='22' fill='%234f46e5'/><text x='50' y='68' font-size='52' text-anchor='middle' fill='white' font-family='Arial' font-weight='bold'>H</text></svg>">
<style>
  main.coverage { max-width: 1200px; margin: 0 auto; padding: 1.5rem 1.2rem 3rem; }
  .cov-stats { display: flex; gap: 1.6rem; flex-wrap: wrap; margin: 1.2rem 0 1.6rem; }
  .cov-stats .stat { background: var(--surface, #fff); border: 1px solid var(--border, #e5e7f0); border-radius: 12px; padding: .8rem 1.2rem; box-shadow: var(--shadow, 0 1px 4px rgba(20,30,80,.06)); }
  .cov-stats b { font-size: 1.25rem; display: block; }
  .cov-stats span { color: var(--muted, #6b7280); font-size: .8rem; font-weight: 600; }
  .matrix-wrap { overflow: auto; max-height: 70vh; border: 1px solid var(--border, #e5e7f0); border-radius: 12px; }
  table.matrix { border-collapse: collapse; font-size: .68rem; }
  table.matrix th, table.matrix td { border: 1px solid var(--border, #eef0f6); padding: .18rem .3rem; }
  table.matrix thead th { position: sticky; top: 0; background: var(--surface-2, #f4f5fa); z-index: 2; }
  table.matrix .subj-col { position: sticky; left: 0; background: var(--surface-2, #f4f5fa); text-align: left; font-weight: 650; white-space: nowrap; min-width: 12rem; z-index: 1; }
  thead .subj-col { z-index: 3; }
  table.matrix td { width: 1.35rem; height: 1.1rem; }
  td.c2 { background: #c7d2fe; } td.c3 { background: #818cf8; } td.c4 { background: #4f46e5; }
  [data-theme="dark"] td.c2 { background: #31407a; } [data-theme="dark"] td.c3 { background: #4a5bbd; }
  .school-table { border-collapse: collapse; width: 100%; font-size: .85rem; }
  .school-table th, .school-table td { border-bottom: 1px solid var(--border, #eef0f6); padding: .35rem .6rem; text-align: left; }
  .school-table td:last-child, .school-table th:last-child { text-align: right; font-variant-numeric: tabular-nums; }
  h2 { margin-top: 2.2rem; }
  .cov-note { color: var(--muted, #6b7280); font-size: .8rem; margin-top: 2rem; }
  /* Instant hover tooltip (native title needs a ~1s delay and feels broken on tiny cells) */
  #covtip { position: fixed; z-index: 99; background: #111827; color: #fff; font: 600 .78rem system-ui; padding: .35rem .6rem; border-radius: 8px; pointer-events: none; display: none; box-shadow: 0 4px 14px rgba(0,0,0,.25); white-space: nowrap; }
</style>
</head>
<body>
<header>
  <nav class="nav">
    <a class="logo" href="/"><span class="logo-mark"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="22" fill="#4f46e5"/><rect x="55" y="22" width="26" height="52" rx="5" fill="#a5b4fc"/><rect x="47" y="28" width="26" height="52" rx="5" fill="#c7d2fe"/><rect x="26" y="22" width="40" height="58" rx="5" fill="#f8fafc"/><path d="M50 22 H66 V38 Z" fill="#e0e4f0"/><rect x="32" y="34" width="5" height="34" fill="#1e1b4b"/><rect x="52" y="34" width="5" height="34" fill="#1e1b4b"/><rect x="37" y="47" width="15" height="5" fill="#1e1b4b"/></svg></span><span>HSCPapers<small>Trial · HSC · Internals</small></span></a>
    <div class="nav-links">
      <a href="/">Browse</a><a href="/#subjects">Subjects</a><a href="/#about">About</a><a href="/" class="active">Coverage</a>
    </div>
    <div class="nav-right"><span class="host-badge">⇪ 🌐 Website</span></div>
  </nav>
</header>
<main class="coverage">
  <h1>What we actually have</h1>
  <p>Every number below is generated straight from the live catalogue at build time — if it's here, we have it; if it's not, we don't claim it.</p>
  <div class="cov-stats">
    <div class="stat"><b>${papers.length.toLocaleString("en-AU")}</b><span>papers indexed</span></div>
    <div class="stat"><b>${totalFiles.toLocaleString("en-AU")}</b><span>files (${fastFiles.toLocaleString("en-AU")} fast)</span></div>
    <div class="stat"><b>${subjects.size}</b><span>subjects</span></div>
    <div class="stat"><b>${schools.size}</b><span>schools + NESA</span></div>
    <div class="stat"><b>${withSol.toLocaleString("en-AU")}</b><span>with solutions</span></div>
    <div class="stat"><b>${yearList[0]}–${yearList[yearList.length - 1]}</b><span>years covered</span></div>
  </div>
  <h2>Subjects × years</h2>
  <p style="color:var(--muted,#6b7280);font-size:.85rem">Darker = more papers. Hover any cell for the exact count. The year column is the last two digits.</p>
  <div class="matrix-wrap"><table class="matrix">${matrixHead}${matrixBody}</table></div>
  <h2>Schools by paper count</h2>
  <table class="school-table"><thead><tr><th>#</th><th>School</th><th>Papers</th></tr></thead><tbody>${schoolRows}</tbody></table>
  <p class="cov-note">Catalogue generated ${generatedAt} UTC by desktop/tools/build-index.cjs — rebuilt nightly. Papers belong to their schools/authors and NESA; HSCPapers is a free, non-commercial index.</p>
</main>
<footer>
  <b>HSCPapers</b> · Independent paper index · Not affiliated with NESA · <a href="/">← Back to the papers</a>
</footer>
<!-- SUBJECTS:STATIC:START -->
<div class="footer-subjects"><h2>All subjects · <a href="/subjects/">subjects hub</a></h2><div class="f-grid">${subjList.map((s) => `<a href="/subjects/${slugOf(s)}/"><span>${esc(s)}</span><small>${subjects.get(s)} papers</small></a>`).join("")}</div></div>
<!-- SUBJECTS:STATIC:END -->
<div id="covtip"></div>
<script>
(() => {
  const tip = document.getElementById("covtip");
  for (const td of document.querySelectorAll("table.matrix td[data-label]")) {
    td.addEventListener("mouseenter", () => { tip.textContent = td.dataset.label; tip.style.display = "block"; });
    td.addEventListener("mousemove", (e) => {
      tip.style.left = Math.min(e.clientX + 12, window.innerWidth - tip.offsetWidth - 8) + "px";
      tip.style.top = Math.max(8, e.clientY - 34) + "px";
    });
    td.addEventListener("mouseleave", () => { tip.style.display = "none"; });
  }
})();
</script>
</body>
</html>
`;
  fs.writeFileSync(path.join(ui, "coverage.html"), html);
  console.log(`coverage.html: ${papers.length} papers · ${subjects.size} subjects · ${schools.size} schools · ${totalFiles} files`);
};
if (require.main === module) module.exports();
