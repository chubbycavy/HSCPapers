# READER-TECHNIQUES.md — building a fast, memory-safe pdf.js web reader

*Techniques from HSCPapers' embedded reader, written generically for any
pdf.js-based web viewer. The working reference implementation lives at
`demo-scroll.html` (MIT — free to reuse and adapt); the same engine runs
 in production on hscpapers.com. No HSCPapers-specific code is
required to use any of this.*

---

## The problems this solves

1. **Rate-limited file pipelines** (Google Drive / Apps Script / throttled
   mirrors): every page view re-hits the pipeline; traffic spikes make
   files fail to load at all
2. **Render races**: one shared canvas + overlapping render calls = blank
   pages with stale counters
3. **Memory blowouts**: rendering every page of a 60-page scanned paper
   at readable scale can consume hundreds of MB
4. **Clunky reading flow**: one-page-at-a-time viewers force constant
   clicking instead of natural scrolling

## 1 — Continuous scroll with lazy per-page rendering (the core)

The viewer shows ONE scroll container holding one placeholder element per
page. Nothing renders until a page approaches the viewport.

**Stable placeholders.** Get page 1's viewport at scale 1 and give every
placeholder `aspect-ratio: width / height` (exam papers are uniform; a
deviant page simply renders at its own size in place). Scroll height is
correct before a single page renders — no layout jumping.

**IntersectionObserver, not scroll math.** Root = the scroll container,
`rootMargin` ~900px both directions. When a placeholder enters the margin,
enqueue its page. This is cheaper and simpler than computing visibility on
every scroll event.

**Bounded render queue.** Cap concurrent renders (3 worked well for us)
and sort the queue by distance to the current page — nearest renders
first. Each page renders into **its own canvas**; pages never contend for
a shared canvas, which structurally eliminates the race that produces
blank pages ("Cannot use the same canvas during multiple render()
operations").

**Distance-based unload.** On scroll (rAF-throttled), sweep the pages:
any rendered page whose centre is farther than ~2.5 viewport-heights away
gets its canvas zeroed (`canvas.width = canvas.height = 0`) and its
pdf.js page object destroyed (`pageProxy.destroy()`). Memory stays
bounded regardless of document length. Skip in-flight renders when
sweeping. Rendering a swept page again is cheap — pdf.js caches parsed
pages internally.

**Scale.** 1.6 rendered-scale with CSS `width: 100%` on the canvas gives
sharp-enough text at reasonable memory (~2 MB/page for A4). If you need
crisper, render at `devicePixelRatio`-aware scales — but bound the total.

## 2 — Fetch discipline for rate-limited pipelines

This is the part that matters most when the file host itself is the
bottleneck (Google Drive/Apps Script, throttled mirrors):

**Fetch the whole file once, cache it client-side.** Cache API + an LRU
cap (60 entries worked for us). A student re-opening yesterday's paper
serves entirely from cache — zero pipeline hits.

**Never cache ranged (206) responses.** pdf.js fetches with HTTP Range
requests by default. If a partial body gets cached and replayed later for
a different range, the file is truncated downstream — it parses as a
tiny document that renders blank with a stuck "1 / 1" counter (we shipped
this bug; it reached users). Rules:

- requests carrying a `Range` header → always network, never the cache
- cache only `status === 200` complete responses
- serve cached copies only to rangeless requests

**One pipeline note for Google Apps Script / base64 flows:** if the file
is delivered base64-encoded through a script endpoint, decode once and
hand pdf.js the resulting `ArrayBuffer` (or `Uint8Array`) directly —
`getDocument({ data })` — and cache *that* by document id. The viewer
layer techniques below are independent of how bytes arrive.

## 3 — Split-view paper + solutions with page-follow sync

Two pdf.js documents load side by side (paper left, solutions right).
Each pane owns its state: `{ doc, page, numPages, queue, observer }`.
Page-follow sync: when one pane's current page changes, scroll the other
to `min(n, itsNumPages)` — with a short-lived lock flag so the
programmatic scroll doesn't re-trigger the sync (feedback loops otherwise
jitter both panes). Mobile: stack the panes vertically, each keeps its
own navigation.

## 4 — Controlled print

Render pages sequentially into an **offscreen scratch canvas** (never the
live view), `toDataURL` each into a popup document, cap at ~60 pages with
a visible note, show progress on the page counter, then trigger
`window.print()`. If some documents must not print, keep a per-file flag
and hide the print affordance for those — don't remove printing globally.

## 5 — Pitfalls we hit for real (so you don't have to)

- **CSS `display` rules beat the `hidden` attribute.** An author rule
  like `.pane { display: flex }` overrides the UA's `[hidden] →
  display: none`, leaving "hidden" panes permanently visible. Fix once,
  globally: `[hidden] { display: none !important; }`
- **Service-worker PDF caching + Range requests**: see §2 — cache 206
  partials and every downstream pdf.js parse breaks. Also: app code
  served by a worker must be network-first on frequently-deployed sites,
  and a worker takeover should auto-reload the page once, or stale
  sessions run old code against new HTML.
- **Wire UI elements null-tolerantly** (`el?.addEventListener`). Old
  cached JS against new HTML otherwise crashes the whole app before
  first render — an entire catalogue "disappearing" because one removed
  button was still being wired.
- **opacity: 0 is "visible"** to automated checks and to users who find
  it. Toggle visibility via classes that set display/visibility, not
  opacity.

## 6 — Reference implementation

- Live demo: `demo-scroll.html` on the same site that hosts this
  document's repo (single file, MIT — load any CORS-enabled PDF URL and
  scroll)
- The production engine: `desktop/ui/js/app.js` (reader section) — same
  algorithms with multi-document split-view, selection, and downloads
- Tested by an automated browser suite: lazy render on deep scroll,
  unload bounds, page detection from scroll position, queue priority,
  sync clamping

Questions or corrections welcome — the point of writing this down is
that nobody else has to rediscover these the slow way.
