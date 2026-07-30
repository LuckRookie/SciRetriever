# simple-three-stage-architecture - Work Plan

## TL;DR (For humans)
<!-- Fill this LAST, after the detailed plan below is written, so it summarizes the REAL plan. -->
<!-- Plain English for a non-engineer: NO file paths, NO todo numbers, NO wave/agent/tool names. -->

**What you'll get:** 元数据检索、文献资产获取和文档解析会成为可分别启动、可错时运行、也可跨阶段并行的三个基础能力；现有完整本地文献库能力和可选的一键深层处理入口继续保留。

**Why this approach:** 三个阶段只通过 catalog 事实和不可变资产交接，避免把日常研究流程强制串成一次长任务；同一 catalog 的 acquisition 和 analysis 分别保持单进程，既守住全局 30 秒下载节奏，也避免重复消耗 MinerU、LLM 和网络资源。

**What it will NOT do:** 不缩减现有 Work-centered 产品能力，不增加 daemon、队列、微服务、lease 或第二套完成状态，也不实施仍未获批的复杂供应商额度管理方案。

**Effort:** Large
**Risk:** High - 涉及公开 CLI/config 默认值、跨进程互斥、多个 completion 入口和理想架构文档的一致性。
**Decisions to sanity-check:** metadata 默认 1000；acquisition/analysis 与深层 completion 默认 100；小于 30 秒的 acquisition 间隔直接拒绝；mixed command 按 acquisition→analysis 固定顺序持有阶段锁。

Your next move: 选择直接在独立 worker 会话执行本计划，或先进行双通道高精度计划审查。完整执行细节如下。

---

> TL;DR (machine): Large/high-risk TDD alignment of independent metadata/acquisition/analysis capabilities, bounded defaults, hard acquisition pacing, host-local stage admission, shared eligibility, MinerU recovery, and synchronized docs.

## Scope
### Must have
- 保留现有 Work/WorkVersion、catalog、不可变 RawAsset、single-current analysis、references/expansion、curation、packaging 和 `DocumentPackageVersion` 边界。
- 将 metadata retrieval、asset acquisition、document analysis 明确实现为三个独立前台能力；不同阶段可以同时操作同一 catalog，下一阶段只消费已经提交的 catalog/storage 事实。
- 保留四阶段事实派生 `METADATA_PENDING → ASSET_PENDING → ANALYSIS_PENDING → COMPLETE`；Completion 继续提供共享 eligibility、幂等检查和显式 missing-suffix convenience，不新增 workflow status。
- `discover` 与普通 `search` 的 metadata 默认合并上限统一为 1000；exact DOI resolution 仍是单目标，不受批次默认值影响。
- `download` 和 `analyze` 的批量默认上限保持 100；`download --all-missing` 必须真正应用 `--limit`。
- `search --level download|analyze` 保留；metadata `--limit` 与下游 `--completion-limit` 解耦，分别默认 1000 和 100，CLI 与 TOML 均可显式覆盖。
- `document_start_interval_seconds` 和 `DocumentStartGate` 都拒绝小于 30 秒的值；30 秒只约束相邻需要 acquisition 的 WorkVersion 启动，不约束 metadata 记录、analysis、资产复用或同一文献内部候选请求。
- 同一主机、同一 catalog 最多一个 acquisition batch 和一个 analysis batch；不同阶段可以并行。Mixed command 按 acquisition→analysis 固定顺序取得所需阶段 admission，冲突立即返回稳定退出码 1。
- 阶段 admission 只使用 host-local、进程退出自动释放的协调锁；不增加 catalog schema、lease、heartbeat、durable rate-limit 或 workflow state。
- Bulk analysis 只选择具有唯一 accepted primary PDF 且没有 current analysis 的 WorkVersion；精确选择缺 PDF 时仍返回当前稳定缺失原因，而不是静默消失。
- MinerU external task ID 在 client、repository 和测试边界统一为 UUID，并继续支持中断后使用原 task ID 恢复 polling。
- 所有新行为采用 `unittest` TDD，使用临时 SQLite/storage、fake provider/MinerU/LLM 和可控 clock；不得连接真实供应商、生产服务或用户语料。
- 按 `docs/development/documentation-map.md` 同步当前行为文档、理想架构文档和活动提案。

