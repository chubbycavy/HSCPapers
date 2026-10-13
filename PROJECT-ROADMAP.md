# HSCPapers: consolidated release plan, roadmap and handoff

Updated: 2026-10-13.
Workspace: `C:\Users\chubb\Downloads\HSCPapers`.
Repository: `chubbycavy/HSCPapers`.
Site: https://hscpapers.com/.

## 0. Current execution and authorization

**The user subsequently approved local execution of the stability-release plan.**
The active consolidated execution plan is
[`RELEASE-READINESS-PLAN.md`](RELEASE-READINESS-PLAN.md), targeting 1.0.27.
Its completion record and
[`desktop/tools/release-readiness-report.md`](desktop/tools/release-readiness-report.md)
record completed and remaining work.

The user previously approved implementation of the priority THSC migration and
duplicate/invalid-paper cleanup plan. That implementation is completed locally,
with tests and a release-mode binary. It is not committed or published.

Local readiness changes, targeted proof refresh, catalogue regeneration, checks
and installer preparation are authorized. The user chose **Keep verified legacy**
for this release. Commit/push, public deployment, uploads and GitHub release
publication remain separate authorization steps. Broader script elimination and
hosting expansion are deferred milestones.

Local execution is complete: 6,629 available records, 7,328 file pointers,
894 recovery records, 12 fragment primaries and 201 transitional legacy primaries.
Fourteen migrated files were rechecked and six review dispositions refreshed.
`papers-v2.json` is the modern feed; `papers.json` is the old-client compatibility
projection. Nightly mirror sync and publication-continuity bindings are in place.
Final checks: 57 JS units, 53 browser cases, 17 Rust tests, sweep
57 PASS/0 FAIL. The 1.0.27 NSIS installer and digest are recorded in the completion
report. Actual installed-upgrade smoke, explicit publication and production checks
remain. The 12 October tables below are historical evidence.

This document consolidates the important current plans. Its latest priorities and
evidence supersede stale assumptions in older plans. Historical snapshots remain
historical; do not silently rewrite them as fresh measurements.

## 1. User priorities and decision log

### Immediate priority

**Keep development rapid and deliver a stable release addressing Dan's actual
download concern as soon as possible.** Use a narrowly scoped stability release,
with only demonstrated release blockers on its critical path.

Dan's statement, quoted by the user:

> "fix the slow route papers, these are not valid for download, as i've removed
> the /d links"

Time supplied by the user: **9/10/2026, 10:07 PM** (9 October in the project's
Australian date convention; timezone was not explicitly supplied).

This is evidence about removed download routes at that time. It is not evidence
that Dan requested a hosting expansion, attribution change, traffic restriction,
or permanent removal of every legacy transport. Changes occurred subsequently.

The immediate release criterion is:

**App-controlled download actions must deliver supported, verified PDF bytes;
removed `/d` links, viewer HTML and error documents must not be advertised as
working direct PDF downloads.**

Old URLs may be retained as historical identity/lookup data where necessary for
ID and filename compatibility. That is distinct from navigating users to them.

### Longer-term goals

- Maximum speed.
- Maximum coverage.
- Minimum duplicate/404 risk.
- Eliminate the slowest script-lane papers.
- Retain the existing Slow route name, ultimately backed by medium-speed delivery.
- Preserve valid papers, file versions, bookmarks, IDs and local downloads.

### Recorded choices and standing constraints

- Unrecoverable records go to a **recovery archive**: preserve identity/history,
  exclude unsupported online actions and unavailable records from available totals.
- Keep the Slow route user-facing concept/name.
- Existing expansion policy permits approved public Drive material to be rehosted
  on R2. Other new sources remain direct third-party links until that policy is
  explicitly broadened. The existing owned R2 set predates that expansion policy.
- Discovery is evidence-gated, without an arbitrary additions cap. AceHSC
  all-subject discovery and Wayback recovery were approved previously.
- Preserve attribution and removal/takedown decisions. No login/paywall bypass.
- One canonical assessment/document representation when copies are established;
  retain genuine separate assessments, parts, providers and document versions.

## 2. Where the project currently stands

### Local release candidate: implemented and verified on 2026-10-12

Source of detailed evidence: `desktop/tools/priority-completion-report.md`.

