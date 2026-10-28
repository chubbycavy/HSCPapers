/* Shared eligibility; catalogue admission, rather than runtime discovery, supplies sources. */
((root, factory) => {
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  else root.SourcePolicy = policy;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  "use strict";
  const FAST_SAVE_HOSTS = new Set(["hscportal.pages.dev", "pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev", "www.nsw.gov.au", "www.boardofstudies.nsw.edu.au", "thsconline.github.io", "thsconline.com.au", "web.archive.org", "aceh.b-cdn.net", "4unitmaths.com", "cresteconomics.com"]);
  const route = /^\/s\/(?:d|v|fz|f|z)\//;
  function isFast(url) { try { const u = new URL(url); return !route.test(u.pathname) && FAST_SAVE_HOSTS.has(u.host); } catch { return false; } }
  function isFragment(url) { try { return ["www.thsconline.net", "thsconline.net"].includes(new URL(url).host); } catch { return false; } }
  function isLegacy(url) { try { const u = new URL(url); return ["thsconline.github.io", "thsconline.pages.dev"].includes(u.host) && route.test(u.pathname); } catch { return false; } }
  function eligible(primary, candidate, allowSlow) {
    return !!candidate && candidate !== primary && !(isFragment(primary) && isLegacy(candidate)) && (allowSlow || isFast(candidate));
  }
  function allowedPrimary(url, allowSlow) { return !!url && (allowSlow || isFast(url)); }
  function candidates(record, kind, primary, allowSlow, exactVersion = false, explicitFallback = null) {
    if (!allowedPrimary(primary, allowSlow)) return [];
    const backups = exactVersion ? [] : kind === "paper"
      ? [...(record?.alternateSources || []).map(s => s.url), record?.fallbackUrl, explicitFallback]
      : [record?.solFallbackUrl, explicitFallback];
    return [...new Set([primary, ...backups].filter(Boolean))].filter(u => u === primary || eligible(primary, u, allowSlow));
  }
  // Stable public delivery URL; preserve the raw URL for identity/library hashing.
  function deliveryHref(url, proxyBase) {
    if (!url || !(isFragment(url) || isLegacy(url))) return url;
    return proxyBase + "?url=" + encodeURIComponent(url) + "&dl=1";
  }
  // Display-only attribution follows the file host, not listing metadata or a
  // stale mirror label. These links do not change download eligibility.
  function credit(url) {
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== "https:" || u.username || u.password) return null;
    switch (u.host) {
      case "hscportal.pages.dev": return { name: "HSC Portal", href: "https://www.hscportal.app/" };
      case "www.nsw.gov.au": return { name: "NESA", href: "https://www.nsw.gov.au/education-and-training/nesa" };
      case "www.boardofstudies.nsw.edu.au": return { name: "Board of Studies", href: "https://www.boardofstudies.nsw.edu.au/hsc_exams/" };
      case "pub-ec23c9b69d2544938d816ad28ee491fd.r2.dev": return { name: "HSCPapers", href: "https://hscpapers.com/#sources" };
      case "thsconline.github.io":
      case "thsconline.pages.dev":
      case "www.thsconline.net":
      case "thsconline.net": return { name: "THSCOnline", href: "https://thsconline.github.io/s/" };
      case "thsconline.com.au": return { name: "independent THSC mirror", href: "https://thsconline.com.au/#/about" };
      case "web.archive.org": return { name: "Internet Archive", href: "https://web.archive.org/" };
      case "aceh.b-cdn.net": return { name: "AceHSC", href: "https://www.acehsc.net/" };
      case "4unitmaths.com": return { name: "4unitmaths", href: "https://4unitmaths.com/" };
      case "cresteconomics.com": return { name: "CREST Economics", href: "https://www.cresteconomics.com/" };
      default: return null;
    }
  }
  return { FAST_SAVE_HOSTS, isFast, isFragment, isLegacy, allowedPrimary, eligible, candidates, deliveryHref, credit };
});