### Must NOT have (guardrails, anti-slop, scope boundaries)
- 不建立缩减版“新核心”，不删除、外围化或延后任何现有 library/curation/references/expansion/packaging/failures 能力。
- 不新增 daemon、后台 worker、外部 workflow 平台、消息队列、跨机器协调、任务中心、lease、fencing、checkpoint 或第二套完成状态。
- 不修改 catalog schema，不设计 migration/compatibility layer，不把阶段锁写入业务表。
- 不把 metadata 返回的每条记录按 30 秒限速，不把 acquisition 的 30 秒规则施加到 MinerU/LLM。
- 不静默把小于 30 秒的配置钳制为 30；严格边界必须报错。
- 不借本计划实施 `docs/proposals/acquisition-source-availability-and-access-limits.md` 中尚未批准的 `acquisition/access/`、周期额度、复杂 provider policy 或 live verification 方案。
- 不改变 MinerU 3.4.4/protocol 2、PDF-required analysis、不可变资产、evidence、current replacement 或 package lineage 语义。
- 不升级依赖、不修改 `uv.lock`、不访问外部服务、不提交 Git 变更，除非用户另行明确授权。

## Verification strategy
> Zero human intervention - all verification is agent-executed.
- Test decision: TDD with the repository's standard-library `unittest`; every behavior todo records the failing RED command before production edits, then the GREEN result after the minimum implementation.
- Targeted commands use `uv run --frozen python -m unittest discover -s tests -p 'test_<name>.py'`; architecture/docs use `uv run --frozen python scripts/harness.py architecture|docs`; completion requires `uv run --frozen python scripts/harness.py full`.
- Time tests inject fake monotonic/sleep functions; process-admission tests use two real subprocesses or multiprocessing contexts against one temporary catalog identity and assert the loser fails before any fake external call.
- CLI QA must invoke the real `sciretriever` entrypoint for help, strict config rejection, defaults, and stage-conflict behavior.
- Evidence: `<attemptDir>/task-<N>-simple-three-stage-architecture.txt` (attemptDir = currentAttemptDir from `omo ulw-loop status --json`; outside ulw-loop use `.omo/evidence/`).

## Execution strategy
### Parallel execution waves
> Target 5-8 todos per wave. Fewer than 3 (except the final) means you under-split.
- Wave 1: Todos 1-5 establish independent public contracts, shared eligibility, admission primitive, and MinerU ID consistency through RED→GREEN tests.
- Wave 2: Todos 6-7 wire every completion entry point and prove cross-stage concurrency/same-stage exclusion end to end.
- Wave 3: Todos 8-9 synchronize current user surfaces, ideal architecture, governance index wording, and the still-draft access-limit proposal.
- Final wave: F1-F4 run only after every implementation/documentation todo is complete.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1 | none | 6, 7, 8, 9 | 2, 3, 4, 5 |
| 2 | none | 6, 7, 8, 9 | 1, 3, 4, 5 |
| 3 | none | 7, 8, 9 | 1, 2, 4, 5 |
| 4 | none | 6, 7, 8, 9 | 1, 2, 3, 5 |
| 5 | none | 7, 8, 9 | 1, 2, 3, 4 |
| 6 | 1, 2, 4 | 7, 8, 9 | none |
| 7 | 1, 2, 3, 4, 5, 6 | 8, 9 | none |
| 8 | 1, 2, 3, 4, 5, 6, 7 | F1-F4 | 9 |
| 9 | 1, 2, 3, 4, 5, 6, 7 | F1-F4 | 8 |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE WITH edit/apply_patch - never rewrite the headers above. -->
- [x] 1. Separate metadata volume from optional deep completion volume
  What to do / Must NOT do: RED first, then make `MetadataSearchRequest`, `discover`, and `search` share one authoritative metadata default of 1000. Add `SearchConfig.completion_limit`, strict TOML parsing/injection, and public `search --completion-limit` default 100. For non-DOI search, persist and report up to metadata `--limit`, but pass only the first deterministic `completion_limit` WorkVersion targets to `download|analyze`; metadata level processes all returned metadata facts, and exact DOI remains one target. Do not overload one `--limit` with two meanings and do not cap expansion frontier behavior.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 6, 7, 8, 9
  References (executor has NO interview context - be exhaustive): `src/sciretriever/discovery/search_contracts.py:12-61`; `src/sciretriever/cli/search.py:37-98,167-214`; `src/sciretriever/cli/discover.py:114-153`; `src/sciretriever/config_models.py:49-57`; `src/sciretriever/cli/config_composition.py:122-139`; `src/sciretriever/cli/expansion_runtime.py:127-140`; `tests/test_search_wp2.py:445-454`; `tests/test_cli_wp2.py`; `tests/test_cli_completion_wp5.py`; `tests/test_toml_config.py`.
  Acceptance criteria (agent-executable): RED tests prove the old 100 default and coupled deep target count fail; GREEN tests assert metadata default 1000, deep default 100, independent CLI/TOML overrides, 1000 metadata results can coexist with 100 completion targets, and DOI produces one target. Run `uv run --frozen python -m unittest discover -s tests -p 'test_search_wp2.py'`, `... -p 'test_cli_wp2.py'`, `... -p 'test_cli_completion_wp5.py'`, and `... -p 'test_toml_config.py'`.
  QA scenarios (name the exact tool + invocation): happy: invoke parser/runtime tests with metadata limit 1000 and completion limit 7 and assert counts 1000/7; failure: TOML/CLI values 0 or negative fail at the strict boundary without starting providers. Evidence `<attemptDir>/task-1-simple-three-stage-architecture.txt`.
  Commit: N | If later authorized: `feat(search): separate metadata and completion batch limits`

