# wp5-completion - Work Plan

## TL;DR (For humans)
**What you'll get:** One shared literature-completion path that accepts a DOI or existing version, resumes from persisted facts, and stops only at the explicitly requested stage or a fully evidence-backed completed record.

**Why this approach:** Completion remains a thin application coordinator. Identity, metadata, immutable assets, parsing, and atomic analysis promotion stay with their existing owners, while completion stage is derived rather than stored.

**What it will NOT do:** It will not retain the old parallel CLI orchestration, add compatibility code, introduce workflow-status persistence, or implement the deferred reference-expansion work.

**Effort:** XL
**Risk:** High - the work replaces composition across metadata, acquisition, normalization, analysis, catalog facts, and four write entry points.
**Decisions to sanity-check:** A DOI creates no row until exact metadata succeeds; `COMPLETE` is WorkVersion-scoped; all compatibility paths are deleted.

Your next move: execute the approved plan through the final verified commits. Full execution detail follows below.

---

> TL;DR (machine): XL/high-risk application-layer orchestration, catalog fact derivation, four entry-point cutover, offline acceptance coverage, and post-verification atomic commits.

## Scope
### Must have
- `CompletionStage` with exactly `METADATA_PENDING`, `ASSET_PENDING`, `ANALYSIS_PENDING`, `COMPLETE`.
- Invocation-local normalized DOI and existing WorkVersion targets.
- Side-effect-free catalog facts that distinguish usable provider projection, exactly one accepted primary PDF, and aligned atomic current result/projections.
- `CompletionPipeline.ensure_complete` that invokes only the next missing stage and uses exactly three action ceilings: metadata, asset, complete. CLI `analyze` maps to complete; there is no duplicate analyze/complete semantic.
- A shared batch runner with stable order, WorkVersion deduplication, per-target outcomes, partial-failure isolation, redacted aggregation, and Ctrl+C suffix interruption.
- Explicit orthogonal operations for force reanalysis and optional XML/HTML acquisition; neither falsifies ordinary completion stage progression.
- Existing WP2-WP4 services remain sole writers of their facts.
- Search, download, analyze, and local primary-PDF import share the completion contract.
- Failed/interrupted/concurrent runs preserve or monotonically advance derived stage; replay skips completed facts and creates no duplicate observations, assets, parser artifacts, or current result.
- Current user docs and implementation progress reflect completed WP5 only after behavior passes.
### Must NOT have (guardrails, anti-slop, scope boundaries)
- No mutable completion status, durable workflow/job/task, daemon, lease, fencing, candidate checkpoint, or second truth source.
- No placeholder Work/WorkVersion for failed DOI metadata resolution.
- No compatibility adapter, feature flag, legacy import/read path, migration, backup, rollback, or retained parallel CLI chain.
- No WP6 expansion/curation/failures/config-check implementation.
- No dependency/lockfile changes and no live external services or production/user data in tests.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: strict red-green-refactor TDD using the repository's standard-library `unittest`; each implementation todo begins with a baseline characterization where behavior is replaced, then a failing test for the new contract.
- Evidence: `.omo/evidence/wp5/task-<N>.txt`; manual CLI evidence in `.omo/evidence/wp5/manual-qa.txt`; all temporary catalogs/storage live in the system temporary directory and are removed.

