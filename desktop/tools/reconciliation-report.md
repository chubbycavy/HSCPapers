# THSC migration and catalogue reconciliation

## Correction to earlier release claims

The 10,368 figure counted listings, including mirror copies. v1.0.25 made URLs distinct but left duplicate cards. Its census iterated a Map with Object.entries(), so no SHA-confirmation candidates were processed. Its claim of catalogue-wide uniqueness is withdrawn.

## Current accounting

- Active catalogue entries: **6936** (previously 10,368).
- Imported rows reconciled: 3496.
- Mirror/copy imports merged into existing entries: **3018**.
- Added after metadata and identity checks: **250**.
- Imports retained in the committed review registry, excluded from active totals: **228**.
- Existing-copy merges: 778.
- Historical aliases resolving to active/recovery records: 4859.
- Recovery records preserved without online download actions: 657.

- Direct-file pointers: 7409/7610; resolver primaries: 200.

| Source | Merged | Added | Review |
|---|---:|---:|---:|
| 4unitmaths | 0 | 4 | 190 |
| acehsc | 0 | 10 | 13 |
| crest | 0 | 0 | 1 |
| hscportal | 1 | 49 | 5 |
| thsc-au-growth | 3006 | 158 | 11 |
| thsc-feed | 11 | 29 | 8 |

## Evidence and preservation rules

Exact listing directory/name identifies a logical paper independent of its mirror URL. Matching full hashes plus semantic context also establish copies. School/year tuples alone are review hints, not proof. Paper numbers, document roles, provider, school level and exam blocks remain distinct.

Canonical entries retain the original ID and richer metadata. Mirror URLs and their cached byte proofs are alternative sources; historical metadata is preserved for desktop library path recognition. Alias IDs are not separate cards. No files already downloaded by users are deleted or renamed.

## Limits and remaining review

Shared-URL groups with differing document metadata recorded for mapping review: 17. These are not silently merged or disguised by URL demotion.
Rejected official replacements recorded: 83 (trial/assessment, provider or paper-part mismatches).
The census now distinguishes full-file hash evidence from incomplete HEAD coverage. This report does not claim every historical PDF is byte-unique or every legacy mapping has been repaired. The unresolved queue and complete row-level decisions are in reconciliation-report.json and catalogue-imports.json.

## Priority cleanup evidence

- Audit disposition coverage: 18886 source URLs; {"review":5108,"verified":12906,"invalid":872}.
- Newly proved full-byte copy merges: 0.
- Identical-document classification consolidations: 795.
- Redundant attached-document cards consolidated: 0.
- Shared-course English Paper 1 consolidations: 0.
- Question/combined assessment version consolidations: 2.
- Migrated fragment primaries: 1; validated legacy primaries: 200.
The known repeated 92,354-byte PDF is THSC's official 404 placeholder, not proof of corrupted directory mappings. Access-denied outcomes are review cases. Unverified legacy fallbacks are provenance rather than online actions.

## Reproducible builds

The catalogue reads committed catalogue-imports.json, never local dedupe acceptance/census state. The nightly build runs unit tests and verify-catalogue.cjs before publishing. Public counts derive from active canonical entries.
