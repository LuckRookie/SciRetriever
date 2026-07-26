# wp6-product-closeout - Work Plan

## TL;DR (For humans)
**What you'll get:** SciRetriever's first complete local-literature-library product surface: citation expansion, actionable failure inspection, reversible manual curation, safe reading and immutable package exports, strict configuration checks, and consistent progress reporting.

**Why this approach:** It extends the catalog, completion, packaging, and configuration owners already proven in WP1-WP5 instead of creating parallel state or duplicate pipelines. Risky identity, audit, graph, and redaction behavior is locked by tests before implementation.

**What it will NOT do:** It will not add background jobs, hidden document limits, compatibility layers, a second configuration system, a second package builder, vector search, a Web UI, or domain-specific scientific data.

**Effort:** XL
**Risk:** High - transactional identity curation, exact undo, citation-graph traversal, and cross-stage diagnostic redaction all touch stable persistence and public CLI contracts.
**Decisions to sanity-check:** Direct pre-v1 schema replacement; preferred completed version supplies each Work's graph frontier; configuration checks are offline by default; package snapshots always retain references.

Your next move: start work from this plan, or request the optional dual high-accuracy plan review first. Full execution detail follows below.

---

> TL;DR (machine): XL/high-risk WP6 delivery across fresh schema, diagnostics, curation/undo, export, graph expansion, config and release convergence; 31 product/documentation TDD todos, one release-receipt todo, one closure-state red/green todo, and four final verification roles.

## Scope
### Must have
- Directly replace the pre-v1 fresh schema with typed append-only diagnostic and curation operation records, Work/Author merge lineage, tombstones, stale-undo guards, and the indexes/constraints required by WP6; do not create migrations.
- Correct completion batch truthfulness before reuse: exhausted targets are not successes, counts distinguish selected/succeeded/exhausted/failed/duplicate/interrupted, and diagnostic history never changes derived completion stage.
- Add a single typed, allowlisted, redacted diagnostic write/query boundary spanning pre-identity metadata, acquisition, analysis/parser and expansion failures, with object/stage reason/action and bounded acquisition source details.
- Add `config check` with offline static/filesystem/profile checks by default and bounded read-only enabled-capability probes only under `--runtime`; extend the one strict TOML parser with WP6 expansion/curation/export/default 30-second document-start fields.
- Add explicit, atomic and reversible review/Work merge/WorkVersion regroup/preferred/manual metadata/manual tag/Author merge operations. Preserve observations, WorkVersions, RawAssets, current analyses and immutable package snapshots.
- Add reading export with references only under `--include-references`, and packaging-owned immutable `DocumentPackageVersion` export/re-export with exact version/hash selection and references always intact.
- Add local-first plus graph-provider `expand` for references/cited-by/both, finite non-negative depth, preferred COMPLETE frontier, stable Work visited/queued sets, deterministic breadth-first layers, no hidden document cap, branch isolation, per-layer counts, Ctrl+C and idempotent rerun.
- Converge command help, deterministic JSON/count vocabulary, config example, README, specs, progress, architecture/deletion checks, wheel parity, manual QA and full harness.

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No mutable completion or expansion status, durable scheduler/task/job, daemon, lease, fencing, checkpoint, retry-child, background worker or exact internal-step crash resume.
- No product-level maximum-new-documents cap, guessed Work creation, fuzzy/LLM identity merge, all-versions frontier, or XML/HTML substitute for primary PDF completion.
- No migration, compatibility adapter, old-schema reader, feature flag, parallel legacy path, retired code retention, or automatic TOML rewrite.
- No second TOML parser, direct command-specific secret parsing, second package constructor, catalog dependency on workflow modules, completion import from CLI, or library reconstruction of package internals.
- No secret, signed URL, response body, arbitrary exception text, absolute/runtime path, headers, cookies or provider payload in output, catalog diagnostics, audit snapshots, lineage or packages.
- No vector index/search, institution registry, license/retraction model, arbitrary import format, Web UI, permissions system, SciRetriever-owned service or downstream domain schema.
- No real provider, user corpus, production catalog, live MinerU/LLM/browser in tests or acceptance; all evidence uses offline fixtures and temporary roots.

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: Full TDD with standard-library `unittest` for every behavior/schema/code/documentation change in Todos 1-30 and final progress/manifest Todo 32. Each first adds and runs a failing direct test or documentation/architecture fixture, then implements the smallest target behavior, reruns direct and affected regressions, and records red-to-green commands. Todo 31 is receipt-only release verification. Todo 33 changes durable closure state and therefore first runs its exact status validator expecting failure, performs only allowlisted closure writes, then reruns the validator to green.
- Direct command: run the exact test module named by the todo, using `uv run --frozen python -m unittest discover -s tests -p 'test_NAME_wp6.py'`; existing regression modules use their current exact filenames.
- Typed/architecture gates: `uv run --frozen pyright src/sciretriever tests scripts`, `uv run --frozen python scripts/harness.py architecture`, and `uv run --frozen python scripts/harness.py docs` when the todo changes their owned surfaces.
- Release gates: `uv run --frozen python scripts/harness.py quick`, then `uv run --frozen python scripts/harness.py full`; no dependency or `uv.lock` changes.
- Manual surface gate: launch the installed CLI in tmux and exercise one happy path, one invalid input, interruption/replay where applicable, `--help`, redaction scans, database/hash assertions and cleanup.
- Evidence: outside ulw-loop use `.omo/evidence/wp6/task-N.txt`, replacing `N` with the todo number. Under ulw-loop, obtain `currentAttemptDir` from `omo ulw-loop status --json` and also write `task-N-wp6-product-closeout.txt` inside that exact directory. Never treat logs or grep alone as proof; include exact command, exit code and asserted state.
- Pure-LOC decision: Todo 1 records a baseline pure-LOC manifest. The one exact algorithm reads each regular non-symlink tracked `*.py` file as UTF-8, tokenizes it with Python 3.12 `tokenize`, and counts each physical line intersected by at least one token whose type is not `ENCODING`, `NL`, `NEWLINE`, `INDENT`, `DEDENT`, `COMMENT` or `ENDMARKER`; docstrings and every physical line of a multiline string therefore count, while blank/comment-only lines do not. Duplicate line hits count once, and decode/tokenization failure is fatal. Generated files receive no exception. Every new Python file and every changed file whose baseline is <=250 pure LOC must finish <=250. A pre-existing file already >250 may be touched only for mechanical extraction/cutover: its pure LOC must strictly decrease from baseline, no new WP6 behavior may be implemented inside it, and all extracted/new behavior must live in <=250-pure-LOC modules. `core/package.py` is read-only for WP6; changing it requires a separately approved decomposition. This is the exact diff-scoped gate used by Todo 5, Todo 31 and F2.

### Canonical progress/count schema
| JSON field | Applies to | Exact meaning / reconciliation |
|---|---|---|
| `provider_returned` | search, expand graph lookup | Raw neutral candidates returned by all completed provider calls before identity dedupe; provider failures are reported separately. |
| `deduplicated_works` | search, expand | Stable Work identities after deterministic merge; never a per-provider sum. |
| `created` / `reused` | search, expand metadata resolution | Newly created versus existing WorkVersion targets; `created + reused` equals unique persisted/resolved targets for the invocation. |
| `selected` | download, analyze, expand layer, shared completion batch | Validated input target positions before stable-identity dedupe, including positions later classified duplicate; `selected = succeeded + exhausted + failed + duplicates + interrupted`. |
| `unique_targets` | download, analyze, expand layer, shared completion batch | Stable identities actually eligible for execution after dedupe; `unique_targets = selected - duplicates`. |
| `succeeded` | all completion-backed commands | Target reached/reused the requested stop. A resolved target that did not advance to stop is never included. |
| `exhausted` | all completion-backed commands | Expected sources/capabilities were exhausted and target remained at its prior fact-derived stage; eligible for rerun. |
| `failed` | all completion-backed commands | Unexpected invariant/config/storage/catalog/runtime failure after redaction; distinct from exhausted. |
| `duplicates` / `interrupted` | all completion-backed commands | Duplicate stable target versus cooperative stop/current-unstarted suffix. |
| `accepted` / `missing` | download and asset stop | Aliases for asset-stage `succeeded` and `exhausted`; command-level `failed` remains unexpected failure. |
| `analysis_succeeded` / `analysis_failed` | analyze and complete stop | `analysis_succeeded = succeeded`; `analysis_failed = exhausted + failed`, while detailed fields preserve expected exhaustion versus unexpected failure. |
| `discovered` / `existing` / `completed` | each expansion layer | `discovered` is unique stable Work frontier after edge dedupe; `existing` already existed before layer resolution; `completed` is the subset at COMPLETE after layer execution. Layer `selected` reconciles through the terminal-disposition equation above. |

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.