- [x] 2. Enforce the acquisition safety floor and bounded download batches
  What to do / Must NOT do: RED first, then make both `parse_document_start_interval` and `DocumentStartGate` reject nonnumeric, nonfinite, `<30`, or `>86400` values with stable errors. Preserve `wait(applicable_interval)` as the stricter `max(base, applicable)` rule. Change `WorkVersionDownloadRepository.select_all_missing_primary_pdf(limit=...)` and the CLI call site so `download --all-missing` honors the existing default/override of 100. Do not sleep in tests, do not apply the gate to metadata/analysis, and do not change same-document candidate pacing.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 6, 7, 8, 9
  References (executor has NO interview context - be exhaustive): `src/sciretriever/config_parsing/expansion.py:36-48`; `src/sciretriever/config_models.py:193-203`; `src/sciretriever/acquisition/pacing.py:9-42`; `src/sciretriever/cli/acquisition_runtime.py:48-60,95-123`; `src/sciretriever/catalog/download_selection.py:49-95`; `src/sciretriever/cli/download.py:35-78,90-150`; `tests/test_runtime_readiness_wp6.py:30-108`; `tests/test_cli_download_wp3.py`; `tests/test_toml_config.py`.
  Acceptance criteria (agent-executable): RED tests demonstrate 29.999 is currently accepted and `--all-missing` exceeds 100; GREEN tests assert 30 succeeds, values below 30 fail in config and direct gate construction, 45 remains stricter, fake-clock starts are at least 30 apart, default all-missing returns 100, and `--limit 7` returns 7. Run targeted runtime/config/download test files.
  QA scenarios (name the exact tool + invocation): happy: fake clock produces starts `(0,30,60)` without wall-clock sleep; failure: offline `config check` with `document_start_interval_seconds=29` exits nonzero and never constructs acquisition runtime. Evidence `<attemptDir>/task-2-simple-three-stage-architecture.txt`.
  Commit: N | If later authorized: `fix(acquisition): enforce safe document pacing and batch bounds`

