// Treat remote catalogue values as data before HTML, CSS or library paths.
((root, factory) => {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.CatalogueSchema = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";
  const TYPES = new Set(["hsc", "trial", "assessment", "other", "internal"]);
  const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/;
  const CONTROL = /[\x00-\x1f\x7f]/;
  function year(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string" && /^\d{4}$/.test(value)) value = Number(value);
    if (!Number.isInteger(value) || value < 1900 || value > new Date().getUTCFullYear() + 1) throw new Error("Invalid catalogue year");
    return value;
  }
  function labelIssue(value, max, filename = false) {
    if (typeof value !== "string" || !value.trim() || value.length > max || CONTROL.test(value)) return "Invalid text field";
    if (filename) {
      const segment = value.replace(/[\\/:*?"<>|]/g, "-").trim();
      if (!segment || /^\.+$/.test(segment) || /[. ]$/.test(segment) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)) return "Unsafe library name";
    }
    return null;
  }
  function urlIssue(value) {
    if (value === "" || value === undefined || value === null) return null;
    if (typeof value !== "string" || value.length > 4096 || CONTROL.test(value)) return "Invalid source URL";
    try {
      const url = new URL(value);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return "Unsafe source URL";
    } catch { return "Invalid source URL"; }
    return null;
  }
  function metadataIssue(p, { partial = false } = {}) {
    if (!p || typeof p !== "object" || Array.isArray(p)) return "Invalid catalogue record";
    if ((!partial || p.id != null) && (typeof p.id !== "string" || !ID.test(p.id))) return "Invalid catalogue ID";
    for (const [key, max, filename] of [["subject", 240, true], ["school", 300, true], ["title", 1200, false]]) {
      // Sparse reviewed imports/filename snapshots may have unknown (null)
      // metadata; they can merge into a complete exact-source owner, never
      // become complete active records on their own. Strings still validate.
      if ((!partial || p[key] != null) && labelIssue(p[key], max, filename)) return "Invalid catalogue " + key;
    }
    if (p.year !== undefined && p.year !== null) {
      try { if (typeof p.year !== "number" || year(p.year) !== p.year) return "Invalid catalogue year"; }
      catch { return "Invalid catalogue year"; }
    }
    if ((!partial || p.type != null) && !TYPES.has(p.type)) return "Invalid catalogue type";
    for (const key of ["url", "solutionUrl", "fallbackUrl", "solFallbackUrl"]) { const issue = urlIssue(p[key]); if (issue) return issue; }
    if (p.relatedSubjects !== undefined && (!Array.isArray(p.relatedSubjects) || p.relatedSubjects.some(s => labelIssue(s, 240, true)))) return "Invalid related subjects";
    return null;
  }
  function issues(catalogue) {
    const errors = [];
    if (!catalogue || !Array.isArray(catalogue.papers) || !Array.isArray(catalogue.recoveryPapers || [])) return ["Invalid catalogue arrays"];
    const aliases = catalogue.idAliases || {};
    if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) return ["Invalid alias graph"];
    for (const [from, to] of Object.entries(aliases)) if (!ID.test(from) || typeof to !== "string" || !ID.test(to)) errors.push("Invalid alias ID");
    for (const p of [...catalogue.papers, ...(catalogue.recoveryPapers || [])]) {
      const issue = metadataIssue(p); if (issue) errors.push(issue + " (" + JSON.stringify(p?.id) + ")");
      for (const key of ["libraryAliases", "alternateSources", "fileVariants", "provenanceSources"]) {
        if (p?.[key] === undefined) continue;
        if (!Array.isArray(p[key])) { errors.push("Invalid " + key); continue; }
        for (const row of p[key]) {
          const problem = metadataIssue(row, { partial: true }); if (problem) errors.push(problem + " in " + key);
          for (const old of [row?.libraryRecord, ...(Array.isArray(row?.libraryAliases) ? row.libraryAliases : [])].filter(Boolean)) {
            const problem = metadataIssue(old, { partial: true }); if (problem) errors.push(problem + " in historical filename");
          }
        }
      }
    }
    return errors;
  }
  function assert(catalogue) { const errors = issues(catalogue); if (errors.length) throw new Error(errors.join("\n")); }
  return { year, metadataIssue, issues, assert, urlIssue };
});
