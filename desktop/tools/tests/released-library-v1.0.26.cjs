// Frozen library consumer semantics from released commit 08f9c0a, app.js:108-131.
// Intentionally ignores modern forKind/savedKind/variantOnly fields.
"use strict";
function hash6(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h.toString(36).padStart(10, "0").slice(0, 10); }
function paperUrlOf(p, kind) { return kind === "paper" ? (p.url || p.path) : (p.solutionUrl || p.solutionPath || null); }
function safeName(p, kind) { return `${p.year ?? "na"}-${p.subject}-${p.school}-${kind}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) + ".pdf"; }
function libraryRel(p, kind) {
  const url = paperUrlOf(p, kind); if (!url) return null;
  const seg = s => String(s ?? "unsorted").replace(/[\\/:*?"<>|]/g, "-").trim() || "unsorted";
  return `${seg(p.subject)}/${p.year || "unknown"}/${safeName(p, kind)}`.replace(/\.pdf$/, `-${hash6(url)}.pdf`);
}
function libraryCandidates(p, kind) { return [...new Set([p, ...(p.libraryAliases || [])].map(row => libraryRel(row, kind)).filter(Boolean))]; }
module.exports = { libraryRel, libraryCandidates };
