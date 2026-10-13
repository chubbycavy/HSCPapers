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
  return { FAST_SAVE_HOSTS, isFast, isFragment, isLegacy, allowedPrimary, eligible, candidates, deliveryHref };
});
