---
slug: wp5-completion
status: approved-for-execution
intent: clear
review_required: false
pending-action: write .omo/plans/wp5-completion.md
approach: Add catalog-owned derived completion facts, then an application-owned CompletionPipeline that composes exact metadata resolution, acquisition, MinerU normalization, and analysis; replace all CLI-local orchestration without compatibility paths.
---

# Draft: wp5-completion

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
facts | derive one WorkVersion completion stage from authoritative catalog facts | active | src/sciretriever/catalog
pipeline | ensure one DOI or WorkVersion reaches an explicit stop stage through WP2-WP4 services | active | src/sciretriever/completion
entrypoints | route search/download/analyze/local primary-PDF import through the pipeline | active | src/sciretriever/cli
acceptance | prove restart, idempotency, atomic promotion, and no parallel state | active | tests

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
exact DOI metadata | filter normalized provider results to the requested DOI before persistence | prevents unrelated query matches and placeholders | yes
completion status | never persist a completion column or status row | approved architecture derives stage from facts | no, contract decision
compatibility | delete replaced CLI orchestration and obsolete helpers | owner explicitly rejected compatibility retention | no, contract decision
commits | create atomic commits only after all WP5 verification passes | honors requested commit timing and repository policy | yes

## Findings (cited - path:lines)

- `docs/planning/literature-library-execution.md:111` defines the approved WP5 behavior and acceptance gate.
- `docs/specs/technical-architecture.md:44` places completion in the application layer and forbids mutable workflow state.
- `src/sciretriever/cli/search.py:187` currently owns the duplicated metadata/download/analyze chain.
- `src/sciretriever/catalog/analysis_selection.py:75` proves exact accepted-primary-PDF eligibility but not complete projection alignment.
- `src/sciretriever/catalog/analysis.py:123` already owns atomic current-result and generated projection replacement.
- `src/sciretriever/discovery/search.py:92` is query-oriented and needs an exact-identifier adapter before DOI completion can be safe.

## Decisions (with rationale)

- Completion stages are WorkVersion-scoped and derived; Work identity status remains unrelated.
- Catalog owns a side-effect-free facts repository; it must not import completion.
- Completion owns orchestration only and delegates all writes to WP2-WP4 owners.
- A DOI-only target remains invocation-local until exact usable provider metadata succeeds.
- `COMPLETE` requires aligned current analysis and current generated projections, not merely a current row.
- Re-reading facts after each stage is orchestration control flow, not a persisted checkpoint.
- Existing CLI-local chains are deleted once the shared pipeline is wired; no adapter preserves them.

## Scope IN

- Typed completion target, stage, stop point, result, and stage-outcome contracts.
- Catalog completion facts and exact stage derivation.
- Exact DOI metadata resolution without placeholders.
- Application composition of metadata, acquisition, MinerU/source-map, and analysis.
- Search, download, analyze, and local primary-PDF import integration.
- Offline unit/integration/E2E tests, current documentation, harness and CLI QA.
- Atomic commits after all verification.

## Scope OUT (Must NOT have)

- No mutable completion status column/table, job, task, daemon, lease, checkpoint, or compatibility layer.
- No legacy CLI/config/schema/read path and no migration/backup/rollback work.
- No WP6 reference expansion, curation, failures command, config check, or export redesign.
- No dependency or lockfile updates; no real provider, production database, or user corpus access.

## Open questions

None. Product behavior and destructive pre-v1 replacement policy were explicitly approved.

## Approval gate
status: approved
Approval is inherited from the user's explicit request to start the already approved WP5 plan; execution may begin after the engineering plan is complete.
<!-- When exploration is exhausted and unknowns are answered, set status: awaiting-approval. -->
<!-- That durable record is the loop guard: on a later turn read it and resume at the gate instead of re-running exploration. -->
