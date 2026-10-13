import test from "node:test";
import assert from "node:assert/strict";
import { createProxyHandler } from "../../ui/_lib/pdf-proxy.mjs";
import { onRequest as productionHandler } from "../../ui/functions/proxy.js";
import { gzipSync } from "node:zlib";
import { fragmentDescriptor, sanitizeThscTitle } from "../../ui/_lib/thsc-fragments.mjs";
const pdf = new TextEncoder().encode("%PDF-1.4\nregression fixture\n%%EOF");
const payload = () => new Response(`downloadfile(${JSON.stringify({ data: Buffer.from(pdf).toString("base64") })});`);
const request = (target, options = {}, dl = false) => ({ request: new Request("https://hscpapers.com/proxy?url=" + encodeURIComponent(target) + (dl ? "&dl=1" : ""), options) });
const route = "https://thsconline.github.io/s/d/5106/Sydney%20Boys%202004";
const handler = options => createProxyHandler({ cache: null, gapMs: 0, ...options });

test("actual production export returns PDF bytes, fixing the forceDownload TDZ", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => payload();
  try {
    const response = await productionHandler(request(route));
    assert.equal(response.status, 200);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf);
  } finally { globalThis.fetch = original; }
});
test("UTF-8 titles, ampersands and strict encoding match the native resolver", async () => {
  let url;
  const serve = handler({ fetchImpl: async value => { url = new URL(value); return payload(); } });
  const response = await serve(request("https://thsconline.pages.dev/s/v/5106/" + encodeURIComponent("École & O'Brien (試験)"), {}, true));
  assert.equal(response.status, 200);
  assert.equal(url.searchParams.get("field"), "École _ O'Brien (試験)");
  assert.equal(url.searchParams.get("base"), "5106");
  assert.match(url.search, /%C3%89/);
  assert.match(url.search, /%27/);
  assert.match(response.headers.get("content-disposition"), /attachment;.*filename\*=UTF-8''/);
});
test("HEAD, Range and attachment variants reuse the same full PDF", async () => {
  let calls = 0;
  const serve = handler({ fetchImpl: async () => { calls++; return payload(); } });
  const first = await serve(request(route));
  const head = await serve(request(route, { method: "HEAD" }, true));
  const ranged = await serve(request(route, { headers: { range: "bytes=1-5" } }));
  assert.equal(calls, 1);
  assert.equal(head.headers.get("content-length"), String(pdf.length));
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(ranged.status, 200);
  assert.equal(ranged.headers.get("accept-ranges"), null);
  assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), pdf);
  assert.equal(first.headers.get("content-disposition"), null);
  assert.match(head.headers.get("content-disposition"), /attachment/);
});
test("concurrent requests for one paper make one resolver call", async () => {
  let calls = 0;
  const serve = handler({ fetchImpl: async () => { calls++; await new Promise(r => setTimeout(r, 10)); return payload(); } });
  const responses = await Promise.all([serve(request(route)), serve(request(route)), serve(request(route, {}, true))]);
  assert.equal(calls, 1);
  for (const response of responses) assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf);
});
test("rate limits create a cooldown and do not trigger retry storms", async () => {
  let calls = 0;
  const serve = handler({ fetchImpl: async () => { calls++; return new Response(null, { status: 429 }); } });
  const first = await serve(request(route));
  const second = await serve(request(route.replace("2004", "2005")));
  assert.equal(first.status, 503);
  assert.equal(first.headers.get("retry-after"), "60");
  assert.equal(second.status, 503);
  assert.equal(calls, 1);
});
const payloadWith = (fileref) => new Response(`downloadfile(${JSON.stringify({ fileref, data: Buffer.from(pdf).toString("base64") })});`);
test("legitimate aliases sharing a fileref are validated rather than accused of corruption", async () => {
  let calls = 0;
  const serve = handler({ fetchImpl: async () => { calls++; return payloadWith("12TrRtJ9xfV4mo9O34MJ5_1YrHzjvirBR"); } });
  const first = await serve(request(route)); // 5106/Sydney Boys 2004
  assert.equal(first.status, 200);
  const second = await serve(request("https://thsconline.github.io/s/d/5106/Riverside%20Girls%202004"));
  assert.equal(second.status, 200);
  assert.deepEqual(new Uint8Array(await second.arrayBuffer()), pdf);
  // a different viewno may legitimately reference the same file: no refusal
  const otherView = await serve(request("https://thsconline.github.io/s/d/9999/Sydney%20Boys%202004"));
  assert.equal(otherView.status, 200);
  assert.equal(calls, 3);
});
test("a known placeholder PDF is unavailable, never cached as a successful paper", async () => {
  const realSha = Buffer.from(pdf).toString("base64"); // the pool serves this fixture for two titles below
  const serve = handler({ fetchImpl: async () => new Response(`downloadfile(${JSON.stringify({ data: realSha })});`) });
  const response = await serve(request(route));
  assert.equal(response.status, 200); // the pristine document still passes the default empty-ban list
  const banning = handler({ fetchImpl: async () => new Response(`downloadfile(${JSON.stringify({ data: realSha })});`), collapsedShas: new Set([await shaOf(pdf)]) });
  const withheld = await banning(request(route));
  assert.equal(withheld.status, 404);
  assert.match(await withheld.text(), /placeholder.*unavailable/);
  assert.equal(withheld.headers.get("cache-control"), "no-store");
});
async function shaOf(bytes) {
  const hex = await (await import("node:crypto")).webcrypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hex)].map(b => b.toString(16).padStart(2, "0")).join("");
}

