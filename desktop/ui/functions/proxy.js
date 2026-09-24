// Pages Function: same-origin CORS proxy for PDF sources that don't send
// Access-Control-Allow-Origin (PapersDB CDN, Board of Studies archive).
// Enables the embedded reader (PDF.js range requests) and browser ZIP
// fetches for those sources. Portal already sends ACAO:* — it stays direct.
//
// Hard host allowlist — this is NOT an open proxy. NESA wcm links are
// deliberately excluded (they serve HTML wrappers, not PDFs).
const ALLOWED_HOSTS = new Set([
  "hscportal.pages.dev",
  "cdn.papersdb.org",
  "www.boardofstudies.nsw.edu.au",
]);

// PDF.js issues ranged GETs; mirror them so the reader stays fast.
const PASS_HEADERS = ["range", "if-range", "accept-encoding", "user-agent"];
const EXPOSE = "Content-Length, Content-Range, Accept-Ranges, Content-Type";

function cors(extra) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "Range, If-Range, Origin",
    "Access-Control-Expose-Headers": EXPOSE,
    ...extra,
  };
}

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors() });
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: cors() });
  }

  const raw = url.searchParams.get("url");
  let target;
  try {
    target = new URL(raw);
  } catch {
    return new Response("Bad request: missing ?url=", { status: 400, headers: cors() });
  }
  if (!/^https?:$/.test(target.protocol) || !ALLOWED_HOSTS.has(target.host)) {
    return new Response("Forbidden: host not allowed", { status: 403, headers: cors() });
  }

  // ?dl=1 -> force-download: Content-Disposition attachment instead of the
  // source's inline display. Used by the instant-download card buttons.
  const forceDownload = url.searchParams.get("dl") === "1";
  const downloadName = (() => {
    const seg = target.pathname.split("/").pop() || "paper.pdf";
    try { return decodeURIComponent(seg).replace(/[\\/:*?"<>|]+/g, "-").slice(-80) || "paper.pdf"; }
    catch { return "paper.pdf"; }
  })();

  const fwd = {};
  for (const h of PASS_HEADERS) {
    const v = request.headers.get(h);
    if (v) fwd[h] = v;
  }

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: request.method,
      headers: fwd,
      redirect: "follow",
    });
  } catch (e) {
    return new Response("Upstream fetch failed: " + (e?.message || e), {
      status: 502,
      headers: cors(),
    });
  }

  // Real Headers object — the plain cors() object is fine when passed
  // directly into new Response(...), but .set() needs a Headers instance.
  const headers = new Headers(cors());
  for (const h of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (forceDownload) headers.set("Content-Disposition", `attachment; filename="${downloadName}"`);
  return new Response(upstream.body, { status: upstream.status, headers });
}
