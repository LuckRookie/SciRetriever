# unified-candidate-retrieval - Work Plan

## TL;DR (For humans)
**What you'll get:** `discover` and `search` will use one deterministic candidate-retrieval truth. `discover` will remain a read-only manifest export, while `search` commits those same candidates to the local catalog and can continue the existing download/analysis flow.

**Why this approach:** The catalog-writing path already preserves the strongest identity and provenance evidence, so its DOI-safe, precedence-aware semantics become authoritative. Both outputs consume the same immutable pre-sink candidates instead of maintaining two matching algorithms.

**What it will NOT do:** It will not make manifests importable, add a staging database/schema, remove either command, add provider-specific advanced filters, or change acquisition/analysis behavior.

**Effort:** Medium
**Risk:** Medium - discover's historical hard-coded merge/order behavior intentionally changes to the safer shared semantics, so parity, atomicity, and completion-prefix tests are load-bearing.
**Decisions to sanity-check:** Partial provider failure publishes successful discover candidates with a sanitized warning; all-provider failure preserves prior output. Search gains the same year range filters already supported by discover.

Your next move: start work with the approved plan, or request a high-accuracy plan review first. Full execution detail follows below.

---

> TL;DR (machine): Medium effort/risk; one observation-preserving candidate pipeline, read-only manifest sink, atomic catalog sink, year-filter parity, exact DOI preservation, no schema/import scope.

