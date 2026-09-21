# HSCPapers — desktop app (Tauri 2)

Windows desktop library for Trial + HSC papers. Same UI and features as the
website (`index.html`/`css`/`js` are shared from `desktop/ui/`), but downloads
run through a Rust backend: direct-to-folder, queued, throttled, resumable —
no browser CORS or ZIP-size limits.

## Layout

```
desktop/
  sources.json        frozen source config (THSC repos, endpoints, polite-fetch policy)
  ui/                 frontend (copy of website UI; data/papers.json is GENERATED — do not hand-edit)
  tools/build-index.cjs catalogue builder: THSC listings + NESA JSON -> ui/data/papers.json
  tools/.cache/       builder HTTP cache (git-ignored)
  src-tauri/          Tauri app (HSCPapers): Rust backend + installer config
```

## Catalogue

Regenerate any time (polite: cached, ~150ms between fetches, ~2 min full run):

```powershell
node tools/build-index.cjs            # full rebuild (uses cache when fresh)
node tools/build-index.cjs --no-cache # refetch everything
node tools/build-index.cjs --limit=6  # quick parser test
```

Current catalogue: **7,015 papers / 8,892 files (6,079 fast)** — sources
`thsc-listing` + `nesa` + mirrors (HSC Portal, PapersDB, Board of Studies).
Papers belong to their schools/authors and NESA; the app is a study-use index
— see `sources.json` attribution.

## Develop (needs Rust once: https://rustup.rs — install, reboot, then:)

```powershell
cd desktop
npm.cmd install
npm.cmd run tauri dev
```

Release installer:

```powershell
npm.cmd run tauri build   # -> src-tauri/target/release/bundle/nsis/
```

## Status (v0.8.1)

- [x] Phases 1-2: sources, builder, Tauri shell, backend, installer
- [x] Mass downloads: pacing, backoff, queue, resume, save-all, overnight
- [x] Mirror layer (portal/papersdb/BOS direct URLs + fallbacks + worker pool)
- [x] **v0.6.0:** path-normalizer fix (Library/Open/Verify), NESA re-routed to
      BOS + router fallbacks, per-lane speed display, 🔍 Verify, Import polish,
      embedded PDF reader
- [x] **v0.7.0:** builder reorder + mirror transfers, BOS letter-page fix,
      honest route counts, host-based lane assignment, 6 CDN lanes, UI desync
      fixes, in-page reader overlay, PapersDB Mathematics Standard
- [x] **v0.8.0:**
      - **File-count consistency:** all save confirmations/progress now count
        FILES (papers + solutions) — the old UI mixed papers (6,948) and files
        (8,816) counts between the button and the confirm screen
      - **Level filter fixed:** the "HSC" pill was literally filtering Year 9
        papers (fallthrough bug); renamed to **Yr 12** with per-level counts
      - **Portal solutions harvest:** the portal's "w. sol" files are now
        matched against the catalogue — 89 attached to parent papers, 80 new
        standalone solution entries (4,656 were already catalogued via THSC's
        own listings)
      - **UI decluttered:** "Save all filtered" removed (select-all + Save does
        the same), 🌙 Overnight scheduler removed (fast lane no longer needs
        it), the four library buttons merged into one **Library ▾** menu
      - **Custom study timer:** presets + Custom… (any minutes, 1-600) +
        count-up, Enter to start
      - Catalogue: **7,015 papers / 8,892 files — 6,079 files fast,
        5,624 fast papers · 417 script · 974 dead-wcm (fail fast)**
- [x] **v0.8.1:**
      - **Mid-batch stutter/chokepoints fixed:**
        - Mirror-fallback resolver calls are now single-attempt (one
          throttle-gated try, then defer) — a stale mirror URL no longer
          parks a CDN slot (and a script-gate permit) through the 15s/60s
          ladder or the 10-min auto-pause, and can no longer freeze the
          script lane on a single 404.
        - O(1) progress accounting: per-file deltas instead of a full
          recompute over the whole batch on every progress event (the
          actual source of the UI stutter on large batches).
        - Board-of-Studies files get their own sub-lane (3) so a slow
          school-server file can never occupy a Cloudflare CDN slot; CDN 5 +
          BOS 3 + script 2 (Rust workers 10).
      - **Confirm breakdown:** the save confirm now reconciles the numbers —
        `N files = M papers + K solutions · X to fetch (≈ Y)`; the bulk bar
        shows both (`N papers selected · F files`).
      - **Level pills:** labels come from a map — fixes the v0.8.0 bug where
        the count-stripping regex ate "Yr 12"'s digits ("Yr 6454").
      - Catalogue unchanged: 7,015 papers / 8,892 files (6,079 fast — of
        which ~1,027 are direct-but-slower Board-of-Studies URLs, so the
        true Cloudflare-CDN fast count is ≈5,100-5,500).
- [x] **v0.8.2:**
      - **Count line fixed:** explicit `kind` on every save file — the
        confirm now shows the true split (`8,892 files = 7,015 papers +
        1,877 solutions`); the old id-suffix heuristic misclassified 3,448
        paper files whose THSC link text ends in "w. sol" as solutions.
      - **Size estimator hardened:** ranged-GET sampling (Content-Range)
        when HEAD omits Content-Length (Cloudflare Pages does), HTML
        responses ignored, and a zero-average / <3-samples floor falls back
        to the flat per-paper estimate — a run of Content-Length: 0
        responses can no longer display 0.0 MB.
      - **Real progress totals:** `bytesTotal` wired from the estimate —
        progress now shows `X/Y MB` with a byte-based ETA.
      - **Slow-route exclusion (default OFF):** new sidebar toggle
        "Include slow-route papers 🐢". Off = saves skip the ~640
        THSC-resolver files entirely (confirm reports what was skipped);
        on = everything as before. 🐢 tags mark affected cards; resumed
        queues are filtered too.
      - **Fewer IPC events:** per-chunk emit threshold 128 KB/300 ms →
        512 KB/500 ms (4× fewer progress events at speed).
      - Note: "8,892 to fetch" with 5,009 files on disk means the configured
        library folder doesn't hold them — check Library ▾.