- **Wave 1 - target contracts and deletion gates:** Todos 1-5. Serial schema/contract ownership where noted; architecture and DTO work may parallelize after Todo 1.
- **Wave 2 - truthful shared foundations:** Todos 6-10. Diagnostics/counts precede command consumers; config/readiness and interval controls may parallelize.
- **Wave 3 - transactional curation:** Todos 11-16. Review and operation service foundations first; Work topology Todo 12 and Author topology Todo 15 are explicitly serial. Preferred and manual metadata/tag work may parallelize only in disjoint files after Todo 11.
- **Wave 4 - export:** Todos 17-21. Safe projections and package selection can parallelize after the export contract, then converge in CLI and security tests.
- **Wave 5 - graph expansion:** Todos 22-27. Neutral graph adapters and reference resolution precede BFS; CLI integration follows the tested expansion service.
- **Wave 6 - public convergence and pre-review evidence:** Todos 28-32. Command/count convergence precedes docs and product acceptance; release gates and pre-review evidence preparation finish before F1-F4.
- **Post-review closure:** Todo 33 runs only after F1-F4 all approve the immutable Todo 32 review manifest. It may change only the closure allowlist (`.omo/plans/wp6-product-closeout.md`, `.omo/start-work/ledger.jsonl`, `.omo/boulder.json`, a new `.omo/evidence/wp6/post-closure.txt` receipt and a new `.omo/evidence/wp6/closure-manifest.json`); product/source/test/docs/config and all manifest-bound evidence inputs remain byte-identical to the reviewed manifest. The plan change is exactly six transitions: Todo 33 and F1-F4 from `[ ]` to `[x]`, plus replacement of the reserved 64-zero closure commitment below with SHA256 of exact final `closure-manifest.json` bytes. Implementation progress is finalized before review in Todo 29.
- Keep at most one schema/transaction owner task active at once. Parallel workers must own disjoint files, reread shared files before editing, and never revert concurrent changes.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | - | 2-32 | - |
| 2 | 1 | 6-9, 11-16, 22-27 | 3-5 |
| 3 | 1 | 7-9, 11-16 | 2,4,5 |
| 4 | 1 | 22-27 | 2,3,5 |
| 5 | 1 | 6-32 | 2-4 |
| 6 | 2,5 | 7,22-32 | 8-10 |
| 7 | 2,3,5,6 | 8,11,25,28-32 | 9,10 |
| 8 | 7 | 25,28-32 | 9,10 |
| 9 | 2,5 | 10,28-32 | 7,8 |
| 10 | 9 | 25,28-32 | 7,8 |
| 11 | 2,3,7 | 12-16 | - |
| 12 | 11 | 15,16,28-32 | 13,14 |
| 13 | 11 | 16,28-32 | 12,14,15 |
| 14 | 11 | 16,28-32 | 12,13,15 |
| 15 | 12 | 16,28-32 | 13,14 |
| 16 | 12-15 | 28-32 | - |
| 17 | 1,5 | 18-21 | - |
| 18 | 17 | 20,21,28-32 | 19 |
| 19 | 17 | 20,21,28-32 | 18 |
| 20 | 18,19 | 21,28-32 | - |
| 21 | 20 | 28-32 | - |
| 22 | 4,5,6 | 23-27 | - |
| 23 | 2,4,7,22 | 24-27 | - |
| 24 | 6,22,23 | 25-27 | - |
| 25 | 7-10,24 | 26,27,28-32 | - |
| 26 | 25 | 27,28-32 | - |
| 27 | 26 | 28-32 | - |
| 28 | 6-10,16,21,27 | 29-32 | - |
| 29 | 28 | 30-32 | - |
| 30 | 28,29 | 31,32 | - |
| 31 | 30 | 32 | - |
| 32 | 31 | F1-F4 | - |
| 33 | F1-F4 | final handoff | - |

## Todos
> Implementation + Test = ONE todo. Never separate.
- [x] 1. Freeze WP6 target contracts and baseline
  What to do / Must NOT do: Before the first worktree edit, run exactly `git rev-parse --verify 'HEAD^{commit}'` and retain its one-line lowercase object ID as `baseline_commit`; fail if it is not a commit. Add `tests/test_wp6_contracts.py` first with failing assertions for the final command tree, product-stage/reason/action/count enums, curation action vocabulary, graph direction/depth rules, reading/package export modes and config-check modes. Record a freshly observed WP5 baseline; the current progress truth source expects 682 tests, but evidence must report the command's actual count rather than force a stale number. Create `.omo/evidence/wp6/baseline-pure-loc.json` as canonical compact UTF-8 JSON with schema `{version:1,baseline_commit,python:"3.12",algorithm:"tokenize-physical-v1",files:[{path,pure_loc}]}` using the exact Verification-strategy algorithm and sorted paths. The manifest contains no self-hash; `.omo/evidence/wp6/task-1.txt` records the same `baseline_commit` plus `baseline_pure_loc_sha256=SHA256(exact manifest bytes)`, and every later LOC/manifest gate must verify both values before use. Do not recapture or reinterpret `baseline_commit`, implement behavior, modify dependencies or weaken WP5 contracts.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 2-32
  References: `docs/specs/requirements.md:285-320,379-425`; `docs/planning/literature-library-execution.md:124-136`; `src/sciretriever/cli/main.py`; `src/sciretriever/completion/outcomes.py`; `src/sciretriever/diagnostics/contracts.py`; `.omo/drafts/wp6-product-closeout.md`.
  Acceptance criteria: the new contract test fails only on explicit missing WP6 symbols/commands; `uv run --frozen python scripts/harness.py full` passes the untouched WP5 baseline; evidence records the observed count, status, initial commit object and external exact-byte baseline pure-LOC digest; `git cat-file -e "$baseline_commit^{commit}"` succeeds, and an independent recount reproduces every path/count, baseline commit and manifest SHA without modifying user work.
  QA scenarios: Bash happy: run existing full harness and capture its observed baseline count; failure: run only `test_wp6_contracts.py` and capture expected missing-contract failures. Evidence `.omo/evidence/wp6/task-1.txt`.
  Commit: N unless owner explicitly authorizes commits during execution | proposed `test(wp6): freeze product contracts`

- [x] 2. Replace the fresh catalog schema with WP6 audit and diagnostic primitives
  What to do / Must NOT do: TDD new schema assertions, then update `catalog/models.py`, `schema.py`, `bootstrap.py` and typed records for append-only diagnostic records that can identify pre-Work DOI/input fingerprints or catalog objects; curation operations with action, subject IDs, allowlisted before/after snapshots and hashes, evidence, timestamp, `undo_of`, undone-by link and stale compare guard; Work and Author merged tombstones/lineage; required checks/indexes/FKs. During Todos 2-7 the old generic failure/event structures may remain temporarily only for unchanged callers; they are not compatibility APIs and cannot receive new WP6 writes. Todo 8 performs caller cutover and deletes those old tables/writers in the same atomic change. No migration, old-schema reader, placeholder Work, mutable completion/expansion status or arbitrary JSON payload.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 6-9,11-16,22-27
  References: `src/sciretriever/catalog/models.py:96,156,193,205,227,258,312,641,674`; `schema.py`; `bootstrap.py`; `docs/specs/requirements.md:135-199,287-320`; owner schema decision in draft.
  Acceptance criteria: fresh bootstrap exposes target WP6 tables/constraints plus only the explicitly temporary old failure/event structures required until Todo 8; pre-identity diagnostic subject is representable without Work rows; self/cyclic merges and duplicate undo linkage reject; RawAsset immutability triggers remain; schema test proves no migration/legacy/task/expansion-status table. Todo 8 owns the final target-only schema assertion.
  QA scenarios: unittest happy creates representative diagnostic/curation/merge records in fresh SQLite; failure injects invalid subject, merge cycle, unknown action, oversized snapshot and FK violation and proves rollback. Evidence `.omo/evidence/wp6/task-2.txt`.
  Commit: N unless authorized | proposed `feat(catalog): define WP6 audit schema`

