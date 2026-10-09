import test from "node:test";
import assert from "node:assert/strict";
import { createProxyHandler } from "../../ui/_lib/pdf-proxy.mjs";
import { onRequest as productionHandler } from "../../ui/functions/proxy.js";
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
  const serve = handler({ fetchImpl: async () => { calls++; return new Response(null, { status: 404 }); } });
  const first = await serve(request(route));
  const second = await serve(request(route.replace("2004", "2005")));
  assert.equal(first.status, 503);
  assert.equal(first.headers.get("retry-after"), "60");
  assert.equal(second.status, 503);
  assert.equal(calls, 1);
});
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