## Execution strategy
### Parallel execution waves
- Wave 1: catalog facts and exact DOI metadata resolver in parallel.
- Wave 2: typed completion contracts, one CLI-owned runtime assembly factory, per-target orchestration, and shared batch runner.
- Wave 3: search cutover and download/analyze/local-import cutover in parallel after pipeline API stabilizes.
- Wave 4: acceptance suite, architecture/documentation cutover, full validation.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 3, 4 | 2 |
| 2 | none | 3, 4 | 1 |
| 3 | 1, 2 | 4 | none |
| 4 | 1, 2, 3 | 5, 6, 7 | none |
| 5 | 4 | 7, 8 | 6 |
| 6 | 4 | 7, 8 | 5 |
| 7 | 5, 6 | 8 | none |
| 8 | 7 | F1, F2 | none |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Add catalog-owned completion facts and deterministic stage derivation
  What to do / Must NOT do: Start with tests for an invocation-local DOI, provider projection without PDF, supplementary-only/one-primary-plus-supplementary/multiple-primary relations, accepted PDF without current result, aligned current promotion, deliberately misaligned current/generated projections, and valid empty generated references/tags. Add immutable typed facts and a read-only repository under `catalog`. Read every fact in one SQLite read snapshot. Metadata is usable only when one persisted provider projection contains a nonblank normalized title, at least one provider observation exists, and identity is either a stable `doi`/`arxiv`/`pmcid`/`pmid` identifier or the WorkVersion is explicitly provisional under its exact provider-derived normalized title; these are the exact combinations from which `WorkVersionDownloadRepository.get` can construct the existing acquisition target. Identity-only rows, synthetic identifier titles, manual-only metadata and projection rows without observations remain METADATA_PENDING. Required asset readiness counts exactly one accepted `work_version_assets` relation with role `primary_pdf` joined to a RawAsset whose media type and format are PDF; supplementary/XML/HTML relations are ignored. Match that primary asset identity/hash to parser, source-map, analysis processing lineage; prove one current promotion by matching current payload collections and every generated metadata/reference/tag source to `current_analyses.analysis_artifact_id`; compare materialized canonical columns to manual > generated > provider. The current payload's explicit empty collections prove published-empty sets without adding status rows. Derive the four stages exhaustively. Do not add or alter a status column, and do not let catalog import completion.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 3, 4
  References: `docs/specs/system-design.md:126`, `src/sciretriever/catalog/models.py:156`, `src/sciretriever/catalog/analysis_selection.py:75`, `src/sciretriever/catalog/analysis.py:123`, `src/sciretriever/catalog/canonical_projection.py:31`, `tests/test_analysis_wp44.py`, `tests/test_analysis_wp45.py`, `tests/test_wp4_contracts.py`.
  Acceptance criteria: `uv run --frozen python -m unittest discover -s tests -p 'test_completion_facts_wp5.py'` passes; tests assert exact stages for stable-identifier provider projection, provisional title provider projection, identity-only/manual-only/projection-without-observation negatives, missing/XML/supplementary-only/multiple primary assets, one primary plus multiple supplementary assets, missing current, stale artifact/PDF lineage, explicit empty promoted collections, aligned COMPLETE, provider fallback and manual override; no mutable completion field/table exists; `uv run --frozen pyright src/sciretriever/catalog tests/test_completion_facts_wp5.py` reports zero errors.
  QA scenarios: Happy: execute a minimal real SQLite fixture through all four fact transitions in one repository read per observation and record stages. Failure: mutate each PDF/artifact/generated-source/canonical alignment independently and observe `ANALYSIS_PENDING`, not `COMPLETE`. Evidence `.omo/evidence/wp5/task-1.txt`.
  Commit: deferred until all WP5 verification | `feat(catalog): derive literature completion facts`

- [x] 2. Add exact stable-identifier metadata resolution without placeholders
  What to do / Must NOT do: Characterize existing query search, then add an exact-identifier application-facing metadata contract that normalizes DOI once, queries configured providers concurrently through existing discovery adapters, discards records not carrying the exact normalized DOI before any catalog write, deterministically merges exact records, and persists only usable metadata. All-provider failure or no exact result leaves catalog counts unchanged. Reuse normalization/ingestion; do not call `IdentityResolver.create_or_reuse_work` before usable metadata exists and do not preserve a query-based fallback compatibility path.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 3, 4
  References: `src/sciretriever/core/contracts.py`, `src/sciretriever/discovery/search.py:32`, `src/sciretriever/discovery/search.py:92`, `src/sciretriever/catalog/library.py`, `tests/test_search_wp2.py:277`, `docs/planning/literature-library-execution.md:115`.
  Acceptance criteria: `uv run --frozen python -m unittest discover -s tests -p 'test_exact_metadata_wp5.py'` proves DOI syntax and prefix normalization, mixed exact/non-exact results, valid-but-missing DOI, partial provider failure, all-provider failure, zero exact results, deterministic precedence, replay observation counts, and no placeholder rows; existing `test_search_wp2.py` stays green.
  QA scenarios: Happy: fake two providers with the same DOI and complementary fields, observe one persisted WorkVersion. Failure: providers return only neighboring DOI/title matches, observe `METADATA_PENDING` and zero new Work/WorkVersion rows. Evidence `.omo/evidence/wp5/task-2.txt`.
  Commit: deferred until all WP5 verification | `feat(discovery): resolve exact metadata targets`

