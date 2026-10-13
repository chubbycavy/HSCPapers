# HSCPapers 1.0.27: local release-readiness completion

Completed locally: 2026-10-13. Approved plan:
[`../../RELEASE-READINESS-PLAN.md`](../../RELEASE-READINESS-PLAN.md).

## Delivered

- Kept the approved verified legacy transition behind Slow route. Fragment
  primaries cannot select legacy-script backups; native enforcement is tested.
- Reconstructed all 14 migrated files, refreshed six stale proof dispositions,
  and retained full verified bytes in the ignored operator checkpoint. Existing
  reviewed hashes matched. Scanned Girraween 2024/2025 covers and solutions were
  visually confirmed as Mathematics Extension 2 Assessment Task 2.
- Fixed historical migration lookup on cached/offline listings. Abbotsleigh's
  13-page questions version is retained alongside its fast 30-page combined copy;
  North Sydney Girls' 88-page combined/solutions version is retained alongside its
  fast 39-page questions copy. Original canonical IDs and local paths survive.
- Generated two independently checked feeds: modern `papers-v2.json` and released
  consumer compatibility `papers.json`. Compatibility primaries/solutions use
  stable ordinary PDF-producing bridge URLs where their transport requires it;
  role-dependent aliases are excluded from the old projection. Modern aliases
  retain both original and bridge-derived filename identities.
- New startup accepts only supported v2 data and falls back to its bundled v2
  copy on offline, old-schema or future-unsupported live responses. Native
  embedded catalogue readers, operator tools, nightly generation and service
  worker routing use the correct feed. Service worker cache revision is v6.
- Shared eligibility receives explicit record/document/version context. Fast
  backups remain eligible with Slow route off, including ZIP solution backups.
  Slow primary/solution online actions require the switch; existing saved native
  files remain openable. Native and reader retain one selected backup attempt.
- Native/external descriptor links use supported PDF-producing URLs instead of
  router/viewer navigation. Cached old browser code's nested bridge is unwrapped
  locally with the existing source allowlist retained.
- Exact-version reader requests cannot inherit another version's backups.
  Initial reader page totals are initialized when the document loads.
- A one-time raw `hsc-state-before-migration-v2` checkpoint precedes remapping of
  bookmarks, recents, download markers, filters and queues. Failed checkpoint
  writes stop migration; existing checkpoints are never replaced.
- Version and npm/Tauri/Cargo metadata synchronized to 1.0.27. NSIS installer
  built; package metadata, Windows executable architecture, input freshness and
  SHA-256 verified. The production installation was not replaced by this task.

## Current local catalogue

| Item | Count |
| --- | ---: |
| Available canonical records | 6,629 |
| Primary/solution file pointers | 7,328 |
| Direct-file pointers | 7,114 |
| Migrated fragment primaries | 12 |
| Validated transitional legacy primaries | 201 |
| Recovery records | 894 |
| Historical aliases | 4,844 |
| Import rows merged / added / review | 2,999 / 172 / 222 |
| Shared-file mapping groups awaiting review | 17 |

Compatibility projection bridges 213 primary URLs and one solutions URL. The
14 migrated files comprise 12 primary files, one questions alternative/version
and one combined/solutions version, rather than 14 new primary cards.

The 12 October full-audit accounting remains historical evidence. The targeted
refresh is recorded separately in `catalogue-validation.json.releaseRefresh`;
it does not claim that all legacy/public sources were freshly downloaded again.

## Verification results

| Check | Result |
| --- | --- |
| JavaScript unit suite | 57 passed |
| Full browser regression suite | 53 passed |
| Rust tests | 17 passed |
| Catalogue/contract sweep | 57 PASS, 0 FAIL, 2 existing warnings |
| Guarded offline generation | Passed |
| Previous-publication identity/import continuity | Passed |
| Modern/compatibility feed checks | Passed |
| Nightly-sync publication continuity | Passed |
| Modern catalogue Brotli payload | Approximately 0.59 MiB / 0.75 MiB budget |
| NSIS package build | Passed |
| Installer version/name/PE/input checks | Passed |
| `git diff --check` | Passed |