for (const [label, body] of [
  ["HTML error", "<html>Google login</html>"],
  ["bad JSON", "downloadfile({no});"],
  ["missing data", "downloadfile({});"],
  ["bad base64", 'downloadfile({"data":"!!!!"});'],
  ["non-PDF data", 'downloadfile({"data":"PGh0bWw+ZXJyb3I8L2h0bWw+"});'],
]) test(`resolver rejects ${label} with an honest failure`, async () => {
  const serve = handler({ fetchImpl: async () => new Response(body) });
  const response = await serve(request(route));
  assert.equal(response.status, 502);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
test("plain proxy forwards byte ranges and preserves 206 headers", async () => {
  let options;
  const serve = handler({ fetchImpl: async (_, init) => { options = init; return new Response(pdf.subarray(0, 5), { status: 206, headers: { "content-type": "application/pdf", "content-range": `bytes 0-4/${pdf.length}`, "content-length": "5" } }); } });
  const response = await serve(request("https://thsconline.com.au/pdf/papers/example.pdf", { headers: { range: "bytes=0-4" } }));
  assert.equal(options.headers.range, "bytes=0-4");
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), `bytes 0-4/${pdf.length}`);
  assert.equal((await response.arrayBuffer()).byteLength, 5);
});
test("unapproved hosts, malformed routes and foreign redirects stay blocked", async () => {
  const serve = handler({ fetchImpl: async () => new Response(null, { status: 302, headers: { location: "https://papersdb.org/file.pdf" } }) });
  assert.equal((await serve(request("https://papersdb.org/file.pdf"))).status, 403);
  assert.equal((await serve(request("https://thsconline.github.io/s/d/not-a-number/test"))).status, 400);
  assert.equal((await serve(request("https://thsconline.com.au/pdf/papers/example.pdf"))).status, 403);
});
test("cache failures never turn a valid upstream PDF into an error", async () => {
  const serve = handler({ cache: { match() { throw new Error("cache unavailable"); }, put() { throw new Error("cache full"); } }, fetchImpl: async () => payload() });
  const response = await serve(request(route));
  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), pdf);
});

