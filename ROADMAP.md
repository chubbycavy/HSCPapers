# HSCPapers Roadmap

Last updated: October 2026.

## Mission

Fast, searchable, downloadable NSW HSC papers — every trial, past HSC and school assessment, organised and verified.

## Goals

- **Maximum speed** — fast direct delivery wherever possible; Slow route as a reliable fallback.
- **Maximum coverage** — continuous source discovery with evidence-gated admission.
- **Minimum duplicates/404s** — one canonical record per document; proven copies consolidated.
- **Preserve user data** — bookmarks, IDs, local filenames and downloaded files survive updates.

## Current status (v1.0.27)

| Metric | Count |
|---|---:|
| Available papers | 6,629 |
| File pointers (papers + solutions) | 7,328 |
| Recovery records (unavailable, preserved) | 894 |
| Subjects | 121 |
| Schools | 101 |

All counts derive from the live catalogue. Recovery records are excluded from available totals.

## Completed

### v1.0.27 — Migration, cleanup, compatibility (Oct 2026)
- Migrated THSC fragment API support alongside validated legacy delivery.
- Catalogue cleanup: duplicate consolidation, corrected mappings, preserved versions.
- Dual catalogue feeds: modern (new clients) and compatibility (v1.0.26 clients).
- Unified fallback policy with Slow route gating and PDF validation everywhere.
- Pre-migration state checkpoint protecting bookmarks, queues and download markers.
- Nightly sync preserving saved-file recognition across mirror URL changes.

### v1.0.26 — Canonical papers (Sep 2026)
- Reconciled mirror copies into canonical papers.
- Historical ID aliases and saved-file recognition.
- Shared English Paper 1 unified across course filters.

## Planned

### Script-lane replacement
Replace remaining legacy THSC script primaries with verified direct or migrated sources. Every record gets a fast replacement, medium replacement, or explicit recovery disposition before any cutoff.

### Medium-backed Slow route
Two-tier delivery: fast direct sources as default, verified medium-speed sources (fragments or measured delivery) behind the existing Slow route toggle.

### Coverage recovery
Resolve outstanding mapping-review groups and import candidates. Continue evidence-gated source discovery (mirrors, archives, Wayback).

### Performance optimization
Measure and tune startup, render and transfer performance. Appropriate caching and concurrency. Potential production file-host domain.

### Ongoing reliability
Nightly admission and continuity checks. Rotating health probes. Controlled incremental growth with availability monitoring.

## Delivery tiers

| Tier | User sees | Sources |
|---|---|---|
| Fast | Default browsing/downloads | Verified direct delivery |
| Medium | Slow route toggle | Verified fragments or measured medium sources |
| Unavailable | Recovery archive | Identity preserved; no online actions |

## Contributing

Papers remain the property of their schools, authors and NESA. This is a non-commercial study-use index. See [TAKEDOWN.md](TAKEDOWN.md) for removal requests.

Source submissions welcome via [GitHub issues](https://github.com/chubbycavy/HSCPapers/issues).

---

*Internal planning docs live in `docs/internal/` (gitignored). Do not commit them. This file is the public roadmap.*