- [x] 3. Define typed curation and diagnostic domain contracts
  What to do / Must NOT do: TDD frozen, serializable, exhaustive contracts for product failure stages (`metadata`, `acquisition`, `analysis`, `expansion`), subject kinds, allowlisted reason/action/rerun guidance, curation actions/results/operation hashes, review decisions and safe snapshot values. Keep core neutral and catalog records infrastructure-only. No free-form exception/output contract, `Any`, compatibility codec or business workflow import into core.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 7-9,11-16
  References: `src/sciretriever/core/contracts.py`; `src/sciretriever/diagnostics/contracts.py`; `src/sciretriever/catalog/records.py`; `tests/test_diagnostics.py`; `AGENTS.md` dependency rules.
  Acceptance criteria: exhaustive round trips are canonical/deterministic; unknown enum/key, duplicate key, non-public identifier, path/URL/secret-like fields and unbounded values fail closed; Pyright reports zero diagnostics.
  QA scenarios: unittest happy round-trips each action/stage; failure feeds malformed/unknown/secret-bearing payloads. Evidence `.omo/evidence/wp6/task-3.txt`.
  Commit: N unless authorized | proposed `feat(core): define WP6 operation contracts`

- [x] 4. Define provider-neutral citation graph capability contracts
  What to do / Must NOT do: TDD neutral graph request/edge/page/result contracts supporting outgoing references and citing Works, stable public identifiers, deterministic ordering, pagination cursor and bounded provider calls. Add capability detection separate from ordinary metadata search. Do not put vendor dictionaries in core/catalog, pretend every provider supports graph queries, persist credentials/cursors, or impose a product document cap.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 22-27
  References: `src/sciretriever/integrations/models.py`; `src/sciretriever/discovery/providers/base.py`; `integrations/openalex.py`; `integrations/semantic_scholar.py`; `docs/specs/requirements.md:285-302`.
  Acceptance criteria: contracts express references/cited-by with exact source/target identifiers and deterministic page order; unsupported capability is explicit; malformed identifiers/cursors/vendor fields reject.
  QA scenarios: unittest happy decodes offline OpenAlex/Semantic Scholar-style pages into the same neutral edge set; failure covers unsupported provider, invalid cursor and identifier conflict. Evidence `.omo/evidence/wp6/task-4.txt`.
  Commit: N unless authorized | proposed `feat(integrations): define citation graph capability`

- [x] 5. Extend architecture, deletion and code-size gates before implementation
  What to do / Must NOT do: TDD architecture/governance checks enforcing new module direction: references/expansion may depend on completion contracts and provider-neutral graph capability protocols injected by CLI composition, but must never import concrete integrations/providers; catalog/core never import expansion/providers; CLI remains composition root; package construction stays in packaging; all write entry points use one config loader; no scheduler/mutable status/migration/compat modules. Implement the exact tokenizer-based diff-scoped pure-LOC decision from Verification strategy using Todo 1's immutable baseline, first verifying the manifest SHA against `task-1.txt`: new/baseline-small changed files <=250; baseline-oversized changed files strictly decrease and contain no new WP6 symbols; `core/package.py` unchanged. Add wheel deletion manifests and exact `scripts/governance_checks.py` modes used by final review: `--wp6-review-manifest PATH`, `--wp6-close PATH`, `--changed-python-max-pure-loc N --baseline-pure-loc PATH` combinable with manifest validation, and `--wp6-release-scan PATH`. Define strict argument schemas, canonical manifest hashing, closure allowlist enforcement and nonzero fail-closed exits with no writes.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 6-32
  References: `scripts/architecture_checks.py`; `scripts/governance_checks.py`; `tests/test_harness_governance.py`; `tests/test_completion_distribution_wp5.py`; `AGENTS.md:architecture boundaries`.
  Acceptance criteria: gates fail on synthetic forbidden imports/status tables/second parser/package builder/new oversized file/baseline-oversized growth/new WP6 symbol in a grandfathered file/changed `core/package.py`, and pass a mechanical-extraction fixture; all governance modes have direct happy/failure tests and never mutate inputs; architecture harness remains deterministic.
  QA scenarios: unittest happy runs target architecture fixtures; failure creates temporary forbidden AST/source manifests and observes exact rejection. Evidence `.omo/evidence/wp6/task-5.txt`.
  Commit: N unless authorized | proposed `test(architecture): enforce WP6 ownership`

- [x] 6. Make completion outcomes and unified counts truthful
  What to do / Must NOT do: TDD the Metis finding: a resolved target that exhausts before its stop is `exhausted`, never `succeeded`. Implement the canonical progress/count schema table above, including command applicability, aliases and reconciliation equations, while preserving deterministic per-target JSON and refreshed fact stages. Define shared invocation/catalog count helpers used later by all commands. Do not add persistent status or count historical failures as current progress.
  Parallelization: Wave 2 | Blocked by: 2,5 | Blocks: 7,22-32
  References: `src/sciretriever/completion/runner.py:37`; `pipeline.py:143`; `batch.py:14-152`; `tests/test_completion_batch_contracts_wp5.py`; `test_cli_completion_wp5.py`.
  Acceptance criteria: direct tests prove unresolved, exhausted, advanced, reused, duplicate, unexpected failure and interruption have distinct truthful counts; existing WP5 completion matrices remain green; catalog counts derive from one snapshot of facts.
  QA scenarios: unittest happy runs mixed batch and reconciles item/count totals; failure injects false advancement and exhaustion and proves no success count. Evidence `.omo/evidence/wp6/task-6.txt`.
  Commit: N unless authorized | proposed `fix(completion): report truthful outcomes`

- [x] 7. Build one redacted diagnostic write and projection boundary
  What to do / Must NOT do: TDD central catalog diagnostic repository/service accepting only typed allowlisted records, applying redaction before persistence, appending immutable history and projecting malformed historical rows as safe corruption diagnostics. Support pre-identity input fingerprint, Work/WorkVersion/processing/expansion subjects, latest/all history and deterministic filters. Do not persist raw exceptions, URLs, response bodies, headers, credentials, provider payloads or mutable current-failure flags.
  Parallelization: Wave 2 | Blocked by: 2,3,5,6 | Blocks: 8,11,25,28-32
  References: `src/sciretriever/diagnostics/{contracts,mapping,projection,redaction}.py`; `catalog/processing.py:132`; `catalog/assets.py:429`; `catalog/repository.py:304`; `tests/test_diagnostics.py`; `tests/test_redaction.py`.
  Acceptance criteria: fixed sentinel secrets and signed URLs are absent from DB bytes, stdout-shaped projections and exception text; filters by subject/stage/reason/action/retryability/latest return deterministic rows; diagnostic insertion never changes completion facts.
  QA scenarios: unittest happy writes/query all four product stages; failure injects nested secrets, malformed legacy JSON and oversized details and proves fail-closed safe output. Evidence `.omo/evidence/wp6/task-7.txt`.
  Commit: N unless authorized | proposed `feat(diagnostics): unify redacted failure records`

- [x] 8. Cut metadata, acquisition and analysis failure owners over to the diagnostic boundary
  What to do / Must NOT do: TDD each owner adapter: persist provider-total metadata failures keyed by normalized input fingerprint without placeholder; acquisition overall and bounded per-source details by WorkVersion/role; parser/analysis replacement failures by processing target while preserving old current. Cut every caller to the typed boundary, then delete old generic failure/event writers and tables from the fresh schema in this same change; update deletion manifests. Do not leave a compatibility view/adapter, classify exhausted as unexpected, leak source data, or let history affect rerun selection.
  Parallelization: Wave 2 | Blocked by: 7 | Blocks: 25,28-32
  References: `src/sciretriever/discovery/search.py`; `acquisition/service.py`; `acquisition/attempt_details.py`; `catalog/assets.py`; `catalog/processing.py`; `catalog/parser_attempts.py`; `analysis/service.py`; existing failure tests.
  Acceptance criteria: four offline failures persist typed reason/action; metadata failure creates zero Works; acquisition source details remain bounded/redacted; failed force analysis preserves COMPLETE and prior package/current; rerun success leaves history but current progress is successful; fresh schema and wheel contain only the target diagnostic structures and no generic writer/table.
  QA scenarios: unittest happy queries each persisted owner failure; failure scans DB/output for sentinel secret and asserts zero placeholder/mutated current rows. Evidence `.omo/evidence/wp6/task-8.txt`.
  Commit: N unless authorized | proposed `refactor: route failures through diagnostics`

