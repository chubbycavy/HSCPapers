export const ALLOWED_HOSTS = new Set([
  "hscportal.pages.dev", "www.nsw.gov.au", "www.boardofstudies.nsw.edu.au",
  "thsconline.github.io", "thsconline.pages.dev", "thsconline.com.au",
]);
export const EXPORT_APIS = [
  "https://script.google.com/macros/s/AKfycbzwc57zmEK1Vm9Q5L1n1my3dxRafZRfNhCZ24zSLIa9H7MhySFhNahvPfW4R3uq753_/exec",
  "https://script.google.com/macros/s/AKfycbxCi8vsX-_l5a0JP-mG1RXIbSeiuZOfteumnk96oZCgQMR9nHjikpDqpknUHp-K5hg/exec",
  "https://script.google.com/macros/s/AKfycbz0Jc62sHl3IKUJNpqYZp6FGf85aERQKg4SITYgb0pbOJXGvo7CVshdIhN3AEbEBkQmww/exec",
  "https://script.google.com/macros/s/AKfycbwMElTU5QdXoUEc4yWj8mUbF-753lHMFAafJnGuaV8WpACWy16DWhXS8KfJA_HKEZ03Q/exec",
  "https://script.google.com/macros/s/AKfycbwafzfiazfcLyo4MPomtJV8j8P3Ys5Y5Z5dlbo6X_Ddll40NQyylFotiGP4RmlNEPNFpg/exec",
  "https://script.google.com/macros/s/AKfycbz2OkJ8-2GbIVWOAOAP0Qp37Sts2tclovMTtGEIfqWRkePvz1G1Ag3YywZNyDxeBtYkjg/exec",
  "https://script.google.com/macros/s/AKfycbyMS8xD-tK6wRe7wc3fyKAX7MmLiLOU5CTLHVV_HLNImZFx8SsPA2Cvhcc0Ml2TUeas/exec",
  "https://script.google.com/macros/s/AKfycbyOERxQbjmX6cmaY9txazA2MFY7y66ylYHyGG1FeGFHARXk36jLvIOGJUsUoy8VmOrp/exec",
  "https://script.google.com/macros/s/AKfycbx0LmnTURBcvLI1I4hASnAOTOkqsNEWToguRNAkypoIiGorRQr6YyqFlbOaZjtnWBjx/exec",
  "https://script.google.com/macros/s/AKfycbyaAQFka8STu0Fupxt333SW2T-7InSqmY6moyRs8-YGHucSiFqqpyCE4vktadLziRPe/exec",
  "https://script.google.com/macros/s/AKfycbxBXfKvsLNcAoiD1usgXLJejnVbGJ4Q0c9WYdufoHoIsuC4bbLKPlQ4XsLPNHRFAzilow/exec",
  "https://script.google.com/macros/s/AKfycbw3FjfIIds8UpY4GE_Jdu9hF8Mf58govLZcdpVdHOqb6IbF_A8F2cgtkvv--iEgOEzm/exec",
  "https://script.google.com/macros/s/AKfycbyzcBH0M5Np7XQf4aaGktd0zgHt5Sa0CRAXiG-XiUyWd5jzEN1qLDcjXbpVgu0LKQbJ/exec",
  "https://script.google.com/macros/s/AKfycbxq4Pi15A7VI2PQGJBnCU0OL0K08gfqbl1dRQEwQc5dcELs1BUoGBw8s9cGQHQncmjh/exec",
  "https://script.google.com/macros/s/AKfycbwYhBoXMfdf0QisZrOiUqr27DwE5Hf9hIYAeXV9SfYce-j5VrdwXkJp_wKSwV70yOe6TQ/exec",
  "https://script.google.com/macros/s/AKfycbx69GPoJtf9sSevsUbWtPr46vpa01u4oNkHjFmkkWxmj62AZ0q-/exec",
];
const THSC_ROUTER_HOSTS = new Set(["thsconline.github.io", "thsconline.pages.dev"]);
const THSC_ROUTER_RE = /^\/s\/(?:d|v|f|z|fz)\/(\d{1,8})\/(.+)$/;
const UA = "HSCPapers/1.0 (study use; cached index, on-demand downloads)";
const CACHE_SECONDS = 21600;
const MAX_JSON_BYTES = 24 * 1024 * 1024;
const MEMORY_BUDGET = 8 * 1024 * 1024;
const cors = extra => ({
  "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range, If-Range, Origin",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, Content-Type, ETag",
  ...extra,
});
const encQ = s => encodeURIComponent(s).replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
const hex = async data => [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))].map(b => b.toString(16).padStart(2, "0")).join("");
const error = (message, status = 502, extra = {}) => new Response(message, { status, headers: cors({ "Cache-Control": "no-store", ...extra }) });

