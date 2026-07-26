---
slug: wp6-product-closeout
status: review-approved
intent: clear
review_required: true
pending-action: execute .omo/plans/wp6-product-closeout.md in a separate start-work session
approach: Extend the existing strict catalog/config/completion/package owners with read-first WP6 foundations, then transactional curation, export, breadth-first expansion, and final CLI/documentation convergence; do not add a scheduler, mutable completion state, compatibility path, or second configuration parser.
---

# Draft: wp6-product-closeout

## Components (topology ledger)
<!-- Lock the SHAPE before depth. One row per top-level component that can succeed or fail independently. -->
<!-- id | outcome (one line) | status: active|deferred | evidence path -->

| id | outcome | status | evidence |
|---|---|---|---|
| expansion | `expand` traverses references/cited-by/both breadth-first by depth, completes each layer through WP5, isolates branches, and reruns idempotently | active | `docs/specs/requirements.md:285-302`; `src/sciretriever/completion/pipeline.py` |
| failures | `failures` projects redacted metadata/acquisition/analysis/expansion diagnostics without becoming completion truth | active | `docs/specs/requirements.md:106-108`; `src/sciretriever/diagnostics/`; `src/sciretriever/catalog/processing.py` |
| curation | explicit library review/merge/regroup/preferred/metadata/tag/author operations are atomic, audited, and compensating-undo capable | active | `docs/specs/requirements.md:96-100`; `src/sciretriever/catalog/library.py`; `src/sciretriever/catalog/manual_metadata.py` |
| export | reading projection and packaging-owned immutable `DocumentPackageVersion` export are explicit; full references require opt-in | active | `docs/specs/requirements.md:96-101`; `src/sciretriever/cli/library.py`; `src/sciretriever/packaging/publisher.py` |
| config | one strict schema gains WP6 fields and `config check`, preserving current selection precedence and secret/redaction behavior | active | `docs/specs/requirements.md:304-320`; `src/sciretriever/config.py`; `src/sciretriever/cli/main.py` |
| convergence | all foreground commands use one count vocabulary; architecture/docs/help/example config/full release gates close the product surface | active | `docs/planning/literature-library-execution.md:124-136`; `scripts/harness.py` |

## Open assumptions (announced defaults)
<!-- Record any default you adopt instead of asking, so the user can veto it at the gate. -->
<!-- assumption | adopted default | rationale | reversible? -->

| assumption | adopted default | rationale | reversible? |
|---|---|---|---|
| Config selection | Preserve `--config` > `SCIRETRIEVER_CONFIG` > `./config.toml`, with `--no-config`; “one strict TOML” means one schema/parser, not one discovery source | WP6 explicitly reuses WP2-WP5 config behavior; changing selection would be unrelated breakage | yes |
| Reading export references | Emit safe canonical reference projections only; never provider observations, raw diagnostics, URLs, paths, or secrets | Matches current library safety boundary and FR-16/FR-18 | yes |
| Package export | Delegate snapshot creation/loading to `packaging`; library never reconstructs package internals | Preserves ADR ownership and immutable replay | yes |
| Expansion limits | Validate finite non-negative depth but add no product document cap; use bounded per-layer batches/streaming internally | FR-17 forbids hidden document caps but not bounded memory/concurrency | yes |
| Failure semantics | Persist append-only evidence; derive current stage, retry eligibility, and progress from facts | Preserves WP5 no-mutable-status contract | no without contract change |
| Undo | Undo appends a compensating operation and fails closed when current state no longer matches the original after-snapshot | Preserves audit history and prevents overwriting later edits | yes |
| Scope exclusions | No vector search, daemon, background task center, migration/legacy adapter, Web UI, domain schema, or real-provider acceptance | Explicit FR-10/FR-17 and repository constraints | no |

## Findings (cited - path:lines)

- FR-16 storage and one-hop read APIs already exist through `version_references`, `ReferenceRepository`, and `LibraryReadRepository`; FR-17 scheduler/provider graph adapters do not (`src/sciretriever/catalog/models.py:509`, `src/sciretriever/catalog/library.py:1232`, `src/sciretriever/catalog/library_read.py:159`).
- WP5 `CompletionPipeline`, fact stages, batch isolation, dedupe, Ctrl+C, and rerun contracts are reusable, but expansion must dedupe stable Work IDs and report layer outcomes (`src/sciretriever/completion/pipeline.py:66`, `runner.py:15`, `batch.py:14`).
- Curation prerequisites exist but audit/undo does not: preferred and manual metadata are mutable, manual tags only add, Work/Author merge and WorkVersion regroup are absent, and generic events lack required before/after/inverse guards (`src/sciretriever/catalog/library.py:993,1123,1196`; `manual_metadata.py:17`; `repository.py:171`).
- Failure evidence is fragmented: metadata is invocation-local, acquisition diagnostics are durable but unqueryable, processing failures are generic, and expansion has no owner. Generic processing messages are not guaranteed to pass the central redactor (`src/sciretriever/diagnostics/`; `src/sciretriever/catalog/processing.py`; `src/sciretriever/catalog/assets.py`).
- Strict TOML and current precedence already exist; WP6 fields, general `config check`, global document-start interval, and enabled-capability readiness projection are missing (`src/sciretriever/config.py:49-223,897-924`; `src/sciretriever/cli/main.py:74-259`).
- Reading export is safe JSON/JSONL; package publication already supplies immutable hash/version/replay semantics. Missing work is an explicit mode/select/export contract, not a second package builder (`src/sciretriever/cli/library.py:50-80`; `src/sciretriever/packaging/publisher.py:161-257`; `src/sciretriever/core/package.py:1068-1365`).
- Current architecture checks do not yet enforce WP6 composition and deletion rules; WP6 must extend them before feature cutover (`scripts/architecture_checks.py`).