## Scope
### Must have
- One catalog-neutral typed candidate retrieval request/result used by ordinary `discover` and `search`.
- One precedence-aware identity grouping, canonical projection, stable ordering, post-merge limit, and sanitized provider-failure implementation.
- Every candidate preserves all normalized provider observations, provider record IDs, ranks, publisher/publication-date/OA fields, safe identifiers, providers, source ranks, and identity-quality reasons.
- Search-authoritative identity safety: distinct non-empty DOI values never auto-merge; ambiguous bridge identifiers remain evidence but are excluded from safe identifiers; exact normalized-title is the only title fallback.
- The manifest sink remains read-only with compare-all-before-labeling and atomic publication; the catalog sink remains atomic and produces Work/WorkVersion/MetadataObservation facts.
- `search` accepts the same `year_from`/`year_to` remote filters as `discover`; provider-specific filters remain unsupported and fail closed.
- Existing `discover` and `search` command names, their TOML sections, exact DOI behavior, completion ordering, and independent metadata/acquisition/analysis topology remain intact.
- Partial provider failures produce candidates plus sorted sanitized failures; all-provider failure produces no candidate/catalog-metadata or manifest mutation, while catalog-writing search preserves its existing single sanitized diagnostic record.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No manifest import, CandidateSet staging protocol, new serialization version, manifest schema change, or temporary/durable retrieval state.
- No catalog schema/model/migration change and no changes to completion, acquisition, analysis, RawAsset, or DocumentPackage ownership.
- No provider-specific query language, subject-area/document-type filter, fuzzy/LLM matching, new provider, or pagination-to-fill-global-limit behavior.
- No second active command path for identity matching/canonical selection; legacy public helpers may remain only as thin projections over the shared matcher.
- No catalog, labeling, CLI, or filesystem dependency inside the shared retrieval core.
- No provider calls in tests, dependency upgrades, lockfile changes, credential reads, or edits to unrelated `config.toml` values.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD with the repository's standard-library `unittest`; every production change begins with a focused failing behavior test, then GREEN, then refactor.
- Test layers: pure candidate/matching unit tests; fake-provider collection and real temporary SQLite integration tests; CLI acceptance for manifest/catalog sinks, partial/all failure, filters, and completion-prefix stability.
- Determinism: use fake providers, barriers/events rather than sleeps, temporary SQLite/catalog/output paths, and fixed timestamps/UUIDs. Never contact real providers or user catalogs.
- Static/build gates: `lsp_diagnostics` on every changed Python file, `uv run --frozen pyright src/sciretriever tests scripts`, targeted unittest files, then `uv run --frozen python scripts/harness.py full`.
- Evidence: <attemptDir>/task-<N>-unified-candidate-retrieval.<ext> (attemptDir = currentAttemptDir from 'omo ulw-loop status --json', .omo/evidence/ulw/<session>/<goalId>/a<attempt>; outside ulw-loop use .omo/evidence/)

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Wave 1: shared candidate contract/matcher, full SearchSpec collection, and search CLI/config filter boundary can proceed in parallel after each RED fixture is isolated.
- Wave 2: migrate catalog sink, manifest sink, and exact/legacy consumers over the Wave 1 contracts.
- Wave 3: cross-sink acceptance plus current/ideal documentation synchronization.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 4, 5, 6, 7 | 2, 3 |
| 2 | none | 4, 5, 6, 7 | 1, 3 |
| 3 | none | 4, 7, 8 | 1, 2 |
| 4 | 1, 2, 3 | 6, 7, 8 | 5 |
| 5 | 1, 2 | 6, 7, 8 | 4 |
| 6 | 1, 2, 4, 5 | 7, 8 | none |
| 7 | 1-6 | 8, F1-F4 | none |
| 8 | 3-7 | F1-F4 | none |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Define the one immutable pre-sink candidate contract and authoritative matching semantics
  What to do / Must NOT do: RED first in a new focused `tests/test_candidate_retrieval.py`, then introduce catalog-neutral frozen types for a retrieval request, normalized observation-rich candidate, and retrieval result. Move/reshape search's normalization, ambiguity detection, grouping, canonical field selection, safe identifiers, precedence-ordered providers/source ranks, stable group ordering, and post-merge limit behind one pure candidate preparer. Preserve every observation and extended field; do not base shared candidates on `Candidate`/`MergedCandidate`, `set()` observations, or import catalog types. Exclude title-less groups from bulk candidates. Encode intentional discover migration: distinct DOI values never merge, ambiguous bridge IDs remain observations only, all fields use request precedence, and quality flags are separate from identity ambiguity.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 4, 5, 6, 7
  References (executor has NO interview context - be exhaustive): `src/sciretriever/discovery/search_records.py:15-124`; `src/sciretriever/discovery/metadata_preparation.py:27-137`; `src/sciretriever/discovery/search_matching.py:16-175`; `src/sciretriever/discovery/models.py:10-133`; `src/sciretriever/discovery/dedup.py:14-246`; `src/sciretriever/catalog/library.py` (`MetadataIngestionBatch` is a sink projection, not a core dependency); `docs/architecture/system-design.md:105-130`; `tests/test_search_wp2.py:152-188,313-443,572-668`.
  Acceptance criteria (agent-executable): a fixture with Crossref DOI `10.1234/shared`/record `CR-1`, Europe PMC same DOI+PMID `42`, and arXiv failure produces one candidate with precedence-selected title, fallback abstract, both observations and one sanitized failure. A DOI bridge fixture has one DOI-bearing observation for `10.1234/a` and one for `10.1234/b`, both carrying the same bridge identifier; it produces two candidates, each observation remains naturally owned by its DOI candidate, and the ambiguous bridge identifier is absent from both safe identifier sets. Provider-map, record, and completion-order permutations produce byte-for-byte equal candidate value objects. A separate title-less group is omitted without aborting valid groups. Run `uv run --frozen python -m unittest discover -s tests -p 'test_candidate_retrieval.py'`.
  QA scenarios (name the exact tool + invocation): happy: run the focused unittest with permutations and inspect candidate objects; failure: temporarily route two DOI groups through one bridge and confirm the RED assertion distinguishes unsafe merge before GREEN. Evidence `<attemptDir>/task-1-unified-candidate-retrieval.txt`.
  Commit: N | If later authorized: `refactor(discovery): define shared retrieved candidates`

