/* nuclear.cjs — the on-demand test arsenal runner (L1→L4), freeze-proof by
 * construction:
 *   L1 sweep-check        (local, static)
 *   L2 e2e                (Playwright, local serve)
 *   L3 live-check         (production — every fetch bounded at 20s)
 *   L4 builder canary     (--offline: cache-only, ZERO network; run twice +
 *                         normalized-hash compare = the determinism gate)
 * Stops on the first red step. Child output is STREAMED through as it
 * arrives (spawn + pipe + forward — never stdio:'inherit', which returns
 * status null under the nested console chain, and never a blocking call
 * with no output: that's the perceived-freeze class).
 * The canary's regenerated artifacts are restored afterwards (the nightly
 * bot owns catalogue commits).
 * Run: npm.cmd run test:nuclear   (~2 min, no silent window > ~45s) */
"use strict";
const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", ".."); // desktop/tools -> repo root
const DESKTOP = path.join(ROOT, "desktop");
const isWin = process.platform === "win32";
const npx = isWin ? "npx.cmd" : "npx";

const stamp = () => new Date().toISOString().slice(11, 19);
const step = (name) => console.log(`\n== [${stamp()}] ${name} ==`);

// the canary regenerates these paths — the pre-canary worktree state is
// SNAPSHOT byte-exact and restored after (git restore would wipe
// UNCOMMITTED work, e.g. hand-edits sitting in the worktree)
const CANARY_PATHS = ["ui/data/papers.json", "ui/sitemap.xml", "ui/coverage.html", "ui/index.html", "ui/subjects"];
const os = require("os");
const SNAPSHOT = fs.mkdtempSync(path.join(os.tmpdir(), "nuc-snap-"));
for (const p of CANARY_PATHS) {
  fs.mkdirSync(path.join(SNAPSHOT, path.dirname(p)), { recursive: true });
  fs.cpSync(path.join(DESKTOP, p), path.join(SNAPSHOT, p), { recursive: true });
}

function runStep(name, cmd, args) {
  return new Promise((resolve) => {
    step(name);
    const t0 = Date.now();
    const p = spawn(cmd, args, { cwd: DESKTOP, stdio: ["ignore", "pipe", "pipe"], shell: isWin });
    let tail = "";
    let lastOut = Date.now();
    // watchdog heartbeat: any child-silence longer than 10s prints a
    // timestamped still-running line — a quiet window can never look frozen
    const beat = setInterval(() => {
      if (Date.now() - lastOut > 10_000) {
        console.log(`  ⏳ still running (${Math.round((Date.now() - t0) / 1000)}s)…`);
      }
    }, 10_000);
    const fwd = (d) => {
      lastOut = Date.now();
      const s = d.toString();
      tail += s; if (tail.length > 6000) tail = tail.slice(-6000);
      process.stdout.write(s);
    };
    p.stdout.on("data", fwd);
    p.stderr.on("data", fwd);
    p.on("error", (e) => { clearInterval(beat); console.error(`  spawn error: ${e}`); resolve(false); });
    p.on("close", (code) => {
      clearInterval(beat);
      const dt = ((Date.now() - t0) / 1000).toFixed(1);
      if (code !== 0) {
        console.error(`  RED in ${dt}s (exit ${code}) — output tail:\n${tail.slice(-1500)}`);
        resolve(false);
      } else {
        console.log(`  GREEN in ${dt}s`);
        resolve(true);
      }
    });
  });
}

// normalised catalogue fingerprint: the "generated" stamp is stripped so two
// runs of the same builder over the same cache compare equal
function fingerprint() {
  const j = JSON.parse(fs.readFileSync(path.join(DESKTOP, "ui", "data", "papers.json"), "utf8"));
  delete j.generated;
  const sha = crypto.createHash("sha256").update(JSON.stringify(j)).digest("hex").slice(0, 16);
  const files = j.papers.reduce((n, p) => n + (p.url ? 1 : 0) + (p.solutionUrl ? 1 : 0), 0);
  return `${sha}|papers ${j.papers.length}|files ${files}`;
}

(async () => {
  if (!(await runStep("L1 sweep-check", "node", ["tools/sweep-check.cjs"]))) process.exit(1);
  if (!(await runStep("L2 e2e (21 journeys, local)", npx, ["playwright", "test", "--config", "tools/e2e/playwright.config.cjs"]))) process.exit(1);
  if (!(await runStep("L3 live-check (production, bounded fetches)", "node", ["tools/e2e/live-check.cjs"]))) process.exit(1);

  const canary = async (n) => {
    if (!(await runStep(`L4 builder canary (--offline, run ${n}/2)`, "node", ["tools/build-index.cjs", "--offline"]))) process.exit(1);
    const h = fingerprint();
    console.log(`  canary ${n}: ${h}`);
    return h;
  };
  const h1 = await canary(1);
  const h2 = await canary(2);
  step("Determinism gate");
  if (h1 !== h2) { console.error(`  RED: canary nondeterministic (${h1} != ${h2})`); process.exit(1); }
  console.log("  canary deterministic ✓");

  step("Restore canary artifacts from the pre-canary snapshot");
  for (const p of CANARY_PATHS) {
    fs.cpSync(path.join(SNAPSHOT, p), path.join(DESKTOP, p), { recursive: true });
  }
  console.log(`  restored ${CANARY_PATHS.length} paths (byte-exact, uncommitted work preserved)`);
  console.log("\n==== NUCLEAR SUMMARY ====");
  console.log("ALL GREEN — sweep + e2e + live + canary (deterministic)");
})().finally(() => { try { fs.rmSync(SNAPSHOT, { recursive: true, force: true }); } catch {} });