- [x] 9. Extend the one strict TOML schema and implement offline `config check`
  What to do / Must NOT do: TDD `ExpansionConfig`, `CurationConfig`, `ExportConfig`, default 30-second document interval and any missing format/interval fields through the existing loader/key tables. Add `config check` static/filesystem/profile/secret-reference report using existing selection precedence and preflight validators. Disabled capabilities skip their secret/profile checks. Do not add a parser, alter precedence, rewrite TOML or make network calls by default.
  Parallelization: Wave 2 | Blocked by: 2,5 | Blocks: 10,28-32
  References: `src/sciretriever/config.py:49-223,897-924`; `config.example.toml`; `cli/main.py:74-259`; `cli/preflight.py`; `acquisition/preflight.py`; `tests/test_toml_config.py`; owner config decision.
  Acceptance criteria: unknown/type/conflict/bounds failures are precise and redacted; default command performs zero mocked network calls; enabled-only paths/secrets/profile checks work; CLI > TOML > built-in default remains invocation-local.
  QA scenarios: unittest/subprocess happy checks minimal and fully enabled configs; failure covers unknown key, symlink replacement, insecure secret file, missing enabled secret/profile and disabled-capability omission. Evidence `.omo/evidence/wp6/task-9.txt`.
  Commit: N unless authorized | proposed `feat(config): add WP6 readiness checks`

- [x] 10. Add explicit bounded runtime readiness and document-start pacing
  What to do / Must NOT do: TDD `config check --runtime` adapters for enabled graph providers, acquisition providers, MinerU and LLM using bounded read-only health/identity probes and central redaction. Add a global monotonic document-start gate, default 30 seconds, composed into every foreground acquisition/expansion entry while retaining stricter provider/host budgets. No sleeping in unit tests; inject clock/sleeper. Do not start services, upload documents or probe disabled capabilities.
  Parallelization: Wave 2 | Blocked by: 9 | Blocks: 25,28-32
  References: `src/sciretriever/acquisition/controls.py`; `cli/acquisition_runtime.py`; `normalization/mineru_client.py:252`; analysis provider contracts; `tests/test_cli.py`; `test_toml_config.py`.
  Acceptance criteria: fake clock proves adjacent new-document starts honor `max(global interval, applicable provider budget)`; reused/completed targets do not consume a new-document slot; runtime check probes only enabled endpoints with timeout and redacted failures.
  QA scenarios: unittest happy checks enabled fake services and pacing timestamps; failure injects timeout/wrong identity/secret-bearing response and proves bounded failure, no document upload and no leaked sentinel. Evidence `.omo/evidence/wp6/task-10.txt`.
  Commit: N unless authorized | proposed `feat(runtime): add readiness and pacing`

- [x] 11. Implement the atomic curation operation owner and guarded undo engine
  What to do / Must NOT do: TDD one `CatalogEngine.critical_transaction()` owner that validates an operation, captures allowlisted before state/hash, applies connection-level helpers, captures after state/hash, appends immutable operation record and supports compensating undo only when current state equals the original after-hash. Each operation and undo must have failpoints before/after every table family. Do not nest repository transactions, delete original audit rows, store secrets/runtime paths or allow undo to overwrite later edits.
  Parallelization: Wave 3 | Blocked by: 2,3,7 | Blocks: 12-16
  References: `catalog/engine.py:47-64`; `catalog/repository.py:171`; new contracts/schema; `tests/test_completion_rollback_wp5.py` failpoint style.
  Acceptance criteria: success writes mutation and audit atomically; every injected failpoint restores exact pre-snapshot; undo appends `undo_of` operation; stale/concurrent undo rejects with zero changes.
  QA scenarios: unittest happy applies/undoes a representative operation; failure iterates transaction failpoints and stale hash. Evidence `.omo/evidence/wp6/task-11.txt`.
  Commit: N unless authorized | proposed `feat(catalog): add curation operation owner`

- [x] 12. Implement review queues, Work merge and WorkVersion regroup
  What to do / Must NOT do: TDD query/resolve identifier and generalized review items; merge source Work into target tombstone with cycle/conflicting-identifier guards; reparent all WorkVersions/manual tags/reference targets/identifiers/review links while preserving observations/assets/current/package rows; regroup one explicit WorkVersion with evidence and recompute both preferred pointers. Undo through Todo 11. Never physically delete Work/WorkVersion/evidence or fuzzy merge.
  Parallelization: Wave 3 | Blocked by: 11 | Blocks: 16,28-32
  References: `catalog/models.py:96,156,283,312,509`; `catalog/identity.py`; `catalog/library.py:200,915,993`; `tests/test_identity.py`; `test_catalog_wp1.py`; FR-1/FR-2.
  Acceptance criteria: merge/regroup preserve row counts and stable IDs, reject self/cycle/DOI conflicts, produce resolved review and exact before/after audit; undo restores topology and preferred pointers without changing RawAsset/observation/package bytes.
  QA scenarios: unittest happy merges preprint/formal Works then undoes; failure covers cycle, conflicting DOI, stale undo and each transaction failpoint. Evidence `.omo/evidence/wp6/task-12.txt`.
  Commit: N unless authorized | proposed `feat(catalog): add reversible Work curation`

- [x] 13. Route preferred version set/clear through audited curation
  What to do / Must NOT do: TDD explicit set/clear operations, before/after preferred/manual flag snapshot, deterministic recomputation on clear and guarded undo. Automatic observation updates must not overwrite active manual preferred. Replace direct public mutation paths with connection helpers under Todo 11; do not keep an unaudited parallel API.
  Parallelization: Wave 3 | Blocked by: 11 | Blocks: 16,28-32
  References: `catalog/library.py:993-1029`; `catalog/bootstrap.py:12-35`; `tests/test_catalog_wp1.py`; FR-1 preferred rules.
  Acceptance criteria: set survives new observations, clear recomputes exact deterministic preferred, undo restores prior pointer/flag, stale undo rejects, and only one audit record is appended per action.
  QA scenarios: unittest happy set/new observation/clear/undo sequence; failure targets foreign version, merged Work and concurrent preferred edit. Evidence `.omo/evidence/wp6/task-13.txt`.
  Commit: N unless authorized | proposed `feat(catalog): audit preferred selection`

- [x] 14. Route manual metadata and manual tags through audited curation
  What to do / Must NOT do: TDD metadata set/clear and tag add/remove with allowlisted fields, canonical recomputation, manual/generated separation, compensating undo and stale guards. Remove unaudited public methods after cutover. Do not delete provider observations/generated tags or let reanalysis overwrite manual values.
  Parallelization: Wave 3 | Blocked by: 11 | Blocks: 16,28-32
  References: `catalog/manual_metadata.py`; `catalog/canonical_projection.py:31-53`; `catalog/library.py:1196`; `catalog/models.py:205,258`; `tests/test_catalog_wp1.py`; `test_analysis_wp44.py`.
  Acceptance criteria: set/clear/add/remove update safe canonical view, reanalysis preserves manual values/links, undo restores exact link/value, duplicate no-op has deterministic disposition and no misleading audit.
  QA scenarios: unittest happy performs mutations, reanalysis fixture and undo; failure covers unsupported field/tag, stale undo and promotion rollback. Evidence `.omo/evidence/wp6/task-14.txt`.
  Commit: N unless authorized | proposed `feat(catalog): audit manual curation`

- [x] 15. Implement evidence-backed reversible Author merge
  What to do / Must NOT do: TDD explicit source/target Author merge requiring compatible ORCID or bounded user evidence, source tombstone/lineage, authorship reassignment with deterministic collision handling, audit snapshots and undo. Preserve author observations/affiliation strings and WorkVersion authorship order. Never merge by name similarity or delete source evidence.
  Parallelization: Wave 3 | Blocked by: 12 | Blocks: 16,28-32
  References: `catalog/models.py:227`; `catalog/library.py:1123-1143`; `tests/test_catalog_wp1.py:176`; FR-7 and owner schema approval.
  Acceptance criteria: compatible merge reuses target and preserves ordered authorships; collision policy is deterministic and recorded; ORCID conflict/name-only merge rejects; undo restores source and links; failpoints roll back all tables.
  QA scenarios: unittest happy merges duplicate ORCID Authors and undoes; failure covers conflicting ORCID, missing evidence, duplicate authorship position and stale undo. Evidence `.omo/evidence/wp6/task-15.txt`.
  Commit: N unless authorized | proposed `feat(catalog): add reversible Author merge`