async function limitedText(response, limit) {
  if (Number(response.headers.get("content-length")) > limit) throw new Error("Resolver response is too large");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error("Resolver response is too large");
      chunks.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return new TextDecoder().decode(bytes);
}

export function createProxyHandler({ fetchImpl = (...args) => fetch(...args), cache = () => globalThis.caches?.default, gapMs = 1500, timeoutMs = 90000, now = () => Date.now(), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let apiIdx = null;
  let tail = Promise.resolve(), pending = 0, lastEnd = 0, cooldown = 0, memoryBytes = 0;
  const inFlight = new Map(), memory = new Map();

  async function resolveRouter(viewno, title) {
    if (pending >= 4 || now() < cooldown) return { failure: error("THSC resolver busy — try again shortly", 503, { "Retry-After": "60" }) };
    pending++;
    const job = tail.catch(() => {}).then(async () => {
      if (now() < cooldown) return { failure: error("THSC resolver throttled — try again shortly", 503, { "Retry-After": "60" }) };
      const wait = Math.max(0, lastEnd + gapMs - now());
      if (wait) await sleep(wait);
      try {
        const hash = await hex(new TextEncoder().encode(viewno));
        if (apiIdx === null) apiIdx = crypto.getRandomValues(new Uint32Array(1))[0] % EXPORT_APIS.length;
        const api = EXPORT_APIS[apiIdx++ % EXPORT_APIS.length];
        const url = `${api}?export=data&field=${encQ(title)}&base=${encQ(viewno)}&hash=${hash}`;
        const upstream = await fetchImpl(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        if ([404, 429, 503].includes(upstream.status)) {
          cooldown = now() + 60000;
          await upstream.body?.cancel();
          return { failure: error("THSC resolver throttled — try again shortly", 503, { "Retry-After": "60" }) };
        }
        if (!upstream.ok) { await upstream.body?.cancel(); return { failure: error(`THSC resolver HTTP ${upstream.status}`) }; }
        const text = await limitedText(upstream, MAX_JSON_BYTES);
        const match = text.match(/^\s*downloadfile\(([\s\S]*)\)\s*;?\s*$/);
        if (!match) return { failure: error("THSC resolver returned an unexpected response") };
        let record;
        try { record = JSON.parse(match[1]); } catch { return { failure: error("THSC resolver returned invalid JSON") }; }
        if (typeof record?.data !== "string" || !record.data.trim()) return { failure: error("THSC resolver returned no file data") };
        let decoded;
        try { decoded = atob(record.data.replace(/\s/g, "")); } catch { return { failure: error("THSC resolver returned invalid base64") }; }
        if (!decoded.startsWith("%PDF-") || !decoded.slice(-4096).includes("%%EOF")) return { failure: error("THSC resolver returned a web page or invalid PDF") };
        const bytes = new Uint8Array(decoded.length);
        for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
        return { bytes, etag: `"${await hex(bytes)}"` };
      } catch (e) { return { failure: error(`THSC resolver unavailable: ${e.message}`) }; }
      finally { lastEnd = now(); }
    });
    tail = job.then(() => {}, () => {});
    try { return await job; } finally { pending--; }
  }

  async function routerResponse(request, target, match) {
    const viewno = match[1];
    let title;
    try { title = decodeURIComponent(match[2]).replace(/&/g, "_"); } catch { return error("Malformed THSC title", 400); }
    const key = viewno + "|" + title;
    const cacheKey = new Request(new URL("/__resolved_pdf/v1/" + await hex(new TextEncoder().encode(key)), request.url));
    const edge = typeof cache === "function" ? cache() : cache;
    let cached;
    try { cached = await edge?.match(cacheKey); } catch {}
    if (cached) return present(cached, request, target);
    const item = memory.get(key);
    if (item && item.until > now()) return present(pdfResponse(item), request, target);
    if (!inFlight.has(key)) {
      const job = resolveRouter(viewno, title).then(async result => {
        if (result.failure) return result;
        if (result.bytes.length <= MEMORY_BUDGET) {
          while (memoryBytes + result.bytes.length > MEMORY_BUDGET && memory.size) {
            const oldest = memory.keys().next().value;
            memoryBytes -= memory.get(oldest).bytes.length;
            memory.delete(oldest);
          }
          if (memory.has(key)) memoryBytes -= memory.get(key).bytes.length;
          memory.set(key, { ...result, until: now() + CACHE_SECONDS * 1000 });
          memoryBytes += result.bytes.length;
        }
        try { await edge?.put(cacheKey, pdfResponse(result)); } catch {}
        return result;
      }).finally(() => inFlight.delete(key));
      inFlight.set(key, job);
    }
    const result = await inFlight.get(key);
    if (result.failure) return result.failure.clone();
    return present(pdfResponse(result), request, target);
  }

  return async function onRequest({ request }) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (!["GET", "HEAD"].includes(request.method)) return error("Method not allowed", 405);
    let target;
    try { target = new URL(new URL(request.url).searchParams.get("url")); } catch { return error("Bad request: missing ?url=", 400); }
    if (!/^https?:$/.test(target.protocol) || !ALLOWED_HOSTS.has(target.host) || target.username || target.password) return error("Forbidden: host not allowed", 403);
    const match = THSC_ROUTER_HOSTS.has(target.host) && THSC_ROUTER_RE.exec(target.pathname);
    if (match) return routerResponse(request, target, match);
    if (THSC_ROUTER_HOSTS.has(target.host) && /^\/s\/(?:d|v|fz|f|z)(?:\/|$)/.test(target.pathname)) return error("Malformed THSC router URL", 400);
    const family = { "www.nsw.gov.au": "nsw.gov.au", "www.boardofstudies.nsw.edu.au": "nsw.edu.au" }[target.host];
    const hopAllowed = host => ALLOWED_HOSTS.has(host) || (family && (host === family || host.endsWith("." + family)));
    const fwd = { "User-Agent": UA, "Accept-Encoding": "identity" };
    for (const name of ["range", "if-range"]) { const value = request.headers.get(name); if (value) fwd[name] = value; }
    try {
      let next = target;
      for (let hop = 0; hop < 5; hop++) {
        const upstream = await fetchImpl(next.toString(), { method: request.method, headers: fwd, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        const location = upstream.headers.get("location");
        if (upstream.status >= 300 && upstream.status < 400 && location) {
          await upstream.body?.cancel();
          next = new URL(location, next);
          if (!/^https?:$/.test(next.protocol) || !hopAllowed(next.host) || next.username || next.password) return error("Forbidden: redirect host not allowed", 403);
          continue;
        }
        const headers = new Headers(cors());
        for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "etag", "last-modified", "cache-control"]) {
          const value = upstream.headers.get(name);
          if (value) headers.set(name, value);
        }
        return present(new Response(request.method === "HEAD" ? null : upstream.body, { status: upstream.status, headers }), request, target);
      }
      return error("Upstream redirect limit exceeded");
    } catch (e) { return error(`Upstream fetch failed: ${e.message}`); }
  };
}

function pdfResponse({ bytes, etag }) {
  return new Response(bytes, { headers: cors({ "Content-Type": "application/pdf", "Content-Length": String(bytes.length), "ETag": etag, "Cache-Control": `public, max-age=300, s-maxage=${CACHE_SECONDS}` }) });
}
function present(response, request, target) {
  const headers = new Headers(response.headers);
  if (new URL(request.url).searchParams.get("dl") === "1" && response.ok) {
    let filename;
    try { filename = decodeURIComponent(target.pathname.split("/").pop()); } catch { filename = "paper.pdf"; }
    filename = (filename || "paper.pdf").replace(/[\x00-\x1f\x7f\\/:*?"<>|]+/g, "-").slice(-80);
    const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
    headers.set("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encQ(filename)}`);
  }
  return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
}
export const onRequest = createProxyHandler();
