/* Playwright config — the nuclear suite's web tier.
   Boots serve.js itself (repo root), sequential workers, one retry.
   PDF bytes in reader tests come from our own R2 bucket only (politeness). */
module.exports = {
  testDir: "./specs",
  timeout: 45000,
  retries: 1,
  workers: 1,
  outputDir: "./artifacts",
  use: {
    headless: true, // pinned explicitly — no visible browser windows, ever
    baseURL: "http://localhost:8000",
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    viewport: { width: 1280, height: 900 },
  },
  webServer: {
    command: "node serve.js",
    url: "http://localhost:8000/",
    cwd: "../../..",
    reuseExistingServer: true,
    timeout: 30_000,
    stdout: "ignore", // the spawned server never paints the console
    stderr: "pipe",
  },
  reporter: [["list"], ["json", { outputFile: "./artifacts/report.json" }]],
};
