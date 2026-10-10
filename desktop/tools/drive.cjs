/* drive.cjs - the Drive re-host lane (policy: Drive files get copied to our
   R2 bucket; every other source stays a direct third-party link).

   What this tool does (no credentials required, never auth in the repo):
     1. take the ACCEPTED drive rows from tools/.cache/dedupe/accepted.json
     2. download each via Google's public download endpoint
        (drive.usercontent.google.com / uc?export=download), byte-proof
        (200 + application/pdf + %PDF- + SHA-256 + PDF.js pages)
     3. stage the verified bytes into tools/.cache/drive/staging/<sha8>.pdf
        (provenance recorded; local-only until upload)
     4. emit tools/drive-upload-manifest.json - the rclone/aws-passthrough
        list: {stagedPath, r2Key, sha256, bytes, pages, sourceRow}
     5. write drive-verified.json rows with {staged:true, uploaded:false}
        - the builder ships NOTHING for these rows until the R2 pass flips
          uploaded: true (flip-drive-registry mode), at which point the
          rows point at pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev/<r2Key>
        and the catalogue ingests them as selfhost papers (mirror
        attribution kept; removal form covers).

   Modes:
     --stage            download + proof + stage + manifest (resumable)
     --flip             mark rows uploaded:true after the user's R2 upload
                        (verifies each staged file exists under its R2 key
                        by HEAD over the public r2.dev endpoint)
     --report           status only

   Usage: node tools/drive.cjs --stage|--flip|--report [--limit=N]
   (the user's upload step: rclone copy tools/.cache/drive/staging/
    <bucket>:papers/drive/ - then --flip validates + lands the registry) */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const TOOLS = __dirname;
const WORKDIR = path.join(TOOLS, ".cache", "drive");
const STAGING = path.join(WORKDIR, "staging");
const MANIFEST = path.join(TOOLS, "drive-upload-manifest.json");
const OUT = path.join(TOOLS, "drive-verified.json");
const ACCEPTED = path.join(TOOLS, ".cache", "dedupe", "accepted.json");
const UA = { "User-Agent": "HSCPapers/1.0 (drive re-host lane)", "Accept-Encoding": "identity" };
const R2_HOST = "pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev";
const R2_PREFIX = "papers/drive";

const argValue = (name) => {
  const i = process.argv.indexOf(name);
  if (i !== -1 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(name + "="));
  return eq ? eq.slice(name.length + 1) : null;
};
const MODE = process.argv.includes("--flip") ? "flip" : process.argv.includes("--report") ? "report" : "stage";
const LIMIT = Number(argValue("--limit") || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pdfjsReady = null;
function pdfjs() {
  if (!pdfjsReady) {
    pdfjsReady = require("../ui/pdfjs/pdf.min.js");
    pdfjsReady.GlobalWorkerOptions.workerSrc = require.resolve("../ui/pdfjs/pdf.worker.min.js");
  }
  return pdfjsReady;
}

async function downloadFile(id) {
  const u1 = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download`;
  let res = await fetch(u1, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(120000) });
  let buf = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
  if (res.ok && buf.subarray(0, 3).toString("latin1").includes("<!D")) {
    // the virus-scan interstitial: parse the confirm form
    const html = buf.toString();
    const uuid = (html.match(/name="uuid" value="([^"]+)"/) || [])[1];
    const c = (html.match(/name="confirm" value="([^"]+)"/) || [])[1];
    if (uuid && c) {
      res = await fetch(`https://drive.usercontent.google.com/download?id=${encodeURIComponent(id)}&export=download&confirm=t&uuid=${encodeURIComponent(uuid)}&confirm2=${encodeURIComponent(c)}`, { headers: UA, redirect: "follow", signal: AbortSignal.timeout(180000) });
      buf = res.ok ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0);
    }
  }
  return { res, buf };
}