- [x] 16. Expose explicit curation/review/audit/undo CLI
  What to do / Must NOT do: TDD `library review`, `merge-work`, `regroup-version`, `preferred set|clear`, `metadata set|clear`, `tag add|remove`, `author merge`, `audit` and `undo` parsing/composition. Require exact IDs and evidence where contracts require it; render deterministic before/after/operation IDs and safe failures. Do not add implicit full-library mutations, confirmation prompts, direct SQL or duplicate transaction owners.
  Parallelization: Wave 3 | Blocked by: 12-15 | Blocks: 28-32
  References: `src/sciretriever/cli/library.py`; `cli/main.py`; curation service/contracts; FR-18.
  Acceptance criteria: each command has `--help`, happy mutation and invalid/stale path tests; JSON/output exposes only safe canonical/audit values; exit codes distinguish success, invalid input and operation conflict.
  QA scenarios: subprocess/tmux happy runs review→merge→audit→undo on temp catalog; failure omits selector/evidence and attempts stale undo. Evidence `.omo/evidence/wp6/task-16.txt`.
  Commit: N unless authorized | proposed `feat(cli): expose library curation`

- [x] 17. Freeze reading versus package export contracts
  What to do / Must NOT do: TDD explicit export mode types and selectors. Reading mode uses bounded canonical projection and opt-in safe full references; package mode selects WorkVersion and optional exact package version/hash, always retains intrinsic package references and delegates to packaging. Define replay/new-version dispositions and output destination safety. Do not let `--include-references` strip package data or let library reconstruct package internals.
  Parallelization: Wave 4 | Blocked by: 1,5 | Blocks: 18-21
  References: `cli/library.py:50-80,174`; `catalog/library_projection.py`; `core/package.py:949,1068`; `packaging/publisher.py:71-257`; owner export decision.
  Acceptance criteria: contract rejects incompatible selectors/options and documents package reference invariance; canonical serialization is deterministic and secret-free.
  QA scenarios: unittest happy validates reading/package requests; failure covers include-references on package if treated as mutation, missing exact selector and unsafe output target. Evidence `.omo/evidence/wp6/task-17.txt`.
  Commit: N unless authorized | proposed `feat(core): define export modes`

- [x] 18. Add safe reading export with optional reference projection
  What to do / Must NOT do: TDD a bounded safe reference DTO and repository query preserving reference order, resolved public identifiers and unresolved safe citation text; add it only under reading `--include-references`. Preserve current atomic JSON/JSONL filesystem protections. Do not expose provider observations, raw provenance, diagnostic/source details, storage paths or evidence internals.
  Parallelization: Wave 4 | Blocked by: 17 | Blocks: 20,21,28-32
  References: `catalog/library_read.py:159-199`; `catalog/library_projection.py`; `tests/test_cli_library_wp2.py`; `catalog/version_references` schema; FR-16/FR-18.
  Acceptance criteria: default reading output is unchanged except approved mode envelope; opt-in references are deterministic and complete; cyclic/duplicate edges do not duplicate rows; symlink/hardlink/sidecar protections remain.
  QA scenarios: unittest happy exports JSON/JSONL with/without references; failure includes hostile raw citation/provider payload and unsafe output paths. Evidence `.omo/evidence/wp6/task-18.txt`.
  Commit: N unless authorized | proposed `feat(library): export safe references`

- [x] 19. Add verified immutable package selection and re-export
  What to do / Must NOT do: TDD packaging APIs to load/verify exact latest/version/hash snapshot for a WorkVersion, atomically write canonical bytes to a safe destination, and create a new package only through existing publisher when current material hash changed. Unchanged current input replays. Do not mutate old snapshots, normalize inside library, or expose internal catalog paths.
  Parallelization: Wave 4 | Blocked by: 17 | Blocks: 20,21,28-32
  References: `packaging/publisher.py:71-100,161-257`; `catalog/packages.py:201-281`; `core/package.py`; `tests/test_package.py`; `test_package_publication.py`; `test_analysis_wp44.py:551`.
  Acceptance criteria: old bytes/hash remain identical after current replacement; unchanged export replays; changed current creates monotonic new version; tampered package fails verification; concurrent identical export converges.
  QA scenarios: unittest happy publish/replay/change/re-export sequence; failure tampers bytes/hash and targets unsafe destination. Evidence `.omo/evidence/wp6/task-19.txt`.
  Commit: N unless authorized | proposed `feat(packaging): export verified snapshots`

- [x] 20. Wire explicit reading and package export CLI modes
  What to do / Must NOT do: TDD parser/composition for `library export --mode reading|package`, explicit selectors, format/path/version/hash and reading-only `--include-references`; preserve one package owner and safe atomic writer. Do not retain ambiguous legacy export flags if they conflict with the final contract; direct delete/cutover is authorized.
  Parallelization: Wave 4 | Blocked by: 18,19 | Blocks: 21,28-32
  References: `cli/library.py`; `cli/package.py`; `cli/main.py`; `README.md:library/export`; owner direct-deletion decision.
  Acceptance criteria: help and subprocess tests cover both modes, invalid option combinations fail before side effects, output reports snapshot identity/hash/disposition, and package references cannot be omitted.
  QA scenarios: tmux/subprocess happy exports both modes from temp catalog; failure combines invalid mode/options and confirms no output/temp residue. Evidence `.omo/evidence/wp6/task-20.txt`.
  Commit: N unless authorized | proposed `feat(cli): expose explicit export modes`

- [x] 21. Harden export redaction, filesystem and immutability boundaries
  What to do / Must NOT do: TDD fixed sentinel secrets and hostile filesystem targets through both export modes; scan output bytes, terminal text and catalog for runtime paths/diagnostics/provider observations. Add crash-before/after-rename recovery and package concurrent replay checks. Do not weaken existing library/package tests.
  Parallelization: Wave 4 | Blocked by: 20 | Blocks: 28-32
  References: `tests/test_cli_library_wp2.py`; `test_package_publication.py`; `storage` atomic publication patterns; `diagnostics/redaction.py`.
  Acceptance criteria: no secret/runtime material appears; sidecar/symlink/hardlink races reject; old packages remain immutable; interrupted reading export leaves no accepted partial file.
  QA scenarios: unittest happy exports to normal target; failure exercises symlink swap, hardlink, crash failpoints and secret payload scan. Evidence `.omo/evidence/wp6/task-21.txt`.
  Commit: N unless authorized | proposed `test(export): enforce safe publication`

- [x] 22. Implement offline graph-capable provider adapters
  What to do / Must NOT do: TDD explicit OpenAlex/Semantic Scholar graph adapters only where their existing integration clients can support references/cited-by; convert offline responses into neutral contracts, paginate deterministically, bound each request and redact failures. Register capability separately from metadata discovery. Do not make real requests, duplicate shared transport, persist cursor/auth material or claim unsupported providers.
  Parallelization: Wave 5 | Blocked by: 4,5,6 | Blocks: 23-27
  References: `integrations/openalex.py`; `integrations/semantic_scholar.py`; discovery provider HTTP fixtures; `network/secure.py`; graph contracts from Todo 4.
  Acceptance criteria: fixture pages in varied completion/order yield identical edge candidates; cited-by discovers unknown identifiers; unsupported/partial/rate-limited provider returns typed redacted diagnostic and siblings continue.
  QA scenarios: unittest happy maps references and cited-by pages; failure covers pagination cycle, malformed edge, timeout and sentinel secret. Evidence `.omo/evidence/wp6/task-22.txt`.
  Commit: N unless authorized | proposed `feat(integrations): add citation graph adapters`

- [x] 23. Implement deterministic reference resolution and retry
  What to do / Must NOT do: TDD catalog/reference service that resolves stored unresolved citations and graph candidates by stable identifiers/exact approved identity rules, preserves raw order/text/evidence, appends diagnostics for unresolved/conflict and supports later rerun resolution. Local reverse edges are read first; remote edges fill unknown Works through metadata target resolution. Do not guess, fuzzy/LLM merge, duplicate edges or delete unresolved evidence.
  Parallelization: Wave 5 | Blocked by: 2,4,7,22 | Blocks: 24-27
  References: `catalog/models.py:509`; `catalog/library.py:1232-1256`; `catalog/identity.py`; `discovery/search.py` exact DOI; FR-16; tests/library graph fixtures.
  Acceptance criteria: unresolved→resolved rerun creates/reuses exactly one Work, preserves original raw reference/order and no duplicate observations/assets; conflict remains unresolved with safe diagnostic.
  QA scenarios: unittest happy resolves DOI and local cited-by then reruns; failure covers missing identifier, conflicting DOI/title and duplicate provider edges. Evidence `.omo/evidence/wp6/task-23.txt`.
  Commit: N unless authorized | proposed `feat(references): resolve citation targets`

