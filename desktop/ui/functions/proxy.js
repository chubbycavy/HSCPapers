// Pages Function: same-origin CORS proxy for PDF sources that don't send
// Access-Control-Allow-Origin (Board of Studies archive).
// Enables the embedded reader (PDF.js range requests) and browser ZIP
// fetches for those sources. Portal and our self-hosted R2 bucket already
// send ACAO:* — they stay direct.
//
// Hard host allowlist — this is NOT an open proxy. NESA wcm links are
// deliberately excluded (they serve HTML wrappers, not PDFs). A third-party
// mirror was delisted 2026-09-25 at its maintainer's request and is likewise
// excluded (its papers are now self-hosted — see desktop/tools/selfhost.json).
const ALLOWED_HOSTS = new Set([
  "hscportal.pages.dev",
  "www.nsw.gov.au",
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

  // Same-family redirect following: redirects may leave the exact allowlist
  // ONLY within the original target's own registrable-domain family (e.g.
  // nsw.gov.au → educationstandards.nsw.gov.au). Shared-hosting platforms
  // (pages.dev — anyone can host there) get exact-match hops only.
  const HOST_FAMILY = {
    "www.nsw.gov.au": "nsw.gov.au",
    "www.boardofstudies.nsw.edu.au": "nsw.edu.au",
  };
  const family = HOST_FAMILY[target.host] || null;
  const hopAllowed = (host) =>
    ALLOWED_HOSTS.has(host) || (family ? host === family || host.endsWith("." + family) : false);

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
  let targetUrl = target.toString();
  try {
    // Manual redirect following with EVERY hop re-validated against the
    // allowlist — redirect:"follow" would let an allowlisted host's 302
    // launder arbitrary-origin bytes through this proxy.
    for (let hop = 0; hop < 5; hop++) {
      upstream = await fetch(targetUrl, {
        method: request.method,
        headers: fwd,
        redirect: "manual",
      });
      const loc = upstream.headers.get("location");
      if (upstream.status >= 300 && upstream.status < 400 && loc) {
        let next;
        try {
          next = new URL(loc, targetUrl);
        } catch {
          return new Response("Forbidden: unparseable redirect", { status: 403, headers: cors() });
        }
        if (!/^https?:$/.test(next.protocol) || !hopAllowed(next.host)) {
          return new Response("Forbidden: redirect to host not allowed", { status: 403, headers: cors() });
        }
        targetUrl = next.toString();
        continue;
      }
      break;
    }
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
