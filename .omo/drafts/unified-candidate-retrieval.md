---
slug: unified-candidate-retrieval
status: reviewed-approved
intent: clear
review_required: true
pending-action: execute .omo/plans/unified-candidate-retrieval.md in a separate start-work phase
approach: Replace the two independent normalize/deduplicate/merge paths with one provider-neutral candidate retrieval service whose immutable prepared candidates feed either the existing read-only manifest projection or catalog ingestion; retain exact DOI resolution as a specialized consumer and preserve both CLI names unless the owner chooses a public-surface expansion.
---

# Draft: unified-candidate-retrieval

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
candidate-core | one concurrent provider collection and one precedence-aware normalize/match/merge result shared by all metadata sinks | active | src/sciretriever/discovery/provider_collection.py; src/sciretriever/discovery/metadata_preparation.py
manifest-sink | project shared prepared candidates through catalog comparison/labeling into the existing atomic DownloadManifest | active | src/sciretriever/discovery/pipeline.py; src/sciretriever/discovery/manifest.py
catalog-sink | ingest the exact same prepared candidates as Work/WorkVersion/MetadataObservation facts | active | src/sciretriever/discovery/search.py; src/sciretriever/discovery/metadata_ingestion.py
cli-docs | keep discover/search intent explicit while aligning filters, precedence, failures, docs, and QA | active | src/sciretriever/cli/discover.py; src/sciretriever/cli/search.py; README.md

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->
test strategy | TDD: add cross-sink parity and failure-isolation tests before refactoring | repository mandates RED/GREEN and has real temporary-catalog acceptance fixtures | yes
authoritative semantics | use search's observation-preserving, explicit-precedence matching rather than discover's hard-coded field order | catalog ingestion requires provenance-rich observations and search already guards DOI bridge ambiguity | no within this work
exact DOI | retain the existing specialized ExactMetadataResolver but reuse shared collection/preparation primitives where semantics match | exact lookup has one-target behavior distinct from bulk candidate retrieval | yes
provider execution | adopt concurrent bounded collection and partial-provider failure isolation for both sinks | current search behavior is safer and already tested; sequential discover is duplicated behavior | yes

## Findings (cited - path:lines)
- `discover` currently performs sequential provider calls, then `normalize_records` + `deduplicate_candidates`, a hard-coded provider field order, catalog comparison, labels, and manifest projection (`src/sciretriever/discovery/pipeline.py:21-131`; `src/sciretriever/discovery/dedup.py:14-19`).
- `search` independently uses bounded concurrent `ProviderCollector`, `MetadataRecordPreparer`, explicit precedence, and immediate ingestion (`src/sciretriever/discovery/search.py:32-70`; `src/sciretriever/discovery/metadata_preparation.py:34-137`).
- The two matching algorithms differ materially: `deduplicate_candidates` merges identifier components/title groups, while `merge_groups` explicitly prevents conflicting DOI bridges (`src/sciretriever/discovery/dedup.py:192-246`; `src/sciretriever/discovery/search_matching.py:16-175`).
- `discover` passes `SearchSpec.filters`, including `year_from/year_to`; catalog-writing `MetadataSearchRequest` has no filters and `ProviderCollector._run` currently creates a filterless SearchSpec (`src/sciretriever/cli/discover.py:43,73-88,220-225`; `src/sciretriever/discovery/search_contracts.py:42-61`; `src/sciretriever/discovery/provider_collection.py:107-121`).
- The manifest contains merged metadata, identifiers, labels, and coarse provenance, not the per-provider observations/record IDs/precedence needed for lossless catalog ingestion (`src/sciretriever/core/contracts.py:146-227`; `src/sciretriever/discovery/metadata_preparation.py:123-137`).
- ADR 0002 makes Work/WorkVersion and observations the durable product center, while read-only exploration remains a separate user intent (`docs/architecture/decisions/0002-work-centered-literature-library.md:22-31`).