- [x] 24. Implement deterministic breadth-first expansion core
  What to do / Must NOT do: TDD a process-local expansion service with directions references/cited-by/both, depth 0/N, stable Work `visited`, `queued` and current-layer sets, deterministic Work ordering, local-first edge collection and provider fill. Use only preferred COMPLETE WorkVersion for discovered Work frontier; explicit WorkVersion seed may supply depth 0. Stream/batch layer data to bounded memory/concurrency without hidden document cap. Do not persist scheduler/frontier status.
  Parallelization: Wave 5 | Blocked by: 6,22,23 | Blocks: 25-27
  References: `completion/pipeline.py`; `catalog/completion_facts.py`; `catalog/library_read.py`; `docs/specs/requirements.md:293-302`; owner frontier decision.
  Acceptance criteria: fixed graph depth 0/1/2 with cycles/duplicate paths visits each Work once, reports deterministic layer discovery/existing counts, uses preferred COMPLETE only, and is not truncated past 100 edges.
  QA scenarios: unittest happy runs cyclic high-fanout fixture twice and compares layers; failure covers invalid depth, no COMPLETE preferred version and provider branch error. Evidence `.omo/evidence/wp6/task-24.txt`.
  Commit: N unless authorized | proposed `feat(expansion): add breadth-first traversal`

- [x] 25. Complete each expansion layer through the shared WP5 pipeline
  What to do / Must NOT do: TDD adapter from discovered DOI/Work targets into the existing `CompletionPipeline` and truthful batch outcomes. Wait until all targets in the layer reach terminal invocation outcomes before constructing next frontier; only COMPLETE contributes edges. Branch exhaustion/failure stops that branch, persists diagnostic and allows siblings. Apply global document-start pacing. Do not copy metadata/acquisition/analysis logic or add expansion completion state.
  Parallelization: Wave 5 | Blocked by: 7-10,24 | Blocks: 26,27,28-32
  References: `completion/{pipeline,runner,batch}.py`; `cli/completion_runtime.py`; `catalog/completion_facts.py`; `tests/test_completion_wp5.py`.
  Acceptance criteria: real temp SQLite/storage fixture completes each layer before next, one missing-PDF/analysis branch remains at fact-derived stage while siblings expand, rerun skips COMPLETE and retries pending without duplicate assets/current.
  QA scenarios: unittest happy expands DOI→COMPLETE layers; failure injects metadata/acquisition/analysis exhaustion and verifies sibling continuation/count reconciliation. Evidence `.omo/evidence/wp6/task-25.txt`.
  Commit: N unless authorized | proposed `feat(expansion): reuse completion pipeline`

- [x] 26. Add expansion interruption, diagnostic and layer reporting contracts
  What to do / Must NOT do: TDD cooperative stop that stops starting new Works, safely finishes/cancels current bounded operations, marks current/unstarted invocation outcomes interrupted, preserves completed facts and emits every canonical per-layer field: provider_returned, deduplicated_works, created, reused, discovered, existing, selected, unique_targets, succeeded, completed, exhausted, failed, duplicates and interrupted, plus safe branch diagnostics. `selected = succeeded + exhausted + failed + duplicates + interrupted`, `unique_targets = selected - duplicates`, and completed equals the layer succeeded subset verified COMPLETE. No durable pause/resume or misleading success exit.
  Parallelization: Wave 5 | Blocked by: 25 | Blocks: 27,28-32
  References: `completion/runner.py`; `batch.py`; `cli/search.py` interruption patterns; diagnostics service; FR-17.
  Acceptance criteria: Ctrl+C returns 130, no next-layer starts, completed assets/current remain, count totals reconcile, rerun converges and diagnostic history does not alter facts.
  QA scenarios: unittest/tmux happy completes two layers; failure interrupts mid-layer at fixed hook then reruns and compares catalog snapshot. Evidence `.omo/evidence/wp6/task-26.txt`.
  Commit: N unless authorized | proposed `feat(expansion): report layers and interruption`

- [x] 27. Expose `expand` CLI and strict expansion configuration
  What to do / Must NOT do: TDD parser/composition for explicit seed Work/WorkVersion/query selectors, default direction references, cited-by/both, required finite depth, provider capability selection, storage/catalog/runtime config and deterministic JSON. No implicit full-library seed, document cap, all-version frontier or direct service wiring in command module.
  Parallelization: Wave 5 | Blocked by: 26 | Blocks: 28-32
  References: `cli/main.py`; `cli/search.py`; `cli/completion_runtime.py`; strict config; expansion service; `tests/test_cli_completion_wp5.py`.
  Acceptance criteria: `--help`, depth 0, all directions, invalid/missing selector, unsupported graph provider, partial branch and exit 130 tests pass; command module delegates through composition runtime.
  QA scenarios: tmux/subprocess happy expands cyclic offline fixture; failure omits selector, uses negative depth/unsupported provider and interrupts. Evidence `.omo/evidence/wp6/task-27.txt`.
  Commit: N unless authorized | proposed `feat(cli): expose citation expansion`

- [x] 28. Expose `failures` and converge deterministic progress JSON
  What to do / Must NOT do: TDD `failures` filters by subject/object, stage, role/source, reason/action, retryability, outcome and latest/all; acquisition details require explicit expansion and stay redacted. Apply one shared count vocabulary to search/download/analyze/expand without breaking existing deterministic fields except the approved exhausted correction. Do not query completion state from diagnostic history or display raw messages.
  Parallelization: Wave 6 | Blocked by: 6-10,16,21,27 | Blocks: 29-32
  References: diagnostics query boundary; `cli/{search,download,analyze}.py`; `cli/rendering.py`; FR-18; existing CLI completion tests.
  Acceptance criteria: four-stage seeded failures are queryable with correct reason/action/rerun guidance; all command count totals reconcile; PDF missing is exhausted/missing, never accepted/succeeded; output secret scan is empty.
  QA scenarios: subprocess happy queries each stage/latest/all and runs command count matrix; failure requests raw source details without opt-in and injects malformed historical row. Evidence `.omo/evidence/wp6/task-28.txt`.
  Commit: N unless authorized | proposed `feat(cli): expose failures and progress`

- [x] 29. Synchronize command help, example TOML and responsibility documentation
  What to do / Must NOT do: TDD documentation/`--help` snapshots, then update `config.example.toml`, README current behavior, three ideal specs only where clarified by approved decisions, execution-plan language, code-doc map and provider/MinerU guides. Update implementation-progress capability rows to implemented but leave exact final test counts/release receipt fields explicitly pending Todo 32. Do not claim gates already passed, duplicate progress truth in plans, expose secrets or alter already-approved scope.
  Parallelization: Wave 6 | Blocked by: 28 | Blocks: 30-32
  References: `docs/governance/code-doc-map.md`; `README.md`; `config.example.toml`; `docs/specs/{requirements,system-design,technical-architecture}.md`; `implementation-progress.md`; `docs/planning/literature-library-execution.md`; `scripts/documentation_checks.py`.
  Acceptance criteria: `uv run --frozen python scripts/harness.py docs` passes; every help/config field is documented once with correct default/precedence; README describes only implemented behavior; implementation progress names Todo 32 as the sole pending final-count/release receipt update and does not invent counts.
  QA scenarios: harness happy validates docs/help/config; failure fixtures detect stale command, unknown example key, duplicate progress and broken link. Evidence `.omo/evidence/wp6/task-29.txt`.
  Commit: N unless authorized | proposed `docs: document WP6 product surface`

- [x] 30. Add full offline WP6 product acceptance fixture
  What to do / Must NOT do: TDD `tests/test_wp6_acceptance.py` plus an executable offline hands-on driver `scripts/wp6_manual_qa.py`. Both exercise search/metadata, completion, cyclic expansion with cited-by provider, one failed branch, failures query, curation and stale undo, reanalysis/manual preservation, reading/package export, config checks, interruption and rerun on real temporary SQLite/storage. The driver accepts only `--work-root PATH`, creates all fixtures beneath it, prints one deterministic JSON summary, returns 0 only when all assertions pass, and removes its root unless `--keep-on-failure` is explicitly used. Use fixed clock, programmatic valid two-page PDF, fake providers/MinerU/LLM and no user data.
  Parallelization: Wave 6 | Blocked by: 28,29 | Blocks: 31,32
  References: `tests/test_completion_wp5.py`; corrected `.omo/evidence/wp5/manual-qa.txt`; `tests/test_analysis_wp44.py`; package publication fixtures; all WP6 acceptance rows in requirements.
  Acceptance criteria: fixture and driver prove all cross-component invariants and canonical count equations/hashes; `uv run --frozen python scripts/wp6_manual_qa.py --work-root /tmp/sciretriever-wp6-manual` exits 0, prints `{"status":"passed"...}` and removes that root; test passes standalone twice and in full discovery order.
  QA scenarios: unittest happy runs `test_wp6_acceptance.py` twice; driver happy uses the exact command above; failure tests invoke `--keep-on-failure` with deterministic branch/transaction/config/export injections, validate rollback/redaction, inspect the retained root, then remove it. Evidence `.omo/evidence/wp6/task-30.txt`.
  Commit: N unless authorized | proposed `test(wp6): add offline product acceptance`

