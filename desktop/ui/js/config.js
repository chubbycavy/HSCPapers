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

  // Small badge in the nav showing where files come from.
  HOST_BADGE: "index · mirrors",

  SITE_NAME: "HSC Papers",
  TAGLINE: "Trial & HSC papers — THSCOnline-style index",
  CONTACT_EMAIL: "",

  // ZIP filename when users bulk-download a selection
  ZIP_NAME: "hsc-papers-selection.zip",

  // Max files per browser ZIP (kept small: each file is fetched into RAM,
  // and polite caps matter while files come from community mirror CDNs).
  // The desktop app has no such limit (Rust backend streams to disk).
  MAX_ZIP_FILES: 30,

  // Desktop app download link (footer). Empty string hides the button.
  DESKTOP_APP_URL: "https://github.com/chubbycavy/HSCPapers/releases",
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