- [x] 2. Make provider collection consume the complete shared request and own sanitized failure semantics
  What to do / Must NOT do: RED first around `ProviderCollector`, then replace its query/providers/limit argument reconstruction with the shared request's complete `SearchSpec` data, precedence, provider timeout, and concurrency. Each provider receives a single-source `SearchSpec` retaining identical filters. Keep bounded concurrency, independent deadlines measured from collection start, stable record ordering, provider ownership checks, and sorted sanitized failures. The collector/retriever returns partial results and never writes diagnostics or sink state; all-provider failure is represented explicitly, not inferred from zero records. Do not add retries, sleeps, provider-specific filter routing, or change queued-provider deadline behavior.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 4, 5, 6, 7
  References (executor has NO interview context - be exhaustive): `src/sciretriever/core/contracts.py:230-279`; `src/sciretriever/discovery/provider_collection.py:20-125`; `src/sciretriever/discovery/providers/_common.py:18-49`; `src/sciretriever/discovery/providers/base.py:8-19`; `tests/test_search_wp2.py:142-235`; `tests/test_failure_owners_wp6.py:95-155`; `tests/test_discovery_pipeline.py:133-152`.
  Acceptance criteria (agent-executable): fake providers start concurrently; each receives only its own source plus unchanged `year_from/year_to`; queued and running calls share the existing finite deadline; partial failure, all failure, and failed+successful-empty are three distinct results; failure text contains only provider/category/stable public message. Run focused candidate tests plus `uv run --frozen python -m unittest discover -s tests -p 'test_search_wp2.py'` and `... -p 'test_failure_owners_wp6.py'`.
  QA scenarios (name the exact tool + invocation): happy: barriers prove two providers overlap while retaining filters; failure: one fake raises a secret-bearing exception and output contains no secret, while all-failed is explicitly true. Evidence `<attemptDir>/task-2-unified-candidate-retrieval.txt`.
  Commit: N | If later authorized: `refactor(discovery): collect one shared search request`

- [x] 3. Add year-filter parity to the catalog-writing search boundary without changing discovery flags
  What to do / Must NOT do: RED CLI/TOML tests, then extend the typed `MetadataSearchRequest`, `MetadataCliConfig`, `SearchConfig`, strict TOML parser/composition, and `search` parser with repeatable `--filter year_from=YEAR|year_to=YEAR`, using the existing `discover` parsing and validation semantics. Preserve existing `discover --source/--timeout` and `search --provider/--precedence/--provider-timeout` names and sections. Reject duplicate, unknown, nonnumeric, out-of-range, or reversed years before constructing providers. Exact DOI keeps empty filters. Do not add `[discovery].precedence`, discovery max-concurrency flags, provider-specific filters, or rename existing keys.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 4, 7, 8
  References (executor has NO interview context - be exhaustive): `src/sciretriever/cli/discover.py:43-88,115-173,220-225`; `src/sciretriever/cli/search.py:37-120,180-214`; `src/sciretriever/cli/metadata_runtime.py:40-78`; `src/sciretriever/config_models.py:49-58`; `src/sciretriever/config_parsing/base.py:116-160`; `src/sciretriever/cli/config_composition.py:104-139`; `tests/test_cli_wp2.py:4-68`; `tests/test_toml_config.py`; `docs/guides/config.toml` and `docs/guides/config.minimal.toml` responsibilities.
  Acceptance criteria (agent-executable): CLI and TOML `year_from=2020/year_to=2025` reach the shared request unchanged; defaults remain empty; exact DOI receives no filters; invalid/repeated/reversed filters fail before provider construction. Existing metadata/completion limits remain 1000/100. Run `uv run --frozen python -m unittest discover -s tests -p 'test_cli_wp2.py'` and `... -p 'test_toml_config.py'`.
  QA scenarios (name the exact tool + invocation): happy: parse `search query --filter year_from=2020 --filter year_to=2025` and assert typed request filters; failure: `year_from=2026/year_to=2025` exits through argparse/config boundary with zero fake provider calls. Evidence `<attemptDir>/task-3-unified-candidate-retrieval.txt`.
  Commit: N | If later authorized: `feat(search): support shared year filters`