- [x] 31. Run release gates, wheel parity and installed CLI manual QA
  What to do / Must NOT do: Run scoped tests, all WP1-WP6 regressions, Pyright, docs, architecture, quick and full harness, clean wheel build/source parity/retired module absence, `git diff --check`, secret scans and changed-file pure-LOC gate. Install/use the built wheel in an isolated temp environment or execute its entry point without changing dependencies. Clean `build/`, `dist/` and temp roots. Do not access live services or manufacture pass evidence.
  Parallelization: Wave 6 | Blocked by: 30 | Blocks: 32
  References: `AGENTS.md` quality commands; `scripts/harness.py`; `tests/test_completion_distribution_wp5.py`; `pyproject.toml`; all task evidence.
  Acceptance criteria: every gate exits 0; exact security/quality modules `test_curation_wp6.py`, `test_curation_rollback_wp6.py`, `test_diagnostics_wp6.py`, `test_config_check_wp6.py`, `test_expansion_wp6.py`, `test_export_wp6.py`, `test_security_wp6.py`, `test_wp6_acceptance.py`, `test_wp6_distribution.py` and `test_architecture_wp6.py` exist and pass; the exact diff-scoped LOC policy passes against Todo 1 baseline; wheel matches source and excludes retired paths; installed CLI exposes final commands; worktree has no generated artifacts.
  QA scenarios: tmux happy runs `--version`, root/subcommand `--help`, config check offline/runtime fake, failures, curation/undo, export and expand; failure runs invalid selector/config/stale undo/interruption and verifies exits/state. Evidence `.omo/evidence/wp6/task-31.txt`.
  Commit: N unless authorized | proposed `test(wp6): pass release gates`

- [x] 32. Prepare immutable pre-review evidence and final diff inventory
  What to do / Must NOT do: First add/update a documentation fixture requiring implementation progress to contain the exact observed Todo 31 full-harness count and release-gate receipt, run it failing, update only `docs/governance/implementation-progress.md` and rerun docs green. Re-read WP6 and write `.omo/evidence/wp6/task-32.txt` with the requirement map, pre-manifest diff/name-status inventory, pure LOC, wheel/deletion manifests and proposed commit map, but no claim that this is the final inventory or that manifest validation passed. Then mark Todo 32 complete in the plan. Only after that checkbox write, read `baseline_commit` from Todo 1's baseline manifest and task receipt, require exact equality plus `git cat-file -e "$baseline_commit^{commit}"`, compute the exact pre-closure `plan_sha256`, and create `.omo/evidence/wp6/review-manifest.json` with schema `{version:1, baseline_commit, plan_sha256, product_files:[{path,sha256}], deleted_files:[{path,baseline_sha256}], evidence_files:[{path,sha256}], commands:[{name,command,exit_code,receipt}], product_manifest_sha256}`. Never recapture `HEAD`. Define the universes exactly: derive tracked changes with `git diff --no-renames --name-status -z "$baseline_commit" --` and untracked non-ignored paths with `git ls-files --others --exclude-standard -z`; normalize untracked entries as added, then sort by path. After excluding the five closure-allowlist paths and every path under `.omo/evidence/wp6/`, `product_files` contains every added or modified candidate that is a regular non-symlink file, while `deleted_files` contains every deleted tracked candidate with SHA256 of its exact `baseline_commit:path` blob. `evidence_files` contains every regular non-symlink file under `.omo/evidence/wp6/` except exactly `review-manifest.json`, `task-32-validation.txt`, `final-f1.json` through `final-f4.json`, `post-closure.txt`, and `closure-manifest.json`. The plan is excluded from product arrays and bound only by `plan_sha256`; ledger/Boulder are closure controls and excluded. Treat renames as delete-plus-add; reject conflicts, type changes, missing hashes, duplicate/extra entries, symlinks, non-regular files or any status outside added/modified/deleted. Include `task-32.txt` in evidence files. Sort arrays and canonicalize object keys. Digest preimage is canonical compact JSON of the first seven fields with `product_manifest_sha256` excluded; set it to SHA256(preimage). External `full_manifest_sha256` is SHA256(exact final manifest bytes). Validate the final manifest, then write `.omo/evidence/wp6/task-32-validation.txt` containing exact plan/product/full hashes, validator command/exit, and the actual final pre-review Git diff/name-status inventory captured after `review-manifest.json` exists; this external receipt is deliberately outside both digest arrays. Do not modify the plan/product/manifest-bound evidence inputs after manifest creation, mark F1-F4/33/WP6 complete, commit or mutate reviewed files.
  Parallelization: Wave 6 | Blocked by: 31 | Blocks: F1-F4
  References: `.omo/plans/wp6-product-closeout.md`; `.omo/start-work/ledger.jsonl`; `.omo/boulder.json`; `docs/governance/implementation-progress.md`; `AGENTS.md:Git policy`.
  Acceptance criteria: final progress fixture red-to-green records Todo 31 count/receipts; task-32 pre-manifest receipt is bound; plan SHA already reflects Todos 1-32 complete and F1-F4/33 open; validator independently reconstructs the exact changed/untracked/deleted product universe and evidence universe and recomputes every current/baseline file hash, preimage, product/full/plan identity; deleted paths cannot be restored or substituted without failure; the manifest excludes itself explicitly, validation receipt is external and records the truthful final pre-review inventory without digest recursion; no bound byte changes or Git mutation occurs.
  QA scenarios: Bash happy runs `uv run --frozen python scripts/governance_checks.py --wp6-review-manifest .omo/evidence/wp6/review-manifest.json` after the exact write order and records `.omo/evidence/wp6/task-32-validation.txt`; failure copies manifest to `/tmp`, changes one product/evidence/plan byte, and requires nonzero stale-hash rejection without workspace mutation. Bound evidence `.omo/evidence/wp6/task-32.txt`; external validation evidence `.omo/evidence/wp6/task-32-validation.txt`.
  Commit: N | receipt-only pre-review task

