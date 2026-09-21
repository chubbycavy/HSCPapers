# HSC Papers Mirror — THSCOnline-style index

Static front-end for Trial + HSC papers. **PDFs live on a separate file host** — this site only stores an index (`data/papers.json`) and builds download links from one base URL.

## Run locally

**Easiest (Windows): double-click `start-site.bat`.** It starts a local server (via `serve.js`, Node.js only — nothing to install) and opens the site in your browser. Keep the black window open while testing; close it to stop the site.

Manual alternative (any static server works — required, since `fetch()` for `papers.json` is blocked on `file://`):

```powershell
npx serve .
# or
python -m http.server 8000
```

Then open http://localhost:8000 (or the port shown).

## Point it at your file host

1. Upload PDFs to your host (Cloudflare R2, AWS S3, VPS/Nginx, GitHub Pages…) keeping folder structure, e.g. `trial/physics/2024-knox-physics-paper.pdf`.
2. Edit `js/config.js`:
   ```js
   FILE_HOST_BASE_URL: "https://papers.yourdomain.com"
   ```
3. Single-file downloads work immediately (plain `<a href>` links — no CORS needed).
4. For **Download ZIP** to work, the host must send `Access-Control-Allow-Origin: *` (ZIP fetches files with JS). Without it the button shows a message and users fall back to “Download individually”.

## Add papers (mirror workflow)

Append entries to `data/papers.json`:

```json
{
  "id": "trial-2024-physics-knox",
  "subject": "Physics",
  "year": 2024,
  "school": "Knox Grammar",
  "type": "trial",
  "title": "2024 Knox Grammar Physics Trial",
  "path": "trial/physics/2024-knox-physics-paper.pdf",
  "solutionPath": "trial/physics/2024-knox-physics-solutions.pdf",
  "size": "3.1 MB",
  "hasSolutions": true
}
```

- Organisation mirrors THSCOnline: `subject → year → school`, split `hsc` (school: `"NESA"`) vs `trial`.
- `path` is relative to `FILE_HOST_BASE_URL`, or a full `https://…` URL to override per-file.
- Paths starting with `Maths Advanced/`, `Physics/`, `data/`, `./`, `../` or `/` are treated as **site-local** and served from this site (used by the local test folders below).
- Search, filters, counts, subject strip, selection + ZIP pick up new entries automatically.

## Local test files

`Maths Advanced/` (30 trial PDFs) and `Physics/` (30 trial PDFs) are indexed in `data/papers.json` and resolve locally, so search / filters / multi-select / ZIP can be tested end-to-end with `npx serve .` — no remote host needed. Combined "Trials & Solutions" PDFs carry `hasSolutions: true` with no separate `solutionPath`.

## Features

- Live search across subject / school / year / title (`?q=ruse` deep-links)
- Filters: subject, year, school, HSC vs Trial, solutions-only + sorting
- Multi-select (click card or checkbox) → **Download ZIP** (JSZip), **Download individually**, **Copy links**
- Dark mode, responsive, grid/list view, shareable filter URLs

## Files

```
index.html          main page
css/styles.css      theme + layout
js/config.js        ★ file-host base URL (change this to go live)
js/app.js           search / filter / select / bulk download
data/papers.json    catalogue (95 entries: 35 remote samples + 60 local test PDFs)
template 1.html     original baseline template (kept for reference)
```
