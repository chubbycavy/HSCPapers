# HSCPapers stable-release readiness plan

Approved for local execution: 2026-10-13. Target: 1.0.27.

## Policy and scope

The user selected **Keep verified legacy**: retain validated legacy primaries
and eligible backups behind Slow route, while prohibiting fragment-primary to
legacy-script fallback. Preserve identity, file roles, versions and local paths.

Execute the local readiness work and produce a tested NSIS installer. Commit,
push, public deployment and GitHub release publication remain the plan's separate
authorization step. Preserve the existing dirty candidate and unrelated artifacts.

## Steps and reasoning

1. **Checkpoint and refresh evidence.** Save the candidate/proof inputs before
   changes. Reconstruct the six regained migrated files, review their text/roles,
   and retain old proofs/history. Recheck existing migrated proofs without silently
   accepting hash drift. This restores supported coverage without repeating the
   completed full audit.
2. **Separate catalogue consumers.** Generate modern `papers-v2.json` and an
   old-client-compatible `papers.json`. Old v1.0.26 ignores the schema tag, uses
   rotating `export=data` rather than the current fixed `export=view` contract,
   and ignores role-aware aliases. Bridge unsupported descriptors through stable
   absolute PDF-producing URLs; preserve semantically safe original/bridge aliases.
   Verify against the released consumer and keep nightly tools on modern data.
3. **Shared fallback selection.** Use explicit record/kind/version context,
   deduplicated approved candidates and a single eligibility policy. Fix fast
   solution backups in ZIP with Slow route off. Preserve bounded retry budgets:
   web downloads iterate candidates; reader/native use one selected backup.
4. **Supported links.** Make native/external/modifier-click links resolve PDF
   bytes for descriptor sources, preserving raw source identity separately. These
   links deliver the selected source; normal app downloads retain their fallback
   logic. Avoid removed router/viewer HTML navigation.
5. **State and upgrade checkpoint.** Snapshot raw bookmarks, recents, downloaded
   markers, filters and queue once before identity remapping. Test live-v2,
   incompatible-live and offline-bundle behavior; retain user PDFs and correct
   question/solution/version aliases. A restore UI is deferred.
6. **Focused checks.** Verify fast backups with Slow route off, legacy backups
   only when enabled, no fragment-to-script calls, ZIP solution backups, explicit
   version isolation, resumed sources and old/new feed compatibility. Run the
   relevant existing JS/browser/Rust/catalogue checks and fix failures.
7. **Package.** Synchronize 1.0.27 package/Tauri/Cargo metadata and npm lock root
   metadata; build NSIS; verify installer digest and installation/upgrade where
   available. The release executable alone does not certify the installer.
8. **Publication checkpoint.** Prepare both feeds, proxy, website and installer
   for coordinated publication. Retain rollback inputs and note forward rollback
   for the newer-version-only updater. Publish and run production checks only on
   explicit authorization; prepare a factual Dan update.

## Acceptance

- [x] Candidate checkpoint retained; six evidence dispositions refreshed.
- [x] Modern and compatibility feeds generated and independently checked.
- [x] Fallback eligibility, version isolation and PDF-producing links corrected.
- [x] Raw state checkpoint precedes migration; upgrade/offline fixtures pass.
- [x] Relevant regressions, catalogue continuity and payload budgets pass.
- [x] Versioned NSIS installer built and SHA-256 recorded.
- [x] Completion report records actual results and any remaining release gates.
- [x] Nightly mirror sync and publication-continuity bindings completed.

## Execution record

### Final nightly-sync step (completed 2026-10-13)

The user reported the installed candidate works, then authorized reconciliation
of the two newer nightly commits before publication.

- Checkpointed the tested installer, both feeds and evidence inputs at
  `.cache/release-readiness/nightly-sync/`.
- Brought the Git base from `775fe94` to `8fe14f0` with all working files retained.
- Validated the 14 new mirror files against upstream proofs and reviewed hashes —
  all matched.
