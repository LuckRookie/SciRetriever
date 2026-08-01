from __future__ import annotations

from collections.abc import Callable
from typing import cast
import unittest

from sciretriever.catalog import CompletionFacts, CompletionStage
from sciretriever.errors import CatalogError
from sciretriever.completion import (
    AnalysisPromotionResult,
    BatchItemStatus,
    CompletionInvariantError,
    CompletionPipeline,
    CompletionResult,
    CompletionServices,
    CompletionStop,
    DoiTarget,
    ForceAnalysisRequest,
    MetadataUnavailableResult,
    MetadataResolutionPolicy,
    OptionalAssetKind,
    OptionalAssetRequest,
    OptionalAssetResult,
    OutcomeDisposition,
    OutcomeReason,
    RequiredPrimaryResult,
    WorkVersionTarget,
    run_completion_batch,
)
from sciretriever.discovery import MetadataSearchResult
from sciretriever.discovery.search_contracts import ExactMetadataOutput
from sciretriever.catalog.records import WorkVersionRecord
from sciretriever.catalog import CompletionFactsRepository, WorkVersionDownloadRecord, WorkVersionDownloadRepository
from sciretriever.acquisition import AcquisitionResult, WorkVersionAcquisitionService
from sciretriever.cli.completion_runtime import (
    AcquisitionRuntimeConfig,
    RequiredPrimaryAdapter,
    WorkVersionIdentifierAdapter,
)
from sciretriever.core.contracts import CandidateMetadata, Identifier


VERSION_A = "11111111-1111-4111-8111-111111111111"
VERSION_B = "22222222-2222-4222-8222-222222222222"
ANALYSIS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
ANALYSIS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"


def facts(version: str, stage: CompletionStage, *, revision: int = 0,
          current: str | None = None) -> CompletionFacts:
    asset = stage in {CompletionStage.ANALYSIS_PENDING, CompletionStage.COMPLETE}
    return CompletionFacts(version, stage, stage is not CompletionStage.METADATA_PENDING,
                           asset, stage is CompletionStage.COMPLETE,
                           VERSION_B if asset else None, "a" * 64 if asset else None,
                           current, revision)


class FactStore:
    def __init__(self, values: dict[str, CompletionFacts]) -> None:
        self.values = values
        self.reads: list[str] = []

    def get(self, work_version_id: str) -> CompletionFacts:
        self.reads.append(work_version_id)
        try:
            return self.values[work_version_id]
        except KeyError:
            raise CatalogError("unknown WorkVersion") from None


class MetadataOwner:
    def __init__(self, version: str | None = VERSION_A) -> None:
        self.version = version
        self.calls: list[str] = []

    def resolve(self, request):
        self.calls.append(request.doi)
        if self.version is None:
            return ExactMetadataOutput(request.doi, None, ())
        record = WorkVersionRecord(
            self.version, VERSION_B, "provider", "title", "Title", None, None,
            None, None, None, None, None, None, None, None, None, None, 1,
            "fixture-key", False, "2026-01-01T00:00:00.000Z",
            "2026-01-01T00:00:00.000Z",
        )
        result = MetadataSearchResult(record, ("fixture",),
                                      (Identifier("doi", request.doi),),
                                      CandidateMetadata(title="Title"))
        return ExactMetadataOutput(request.doi, result, ())


class IdentifierOwner:
    def __init__(self, doi: str | None = "10.1234/existing") -> None:
        self.doi = doi
        self.calls: list[str] = []

    def doi_for(self, work_version_id: str) -> str | None:
        self.calls.append(work_version_id)
        return self.doi


class PrimaryOwner:
    def __init__(self, store: FactStore, disposition=OutcomeDisposition.ADVANCED) -> None:
        self.store = store
        self.disposition = disposition
        self.calls: list[str] = []
        self.interrupt = False
        self.on_call: Callable[[], None] | None = None

    async def acquire(self, work_version_id: str) -> RequiredPrimaryResult:
        self.calls.append(work_version_id)
        if self.interrupt:
            raise KeyboardInterrupt
        if self.on_call is not None:
            self.on_call()
        elif self.disposition is OutcomeDisposition.ADVANCED:
            self.store.values[work_version_id] = facts(work_version_id, CompletionStage.ANALYSIS_PENDING)
        reason = OutcomeReason.SUCCEEDED if self.disposition is OutcomeDisposition.ADVANCED else OutcomeReason.EXHAUSTED
        return RequiredPrimaryResult(work_version_id, self.disposition, reason)


class AnalysisOwner:
    def __init__(self, store: FactStore) -> None:
        self.store = store
        self.calls = []
        self.fail = False
        self.on_call: Callable[[], None] | None = None

    def promote(self, request):
        self.calls.append(request)
        if self.fail:
            raise RuntimeError("provider secret")
        if self.on_call is not None:
            self.on_call()
            current = self.store.values[request.work_version_id]
            if current.current_analysis_id is None:
                raise AssertionError("race fixture did not publish current analysis")
            return AnalysisPromotionResult(request.work_version_id,
                                           current.current_analysis_id,
                                           current.current_revision)
        old = self.store.values[request.work_version_id]
        revision = old.current_revision + 1
        current = ANALYSIS_B if old.current_analysis_id == ANALYSIS_A else ANALYSIS_A
        self.store.values[request.work_version_id] = facts(
            request.work_version_id, CompletionStage.COMPLETE,
            revision=revision, current=current)
        return AnalysisPromotionResult(request.work_version_id, current, revision)


class OptionalOwner:
    def __init__(self) -> None:
        self.calls = []

    async def acquire(self, request):
        self.calls.append(request)
        return OptionalAssetResult(request, OutcomeDisposition.ADVANCED,
                                   OutcomeReason.SUCCEEDED, CompletionStage.COMPLETE)


class DownloadRepositoryFake:
    def __init__(self, identifiers: tuple[Identifier, ...]) -> None:
        self.identifiers = identifiers

    def get(self, work_version_id: str) -> WorkVersionDownloadRecord:
        return WorkVersionDownloadRecord(work_version_id, VERSION_B, self.identifiers,
                                         "Title", (), None, None, None, None)


class AcquisitionServiceFake:
    def __init__(self, status: str, store: FactStore, *, progress: bool = False) -> None:
        self.status = status
        self.store = store
        self.progress = progress

    async def acquire(self, work_version_id, role, target, providers, *, timeout):
        if self.progress:
            self.store.values[work_version_id] = facts(
                work_version_id, CompletionStage.ANALYSIS_PENDING)
        return AcquisitionResult(work_version_id, self.status)


def pipeline(stage: CompletionStage, *, version: str = VERSION_A):
    current = ANALYSIS_A if stage is CompletionStage.COMPLETE else None
    revision = 1 if current else 0
    store = FactStore({version: facts(version, stage, revision=revision, current=current)})
    owners = (MetadataOwner(version), PrimaryOwner(store), AnalysisOwner(store),
              OptionalOwner(), IdentifierOwner())
    services = CompletionServices(store, owners[4], owners[0], owners[1],
                                  owners[2], owners[3])
    policy = MetadataResolutionPolicy(("fixture",), ("fixture",))
    value = CompletionPipeline(services, policy)
    return value, store, owners


def completed(value: CompletionResult | MetadataUnavailableResult) -> CompletionResult:
    if isinstance(value, MetadataUnavailableResult):
        raise AssertionError("expected a resolved completion result")
    return value


