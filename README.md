# HSCPapers

Fast, searchable index of NSW HSC **trial papers, past HSC papers and school
assessment tasks** — organised `Subject → Year → School`, split HSC (NESA past
papers) vs Trial (school-written). This repo ships two products from one codebase:

1. **Website** — `desktop/ui/` (deployed via Cloudflare Pages). Pure static:
   search, faceted filters, embedded PDF reader + study timer, bulk download
   (structured ZIP, copy links). Mostly an index — downloads resolve to
   their source: the HSC Portal mirror, the Board of Studies archive, or
   official NESA links — plus a small **self-hosted set** (76 papers served
   from our own Cloudflare R2 bucket, see `desktop/tools/selfhost.json`).
2. **Desktop app** (Tauri 2) — same UI, plus a Rust download backend:
   direct-to-folder library, queued/resumable batches, adaptive pacing, CDN
   mirror lanes + THSC-resolver fallback, embedded reader over saved files.
   See [`desktop/README.md`](desktop/README.md).

## Layout

```
desktop/
  sources.json          frozen source config (THSC, mirrors, polite-fetch policy)
  ui/                   ★ CANONICAL WEB UI — index.html, css/, js/, data/, pdfjs/
    data/papers.json    GENERATED catalogue (7,015 papers / 8,892 files) — do not hand-edit
  tools/build-index.cjs catalogue builder (THSC listings + NESA + mirrors)
  tools/.cache/         builder HTTP cache (git-ignored)
  src-tauri/            Tauri app (Rust backend + NSIS installer config)
serve.js                zero-dependency local preview server (serves desktop/ui)
start-site.bat          Windows: double-click to preview locally
.github/workflows/      nightly catalogue rebuild (commit + auto-deploy)
```

The old root-level website copy (95-entry demo) was retired — `desktop/ui` is
the single source of truth for web and desktop.

## Run locally

**Windows: double-click `start-site.bat`** (Node.js only — nothing to
install). Any static server works too:

```powershell
npx serve .
# or
python -m http.server 8000
```

Then open the port shown. `fetch()` needs a server — it's blocked on `file://`.

## Deploy (Cloudflare Pages — free)

1. Push this repo to GitHub (done — `chubbycavy/HSCPapers`).
2. Cloudflare Dashboard → Workers & Pages → Create → Pages → **Connect to Git**
   → pick `HSCPapers`.
3. Build settings:
   - **Root directory**: `desktop/ui`
   - **Build command**: *(none)* — the UI is fully static
   - **Output directory**: `/`
4. Deploy. The `*.pages.dev` URL is live; every push to `main` redeploys.

The nightly GitHub Action (`catalogue.yml`) regenerates
`desktop/ui/data/papers.json` and commits it — the push triggers a site
redeploy automatically.

## Legal & removal

- **Code**: © chubbycavy, all rights reserved (no license granted).
- **Papers**: remain the property of their schools/authors and NESA. This is
  a non-commercial, study-use **index** and hosts no PDFs.
- **Removal requests**: see [TAKEDOWN.md](TAKEDOWN.md) — honored within 24
  hours and permanent (the nightly builder excludes removed papers via
  `desktop/tools/removals.json`; the removal form is a GitHub issue template).
- **Deliberately parked** (documented decision — revisit consciously):
  **full** library self-hosting and unlimited streaming ZIP. Proxy rate
  limiting is likewise deferred (needs an owned zone).
- **Phase-2-lite: ACTIVATED 2026-09-25** — 76 papers (421 MB) self-hosted on
  Cloudflare R2 (free tier, $0/mo) after a third-party mirror applied
  referer protection against this project. Registered in
  `desktop/tools/selfhost.json`; the builder rewrites those URLs at every
  rebuild, so the site and desktop app are fully independent of any mirror.
  The **"Submit a paper" issue template** is the continuous-update path for
  the newest trials: submitted papers land in the library + registry and go
  live self-hosted, same day.

## Numbers contract (keep marketing honest)

Every number shown on the site/app traces to a source — update them together:

- **Live counts** (papers / subjects / schools / solutions in the hero) are
  derived from `desktop/ui/data/papers.json` — always correct by construction.
- **Static claims** live in `desktop/ui/js/config.js`:
  `MAX_ZIP_FILES` (200) + `MAX_ZIP_BUDGET_MB` (500). When these change, update
  in the same commit: hero sub ("up to 200 papers…"), the meta description,
  feature card 4, the features stats band, and the desktop ZIP notes.
- Catalogue-scale claims ("7,000+ papers", "12,000+ files", "5,600+
  one-click", "1967–2026") are durable round numbers — re-derive from the
  current catalogue when they drift by more than ~5%.
- Download/traffic counters: intentionally absent until real analytics exist
  (Cloudflare Web Analytics toggle in the dashboard).

## Catalogue

Regenerate locally any time (polite: cached, ~150ms between fetches):

```powershell
node desktop/tools/build-index.cjs            # full rebuild (cache when fresh)
node desktop/tools/build-index.cjs --no-cache # refetch everything
node desktop/tools/build-index.cjs --limit=6  # quick parser test (partial output)
```

Current catalogue: **7,015 papers / 8,892 files (6,079 fast)** — sources
`thsc-listing` + `nesa` + mirrors (HSC Portal, Board of Studies).
Slow-route files (~640, THSC rate-limited resolver) are hidden by default
(sidebar toggle 🐢). Papers belong to their schools/authors and NESA — see
`desktop/sources.json` attribution.

## Web vs desktop capabilities

| | Website | Desktop app |
|---|---|---|
| Search, filters, level pills, deep links | ✅ | ✅ |
| Embedded reader + study timer | ✅ (CORS-permitting sources) | ✅ (local files) |
| Single downloads | ✅ | ✅ |
| Bulk downloads | Browser ZIP, ≤30 files (RAM-bound) | Unlimited, queued, resumable, direct-to-folder |
| Library tools (Verify / Import) | — | ✅ |
| Slow-route (THSC resolver) files | Fallback links only | ✅ (background, polite pacing) |

## Sources & attribution

- **THSCOnline** (thsconline.github.io) — catalogue metadata + resolver
- **HSC Portal** (hscportal.app) — community mirror (fast files)
- **Board of Studies / NESA** — official past papers + marking materials
- A small set of papers is **self-hosted** from our own study library
  (`desktop/tools/selfhost.json`); removal requests cover them identically

All papers remain the property of their schools/authors and NESA. This is a
study-use index; not affiliated with NESA.
