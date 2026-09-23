/* ==========================================================================
   SITE CONFIG — HSCPapers (web + desktop share this file)
   --------------------------------------------------------------------------
   Downloads model: the catalogue (data/papers.json) carries ABSOLUTE file
   URLs per entry — fast files come straight from the community mirrors
   (HSC Portal, PapersDB) or official sources (Board of Studies, NESA).
   This front-end hosts no PDFs itself.

   - Single downloads: plain links, no CORS setup needed.
   - Browser "Download ZIP": fetches via JS, so it only works for sources
     that send Access-Control-Allow-Origin: *. Files that fail are skipped
     with a hint to use "Download individually".
   - FILE_HOST_BASE_URL is only needed if you later add entries whose
     `path` is relative to a bucket you own (e.g. Cloudflare R2).
   ========================================================================== */

const SITE_CONFIG = {
  // Optional: base URL of your own file host (R2 / S3 / …). Empty = none.
  FILE_HOST_BASE_URL: "",

  // Same-origin CORS proxy (Pages Function) for reader/ZIP fetches against
  // sources that don't send Access-Control-Allow-Origin (PapersDB, BOS).
  // The function itself allowlists hosts. Empty string = no proxy
  // (those sources fall back to the "use ⭳" hint).
  PROXY_BASE: "/proxy",

  // Small badge in the nav showing where files come from.
  HOST_BADGE: "index · mirrors",

  SITE_NAME: "HSCPapers",
  TAGLINE: "Every NSW HSC paper — searchable, readable, downloadable",
  CONTACT_EMAIL: "",

  // ZIP filename when users bulk-download a selection
  ZIP_NAME: "hsc-papers-selection.zip",

  // Browser ZIP limits: each file is fetched into tab RAM, so the count
  // cap plus a running byte budget keep the build inside safe memory.
  // Budget is enforced during the build with real sizes — an oversized
  // selection still produces a partial ZIP with a note, not a crash.
  // The desktop app has no such limits (Rust backend streams to disk).
  MAX_ZIP_FILES: 200,
  MAX_ZIP_BUDGET_MB: 500,

  // Desktop app download link (footer + about). Empty string hides the button.
  DESKTOP_APP_URL: "https://github.com/chubbycavy/HSCPapers/releases/latest",
};

/**
 * Resolve a paper's `path` to a full download URL.
 * - Absolute URLs (http…) are returned as-is (the normal case — mirrors).
 * - Site-local files (./, ../, /-rooted, data/) resolve relative to THIS
 *   site — used by the local test folders and dev setups.
 * - Everything else is joined onto FILE_HOST_BASE_URL.
 */
function fileUrl(path) {
  if (!path) return "#";
  if (/^https?:\/\//i.test(path)) return path;
  if (/^(\.\.?\/|\/|data\/)/.test(path)) return encodeURI(path);
  const base = (SITE_CONFIG.FILE_HOST_BASE_URL || "").replace(/\/+$/, "");
  const clean = String(path).replace(/^\/+/, "");
  return base ? `${base}/${clean}` : clean;
}

// Expose for app.js (works with plain <script> tags, no modules needed)
window.SITE_CONFIG = SITE_CONFIG;
window.fileUrl = fileUrl;