(async () => {
  fs.mkdirSync(STAGING, { recursive: true });
  let registry;
  try { registry = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch {
    registry = { _doc: "Drive re-host lane (policy: Drive files copy to OUR R2 bucket; attribution kept). staged=true uploaded=false rows wait for the operator's upload pass (see drive-upload-manifest.json); --flip verifies public availability of each R2 key and lands the rows for the builder. Every row carries byte proof: HTTP 200 + %PDF- + SHA-256 (+ PDF.js pages) captured at staging time.", version: 1, entries: {} };
  }

  if (MODE === "report") {
    const entries = Object.entries(registry.entries || {});
    console.log(`drive registry: ${entries.length} rows | staged ${entries.filter(([, e]) => e.staged).length} | uploaded ${entries.filter(([, e]) => e.uploaded).length}`);
    return;
  }

  if (MODE === "stage") {
    // drive rows bypass the dedupe direct-link gate by design (their ingest
    // url is the re-host key, not the Google link) - so this lane reads the
    // discover manifest and applies the same gates inline: byte proof, sha
    // uniqueness vs the catalogue, tuple test.
    const DISCOVER_MANIFEST = path.join(TOOLS, ".cache", "discover", "drive.candidates.json");
    if (!fs.existsSync(DISCOVER_MANIFEST)) { console.error("drive candidates missing - run discover.cjs --source=drive first"); process.exit(1); }
    const candidates = (JSON.parse(fs.readFileSync(DISCOVER_MANIFEST, "utf8")).candidates || []);
    const catalogue = require("../ui/data/papers.json").papers;
    const knownShas = new Set(catalogue.map((p) => p.sha256).filter(Boolean));
    const knownUrls = new Set(catalogue.map((p) => p.url));
    const normKey = (s) => String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
    const tupleOf = (c) => `${normKey(c.subject)}|${normKey(c.school)}|${c.year}|${c.type}`;
    const tuples = new Map(catalogue.map((p) => [tupleOf(p), 1]));
    const work = candidates.filter((c) => {
      if (knownUrls.has(c.url)) return false;
      const e = registry.entries[c.url];
      if (e) return !e.uploaded;
      return true;
    });
    console.log(`drive staging: ${work.length} of ${candidates.length} candidate drive files`);
    const manifest = (() => { try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return { generated: new Date().toISOString(), uploads: [] }; } })();
    const knownUp = new Set(manifest.uploads.map((u) => u.sha256 + "|" + u.r2Key));
    let i = 0, stagedN = 0, skipN = 0, failN = 0;
    for (const row of work) {
      i++;
      // tuple gate BEFORE the download (a parallel doc needs human eyes)
      if (tuples.has(tupleOf(row))) { console.log(`[${i}/${work.length}] REVIEW (tuple exists) ${row.title.slice(0, 46)}`); failN++; continue; }
      const id = row.hints && row.hints.driveFileId;
      if (!id) { failN++; continue; }
      let entry = registry.entries[row.url] || {};
      if (entry.uploaded) { skipN++; continue; }
      // download + proof (idempotent via sha key)
      try {
        const { res, buf } = await downloadFile(id);
        if (!res.ok || !buf.length) { failN++; console.log(`[${i}/${work.length}] download fail ${id.slice(0, 10)} HTTP ${res.status}`); continue; }
        if (buf.subarray(0, 5).toString("binary") !== "%PDF-") { failN++; console.log(`[${i}/${work.length}] not a PDF ${id.slice(0, 10)}`); continue; }
        const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
        if (knownShas.has(sha256)) { console.log(`[${i}/${work.length}] sha duplicate - skipped ${id.slice(0, 10)}`); failN++; continue; }
        knownShas.add(sha256);
        let pages = null;
        try {
          const doc = await pdfjs().getDocument({ data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true }).promise;
          pages = doc.numPages;
          await doc.destroy();
        } catch { /* pages optional */ }
        const stagedPath = path.join(STAGING, sha256.slice(0, 10) + ".pdf");
        if (!fs.existsSync(stagedPath)) fs.writeFileSync(stagedPath, buf);
        const r2Key = `${R2_PREFIX}/${sha256}.pdf`;
        entry = { ...row, staged: true, uploaded: false, stagedPath, r2Key, sha256, bytes: buf.length, pages, verifiedAt: new Date().toISOString() };
        registry.entries[row.url] = entry;
        if (!knownUp.has(sha256 + "|" + r2Key)) {
          knownUp.add(sha256 + "|" + r2Key);
          manifest.uploads.push({ stagedPath: path.basename(stagedPath), r2Key, sha256, bytes: buf.length, sourceRow: { title: row.title, driveFileId: id, sourceUrl: row.url } });
          stagedN++;
        }
        if (i % 5 === 0) { fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + "\n"); fs.writeFileSync(OUT, JSON.stringify(registry, null, 1) + "\n"); }
        console.log(`[${i}/${work.length}] staged ${sha256.slice(0, 8)} ${row.drive ? "" : ""}${(buf.length / 1024).toFixed(0)}KB -> ${r2Key}`);
      } catch (e) { failN++; console.log(`[${i}/${work.length}] stage fail ${id && id.slice(0, 10)}: ${String(e && e.message).slice(0, 50)}`); }
      await sleep(1100);
    }
    fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + "\n");
    fs.writeFileSync(OUT, JSON.stringify(registry, null, 1) + "\n");
    console.log(`\nSTAGE DONE: staged=${stagedN} already=${skipN} failed=${failN} | uploads queued: ${manifest.uploads.length}`);
    console.log(`operator step: rclone copyto each staging file (or one folder copy) to <bucket>:${R2_PREFIX}/ then run: node tools/drive.cjs --flip`);
    return;
  }

  if (MODE === "flip") {
    const entries = Object.entries(registry.entries || {}).filter(([, e]) => e.staged && !e.uploaded);
    console.log(`flip: verifying ${entries.length} staged rows against the public bucket`);
    let flipped = 0, missing = 0;
    for (const [key, e] of entries) {
      const url = `https://${R2_HOST}/${e.r2Key}`;
      const res = await fetch(url, { method: "HEAD", headers: UA, signal: AbortSignal.timeout(30000) });
      if (res.ok && Number(res.headers.get("content-length") || 0) === e.bytes) {
        e.uploaded = true;
        e.r2Url = url;
        flipped++;
      } else { missing++; console.log(`  missing/mismatch ${e.r2Key} (HTTP ${res.status})`); }
      await sleep(400);
    }
    fs.writeFileSync(OUT, JSON.stringify(registry, null, 1) + "\n");
    console.log(`\nFLIP DONE: flipped=${flipped} missing=${missing} (the builder ingests uploaded rows)`);
    return;
  }
})();