## Decisions (with rationale)

- Use six independently verifiable components above, implemented in dependency order: contracts/schema and architecture gates; diagnostics/config/count foundations; curation; export; expansion; public convergence.
- Keep catalog as persistence owner, completion as stage orchestration owner, integrations as provider adapter owner, packaging as package owner, and CLI as composition root.
- Expansion operates breadth-first and only COMPLETE WorkVersions contribute a next-layer frontier; branch exhaustion remains a diagnostic/fact outcome, not a new status machine.
- Preserve unresolved references and support later deterministic resolution; never create guessed Works solely to make the graph connected.
- New public JSON remains deterministic, sorted and additive where existing commands are extended; no secret/runtime material may enter terminal, catalog, lineage, package, or audit snapshots.
- Owner approved direct pre-v1 target-schema replacement for append-only curation/audit, cross-stage diagnostics, and Work/Author merge lineage/tombstones. No compatibility with nonconforming code or schema is required; delete code that conflicts with the target design.
- A Work contributes expansion edges only from its preferred COMPLETE WorkVersion. An explicitly selected WorkVersion seed may supply the depth-0 frontier, but discovered Works return to preferred-version semantics.
- `config check` is offline/static plus filesystem/profile validation by default. Explicit `--runtime` enables bounded read-only health/readiness probes for configured endpoints; disabled capabilities are never probed.
- All WP6 implementation items use TDD: the worker must first add and run a failing direct test for the contract or behavior, then implement the smallest target design, then rerun direct and affected regression gates. Agent-executed happy/failure QA remains mandatory per todo.
- Cited-by expansion is local-first plus remote discovery: reuse saved reverse edges, then query only explicitly graph-capable provider adapters for unknown citing Works and deterministically merge by stable identity. This is an engineering derivation of the approved product goal, not a separate owner-facing product choice.
- `--include-references` controls only the human-oriented reading projection. `DocumentPackageVersion` always retains its intrinsic evidence-backed references because they are part of the complete immutable downstream contract.

## Scope IN

- `expand`, `failures`, and `config check` command surfaces.
- References/cited-by/both provider-neutral graph adapters, deterministic BFS depth semantics, stable Work visited set, per-layer completion/counts, branch isolation, interruption and rerun.
- Review queues and explicit reversible curation operations required by FR-18.
- Reading and versioned package exports, with explicit `--include-references`.
- Strict WP6 TOML fields, default 30-second document-start interval, config validation/readiness, and existing precedence.
- Unified count vocabulary and deterministic/redacted JSON projections.
- Offline fixtures, transaction failpoints, security/manual QA, docs/help/example config, architecture/deletion/wheel gates, and full harness.

## Scope OUT (Must NOT have)

- Mutable completion/expansion status, durable scheduler/task/job, lease/fencing/checkpoints, background workers, exact crash resume, or product document cap.
- Compatibility adapters, migrations, old-schema readers, feature flags, parallel config parsers, or duplicate package builders.
- Vector search, institutions, license/retraction models, Web UI, multi-user permissions, arbitrary import formats, or downstream domain data.
- Live provider/MinerU/LLM/browser acceptance or user data; all execution evidence is offline and temporary.

## Open questions

- None. Remaining implementation details are derived from the approved product boundary and recorded above.

## Approval gate
status: plan-reviewed
approach: contracts/schema and architecture gates -> diagnostics/config/count foundations -> transactional curation and compensating undo -> reading/package export -> provider-neutral BFS expansion through shared completion -> CLI/docs/release convergence.
next-action: Owner starts execution from `.omo/plans/wp6-product-closeout.md` in a separate `$start-work` session. Do not implement in this planning session.

## High-accuracy review state

```json
{
  "transition": "replace",
  "phase": "review_round_approved",
  "review_required": false,
  "plan_path": ".omo/plans/wp6-product-closeout.md",
  "plan_sha256": "5939abc046135f2d627d38db21b8ade7de883205cbb423713107d023f15b0912",
  "review_round_id": "160565ef-2ac9-482c-b35e-e4630e0dc084",
  "round_status": "approved",
  "pending-action": "execute .omo/plans/wp6-product-closeout.md in a separate start-work session",
  "review": {
    "momus": {
      "status": "approved",
      "workspace_root": "/workplace/home/duanjw/project/literature/retrieval/SciRetriever",
      "runtime_home": null,
      "target": ".omo/plans/wp6-product-closeout.md",
      "round_id": "160565ef-2ac9-482c-b35e-e4630e0dc084",
      "plan_sha256": "5939abc046135f2d627d38db21b8ade7de883205cbb423713107d023f15b0912",
      "launch_id": "32ec2977-dcc4-49fa-84ae-b8e927172af8",
      "session": "ses_067a95eceffeOOm3JDn4FpNFZ7",
      "result": "OKAY: decision-complete; baseline commit, LOC, manifest, closure and F1-F4 contracts coherent"
    },
    "independent": {
      "status": "approved",
      "workspace_root": "/workplace/home/duanjw/project/literature/retrieval/SciRetriever",
      "runtime_home": null,
      "target": ".omo/plans/wp6-product-closeout.md",
      "round_id": "160565ef-2ac9-482c-b35e-e4630e0dc084",
      "plan_sha256": "5939abc046135f2d627d38db21b8ade7de883205cbb423713107d023f15b0912",
      "launch_id": "69f7ced3-55a9-40c3-802d-f4be009f4075",
      "session": "ses_067a95d34ffeUSnGpPihQkIXaO",
      "result": "OKAY: architecture-safe, scope-faithful, TDD-executable and cryptographically noncircular"
    }
  }
}
```