| Local generated catalogue | Count |
| --- | ---: |
| Available canonical records | 6,625 |
| Primary/solution URL pointers | 7,323 |
| Direct-file pointers | 7,114 |
| Migrated fragment primaries | 8 |
| Validated legacy primaries retained for the priority transition | 201 |
| Recovery records | 898 |
| Historical aliases to active/recovery records | 4,844 |
| Original import rows accounted for | 3,393 |
| Imports merged / added / review | 2,999 / 172 / 222 |

These are candidate counts, not a fresh inventory of the published website. A
direct-file pointer is not necessarily a fast source, a unique PDF, or a guarantee
of current availability.

The audit inventoried 16,219 source URLs: 10,253 full-byte PDF-verified, 872 invalid
outcomes and 5,094 review/provenance dispositions. No pending/transient audit work
remained in that completed run. Review includes 5,052 legacy fallbacks intentionally
retained as provenance instead of executing thousands of quota-consuming requests.
Complete dispositions do not mean every inventoried URL has a full hash.

Implemented work includes:

- Shared hosted/local fragment adapter and native gzip-fragment delivery.
- Correct placeholder rejection, incomplete-PDF checks and safer PDF caching.
- Corrected course/provider/answer mappings and cross-school solution attachments.
- Historical-ID continuity and preservation of question/combined/solution versions.
- Full-byte copy and classification consolidation; redundant attached-document
  cards and explicitly shared English Paper 1 copies consolidated.
- Recovery archive with bookmarks/history and existing-local-file access.
- Queue source re-resolution and native direct-alternative handling.
- Committed proof/history inputs and nightly continuity/admission safeguards.
- Available-catalogue marketing counts rather than inflated listings.

Verification completed:

- JavaScript units: 43 passed.
- Browser regression suite: 38 passed.
- Rust tests: 15 passed.
- Sweep: 57 PASS, 0 FAIL, 2 existing warnings.
- Guarded offline rebuild and prior-publication identity checks pass.
- Catalogue approximately 0.58 MiB Brotli, within its 0.75 MiB budget.
- `git diff --check` passed.
- `cargo build --release` succeeded.

Binary: `desktop/src-tauri/target/release/hscpapes.exe` (crate spelling is existing).
Package/version remains 1.0.26. A next-release version has not been assigned.
No new NSIS installer or GitHub release was published.

### Repository/publication state

- The implementation, evidence and generated surface are uncommitted workspace
  changes. New implementation/evidence files are also untracked.
- Last synchronized checkout was main at nightly commit
  `775fe948f94412a0ec3495a0b7f5770c62059f3c`. Do not assume remote main remains there.
- Released v1.0.26 code was `08f9c0a68a3e7d60b70293e8bbd5ac3b357894f0`.
- Do not reset, discard, overwrite or blindly stash the candidate when resuming.
- Preserve unrelated user artifacts `debug.log` and `desktop/tools/logo-previews/`.
- Existing `.opencode/plans/` documents are local and Git-ignored. This root file
  is discoverable from the workspace and can be committed only if requested.

## 3. Latest live THSC investigation: 2026-10-13

This investigation was read-only. It did not refresh registries or rebuild the
candidate. The candidate counts in section 2 therefore remain unchanged.

### Frontend and published activity

The live viewer, custom PDF viewer and React bundle were byte-for-byte identical
to the saved earlier investigation. Checked around 03:35 UTC.

| Asset | Bytes | SHA-256 |
| --- | ---: | --- |
| `/s/viewer.js` | 93,448 | `70750dcb4e35a3097c9e0ab55b959f04397cbb9991521aaa7d9dd0f915c941b0` |
| `/pdf/viewer_custom.js` | 503,124 | `7c489c4f2edb734c8a4ded65909448e5f2f2c5cb2a1d05c7846803ad82a2c88f` |
| `/s/app.js` | 1,822,786 | `12d82a73ca113503ff9e72112591e2df9e56091b1fbe59c11f8cd6c491b38919` |

The React inventory remained 141 registered static-page routes, 8,197 literal PDF
callback occurrences and 116 distinct view numbers. These are not unique-paper
counts. The inspected Extension 1, Physics and English Paper 1 listing sequences
were unchanged (810, 180 and 247 occurrences).

