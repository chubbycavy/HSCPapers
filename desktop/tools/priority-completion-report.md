# THSC migration and catalogue cleanup: local completion report

Completed and verified locally: 2026-10-12. No commit, push, deployment, R2 upload,
version bump or release publication was performed. The published site/release
therefore still has its previous snapshot until rollout is authorized.

## Delivered

- Shared hosted/local THSC fragment adapter, plus native gzip-fragment delivery.
  Metadata/fragments are assembled into validated PDF bytes. The migrated adapter
  has no implicit Apps Script or external-viewer escape path.
- Correct placeholder detection and incident diagnosis: the repeated 92,354-byte
  payload is THSC's official one-page 404 PDF. Shared filerefs are not corruption
  evidence. Native, browser-download and service-worker validation reject known
  placeholders/incomplete files; error responses are not cached as documents.
- Corrected source admission, courses, provider/answer claims, exact-source matching,
  unrelated-school solution attachments and the 2017 Mathematics question/MG swap.
- Restored known renamed assessment IDs; preserved original local filenames and
  separate question/combined/solution versions. Version controls expose verified
  alternatives; unrelated variants cannot falsely satisfy primary saved-file checks.
- Consolidated proven identical documents/classification copies and redundant
  attached-document cards, including explicitly common English Paper 1 copies.
- Recovery archive preserves unavailable/ambiguous records, bookmarks and historical
  IDs, with no unsupported online actions and an existing-local-file opening path.
- Resumed queues select current sources instead of replaying stale URLs. Direct
  alternatives work in native delivery and different-source partial files are not
  spliced together.
- Committed audit/history/metadata inputs drive reproducible rebuilds. Nightly
  checks publication continuity, admits new byte-verified sources, rechecks a bounded
  rotating migrated-source set, and regenerates readable/JSON accounting together.
- Marketing counts round down from available records; recovery records do not
  inflate advertised coverage. The unrelated 23-file university Drive staging
  batch is quarantined and contributes no approved HSC uploads.

## Audit and catalogue accounting

The resumable full source inventory covered **16,219 unique URLs**, including
primary files, solutions, alternative sources and fallbacks:

| Final disposition | URLs |
| --- | ---: |
| Full-byte PDF verified | 10,253 |
| Invalid response/content | 872 |
| Review / unverified provenance | 5,094 |
| Pending/transient audit work | 0 |

Review includes 5,052 unverified legacy fallbacks deliberately retained as provenance
rather than executed as thousands of quota-consuming requests. Access-denied and
ambiguous integrity outcomes remain review cases, not accusations of corrupt files.
Complete dispositions do not mean every inventoried URL has a full hash.

The verifier requires current full-file proof and consistent intended context for
every published online file action. Remaining conflicting shared-file mappings
are excluded from online publication pending reviewed relationships.

| Local generated catalogue | Count |
| --- | ---: |
| Available canonical records | 6,625 |
| Explicit primary/solution file pointers | 7,323 |
| Direct-file pointers | 7,114 |
| Migrated fragment primaries | 8 |
| Validated legacy primaries retained during the approved transition | 201 |
| Recovery records | 898 |
| Historical aliases to active/recovery records | 4,844 |
| Original import rows accounted for | 3,393 |
| Imports merged / added / review | 2,999 / 172 / 222 |

Cleanup evidence includes **815 classification-copy consolidations**, **66 newly
proved full-byte merges**, **19 redundant attached-document consolidations** and
**4 content-proved common English Paper 1 consolidations**. These are stages of
reconciliation, not additive counts of files deleted or previously published
papers lost. Early unsafe URL-only dropping had also hidden legitimate distinct
contexts; the final counts reflect both restored records and cleanup.

The earlier research reconstructed 14 new-API files. This later full audit found
8 usable migrated primaries; access failures were retained for review instead of
advertised as valid new routes. The adapter supports additional migration as it
becomes verifiable. New-API count-zero does not establish total paper deletion.

## Verification completed

- JavaScript unit suite: **43 passed**.
- Catalogue/contract sweep: **57 PASS, 0 FAIL, 2 existing warnings**.
- Browser regression suite: **38 passed**, including migration reader/download,
  recovery shared IDs/bookmarks, local-path aliases, reader panes, ZIPs and toggles.
- Rust tests: **15 passed**.
- `cargo build --release`: successful release-mode desktop binary.
- Guarded offline catalogue rebuild and previous-publication identity checks pass.
- Catalogue payload remains approximately **0.58 MiB Brotli**, within 0.75 MiB.
- `git diff --check`: clean.

The release-mode binary is `desktop/src-tauri/target/release/hscpapes.exe`.
No new NSIS installer or GitHub release was published.

## Explicit remaining limits / deferred work

- 222 original import candidates still require identity/metadata review; they are
  not advertised as available additions. Recovery contains 17 shared-file mapping
  groups awaiting supported context/part relationships.
- Scanned documents and classification uncertainty are preserved conservatively;
  this report does not claim every historical mapping is semantically perfect or
  every historical PDF is globally byte-unique. Byte and role evidence, disposition
  coverage and source provenance are retained for follow-up.
- Network availability can change after the audit. Hash/version drift requires
  review; it is not automatically accepted as the same document.
- Global elimination of Apps Script, expanded R2 mirroring and the medium-only
  end-state remain the separately approved longer-term roadmap. This priority
  transition retains 201 validated legacy primaries.
- Public deployment and coordinated desktop rollout remain pending authorization;
  new native clients prefer a compatible v2 live catalogue or the bundled v2 copy.

Evidence: `catalogue-validation.json`, `catalogue-history.json`,
`catalogue-metadata-corrections.json`, `catalogue-document-review.json`,
`reconciliation-report.json` and `reconciliation-report.md`. Resumable operator
state/logs remain in the ignored `.cache/priority-audit/` directory.