const netRoute = "https://www.thsconline.net/s/v/5338/Abbotsleigh%202022";
test("old-client ordinary and nested bridge URLs deliver migrated PDF bytes without script calls", async () => {
  const compressed = gzipSync(pdf), calls = [];
  const serve = handler({ fetchImpl: async url => {
    calls.push(url); assert.match(url, /^https:\/\/www\.thsconline\.net\/api\/v1\//);
    return url.includes("getmetadata") ? Response.json({ fragmentCount: 1 }) : new Response(compressed);
  } });
  const bridge = "https://hscpapers.com/proxy?url=" + encodeURIComponent(netRoute) + "&dl=1";
  const direct = await serve({ request: new Request(bridge) });
  assert.equal(direct.status, 200); assert.deepEqual(new Uint8Array(await direct.arrayBuffer()), pdf);
  const nested = await serve(request(bridge));
  assert.equal(nested.status, 200); assert.deepEqual(new Uint8Array(await nested.arrayBuffer()), pdf);
  assert.equal(calls.length, 2);
  assert.equal((await serve(request("https://hscpapers.com/proxy?url=" + encodeURIComponent("https://unapproved.example/paper.pdf")))).status, 403);
});
test("migrated transport joins out-of-order gzip fragments and shares validated PDF cache", async () => {
  const compressed = gzipSync(pdf), pieces = [compressed.subarray(0, 13), compressed.subarray(13)];
  const calls = [];
  const serve = handler({ fetchImpl: async url => {
    calls.push(url); assert.match(url, /^https:\/\/www\.thsconline\.net\/api\/v1\//);
    if (url.includes("getmetadata")) return Response.json({ fragmentCount: 2, originalFileName: "paper.pdf" });
    const i = Number(url.split("/").pop()); if (i === 0) await new Promise(r => setTimeout(r, 15));
    return new Response(pieces[i]);
  } });
  const [a, b] = await Promise.all([serve(request(netRoute)), serve(request(netRoute))]);
  assert.equal(a.status, 200); assert.deepEqual(new Uint8Array(await a.arrayBuffer()), pdf);
  assert.deepEqual(new Uint8Array(await b.arrayBuffer()), pdf);
  assert.equal(calls.length, 3);
  const head = await serve(request(netRoute, { method: "HEAD" })); assert.equal(head.headers.get("content-length"), String(pdf.length));
  assert.equal(calls.length, 3);
});
test("unmigrated metadata returns an explicit miss without an Apps Script or viewer fallback", async () => {
  let calls = 0;
  const serve = handler({ fetchImpl: async url => { calls++; assert.match(url, /\/api\/v1\/getmetadata\//); return Response.json({ fragmentCount: 0, originalFileName: "404_html.pdf" }); } });
  const response = await serve(request(netRoute)); assert.equal(response.status, 404); assert.equal(calls, 1);
  assert.match(await response.text(), /migrated transport/);
});
test("broken gzip and missing fragments fail honestly without entering the legacy transport", async () => {
  for (const fail of ["gzip", "http"]) {
    const serve = handler({ fetchImpl: async url => {
      assert.match(url, /thsconline\.net\/api/);
      if (url.includes("metadata")) return Response.json({ fragmentCount: 1 });
      return fail === "gzip" ? new Response("not gzip") : new Response(null, { status: 404 });
    } });
    assert.equal((await serve(request(netRoute))).status, 502);
  }
});
test("sanitization is a transport lookup only and malformed descriptors fail closed", () => {
  assert.equal(sanitizeThscTitle(" A & O'Brien (Adv.) "), "A  OBrien (Adv.)");
  assert.equal(fragmentDescriptor(netRoute).rawTitle, "Abbotsleigh 2022");
  for (const url of ["https://www.thsconline.net/s/v/no/title", netRoute + "?field=x", "https://www.thsconline.net/s/v/5338/%ZZ"])
    assert.throws(() => fragmentDescriptor(url));
});