## Decisions (with rationale)
- One retrieval request type owns query, providers, precedence, limit, filters, provider timeout, and max concurrency; both bulk sinks consume its one deterministic prepared-candidate output.
- Provider records remain neutral immutable observations; vendor dicts do not cross integrations.
- The catalog sink consumes prepared observations directly; the manifest sink projects those same candidates into the existing report after read-only catalog comparison and labeling.
- Unknown filters fail closed for every selected provider; `search` gains the same year range input already available to `discover`.
- Partial provider failures remain sanitized and are returned by the shared retrieval result; all-provider failure produces no catalog write and no manifest replacement.
- No new catalog schema, workflow state, background task, or provider-specific query language.
- Candidate parity means both sinks receive the same immutable pre-sink candidate tuple; it does not require manifest JSON to equal search's post-ingest projection, which may include prior catalog observations.
- Search's identity safety is authoritative: different non-empty DOI values never auto-merge; ambiguous bridge identifiers stay in observations but not safe candidate identifiers; exact normalized-title remains the only title fallback.
- Canonical fields and candidate ordering use request precedence; merge, stable sort, then global limit. This intentionally replaces discover's hard-coded per-field priorities and preserves search's completion-prefix ordering.
- Identifier-only/title-less groups are retained as observations during normalization but excluded from bulk candidates; exact DOI remains unresolved without a canonical title.
- Shared retrieval returns candidates plus sorted sanitized failures and performs no sink writes. Partial failure continues; all-provider failure blocks either sink. Discover partial success publishes and warns on stderr; discover all-failed preserves existing manifest bytes.
- Discover maps its existing deduplicated source order to effective precedence; no new discovery precedence/config surface. Search receives the already-approved public year filters.

## Scope IN
- Shared typed candidate retrieval request/output and one normalize/match/merge implementation.
- Concurrent bounded provider collection with stable partial-failure semantics for both sinks.
- Existing manifest projection, atomic publication, catalog comparison, and deterministic local labels over shared candidates.
- Existing catalog ingestion and downstream completion over shared candidates.
- Year filter parity between `discover` and `search`, explicit precedence parity, CLI/config/docs updates.
- Regression tests proving identical candidate identity/order/canonical metadata across sinks from the same provider responses.

## Scope OUT (Must NOT have)
- No import command for the current DownloadManifest and no claim that it is a staging protocol.
- No versioned observation-rich CandidateSet serialization schema.
- No removal of Work/WorkVersion, MetadataObservation, completion stages, or independent metadata/acquisition/analysis execution.
- No new subject-area/document-type/provider-specific advanced filter surface.
- No live provider calls in tests, dependency upgrades, lockfile changes, schema migration, daemon, or cross-machine coordination.

## Open questions
1. Public product shape (owner decision):
   - **A, recommended for this small refactor:** retain `discover` as read-only export and `search` as catalog commit; unify only the candidate pipeline, align filters/precedence, and keep the current manifest explicitly non-importable.
   - B: collapse both under one `search --sink manifest|catalog` command and retire `discover` (larger CLI compatibility/documentation change).
   - C: additionally design a versioned, observation-rich export/import staging contract (substantially larger public data-contract scope).

Resolved: owner selected A. No open questions remain.

## Approval gate
status: approved
approach: Plan option A with search-authoritative matching, shared pre-sink candidate equality, read-only manifest projection, catalog ingestion, year-filter parity for search, and no staging/import schema.
pending-action: complete the bounded dual review, repair only concrete requirement gaps without scope expansion, then hand off `.omo/plans/unified-candidate-retrieval.md` to a separate `$start-work` execution phase
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->

## Review round
phase: review_round_initialized
workspace_root: /workplace/home/duanjw/project/literature/retrieval/SciRetriever
runtime_home: null
target: .omo/plans/unified-candidate-retrieval.md
plan_sha256: dd24e754736ed153f61ae9a4df64e91f2ab5bb75a30db0db3b78ad5225e42d30
round_id: db62177b-0da5-4ad5-ae3e-d4568ede9af3
round_status: approved
momus_launch_id: 9d2e2b83-ca4a-4da7-a265-ab28778816f4
independent_launch_id: f659a3e9-2054-4b18-8e62-d71ad2d709bb
review_constraint: Review against approved Option A only. Reject unnecessary abstractions, staging/import contracts, schema changes, new frameworks, compatibility layers, provider-specific filters, or any proposal that increases product scope. Changes requested must identify a concrete requirement violation or unverifiable acceptance criterion in the current plan.
prior_round: 4ec98fbb-8cee-46a7-992a-f68c53af8a25 changes requested; fixed invalid parser reference, diagnostic exception wording, unsafe standalone bridge fixture, and impossible documentation-gate claim without adding scope.
momus_result: OKAY; session ses_05395c363ffeV1J3OLoi3I7C8h; exact digest verified.
independent_result: APPROVED; session ses_05395c00fffefcuSBqmjuXJl5J; exact digest verified.
live_validation: dd24e754736ed153f61ae9a4df64e91f2ab5bb75a30db0db3b78ad5225e42d30 matched after both approvals.
