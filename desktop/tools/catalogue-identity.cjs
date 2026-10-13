/* A paper's source identity is independent of its mirror URL and display title.
   Tuples are review hints, never sufficient evidence to merge two documents. */
"use strict";
const normalize = value => String(value || "").replace(/&amp;/gi, "&").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
const listingName = value => String(value || "").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim().toLowerCase();
const SUBJECTS = {
  "maths advanced 2u": "Mathematics Advanced", "mathematics 2 unit advanced": "Mathematics Advanced",
  "maths advanced": "Mathematics Advanced", "maths 2 unit": "Mathematics Advanced",
  "maths extension 1": "Mathematics Extension 1", "maths ext 1": "Mathematics Extension 1",
  "maths extension 2": "Mathematics Extension 2", "maths ext 2": "Mathematics Extension 2",
  "standard maths": "Mathematics Standard", "maths general": "Mathematics Standard",
  "mathematics general": "Mathematics Standard", "maths standard": "Mathematics Standard",
  "english advanced paper 2": "English Advanced", "english standard paper 2": "English Standard",
  "english general": "English", "ipt": "Information Processes & Technology",
  "software": "Software Design & Development",
};
function canonicalSubject(value) { return SUBJECTS[normalize(value)] || value; }
function routerKey(value) {
  try {
    const u = new URL(value);
    if (!["thsconline.github.io", "thsconline.pages.dev", "www.thsconline.net", "thsconline.net"].includes(u.hostname)) return null;
    const m = u.pathname.match(/^\/s\/(?:d|v|f|z|fz)\/(\d+)\/(.+)$/);
    return m ? m[1] + "|" + listingName(decodeURIComponent(m[2])) : null;
  } catch { return null; }
}
function mirrorKey(value) {
  const m = String(value || "").match(/^(\d+)\/(.+)$/);
  return m ? m[1] + "|" + listingName(m[2]) : null;
}
function listingKeys(p) {
  return [...new Set([
    ...(p.sourceKeys || []),
    p.listingKey, p.viewno && p.linkText ? String(p.viewno) + "|" + listingName(p.linkText) : null,
    routerKey(p.url), routerKey(p.fallbackUrl), mirrorKey(p.hints?.mirrorRow),
  ].filter(Boolean))];
}
function routeText(p) {
  const key = listingKeys(p)[0];
  return key ? key.slice(key.indexOf("|") + 1) : String(p.title || "");
}
function documentRole(text) {
  const t = normalize(text);
  if (/itute|jan hansen/.test(t)) return "provider-solutions";
  if (/sample answers?/.test(t)) return "sample-answers";
  if (/marking feedback|notes from (?:the )?marking centre/.test(t)) return "feedback";
  if (/marking guidelines?|\bsolutions\b|quick answers|worked solutions/.test(t)) return "solutions";
  if (/transcript|listening/.test(t)) return "transcript";
  return "questions";
}
function paperPart(text) {
  const t = normalize(text);
  const m = t.match(/\b(?:paper|p)\s*([12])\b/);
  return m ? m[1] : "";
}
function reviewKey(p) {
  const role = /HSC Exam Paper/i.test(p.title || "") ? "questions" : p.documentRole === "combined" ? "questions" : (p.documentRole || documentRole(routeText(p)));
  let subject = canonicalSubject(p.subject);
  // NESA's pre-2019 HSC "Mathematics" is the legacy 2-unit Advanced course.
  if (subject === "Mathematics" && p.level === "HSC" && p.type === "hsc" && p.year >= 1995 && p.year <= 2018) subject = "Mathematics Advanced";
  if (normalize(subject) === "english" && paperPart(routeText(p)) === "2") {
    if (/advanced|\badv\b/.test(normalize(routeText(p)))) subject = "English Advanced";
    else if (/standard|\bstd\b/.test(normalize(routeText(p)))) subject = "English Standard";
  }
  return [normalize(subject), normalize(p.school), p.year || "", p.type || "",
    normalize(p.level), normalize(p.examBlock), role, p.paperPart || paperPart(p.title) || paperPart(routeText(p))].join("|");
}
function sourceContext(p) {
  const r = reviewKey(p).split("|"), part = paperPart(p.title) || paperPart(routeText(p));
  const course = part === "1" && /^english(?: standard| advanced| paper 1)?$/.test(r[0]) ? "english paper 1" : r[0];
  return [course, p.level || "", r[6], part].join("|");
}
function compatibleSourceContext(a, b) {
  const x = sourceContext(a).split("|"), y = sourceContext(b).split("|");
  return x.every((v, i) => !v || !y[i] || v === y[i]);
}
function officialReplacementAllowed(p, entry) {
  if (p.type !== "hsc" || (p.school && normalize(p.school) !== "nesa")) return false;
  const route = routeText(p);
  if (/\bitute\b|\bhy\b|half yearly|trials?/.test(normalize(route))) return false;
  const doc = entry.docName || entry.packText || "";
  let file = ""; try { file = decodeURIComponent(new URL(entry.url).pathname.split("/").pop()); } catch {}
  const part = paperPart(doc) || paperPart(file);
  if (paperPart(route) && part && paperPart(route) !== part) return false;
  if (entry.docName && paperPart(route) && !part && !entry.exact) return false;
  const expected = documentRole(route), actual = documentRole(doc);
  if (doc && expected !== actual && !entry.exact) return false;
  return true;
}
function isDirect(url) {
  try {
    const u = new URL(url);
    return !/^\/s\/(?:d|v|f|z|fz)\//.test(u.pathname) && !/educationstandards/.test(u.hostname);
  } catch { return false; }
}
function importId(row) { return row.id || `add-${row.source}-${String(row.sha256).slice(0, 10)}`; }
function validProof(row) { return /^[a-f0-9]{64}$/.test(row.sha256 || "") && Number.isInteger(row.bytes) && row.bytes > 0; }
function candidateMetadata(row) {
  const out = { ...row, subject: canonicalSubject(row.subject) };
  if (row.source === "thsc-au-growth") {
    out.listingKey = mirrorKey(row.hints?.mirrorRow);
    const pathname = new URL(row.url).pathname;
    out.type = /assessment/.test(pathname) ? "assessment" : /trialpapers/.test(pathname) ? "trial" : /hscpapers/.test(pathname) ? "hsc" : row.type;
    const yearLevel = (pathname.match(/\/yr(\d+)\//) || [])[1];
    out.level = ({ "12": "HSC", "11": "Preliminary", "10": "Year 10", "9": "Year 9" })[yearLevel] || row.level || null;
  }
  return out;
}
function subjectsOf(p) { return [...new Set([p.subject, ...(p.relatedSubjects || [])].filter(Boolean))]; }
function semanticFileKey(p) {
  let file = ""; try { file = decodeURIComponent(new URL(p.url).pathname.split("/").pop()); } catch {}
  const sharedPaper1 = p.type === "hsc" && normalize(p.school) === "nesa" && /^english/.test(normalize(p.subject)) &&
    /english.*(?:std.*adv|standard.*advanced)/i.test(file) && paperPart(routeText(p)) === "1" && documentRole(routeText(p)) === "questions";
  return sharedPaper1 ? ["shared-english-paper-1", p.year, normalize(p.level), "questions"].join("|") : reviewKey(p);
}
module.exports = { normalize, listingName, canonicalSubject, routerKey, mirrorKey, listingKeys, routeText,
  documentRole, paperPart, reviewKey, sourceContext, compatibleSourceContext, officialReplacementAllowed, isDirect, importId, validProof, candidateMetadata, subjectsOf, semanticFileKey };
