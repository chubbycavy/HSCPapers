# HSCPapers

Fast, searchable index of NSW HSC **trial papers, past HSC papers and school
assessment tasks** — organised `Subject → Year → School`, split HSC (NESA past
papers) vs Trial (school-written). This repo ships two products from one codebase:

1. **Website** — `desktop/ui/` (deployed via Cloudflare Pages). Pure static:
   search, faceted filters, embedded PDF reader + study timer, bulk download
   (individually / structured ZIP / copy links). Hosts **no PDFs itself** —
   every download resolves to its source: community mirrors (HSC Portal,
   PapersDB), the Board of Studies archive, or official NESA links.
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
`thsc-listing` + `nesa` + mirrors (HSC Portal, PapersDB, Board of Studies).
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
- **PapersDB** (papersdb.org) — community fast mirror (Maths + Science)
- **Board of Studies / NESA** — official past papers + marking materials

All papers remain the property of their schools/authors and NESA. This is a
study-use index; not affiliated with NESA.
