"use strict";
const I = require("./catalogue-identity.cjs");
function curriculumIssue(row, text = "") {
  const s = `${row.title || ""} ${text}`;
  if (/\bMATH(?:3202|7232)\b|Operations Research and (?:Math|Mathematical) Planning/i.test(s)) return "University operations-research material is outside NSW school coverage";
  if (/University of Queensland|St Lucia Campus/i.test(text) && /Semester (?:One|Two) Final Examinations/i.test(text)) return "University examination is outside NSW school coverage";
  return null;
}
function contextIssue(p, role, text, url) {
  const scope = curriculumIssue(p, text); if (scope) return scope;
  if (role !== "primary" && role !== "solutions") return null;
  const intro = String(text || "").slice(0, 700);
  const examYear = (intro.slice(0, 400).match(/\b((?:19|20)\d{2})\s+(?:HIGHER SCHOOL CERTIFICATE\s+EXAMINATION|HSC\s+(?:Examination|Marking Guidelines))/i) || [])[1];
  if (p.school === "NESA" && p.type === "hsc" && examYear && Number(examYear) !== Number(p.year)) return `Official document heading identifies ${examYear}, not ${p.year}`;
  const courses = [...intro.replace(/\(ESL\)/gi, " ESL ").matchAll(/\b(?:Mathematics\s+(?:Advanced|Standard|Extension\s*[12])|English\s+(?:Advanced|Standard|ESL)|Chemistry|Physics|Biology|Studies\s+of\s+Religion\s+(?:II|I|[12]))\b/gi)]
    .map(m => m[0].replace(/\s+/g, " ").replace(/Extension\s*(\d)/i, "Extension $1").toLowerCase());
  const normalizeCourse = s => s.replace(/\(esl\)/, "esl").replace(/religion 1$/, "religion i").replace(/religion 2$/, "religion ii");
  const unique = [...new Set(courses.map(normalizeCourse))];
  let expected = normalizeCourse(I.canonicalSubject(p.subject || "").toLowerCase());
  const route = I.normalize(I.routeText(p));
  if (expected === "english" && /advanced|\badv\b/.test(route)) expected = "english advanced";
  else if (expected === "english" && /standard|\bstd\b/.test(route)) expected = "english standard";
  const expectedPart = I.paperPart(p.title || "") || I.paperPart(I.routeText(p));
  const actualParts = [...new Set([...intro.matchAll(/\bpaper\s*([12])\b/gi)].map(m => m[1]))];
  if (expectedPart && actualParts.length === 1 && expectedPart !== actualParts[0]) return `Document heading identifies Paper ${actualParts[0]}, not Paper ${expectedPart}`;
  if (unique.length === 1 && /^(mathematics (advanced|standard|extension [12])|english (advanced|standard|esl)|chemistry|physics|biology|studies of religion (i|ii))$/.test(expected) && unique[0] !== expected) {
    const sharedEnglish = /english (advanced|standard)/.test(expected) && /english (advanced|standard)/.test(unique[0]) && (I.paperPart(I.routeText(p)) === "1" || /paper\s*1/i.test(intro));
    if (!sharedEnglish) return `Document heading identifies ${unique[0]}, not ${expected}`;
  }
  const expectedRole = /HSC Exam Paper/i.test(p.title || "") ? "questions" : I.documentRole(I.routeText(p));
  if (role === "primary" && /marking guidelines/i.test(I.routeText(p)) && /notes from (?:the )?marking cent(?:re|er)/i.test(intro)) return "Marking-centre feedback was substituted for the advertised marking guidelines";
  if (role === "primary" && expectedRole === "questions" && p.type === "hsc" &&
      /marking guidelines/i.test(intro) && /(?:-mg-|marking-guidelines)/i.test(url || "")) return "Marking guidelines were substituted for an examination questions file";
  return null;
}
function completeMetadata(row) {
  return !!row.subject && !!row.school && Number.isInteger(row.year) && !!row.type && ["HSC", "Preliminary", "Year 10", "Year 9"].includes(row.level);
}
module.exports = { curriculumIssue, contextIssue, completeMetadata };
