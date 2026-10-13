// Shared by the hosted/local proxy and the operator's catalogue audit.
// /s/v/... is a transport descriptor, not an HTML viewer to fetch or embed.
export const THSC_NET_HOSTS = new Set(["www.thsconline.net", "thsconline.net"]);
export const THSC_API_ORIGIN = "https://www.thsconline.net";
export const PLACEHOLDER_SHA256 = "ae3414ce7149e4f808bca8563d46b813a36af04c5651762c47ce0f854ff0561c";
export const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_FRAGMENTS = 16;
export class SourceError extends Error {
  constructor(message, status = 502, code = "invalid-source") { super(message); this.status = status; this.code = code; }
}
export function sanitizeThscTitle(value) {
  return String(value || "").trim().replace(/&amp;/gi, "&").replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'").replace(/&nbsp;/gi, " ")
    .replace(/\(Adv\.\)/g, "__ADV__").replace(/\(Std\.\)/g, "__STD__")
    .replace(/[^A-Za-z0-9._\- ]/g, "").replace(/__ADV__/g, "(Adv.)").replace(/__STD__/g, "(Std.)");
}
export function fragmentDescriptor(value) {
  const u = new URL(value);
  if (!THSC_NET_HOSTS.has(u.host)) return null;
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash)
    throw new SourceError("Malformed THSC fragment descriptor", 400, "bad-descriptor");
  const match = /^\/s\/v\/(\d{1,8})\/([^/]+)$/.exec(u.pathname);
  if (!match) throw new SourceError("Malformed THSC fragment descriptor", 400, "bad-descriptor");
  let rawTitle;
  try { rawTitle = decodeURIComponent(match[2]); } catch { throw new SourceError("Malformed THSC title encoding", 400, "bad-descriptor"); }
  const title = sanitizeThscTitle(rawTitle);
  if (!title || title.length > 400) throw new SourceError("Invalid THSC lookup title", 400, "bad-descriptor");
  return { viewno: match[1], title, rawTitle };
}
export function fragmentUrl(viewno, rawTitle) {
  return `${THSC_API_ORIGIN}/s/v/${viewno}/${encodeURIComponent(rawTitle)}`;
}
export async function readBounded(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) { await response.body?.cancel(); throw new SourceError("Source exceeds transport byte limit", 413, "size-limit"); }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length;
      if (size > limit) throw new SourceError("Source exceeds transport byte limit", 413, "size-limit");
      parts.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}
export async function pdfProof(bytes, placeholderShas = new Set([PLACEHOLDER_SHA256])) {
  if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-" ||
      !new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 4096))).includes("%%EOF"))
    throw new SourceError("Source returned HTML or an incomplete PDF", 502, "not-pdf");
  const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
  if (placeholderShas.has(sha256)) throw new SourceError("THSC returned its 404 placeholder; requested file unavailable", 404, "placeholder");
  return { sha256, bytes: bytes.length };
}
async function decompressGzip(pieces) {
  const total = pieces.reduce((s, p) => s + p.length, 0);
  const combined = new Uint8Array(total);
  let off = 0;
  for (const p of pieces) { combined.set(p, off); off += p.length; }
  const stream = new ReadableStream({
    start(c) { c.enqueue(combined); c.close(); }
  }).pipeThrough(new DecompressionStream("gzip"));
  return await readBounded(new Response(stream), MAX_PDF_BYTES);
}

export async function resolveFragments({ viewno, title }, { fetchImpl = fetch, signal = AbortSignal.timeout(30000), placeholderShas, onProgress = () => {} } = {}) {
  const key = `${encodeURIComponent(viewno)}/${encodeURIComponent(title)}`;
  async function request(path) {
    const response = await fetchImpl(`${THSC_API_ORIGIN}/api/v1/${path}/${key}`, { signal, redirect: "error", headers: { "User-Agent": "HSCPapers/1.0 (verified THSC delivery)" } });
    if (!response.ok) {
      await response.body?.cancel();
      const transient = [429, 503, 504].includes(response.status);
      throw new SourceError(`THSC ${path} HTTP ${response.status}`, transient ? 503 : 502, transient ? "transient" : "upstream-http");
    }
    return response;
  }
  const metadataBytes = await readBounded(await request("getmetadata"), 65536);
  let metadata;
  try { metadata = JSON.parse(new TextDecoder().decode(metadataBytes)); } catch { throw new SourceError("Invalid THSC metadata JSON"); }
  if (metadata?.error) throw new SourceError("THSC metadata reports the requested file unavailable", 404, "not-migrated");
  const count = Number(metadata?.fragmentCount);
  if (count === 0) throw new SourceError("File not available through THSC's migrated transport", 404, "not-migrated");
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_FRAGMENTS) throw new SourceError("Invalid THSC fragment count");
  const pieces = new Array(count); let next = 0, compressedSize = 0;
  async function worker() {
    while (next < count) {
      const i = next++;
      const response = await fetchImpl(`${THSC_API_ORIGIN}/api/v1/getfragment/${key}/${i}`, { signal, redirect: "error", headers: { "User-Agent": "HSCPapers/1.0 (verified THSC delivery)" } });
      if (!response.ok) { await response.body?.cancel(); throw new SourceError(`THSC fragment ${i} HTTP ${response.status}`, [429, 503].includes(response.status) ? 503 : 502); }
      pieces[i] = await readBounded(response, MAX_COMPRESSED_BYTES);
      compressedSize += pieces[i].length;
      if (compressedSize > MAX_COMPRESSED_BYTES) throw new SourceError("Compressed file exceeds transport byte limit", 413, "size-limit");
      onProgress(compressedSize);
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, count) }, worker));
  if (signal.aborted) throw signal.reason;
  let bytes;
  try {
    bytes = await decompressGzip(pieces);
  } catch (e) { if (e instanceof SourceError) throw e; throw new SourceError("THSC returned incomplete or invalid gzip fragments"); }
  const proof = await pdfProof(bytes, placeholderShas);
  return { ...proof, bytes, byteLength: proof.bytes, metadata };
}