- Homepage still announces "New thsconline launched" and "More features coming soon".
- About page still says resources trickle in week by week.
- Public website branch's latest visible commit: `c0d12e6eca77c1e4deacf815d01b832c5bcfdef2`,
  "2019 Upload", 2026-10-10 11:37:04 UTC.
- Public `feed.atom` timestamp: 2026-10-10 11:36:39 UTC, listing paper updates.
- No specific forthcoming API change, identifier change, migration-completion
  timetable or legacy-fallback removal announcement was found.

Unchanged public assets do not prove a private backend is unchanged. Do not claim
Dan is finished, idle, or currently editing code based only on this evidence.

### Current transport contract

Official origin: `https://www.thsconline.net`.

- `/api/v1/getmetadata/<viewno>/<title>`
- `/api/v1/getfragment/<viewno>/<title>/<zero-based-index>`
- Numeric viewno and title lookup remain; no new opaque-ID scheme was observed.
- Concatenate binary fragments in index order and decompress ONE gzip stream.
- Metadata and fragments are not standalone PDF files.
- Listing-click and viewer-route title transformations differ, including ampersands.
  Preserve raw identity; derive the appropriate lookup separately.
- Tested API responses still did not grant CORS permission to our website. Use our
  same-origin PDF adapter for browser delivery, and native protocol support.
- THSC's custom viewer still retains legacy `export=view` fallback. Its standalone
  downloader and viewer have different failure behavior. Do not embed the viewer
  as an uncontrolled download/fallback substitute.

Sample routes `/s/d/5338/Abbotsleigh%202022`, `/s/v/5338/Abbotsleigh%202022`, and
`/s/index/5338.json` still returned HTTP 404 with an HTML React shell. A browser
route may render client-side despite that status; it is not direct PDF delivery.

### Coverage and actual file retrieval

At 03:40:51 UTC, the same original 311 resolver keys were checked:

- 14 positive metadata results; 297 zero-fragment results.
- Same 14 positives as the earlier check; no gains or losses in that lookup set.
- This is our original resolver backlog, not the entire THSC catalogue.
- A zero-fragment sentinel does not prove deletion; a legacy path or independent
  copy may still work.

At 03:43:17 UTC (approximately 14:43 AEDT), all 14 positives were reconstructed
using our implemented shared adapter. All returned valid PDF bytes; the eight
with verified saved-audit hashes matched. The six earlier access-review cases
were retrievable again. All requests reported cache hits; measured operations
were approximately 70-385 ms, not a cold-cache or worldwide performance promise.

**The following six proof/review dispositions are stale and need a targeted
refresh in a later authorized implementation turn before release:**

| Baseline ID | Viewno / lookup title | PDF bytes | Intended role |
| --- | --- | ---: | --- |
| `thsc-5222-normanhurst-boys-2025-w-sol` | `5222` / `Normanhurst Boys 2025 w. sol` | 2,758,853 | Preliminary Advanced PT2, combined |
| `thsc-5331-caringbah-2024-w-sol` | `5331` / `Caringbah 2024 w. sol` | 939,729 | Extension 1 CT1, combined |
| `thsc-5342-girraween-2024-w-sol` | `5342` / `Girraween 2024 w. sol` | 721,700 | Extension 2 CT2, combined |
| `thsc-5342-girraween-2025-w-sol` | `5342` / `Girraween 2025 w. sol` | 725,266 | Extension 2 CT2, combined |
| `thsc-5338-abbotsleigh-2022` | `5338` / `Abbotsleigh 2022` | 993,649 | Questions only, 13 pages |
| `thsc-6528-north-sydney-girls-2023-w-sol` | `6528` / `North Sydney Girls 2023 w. sol` | 1,890,263 | Questions + solutions, 88 pages |

Fresh SHA-256 values, in the same order:

1. `914f190edca86c5b1f718552964d8126f3e9c8a660790e3b8925d6ed80bac8ad`
2. `fbb00ec5ad7a6059d0c573c4a2f7853d96e755e862c6711d37aa99b1b939222c`
3. `c0b20993aed3a2a8fd0e06b6378fe990bc0d5f9d97a076a3ca4112c4f2a5eba5`
4. `1168a6aaaeb4b8d90b6af6fe208e59c92c73ec51db2813e9b188b1d0909c7cfc`
5. `866569610dc4bf9c5a1a009328f6f05142440f411c08a96fe5c3ff4aca11da93`
6. `a31a005edf0c721af7637160ca72ebed9423fc14bb694e1d06f39f319846561b`

