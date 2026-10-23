// Apply only classified-new growth candidates to the reviewed import registry.
// Duplicates, versions, SHA-context conflicts and unverified records are held.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DESKTOP = path.resolve(__dirname, "..");
const CACHE = path.join(__dirname, ".cache", "growth");
const review = JSON.parse(fs.readFileSync(path.join(CACHE, "review.json"), "utf8"));
const manifest = JSON.parse(fs.readFileSync(path.join(CACHE, "thsc-r2-manifest.json"), "utf8"));
const uploads = JSON.parse(fs.readFileSync(path.join(CACHE, "r2-upload-results.json"), "utf8"));
const portal = JSON.parse(fs.readFileSync(path.join(__dirname, ".cache", "hscportal-papers.json"), "utf8"));
const importsPath = path.join(__dirname, "catalogue-imports.json");
const validationPath = path.join(__dirname, "catalogue-validation.json");
const selfhostPath = path.join(__dirname, "selfhost.json");
const imports = JSON.parse(fs.readFileSync(importsPath, "utf8"));
const validation = JSON.parse(fs.readFileSync(validationPath, "utf8"));
const selfhost = JSON.parse(fs.readFileSync(selfhostPath, "utf8"));
const norm = (s) => String(s || "").toLowerCase().replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const examBlockOf = (s) => {
  const text = String(s || "");
  const task = text.match(/\bTask\s*\d+\b/i);
  if (task) return task[0];
  const term = text.match(/\bTerm\s*\d+\b/i);
  if (term) return term[0];
  if (/half[- ]?year/i.test(text)) return "Half-Yearly";
  return "";
};

const backup = path.join(CACHE, "backup-" + new Date().toISOString().replace(/[:.]/g, "-"));
fs.mkdirSync(backup, { recursive: true });
for (const f of [importsPath, validationPath, selfhostPath]) fs.copyFileSync(f, path.join(backup, path.basename(f)));

const portalByKey = new Map();
const subjects = portal.subjects || [], schools = portal.schools || [];
for (const e of portal.papers || []) {
  if (!e.v || !e.n || !e.cf) continue;
  portalByKey.set(String(e.v) + "|" + norm(e.n), e);
}
const uploadById = new Map((uploads.results || []).filter((r) => r.ok).map((r) => [r.id, r]));
const manifestById = new Map((manifest.entries || []).map((r) => [r.id, r]));

const additions = [];
const held = [];
for (const r of review.rows) {
  if (r.disposition !== "new" || !r.proof) { held.push({ id: r.id, reason: r.disposition }); continue; }
  if (r.source === "hscportal") {
    additions.push({ kind: "hscportal", row: r, proof: r.proof, fallback: null });
  } else if (r.source === "thsc-feed" && r.r2Upload) {
    const m = manifestById.get(r.id), u = uploadById.get(r.id);
    if (!m || !u) { held.push({ id: r.id, reason: "missing R2 upload" }); continue; }
    additions.push({ kind: "r2", row: r, proof: r.proof, fallback: r.url, r2: m });
  } else if (r.source === "thsc-feed" && r.portalExact) {
    const e = portalByKey.get(String(r.viewno) + "|" + norm(r.linkText || r.title));
    if (!e) { held.push({ id: r.id, reason: "portal exact row missing" }); continue; }
    additions.push({ kind: "thsc-portal", row: r, proof: r.proof, fallback: r.url, portal: e });
  } else {
    held.push({ id: r.id, reason: "no delivery selected" });
  }
}

async function verifyPortalCopy(entry) {
  const url = "https://hscportal.pages.dev/" + entry.portal.cf.split("/").map(encodeURIComponent).join("/");
  const res = await fetch(url, { signal: AbortSignal.timeout(45000) });
  if (!res.ok) throw new Error("portal HTTP " + res.status + " for " + entry.row.id);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (sha(bytes) !== entry.proof.sha256 || bytes.length !== entry.proof.bytes) throw new Error("portal bytes differ for " + entry.row.id);
  return { url, proof: { ...entry.proof, transport: "hscportal" } };
}

function addProof(map, url, proof) {
  if (!url) return;
  const old = map[url];
  if (old && (old.sha256 !== proof.sha256 || old.bytes !== proof.bytes || old.state !== "verified")) {
    throw new Error("Conflicting proof for " + url);
  }
  map[url] = { state: "verified", sha256: proof.sha256, bytes: proof.bytes, pages: proof.pages, text: proof.text || "", transport: proof.transport || "direct-pdf", at: proof.verifiedAt || new Date().toISOString() };
}

(async () => {
  const ids = new Set((imports.entries || []).map((e) => e.id));
  let added = 0;
  for (const a of additions) {
    const r = a.row;
    if (ids.has(r.id)) { held.push({ id: r.id, reason: "already imported" }); continue; }
    let url, fallback = a.fallback, primaryProof = a.proof;
    if (a.kind === "r2") {
      url = uploadById.get(r.id).url;
      primaryProof = { ...a.proof, transport: "r2" };
    } else if (a.kind === "thsc-portal") {
      try {
        const p = await verifyPortalCopy(a);
        url = p.url; primaryProof = p.proof;
      } catch (e) {
        held.push({ id: r.id, reason: String(e.message || e) });
        continue;
      }
    } else {
      url = r.url;
    }
    if (!url) { held.push({ id: r.id, reason: "missing primary URL" }); continue; }
    const legacyRecord = {
      id: r.id, url: fallback || url, subject: r.subject, school: r.school,
      year: r.year, type: r.type, title: r.linkText || r.title,
    };
    const entry = {
      id: r.id, source: a.kind === "hscportal" ? "hscportal" : "thsc-feed",
      subject: r.subject, school: r.school, year: r.year, type: r.type, level: r.level || undefined,
      title: r.title, url, fallbackUrl: fallback || "", solutionUrl: "", solFallbackUrl: "",
      hasSolutions: !!r.hasSolutions, viewno: r.viewno ? String(r.viewno) : undefined,
      linkText: r.linkText || r.title, sourceKeys: r.sourceKeys || [],
      examBlock: r.examBlock || examBlockOf(r.title || r.linkText),
      documentRole: r.documentRole || r.role || undefined, hints: r.hints || {},
      sha256: primaryProof.sha256, bytes: primaryProof.bytes, pages: primaryProof.pages,
      checkedAt: primaryProof.verifiedAt || new Date().toISOString(), legacyRecord,
    };
    imports.entries.push(entry);
    addProof(imports.proofs, url, primaryProof);
    addProof(validation.entries, url, primaryProof);
    if (fallback) {
      const fb = { ...a.proof, transport: "thsc-fragments" };
      addProof(imports.proofs, fallback, fb);
      addProof(validation.entries, fallback, fb);
    }
    if (a.kind === "r2") {
      const sh = { ...a.r2.selfhost, autoAdd: false };
      if (!selfhost.entries.some((e) => e.key === sh.key)) selfhost.entries.push(sh);
    }
    ids.add(r.id);
    added++;
  }
  fs.writeFileSync(importsPath, JSON.stringify(imports, null, 1) + "\n");
  fs.writeFileSync(validationPath, JSON.stringify(validation, null, 1) + "\n");
  fs.writeFileSync(selfhostPath, JSON.stringify(selfhost, null, 1) + "\n");
  const out = { generated: new Date().toISOString(), additions: additions.length, added, held, backup };
  fs.writeFileSync(path.join(CACHE, "apply-growth-result.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify({ additions: additions.length, added, held: held.length, backup }, null, 2));
  for (const h of held) console.log("HELD", h.id, h.reason);
})().catch((e) => { console.error(e); process.exitCode = 1; });