- [x] 3. Make bulk analysis selection consume authoritative completion eligibility
  What to do / Must NOT do: RED first for media type/format/cardinality mismatches. Refactor `CompletionFactsRepository` so `get()` and a new bounded, deterministically ordered `select_by_stage(CompletionStage, limit)` evaluate the same private fact-derivation helper inside one catalog snapshot. `select_all_pending` delegates to `select_by_stage(ANALYSIS_PENDING, limit)`; bounded library-query selection filters its already-bounded IDs through the same facts repository and may return fewer than `limit` rather than widening the query. Preserve exact-selector diagnostics for missing PDF and preserve `--force --all-current`. Do not duplicate a reduced SQL eligibility predicate in `analysis_selection`, import `completion` into `catalog`, or create a second stage enum/status.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 7, 8, 9
  References (executor has NO interview context - be exhaustive): `src/sciretriever/catalog/completion_facts.py:29-151`; `src/sciretriever/catalog/analysis_selection.py:31-95`; `src/sciretriever/cli/analyze.py:21-100`; `docs/architecture/decisions/0002-work-centered-literature-library.md:22-31`; `tests/test_completion_facts_wp5.py`; `tests/test_completion_facts_alignment_wp5.py`; `tests/test_cli_completion_backfill_wp5.py`.
  Acceptance criteria (agent-executable): RED proves bulk selection currently includes missing/non-PDF/multiple-primary targets; GREEN asserts default/override limits count eligible targets only, exact missing-PDF selection still returns a stable unadvanced reason, completed targets are skipped unless forced, and no acquisition adapter is invoked by `analyze`. Run the three referenced completion/backfill test files.
  QA scenarios (name the exact tool + invocation): happy: temporary catalog with 120 eligible and 20 ineligible targets selects exactly the first deterministic 100 eligible IDs; failure: an exact WorkVersion with no accepted PDF returns the existing missing-PDF action and performs zero MinerU/LLM calls. Evidence `<attemptDir>/task-3-simple-three-stage-architecture.txt`.
  Commit: N | If later authorized: `fix(analysis): select only eligible pending documents`

- [x] 4. Add host-local catalog stage admission without workflow state
  What to do / Must NOT do: RED first, then add a small `src/sciretriever/cli/stage_admission.py` context-managed primitive with typed `StageKind` (`acquisition`, `analysis`) and `StageAdmissionConflict`. Derive lock identity from SHA-256 of the resolved catalog path plus stage, stored under an owner-only system-temp `sciretriever-stage-admission-<uid>` directory. Create/validate the directory as current-user-owned mode `0700`, reject symlink/non-directory collisions, and keep per-stage lock files mode `0600`. Use a separate stdlib SQLite lock file per stage, `timeout=0`, and a held `BEGIN IMMEDIATE` transaction; translate only SQLite BUSY/LOCKED into `StageAdmissionConflict` and propagate every other operational error. Create no tables/rows, roll back and close on exit, and acquire multiple stages in fixed acquisition→analysis order. Lock state must be kernel/connection scoped, auto-release on normal exit, exception, Ctrl+C, or process death; no wait/retry/lease/heartbeat/catalog schema and no cross-machine claim.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 6, 7, 8, 9
  References (executor has NO interview context - be exhaustive): `src/sciretriever/catalog/engine.py:19-106` for existing SQLite timeout/transaction conventions; `src/sciretriever/errors.py:7-18,124-188` for typed public error ownership; `docs/architecture/decisions/0002-work-centered-literature-library.md:25-28,39-40`; `AGENTS.md:25-31,54-59`.
  Acceptance criteria (agent-executable): new `tests/test_stage_admission.py` first fails, then proves two real processes using the same resolved catalog identity cannot hold the same stage, acquisition and analysis can be held simultaneously, relative/absolute aliases collide, fixed multi-stage ordering cannot deadlock, conflict is immediate, and abrupt holder termination permits the next admission. Assert lock files contain no schema or state rows.
  QA scenarios (name the exact tool + invocation): happy: two subprocesses hold acquisition and analysis concurrently; failure: a second acquisition subprocess receives `StageAdmissionConflict` before its sentinel external-call file is created. Evidence `<attemptDir>/task-4-simple-three-stage-architecture.txt`.
  Commit: N | If later authorized: `feat(cli): add catalog-scoped stage admission`

- [x] 5. Preserve and normalize MinerU task-ID recovery contracts
  What to do / Must NOT do: RED first for repository creation with a non-UUID external task ID, then make `ExternalParserAttemptRepository.create(..., external_task_id=...)` use the same UUID validation as `attach_task` and the MinerU client. Replace stale `task-1/task-2` fixtures with UUIDs and strengthen interruption/resume tests to assert the persisted task ID is reused for polling with no second submit. Preserve 404 expiration/resubmission under the same deterministic processing run. Do not remove attempts, add workflow states, or change MinerU protocol/version.
  Parallelization: Wave 1 | Blocked by: none | Blocks: 7, 8, 9
  References (executor has NO interview context - be exhaustive): `src/sciretriever/catalog/parser_attempts.py:16-102`; `src/sciretriever/normalization/mineru_contracts.py:13-39`; `src/sciretriever/normalization/mineru_client.py:286-313`; `docs/architecture/decisions/0003-operator-managed-mineru-service.md:20-30`; `tests/test_wp4_contracts.py:102-132`; `tests/test_mineru_wp42.py:385-509`; `docs/notes/mineru.md`.
  Acceptance criteria (agent-executable): RED proves create accepts a non-UUID; GREEN rejects it, accepts UUIDs, persists the task ID before polling, resumes interrupted polling using the identical ID with `submissions == 1`, and still resubmits expired remote tasks within `max_attempts`. Run `test_wp4_contracts.py` and `test_mineru_wp42.py`.
  QA scenarios (name the exact tool + invocation): happy: interrupted fake MinerU task resumes and completes with one submission; failure: malformed task ID is rejected before catalog persistence and secrets/URLs never enter the error. Evidence `<attemptDir>/task-5-simple-three-stage-architecture.txt`.
  Commit: N | If later authorized: `fix(mineru): enforce resumable task id contract`