Do not assume six recovered files imply six additional primary cards. Abbotsleigh
and North Sydney Girls have existing faster copies and separate version/solution
roles. Preserve their old IDs and local path mappings.

There is no observed frontend-contract reason to redesign the adapter or wait
indefinitely for "migration completion". Refresh this evidence near rollout.

## 4. Corrected incident facts and data laws

### Error PDF, not demonstrated mapping corruption

The repeated payload is `https://www.thsconline.net/s/index/404_html.pdf`:

- 92,354 bytes; one page saying "404 Not Found".
- SHA-256 `ae3414ce7149e4f808bca8563d46b813a36af04c5651762c47ce0f854ff0561c`.

It must be rejected. Identical error bytes/shared filerefs did not establish
directories were remapped to an unrelated exam. Historical `collapsed` labels in
old reports describe the placeholder; do not reinterpret them as fresh outcomes.
The historical Dan report now carries the diagnosis correction.

### Invalid Drive staging batch

The 23 staged Drive files belong to a university MATH3202 collection; sampled
covers identify University of Queensland material. They are not approved HSC
additions, are quarantined, and contribute zero approved uploads. Preserve the
local staged files. Valid PDF bytes alone never establish curriculum relevance.

### Identity, file roles and evidence

- Equal URL/SHA alone is not enough when assessment contexts differ or a file is a
  multi-assessment/part collection. School/year similarity is not merge proof.
- Preserve actual differences: paper parts, provider solutions, assessment blocks,
  question-only versus combined material, sitting date versus cohort year.
- Do not equate a 200 response, MIME type, HEAD length or PDF signature with correct
  content. Keep full-byte and semantic/context evidence separate.
- Scanned/ambiguous cases can stay in review. Do not promise every historical mapping
  is perfect or every PDF is globally unique.
- Preserve user files and original history. A corrected source does not repair an
  already saved placeholder automatically.
- Keep available records, source pointers, physical stored objects and recovery
  records as separate counts. Consolidation stages are not additive deletion totals.

Known version relationships:

- Abbotsleigh 2022 Extension 1: old 30-page combined copy versus new 13-page questions.
  Canonical historical ID: `thsc-5338-abbotsleigh-2022-w-sol`; new listing ID is an alias.
- North Sydney Girls 2023 Physics: old 39-page questions versus new 88-page combined.
  Canonical historical ID: `thsc-6528-north-sydney-girls-2023`; preserve the old fast
  questions copy and correctly represent the migrated combined/solution version.
- Retired Abbotsleigh mirror ID `add-thsc-au-growth-db836e142c` must continue resolving.

## 5. Immediate narrow stability-release plan (NOT executed)

Release goal: address Dan's actual removed-link concern quickly and preserve
correct coverage. Freeze new feature scope; add only a demonstrated release fix,
compatibility requirement or low-cost protection for user state/files.

### R1 - Targeted freshness and download-action checks

- Refresh only the six recovered proof/review records, with correct versions and
  identities; rebuild/reconcile under the existing gates once authorized.
- Prefer existing proven faster direct copies. The recent 14-file check is not a
  reason to redirect all fast papers through the new API.
- Inspect all actionable link surfaces: web/native cards, modifier-clicks, reader,
  solutions, ZIP, resumed jobs and generated pages.
- Actual actions must use supported PDF delivery. Removed router/viewer URLs must
  not be exposed as direct PDF downloads; history/lookup records are preserved.
- Confirm default/native card href behavior specifically: current source contains
  `IS_TAURI ? paperHref : downloadHref(paperHref)`, which warrants targeted review
  for external/modifier-click navigation to router descriptors.
- Missing or invalid sources retain recovery/review status; do not fabricate a URL.
- No new full 16,219-source audit unless a real regression or contract change
  justifies it. The current protocol/frontend comparison found none.

### R2 - Minimum release compatibility check

