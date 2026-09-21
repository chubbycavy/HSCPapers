// Local preview server for the HSC Papers Mirror — zero dependencies.
// Double-click start-site.bat (it runs this file, then opens your browser).
// Keep the console window open while testing; close it to stop the site.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const ROOT = __dirname;
const START_PORT = 8000;
const MAX_TRIES = 11; // try 8000..8010
const NO_OPEN = process.argv.includes("--no-open");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

// Don't cache the site's own files while testing, so edits show on refresh.
const NO_STORE = new Set([".html", ".css", ".js", ".json"]);

const server = http.createServer((req, res) => {
  try {
    let urlPath = decodeURIComponent(req.url.split("?")[0]);
    if (urlPath === "/") urlPath = "/index.html";
    const safe = path.normalize(urlPath.replace(/^\/+/, ""));
    const file = path.join(ROOT, safe);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found: " + urlPath);
        return;
      }
      const ext = path.extname(file).toLowerCase();
      const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
      if (NO_STORE.has(ext)) headers["Cache-Control"] = "no-store";
      res.writeHead(200, headers);
      fs.createReadStream(file).pipe(res);
    });
  } catch (e) {
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("Server error");
  }
});

function listen(port, triesLeft) {
  server.once("error", (e) => {
    if (e.code === "EADDRINUSE" && triesLeft > 1) {
      listen(port + 1, triesLeft - 1);
    } else {
      console.error("Could not start server:", e.message);
      process.exitCode = 1;
    }
  });
  server.listen(port, () => {
    const url = "http://localhost:" + port;
    console.log("\n  HSC Papers Mirror running at " + url);
    console.log("  Keep this window open while testing. Close it to stop the site.\n");
    if (!NO_OPEN) exec('start "" "' + url + '"');
  });
}

listen(START_PORT, MAX_TRIES);