- [x] 33. Close WP6 after all final approvals without Git overreach
  Closure commitment before execution: `closure_manifest_sha256=6d0ecce7062516e233f9fecf29b282333374a4827a211baf282a6e7dfb6927ec`.
  What to do / Must NOT do: Each F1-F4 receipt is strict JSON `{role,session_id,plan_sha256,product_manifest_sha256,full_manifest_sha256,verdict,commands:[{command,exit_code}]}` with `verdict="APPROVE"`; reviewers compute both digests independently. First run `uv run --frozen python scripts/governance_checks.py --wp6-close .omo/evidence/wp6/review-manifest.json` and require nonzero because F1-F4/33 are open. After all receipts bind the same plan/product/full-manifest digests, capture exact pre-transition ledger/Boulder bytes, append the four receipt identities/hashes to the ledger, set Boulder completed, and capture exact post-transition bytes. Write `.omo/evidence/wp6/post-closure.txt` with the four receipt hashes, pre/post ledger/Boulder hashes, unchanged product/full-manifest digests and pre-review plan digest. Then write canonical compact UTF-8 `.omo/evidence/wp6/closure-manifest.json` with schema `{version:1,plan_sha256,product_manifest_sha256,full_manifest_sha256,receipt_files:[{path,sha256}],post_closure:{path,sha256},ledger:{path,pre_sha256,post_sha256,pre_base64,appended_base64},boulder:{path,pre_sha256,post_sha256,pre_base64,post_base64}}`, sorted receipt paths, RFC 4648 base64 without whitespace, and no self-hash. The validator decodes all snapshots, requires `current ledger bytes == pre bytes + appended bytes`, verifies both ledger hashes, parses only the appended JSONL records and requires exactly the four approved receipt identities/hashes, compares current Boulder bytes to decoded post bytes, verifies both Boulder hashes, parses both strict JSON snapshots and permits only the planned active-to-completed fields to differ. Compute SHA256 of exact closure-manifest bytes. Finally mark F1-F4 and Todo 33 complete and replace only the reserved 64-zero commitment with that digest. The closure validator reads the post-closure plan as UTF-8 with exact LF bytes, requires exactly the five named headings `33.`, `F1.`, `F2.`, `F3.`, `F4.` to contain `[x]` and exactly one lowercase 64-hex closure commitment, verifies that commitment against exact closure-manifest bytes and every receipt/file/control transition it binds, reconstructs pre-closure plan bytes in memory by changing only those five heading markers to `[ ]` and restoring the commitment to 64 zeroes, rejects any missing/duplicate heading, receipt/control mismatch or other plan-byte drift, and requires SHA256(reconstructed bytes) to equal manifest `plan_sha256`. Recompute the exact Todo 32 product/evidence path universes, preimage and unchanged review-manifest bytes; require product and full-manifest digests unchanged, then closure validator 0. Implementation progress was finalized Todo 32 and must not change. Authorized local commits may follow product identity validation; never push.
  Parallelization: Post-review closure | Blocked by: F1-F4 | Blocks: final handoff
  References: `.omo/evidence/wp6/final-f1.json` through `final-f4.json`; `.omo/start-work/ledger.jsonl`; `.omo/boulder.json`; `docs/governance/implementation-progress.md`; `AGENTS.md:Git policy`.
  Acceptance criteria: pre-change validator fails; four strict receipts bind identical pre-review plan, product and full-manifest hashes and APPROVE; post validator 0 after byte-exact five-checkbox-plus-commitment reconstruction; any seventh or non-allowlisted plan change fails; the post plan commitment anchors exact approval receipts, post-closure receipt and pre/post ledger/Boulder transitions through the non-self-hashing closure manifest; only closure allowlist differs; product digest and exact review-manifest/full hash remain unchanged; Git action matches authorization.
  QA scenarios: happy runs the exact pre-fail/write/recompute/commitment/post-pass sequence; failure copies the manifest to `/tmp` and tests missing/rejected/stale or replaced receipt, altered closure manifest/post receipt, ledger/Boulder pre/post mismatch, commitment mismatch, product drift and non-allowlisted closure write, each requiring nonzero with no workspace mutation. Todo 33 evidence is the allowlisted `post-closure.txt` plus `closure-manifest.json`; no separate task-33 file is written.
  Commit: N by default | proposed only if authorized: atomic commit series following Todo ownership

## Final verification wave
> Runs in parallel after Todos 1-32 and before post-review closure Todo 33. ALL must APPROVE the same final diff/evidence. Use at most two reviewer agents; surface results before Todo 33 declares completion.
- [x] F1. Plan compliance audit
  One goal/architecture reviewer runs `uv run --frozen python scripts/harness.py architecture`, `uv run --frozen python scripts/harness.py docs`, and `uv run --frozen python scripts/governance_checks.py --wp6-review-manifest .omo/evidence/wp6/review-manifest.json`; independently hashes exact plan and manifest bytes, reads diff/receipts, and checks must-have/must-not-have, owner decisions, dependency/deletion/docs. APPROVE requires all commands 0 and every requirement mapped. Write strict Todo 33 receipt JSON with exact `plan_sha256`, `product_manifest_sha256`, independently computed `full_manifest_sha256` and commands. Evidence `.omo/evidence/wp6/final-f1.json`.
- [x] F2. Code quality and security review
  The same reviewer runs exactly: `uv run --frozen pyright src/sciretriever tests scripts`; `uv run --frozen python -m unittest discover -s tests -p 'test_curation*_wp6.py'`; `uv run --frozen python -m unittest discover -s tests -p 'test_diagnostics_wp6.py'`; `uv run --frozen python -m unittest discover -s tests -p 'test_config_check_wp6.py'`; `uv run --frozen python -m unittest discover -s tests -p 'test_expansion_wp6.py'`; `uv run --frozen python -m unittest discover -s tests -p 'test_export_wp6.py'`; `uv run --frozen python -m unittest discover -s tests -p 'test_security_wp6.py'`; `git diff --check`; and `uv run --frozen python scripts/governance_checks.py --changed-python-max-pure-loc 250 --baseline-pure-loc .omo/evidence/wp6/baseline-pure-loc.json --wp6-review-manifest .omo/evidence/wp6/review-manifest.json`. APPROVE requires every command 0, diff-scoped LOC, transaction/undo/graph/filesystem/package/second-path clean. Independently validate hashes and write strict receipt. Evidence `.omo/evidence/wp6/final-f2.json`.
- [x] F3. Real manual QA
  A second reviewer first runs `uv run --frozen python scripts/governance_checks.py --wp6-review-manifest .omo/evidence/wp6/review-manifest.json` and independently hashes plan and exact manifest bytes; then runs `uv run --frozen python scripts/harness.py full` and in tmux `uv run --frozen python scripts/wp6_manual_qa.py --work-root /tmp/sciretriever-wp6-f3`. Driver covers offline/fake-runtime config, cyclic expand/interruption/rerun, four-stage failures, every curation/undo/stale undo, reading references off/on, package replay/new. APPROVE requires validator/harness/driver 0, JSON status passed, count equations, exits `2/1/130`, exact DB/hash, no secret/temp root. Write strict receipt with independently computed plan/product/full hashes. Evidence `.omo/evidence/wp6/final-f3.json`.
- [x] F4. Scope fidelity
  The hands-on reviewer runs exactly: `uv run --frozen python -m build --wheel --no-isolation`; `uv run --frozen python -m unittest discover -s tests -p 'test_wp6_distribution.py'`; `uv run --frozen python -m unittest discover -s tests -p 'test_architecture_wp6.py'`; `uv run --frozen python -m unittest discover -s tests -p 'test_security_wp6.py'`; `git diff --exit-code -- pyproject.toml uv.lock`; and `uv run --frozen python scripts/governance_checks.py --wp6-release-scan .omo/evidence/wp6/review-manifest.json`. Release scan fails on dependency/lock drift, unexpected status paths, compatibility/scheduler/second-path/secret/generated/runtime/user-data findings or manifest drift. After recording wheel assertions, run `rm -rf -- build dist && test ! -e build && test ! -e dist`. APPROVE requires every command including cleanup assertion 0. Independently validate hashes and write strict receipt JSON. Evidence `.omo/evidence/wp6/final-f4.json`.

## Commit strategy
- Planning does not authorize Git mutations during execution. Default: no commits, no push.
- If the user explicitly authorizes local commits in the execution session, use English Conventional Commits and stage only each todo's implementation plus direct tests. Follow dependency order: contracts/schema → diagnostics/config/counts → curation → export → expansion → CLI/docs/evidence.
- Keep every implementation with its direct tests; pure documentation and `.omo` closure may be separate. Inspect `GIT_MASTER=1 git status`, diff, staged diff and recent log before every commit sequence. Never amend, rebase or push unless separately requested.
- Preserve concurrent/user changes. No destructive reset/checkout and no staging generated `build/`, `dist/`, runtime catalogs, assets, credentials or corpus data.

## Success criteria
- Todos 1-30 and Todo 32 have red-to-green TDD evidence, direct/affected regressions and happy/failure QA receipts; Todo 31 has exact receipt-only release evidence; F1-F4 all APPROVE the same immutable product manifest using no more than two reviewer agents; Todo 33 proves pre-closure failure, changes only the closure allowlist, anchors all approval/control evidence through the plan's closure-manifest commitment, proves unchanged product identity and closes to green.
- Fresh schema supports append-only redacted diagnostics and guarded reversible curation without migrations, placeholders, mutable completion/expansion state or evidence deletion.
- `search`, `download`, `analyze` and `expand` use truthful shared completion outcomes/counts; expansion is deterministic BFS over preferred COMPLETE frontier, local-first plus graph providers, cycle-safe, depth-only, branch-isolated, interruptible and idempotent.
- `failures` queries all four product stages by object with stable reason/action/rerun guidance; acquisition source detail is explicit and redacted; diagnostic history does not alter current completion facts.
- Every curation operation is explicit, atomic, audited and compensating-undo capable; stale undo fails closed; observations, RawAssets, WorkVersions, manual data and old packages are preserved.
- `config check` is network-free by default, `--runtime` probes only enabled capabilities, the single strict TOML schema rejects unknown/type/conflict errors, and the global default document-start interval is 30 seconds.
- Reading export references are opt-in and safe; package exports always retain intrinsic references, replay unchanged material and create a new immutable version only for changed current inputs.
- Pyright has zero diagnostics; docs/architecture/quick/full harness and wheel/source parity exit 0; the exact diff-scoped pure-LOC policy passes against Todo 1 baseline; installed CLI manual QA passes; no secret, dependency/lockfile drift, generated artifact, live access or user data remains.