- Test new website/new catalogue, new desktop/new catalogue, existing desktop
  during rollout, offline bundled data and stale/resumed queues.
- The new client accepts a v2 live catalogue or falls back to its bundled v2 copy.
  That does not make an old installed binary understand the new fragment protocol.
- Choose a minimal backwards-compatible feed/versioned-path or coordinated rollout
  strategy before publishing new data. A query cache key or schema tag alone is
  not an old-client compatibility solution.
- Ensure verified alternatives and old local filenames work after upgrade.
- Preserve a known-good candidate/release checkpoint. Assign a release version
  only during authorized release preparation; 1.0.27 is not already assigned.

### R3 - Low-cost safety, not a large new feature project

- Snapshot raw device state once before its first identity migration: bookmarks,
  recent items, download markers, filters and queued work. Keep the backup.
- Test an existing installation with representative library files and queues.
- Preserve final user PDFs; failures must not delete or overwrite good originals.
- Keep the previous installer and compatible catalogue/release inputs available.
- An automatic updater expects newer versions; rollback may need a higher version
  containing last-known-good code, not a downgrade to an older tag.
- A complete restore UI, elaborate rollout infrastructure and every long-term
  mitigation are not prerequisites for this focused release.

### R4 - Package and publish only when explicitly authorized

- Review the intentional diff, include new required files, preserve unrelated user
  artifacts, then commit/push only when requested.
- Assign the approved version consistently in package/Tauri/Cargo metadata.
- Build an NSIS installer, verify local and published hashes, and coordinate website,
  proxy, catalogue and desktop publication.
- Run focused production smoke checks against real supported delivery and caches.
- Send Dan a short factual response about the removed-link fix and current delivery,
  including the corrected placeholder diagnosis if relevant. Do not repeat unsupported
  corruption accusations or claim all old keys are migrated.

### Release acceptance

- [ ] Six recovered proofs reviewed/refreshed; candidate regenerated as needed.
- [ ] No actionable direct download points to a removed route, HTML or error PDF.
- [ ] Web/native/old-client/offline/queue compatibility is demonstrated.
- [ ] Low-cost state/file checkpoints exist and upgrade preserves library behavior.
- [ ] Relevant regression checks pass; install/package/digest checks pass.
- [ ] Publication operations explicitly authorized and production smoke checks pass.

Verified transitional legacy delivery may remain for this ASAP release. It does
not satisfy the later absolute runtime script-elimination end-state.

## 6. Longer-term roadmap (separately approved future work)

### M1 - Publish the stability release

Execute section 5 after approval. Outcome: users receive migration compatibility,
corrected publication and recovery metadata, with a coordinated rollback point.

### M2 - Replace the remaining script primaries

- Recheck current migrated API coverage; look for exact direct mirror/archive copies.
- Establish correct document/provider/part/version identity for each replacement.
- If targeted R2 expansion is approved, use a separate operator acquisition tool
  to retrieve publicly accessible legacy-served files once and publish verified
  immutable copies. No request-triggered acquisition fallback in the app.
- Maintain a per-record ledger: Fast replacement, Medium replacement, recovery,
  or identity review. Prepare replacements before enforcing a runtime cutoff.

Done when every current script primary has a verified non-script source or an
explicit recovery disposition. Counts change as the live migration progresses.

### M3 - Final two-tier delivery with medium-backed Slow route

| Internal tier | User treatment | Eligible source |
| --- | --- | --- |
| Fast | Default available browsing/downloads | Verified low-overhead direct delivery |
| Medium | Existing Slow route label/setting | Verified fragments or suitable measured medium sources |
| Unavailable/review | Recovery archive | Identity/local history retained; unsupported online actions disabled |

- Apply one per-file/version source policy to reader, solutions, ZIP, native save,
  preflight, alternatives, redirects, retries and resumed queues.
- A Fast primary with a Medium backup remains Fast; Medium-only delivery is
  included through Slow route. Prefer proven faster copies.
- If absolute cutoff is approved, exclude Apps Script execution from every
  app-controlled user delivery path, including failure cases and stale/offline data.
- Block script destinations before following redirects; a checkbox is not the
  enforcement boundary. Attribution browsing is distinct from app download delivery.
