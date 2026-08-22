"""Production object-graph contracts and narrow Entry adapters."""

from __future__ import annotations

import os
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, field
from enum import Enum
from typing import TYPE_CHECKING, BinaryIO, Protocol, cast

from sciretriever.acquisition.sources.configured_sci_hub import ConfiguredLocatorResolver
from sciretriever.agents import AgentBudget, AgentPort
from sciretriever.bootstrap.browser import _AcquisitionExecutionRuntime
from sciretriever.model.configuration import Configuration
from sciretriever.model.discovery import (
    CitationDiscoveryInput,
    ProviderDiscoveryLimit,
    TopicDiscoveryInput,
)
from sciretriever.model.execution import (
    BatchRequest,
    DiscoveryRunSelector,
    LiteratureSelector,
    MetaLiteratureSelector,
    QuerySelector,
)
from sciretriever.model.library import (
    LibrarySearchPage,
    LibrarySearchRequest,
    LiteratureDetail,
    LiteratureReferencePage,
    LiteratureReferenceRequest,
    ReferenceDetail,
)
from sciretriever.model.primitives import LiteratureId, ReferenceId
from sciretriever.model.report import (
    BibliographyFormat,
    DatabaseCompletionReport,
    DiscoveryReport,
    ExportReport,
    ImportReport,
    ManualPdfReport,
)
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.http import HttpClient
from sciretriever.parsing.ports import ParserPort

if TYPE_CHECKING:
    from sciretriever.entry.api import EntryApi
    from sciretriever.entry.library import LibraryOperations
    from sciretriever.literature.api import LiteratureArtifactReference

BibliographyExportScope = (
    DiscoveryRunSelector | QuerySelector | MetaLiteratureSelector | LiteratureSelector | None
)


class ProductionEntryScope(str, Enum):
    """Closed production Entry capability sets selected by the CLI."""

    TOPIC_DISCOVERY = "topic-discovery"
    CITATION_DISCOVERY = "citation-discovery"
    ASSET_COMPLETION = "asset-completion"
    CONTENT_COMPLETION = "content-completion"
    LOCAL_LIBRARY = "local-library"
    MANUAL_PDF = "manual-pdf"
    BIBLIOGRAPHY_EXCHANGE = "bibliography-exchange"