- [x] 4. Migrate ordinary search to the shared candidate pipeline while preserving atomic catalog behavior
  What to do / Must NOT do: RED sink tests, then make `MetadataSearchService.search()` retrieve one candidate tuple and project it to `MetadataIngestionBatch` for the existing `MetadataIngestor`. Preserve one atomic batch transaction, all provider observations and stable/synthetic provider record IDs, prior-catalog fill-missing behavior in post-ingest CLI results, all-failed diagnostic ownership, partial-failure behavior, result order, and completion-limit prefix selection. Candidate parity assertions must compare pre-sink candidate tuples, not manifest JSON with post-ingest catalog projections. Do not make search depend on manifest, labeling, or read-only catalog view.
  Parallelization: Wave 2 | Blocked by: 1, 2, 3 | Blocks: 6, 7, 8 | Can parallelize with: 5
  References (executor has NO interview context - be exhaustive): `src/sciretriever/discovery/search.py:32-70`; `src/sciretriever/discovery/metadata_ingestion.py:17-47`; `src/sciretriever/catalog/library.py` metadata ingestion methods; `src/sciretriever/cli/search.py:180-252`; `src/sciretriever/cli/search_completion_runtime.py:40-53`; `tests/test_search_wp2.py:142-718`; `tests/test_cli_wp2.py:70-160`; `tests/test_cli_completion_wp5.py`; `tests/test_exact_metadata_wp5.py` ordinary/exact separation.
  Acceptance criteria (agent-executable): existing search tests remain green; partial failure ingests successful candidates and returns sanitized failures; all failure writes zero Work/WorkVersion/observation rows and one existing diagnostic; one ingestion failure rolls back the entire candidate batch; historical observations may affect post-ingest canonical output but do not mutate the captured pre-sink candidate tuple; completion targets remain the first deterministic `completion_limit` search results. Run search, CLI, completion, and failure-owner targeted suites.
  QA scenarios (name the exact tool + invocation): happy: real temporary SQLite receives two candidates and all observations in shared order, then a repeat is idempotent; failure: inject a second-batch catalog conflict and assert zero partial rows plus stable CLI exit 1. Evidence `<attemptDir>/task-4-unified-candidate-retrieval.txt`.
  Commit: N | If later authorized: `refactor(search): ingest shared retrieved candidates`

- [x] 5. Migrate discover to the shared candidates while preserving its read-only manifest sink
  What to do / Must NOT do: RED discover parity/failure tests, then replace sequential provider collection and independent deduplication in `discovery.pipeline.discover` with the shared retriever. Map the first occurrence of existing `SearchSpec.sources` to an effective precedence that is independent of provider-map and response completion order. Project candidates to the existing `MergedCandidate`/labeling boundary or a narrower compatible projection, preserving compare-all-before-labeling, catalog label reuse, review reasons, lexical manifest provenance order, fixed run/time provenance, and atomic JSONL replacement. Partial success publishes candidates and reports sorted sanitized warnings at the CLI boundary; all-provider failure, catalog comparison failure, or label failure preserves existing manifest bytes. Do not write catalog facts/diagnostics or change `DownloadManifestEntry` serialization.
  Parallelization: Wave 2 | Blocked by: 1, 2 | Blocks: 6, 7, 8 | Can parallelize with: 4
  References (executor has NO interview context - be exhaustive): `src/sciretriever/discovery/pipeline.py:21-131`; `src/sciretriever/discovery/manifest.py:18-83`; `src/sciretriever/discovery/labeling.py:126-265`; `src/sciretriever/cli/discover.py:115-208,215-260`; `src/sciretriever/core/contracts.py:145-227`; `tests/test_discovery_pipeline.py:101-323`; `tests/test_discovery_acceptance.py:228-447`.
  Acceptance criteria (agent-executable): discover and search capture the same pre-sink candidate tuple for identical shared request/provider responses; manifest remains byte-deterministic across provider-map/record/completion permutations; compare-all occurs before any label call; partial provider failure publishes successful candidates with exit 0 and a sanitized sorted warning; all failure and downstream sink errors preserve preexisting bytes and exit 1; catalog row counts remain unchanged. Run discovery pipeline and acceptance tests twice consecutively.
  QA scenarios (name the exact tool + invocation): happy: fake Crossref+Europe PMC candidates plus failed arXiv generate a manifest from the shared tuple and no catalog mutation; failure: all providers fail with secret-bearing messages, existing manifest bytes remain exact, and stderr exposes no secret. Evidence `<attemptDir>/task-5-unified-candidate-retrieval.txt`.
  Commit: N | If later authorized: `refactor(discover): export shared retrieved candidates`