- [x] 3. Define typed completion, batch, force, optional-asset, and runtime assembly contracts
  What to do / Must NOT do: Create `src/sciretriever/completion/` with frozen tagged `DoiTarget`/`WorkVersionTarget`, `CompletionStage`, three `CompletionStop` values (METADATA, ASSET, COMPLETE), redacted `ADVANCED`/`NOT_ADVANCED` stage outcomes, result contracts, and narrow Protocols for facts, exact metadata, required primary-PDF acquisition, and the one WP4 atomic analysis-promotion API. Define a batch runner contract: stable input order, WorkVersion deduplication, per-target outcomes, partial failure continuation, sanitized aggregate, stop-starting-new-targets on Ctrl+C, current/unstarted suffix interruption. Define `force_analysis` as COMPLETE->COMPLETE revision replacement that skips metadata/acquisition and preserves old current on failure. Define optional XML/HTML acquisition as orthogonal work that never changes stage. Name `src/sciretriever/cli/completion_runtime.py` as the single invocation-owned assembly module; CLI builds one CatalogEngine and injects adapters, while completion never imports CLI. Do not create aliases for old callable chains.
  Parallelization: Wave 2 | Blocked by: 1, 2 | Blocks: 4
  References: `docs/specs/technical-architecture.md:40`, `src/sciretriever/acquisition/service.py`, `src/sciretriever/normalization/mineru_service.py`, `src/sciretriever/normalization/mineru_source_map.py`, `src/sciretriever/analysis/service.py`, `src/sciretriever/cli/analyze.py:68`, `src/sciretriever/cli/download.py:162`.
  Acceptance criteria: `uv run --frozen python -m unittest discover -s tests -p 'test_completion_contracts_wp5.py'` covers invalid DOI/UUID, the action truth table (metadata calls metadata only and returns ASSET_PENDING; asset may call metadata+asset and returns ANALYSIS_PENDING; complete may call missing suffix and returns COMPLETE; already-advanced targets are no-ops), batch order/dedup/partial failure/interruption, COMPLETE non-force no-op, COMPLETE force replacement, and optional assets; architecture tests prove stage modules do not import completion, completion does not import CLI, and command modules neither construct stage services independently nor sequence stages directly; Pyright is clean.
  QA scenarios: Happy: instantiate and serialize every typed request/outcome, then drive a three-target batch preserving order. Failure: malformed target, ADVANCED without fact progress, batch interruption and impossible result combinations fail with stable behavior. Evidence `.omo/evidence/wp5/task-3.txt`.
  Commit: deferred until all WP5 verification | `feat(completion): define pipeline contracts`

