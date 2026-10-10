/* Historical catalogue IDs resolve to active IDs. No alias is a second card. */
(function (root) {
  "use strict";
  function resolve(id, aliases, active) {
    const seen = new Set();
    while (aliases[id]) { if (seen.has(id)) return null; seen.add(id); id = aliases[id]; }
    return active.has(id) ? id : null;
  }
  function remap(ids, aliases, active) {
    return [...new Set((ids || []).map(id => resolve(id, aliases, active)).filter(Boolean))];
  }
  const api = { resolve, remap };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CatalogueAliases = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
