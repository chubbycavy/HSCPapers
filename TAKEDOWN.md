# Content removal (takedown) policy

HSCPapers is a free, non-commercial index of NSW HSC study material.
It hosts no PDF files beyond a small self-hosted set from our own study
library: every other download resolves to a public source — official
NESA / Board of Studies releases, or the community mirror (HSC Portal)
that THSCOnline itself lists. All papers remain the property of their
schools/authors and NESA.

## How to request removal

Open an issue using the **Content removal request** template:
<https://github.com/chubbycavy/HSCPapers/issues/new?template=removal-request.yml>

Include:

1. The page URL or paper title,
2. The material you own or represent,
3. Your name and contact details.

## What happens next

- The catalogue entry is removed from the website and the desktop
  catalogue within **24 hours** of a valid request.
- Removals are **permanent**: the catalogue builder keeps a removals
  registry (`removals.json` in this repository) and excludes removed
  papers from every nightly rebuild — removed papers never reappear
  automatically.
- Proxy access to that file is disabled where applicable.
- We confirm the removal in the issue.

## Scope notes

- We do not host copies of papers **except a small self-hosted subset**
  (76 papers from our own study library — see
  `desktop/tools/selfhost.json`). Removal requests cover those identically:
  the catalogue entry is removed and the file is deleted from the bucket
  within 24 hours.
- Files on third-party mirrors (HSC Portal, Board of Studies, NESA) can
  only be *delinked* by us — the underlying hosts may need to be contacted
  directly, and we will tell you which.
- Valid requests only: where a claim is unclear (for example, material
  publicly released by NESA or in the Board of Studies archive), we may
  ask for clarification first.

## Our position

- Non-commercial: no ads, no paid tiers, nothing sold.
- Study-use index; not affiliated with NESA.
- Catalogue and file hosting are decoupled by design — removals never
  break the site.

## Removal log

Removals are tracked in [`desktop/tools/removals.json`](desktop/tools/removals.json)
in this repository (per-entry date + reason summary) — a transparent,
append-only record that also guarantees permanence across rebuilds.