- [x] 4. Implement `CompletionPipeline`, shared batch runner, force analysis, and optional acquisition
  What to do / Must NOT do: Add failing orchestration tests, then implement the single-target loop: normalize/exact-lookup target, obtain a fresh one-snapshot fact read, invoke exactly the missing required stage up to the requested stop, and obtain a fresh snapshot. Exact DOI starts invocation-local; existing WorkVersion enters from facts. A stage returns ADVANCED or NOT_ADVANCED with redacted reason/action. ADVANCED with unchanged facts is an invariant error; NOT_ADVANCED with unchanged facts is normal controlled exhaustion; any monotonic advancement, including another invocation's advancement, is progress. Required acquisition calls the existing primary-PDF service. Analysis invokes exactly one WP4-owned adapter that performs MinerU parse/source-map and `AnalysisService.run`; completion must never write current analysis, canonical projection, references, or tags. Implement batch behavior from Todo 3; `CompletionPipeline` does not catch KeyboardInterrupt, while batch stops new targets and records the interrupted suffix. Implement force analysis and optional XML/HTML acquisition as separate explicit operations. One invocation-owned CatalogEngine is shared by adapters; no transaction/connection spans provider/filesystem/MinerU/LLM calls. Do not add retries or durable state.
  Parallelization: Wave 2 | Blocked by: 1, 2, 3 | Blocks: 5, 6, 7
  References: `docs/planning/literature-library-execution.md:111`, `docs/specs/system-design.md:126`, `src/sciretriever/catalog/engine.py`, `src/sciretriever/acquisition/service.py`, `src/sciretriever/normalization/mineru_service.py`, `src/sciretriever/analysis/service.py`, `src/sciretriever/catalog/analysis.py:123`.
  Acceptance criteria: `uv run --frozen python -m unittest discover -s tests -p 'test_completion_pipeline_wp5.py'` enters from DOI, persisted metadata, existing WorkVersion, accepted PDF and COMPLETE; asserts exact call sequences/action ceilings; tests NOT_ADVANCED exhaustion, invariant no-progress, restart suffix, KeyboardInterrupt, partial batch failure, force/no-force revision behavior, optional assets, and two-pipeline acquisition/analysis races where owner uniqueness plus fact reread suppress duplicates and accept concurrent progress; no completion state exists.
  QA scenarios: Happy: drive fake stages through all four facts, then run a stable three-target batch twice and assert one call per missing stage. Failure: fail each stage and force promotion once, then rerun; concurrently advance the same target from a second pipeline and assert fresh facts win without false failure. Evidence `.omo/evidence/wp5/task-4.txt`.
  Commit: deferred until all WP5 verification | `feat(completion): orchestrate literature completion`

- [x] 5. Replace search-local chaining and make exact DOI a public pipeline target
  What to do / Must NOT do: Pin current JSON and selector behavior, inventory every current direct sequencer/reference, then delete `_download_args`, `_analysis_args`, the manual chain in `cli/search.py`, and their helper-only tests/imports. In `search QUERY`, parse a syntactically valid DOI query into `DoiTarget` before any metadata persistence and send it directly to the shared batch runner; ordinary non-DOI search may keep query discovery, then pass only this invocation's persisted WorkVersion targets to the same runner. Map CLI metadata->METADATA, download->ASSET, analyze->COMPLETE. Preserve partial provider failures, selected-ID scope, sanitized output and exit 130. Add the closed deletion manifest to test evidence; no wrapper/alias/fallback remains.
  Parallelization: Wave 3 | Blocked by: 4 | Blocks: 7, 8
  References: `src/sciretriever/cli/search.py:142`, `src/sciretriever/cli/search.py:159`, `src/sciretriever/cli/search.py:187`, `tests/test_cli_wp2.py`, `tests/test_cli_download_wp3.py`, `docs/specs/system-design.md:142`.
  Acceptance criteria: `uv run --frozen python -m unittest discover -s tests -p 'test_cli_completion_wp5.py'` proves exact DOI through all three stop points, all-provider/no-exact zero rows, ordinary search exact selected IDs, no catalog reselection, blocked analyze after missing PDF, sanitized per-target output, batch interruption exit 130, and zero retired symbols/imports/calls. JSON assertions name exact stage/count keys and expected exit codes.
  QA scenarios: Happy: `search 10.1234/example` with offline injected providers reaches ASSET_PENDING, ANALYSIS_PENDING and COMPLETE under each requested level. Failure: mismatched DOI and interrupted asset return stable nonzero/130 results, preserve committed facts and never call analysis. Evidence `.omo/evidence/wp5/task-5.txt`.
  Commit: deferred until all WP5 verification | `refactor(cli): route search through completion`