@dataclass(frozen=True, slots=True)
class BootstrapExternalDependencies:
    """Explicit external capabilities for Python integration and offline tests."""

    parser_factory: Callable[[HttpClient, AccessCoordinator], ParserPort] = field(repr=False)
    agents_factory: Callable[[HttpClient, AccessCoordinator], AgentPort] = field(repr=False)
    agents_analysis_model: str
    agents_analysis_budget: AgentBudget
    metadata_max_output_tokens: int
    content_max_output_tokens: int
    reference_max_output_tokens: int
    analysis_max_input_bytes: int = 16 * 1024 * 1024
    analysis_max_chunk_bytes: int = 16 * 1024 * 1024
    analysis_max_chunk_count: int = 1
    analysis_max_total_llm_requests: int = 3
    analysis_max_total_output_tokens: int = 65_536
    configured_sci_hub_resolver: ConfiguredLocatorResolver | None = field(
        default=None,
        repr=False,
    )
    agents_browser_model: str | None = None
    agents_browser_budget: AgentBudget | None = field(default=None, repr=False)

    def __post_init__(self) -> None:
        if not callable(self.parser_factory) or not callable(self.agents_factory):
            raise TypeError("external dependency factories must be callable")
        if type(self.agents_analysis_model) is not str or not self.agents_analysis_model.strip():
            raise ValueError("agents_analysis_model must be nonblank")
        if not isinstance(self.agents_analysis_budget, AgentBudget):
            raise TypeError("agents_analysis_budget must be an AgentBudget")
        if self.agents_browser_model is not None and (
            type(self.agents_browser_model) is not str or not self.agents_browser_model.strip()
        ):
            raise ValueError("agents_browser_model must be nonblank or None")
        if self.agents_browser_budget is not None and not isinstance(
            self.agents_browser_budget,
            AgentBudget,
        ):
            raise TypeError("agents_browser_budget must be an AgentBudget or None")
        if (self.agents_browser_model is None) != (self.agents_browser_budget is None):
            raise ValueError("Browser Agent model and budget must be configured together")
        for name in (
            "metadata_max_output_tokens",
            "content_max_output_tokens",
            "reference_max_output_tokens",
            "analysis_max_input_bytes",
            "analysis_max_chunk_bytes",
            "analysis_max_chunk_count",
            "analysis_max_total_llm_requests",
            "analysis_max_total_output_tokens",
        ):
            value = getattr(self, name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{name} must be a positive integer")


@dataclass(frozen=True, slots=True)
class ApplicationObjectGraph:
    """Explicit production object graph; no string service locator is used."""

    configuration: Configuration
    catalog_engine: object
    storage_root: object
    artifact_store: object
    verified_reader: object
    atomic_user_output: object
    write_admission: object
    discovery_repository: object
    entry_reader: object
    artifact_reference_store: object
    artifact_reconciler: object
    access_coordinator: object
    http_client: object
    browser_client: object | None
    metadata_registry: object
    acquisition_registry: object
    acquisition_runtime: _AcquisitionExecutionRuntime
    topic_provider_limits: tuple[ProviderDiscoveryLimit, ...]
    citation_provider_limits: tuple[ProviderDiscoveryLimit, ...]
    metadata_api: object
    literature_api: object
    acquisition_api: object
    parsing_api: object
    analysis_api: object
    entry_api: EntryApi

    def close(self) -> None:
        """Close process-local acquisition resources owned by this graph."""

        self.acquisition_runtime.close()

    def __enter__(self) -> ApplicationObjectGraph:
        return self

    def __exit__(self, *unused: object) -> None:
        self.close()


class TopicDiscoveryEntry(Protocol):
    def discover_topic(self, request: TopicDiscoveryInput) -> DiscoveryReport: ...


class CitationDiscoveryEntry(Protocol):
    def discover_citations(self, request: CitationDiscoveryInput) -> DiscoveryReport: ...


class DatabaseCompletionEntry(Protocol):
    def complete_database(self, request: BatchRequest) -> DatabaseCompletionReport: ...


class ManualPdfEntry(Protocol):
    def admit_manual_pdf(
        self,
        literature_id: LiteratureId,
        source: BinaryIO,
    ) -> ManualPdfReport: ...


class BibliographyExchangeEntry(Protocol):
    def import_bibliography(
        self,
        format: BibliographyFormat,
        source: BinaryIO,
    ) -> ImportReport: ...

    def export_bibliography(
        self,
        format: BibliographyFormat,
        selector: BibliographyExportScope,
        target: str | os.PathLike[str],
        *,
        overwrite: bool = False,
    ) -> ExportReport: ...


class LocalLibraryEntry(Protocol):
    def search_literature(self, request: LibrarySearchRequest) -> LibrarySearchPage: ...

    def get_literature_detail(self, literature_id: LiteratureId) -> LiteratureDetail: ...

    def list_literature_references(
        self,
        request: LiteratureReferenceRequest,
    ) -> LiteratureReferencePage: ...

    def get_reference_detail(self, reference_id: ReferenceId) -> ReferenceDetail: ...

    def open_artifact(
        self,
        reference: LiteratureArtifactReference,
    ) -> AbstractContextManager[BinaryIO]: ...

    def export_artifact(
        self,
        reference: LiteratureArtifactReference,
        target: str | os.PathLike[str],
        *,
        overwrite: bool = False,
    ) -> None: ...


@dataclass(frozen=True, slots=True)
class LocalLibraryObjectGraph:
    """Production graph for operations that consume only the local database."""

    configuration: Configuration
    catalog_engine: object
    storage_root: object
    artifact_store: object
    verified_reader: object
    atomic_user_output: object
    literature_api: object
    entry_api: LocalLibraryEntry


@dataclass(frozen=True, slots=True)
class TopicDiscoveryObjectGraph:
    configuration: Configuration
    topic_provider_limits: tuple[ProviderDiscoveryLimit, ...]
    entry_api: TopicDiscoveryEntry


@dataclass(frozen=True, slots=True)
class CitationDiscoveryObjectGraph:
    configuration: Configuration
    citation_provider_limits: tuple[ProviderDiscoveryLimit, ...]
    entry_api: CitationDiscoveryEntry


@dataclass(frozen=True, slots=True)
class DatabaseCompletionObjectGraph:
    configuration: Configuration
    access_coordinator: AccessCoordinator = field(repr=False)
    http_client: HttpClient = field(repr=False)
    browser_client: object | None = field(repr=False)
    acquisition_registry: object = field(repr=False)
    acquisition_runtime: _AcquisitionExecutionRuntime = field(repr=False)
    acquisition_api: object = field(repr=False)
    entry_api: DatabaseCompletionEntry

    def close(self) -> None:
        """Close command-scoped acquisition runtime resources."""

        self.acquisition_runtime.close()

    def __enter__(self) -> DatabaseCompletionObjectGraph:
        return self

    def __exit__(self, *unused: object) -> None:
        self.close()


@dataclass(frozen=True, slots=True)
class ManualPdfObjectGraph:
    configuration: Configuration
    entry_api: ManualPdfEntry


@dataclass(frozen=True, slots=True)
class BibliographyExchangeObjectGraph:
    configuration: Configuration
    entry_api: BibliographyExchangeEntry


class _TopicDiscoveryEntry:
    __slots__ = ("_operation",)

    def __init__(self, operation: object) -> None:
        if not callable(operation):
            raise TypeError("topic discovery operation must be callable")
        self._operation = operation

    def discover_topic(self, request: TopicDiscoveryInput) -> DiscoveryReport:
        return cast(DiscoveryReport, self._operation(request))


class _CitationDiscoveryEntry:
    __slots__ = ("_operation",)

    def __init__(self, operation: object) -> None:
        if not callable(operation):
            raise TypeError("citation discovery operation must be callable")
        self._operation = operation

    def discover_citations(self, request: CitationDiscoveryInput) -> DiscoveryReport:
        return cast(DiscoveryReport, self._operation(request))


class _DatabaseCompletionEntry:
    __slots__ = ("_operation",)

    def __init__(self, operation: object) -> None:
        if not callable(operation):
            raise TypeError("database completion operation must be callable")
        self._operation = operation

    def complete_database(self, request: BatchRequest) -> DatabaseCompletionReport:
        return cast(DatabaseCompletionReport, self._operation(request))


class _ManualPdfEntry:
    __slots__ = ("_operation",)

    def __init__(self, operation: object) -> None:
        if not callable(operation):
            raise TypeError("manual PDF operation must be callable")
        self._operation = operation

    def admit_manual_pdf(self, literature_id: LiteratureId, source: BinaryIO) -> ManualPdfReport:
        return cast(ManualPdfReport, self._operation(literature_id, source))


class _BibliographyExchangeEntry:
    __slots__ = ("_import", "_export")

    def __init__(
        self,
        import_operation: Callable[[BibliographyFormat, BinaryIO], ImportReport],
        export_operation: Callable[
            [BibliographyFormat, BibliographyExportScope, str | os.PathLike[str], bool],
            ExportReport,
        ],
    ) -> None:
        if not callable(import_operation) or not callable(export_operation):
            raise TypeError("bibliography operations must be callable")
        self._import = import_operation
        self._export = export_operation

    def import_bibliography(self, format: BibliographyFormat, source: BinaryIO) -> ImportReport:
        return cast(ImportReport, self._import(format, source))

    def export_bibliography(
        self,
        format: BibliographyFormat,
        selector: BibliographyExportScope,
        target: str | os.PathLike[str],
        *,
        overwrite: bool = False,
    ) -> ExportReport:
        return cast(ExportReport, self._export(format, selector, target, overwrite))


class _LocalLibraryEntry:
    __slots__ = ("_operations",)

    def __init__(self, operations: LibraryOperations) -> None:
        self._operations = operations

    def search_literature(self, request: LibrarySearchRequest) -> LibrarySearchPage:
        return cast(LibrarySearchPage, self._operations.search_literature(request))

    def get_literature_detail(self, literature_id: LiteratureId) -> LiteratureDetail:
        return cast(LiteratureDetail, self._operations.get_literature_detail(literature_id))

    def list_literature_references(
        self,
        request: LiteratureReferenceRequest,
    ) -> LiteratureReferencePage:
        return cast(
            LiteratureReferencePage,
            self._operations.list_literature_references(request),
        )

    def get_reference_detail(self, reference_id: ReferenceId) -> ReferenceDetail:
        return cast(ReferenceDetail, self._operations.get_reference_detail(reference_id))

    def open_artifact(
        self,
        reference: LiteratureArtifactReference,
    ) -> AbstractContextManager[BinaryIO]:
        return self._operations.open_artifact(reference)

    def export_artifact(
        self,
        reference: LiteratureArtifactReference,
        target: str | os.PathLike[str],
        *,
        overwrite: bool = False,
    ) -> None:
        self._operations.export_artifact(reference, target, overwrite=overwrite)