- [x] **v0.8.3:**
      - **Toggle drives every count:** new `effectivePapers()` is the single
        source of truth — with "Include slow-route papers" OFF, the hero
        stats, level pills, subject strip, sidebar lists, results count and
        select-all all reflect the effective catalogue (~5,622 papers);
        results count shows `· 1,393 slow-route hidden (toggle to show)`.
      - **Slow-route papers hidden from the grid** while the toggle is OFF
        (hidden papers are pruned from the selection; flipping the toggle
        back shows them again, unselected).
      - **One counter everywhere:** the bulk bar and confirm show a single
        number — files that will actually download (`6079 files to save`,
        `Confirm save 6079 files (≈ 1.5 GB)?`) — the papers+solutions
        equation is gone.
      - **Toggle OFF = zero resolver traffic:** `fallback: null` on every
        download call, so a mirror-missing file fails immediately instead
        of quietly using THSC's rate-limited resolver.
      - **Sidebar scrolls independently:** `max-height: calc(100vh - 88px)`
        + `overscroll-behavior: contain` — the tall panel stack is always
        reachable without scrolling the main page.
      - Library ▾ Verify deliberately still scans the FULL catalogue
        (library truth, not the view) — now noted in its tooltip.
- [x] **v0.8.4:**
      - **Both numbers, explicitly, on every surface:** results count shows
        `5622 papers · 6079 files` (+ hidden note), bulk bar shows
        `5622 papers · 6079 files to save`, and the confirm headline matches
        the bulk bar (`Confirm save 6079 files (≈ 1.5 GB)?`) with the status
        explaining the delta (`5843 will download — 236 already on disk`).
        The view's file total comes from the same generator as the save, so
        view ↔ selection always agree.
      - **Sidebar owns the left column:** `min-height: calc(100vh - 88px)`
        makes the sidebar span the whole visible left side, so the wheel
        anywhere over it scrolls the sidebar — never the main grid.
- [x] **v0.8.5:**
      - **Windowed speed + ETA:** rates are computed over the last ~12s of
        real byte movement (ring buffer) instead of bytes ÷ total elapsed —
        time spent on skips/failures/pauses no longer collapses the speed
        display and explodes the ETA. Speed shows per lane:
        `CDN x MB/s · BOS y MB/s` (script only when the toggle is on).
      - **Per-component 🐢 tags:** `🐢 paper` / `🐢 sol` / `🐢 paper + sol`
        with tooltips — a fast paper with slow solutions no longer looks
        mislabeled (502 cards have fast papers whose solutions are slow).
      - **Estimate transparency:** the confirm shows the sample count behind
        the size (`≈ 1.5 GB (from 11 samples)`), and pending-queue merges
        extend the byte estimate so progress can't exceed 100%.
      - Verified: THSC's index-CDN fast path (`/s/index/<viewno>.json`)
        returns 404 — script-route files genuinely depend on the throttled
        resolver; no hidden fast lane to exploit.
- [x] **v0.8.6:**
      - **Sidebar scroll fixes:** the inner `.check-list` scrollers (a 122-row
        subject list trapped in a 236px box) no longer swallow the wheel —
        the sidebar is the single scroller, so it scrolls smoothly from top
        to bottom. A JS wheel-router drives the sidebar for ANY cursor
        position over the left column (page margins and empty column space
        used to fall through to the main grid); the reader overlay is left
        alone and the subject strip still scrolls the page.
- [ ] Phase 3: About screen polish
- [ ] Phase 4: GitHub Releases auto-updater
- [ ] v0.9 (planned): full-featured public website — Cloudflare Pages + Worker
      backend (resolver proxy, ZIP streaming, reader CORS proxy). Defaults to
      CDN-route files; no local-library layer (browser sandbox).

## Library usage (v0.5.0)

- Library defaults to `C:\Users\<you>\HSCPapers` (never OneDrive-synced);
  change via ⚙ Library… (persisted in app config).
- **⇪ Import**: point it at a folder of PDFs you already have (e.g. an old
  library) — matched files are copied into the canonical layout and
  skip-if-exists takes over; unmatched files are reported.
- Save-all confirm shows exact already-saved files + a per-source sampled
  size estimate.

## Sources & attribution

- **THSCOnline** (thsconline.github.io / thsconline.pages.dev) — catalogue,
  resolver endpoints (16-way worker pool mirrored from their v2 site code).
- **HSC Portal** (hscportal.app / hscportal.pages.dev) — community mirror,
  6,449 self-hosted papers, all subjects, 1978-2025.
- **PapersDB** (papersdb.org / cdn.papersdb.org) — community fast mirror
  (Maths incl. Standard & Science), 2001-2026.
- **NESA** (educationstandards.nsw.edu.au / boardofstudies.nsw.edu.au) —
  official HSC exam papers + marking materials (direct links).
All papers remain the property of their schools/authors and NESA.

## Download behaviour (verified against THSC's live site)

Trial bytes come from THSC's own resolver as base64 (their `/s/d/` links are
router URLs, not files). Google throttles that endpoint in a sliding window:
bursts return HTTP 404 and recover after ~10 min. The backend treats 404 as
"slow down" (retry with 15s/1m/4m/10m backoff, auto-pause 10 min after 3
consecutive 404s, then resume). Direct Google Drive download is not possible
anonymously (files require sign-in), so the resolver path is the only route.
