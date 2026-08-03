from __future__ import annotations

from types import TracebackType
from typing import Protocol

from sciretriever.model.execution import ValidatedImportAcceptance
from sciretriever.model.library import (
    CurationCommit,
    CurationTopology,
    ExportCandidate,
    ExportSelectionRequest,
    ValidatedCurationPlan,
)
from sciretriever.model.library_details import (
    CollectionMembershipPage,
    GraphPage,
    WorkDetail,
    WorkVersionDetail,
)
from sciretriever.model.library_pages import LibraryPage, LibraryPageRequest
from sciretriever.model.library_query import QueryFilterV1
from sciretriever.model.primitives import (
    BibliographyFormat,
    CollectionId,
    RelativeArtifactPath,
    WorkId,
    WorkVersionId,
)
from sciretriever.model.record import (
    ExportEncodingResult,
    ImportedBibliographicRecord,
    ImportIdentityResolution,
    ImportPreparationRequest,
    RecordParseResult,
)


class LibraryReadPort(Protocol):
    def search(self, filters: QueryFilterV1, request: LibraryPageRequest) -> LibraryPage: ...

    def get_work(self, work_id: WorkId, observations: bool) -> WorkDetail: ...

    def get_version(self, version_id: WorkVersionId, observations: bool) -> WorkVersionDetail: ...

    def references(
        self, version_id: WorkVersionId, unresolved: bool, limit: int, cursor: str | None
    ) -> GraphPage: ...

    def collection_memberships(
        self, collection_id: CollectionId, after: WorkId | None, limit: int
    ) -> CollectionMembershipPage: ...

    def authority_fingerprint(self) -> str: ...

    def drop_search_indexes(self) -> None: ...

    def rebuild_search_indexes(self) -> None: ...


class LibraryCurationRepository(Protocol):
    def load_curation_topology(self) -> CurationTopology: ...


class CurationTransactionPort(Protocol):
    def apply(self, validated_plan: ValidatedCurationPlan) -> CurationCommit: ...


class CoreWriteGuard(Protocol):
    def __enter__(self) -> CoreWriteGuard: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...


class CoreWriteAcquirer(Protocol):
    def __call__(self) -> CoreWriteGuard: ...


class GuardedArtifactReconciler(Protocol):
    def reconcile_guarded(self) -> None: ...


class ArtifactReferenceReader(Protocol):
    def referenced_artifact_paths(self) -> tuple[RelativeArtifactPath, ...]: ...


class ImportIdentityPort(Protocol):
    def prepare_import(self, request: ImportPreparationRequest) -> ImportIdentityResolution: ...


class ImportAcceptancePublisher(Protocol):
    def publish(self, acceptance: ValidatedImportAcceptance) -> None: ...


class BinaryInput(Protocol):
    def read(self, size: int = -1) -> bytes: ...


class BinaryOutput(Protocol):
    def write(self, value: bytes) -> int: ...


class BibliographyCodec(Protocol):
    format: BibliographyFormat

    def read(self, stream: BinaryInput) -> tuple[RecordParseResult, ...]: ...

    def write(
        self, records: tuple[ImportedBibliographicRecord, ...], stream: BinaryOutput
    ) -> ExportEncodingResult: ...


class LibraryExportSelectionPort(Protocol):
    def select_snapshot(self, request: ExportSelectionRequest) -> tuple[ExportCandidate, ...]: ...


class AtomicOutputContext(Protocol):
    def __enter__(self) -> BinaryOutput: ...

    def publish(self) -> None: ...

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> None: ...


class AtomicOutputPort(Protocol):
    def acquire_output(self) -> AtomicOutputContext: ...


__all__ = (
    "CoreWriteAcquirer",
    "CoreWriteGuard",
    "AtomicOutputContext",
    "AtomicOutputPort",
    "ArtifactReferenceReader",
    "BibliographyCodec",
    "BinaryInput",
    "BinaryOutput",
    "CurationTransactionPort",
    "GuardedArtifactReconciler",
    "ImportAcceptancePublisher",
    "ImportIdentityPort",
    "LibraryExportSelectionPort",
    "LibraryCurationRepository",
    "LibraryReadPort",
)