- [x] 6. Keep exact DOI specialized and retire the second active matching implementation safely
  What to do / Must NOT do: After both ordinary sinks are green, migrate `ExactMetadataResolver` to shared provider collection/normalization/failure DTOs while retaining exact DOI-only selection, default provider fetch limit, canonical-title requirement, independent all-failed return policy, and no title fallback. Inspect all callers/exports of `deduplicate_candidates`, `merge_candidates`, `Candidate`, `MergedCandidate`, `ProviderCollector`, and `MetadataRecordPreparer`; remove command-path use of the old matcher. Preserve public Python symbols as thin adapters over the shared matcher where possible, with tests documenting search-authoritative semantics; only delete an export if all indexed callers are internal tests and pre-v1 policy permits it without breaking current README/API claims. Do not leave two independently evolving identity algorithms.
  Parallelization: Wave 2 | Blocked by: 1, 2, 4, 5 | Blocks: 7, 8
  References (executor has NO interview context - be exhaustive): `src/sciretriever/discovery/search.py:73-106`; `src/sciretriever/discovery/metadata_preparation.py:61-82`; `src/sciretriever/discovery/__init__.py:1-104`; `src/sciretriever/discovery/dedup.py:192-249`; `tests/test_exact_metadata_wp5.py`; `tests/test_discovery_transport.py` public export assertions; ADR 0002 pre-v1 compatibility decision at `docs/architecture/decisions/0002-work-centered-literature-library.md:25,32`.
  Acceptance criteria (agent-executable): exact DOI only ingests records carrying the normalized requested DOI, remains unresolved without title, never uses ordinary title matching/limit, and preserves its existing all-failed output; CodeGraph/LSP references show no ordinary command path invokes the legacy matcher; public export tests are intentionally updated without compatibility shims. Run `test_exact_metadata_wp5.py`, `test_discovery_transport.py`, and all candidate/discovery/search focused suites.
  QA scenarios (name the exact tool + invocation): happy: two providers return the exact DOI and one unrelated title match; only exact observations are ingested; failure: all providers fail or exact records lack title and catalog stays unchanged with the existing result contract. Evidence `<attemptDir>/task-6-unified-candidate-retrieval.txt`.
  Commit: N | If later authorized: `refactor(discovery): converge exact and legacy consumers`

- [x] 7. Prove both sinks share one candidate truth with real temporary catalog and atomic output
  What to do / Must NOT do: Add one offline acceptance scenario using fake wire/provider responses, real temporary SQLite, real read-only/writable catalog views, and a temporary manifest path. Capture the immutable candidate tuple once and feed both sinks; assert same identities/order/canonical batch metadata, complete observations, divergent sink effects only, idempotent catalog rerun, read-only manifest behavior, and preserved output on failure. Include year filters, partial failure, DOI bridge conflict, title-less observation, prior catalog observation, and `completion_limit` prefix in separate deterministic cases. Do not compare post-ingest catalog projection to manifest as the parity proof and do not contact network.
  Parallelization: Wave 3 | Blocked by: 1-6 | Blocks: 8, F1-F4
  References (executor has NO interview context - be exhaustive): `tests/test_discovery_acceptance.py`; `tests/test_search_wp2.py`; `tests/test_cli_wp2.py`; `tests/test_discovery_pipeline.py`; `tests/test_completion_acceptance_fixture.py`; `src/sciretriever/catalog/engine.py`; `src/sciretriever/discovery/manifest.py`; `src/sciretriever/discovery/metadata_ingestion.py`.
  Acceptance criteria (agent-executable): new acceptance file passes three consecutive isolated runs; the same captured candidates drive both sinks; manifest causes zero catalog writes; catalog sink preserves every observation and is idempotent; partial/all failures and atomic rollback have observable correct effects; no second workflow state/table/file is created. Then `uv run --frozen python scripts/harness.py quick` passes.
  QA scenarios (name the exact tool + invocation): happy: invoke both sink services against one fixture and inspect manifest + catalog via public readers; failure: force all-provider failure and catalog/label sink errors, asserting preexisting manifest and catalog facts remain unchanged. Evidence `<attemptDir>/task-7-unified-candidate-retrieval.txt`.
  Commit: N | If later authorized: `test(discovery): prove shared candidate sinks`

