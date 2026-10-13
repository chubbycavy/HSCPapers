(function (root) {
  "use strict";
  const PLACEHOLDER_SHA = "ae3414ce7149e4f808bca8563d46b813a36af04c5651762c47ce0f854ff0561c";
  async function validateBlob(blob) {
    if ((await blob.slice(0, 5).text()) !== "%PDF-" || !(await blob.slice(-4096).text()).includes("%%EOF"))
      throw new Error("Source returned HTML or an incomplete PDF");
    if (blob.size === 92354) {
      const sha = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(b => b.toString(16).padStart(2, "0")).join("");
      if (sha === PLACEHOLDER_SHA) throw new Error("THSC returned its 404 placeholder; requested file unavailable");
    }
    return blob;
  }
  const api = { validateBlob, PLACEHOLDER_SHA };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PdfValidation = api;
})(globalThis);