- [x] 6. Replace download, analyze, and local-import parallel completion logic
  What to do / Must NOT do: Inventory and delete `acquisition/backfill.py` and `analysis/backfill.py` batch loops if no stage-local DTO remains necessary, plus superseded `execute_work_versions`, interruption helpers, direct stage construction, imports and helper-only tests in `cli/download.py`/`cli/analyze.py`; relocate only still-required output DTOs, never alias old APIs. Preserve selector repositories. Route download to shared batch ASSET plus explicit optional XML/HTML operation; route analyze to COMPLETE or force_analysis. `ExistingAssetImporter` remains the asset writer; after successful primary-PDF import, call shared completion with an explicit COMPLETE stop when analysis config is available and report the result; if command invocation explicitly chooses an asset-only stop, encode and test that stop rather than merely inspecting. Supplementary/XML/HTML import never advances required completion. Keep validation/storage owners untouched.
  Parallelization: Wave 3 | Blocked by: 4 | Blocks: 7, 8
  References: `src/sciretriever/cli/download.py:145`, `src/sciretriever/cli/download.py:162`, `src/sciretriever/cli/analyze.py:55`, `src/sciretriever/cli/analyze.py:68`, `src/sciretriever/cli/catalog.py:62`, `src/sciretriever/acquisition/existing_asset.py:84`, `tests/test_cli_download_wp3.py`, `tests/test_analysis_wp45.py`, `tests/test_p9_acceptance.py`.
  Acceptance criteria: `uv run --frozen python -m unittest discover -s tests -p 'test_cli_completion_backfill_wp5.py'` covers every selector, stable batch order/dedup/partial failure/exit 130, asset and COMPLETE stop, COMPLETE no-force no-op, force revision replacement and failed-force old-current preservation, optional XML/HTML stage invariance, primary-PDF import shared-service invocation/replay, and invalid import zero side effects; repository-wide assertions prove the deletion manifest absent; WP3/WP4 storage/security regressions pass.
  QA scenarios: Happy: select two versions, download required/optional assets, analyze, force reanalyze, and import primary PDF twice; assert exact stages/revisions/hashes. Failure: XML-only, malformed/symlink import, interrupted batch and failed force keep exact previous facts. Evidence `.omo/evidence/wp5/task-6.txt`.
  Commit: deferred until all WP5 verification | `refactor(cli): unify completion entry points`

- [x] 7. Add offline WP5 acceptance and architecture enforcement
  What to do / Must NOT do: Build one real temporary SQLite/storage acceptance fixture that enters the pipeline from DOI, provider metadata, existing WorkVersion, accepted primary PDF, and already complete analysis. Exercise failure/restart/concurrent invocation at every stage and verify exact row/hash/current-revision counts. Add failpoints before each sub-write inside the existing WP4 atomic promotion transaction and assert the previous current result plus generated metadata/references/tags/canonical fields remain byte-for-byte unchanged after rollback; completion still invokes only that one owner API. Extend architecture harness so discovery/acquisition/normalization/analysis/catalog cannot import completion, command modules cannot sequence stages, and completion cannot import CLI. Assert the closed deletion manifests from Todos 5-6 across source/tests/docs and built wheel. Delete superseded helper tests only after equivalent behavior exists; never weaken assertions.
  Parallelization: Wave 4 | Blocked by: 5, 6 | Blocks: 8
  References: `tests/test_discovery_acceptance.py`, `tests/test_download_wp3.py`, `tests/test_analysis_wp44.py`, `tests/test_analysis_wp45.py`, `tests/test_p9_acceptance.py`, `scripts/harness.py:55`, `docs/planning/literature-library-execution.md:122`.
  Acceptance criteria: `uv run --frozen python -m unittest discover -s tests -p 'test_completion_wp5.py'` proves all approved entry paths, exact empty/nonempty promotion, strict convergence, manual > generated > provider, every promotion rollback failpoint, idempotent restart, valid-but-missing UUID, partial batch failure and two-pipeline races; architecture direct tests detect forbidden imports/sequencing; repository/wheel absence assertions pass; affected WP1-WP4 regressions pass.
  QA scenarios: Happy: run the acceptance scenario twice and compare stable IDs/hashes/counts with no duplicate facts. Failure: inject each stage failure and assert derived stage plus successful missing-suffix replay. Evidence `.omo/evidence/wp5/task-7.txt`.
  Commit: deferred until all WP5 verification | `test(completion): cover WP5 acceptance`

