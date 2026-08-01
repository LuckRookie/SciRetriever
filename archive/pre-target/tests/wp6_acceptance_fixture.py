from __future__ import annotations

from dataclasses import asdict, dataclass
import hashlib
from io import BytesIO
import json
from pathlib import Path
from typing import Protocol

import anyio
from PyPDF2 import PdfReader, PdfWriter

from sciretriever.catalog import CatalogDiagnosticService
from sciretriever.catalog.curation import CurationOperationOwner, CurationRequest
from sciretriever.catalog.manual_metadata_curation import ManualMetadataSetHandler
from sciretriever.completion import (
    CompletionResult, CompletionStop, DoiTarget, ForceAnalysisRequest, WorkVersionTarget,
    run_completion_batch,
)
from sciretriever.errors import PackagingError
from sciretriever.diagnostics import DiagnosticQuery
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.export_errors import ExportContractError
from sciretriever.core.snapshots import SafeSnapshot
from sciretriever.expansion import (
    CatalogFrontier, ExpansionCompletionServices, ExpansionEngine, ExpansionPolicy, ExpansionResult,
    ExpansionSeed, ExpansionServices, GraphDiscoveryResult, PipelineLayerCompletion,
)
from sciretriever.integrations.graph import (
    CitationEdge, ExpansionDepth, GraphDirection, GraphIdentifier,
    GraphIdentifierNamespace, GraphQuery,
)
from sciretriever.packaging import PackagePipeline
from sciretriever.references import ReferenceResolutionPolicy, ReferenceResolutionService
from sciretriever.discovery.search_contracts import ExactMetadataRequest

from wp6_acceptance_curation import exercise_curation
from wp6_acceptance_identity import fixed_identities
from wp6_acceptance_outputs import (
    check_offline_and_runtime, export_old_and_new_packages, export_reading_views,
    fixed_clock,
)
from wp6_acceptance_runtime import AcceptanceRuntime


INJECTIONS = frozenset(("branch", "transaction", "config", "export"))
SECRET = "WP6-SECRET-MUST-NOT-PERSIST"


@dataclass(frozen=True, slots=True)
class AcceptanceSummary:
    complete_versions: int
    curation_operations: int
    export_sha256: str
    failures: int
    package_sha256: str
    pdf_pages: int
    pdf_sha256: str
    raw_asset_sha256: str
    references: int
    package_versions: int
    work_version_id: str
    work_versions: int
    status: str = "passed"

    def to_json(self) -> str:
        return json.dumps(asdict(self), separators=(",", ":"), sort_keys=True)


class InjectedAcceptanceFailure(RuntimeError):
    def __init__(self, point: str) -> None:
        self.point = point


class Pacer(Protocol):
    async def wait(self, applicable_interval: float = 0.0) -> float: ...


class NoWait:
    async def wait(self, applicable_interval: float = 0.0) -> float:
        return 0.0


class InterruptOnce:
    async def wait(self, applicable_interval: float = 0.0) -> float:
        raise KeyboardInterrupt


class CyclicCitedBy:
    def __init__(self, seed: GraphIdentifier) -> None:
        self.seed = seed

    async def discover(self, query: GraphQuery) -> GraphDiscoveryResult:
        leaf = query.seed.value.rsplit("/", 1)[-1]
        if query.seed == self.seed:
            endpoints = ("citer", "failed")
        else:
            endpoints = ("seed",) if leaf == "citer" else ()
        edges = tuple(CitationEdge(
            GraphIdentifier(GraphIdentifierNamespace.DOI, f"10.9000/{value}"),
            query.seed,
        ) for value in endpoints)
        return GraphDiscoveryResult(edges, (), len(edges))


def _pdf(root: Path) -> tuple[Path, str]:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=300)
    writer.add_blank_page(width=300, height=200)
    writer.pages[-1].rotation = 90
    writer.add_metadata({"/Subject": "offline WP6 acceptance " * 200})
    value = BytesIO()
    writer.write(value)
    path = root / "fixture" / "two-page.pdf"
    path.parent.mkdir()
    path.write_bytes(value.getvalue())
    return path, hashlib.sha256(value.getvalue()).hexdigest()


def _snapshot(runtime: AcceptanceRuntime) -> list[int]:
    return list(runtime.snapshot())


def _failure(root: Path, runtime: AcceptanceRuntime, injection: str,
             before: list[int], detail: str) -> None:
    observation = {
        "after": _snapshot(runtime), "before": before, "detail": detail,
        "injection": injection,
    }
    encoded = json.dumps(observation, separators=(",", ":"), sort_keys=True)
    if SECRET in encoded:
        raise AssertionError("failure observation leaked secret")
    (root / "failure-observation.json").write_text(encoded + "\n", encoding="utf-8")
    raise InjectedAcceptanceFailure(injection)


def _expand(runtime: AcceptanceRuntime, version_id: str, pacer: Pacer) -> ExpansionResult:
    resolver = ReferenceResolutionService(
        runtime.catalog, runtime.metadata,
        ReferenceResolutionPolicy(("fixture",), ("fixture",), 1.0, 1),
    )
    seed = GraphIdentifier(GraphIdentifierNamespace.DOI, "10.9000/seed")
    engine = ExpansionEngine(ExpansionServices(
        CatalogFrontier(runtime.catalog),
        PipelineLayerCompletion(ExpansionCompletionServices(
            runtime.runtime.pipeline, pacer, CatalogDiagnosticService(runtime.catalog),
        )),
        resolver, CyclicCitedBy(seed),
    ))
    return anyio.run(
        engine.expand, ExpansionSeed(version_id),
        ExpansionPolicy(GraphDirection.CITED_BY, ExpansionDepth(2), 8, 20),
    )


