---
slug: simple-three-stage-architecture
status: planned
intent: clear
review_required: false
pending-action: execute .omo/plans/simple-three-stage-architecture.md in a separate worker session, or run optional dual high-accuracy review first
approach: Preserve the existing mature Work-centered local-library architecture while treating metadata retrieval, document-asset acquisition, and document analysis as three independently runnable capabilities coordinated only through catalog facts and immutable storage. Completion remains a shared fact/eligibility contract and optional explicit convenience path, not a mandatory end-to-end workflow. Metadata defaults to 1000 merged results and is paced per provider request/page; acquisition starts retain a non-reducible 30-second minimum; MinerU task IDs remain technical recovery handles without becoming completion states.
---

# Draft: simple-three-stage-architecture

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->
metadata-batch | independently retrieve, normalize, deduplicate, and persist up to the selected metadata batch; no downstream acquisition or 30-second per-record delay is required | active | src/sciretriever/cli/metadata_runtime.py:80
asset-acquisition | independently select catalog WorkVersions missing accepted assets and acquire them with at least 30 seconds between adjacent document starts | active | src/sciretriever/cli/download.py:90
document-analysis | independently select WorkVersions with exactly one accepted primary PDF and no current analysis, then parse/analyze/publish current results | active | src/sciretriever/cli/analyze.py:58
completion-catalog | expose fact-derived eligibility and idempotent stage invocation shared by independent commands; it is not a mandatory chained workflow | active | src/sciretriever/completion/pipeline.py:66
library-capabilities | query/curation/references/expansion/export remain active parts of the existing Work-centered architecture and continue to consume the shared completion contract | active | README.md:17

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->
metadata pacing unit | provider HTTP request/page, never returned record | provider APIs return batches and current collector calls each configured provider once per search | yes
acquisition pacing unit | adjacent WorkVersion acquisition starts, minimum 30 seconds | owner declared this an iron rule and current acquisition service already owns the gate | yes
analysis pacing | parser/model-specific timeout and concurrency only | the 30-second anti-ban rule concerns document acquisition, not local/external parsing | yes
workflow state | three active missing stages plus COMPLETE terminal | catalog facts already derive this and owner rejects stage-internal persisted states | no without owner change
recovery | idempotent rerun from catalog facts, while preserving the MinerU external task ID as a technical recovery handle | avoids duplicate external parsing without creating a completion state | yes
process model | one independently started foreground process per capability may operate against the same catalog | SQLite WAL and bounded transactions support cross-stage writes, while same-WorkVersion duplicate external work still needs fail-closed eligibility/recheck protection | yes

## Findings (cited - path:lines)
1. Metadata architecture is directionally correct: configured providers run concurrently with independent timeout, and each provider returns a tuple/batch of ProviderRecord values in one collector invocation (`src/sciretriever/discovery/provider_collection.py:40-125`).
2. The documented merged result limit of 100 is a product output cap, not one HTTP request per record; the owner selected a new default of 1000 while retaining explicit user overrides (`docs/architecture/requirements.md:201-207`; `docs/architecture/system-design.md:103-124`; `src/sciretriever/discovery/search_contracts.py:43-60`).
3. Keyword search persists the whole metadata batch before constructing WorkVersion targets for deeper completion (`src/sciretriever/cli/search.py:199-209`; `src/sciretriever/cli/search_completion_runtime.py:47-59`).
4. The 30-second gate is constructed in acquisition runtime and applied when a WorkVersion needs an asset, not while iterating metadata records (`src/sciretriever/cli/acquisition_runtime.py:95-123`; `src/sciretriever/acquisition/service.py:159-189`).
5. The completion spine matches the owner's simplicity rule: failure does not create an internal document state; rerun re-reads catalog facts and invokes only the missing stage (`docs/architecture/system-design.md:126-146`; `src/sciretriever/completion/pipeline.py:134-155`).
6. The modular-monolith dependency direction is reasonable and should remain: completion coordinates; metadata/acquisition/analysis own their stage; catalog/storage own facts and bytes (`docs/architecture/technical-architecture.md:27-39`).
7. The design documents describe an already implemented, mature Work-centered local-library architecture: version preference, observations, curation, references/expansion, packaging, failure history, and MinerU recovery remain in scope and must not be replaced by a reduced parallel core (`README.md:12-31`; `docs/architecture/requirements.md:133-197,283-319,332-424`).
8. The current access-limit proposal should be aligned with existing acquisition/integration/network owners rather than introduce a parallel replacement architecture; cycle quotas and availability evidence may remain only where they directly support the existing provider contracts (`docs/proposals/acquisition-source-availability-and-access-limits.md:120-170,206-226`).
9. Architecture wording is ambiguous about the 30-second rule: technical architecture calls it a generic document start interval rather than explicitly an acquisition-start interval (`docs/architecture/technical-architecture.md:70-84`).
10. Exact DOI metadata resolution is a separate metadata request shape from keyword batch search; it still needs provider-request pacing, but never the acquisition 30-second per-document rule (`src/sciretriever/completion/pipeline.py:72-75,123-132`).
11. The current CLI already exposes independent `search`, `download`, and `analyze` entry points; download selects existing WorkVersions and stops at ASSET, while analyze builds an analysis-only runtime (`src/sciretriever/cli/download.py:90-150`; `src/sciretriever/cli/analyze.py:58-100`).
12. Analysis selection currently treats every WorkVersion without current analysis as pending, including records without an accepted primary PDF; an independent analysis capability should select only records eligible for analysis instead of invoking completion on ineligible records (`src/sciretriever/catalog/analysis_selection.py:58-64,75-95`).
13. The writable catalog uses SQLite WAL, a 5-second busy timeout, ordinary bounded transactions, and `BEGIN IMMEDIATE` for critical admission paths, so different stages can share the catalog; however WAL alone does not prevent duplicate network/MinerU work if two processes select the same WorkVersion (`src/sciretriever/catalog/engine.py:19,47-64,83-106`).

