// Local preview server for HSCPapers — zero dependencies.
// Serves the canonical UI and the production proxy handler.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");
const { Readable } = require("stream");
const { exec } = require("child_process");

const ROOT = path.join(__dirname, "desktop", "ui");
const START_PORT = 8000;
const MAX_TRIES = 11;
const NO_OPEN = process.argv.includes("--no-open");
const proxyModule = import(pathToFileURL(path.join(ROOT, "_lib", "pdf-proxy.mjs")).href);
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".pdf": "application/pdf",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const NO_STORE = new Set([".html", ".css", ".js", ".mjs", ".json"]);
async function proxyHandle(req, res) {
  const { onRequest } = await proxyModule;
  const response = await onRequest({ request: new Request(new URL(req.url, "http://localhost"), { method: req.method, headers: req.headers }) });
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body || req.method === "HEAD") return res.end();
  Readable.fromWeb(response.body).on("error", error => res.destroy(error)).pipe(res);
}
const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/proxy") {
      proxyHandle(req, res).catch(error => {
        if (res.headersSent) res.destroy(error);
        else { res.writeHead(502, { "Content-Type": "text/plain" }); res.end("Proxy failed: " + error.message); }
      });
      return;
    }
    if (urlPath === "/") urlPath = "/index.html";
    const file = path.join(ROOT, path.normalize(urlPath.replace(/^\/+/, "")));
    if (!file.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end("Forbidden"); return; }
    fs.stat(file, (error, stat) => {
      if (error || !stat.isFile()) { res.writeHead(404); res.end("Not found: " + urlPath); return; }
      const ext = path.extname(file).toLowerCase();
      const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
      if (NO_STORE.has(ext)) headers["Cache-Control"] = "no-store";
      res.writeHead(200, headers);
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(file).pipe(res);
    });
  } catch { res.writeHead(500, { "Content-Type": "text/plain" }); res.end("Server error"); }
});
function listen(port, triesLeft) {
  server.once("error", error => {
    if (error.code === "EADDRINUSE" && triesLeft > 1) listen(port + 1, triesLeft - 1);
    else { console.error("Could not start server:", error.message); process.exitCode = 1; }
  });
  server.listen(port, () => {
    const url = "http://localhost:" + port;
    console.log("HSC Papers Mirror running at " + url);
    if (!NO_OPEN) exec('start "" "' + url + '"');
  });
}
listen(START_PORT, MAX_TRIES);