async def _interrupted_batch(runtime: AcceptanceRuntime, version_id: str):
    return await run_completion_batch(
        runtime.runtime.pipeline, (WorkVersionTarget(version_id),),
        CompletionStop.COMPLETE, start_pacer=InterruptOnce(),
    )


def _run_acceptance(root: Path, injection: str | None = None) -> AcceptanceSummary:
    if injection is not None and injection not in INJECTIONS:
        raise InjectedAcceptanceFailure("invalid")
    root.mkdir(parents=True, exist_ok=False)
    pdf_path, pdf_sha = _pdf(root)
    runtime = AcceptanceRuntime(root, pdf_path)
    try:
        completed = anyio.run(
            runtime.runtime.pipeline.ensure_complete, DoiTarget("10.9000/seed"),
            CompletionStop.COMPLETE,
        )
        if not isinstance(completed, CompletionResult):
            raise AssertionError("metadata did not resolve")
        version_id = completed.work_version_id
        before = _snapshot(runtime)
        expansion_interrupted = _expand(runtime, version_id, InterruptOnce())
        if not expansion_interrupted.interrupted:
            raise AssertionError("expansion interruption was not recorded")
        runtime.acquisition.fail_doi = "10.9000/failed"
        first_expansion = _expand(runtime, version_id, NoWait())
        if sum(layer.counts.failed for layer in first_expansion.layers) != 1:
            raise AssertionError("expansion did not isolate exactly one failed branch")
        if injection == "branch":
            _failure(root, runtime, injection, before, "failed branch persisted; sibling completed")
        _expand(runtime, version_id, NoWait())
        policy = runtime.runtime.pipeline.metadata_policy
        pending = runtime.metadata.resolve(ExactMetadataRequest(
            "10.9000/interrupted", policy.providers, policy.precedence,
            policy.timeout_seconds, policy.max_concurrency,
        ))
        assert pending.result is not None
        interrupted = anyio.run(_interrupted_batch, runtime, pending.result.work_version.id)
        if not interrupted.interrupted:
            raise AssertionError("completion interruption was not recorded")
        anyio.run(
            run_completion_batch, runtime.runtime.pipeline,
            (WorkVersionTarget(pending.result.work_version.id),), CompletionStop.COMPLETE,
        )
        if injection == "transaction":
            transaction_before = _snapshot(runtime)
            handler = ManualMetadataSetHandler.load(runtime.catalog, version_id, "language", "de")
            request = CurationRequest(handler, ReviewDecision.NOT_REQUIRED, SafeSnapshot(()), handler.operation_id)
            def fail(point: str) -> None:
                if point == "apply:after:work_versions":
                    raise RuntimeError(SECRET)
            try:
                CurationOperationOwner(runtime.catalog, test_failpoint=fail).apply(request)
            except RuntimeError:
                _failure(root, runtime, injection, transaction_before, "curation transaction rolled back")
        with runtime.catalog.connect() as connection:
            work_id = str(connection.exec_driver_sql(
                "SELECT work_id FROM work_versions WHERE id=?", (version_id,),
            ).scalar_one())
        tag_id, _ = exercise_curation(runtime, work_id, version_id)
        package_pipeline = PackagePipeline(
            runtime.catalog, runtime.raw_store, runtime.derived_store,
        )
        old_package = package_pipeline.run(work_version_id=version_id)
        old_replay = package_pipeline.run(work_version_id=version_id)
        if old_replay.created or old_replay.record != old_package.record:
            raise AssertionError("identical package input did not replay")
        runtime.runtime.pipeline.force_analysis(
            ForceAnalysisRequest(WorkVersionTarget(version_id), 1)
        )
        with runtime.catalog.connect() as connection:
            language = connection.exec_driver_sql("SELECT language FROM work_versions WHERE id=?", (version_id,)).scalar_one()
            manual_tag = connection.exec_driver_sql("SELECT count(*) FROM manual_work_tags WHERE work_id=? AND tag_id=?", (work_id, tag_id)).scalar_one()
        if (language, manual_tag) != ("fr", 1):
            raise AssertionError("reanalysis clobbered manual state")
        export_reading_views(root, runtime, version_id)
        config_before = _snapshot(runtime)
        if not check_offline_and_runtime(root, injection):
            raise AssertionError("config checks did not remain read-only")
        if injection == "config":
            _failure(root, runtime, injection, config_before, "invalid config rejected read-only")
        export_before = _snapshot(runtime)
        try:
            package_sha, export_sha = export_old_and_new_packages(
                root, runtime, version_id, old_package, injection,
            )
        except (ExportContractError, PackagingError, OSError):
            if injection == "export":
                _failure(root, runtime, injection, export_before, "unsafe export preserved immutable target")
            raise
        raw_hash = runtime.facts.get(version_id).primary_pdf_sha256
        if raw_hash is None:
            raise AssertionError("primary PDF hash missing")
        failures = CatalogDiagnosticService(runtime.catalog).query(DiagnosticQuery())
        if len(failures) != runtime.table_count("diagnostic_records"):
            raise AssertionError("failure query did not project persisted diagnostics")
        return AcceptanceSummary(
            runtime.table_count("current_analyses"), runtime.table_count("curation_operations"),
            export_sha, len(failures), package_sha,
            len(PdfReader(pdf_path).pages), pdf_sha, raw_hash,
            runtime.table_count("version_references"), runtime.table_count("package_versions"), version_id,
            runtime.table_count("work_versions"),
        )
    finally:
        runtime.close()


def run_acceptance(root: Path, injection: str | None = None) -> AcceptanceSummary:
    with fixed_clock(), fixed_identities():
        return _run_acceptance(root, injection)