- [x] 8. Synchronize current CLI guidance and ideal candidate/sink ownership
  What to do / Must NOT do: Update README, user manual, configuration guide, requirements, system design, technical architecture, AGENTS summary only where responsibility text changes, and CLI help. Explain one candidate retrieval pipeline, `discover` as read-only manifest projection, `search` as catalog commit, shared query/year/provider semantics, search precedence, discover source-order effective precedence, partial/all failure behavior, and current manifest's non-importable status. Keep requirements/system/technical docs ideal rather than progress logs. Do not modify ADR 0002 unless a genuine contradiction appears, claim staging import, merge `[discovery]`/`[search]`, or document provider-specific filters.
  Parallelization: Wave 3 | Blocked by: 3-7 | Blocks: F1-F4
  References (executor has NO interview context - be exhaustive): `README.md`; `docs/guides/user-manual.md`; `docs/guides/configuration.md`; `docs/guides/config.toml`; `docs/guides/config.minimal.toml`; `docs/architecture/requirements.md`; `docs/architecture/system-design.md`; `docs/architecture/technical-architecture.md`; `AGENTS.md`; `docs/development/documentation-map.md:5-30`; `scripts/documentation_checks.py`.
  Acceptance criteria (agent-executable): CLI help, strict TOML accepted keys, README, user manual, templates, and architecture agree on two sinks over one candidate truth and on year filters/failures; no document says manifest can be imported or that discover writes catalog. `uv run --frozen python scripts/harness.py docs` and `... architecture` pass with relevant CLI/config tests.
  QA scenarios (name the exact tool + invocation): happy: follow documented discover and search examples against offline fixtures and observe only the selected sink effect; failure: run `uv run --frozen python scripts/harness.py docs`, `... architecture`, then explicitly audit `git diff -- README.md docs AGENTS.md` against the Scope/Must-NOT list and reject any second-matcher, staging/import, unsupported-filter, or current-vs-ideal claim. Do not add a generalized semantic documentation checker. Evidence `<attemptDir>/task-8-unified-candidate-retrieval.txt`.
  Commit: N | If later authorized: `docs(discovery): explain shared candidate sinks`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [x] F1. Plan compliance audit
  Verify every Must have/Must NOT have against the final diff and evidence ledger. Inspect task-related paths only, confirm one active ordinary matching pipeline and two sink projections, and reject manifest/schema/import/provider-filter scope creep. Run `git diff --check` and targeted CodeGraph/LSP impact checks. Evidence `<attemptDir>/final-F1-plan-compliance.txt`.
- [x] F2. Code quality review
  Run diagnostics on every changed Python file, the programming skill no-excuse audit if available, `uv run --frozen pyright src/sciretriever tests scripts`, all targeted tests from Todos 1-7, and `uv run --frozen python scripts/harness.py full`. Reject type suppressions, observation loss, duplicate matching implementations, oversized new modules, broad compatibility layers, or stale tests weakened to fit the refactor. Evidence `<attemptDir>/final-F2-quality.txt`.
- [x] F3. Real manual QA
  Through the CLI surface with fake/offline providers and system-temporary catalog/output, run `discover --help`, `search --help`, a year-bounded read-only manifest export, a year-bounded catalog search, partial failure, and all failure. Observe identical candidate identity/order before sinks, zero discover catalog mutation, search persistence, warning/error redaction, and atomic output preservation. Never use real credentials/providers/user catalog. Evidence `<attemptDir>/final-F3-cli-qa.txt`.
- [x] F4. Scope fidelity
  Re-read the approved draft, ADR 0002, requirements, system design, and documentation map. Confirm Work-centered ownership, independent stages, no manifest import/staging/schema, no provider-specific filters, and truthful current-vs-ideal docs. Run docs and architecture harness modes. Evidence `<attemptDir>/final-F4-scope.txt`.

## Commit strategy
- The user has not authorized commits. Leave all changes unstaged and uncommitted; do not commit, amend, rebase, push, or create a PR.
- If authorization is later granted, use the per-todo Conventional Commit suggestions and keep implementation/tests/responsibility docs atomic.

## Success criteria
- Ordinary `discover` and `search` invoke one shared typed retrieval/matching implementation and receive the same immutable pre-sink candidate tuple for the same request/provider responses.
- Shared candidates preserve all normalized observations and safe identity provenance; distinct DOI values cannot be bridged into one Work candidate.
- Manifest remains read-only/atomic/non-importable; catalog ingestion remains atomic/idempotent and feeds existing completion stages unchanged.
- Search and discover both apply validated year ranges to every selected provider; unsupported filters fail before provider calls.
- Partial and all-provider failures have deterministic sanitized sink behavior with no unintended writes.
- Exact DOI semantics remain unchanged and no ordinary command path uses the legacy matcher.
- Changed files have clean diagnostics, targeted tests pass, full harness passes, docs/architecture gates pass, and offline CLI manual QA observes the requested behavior.