- [x] 8. Publish completed WP5 documentation and run all release gates
  What to do / Must NOT do: Update README/current workflow, AGENTS project map for the completion package, code-doc map, and implementation progress from approved/not-started to completed with exact current evidence. The fixed requirements/system design/technical architecture are acceptance inputs and must not be weakened or rewritten to fit implementation; any mismatch fails this todo and is fixed in code. Remove stale current-state statements that CLI owns cross-stage orchestration or WP5 is pending. Run targeted suites, quick/docs/architecture/full harness, Pyright, clean wheel build/content and deleted-module checks, and code-size/no-suppression review. Do not modify dependencies or lockfile.
  Parallelization: Wave 4 | Blocked by: 7 | Blocks: F1, F2
  References: `AGENTS.md:58`, `README.md:46`, `docs/governance/code-doc-map.md`, `docs/governance/implementation-progress.md`, `scripts/harness.py`, `HARNESS.md:88`.
  Acceptance criteria: capture baseline `GIT_MASTER=1 git status --short`; `uv run --frozen python scripts/harness.py full` passes; docs and architecture gates pass; Pyright reports zero diagnostics; wheel contains every live completion module and no retired module/symbol; `GIT_MASTER=1 git diff --check` passes; diff contains no dependency/lockfile or new unrelated change. Pre-existing user documentation modifications are preserved and included only where they are the approved WP5 baseline.
  QA scenarios: Use Bash in a temporary directory and append every literal command, stdout, stderr and exit code to `.omo/evidence/wp5/manual-qa.txt`: (1) `TMP=$(mktemp -d /tmp/sciretriever-wp5-XXXXXX)` and `mkdir "$TMP/storage"`; (2) `uv run --frozen sciretriever --version` must exit 0 and print `0.1.0`; (3) `uv run --frozen sciretriever catalog create --catalog "$TMP/catalog.sqlite"` must exit 0 and include `disposition=created`; (4) `WV=$(uv run --frozen python -c 'import sys; from sciretriever.catalog import WorkRepository, open_catalog_engine; engine=open_catalog_engine(sys.argv[1]); version=WorkRepository(engine).ingest_version(provider="fixture", provider_record_id="fixture-1", title="WP5 Fixture", doi="10.1234/wp5"); print(version.id); engine.dispose()' "$TMP/catalog.sqlite")`; require a UUID-shaped `WV`; (5) `uv run --frozen python -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(*(c.execute(f"SELECT count(*) FROM {t}").fetchone()[0] for t in ("works","work_versions","metadata_observations","provider_canonical_projections")))' "$TMP/catalog.sqlite"` must print `1 1 2 2`; (6) `uv run --frozen python -c 'import sys; from pathlib import Path; Path(sys.argv[1]).write_bytes(b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n")' "$TMP/input.pdf"`; (7) run `uv run --frozen sciretriever catalog import-asset --catalog "$TMP/catalog.sqlite" --storage-root "$TMP/storage" --asset "$TMP/input.pdf" --asset-role primary_pdf --work-version-id "$WV"` twice; both must exit 0, first include `disposition=imported stage=ANALYSIS_PENDING`, second include `disposition=replayed stage=ANALYSIS_PENDING`, and parsed `raw_asset_id`/`sha256` must match; (8) `uv run --frozen python -c 'import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute("SELECT count(*) FROM raw_assets").fetchone()[0],c.execute("SELECT count(*) FROM work_version_assets WHERE asset_role=\"primary_pdf\"").fetchone()[0],c.execute("SELECT count(*) FROM current_analyses").fetchone()[0])' "$TMP/catalog.sqlite"` must print `1 1 0`; (9) `uv run --frozen sciretriever library show --catalog "$TMP/catalog.sqlite" --work-version-id "$WV" --format json` must exit 0 and JSON must contain exactly one item with DOI `10.1234/wp5` and the same WorkVersion ID; (10) `uv run --frozen python -m unittest discover -s tests -p 'test_completion_wp5.py'` is the exact offline wire-fake DOI-to-COMPLETE subprocess/integration channel and must exit 0 without network; (11) run `uv run --frozen sciretriever download --catalog "$TMP/catalog.sqlite" --storage-root "$TMP/storage"`; it must exit 2 because no selector was supplied and row counts `1 1 1` for work_versions/raw_assets/primary links remain unchanged; (12) `ln -s "$TMP/input.pdf" "$TMP/link.pdf"`, then run the same `catalog import-asset` command with `--asset "$TMP/link.pdf"`; it must exit 1 and raw_assets/primary-links/current counts remain `1 1 0`; (13) `rm -rf "$TMP"` and `test ! -e "$TMP"` must exit 0. The real manual channel stops imported primary PDF at the explicit ASSET ceiling because external MinerU/LLM calls are forbidden; complete behavior is proven by step 10. Evidence `.omo/evidence/wp5/manual-qa.txt`.
  QA correction (2026-07-25): The first literal release run proved two fixture defects without changing product contracts. In step 5, require `1 1 2 1`: DOI is persisted as stable identity plus observation, while only the title is a provider canonical projection. In step 6, generate a valid two-page PDF with PyPDF2 and long metadata, following the existing acceptance fixture, instead of the 49-byte byte string rejected by the minimum-size/structure/preview security gates. Step 9's DOI safe-view assertion remains mandatory and is a product acceptance requirement.
  Commit: deferred until F1/F2 approve | documentation included in final atomic commit sequence.

