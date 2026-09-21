/* ==========================================================================
   SITE CONFIG — point this site at your remote file host
   --------------------------------------------------------------------------
   The actual PDFs live on ANOTHER site (R2 / S3 / VPS / Google Drive mirror
   etc). This front-end never stores PDFs itself — it just builds download
   links from FILE_HOST_BASE_URL + each paper's `path` in data/papers.json.

   To go live:
   1. Upload your PDFs to the file host preserving folder structure, e.g.
        2024/Maths-Advanced/Sydney-Boys-Trial-Paper.pdf
   2. Change FILE_HOST_BASE_URL below to your host.
   3. Make sure the host sends `Access-Control-Allow-Origin: *` if you want
      "Download as ZIP" to work (ZIP fetches files via JS). Plain single-file
      downloads work with NO CORS setup — they're just <a href> links.

   Examples:
   - Cloudflare R2 public bucket : "https://papers.yourdomain.com"
   - AWS S3 static hosting       : "https://hsc-papers.s3.ap-southeast-2.amazonaws.com"
   - GitHub Releases / Pages     : "https://username.github.io/hsc-files"
   - Any direct-link host        : entries in papers.json can also use a full
     https:// URL in `path` to override the base for one-off files.
   ========================================================================== */

const SITE_CONFIG = {
  // 👇 CHANGE THIS to your real file host. No trailing slash.
  FILE_HOST_BASE_URL: "https://files.example.com/hsc-papers",

  SITE_NAME: "HSC Papers Mirror",
  TAGLINE: "THSCOnline-style mirror — Trial & HSC papers",
  CONTACT_EMAIL: "admin@example.com",

  // ZIP filename when users bulk-download a selection
  ZIP_NAME: "hsc-papers-selection.zip",

  // Max files per ZIP to keep browsers happy (user can repeat in batches)
  MAX_ZIP_FILES: 30,
};

/**
 * Resolve a paper's `path` to a full download URL.
 * - Absolute URLs (http…) are returned as-is (per-file override).
 * - Site-local files (./, ../, /-rooted, data/, or the local test folders
 *   like "Maths Advanced/…", "Physics/…") resolve relative to THIS site,
 *   NOT the remote file host — so local test PDFs just work.
 * - Everything else is joined onto FILE_HOST_BASE_URL.
 */
function fileUrl(path) {
  if (!path) return "#";
  if (/^https?:\/\//i.test(path)) return path;
  if (/^(\.\.?\/|\/|data\/|Maths Advanced\/|Physics\/)/.test(path)) return encodeURI(path);
  const base = (SITE_CONFIG.FILE_HOST_BASE_URL || "").replace(/\/+$/, "");
  const clean = String(path).replace(/^\/+/, "");
  return base ? `${base}/${clean}` : clean;
}

// Expose for app.js (works with plain <script> tags, no modules needed)
window.SITE_CONFIG = SITE_CONFIG;
window.fileUrl = fileUrl;