## Decisions (with rationale)
confirmed | Keep a three-active-stage fact-derived workflow plus COMPLETE terminal; no stage-internal persistent state.
confirmed | Metadata search rate limits apply per provider request/page, not per returned record.
confirmed | Every adjacent WorkVersion acquisition start waits at least 30 seconds across search-download, download backfill, and expansion paths.
confirmed | Preserve the complete existing Work-centered architecture; do not redefine the product as a smaller replacement core.
confirmed | Metadata retrieval, document-asset acquisition, and document analysis are independently runnable capabilities; none is required to synchronously launch the next.
confirmed | Change the default merged metadata search limit from 100 to 1000 while preserving explicit lower or higher user limits within the existing validation boundary.
confirmed | Preserve the MinerU external task ID as a technical recovery handle; it does not create an additional completion stage.
confirmed | Restart clears in-process pacing state; no durable rate-limit state.
confirmed | Retain explicit `search --level download|analyze` as an optional convenience path. Keep metadata `--limit` independent from a downstream `--completion-limit`; metadata defaults to 1000 and deep completion defaults to 100, with either value overridable by CLI or TOML.
confirmed | Use TDD for behavior changes and repository documentation/architecture gates for documentation-only alignment.
confirmed | Retain independent command defaults: metadata 1000, acquisition 100, and analysis 100; explicit positive `--limit` overrides the applicable default.
confirmed | Permit metadata, acquisition, and analysis to run concurrently against one catalog, while enforcing at most one active acquisition process and one active analysis process per catalog; same-stage conflicts fail closed without durable workflow state.
confirmed | Reject `document_start_interval_seconds < 30` at strict config and gate construction boundaries; never silently clamp an invalid value.
confirmed | Implement host-local, catalog-scoped acquisition/analysis admission with non-waiting process locks, fixed acquisition-then-analysis lock order for mixed commands, stable exit code 1 on conflicts, and no lease/heartbeat/schema state.
confirmed | Keep MinerU external task IDs UUID-validated at every repository/client boundary and preserve the existing resume-polling behavior.
recommended | Keep Completion as the shared fact-derived eligibility/idempotence contract and retain explicit chaining only as an optional convenience, never as the architectural default.
recommended | Tighten analysis selection to accepted-primary-PDF candidates so an independent analysis run does not scan or report asset-pending records as analysis work.
recommended | Permit simultaneous different-stage processes against SQLite WAL, but fail closed or recheck facts immediately before expensive external work to avoid duplicate acquisition or MinerU/LLM execution for the same WorkVersion.
recommended | Keep the existing modular-monolith ownership direction and make only targeted code, configuration, test, proposal, and architecture-document corrections.

## Scope IN
Targeted alignment of the existing architecture: independent stage command contracts and eligibility, optional completion convenience behavior, metadata batching/default limit, acquisition pacing, cross-stage concurrent-process safety, MinerU recovery wording, affected strict configuration and CLI surfaces, tests, user documentation, architecture documents, and the active access-limit proposal.

## Scope OUT (Must NOT have)
No replacement core, no removal or deferral of existing library capabilities, no daemon/queue/workflow platform, no new completion stages, no per-metadata-record 30-second waits, no durable rate-limit state, and no product-code or documentation edits before plan approval and separate execution.

## Open questions
None. Product scope, public defaults, optional chaining, concurrency policy, recovery behavior, and test strategy are owner-confirmed.

## Approval gate
status: approved
approved_on: 2026-07-28
approval_scope: Write `.omo/plans/simple-three-stage-architecture.md` only. Product code and formal documentation remain unchanged until a separate worker session executes the plan.
plan_path: `.omo/plans/simple-three-stage-architecture.md`
plan_written_on: 2026-07-28