## Final verification wave
> Runs in parallel after ALL todos. Both must APPROVE. The two-reviewer hard limit overrides wider default fan-out.
- [x] F1. Goal, architecture, and code-quality audit: independent reviewer checks every WP5 acceptance clause, dependency direction, deletion of parallel/compatibility paths, strict types, transactions, interruption, and tests against the actual diff and commands.
- [x] F2. Hands-on QA and security audit: independent reviewer runs targeted and full gates, drives the CLI manual-QA scenario, inspects generated evidence, probes dirty-worktree/stale-state/misleading-success/interruption classes, and confirms cleanup.

## Commit strategy
- No commit before Todos 1-8 and F1-F2 are complete.
- Inspect `GIT_MASTER=1 git status`, unstaged/staged diffs, recent style, upstream, and exact file groups.
- Create multiple English Conventional Commits only after verification, pairing implementation with direct tests and ordering foundations before entry-point/documentation changes.
- Planned groups: catalog facts; exact metadata resolution; completion contracts/orchestration; CLI cutover plus direct tests; acceptance/harness/docs. Adjust final count to satisfy actual changed-file atomicity; do not amend, push, or rewrite history.
- After each commit, verify staged paths and at the end require no uncommitted WP5-owned change; preserve any pre-existing unrelated user change instead of forcing global cleanliness. Report hashes.

## Success criteria
- A normalized DOI can drive the whole pipeline without a pre-created row; failed exact metadata resolution creates no placeholder.
- All write entry points share one application completion contract and no removed parallel/compatibility path remains.
- Every WorkVersion stage is derived from authoritative facts; no mutable completion state exists.
- `COMPLETE` requires accepted primary PDF plus aligned current analysis, canonical metadata, references, generated tags, and PDF evidence.
- Failure/interruption preserves the derived stage; rerun executes only the missing suffix and is idempotent.
- WP1-WP4 regressions, targeted WP5 tests, Pyright, docs/architecture/quick/full harness, wheel, and manual CLI QA all pass offline.
- Two independent final reviewers approve; all QA artifacts are cleaned except bounded `.omo/evidence` receipts.
- WP5 is represented by atomic local commits created only after all work passed; no push occurs.