- [x] 6. Wire stage admission through every expensive completion entry point
  What to do / Must NOT do: RED CLI/composition tests, then wrap entire stage batches through the shared admission primitive: `download` holds acquisition through required and optional assets; `analyze` holds analysis through force/non-force batch; non-DOI `search` performs metadata first, then metadata level takes no lock, download level takes acquisition, analyze level takes acquisition+analysis; exact DOI deep search takes the same stage locks around missing-suffix completion; `expand --depth 0` takes none and deeper expansion takes both; `catalog import-asset` takes no acquisition lock for local immutable import but holds analysis around `--stop complete`. Acquire mixed locks only through the central fixed-order helper. Catch conflicts at CLI boundaries, redact catalog paths, print a stable stage-active message, and return 1 before external adapters run.
  Parallelization: Wave 2 | Blocked by: 1, 2, 4 | Blocks: 7, 8, 9
  References (executor has NO interview context - be exhaustive): `src/sciretriever/cli/download.py:90-167`; `src/sciretriever/cli/analyze.py:58-116`; `src/sciretriever/cli/search.py:174-252`; `src/sciretriever/cli/expand.py:55-70`; `src/sciretriever/cli/expansion_runtime.py:73-89,155-196`; `src/sciretriever/cli/catalog.py:67-124`; `src/sciretriever/cli/completion_runtime.py`; `tests/test_cli_download_wp3.py`; `tests/test_cli_completion_wp5.py`; `tests/test_cli_expand_composition_wp6.py`; `tests/test_cli_catalog_import_wp5.py`.
  Acceptance criteria (agent-executable): all listed commands have tests proving correct stage acquisition, no lock for metadata/fact-only/local import paths, both locks for mixed complete paths, stable exit 1 on conflict, no external fake call after conflict, and lock release on success/error/interrupt. No command may instantiate a private alternative lock mechanism.
  QA scenarios (name the exact tool + invocation): happy: metadata search proceeds while separate acquisition and analysis locks are held; failure: second download and second analyze invocations fail immediately with redacted stable errors while the first holders remain active. Evidence `<attemptDir>/task-6-simple-three-stage-architecture.txt`.
  Commit: N | If later authorized: `feat(completion): enforce stage admission at cli boundaries`

- [x] 7. Prove independent-stage convergence and interruption with real temporary catalog/storage
  What to do / Must NOT do: Add an offline acceptance suite using a real temporary SQLite WAL catalog, immutable storage, fake metadata provider, fake acquisition transport, fake MinerU and fake LLM. Use barriers rather than sleeps to overlap metadata ingestion, one acquisition batch and one analysis batch on distinct eligible WorkVersions. Assert catalog facts converge independently, same-stage losers fail before external calls, batch defaults are 1000/100/100, completion convenience still works, accepted primary PDF identity remains aligned with current analysis, and Ctrl+C/process termination releases stage admission while preserving committed facts and MinerU task recovery. Do not connect to network or add probabilistic timing assertions.
  Parallelization: Wave 2 | Blocked by: 1, 2, 3, 4, 5, 6 | Blocks: 8, 9
  References (executor has NO interview context - be exhaustive): `tests/test_completion_wp5.py`; `tests/test_discovery_acceptance.py`; `tests/test_completion_acceptance_fixture.py`; `tests/test_cli_completion_backfill_wp5.py`; `tests/test_raw_asset_crash_recovery.py`; `src/sciretriever/catalog/engine.py:83-106`; `src/sciretriever/completion/pipeline.py:66-155`.
  Acceptance criteria (agent-executable): a new focused acceptance file passes repeatedly with deterministic barriers; it asserts no duplicate vendor/MinerU/LLM call, no second workflow status, no asset overwrite, committed metadata remains after downstream conflict, and rerun reaches expected fact-derived stages. Run it alone three consecutive times, then run `uv run --frozen python scripts/harness.py quick`.
  QA scenarios (name the exact tool + invocation): happy: three stage processes overlap on one catalog and independently commit expected facts; failure: same-stage contender exits 1, interrupted holder releases admission, and rerun skips completed work. Evidence `<attemptDir>/task-7-simple-three-stage-architecture.txt`.
  Commit: N | If later authorized: `test(completion): cover independent stage concurrency`

