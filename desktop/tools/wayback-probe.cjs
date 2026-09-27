/* wayback-probe.cjs — A2 path 2: does web.archive.org hold snapshots of the
   dead wcm URLs? Sample-probes the availability API (rate-polite). */
const fs = require("fs");
const path = require("path");
const papers = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "ui", "data", "papers.json"), "utf8")).papers;
const dead = papers.filter(p => (p.url || "").includes("wcm"));

(async () => {
  const sample = [];
  const step = Math.max(1, Math.floor(dead.length / 25));
  for (let i = 0; i < dead.length && sample.length < 25; i += step) sample.push(dead[i]);
  let hits = 0;
  const results = [];
  for (const p of sample) {
    try {
      const api = `https://archive.org/wayback/available?url=${encodeURIComponent(p.url)}`;
      const r = await fetch(api, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      const snap = j?.archived_snapshots?.closest;
      const hit = !!(snap && snap.available && snap.url);
      if (hit) hits++;
      results.push({ year: p.year, subject: p.subject.slice(0, 28), hit, snap: hit ? snap.url.slice(0, 90) : null });
      process.stdout.write(hit ? "H" : ".");
    } catch { results.push({ year: p.year, err: true }); process.stdout.write("x"); }
  }
  console.log(`\nwayback hits: ${hits}/${sample.length}`);
  console.log(JSON.stringify(results.filter(r => r.hit).slice(0, 8), null, 1));
})();