- Keep operator acquisition isolated from shipped/request-triggered runtime.
- Demonstrate zero attempted script requests with instrumented browser/server/native
  tests. Existing unupdated binaries are outside a new-client execution guarantee.

### M4 - Recover coverage and resolve remaining identities

- Prioritize the 17 mapping-review groups: bytes may exist but relationships are
  unestablished. Then review 222 import candidates and recover archive records.
- Preserve original IDs on restoration; do not create unrelated replacement IDs.
- Use body/source evidence for courses, assessment blocks, paper parts, provider
  solutions and calendar/cohort-year differences. Avoid aggressive tuple guessing.
- Continue approved source discovery after the stability release, including existing
  mirrors, official archives, Wayback and relevant Drive collections.
- Admit each new/restored source through the full-byte/context gates. Maintain
  takedown state across rediscovery, aliases and file versions.

### M5 - Optimize measured performance

- Measure startup, first-page render, full transfer, failure/fallback rate and slow
  cases separately by source, file size and connection conditions.
- Tune bounded concurrency, cancellation, retry budgets and in-flight deduplication.
- Improve appropriate caching/range behavior without accepting partial/error bodies.
- If approved, use a production R2 custom domain (proposed `files.hscpapers.com`),
  caching, CORS and range support; preserve old delivery/path metadata.
- Long immutable caching belongs to hash-addressed content. Mutable lookup endpoints
  need controllable version/TTL behavior. Warm-cache samples are not universal SLAs.

### M6 - Routine reliability and incremental growth

- Retain nightly admission, identity continuity and reproducible committed inputs.
- Rotate health/recovery checks; validate fully on admission/content change, not a
  full redownload of the catalogue every day.
- Stop on unexplained availability drops, bad alias moves or widespread classification
  changes; identity retention alone cannot detect mass movement into recovery.
- Treat transient failures and version drift conservatively. Keep publication and
  proof-registry checkpoints. Do not automatically accept changed hashes.
- Retain useful archived subject URLs/tombstones rather than surprise SEO/link 404s.
- Report available, Fast, Medium, recovery, review and hosted-object counts separately.

Recommended sequence: **stability release -> replacement preparation -> approved
cutoff/medium-only end-state -> continuing recovery/growth -> measured optimization**.
Identity recovery and performance work can be targeted alongside replacement work
without expanding the release critical path.

## 7. Open decisions and hosting estimates

No pending choice below has been silently approved:

1. **Absolute runtime cutoff:** user said eliminate the slowest script-lane papers,
   but has not confirmed whether that means no app-controlled script request ever
   versus zero script-primary cards with an emergency legacy fallback retained.
   Recommendation: absolute cutoff later, after preparing replacements.
2. **R2 scope:** targeted verified recovery mirroring is recommended; expansion
   beyond currently approved Drive policy remains pending.
3. **One-time legacy acquisition:** confirm permitted public-file operator use if
   mirroring is broadened. It is distinct from runtime delivery.
4. **Infrastructure/performance budgets:** custom domain and practical startup/
   retry/concurrency thresholds remain proposed, not configured or approved.
5. **Publishing:** version, installer/release, commit/push/deploy and rollout need
   an explicit instruction.

### Count estimates, refreshed to the candidate where possible

- Existing catalogue-referenced owned R2 footprint: **76 files**; not a full bucket
  inventory. Future eligible Drive discoveries have an unknown count; university
  staging batch contributes zero approved HSC files.
- Targeted mirroring of one replacement for each current 201 script primary:
  **76 + up to 201 = approximately 277 files** before full-hash deduplication,
  additional versions/solutions, or replacements served by third-party sources.
- Earlier estimate of approximately 280 used 202 recovery candidates; the older
  approximately 390 scenario assumed recovery of all 311 original script primaries.
  Those are historical planning estimates, not upload promises or fixed limits.
- Full-catalogue hosting is a separate much larger scope: thousands of files,
  not the targeted hundreds. Source-pointer totals are not unique-file totals.
- File counts do not establish storage/request costs; measure actual sizes/use.
- Use immutable full-SHA keys, remote full-byte verification and retained provenance
  if upload is approved. No overwriting an existing hash-addressed version.

## 8. Risk register and proportional mitigations