- [x] 8. Synchronize published CLI, configuration, and user guidance
  What to do / Must NOT do: After behavior is green, update current-behavior surfaces for independent commands, 1000/100/100 defaults, `--completion-limit`, hard 30-second minimum, same-stage host-local exclusion, and optional explicit deep search. Update full/minimal TOML examples according to their existing responsibilities; the full template should expose truthful default/example values and the minimal template should not add unnecessary tuning. Update help strings and docs examples so metadata accumulation, later download, and later analysis are the recommended workflow. Do not describe unimplemented provider-policy features or imply cross-machine locks.
  Parallelization: Wave 3 | Blocked by: 1-7 | Blocks: F1-F4 | Can parallelize with: 9
  References (executor has NO interview context - be exhaustive): `README.md`; `docs/guides/user-manual.md`; `docs/guides/configuration.md`; `docs/guides/config.toml`; `docs/guides/config.minimal.toml`; `src/sciretriever/cli/search.py:71-98`; `src/sciretriever/cli/download.py:35-58`; `src/sciretriever/cli/analyze.py:21-37`; `docs/development/documentation-map.md:9-17,23-31`; `scripts/documentation_checks.py`.
  Acceptance criteria (agent-executable): CLI `--help`, strict TOML accepted keys/defaults, README, user manual and templates agree on all three defaults and stage independence; no current-behavior document claims mandatory end-to-end completion. `uv run --frozen python scripts/harness.py docs` and relevant CLI/config tests pass.
  QA scenarios (name the exact tool + invocation): happy: follow the documented metadata-only → download → analyze command sequence against temporary fixtures; failure: documented/configured interval 29 is rejected with the same action described by the guide. Evidence `<attemptDir>/task-8-simple-three-stage-architecture.txt`.
  Commit: N | If later authorized: `docs(cli): explain independent literature stages`

- [x] 9. Align ideal architecture and keep the access-limit proposal non-authoritative
  What to do / Must NOT do: Update requirements, system design, technical architecture and the architecture index wording so the three capabilities are independently runnable, catalog facts are their handoff, Completion is shared eligibility/idempotence plus optional explicit suffix chaining, and stage admission is host-local process coordination rather than durable workflow state. Adjust `AGENTS.md` only where its architecture summary currently implies mandatory chaining. Reconcile the active access-limit proposal only where it conflicts with the approved 30-second acquisition floor and single-process acquisition rule; preserve `status=draft`, supplier evidence, unresolved provider-policy questions and the statement that it does not authorize implementation. Do not add a new ADR because Work-centered scope, PDF authority, foreground execution and MinerU ownership remain unchanged.
  Parallelization: Wave 3 | Blocked by: 1-7 | Blocks: F1-F4 | Can parallelize with: 8
  References (executor has NO interview context - be exhaustive): `docs/architecture/requirements.md`; `docs/architecture/system-design.md`; `docs/architecture/technical-architecture.md`; `docs/architecture/decisions/0002-work-centered-literature-library.md:16-31`; `docs/architecture/decisions/0003-operator-managed-mineru-service.md:18-30`; `docs/architecture/principles.md`; `AGENTS.md:42-59`; `docs/proposals/acquisition-source-availability-and-access-limits.md:9-28,57-95,198-239`; `docs/development/documentation-map.md`.
  Acceptance criteria (agent-executable): semantic review finds one consistent topology across requirements/system/technical docs; ADR 0002/0003 remain unchanged unless a genuine contradiction is demonstrated; proposal remains draft and does not authorize `acquisition/access/` or quota implementation. Run `uv run --frozen python scripts/harness.py architecture` and `... docs`.
  QA scenarios (name the exact tool + invocation): happy: trace metadata-only, acquisition-only, analysis-only and optional deep search through the documents with matching owners/states; failure: architecture/documentation checks reject any new reverse dependency, second state model, or current-behavior claim before implementation. Evidence `<attemptDir>/task-9-simple-three-stage-architecture.txt`.
  Commit: N | If later authorized: `docs(architecture): define independent stage execution`

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE using independently captured evidence; no human action is required to execute the checks.
- [x] F1. Plan compliance audit
  Verify every Must have and Must NOT have against the final diff and evidence ledger. Run `GIT_MASTER=1 git diff --check` and inspect only task-related paths; reject missing entry points, unverified defaults, unauthorized schema/dependency changes, or unrelated worktree edits. Evidence `<attemptDir>/final-F1-plan-compliance.txt`.