- Preserved filenames from the current public catalogue and tested candidate,
  including separate questions and combined/solutions versions with role-aware
  saved-file aliases.
- Regenerated both feeds, checked continuity against both saved snapshots, ran
  relevant regressions (57 unit, 53 browser, 17 Rust, sweep 57 PASS / 0 FAIL),
  and rebuilt the installer because bundled data changed.

### Local execution complete (2026-10-13)

Current candidate: 6,629 available records, 7,328 file pointers, 894 recovery
records, 12 fragment primaries and 201 validated transitional legacy primaries.
Abbotsleigh/NSG versions are correctly carried through cached/offline builds.
Nightly mirror sync and publication-continuity bindings are in place.

Final checks: **57 JS units, 53 browser regressions, 17 Rust tests; sweep
57 PASS / 0 FAIL**. Guarded generation, identity/feed checks and approximately
0.59 MiB modern payload pass. Three real-upstream bridge samples match full hashes.

Installer: `desktop/src-tauri/target/release/bundle/nsis/HSCPapers_1.0.27_x64-setup.exe`.
SHA-256: `ac338eb4cbb811bf187d98edd4d108f21b9a91e6d1e5175c798e040a675e45aa`.
Artifact/input hashes: `desktop/tools/release-readiness-artifact.json`.

### Local execution complete (2026-10-13)

Current candidate: 6,629 available records, 7,328 file pointers, 894 recovery
records, 12 fragment primaries and 201 validated transitional legacy primaries.
Abbotsleigh/NSG versions are correctly carried through cached/offline builds.

Final checks: **57 JS units, 53 browser regressions, 17 Rust tests; sweep
57 PASS / 0 FAIL**. Guarded generation, identity/feed checks and approximately
0.59 MiB modern payload pass. Three real-upstream bridge samples match full hashes.

Installer: `desktop/src-tauri/target/release/bundle/nsis/HSCPapers_1.0.27_x64-setup.exe`.
SHA-256: `ac338eb4cbb811bf187d98edd4d108f21b9a91e6d1e5175c798e040a675e45aa`.
Artifact/input hashes: `desktop/tools/release-readiness-artifact.json`.

Authoritative results and remaining gates:
[`desktop/tools/release-readiness-report.md`](desktop/tools/release-readiness-report.md).
Actual installed-app upgrade smoke, publication authorization and coordinated
production checks remain. No commit, deployment or release publication occurred.

### Restart checkpoint (2026-10-13)

- Candidate/proof checkpoint exists at
  `desktop/tools/.cache/release-readiness/before-1.0.27/`.
- Targeted live reconstruction checked 14 files. Six review dispositions refreshed;
  existing verified hashes matched. The two scanned Girraween covers/solution
  sections were visually reviewed as Extension 2 Assessment Task 2, 2024/2025.
- Guarded offline rebuild completed: **6,629 available**, modern and compatibility
  feeds written; 4,844 aliases and all 3,393 imports passed continuity/accounting.
- Shared source policy, fast ZIP solution backup fix, exact-version reader
  isolation, descriptor delivery links, gateway unwrapping and raw-state
  checkpoint are implemented, awaiting focused regressions.
- New client/tooling/nightly paths use `papers-v2.json`; released consumers retain
  `papers.json` with stable PDF-producing bridges and filtered role aliases.
- Remaining: independent compatibility/fallback/upgrade fixtures, JS/browser/Rust
  checks, version synchronization, NSIS packaging, digest and completion report.

This restart checkpoint is historical; the completed results above supersede its
remaining-work list. Do not overwrite it or repeat the full source audit.

Results will be recorded here and in `desktop/tools/release-readiness-report.md`.
`PROJECT-ROADMAP.md` is the broader roadmap, with historical snapshots explicitly
dated. This approved local execution supersedes its former documentation-only
authorization statement for these steps.