These are qualitative pre-mitigation assessments, not invented probability figures.
Code/data rollback does not automatically undo distributed installs, caches, local
state migrations or already downloaded public copies.

| Milestone | Hard-to-reverse risk | Main failure | Mitigation |
| --- | --- | --- | --- |
| M1 release | Medium-high | Old/new client/feed mismatch; wrong user-state remap | Compatible/versioned feed, one-time state backup, release checkpoints, real upgrade/rollback check |
| M2 replacement | Medium | Wrong role/version hosted or original only copy lost | Retained verified staging bytes, immutable keys, publish after remote verification, small initial batch |
| M3 cutoff | Medium | Coverage cut off prematurely; stale queues bypass policy | Replacement ledger, visible archive impact, current-source re-resolution, explicit policy checkpoint and instrumented failure tests |
| M4 identity/recovery | Medium-high | False merges erase user intent or hide genuine assessments | Append-only before/after ledger, preserved variants, semantic evidence, human review for weak cases, state backups and unmerge recovery |
| M5 optimization | Low-medium; higher for file writing | Mixed-version resume, concurrent writers, overwrite or long bad cache | Per-destination lock, version-aware resume/If-Range, temporary write and identity verification, atomic finalize, short mutable caching |
| M6 automation | Medium-high | Temporary failure/parse rule archives hundreds and auto-publishes | Candidate validation, last-good snapshot, per-source/global change budgets, publication stop on unexplained regressions, observed initial runs |

### Existing protections versus remaining work

Existing: preserved catalogue history/aliases, recovery metadata, byte evidence,
known-placeholder checks, tested version cases, separate source finalization and
previous-publication continuity gates.

Release-relevant gaps to evaluate:

- User-specific original state is not recovered merely by having old catalogue
  records. Many-to-one alias remaps should have a raw local-state snapshot first.
- New-client v2 checking does not protect an old binary reading a new feed.
- Native source switching clears incompatible partials, but same-URL version-aware
  resume and per-destination concurrency/expected-identity checks warrant attention
  before risky downloader optimizations. Do not claim those protections already exist.
- The updater expects newer versions; keep a forward-rollback plan.
- Nightly continuity can pass if records all become archived. Add availability-delta
  budgets and appropriate observation rather than relying only on identity checks.
- Public files cannot be recalled from users' machines. Before publication, establish
  content/role identity and retain originals; a hash proves bytes, not permission or
  assessment relationship.

For rapid development, put the low-cost checkpoint/state-backup/compatibility
checks on the release path. Keep the comprehensive restore UI, broad infrastructure
project and all long-term optimizations off that path unless a demonstrated failure
makes them release blockers.

## 9. Implementation/evidence map for the next session

| Area | Important files |
| --- | --- |
| Shared/web delivery | `desktop/ui/_lib/thsc-fragments.mjs`, `pdf-proxy.mjs`, `desktop/ui/functions/proxy.js`, `serve.js` |
| Native delivery | `desktop/src-tauri/src/thsc_fragments.rs`, `main.rs`, `Cargo.toml`, `Cargo.lock` |
| Browser/queues/library/version UI | `desktop/ui/js/app.js`, `catalogue-aliases.js`, `pdf-validation.js`, `config.js`, `index.html`, `sw.js` |
| Build/reconciliation | `desktop/tools/build-index.cjs`, `catalogue-identity.cjs`, `catalogue-reconcile.cjs`, `catalogue-cleanup.cjs`, `document-admission.cjs` |
| Durable evidence | `catalogue-validation.json`, `catalogue-history.json`, `catalogue-metadata-corrections.json`, `catalogue-document-review.json`, `catalogue-imports.json` |
| Audit/admission operators | `priority-audit.cjs`, `prepare-priority-inputs.cjs`, `refresh-catalogue-proof.cjs`, `verify-catalogue.cjs`, `validate-registry.cjs`, `content-census.cjs` |
| Drive | `drive.cjs`, `drive-verified.json`, `drive-upload-manifest.json` (quarantined batch) |
| Reports/generated surface | `priority-completion-report.md`, reconciliation JSON/MD, coverage, subjects, sitemap, README |
| Nightly | `.github/workflows/catalogue.yml`, `.github/workflows/nightly.yml` |
| Tests | `desktop/tools/tests/`, `desktop/tools/e2e/`, native tests |