- [x] F2. Code quality and static-contract review
  Run `lsp_diagnostics` on every changed Python file, `uv run --frozen pyright src/sciretriever tests scripts`, targeted tests from Todos 1-7, then `uv run --frozen python scripts/harness.py full`. Reject type suppressions, broad compatibility layers, duplicated eligibility/lock logic, external calls, or pre-existing failures not clearly separated from task regressions. Evidence `<attemptDir>/final-F2-quality.txt`.
- [x] F3. Real CLI manual QA
  Through `interactive_bash`, run `uv run --frozen sciretriever --version`, `search --help`, `download --help`, `analyze --help`; use a system-temporary config/catalog/storage to observe metadata/deep limits, interval 29 rejection, interval 30 acceptance, independent stage invocation, same-stage conflict exit 1, cross-stage coexistence, and lock release after interruption. Never contact real providers/MinerU/LLM. Evidence `<attemptDir>/final-F3-cli-qa.txt`.
- [x] F4. Scope and documentation fidelity
  Re-read the approved draft, ADR 0002/0003 and `docs/development/documentation-map.md`; run `uv run --frozen python scripts/harness.py docs` and `... architecture`. Reject a replacement core, removed library capability, accepted/archived access-limit proposal, new ADR without need, cross-machine guarantee, or mismatch between README/current behavior and architecture/ideal behavior. Evidence `<attemptDir>/final-F4-scope.txt`.

## Commit strategy
- The user has not authorized commits. The executor must leave all changes uncommitted and must not stage, amend, rebase, push or create a PR.
- If the user later authorizes commits, use English Conventional Commits and preserve implementation+direct-test atomicity. Recommended groups: search limits; acquisition pacing/bounds; analysis eligibility; stage admission+wiring+acceptance; MinerU contract; current user docs; architecture/proposal docs.
- Before any authorized commit, use `GIT_MASTER=1` and inspect status, diff, staged diff and recent log; stage only task-related files and exclude `.omo/run-continuation/`, runtime catalogs, storage, evidence, build/dist and unrelated user edits.

## Success criteria
- Metadata retrieval, acquisition and analysis can each be invoked independently and can run cross-stage against the same catalog without requiring synchronous suffix completion.
- Metadata default is 1000; acquisition, analysis and downstream deep completion defaults are 100; every explicit override is strictly parsed, documented and tested.
- `download --all-missing` and bulk analysis obey bounded limits; bulk analysis excludes ineligible missing/non-PDF/multiple-primary targets while exact diagnostics remain useful.
- Every acquisition-capable entry point enforces a non-reducible 30-second adjacent WorkVersion start interval, and no metadata/analysis path inherits that delay.
- Same-catalog same-stage conflicts fail immediately before external calls; different stages coexist; process exit/interruption releases admission without leases or schema state.
- MinerU UUID task IDs persist and resume polling without duplicate submit; expiration behavior remains bounded and unchanged.
- Existing Work-centered library capabilities, immutable assets, single-current analysis, evidence, packaging and module dependency direction remain intact.
- All changed Python files have clean diagnostics; targeted tests, quick, docs, architecture and full harness pass offline.
- README/guides/help describe current behavior; architecture describes the ideal independent-capability topology; the acquisition access-limit proposal remains a non-authoritative draft.
- Final diff contains no secrets, runtime data, generated build artifacts, unrelated user changes, lockfile changes or unauthorized Git operations.
