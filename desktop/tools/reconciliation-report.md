# v1.0.26 catalogue reconciliation

## Correction to earlier release claims

The 10,368 figure counted listings, including mirror copies. v1.0.25 made URLs distinct but left duplicate cards. Its census iterated a Map with Object.entries(), so no SHA-confirmation candidates were processed. Its claim of catalogue-wide uniqueness is withdrawn.

## Current accounting

- Active catalogue entries: **7247** (previously 10,368).
- Imported rows reconciled: 3393.
- Mirror/copy imports merged into existing entries: **2893**.
- Added after metadata and identity checks: **296**.
- Imports retained in the committed review registry, excluded from active totals: **204**.
- Existing-copy merges: 47.
- Historical IDs resolving to active entries: 2940.

- Direct-file pointers: 7209/7976; resolver primaries: 308.

| Source | Merged | Added | Review |
|---|---:|---:|---:|
| 4unitmaths | 0 | 20 | 174 |
| acehsc | 0 | 11 | 12 |
| crest | 0 | 0 | 1 |
| thsc-au-growth | 2893 | 265 | 17 |

## Evidence and preservation rules

Exact listing directory/name identifies a logical paper independent of its mirror URL. Matching full hashes plus semantic context also establish copies. School/year tuples alone are review hints, not proof. Paper numbers, document roles, provider, school level and exam blocks remain distinct.

Canonical entries retain the original ID and richer metadata. Mirror URLs and their cached byte proofs are alternative sources; historical metadata is preserved for desktop library path recognition. Alias IDs are not separate cards. No files already downloaded by users are deleted or renamed.

## Limits and remaining review

Shared-URL groups with differing document metadata recorded for mapping review: 10. These are not silently merged or disguised by URL demotion.
Rejected official replacements recorded: 119 (trial/assessment, provider or paper-part mismatches).
The census now distinguishes full-file hash evidence from incomplete HEAD coverage. This report does not claim every historical PDF is byte-unique or every legacy mapping has been repaired. The unresolved queue and complete row-level decisions are in reconciliation-report.json and catalogue-imports.json.

## Reproducible builds

The catalogue reads committed catalogue-imports.json, never local dedupe acceptance/census state. The nightly build runs unit tests and verify-catalogue.cjs before publishing. Public counts derive from active canonical entries.