Browser coverage includes real PDF parsing/rendering and ZIP output; native
frontend cases use mocked Tauri IPC. Old library-consumer semantics are frozen
from v1.0.26 and tested against the compatibility projection. Rust tests include
the actual Windows updater handoff/failure process tests.

The current production handler was also run locally against real public
upstreams for a migrated primary, a legacy primary and the restored combined
solutions source. All three reconstructed hashes matched the saved evidence:

- Killara 2019 Chemistry: 5,710,109 bytes.
- Abbotsleigh 2020 English: 3,262,547 bytes (current legacy `export=view` contract).
- North Sydney Girls 2023 Physics combined: 1,890,263 bytes.

This checks the current handler and upstream delivery, not a deployment of that
handler. Detailed operator evidence is under `.cache/release-readiness/`.

## Nightly-sync reconciliation (approved 2026-10-13)

After the user confirmed the installed candidate works, the two newer nightly
catalogue commits (`12190de` and `8fe14f0`) were reconciled before publication.
Both introduced direct `thsconline.com.au` mirror URLs for 14 files already
covered by reviewed fragment proofs.

- 14 mirror PDFs validated against upstream proofs and our saved hashes — all matched.
- Git base advanced from `775fe94` to `8fe14f0` with all working files retained.
- Saved-file recognition preserved for three sources per record: the tested
  candidate's path, the public mirror path, and variant-only bindings for
  question/combined/solutions versions. Role-aware aliases prevent a questions
  copy from satisfying a combined-primary lookup and vice versa.
- Both feeds regenerated; continuity checked against both the tested candidate
  and the current public catalogue. The compatibility projection updated
  accordingly.
- 57 unit tests, 53 browser tests (including 3 new publication-continuity tests),
  17 Rust tests and sweep 57 PASS / 0 FAIL all pass after the sync.

## Installer

`desktop/src-tauri/target/release/bundle/nsis/HSCPapers_1.0.27_x64-setup.exe`

- Size: 7,082,960 bytes.
- Windows product/file version: 1.0.27.
- Payload: x64; standard NSIS bootstrap is x86 (`0x14c`).
- SHA-256:
  `ac338eb4cbb811bf187d98edd4d108f21b9a91e6d1e5175c798e040a675e45aa`.
- Adjacent `.exe.sha256` file and `release-readiness-artifact.json` contain the
  digest and the exact source/catalogue input hashes for this package.

Build warnings remain for the existing static-VCRUNTIME configuration and unused
historical endpoint helper. Neither prevented packaging or the passing checks.

## Remaining release gates

1. **Explicit publication instruction:** review the whole dirty candidate and
   required untracked files, remote changes and intended release diff before
   commit/push. Preserve `debug.log` and `desktop/tools/logo-previews/`.
2. **Coordinate publication:** ship proxy, both feeds and website coherently;
   publish the versioned installer; verify the GitHub asset digest; run production
   smoke checks against the synchronized modern and compatibility feeds.
3. **Notify Dan:** explain the removed-link delivery fix and corrected placeholder
   diagnosis. The user decides where/how to send the message.

No commit, push, public deployment, upload or GitHub release publication happened.
The existing public release remains v1.0.26 until publication is authorized.
Retain the previous installer/compatible catalogue for forward rollback; the
updater normally accepts newer versions only.

## Suggested Dan update

> We've updated HSCPapers to use supported PDF delivery instead of navigating to
> the removed /d routes, added support for the migrated fragment API, and kept
> validated legacy delivery as an opt-in transition. Known 404 placeholder PDFs
> are rejected. We also corrected our earlier diagnosis: the repeated payload was
> the official 404 PDF, not evidence of remapped exams. The changes are verified
> locally and packaged; we'll confirm once the coordinated release is live.

## Resume information

The local implementation and nightly-sync reconciliation are complete. The user
has confirmed the installed candidate works. Resume with the publication review
and coordinated rollout, not another full audit or bootstrap-input regeneration.
Broader script elimination, R2 expansion, 222 import reviews, 17 mapping groups
and recovery growth remain the roadmap's later milestones.
