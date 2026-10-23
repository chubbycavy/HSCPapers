// Upload a reviewed growth manifest to the existing R2 bucket and verify the
// public object bytes. Credentials are read only from the environment.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const arg = (name, fallback = "") => {
  const p = "--" + name + "=";
  const hit = process.argv.find((a) => a.startsWith(p));
  return hit ? hit.slice(p.length) : fallback;
};
const manifestPath = path.resolve(arg("manifest", path.join(__dirname, ".cache", "growth", "thsc-r2-manifest.json")));
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const bucket = process.env.R2_BUCKET || manifest.bucket || "hscpapers-files";
if (!account || !token) throw new Error("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required");
const api = `https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${bucket}/objects/`;
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function upload(entry) {
  const keyPath = entry.key.split("/").map(encodeURIComponent).join("/");
  const bytes = fs.readFileSync(entry.file);
  if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) throw new Error("Local proof changed: " + entry.id);
  const res = await fetch(api + keyPath, {
    method: "PUT",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/pdf",
    },
    body: bytes,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.success) throw new Error("R2 PUT failed: HTTP " + res.status + " " + JSON.stringify(json?.errors || json));
  let last;
  for (let i = 0; i < 4; i++) {
    const pub = await fetch(entry.url, { signal: AbortSignal.timeout(30000) });
    if (pub.ok) {
      const got = Buffer.from(await pub.arrayBuffer());
      if (got.length !== entry.bytes || sha(got) !== entry.sha256) throw new Error("Public R2 bytes differ: " + entry.id);
      return { status: pub.status, contentType: pub.headers.get("content-type"), bytes: got.length };
    }
    last = pub.status;
    await sleep(750 * (i + 1));
  }
  throw new Error("Public R2 check failed: HTTP " + last + " " + entry.url);
}

(async () => {
  const results = [];
  let ok = 0, failed = 0;
  for (const entry of manifest.entries || []) {
    try {
      const proof = await upload(entry);
      results.push({ id: entry.id, key: entry.key, url: entry.url, ok: true, proof });
      ok++;
      console.log(`uploaded ${ok}/${manifest.entries.length} ${entry.key}`);
    } catch (e) {
      results.push({ id: entry.id, key: entry.key, url: entry.url, ok: false, error: String(e.message || e) });
      failed++;
      console.error(`FAILED ${entry.id}: ${e.message || e}`);
    }
  }
  const out = { generated: new Date().toISOString(), bucket, total: manifest.entries.length, ok, failed, results };
  fs.writeFileSync(path.join(path.dirname(manifestPath), "r2-upload-results.json"), JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify({ bucket, total: out.total, ok, failed }, null, 2));
  if (failed) process.exitCode = 1;
})();