The latest read-only probes did not change these files. Inspect durable inputs
before refreshing: the six regained files still have old review dispositions.

### Execution cautions for a later authorized turn

- Windows PowerShell 5.1: use `npm.cmd`/`npx.cmd`, not `&&`; check native exit codes.
- Use `apply_patch` for edits and preserve UTF-8/LF. Avoid default PowerShell
  content pipelines that have previously introduced mojibake/encoding changes.
- A `Start-Process` tool error `Unknown: ChildProcess.kill` can occur after a child
  has actually launched. Check the process/log before retrying; duplicate writers
  can corrupt shared run state. The previous full audit is already completed.
- Operator `.cache` state/logs are ignored and not publication inputs. Do not rerun
  bootstrap scripts blindly: `prepare-priority-inputs.cjs` derives historical
  inputs from a specific old release and can replace current reviewed inputs.
- Future root temp files belong in the preapproved
  `C:\Users\chubb\AppData\Local\Temp\opencode` location when outside the workspace.

### Relevant checks, for authorized later execution only

Working directory `desktop`:

```powershell
npm.cmd run test:unit
npm.cmd run test:sweep
npm.cmd run test:e2e
```

Working directory `desktop/src-tauri`:

```powershell
cargo test
cargo build --release
```

Root catalogue checks/generation (these write outputs when generation is run):

```powershell
node --require ./desktop/tools/tests/no-local-ingest.cjs desktop/tools/build-index.cjs --offline --quiet
node desktop/tools/verify-catalogue.cjs --previous=desktop/tools/.cache/priority-audit/baseline.json
```

Use a synchronized snapshot for `test:live` after an authorized deployment. Do not
interpret an intentionally unpublished candidate versus the old live catalogue as
an application failure. Installer/digest and genuine upgrade checks remain release
preparation, not results implied by the existing release-mode binary.

## 10. Resume checklist

This is guidance for a future authorized session, not an instruction to execute now.

1. Read this file and the completion report. Establish whether the user authorized
   release preparation, publishing, broader roadmap work, or documentation only.
2. Inspect the dirty worktree and remote history; preserve candidate/user artifacts.
3. Prioritize the narrow stable release; do not restart the broader architecture or
   full audit simply because context was compacted.
4. If release work is approved, refresh the six regained proof records and address
   actionable href/client-feed compatibility with the smallest supported change.
5. Add only necessary low-cost state/file checkpoints, then run relevant checks.
6. Present any revised counts, limitations and rollout plan. Publish only with
   explicit permission; do not invent an already assigned release version.
7. After stability rollout, resume separately approved script replacement/hosting,
   recovery and performance milestones.

## 11. Existing plans and research references

- Detailed completed priority plan:
  [`.opencode/plans/thsc-migration-catalogue-cleanup.md`](.opencode/plans/thsc-migration-catalogue-cleanup.md)
- Detailed deferred roadmap:
  [`.opencode/plans/delivery-speed-coverage-roadmap.md`](.opencode/plans/delivery-speed-coverage-roadmap.md)
- Local completion evidence:
  [`desktop/tools/priority-completion-report.md`](desktop/tools/priority-completion-report.md)
- Current accounting:
  [`desktop/tools/reconciliation-report.md`](desktop/tools/reconciliation-report.md)
- THSC homepage: https://www.thsconline.net/s/
- Downloader/router: https://www.thsconline.net/s/viewer.js
- Viewer byte loader: https://www.thsconline.net/pdf/viewer_custom.js
- React frontend: https://www.thsconline.net/s/app.js
- Published feed: https://raw.githubusercontent.com/thsconline/s/thsconline-website/feed.atom
- Public branch activity: https://github.com/thsconline/s/commits/thsconline-website
- R2 custom-domain/public-bucket documentation:
  https://developers.cloudflare.com/r2/buckets/public-buckets/
  and https://developers.cloudflare.com/r2/platform/limits/

Older v1.0.24/v1.0.25 growth/uniqueness assertions, fixed timing promises, and
mapping-corruption claims are superseded by the corrections above. No plan-file
creation, context handoff or build-mode switch authorizes plan execution.
