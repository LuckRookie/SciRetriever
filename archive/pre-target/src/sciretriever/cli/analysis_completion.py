"""Lazy analysis promotion for completion command runtimes."""

from collections.abc import Callable

from sciretriever.catalog import CompletionStage
from sciretriever.cli.analysis_runtime import AnalysisRuntimeServices
from sciretriever.completion import AnalysisPromotionRequest, AnalysisPromotionResult


class AtomicAnalysisAdapter:
    def __init__(self, services: Callable[[], AnalysisRuntimeServices]) -> None:
        self._build_services = services
        self._services: AnalysisRuntimeServices | None = None

    def promote(self, request: AnalysisPromotionRequest) -> AnalysisPromotionResult:
        services = self._services
        if services is None:
            services = self._build_services()
            self._services = services
        before = services.facts.get(request.work_version_id)
        raw_asset_id = before.primary_pdf_id
        if raw_asset_id is None:
            raise ValueError("analysis promotion requires one accepted primary PDF")
        raw = services.assets.get_raw_asset(raw_asset_id)
        if raw is None:
            raise ValueError("accepted primary PDF record is missing")
        pdf = services.raw_store.read_verified(
            raw.storage_path, raw.sha256, raw.byte_size, services.max_pdf_bytes
        )
        parsed = services.parsing.run(request.work_version_id, raw.id, pdf)
        source = services.mapping.run(request.work_version_id, parsed)
        services.analysis.run(
            request.work_version_id,
            source,
            expected_current_id=request.expected_current_analysis_id,
            expected_revision=before.current_revision,
            force=request.replace_current,
        )
        after = services.facts.get(request.work_version_id)
        if after.current_analysis_id is None or after.stage is not CompletionStage.COMPLETE:
            raise ValueError("analysis owner did not publish an aligned current result")
        return AnalysisPromotionResult(
            request.work_version_id, after.current_analysis_id, after.current_revision
        )


__all__ = ("AtomicAnalysisAdapter",)
