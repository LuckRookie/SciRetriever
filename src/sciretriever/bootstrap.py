"""The single production assembly point for SciRetriever.

Construction is deliberately side-effect free with respect to external
services: no DNS, HTTP, Browser navigation, MinerU health check, LLM request,
or Provider probe is performed here.  The production factory validates every
selected ordinary/secret dependency before delegating to the lower-level
explicit-dependency object-graph builder.
"""

from __future__ import annotations

import logging
import os
import stat
from collections.abc import Callable
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING, BinaryIO, Generator, NoReturn, Protocol, cast
from uuid import uuid4

from sciretriever.acquisition.sources.configured_sci_hub import ConfiguredLocatorResolver
from sciretriever.analysis.ports import AnalysisLLMPort
from sciretriever.configuration import (
    ConfigurationError,
    CredentialLookup,
    RuntimeSecretLookup,
    configuration_runtime_status,
    configuration_status,
    load_credentials,
    load_runtime_secrets,
    run_configuration_probes,
)
from sciretriever.model.configuration import (
    AnalysisAuthentication,
    AnalysisProvider,
    Configuration,
    ConfigurationProbeSummary,
    ConfigurationStatus,
    CoreConfigurationProbeResult,
    CoreCredentialService,
    LLMConfigurationProbeDetails,
    MinerUConfigurationProbeDetails,
    ParserConnectionMode,
    ProbeOutcome,
    ProviderName,
)
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
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    UtcTimestamp,
)
from sciretriever.model.report import (
    BibliographyFormat,
    DatabaseCompletionReport,
    DiscoveryReport,
    ExportReport,
    ImportReport,
    ManualPdfReport,
    StableFailure,
)
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.http import HttpClient
from sciretriever.parsing.ports import ParserPort

BibliographyExportScope = (
    DiscoveryRunSelector | QuerySelector | MetaLiteratureSelector | LiteratureSelector | None
)

if TYPE_CHECKING:
    from sciretriever.entry.api import EntryApi
    from sciretriever.entry.library import LibraryOperations
    from sciretriever.literature.api import LiteratureApi, LiteratureArtifactReference
    from sciretriever.metadata.api import MetadataApi
    from sciretriever.metadata.registry import MetadataProbeRegistry, MetadataRegistry
    from sciretriever.storage.files.output import AtomicOutput
    from sciretriever.storage.files.paths import StorageRoot
    from sciretriever.storage.files.reader import VerifiedReader
    from sciretriever.storage.files.store import ArtifactStore
    from sciretriever.storage.sqlite.discovery_repository import SqliteDiscoveryRepository
    from sciretriever.storage.sqlite.engine import CatalogEngine
    from sciretriever.storage.sqlite.entry_reader import SqliteEntryReader
    from sciretriever.storage.sqlite.literature_writer import LiteratureWriter


class BootstrapError(RuntimeError):
    """Stable, path-free and secret-free production assembly failure."""

    _CODES = frozenset(
        {
            "configuration-invalid",
            "paths-not-ready",
            "parser-not-ready",
            "analysis-not-ready",
            "metadata-not-ready",
            "acquisition-not-ready",
            "storage-unavailable",
            "assembly-failed",
        }
    )

    def __init__(self, code: str) -> None:
        safe = code if code in self._CODES else "assembly-failed"
        self.code = safe
        super().__init__(safe)

    def __repr__(self) -> str:
        return f"BootstrapError(code={self.code!r})"


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
    analysis_llm_factory: Callable[[HttpClient, AccessCoordinator], AnalysisLLMPort] = field(
        repr=False
    )
    analysis_model: str
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

    def __post_init__(self) -> None:
        if not callable(self.parser_factory) or not callable(self.analysis_llm_factory):
            raise TypeError("external dependency factories must be callable")
        if type(self.analysis_model) is not str or not self.analysis_model.strip():
            raise ValueError("analysis_model must be nonblank")
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
    topic_provider_limits: tuple[ProviderDiscoveryLimit, ...]
    citation_provider_limits: tuple[ProviderDiscoveryLimit, ...]
    metadata_api: object
    literature_api: object
    acquisition_api: object
    parsing_api: object
    analysis_api: object
    entry_api: EntryApi


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
    entry_api: DatabaseCompletionEntry


@dataclass(frozen=True, slots=True)
class ManualPdfObjectGraph:
    configuration: Configuration
    entry_api: ManualPdfEntry


@dataclass(frozen=True, slots=True)
class BibliographyExchangeObjectGraph:
    configuration: Configuration
    entry_api: BibliographyExchangeEntry


@dataclass(frozen=True, slots=True)
class ProductionConfigurationProbeSession:
    """A no-Storage configuration-test session from one credential snapshot."""

    configuration: Configuration
    credentials: CredentialLookup = field(repr=False)
    status: ConfigurationStatus
    probe_port: MetadataProbeRegistry = field(repr=False)
    access_coordinator: AccessCoordinator = field(repr=False)
    http_client: HttpClient = field(repr=False)

    def run(
        self,
        *,
        provider: ProviderName | str | None = None,
        test_all: bool = False,
    ) -> ConfigurationProbeSummary:
        return run_configuration_probes(
            self.configuration,
            self.probe_port,
            provider=provider,
            test_all=test_all,
            status_snapshot=self.status,
        )

    def run_llm(self) -> CoreConfigurationProbeResult:
        """Run one minimal strict LLM request without user Literature content."""

        from sciretriever.analysis.ports import (
            AnalysisLLMCall,
            AnalysisLLMFailure,
            parse_strict_json_object,
        )
        from sciretriever.model.llm import LLMRequest, LLMRequestKind
        from sciretriever.model.primitives import sha256_digest

        runtime = configuration_runtime_status(
            self.configuration,
            credentials=self.credentials,
        )
        locally_ready = runtime.analysis.reference_configuration_complete and (
            not runtime.analysis.api_key_required
            or (
                runtime.analysis.api_key_configured is True
                and runtime.analysis.credential_origin_matches is True
            )
        )
        if not locally_ready:
            return _core_probe_payload(
                "llm",
                outcome="skipped",
                local_ready=False,
                failure_code="analysis-not-ready",
            )
        try:
            secrets = load_runtime_secrets(
                self.configuration,
                credentials=self.credentials,
                include_parser=False,
                include_analysis=True,
            )
            adapter = _build_analysis_llm(
                self.configuration,
                secrets,
                self.http_client,
                self.access_coordinator,
            )
            structured_input = '{"probe":"sciretriever-configuration"}'
            response = adapter.complete(
                AnalysisLLMCall(
                    request=LLMRequest(
                        kind=LLMRequestKind.REFERENCE_LOOKUP,
                        input_sha256=sha256_digest(structured_input.encode("utf-8")),
                        model=self.configuration.analysis.model or "",
                        max_output_tokens=min(
                            self.configuration.analysis.reference_max_output_tokens or 16,
                            64,
                        ),
                    ),
                    prompt_version="configuration-probe-v1",
                    prompt=(
                        "Return exactly one JSON object matching the schema. "
                        "Set ok to true. Do not add fields."
                    ),
                    structured_input=structured_input,
                    response_schema=(
                        '{"type":"object","properties":{"ok":{"type":"boolean",'
                        '"const":true}},"required":["ok"],"additionalProperties":false}'
                    ),
                )
            )
            result = parse_strict_json_object(response.result)
            if result != {"ok": True}:
                return _core_probe_payload(
                    "llm",
                    outcome="failed",
                    local_ready=True,
                    failure_code="analysis-llm-probe-contract",
                )
        except AnalysisLLMFailure as error:
            return _core_probe_payload(
                "llm",
                outcome="failed",
                local_ready=True,
                failure_code=error.failure.code,
            )
        except (BootstrapError, ConfigurationError, TypeError, ValueError):
            return _core_probe_payload(
                "llm",
                outcome="failed",
                local_ready=True,
                failure_code="analysis-llm-probe-failed",
            )
        return _core_probe_payload(
            "llm",
            outcome="passed",
            local_ready=True,
            failure_code=None,
            details={
                "strict_response_parseable": True,
                "model": self.configuration.analysis.model,
                "protocol": (
                    None
                    if self.configuration.analysis.protocol is None
                    else self.configuration.analysis.protocol.value
                ),
            },
        )

    def run_mineru(self) -> CoreConfigurationProbeResult:
        """Run MinerU health/version/protocol checks without uploading a PDF."""

        from sciretriever.network.admission import AccessPolicy, AccessScope
        from sciretriever.parsing.adapters.mineru import (
            MinerUProtocol2Error,
            MinerUProtocol2ServiceClient,
        )

        runtime = configuration_runtime_status(
            self.configuration,
            credentials=self.credentials,
        )
        locally_ready = runtime.parsing.configuration_complete and (
            not runtime.parsing.bearer_token_required
            or (
                runtime.parsing.bearer_token_configured is True
                and runtime.parsing.credential_origin_matches is True
            )
        )
        if not locally_ready:
            return _core_probe_payload(
                "mineru",
                outcome="skipped",
                local_ready=False,
                failure_code="parser-not-ready",
            )
        try:
            secrets = load_runtime_secrets(
                self.configuration,
                credentials=self.credentials,
                include_parser=True,
                include_analysis=False,
            )
            parser = self.configuration.parsing
            client = MinerUProtocol2ServiceClient(
                http_client=self.http_client,
                base_url=parser.base_url or "",
                connection_mode=(parser.connection_mode or ParserConnectionMode.LOOPBACK).value,
                access_scope=AccessScope("mineru", "api", "protocol-2"),
                access_policy=AccessPolicy(max_concurrency=1),
                bearer_token=secrets.mineru_bearer_token,
                remote_upload_authorized=parser.remote_upload_authorized,
            )
            health = client.probe_health()
        except MinerUProtocol2Error as error:
            return _core_probe_payload(
                "mineru",
                outcome="failed",
                local_ready=True,
                failure_code=f"mineru-{error.code}",
            )
        except (ConfigurationError, TypeError, ValueError):
            return _core_probe_payload(
                "mineru",
                outcome="failed",
                local_ready=True,
                failure_code="mineru-probe-failed",
            )
        return _core_probe_payload(
            "mineru",
            outcome="passed",
            local_ready=True,
            failure_code=None,
            details={
                "health": health.status,
                "release": health.release,
                "api_protocol": health.api_protocol,
                "profile": "vlm-engine",
                "uploaded_pdf": False,
            },
        )


def _core_probe_payload(
    service: str,
    *,
    outcome: str,
    local_ready: bool,
    failure_code: str | None,
    details: dict[str, object] | None = None,
) -> CoreConfigurationProbeResult:
    service_name = CoreCredentialService(service)
    detail_payload = {} if details is None else details
    checked_details: LLMConfigurationProbeDetails | MinerUConfigurationProbeDetails
    if service_name is CoreCredentialService.LLM:
        checked_details = LLMConfigurationProbeDetails.model_validate(detail_payload)
    else:
        checked_details = MinerUConfigurationProbeDetails.model_validate(detail_payload)
    return CoreConfigurationProbeResult(
        service=service_name,
        outcome=ProbeOutcome(outcome),
        local_ready=local_ready,
        failure_code=failure_code,
        details=checked_details,
    )


class _UtcClock:
    __slots__ = ()

    def now(self) -> UtcTimestamp:
        return UtcTimestamp.model_validate(datetime.now(timezone.utc))


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


class _UuidLiteratureIds:
    __slots__ = ()

    def new_literature_id(self) -> LiteratureId:
        return LiteratureId(str(uuid4()))

    def new_meta_literature_id(self) -> MetaLiteratureId:
        return MetaLiteratureId(str(uuid4()))

    def new_reference_id(self) -> ReferenceId:
        return ReferenceId(str(uuid4()))


class _CatalogWriteAdmission:
    __slots__ = ("_artifact_reconciler", "_catalog_path")

    def __init__(self, catalog_path: Path, artifact_reconciler: object) -> None:
        from sciretriever.storage.files.reconciliation import ArtifactStoreReconciler

        if not isinstance(artifact_reconciler, ArtifactStoreReconciler):
            raise TypeError("artifact_reconciler must be an ArtifactStoreReconciler")
        self._catalog_path = catalog_path
        self._artifact_reconciler = artifact_reconciler

    @contextmanager
    def acquire_nowait(self) -> Generator[None, None, None]:
        from sciretriever.entry.ports import WriteAdmissionFailure
        from sciretriever.storage.files.reconciliation import ArtifactReconciliationError
        from sciretriever.storage.locking import (
            CatalogLockConflictError,
            CatalogLockError,
            CatalogWriteLock,
        )

        try:
            with CatalogWriteLock(self._catalog_path):
                self._artifact_reconciler.reconcile_admitted()
                try:
                    yield None
                except BaseException:
                    raise
                else:
                    self._artifact_reconciler.reconcile_admitted()
        except WriteAdmissionFailure:
            raise
        except CatalogLockConflictError as error:
            raise WriteAdmissionFailure(_write_admission_conflict_failure()) from error
        except (ArtifactReconciliationError, CatalogLockError) as error:
            raise WriteAdmissionFailure(_write_admission_storage_failure()) from error


def _write_admission_conflict_failure() -> StableFailure:
    return StableFailure(
        code="write-admission-conflict",
        reason="Another operation currently owns the local database write boundary.",
        action="Wait for the other operation to finish, then retry.",
        retryable=True,
    )


def _write_admission_storage_failure() -> StableFailure:
    return StableFailure(
        code="write-admission-failed",
        reason="The local database and artifact store could not be admitted safely.",
        action="Check the local storage and retry the operation.",
        retryable=True,
    )


def _new_observation_id() -> ObservationId:
    return ObservationId(str(uuid4()))


def _new_provenance_id() -> ProvenanceId:
    return ProvenanceId(str(uuid4()))


def _validate_low_level_inputs(
    configuration: Configuration,
    catalog_path: str | Path,
    artifact_root: str | Path,
    external_dependencies: BootstrapExternalDependencies,
) -> tuple[Path, Path]:
    if not isinstance(configuration, Configuration):
        raise BootstrapError("configuration-invalid")
    if not isinstance(external_dependencies, BootstrapExternalDependencies):
        raise BootstrapError("configuration-invalid")
    try:
        catalog = Path(catalog_path)
        artifacts = Path(artifact_root)
    except TypeError:
        raise BootstrapError("paths-not-ready") from None
    return catalog, artifacts


@dataclass(slots=True)
class _OwnedNode:
    path: Path = field(repr=False)
    descriptor: int = field(repr=False)
    device: int
    inode: int
    links: int


@dataclass(frozen=True, slots=True)
class _FreshStorageOwnership:
    catalog: _OwnedNode | None = None
    artifact_root: _OwnedNode | None = None

    @property
    def owned(self) -> bool:
        return self.catalog is not None or self.artifact_root is not None


@dataclass(frozen=True, slots=True)
class _ProjectLoggerState:
    handlers: tuple[logging.Handler, ...]
    level: int
    propagate: bool
    disabled: bool


@dataclass(frozen=True, slots=True)
class _StorageFoundation:
    engine: CatalogEngine
    storage_root: StorageRoot
    artifact_store: ArtifactStore
    verified_reader: VerifiedReader
    ownership: _FreshStorageOwnership = field(repr=False)


@dataclass(frozen=True, slots=True)
class _ScopedStorageComponents:
    foundation: _StorageFoundation
    atomic_user_output: AtomicOutput
    write_admission: _CatalogWriteAdmission
    discovery_repository: SqliteDiscoveryRepository
    entry_reader: SqliteEntryReader
    artifact_reconciler: object
    literature_api: LiteratureApi
    literature_writer: LiteratureWriter


def _missing(path: Path) -> bool:
    try:
        os.lstat(path)
    except FileNotFoundError:
        return True
    except OSError:
        return False
    return False


def _owned_node(path: Path, *, directory: bool) -> _OwnedNode:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | (getattr(os, "O_DIRECTORY", 0) if directory else 0)
    )
    descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(descriptor)
        path_metadata = os.lstat(path)
    except BaseException:
        try:
            os.close(descriptor)
        except OSError:
            pass
        raise
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    if (
        stat.S_ISLNK(path_metadata.st_mode)
        or not expected(metadata.st_mode)
        or not expected(path_metadata.st_mode)
        or (path_metadata.st_dev, path_metadata.st_ino) != (metadata.st_dev, metadata.st_ino)
    ):
        os.close(descriptor)
        raise OSError("fresh storage identity is unsafe")
    return _OwnedNode(
        path=path,
        descriptor=descriptor,
        device=metadata.st_dev,
        inode=metadata.st_ino,
        links=metadata.st_nlink,
    )


def _same_owned_node(node: _OwnedNode, *, directory: bool) -> bool:
    try:
        descriptor_metadata = os.fstat(node.descriptor)
        path_metadata = os.lstat(node.path)
    except OSError:
        return False
    expected = stat.S_ISDIR if directory else stat.S_ISREG
    return (
        not stat.S_ISLNK(path_metadata.st_mode)
        and expected(descriptor_metadata.st_mode)
        and expected(path_metadata.st_mode)
        and (
            descriptor_metadata.st_dev,
            descriptor_metadata.st_ino,
            descriptor_metadata.st_nlink,
        )
        == (
            node.device,
            node.inode,
            node.links,
        )
        and (path_metadata.st_dev, path_metadata.st_ino)
        == (descriptor_metadata.st_dev, descriptor_metadata.st_ino)
        and path_metadata.st_nlink == descriptor_metadata.st_nlink
    )


def _release_fresh_storage_ownership(ownership: _FreshStorageOwnership) -> None:
    for node in (ownership.catalog, ownership.artifact_root):
        if node is None or node.descriptor < 0:
            continue
        descriptor = node.descriptor
        node.descriptor = -1
        try:
            os.close(descriptor)
        except OSError:
            pass


def _project_logger_state() -> _ProjectLoggerState:
    logger = logging.getLogger("sciretriever")
    return _ProjectLoggerState(
        handlers=tuple(logger.handlers),
        level=logger.level,
        propagate=logger.propagate,
        disabled=logger.disabled,
    )


def _restore_project_logger(state: _ProjectLoggerState) -> None:
    """Best-effort rollback without touching root or host-owned handlers."""

    logger = logging.getLogger("sciretriever")
    previous = frozenset(state.handlers)
    for handler in tuple(logger.handlers):
        if handler in previous:
            continue
        try:
            logger.removeHandler(handler)
        except Exception:
            pass
        try:
            handler.close()
        except Exception:
            pass
    logger.handlers[:] = state.handlers
    logger.setLevel(state.level)
    logger.propagate = state.propagate
    logger.disabled = state.disabled


def _rollback_fresh_storage(ownership: _FreshStorageOwnership) -> None:  # noqa: C901
    """Remove only the unchanged, empty nodes proven to be created here.

    The rollback is intentionally non-recursive.  Any identity change,
    unexpected SQLite sidecar, or nonempty artifact root is concurrent/user
    evidence, so the complete pair is preserved rather than guessed at.
    """

    try:
        if not ownership.owned:
            return
        catalog = ownership.catalog
        artifacts = ownership.artifact_root
        if catalog is not None and not _same_owned_node(catalog, directory=False):
            return
        if artifacts is not None and not _same_owned_node(artifacts, directory=True):
            return
        if catalog is not None:
            for suffix in ("-wal", "-shm", "-journal"):
                if not _missing(Path(f"{catalog.path}{suffix}")):
                    return
        if artifacts is not None:
            try:
                with os.scandir(artifacts.path) as entries:
                    if next(entries, None) is not None:
                        return
            except OSError:
                return
        if catalog is not None:
            try:
                catalog.path.unlink()
            except OSError:
                return
        if artifacts is not None:
            try:
                artifacts.path.rmdir()
            except OSError:
                pass
    finally:
        _release_fresh_storage_ownership(ownership)


def _build_storage_foundation(
    catalog_path: Path,
    artifact_root: Path,
) -> _StorageFoundation:
    """Create the two final roots as one rollback-safe Bootstrap boundary."""

    from sciretriever.storage.files.paths import StorageRoot
    from sciretriever.storage.files.reader import VerifiedReader
    from sciretriever.storage.files.store import ArtifactStore
    from sciretriever.storage.sqlite.engine import CatalogEngine, create_or_open_catalog

    fresh_pair = _missing(catalog_path) and _missing(artifact_root)
    owned_artifacts: _OwnedNode | None = None
    owned_catalog: _OwnedNode | None = None
    try:
        if fresh_pair:
            try:
                os.mkdir(artifact_root, 0o700)
            except FileExistsError:
                fresh_pair = False
            else:
                owned_artifacts = _owned_node(artifact_root, directory=True)
        storage_root = StorageRoot(artifact_root)

        if fresh_pair:

            def catalog_checkpoint(name: str) -> None:
                nonlocal owned_catalog
                if name == "after-publication":
                    owned_catalog = _owned_node(catalog_path, directory=False)

            with create_or_open_catalog(catalog_path, checkpoint=catalog_checkpoint):
                pass
            engine = CatalogEngine.open(catalog_path)
        else:
            engine = CatalogEngine(catalog_path)
        artifact_store = ArtifactStore(storage_root)
        verified_reader = VerifiedReader(storage_root)
    except BaseException:
        ownership = _FreshStorageOwnership(
            catalog=owned_catalog,
            artifact_root=owned_artifacts,
        )
        if owned_catalog is None and not _missing(catalog_path):
            # Publication happened but descriptor-bound ownership could not be
            # established.  Preserve both roots as concurrent/user evidence.
            _release_fresh_storage_ownership(ownership)
        else:
            _rollback_fresh_storage(ownership)
        raise
    return _StorageFoundation(
        engine=engine,
        storage_root=storage_root,
        artifact_store=artifact_store,
        verified_reader=verified_reader,
        ownership=_FreshStorageOwnership(
            catalog=owned_catalog,
            artifact_root=owned_artifacts,
        ),
    )


def build_object_graph(  # noqa: C901, PLR0915
    configuration: Configuration,
    *,
    catalog_path: str | Path,
    artifact_root: str | Path,
    external_dependencies: BootstrapExternalDependencies,
    credentials: CredentialLookup | None = None,
    credentials_home: str | Path | None = None,
    configure_process_logging: bool = False,
    logging_level: int = logging.INFO,
) -> ApplicationObjectGraph:
    """Build a complete graph from explicit non-fake dependencies."""

    catalog_path_value, artifact_root_value = _validate_low_level_inputs(
        configuration,
        catalog_path,
        artifact_root,
        external_dependencies,
    )
    from sciretriever.acquisition.api import AcquisitionApi
    from sciretriever.acquisition.manual import ManualPdfAdmissionService
    from sciretriever.acquisition.publication import (
        PrimaryPdfPublisher,
        ValidatedPrimaryPdfPublisher,
    )
    from sciretriever.acquisition.registry import (
        AcquisitionAssemblyDependencies,
        build_acquisition_registry,
        production_web_access_profile_resolver,
    )
    from sciretriever.acquisition.tiered_service import TieredAcquisitionService
    from sciretriever.analysis.api import AnalysisApi
    from sciretriever.analysis.content import ContentAnalysisLimits
    from sciretriever.analysis.references import ReferenceLookupStage
    from sciretriever.analysis.service import AnalysisService
    from sciretriever.entry.api import EntryApi
    from sciretriever.entry.citations import CitationDiscoveryOperation
    from sciretriever.entry.completion import DatabaseCompletionOperation
    from sciretriever.entry.discovery import TopicDiscoveryOperation
    from sciretriever.entry.exchange import BibliographyCodecs, BibliographyOperations
    from sciretriever.entry.library import LibraryOperations
    from sciretriever.entry.manual import ManualPdfOperation
    from sciretriever.literature.api import LiteratureApi
    from sciretriever.literature.service import LiteratureService
    from sciretriever.metadata.api import MetadataApi
    from sciretriever.metadata.publication import MetadataPublication
    from sciretriever.metadata.registry import (
        MetadataAssemblyDependencies,
        build_metadata_registry,
    )
    from sciretriever.metadata.service import MetadataService
    from sciretriever.network.admission import AccessCoordinator
    from sciretriever.network.http import HttpClient, SecureHttpTransport, SystemResolver
    from sciretriever.parsing.api import ParsingApi
    from sciretriever.parsing.service import ParsingService
    from sciretriever.storage.analysis_artifacts import AnalysisArtifactPublisher
    from sciretriever.storage.completion import CompletionInputBuilder
    from sciretriever.storage.files.output import AtomicOutput
    from sciretriever.storage.files.reconciliation import ArtifactStoreReconciler
    from sciretriever.storage.literature_artifacts import LiteratureArtifactReader
    from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging
    from sciretriever.storage.sqlite.acquisition_publication import SqliteAcquisitionPublication
    from sciretriever.storage.sqlite.analysis_artifacts import AnalysisArtifactReader
    from sciretriever.storage.sqlite.analysis_inputs import SqliteAnalysisCurrentInputs
    from sciretriever.storage.sqlite.artifact_references import SqliteArtifactReferenceStore
    from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
    from sciretriever.storage.sqlite.discovery_repository import SqliteDiscoveryRepository
    from sciretriever.storage.sqlite.entry_reader import SqliteEntryReader
    from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
    from sciretriever.storage.sqlite.literature_reader import LiteratureReader
    from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
    from sciretriever.storage.sqlite.metadata_publication import (
        SqliteProviderRelationObservationPublication,
    )
    from sciretriever.storage.sqlite.no_usable_content_cleanup import (
        SqliteNoUsableContentCleanup,
    )
    from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

    # One process-local coordinator and one HTTP client are shared by every
    # external adapter in this graph.
    coordinator = AccessCoordinator()
    http_client = HttpClient(
        resolver=SystemResolver(),
        transport=SecureHttpTransport(),
        coordinator=coordinator,
    )
    browser_client = None
    clock = _UtcClock()

    # Every ordinary setting, credential, Provider registry and injected
    # Parser/LLM dependency is validated before either persistent root is
    # created.  A broken later Provider must therefore leave no half graph.
    if credentials is not None and credentials_home is not None:
        raise BootstrapError("configuration-invalid")
    credential_snapshot = (
        load_credentials(home=credentials_home) if credentials is None else credentials
    )
    if not isinstance(credential_snapshot, CredentialLookup):
        raise BootstrapError("configuration-invalid")
    metadata_registry = build_metadata_registry(
        configuration,
        credential_snapshot,
        MetadataAssemblyDependencies(
            http_client=http_client,
            access_coordinator=coordinator,
            observation_id_factory=_new_observation_id,
            provenance_id_factory=_new_provenance_id,
            clock=clock.now,
        ),
    )
    acquisition_registry = build_acquisition_registry(
        configuration,
        AcquisitionAssemblyDependencies(
            http_client=http_client,
            access_coordinator=coordinator,
            web_access_profile_resolver=production_web_access_profile_resolver(),
            provenance_id_factory=_new_provenance_id,
            clock=clock.now,
            credentials=credential_snapshot,
            configured_sci_hub_resolver=external_dependencies.configured_sci_hub_resolver,  # type: ignore[arg-type]
            browser_client=browser_client,
        ),
    )
    parser = external_dependencies.parser_factory(http_client, coordinator)
    if not isinstance(parser, ParserPort):
        raise BootstrapError("parser-not-ready")
    llm = external_dependencies.analysis_llm_factory(http_client, coordinator)
    if not isinstance(llm, AnalysisLLMPort):
        raise BootstrapError("analysis-not-ready")

    # Persistent construction begins only after the complete preflight above.
    # Bind the artifact root first: if catalog creation then fails, no catalog
    # is left paired with a missing artifact root.  StorageRoot itself uses a
    # secure create-or-bind operation, so an existing root is never removed.
    try:
        foundation = _build_storage_foundation(
            catalog_path_value,
            artifact_root_value,
        )
        engine = foundation.engine
        storage_root = foundation.storage_root
        artifact_store = foundation.artifact_store
        verified_reader = foundation.verified_reader
    except BaseException:
        raise
    try:
        atomic_user_output = AtomicOutput(max_bytes=536_870_912)
        discovery_repository = SqliteDiscoveryRepository(engine)
        entry_reader = SqliteEntryReader(engine, verified_reader)
        artifact_reference_store = SqliteArtifactReferenceStore(engine)
        artifact_reconciler = ArtifactStoreReconciler(storage_root, artifact_reference_store)
        write_admission = _CatalogWriteAdmission(engine.catalog_path, artifact_reconciler)

        literature_writer = LiteratureWriter(engine)
        literature_service = LiteratureService(
            read_port=LiteraturePreconditionReader(engine, verified_reader),
            identity_port=literature_writer,
            content_port=SqliteContentPublication(engine, artifact_store, verified_reader),
            reference_port=literature_writer,
            maintenance_port=literature_writer,
            id_factory=_UuidLiteratureIds(),
            query_port=LiteratureReader(engine, verified_reader),
            artifact_read_port=LiteratureArtifactReader(engine, verified_reader),
        )
        literature_api = LiteratureApi(literature_service)

        metadata_api = MetadataApi(
            MetadataService(
                topic_search_ports=metadata_registry.topic_search_ports,
                lookup_ports=metadata_registry.lookup_ports,
                reference_query_ports=metadata_registry.reference_query_ports,
            )
        )
        metadata_publication = MetadataPublication(
            literature_api,
            SqliteProviderRelationObservationPublication(literature_writer),
        )

        acquisition_publication = SqliteAcquisitionPublication(
            engine,
            artifact_store,
            verified_reader,
        )
        pdf_validation_staging = SystemPdfValidationStaging()
        validated_pdf_publisher = ValidatedPrimaryPdfPublisher(acquisition_publication)
        primary_pdf_publisher = PrimaryPdfPublisher(
            validated_pdf_publisher,
            staging=pdf_validation_staging,
        )
        acquisition_api = AcquisitionApi(
            TieredAcquisitionService(
                route_registry=acquisition_registry.route_registry,
                planner=acquisition_registry.planner,
                publication_port=primary_pdf_publisher,
                exhaustion_port=acquisition_publication,
                exhaustion_clear_port=acquisition_publication,
            )
        )
        manual_admission = ManualPdfAdmissionService(
            publication_port=validated_pdf_publisher,
            staging=pdf_validation_staging,
            provenance_id_factory=_new_provenance_id,
            clock=clock.now,
        )

        parsing_api = ParsingApi(
            ParsingService(
                parser=parser,
                result_store=SqliteParserResultPublication(engine, artifact_store, verified_reader),
            )
        )

        limits = ContentAnalysisLimits(
            max_input_bytes=external_dependencies.analysis_max_input_bytes,
            max_chunk_bytes=external_dependencies.analysis_max_chunk_bytes,
            max_chunk_count=external_dependencies.analysis_max_chunk_count,
            max_total_llm_requests=external_dependencies.analysis_max_total_llm_requests,
            max_total_output_tokens=external_dependencies.analysis_max_total_output_tokens,
        )
        analysis_service = AnalysisService(
            llm=llm,
            artifact_reader=AnalysisArtifactReader(engine, verified_reader),
            current_inputs=SqliteAnalysisCurrentInputs(engine),
            artifact_publisher=AnalysisArtifactPublisher(artifact_store),
            model=external_dependencies.analysis_model,
            metadata_max_output_tokens=external_dependencies.metadata_max_output_tokens,
            content_max_output_tokens=external_dependencies.content_max_output_tokens,
            limits=limits,
            provenance_id_factory=_new_provenance_id,
            clock=clock.now,
        )
        analysis_api = AnalysisApi(
            content_service=analysis_service,
            reference_lookup_stage=ReferenceLookupStage(
                llm=llm,
                model=external_dependencies.analysis_model,
                max_output_tokens=external_dependencies.reference_max_output_tokens,
            ),
        )

        provider_precedence = tuple(
            registration.provider_name for registration in metadata_registry.registrations
        )
        completion_inputs = CompletionInputBuilder(engine, verified_reader)
        topic_operation = TopicDiscoveryOperation(
            metadata=metadata_api,
            metadata_publication=metadata_publication,
            repository=discovery_repository,
            publication=discovery_repository,
            clock=clock,
            write_admission=write_admission,
            recovery=discovery_repository,
            provider_precedence=provider_precedence,
        )
        citation_operation = CitationDiscoveryOperation(
            metadata=metadata_api,
            relation_publication=metadata_publication,
            literature=literature_api,
            analysis=analysis_api,
            candidate_reader=entry_reader,
            run_repository=discovery_repository,
            discovery_publication=discovery_repository,
            write_admission=write_admission,
            recovery=discovery_repository,
            clock=clock,
            provider_precedence=provider_precedence,
        )
        completion_operation = DatabaseCompletionOperation(
            selector_reader=entry_reader,
            current_facts_reader=entry_reader,
            write_admission=write_admission,
            recovery=discovery_repository,
            acquisition=acquisition_api,
            acquisition_requests=completion_inputs,
            parsing=parsing_api,
            parser_requests=completion_inputs,
            analysis=analysis_api,
            analysis_inputs=completion_inputs,
            literature=literature_api,
            cleanup=SqliteNoUsableContentCleanup(engine),
            max_concurrency=configuration.execution.max_concurrency,
        )
        manual_operation = ManualPdfOperation(
            current_facts_reader=entry_reader,
            manual_admission=manual_admission,
            write_admission=write_admission,
            recovery=discovery_repository,
        )
        library_operations = LibraryOperations(
            literature=literature_api,
            output=atomic_user_output,
        )
        bibliography_operations = BibliographyOperations(
            literature=literature_api,
            codec=BibliographyCodecs(max_input_bytes=configuration.library.max_input_bytes),
            output=atomic_user_output,
            selector_reader=entry_reader,
            clock=clock,
            write_admission=write_admission,
            recovery=discovery_repository,
            observation_id_factory=_new_observation_id,
            provenance_id_factory=_new_provenance_id,
            provider_precedence=provider_precedence,
        )
        entry_api = EntryApi(
            discover_topic_operation=topic_operation,
            discover_citations_operation=citation_operation,
            complete_database_operation=completion_operation,
            admit_manual_pdf_operation=manual_operation,
            search_literature_operation=library_operations.search_literature,
            get_literature_detail_operation=library_operations.get_literature_detail,
            list_literature_references_operation=library_operations.list_literature_references,
            get_reference_detail_operation=library_operations.get_reference_detail,
            open_artifact_operation=library_operations.open_artifact,
            export_artifact_operation=library_operations.export_artifact,
            import_bibliography_operation=bibliography_operations.import_bibliography,
            export_bibliography_operation=bibliography_operations.export_bibliography,
        )
        graph = ApplicationObjectGraph(
            configuration=configuration,
            catalog_engine=engine,
            storage_root=storage_root,
            artifact_store=artifact_store,
            verified_reader=verified_reader,
            atomic_user_output=atomic_user_output,
            write_admission=write_admission,
            discovery_repository=discovery_repository,
            entry_reader=entry_reader,
            artifact_reference_store=artifact_reference_store,
            artifact_reconciler=artifact_reconciler,
            access_coordinator=coordinator,
            http_client=http_client,
            browser_client=browser_client,
            metadata_registry=metadata_registry,
            acquisition_registry=acquisition_registry,
            topic_provider_limits=metadata_registry.topic_limits,
            citation_provider_limits=metadata_registry.citation_limits,
            metadata_api=metadata_api,
            literature_api=literature_api,
            acquisition_api=acquisition_api,
            parsing_api=parsing_api,
            analysis_api=analysis_api,
            entry_api=entry_api,
        )
    except BaseException:
        _rollback_fresh_storage(foundation.ownership)
        raise
    try:
        if configure_process_logging:
            logger_state = _project_logger_state()
            try:
                from sciretriever.logging.api import configure_logging

                configure_logging(level=logging_level)
            except BaseException:
                _restore_project_logger(logger_state)
                raise
    except BaseException as error:
        _rollback_fresh_storage(foundation.ownership)
        if isinstance(error, Exception):
            raise BootstrapError("assembly-failed") from None
        raise
    _release_fresh_storage_ownership(foundation.ownership)
    return graph


def _require_paths_configuration(configuration: Configuration) -> None:
    if configuration.paths.catalog_path is None or configuration.paths.artifact_root is None:
        raise BootstrapError("paths-not-ready")


def _require_parser_configuration(configuration: Configuration) -> None:
    parsing = configuration.parsing
    if (
        parsing.base_url is None
        or parsing.connection_mode is None
        or parsing.model_identity is None
        or (
            parsing.connection_mode is ParserConnectionMode.REMOTE
            and not parsing.remote_upload_authorized
        )
    ):
        raise BootstrapError("parser-not-ready")


def _require_analysis_configuration(configuration: Configuration) -> None:
    analysis = configuration.analysis
    if any(
        value is None
        for value in (
            analysis.provider,
            analysis.protocol,
            analysis.base_url,
            analysis.model,
            analysis.context_window_tokens,
            analysis.authentication,
            analysis.metadata_max_output_tokens,
            analysis.content_max_output_tokens,
            analysis.reference_max_output_tokens,
            analysis.max_input_bytes,
            analysis.max_chunk_bytes,
            analysis.max_chunk_count,
            analysis.max_total_llm_requests,
            analysis.max_total_output_tokens,
        )
    ):
        raise BootstrapError("analysis-not-ready")


def _require_reference_analysis_configuration(configuration: Configuration) -> None:
    analysis = configuration.analysis
    if any(
        value is None
        for value in (
            analysis.provider,
            analysis.protocol,
            analysis.base_url,
            analysis.model,
            analysis.context_window_tokens,
            analysis.authentication,
            analysis.reference_max_output_tokens,
        )
    ):
        raise BootstrapError("analysis-not-ready")


def _required_production_configuration(configuration: Configuration) -> None:
    _require_paths_configuration(configuration)
    _require_parser_configuration(configuration)
    _require_analysis_configuration(configuration)


def _analysis_limits(configuration: Configuration):  # noqa: ANN202
    from sciretriever.analysis.content import ContentAnalysisLimits

    analysis = configuration.analysis
    return ContentAnalysisLimits(
        max_input_bytes=analysis.max_input_bytes or 0,
        max_chunk_bytes=analysis.max_chunk_bytes or 0,
        max_chunk_count=analysis.max_chunk_count or 0,
        max_total_llm_requests=analysis.max_total_llm_requests or 0,
        max_total_output_tokens=analysis.max_total_output_tokens or 0,
    )


def _analysis_provider_limits(configuration: Configuration):  # noqa: ANN202
    from sciretriever.analysis.ports import LLMProviderLimits

    analysis = configuration.analysis
    return LLMProviderLimits(
        max_input_bytes=analysis.max_input_bytes or 1,
        max_output_tokens=max(
            analysis.metadata_max_output_tokens or 1,
            analysis.content_max_output_tokens or 1,
            analysis.reference_max_output_tokens or 1,
        ),
        context_window_tokens=analysis.context_window_tokens or 1_024,
    )


def _production_dependencies(
    configuration: Configuration,
    secrets: RuntimeSecretLookup,
) -> BootstrapExternalDependencies:
    from sciretriever.network.admission import AccessPolicy, AccessScope
    from sciretriever.parsing.adapters.mineru import (
        MinerUProtocol2Error,
        MinerUProtocol2ServiceClient,
        OperatorManagedMinerUAdapter,
    )

    parser = configuration.parsing
    analysis = configuration.analysis

    def parser_factory(
        http_client: HttpClient,
        _coordinator: AccessCoordinator,
    ) -> ParserPort:
        try:
            service = MinerUProtocol2ServiceClient(
                http_client=http_client,
                base_url=parser.base_url or "",
                connection_mode=(parser.connection_mode or ParserConnectionMode.LOOPBACK).value,
                access_scope=AccessScope("mineru", "api", "protocol-2"),
                access_policy=AccessPolicy(max_concurrency=1),
                bearer_token=secrets.mineru_bearer_token,
                remote_upload_authorized=parser.remote_upload_authorized,
            )
            return cast(
                ParserPort,
                OperatorManagedMinerUAdapter(
                    service=service,
                    profile="vlm-engine",
                    model_identity=parser.model_identity or "",
                ),
            )
        except (MinerUProtocol2Error, TypeError, ValueError):
            raise BootstrapError("parser-not-ready") from None

    def analysis_factory(
        http_client: HttpClient,
        coordinator: AccessCoordinator,
    ) -> AnalysisLLMPort:
        return _build_analysis_llm(
            configuration,
            secrets,
            http_client,
            coordinator,
        )

    return BootstrapExternalDependencies(
        parser_factory=parser_factory,
        analysis_llm_factory=analysis_factory,
        analysis_model=analysis.model or "",
        metadata_max_output_tokens=analysis.metadata_max_output_tokens or 0,
        content_max_output_tokens=analysis.content_max_output_tokens or 0,
        reference_max_output_tokens=analysis.reference_max_output_tokens or 0,
        analysis_max_input_bytes=analysis.max_input_bytes or 0,
        analysis_max_chunk_bytes=analysis.max_chunk_bytes or 0,
        analysis_max_chunk_count=analysis.max_chunk_count or 0,
        analysis_max_total_llm_requests=analysis.max_total_llm_requests or 0,
        analysis_max_total_output_tokens=analysis.max_total_output_tokens or 0,
    )


def _new_shared_network() -> tuple[AccessCoordinator, HttpClient]:
    from sciretriever.network.http import SecureHttpTransport, SystemResolver

    coordinator = AccessCoordinator()
    return coordinator, HttpClient(
        resolver=SystemResolver(),
        transport=SecureHttpTransport(),
        coordinator=coordinator,
    )


def build_production_configuration_probe_session(
    configuration: Configuration,
    *,
    credentials_home: str | Path | None = None,
    configured_sci_hub_resolver: ConfiguredLocatorResolver | None = None,
) -> ProductionConfigurationProbeSession:
    """Build a complete config-test session without runtime services or Storage."""

    from sciretriever.metadata.registry import (
        MetadataAssemblyDependencies,
        MetadataRegistryError,
        build_metadata_probe_registry,
    )

    if not isinstance(configuration, Configuration):
        raise BootstrapError("configuration-invalid")
    coordinator, http_client = _new_shared_network()
    clock = _UtcClock()
    try:
        credentials = load_credentials(home=credentials_home)
        status = configuration_status(
            configuration,
            credentials=credentials,
            configured_sci_hub_resolver=configured_sci_hub_resolver,
        )
        probe_port = build_metadata_probe_registry(
            configuration,
            credentials,
            MetadataAssemblyDependencies(
                http_client=http_client,
                access_coordinator=coordinator,
                observation_id_factory=_new_observation_id,
                provenance_id_factory=_new_provenance_id,
                clock=clock.now,
            ),
        )
    except ConfigurationError:
        raise BootstrapError("configuration-invalid") from None
    except MetadataRegistryError:
        raise BootstrapError("metadata-not-ready") from None
    return ProductionConfigurationProbeSession(
        configuration=configuration,
        credentials=credentials,
        status=status,
        probe_port=probe_port,
        access_coordinator=coordinator,
        http_client=http_client,
    )


def _build_local_library_graph(
    configuration: Configuration,
    *,
    configure_process_logging: bool,
    logging_level: int,
) -> LocalLibraryObjectGraph:
    from sciretriever.entry.library import LibraryOperations
    from sciretriever.literature.api import LiteratureApi
    from sciretriever.literature.service import LiteratureService
    from sciretriever.storage.files.output import AtomicOutput
    from sciretriever.storage.literature_artifacts import LiteratureArtifactReader
    from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
    from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
    from sciretriever.storage.sqlite.literature_reader import LiteratureReader
    from sciretriever.storage.sqlite.literature_writer import LiteratureWriter

    catalog_path = configuration.paths.catalog_path
    artifact_root = configuration.paths.artifact_root
    if catalog_path is None or artifact_root is None:
        raise BootstrapError("paths-not-ready")
    foundation = _build_storage_foundation(Path(catalog_path), Path(artifact_root))
    try:
        engine = foundation.engine
        writer = LiteratureWriter(engine)
        literature_api = LiteratureApi(
            LiteratureService(
                read_port=LiteraturePreconditionReader(engine, foundation.verified_reader),
                identity_port=writer,
                content_port=SqliteContentPublication(
                    engine,
                    foundation.artifact_store,
                    foundation.verified_reader,
                ),
                reference_port=writer,
                maintenance_port=writer,
                id_factory=_UuidLiteratureIds(),
                query_port=LiteratureReader(engine, foundation.verified_reader),
                artifact_read_port=LiteratureArtifactReader(engine, foundation.verified_reader),
            )
        )
        output = AtomicOutput(max_bytes=536_870_912)
        operations = LibraryOperations(literature=literature_api, output=output)
        graph = LocalLibraryObjectGraph(
            configuration=configuration,
            catalog_engine=engine,
            storage_root=foundation.storage_root,
            artifact_store=foundation.artifact_store,
            verified_reader=foundation.verified_reader,
            atomic_user_output=output,
            literature_api=literature_api,
            entry_api=_LocalLibraryEntry(operations),
        )
        if configure_process_logging:
            logger_state = _project_logger_state()
            try:
                from sciretriever.logging.api import configure_logging

                configure_logging(level=logging_level)
            except BaseException:
                _restore_project_logger(logger_state)
                raise
    except BaseException:
        _rollback_fresh_storage(foundation.ownership)
        raise
    _release_fresh_storage_ownership(foundation.ownership)
    return graph


def _build_scoped_storage(configuration: Configuration) -> _ScopedStorageComponents:
    from sciretriever.literature.api import LiteratureApi
    from sciretriever.literature.service import LiteratureService
    from sciretriever.storage.files.output import AtomicOutput
    from sciretriever.storage.files.reconciliation import ArtifactStoreReconciler
    from sciretriever.storage.literature_artifacts import LiteratureArtifactReader
    from sciretriever.storage.sqlite.artifact_references import SqliteArtifactReferenceStore
    from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
    from sciretriever.storage.sqlite.discovery_repository import SqliteDiscoveryRepository
    from sciretriever.storage.sqlite.entry_reader import SqliteEntryReader
    from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
    from sciretriever.storage.sqlite.literature_reader import LiteratureReader
    from sciretriever.storage.sqlite.literature_writer import LiteratureWriter

    catalog_path = configuration.paths.catalog_path
    artifact_root = configuration.paths.artifact_root
    if catalog_path is None or artifact_root is None:
        raise BootstrapError("paths-not-ready")
    foundation = _build_storage_foundation(Path(catalog_path), Path(artifact_root))
    try:
        engine = foundation.engine
        writer = LiteratureWriter(engine)
        literature_api = LiteratureApi(
            LiteratureService(
                read_port=LiteraturePreconditionReader(engine, foundation.verified_reader),
                identity_port=writer,
                content_port=SqliteContentPublication(
                    engine,
                    foundation.artifact_store,
                    foundation.verified_reader,
                ),
                reference_port=writer,
                maintenance_port=writer,
                id_factory=_UuidLiteratureIds(),
                query_port=LiteratureReader(engine, foundation.verified_reader),
                artifact_read_port=LiteratureArtifactReader(engine, foundation.verified_reader),
            )
        )
        artifact_reconciler = ArtifactStoreReconciler(
            foundation.storage_root,
            SqliteArtifactReferenceStore(engine),
        )
        return _ScopedStorageComponents(
            foundation=foundation,
            atomic_user_output=AtomicOutput(max_bytes=536_870_912),
            write_admission=_CatalogWriteAdmission(engine.catalog_path, artifact_reconciler),
            discovery_repository=SqliteDiscoveryRepository(engine),
            entry_reader=SqliteEntryReader(engine, foundation.verified_reader),
            artifact_reconciler=artifact_reconciler,
            literature_api=literature_api,
            literature_writer=writer,
        )
    except BaseException:
        _rollback_fresh_storage(foundation.ownership)
        raise


def _finish_scoped_graph(
    storage: _ScopedStorageComponents,
    graph: object,
    *,
    configure_process_logging: bool,
    logging_level: int,
) -> object:
    try:
        if configure_process_logging:
            logger_state = _project_logger_state()
            try:
                from sciretriever.logging.api import configure_logging

                configure_logging(level=logging_level)
            except BaseException:
                _restore_project_logger(logger_state)
                raise
    except BaseException:
        _rollback_fresh_storage(storage.foundation.ownership)
        raise
    _release_fresh_storage_ownership(storage.foundation.ownership)
    return graph


def _raise_production_assembly_error(error: Exception) -> NoReturn:
    """Translate every production assembly failure to one stable safe code."""

    from sciretriever.acquisition.registry import AcquisitionRegistryError
    from sciretriever.analysis.ports import AnalysisLLMFailure
    from sciretriever.metadata.registry import MetadataRegistryError
    from sciretriever.parsing.adapters.mineru import MinerUProtocol2Error
    from sciretriever.storage.files.output import AtomicOutputError
    from sciretriever.storage.files.paths import StoragePathError
    from sciretriever.storage.files.store import ArtifactStoreError
    from sciretriever.storage.sqlite.engine import CatalogError

    if isinstance(error, MetadataRegistryError):
        raise BootstrapError("metadata-not-ready") from None
    if isinstance(error, AcquisitionRegistryError):
        raise BootstrapError("acquisition-not-ready") from None
    if isinstance(error, MinerUProtocol2Error):
        raise BootstrapError("parser-not-ready") from None
    if isinstance(error, AnalysisLLMFailure):
        raise BootstrapError("analysis-not-ready") from None
    if isinstance(
        error,
        (
            CatalogError,
            StoragePathError,
            ArtifactStoreError,
            AtomicOutputError,
            OSError,
        ),
    ):
        raise BootstrapError("storage-unavailable") from None
    raise BootstrapError("assembly-failed") from None


def _build_metadata_components(
    configuration: Configuration,
    credentials: CredentialLookup,
    coordinator: AccessCoordinator,
    http_client: HttpClient,
) -> tuple[MetadataRegistry, MetadataApi]:
    from sciretriever.metadata.api import MetadataApi
    from sciretriever.metadata.registry import MetadataAssemblyDependencies, build_metadata_registry
    from sciretriever.metadata.service import MetadataService

    registry = build_metadata_registry(
        configuration,
        credentials,
        MetadataAssemblyDependencies(
            http_client=http_client,
            access_coordinator=coordinator,
            observation_id_factory=_new_observation_id,
            provenance_id_factory=_new_provenance_id,
            clock=_UtcClock().now,
        ),
    )
    api = MetadataApi(
        MetadataService(
            topic_search_ports=registry.topic_search_ports,
            lookup_ports=registry.lookup_ports,
            reference_query_ports=registry.reference_query_ports,
        )
    )
    return registry, api


def _build_analysis_llm(
    configuration: Configuration,
    secrets: RuntimeSecretLookup,
    http_client: HttpClient,
    coordinator: AccessCoordinator,
) -> AnalysisLLMPort:
    from sciretriever.analysis.ports import AnalysisLLMFailure
    from sciretriever.analysis.providers.anthropic import AnthropicAnalysisLLMAdapter
    from sciretriever.analysis.providers.openai import OpenAIAnalysisLLMAdapter
    from sciretriever.analysis.providers.openai_chat import (
        OpenAIChatCompletionsAnalysisLLMAdapter,
    )
    from sciretriever.model.configuration import AnalysisProtocol

    if getattr(http_client, "_coordinator", None) is not coordinator:
        raise BootstrapError("analysis-not-ready")
    analysis = configuration.analysis
    adapter_by_protocol = {
        AnalysisProtocol.OPENAI_RESPONSES: OpenAIAnalysisLLMAdapter,
        AnalysisProtocol.OPENAI_CHAT_COMPLETIONS: OpenAIChatCompletionsAnalysisLLMAdapter,
        AnalysisProtocol.ANTHROPIC_MESSAGES: AnthropicAnalysisLLMAdapter,
    }
    try:
        analysis_api_key = secrets.analysis_api_key
        if analysis.authentication is AnalysisAuthentication.API_KEY and analysis_api_key is None:
            raise BootstrapError("analysis-not-ready")
        protocol = analysis.protocol
        base_url = analysis.base_url
        if protocol is None or base_url is None:
            raise BootstrapError("analysis-not-ready")
        adapter = adapter_by_protocol[protocol]
        provider_name = (
            analysis.provider.value
            if analysis.provider is not AnalysisProvider.CUSTOM
            else analysis.service_name or "custom"
        )
        return cast(
            AnalysisLLMPort,
            adapter(
                http_client=http_client,
                api_key=analysis_api_key,
                base_url=base_url,
                provider_name=provider_name,
                limits=_analysis_provider_limits(configuration),
            ),
        )
    except (AnalysisLLMFailure, KeyError, TypeError, ValueError):
        raise BootstrapError("analysis-not-ready") from None


def _build_scoped_production_graph(  # noqa: C901, PLR0915
    configuration: Configuration,
    *,
    scope: ProductionEntryScope,
    credentials_home: str | Path | None,
    configure_process_logging: bool,
    logging_level: int,
) -> (
    TopicDiscoveryObjectGraph
    | CitationDiscoveryObjectGraph
    | DatabaseCompletionObjectGraph
    | ManualPdfObjectGraph
    | BibliographyExchangeObjectGraph
):
    from sciretriever.acquisition.api import AcquisitionApi
    from sciretriever.acquisition.manual import ManualPdfAdmissionService
    from sciretriever.acquisition.publication import (
        PrimaryPdfPublisher,
        ValidatedPrimaryPdfPublisher,
    )
    from sciretriever.acquisition.registry import (
        AcquisitionAssemblyDependencies,
        AcquisitionRegistry,
        build_acquisition_registry,
        production_web_access_profile_resolver,
    )
    from sciretriever.acquisition.tiered_service import TieredAcquisitionService
    from sciretriever.analysis.api import AnalysisApi
    from sciretriever.analysis.references import ReferenceLookupStage
    from sciretriever.analysis.service import AnalysisService
    from sciretriever.entry.citations import CitationDiscoveryOperation
    from sciretriever.entry.completion import (
        AssetDatabaseCompletionOperation,
        DatabaseCompletionOperation,
    )
    from sciretriever.entry.discovery import TopicDiscoveryOperation
    from sciretriever.entry.exchange import BibliographyCodecs, BibliographyOperations
    from sciretriever.entry.manual import ManualPdfOperation
    from sciretriever.metadata.publication import MetadataPublication
    from sciretriever.parsing.api import ParsingApi
    from sciretriever.parsing.service import ParsingService
    from sciretriever.storage.analysis_artifacts import AnalysisArtifactPublisher
    from sciretriever.storage.completion import CompletionInputBuilder
    from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging
    from sciretriever.storage.sqlite.acquisition_publication import SqliteAcquisitionPublication
    from sciretriever.storage.sqlite.analysis_artifacts import AnalysisArtifactReader
    from sciretriever.storage.sqlite.analysis_inputs import SqliteAnalysisCurrentInputs
    from sciretriever.storage.sqlite.metadata_publication import (
        SqliteProviderRelationObservationPublication,
    )
    from sciretriever.storage.sqlite.no_usable_content_cleanup import SqliteNoUsableContentCleanup
    from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

    needs_metadata = scope in {
        ProductionEntryScope.TOPIC_DISCOVERY,
        ProductionEntryScope.CITATION_DISCOVERY,
    }
    needs_acquisition = scope in {
        ProductionEntryScope.ASSET_COMPLETION,
        ProductionEntryScope.CONTENT_COMPLETION,
    }
    needs_parser = scope is ProductionEntryScope.CONTENT_COMPLETION
    needs_analysis = scope in {
        ProductionEntryScope.CITATION_DISCOVERY,
        ProductionEntryScope.CONTENT_COMPLETION,
    }
    needs_provider_credentials = needs_metadata or (
        needs_acquisition and bool(configuration.sources.acquisition.providers)
    )
    needs_runtime_credentials = (
        needs_parser and configuration.parsing.connection_mode is ParserConnectionMode.REMOTE
    ) or (
        needs_analysis and configuration.analysis.authentication is AnalysisAuthentication.API_KEY
    )
    needs_credentials = needs_provider_credentials or needs_runtime_credentials
    _require_paths_configuration(configuration)
    if needs_parser:
        _require_parser_configuration(configuration)
    if scope is ProductionEntryScope.CITATION_DISCOVERY:
        _require_reference_analysis_configuration(configuration)
    elif needs_analysis:
        _require_analysis_configuration(configuration)
    if needs_metadata and not configuration.sources.metadata.providers:
        raise BootstrapError("metadata-not-ready")

    credentials = load_credentials(home=credentials_home) if needs_credentials else None
    secrets = load_runtime_secrets(
        configuration,
        credentials=credentials,
        include_parser=needs_parser,
        include_analysis=needs_analysis,
    )
    coordinator, http_client = (
        _new_shared_network()
        if (needs_metadata or needs_acquisition or needs_parser or needs_analysis)
        else (None, None)
    )
    clock = _UtcClock()
    acquisition_registry: AcquisitionRegistry | None = None
    if needs_acquisition:
        assert coordinator is not None and http_client is not None
        acquisition_registry = build_acquisition_registry(
            configuration,
            AcquisitionAssemblyDependencies(
                http_client=http_client,
                access_coordinator=coordinator,
                web_access_profile_resolver=production_web_access_profile_resolver(),
                provenance_id_factory=_new_provenance_id,
                clock=clock.now,
                credentials=credentials,
            ),
        )

    # Acquisition readiness includes enabled authorized-API credentials.  It
    # must be closed before Catalog or ArtifactStore construction, even though
    # a later rollback could otherwise hide that persistent roots were touched.
    storage = _build_scoped_storage(configuration)
    try:
        pdf_validation_staging = SystemPdfValidationStaging()
        engine = storage.foundation.engine
        literature_api = storage.literature_api
        if scope is ProductionEntryScope.MANUAL_PDF:
            publication = SqliteAcquisitionPublication(
                engine,
                storage.foundation.artifact_store,
                storage.foundation.verified_reader,
            )
            operation = ManualPdfOperation(
                current_facts_reader=storage.entry_reader,
                manual_admission=ManualPdfAdmissionService(
                    publication_port=ValidatedPrimaryPdfPublisher(publication),
                    staging=pdf_validation_staging,
                    provenance_id_factory=_new_provenance_id,
                    clock=clock.now,
                ),
                write_admission=storage.write_admission,
                recovery=storage.discovery_repository,
            )
            graph: object = ManualPdfObjectGraph(
                configuration=configuration,
                entry_api=_ManualPdfEntry(operation),
            )
        elif scope is ProductionEntryScope.BIBLIOGRAPHY_EXCHANGE:
            operation = BibliographyOperations(
                literature=literature_api,
                codec=BibliographyCodecs(max_input_bytes=configuration.library.max_input_bytes),
                output=storage.atomic_user_output,
                selector_reader=storage.entry_reader,
                clock=clock,
                write_admission=storage.write_admission,
                recovery=storage.discovery_repository,
                observation_id_factory=_new_observation_id,
                provenance_id_factory=_new_provenance_id,
                provider_precedence=tuple(
                    item.value for item in configuration.sources.metadata.providers
                ),
            )
            graph = BibliographyExchangeObjectGraph(
                configuration=configuration,
                entry_api=_BibliographyExchangeEntry(
                    operation.import_bibliography,
                    operation.export_bibliography,
                ),
            )
        elif needs_metadata:
            assert credentials is not None and coordinator is not None and http_client is not None
            registry, metadata_api = _build_metadata_components(
                configuration, credentials, coordinator, http_client
            )
            publication = MetadataPublication(
                literature_api,
                SqliteProviderRelationObservationPublication(storage.literature_writer),
            )
            precedence = tuple(item.provider_name for item in registry.registrations)
            if scope is ProductionEntryScope.TOPIC_DISCOVERY:
                operation = TopicDiscoveryOperation(
                    metadata=metadata_api,
                    metadata_publication=publication,
                    repository=storage.discovery_repository,
                    publication=storage.discovery_repository,
                    clock=clock,
                    write_admission=storage.write_admission,
                    recovery=storage.discovery_repository,
                    provider_precedence=precedence,
                )
                graph = TopicDiscoveryObjectGraph(
                    configuration=configuration,
                    topic_provider_limits=registry.topic_limits,
                    entry_api=_TopicDiscoveryEntry(operation),
                )
            else:
                llm = _build_analysis_llm(configuration, secrets, http_client, coordinator)
                analysis_api = AnalysisApi.for_reference_lookup(
                    ReferenceLookupStage(
                        llm=llm,
                        model=configuration.analysis.model or "",
                        max_output_tokens=configuration.analysis.reference_max_output_tokens or 0,
                    )
                )
                operation = CitationDiscoveryOperation(
                    metadata=metadata_api,
                    relation_publication=publication,
                    literature=literature_api,
                    analysis=analysis_api,
                    candidate_reader=storage.entry_reader,
                    run_repository=storage.discovery_repository,
                    discovery_publication=storage.discovery_repository,
                    write_admission=storage.write_admission,
                    recovery=storage.discovery_repository,
                    clock=clock,
                    provider_precedence=precedence,
                )
                graph = CitationDiscoveryObjectGraph(
                    configuration=configuration,
                    citation_provider_limits=registry.citation_limits,
                    entry_api=_CitationDiscoveryEntry(operation),
                )
        else:
            assert coordinator is not None and http_client is not None
            assert acquisition_registry is not None
            acquisition_publication = SqliteAcquisitionPublication(
                engine,
                storage.foundation.artifact_store,
                storage.foundation.verified_reader,
            )
            validated = ValidatedPrimaryPdfPublisher(acquisition_publication)
            acquisition_api = AcquisitionApi(
                TieredAcquisitionService(
                    route_registry=acquisition_registry.route_registry,
                    planner=acquisition_registry.planner,
                    publication_port=PrimaryPdfPublisher(
                        validated,
                        staging=pdf_validation_staging,
                    ),
                    exhaustion_port=acquisition_publication,
                    exhaustion_clear_port=acquisition_publication,
                )
            )
            inputs = CompletionInputBuilder(engine, storage.foundation.verified_reader)
            if scope is ProductionEntryScope.ASSET_COMPLETION:
                completion = AssetDatabaseCompletionOperation(
                    selector_reader=storage.entry_reader,
                    current_facts_reader=storage.entry_reader,
                    write_admission=storage.write_admission,
                    recovery=storage.discovery_repository,
                    acquisition=acquisition_api,
                    acquisition_requests=inputs,
                    max_concurrency=configuration.execution.max_concurrency,
                )
            else:
                parser = _production_dependencies(configuration, secrets).parser_factory(
                    http_client, coordinator
                )
                llm = _build_analysis_llm(configuration, secrets, http_client, coordinator)
                parsing_api = ParsingApi(
                    ParsingService(
                        parser=parser,
                        result_store=SqliteParserResultPublication(
                            engine,
                            storage.foundation.artifact_store,
                            storage.foundation.verified_reader,
                        ),
                    )
                )
                analysis_api = AnalysisApi(
                    content_service=AnalysisService(
                        llm=llm,
                        artifact_reader=AnalysisArtifactReader(
                            engine, storage.foundation.verified_reader
                        ),
                        current_inputs=SqliteAnalysisCurrentInputs(engine),
                        artifact_publisher=AnalysisArtifactPublisher(
                            storage.foundation.artifact_store
                        ),
                        model=configuration.analysis.model or "",
                        metadata_max_output_tokens=configuration.analysis.metadata_max_output_tokens
                        or 0,
                        content_max_output_tokens=configuration.analysis.content_max_output_tokens
                        or 0,
                        limits=_analysis_limits(configuration),
                        provenance_id_factory=_new_provenance_id,
                        clock=clock.now,
                    ),
                    reference_lookup_stage=ReferenceLookupStage(
                        llm=llm,
                        model=configuration.analysis.model or "",
                        max_output_tokens=configuration.analysis.reference_max_output_tokens or 0,
                    ),
                )
                completion = DatabaseCompletionOperation(
                    selector_reader=storage.entry_reader,
                    current_facts_reader=storage.entry_reader,
                    write_admission=storage.write_admission,
                    recovery=storage.discovery_repository,
                    acquisition=acquisition_api,
                    acquisition_requests=inputs,
                    parsing=parsing_api,
                    parser_requests=inputs,
                    analysis=analysis_api,
                    analysis_inputs=inputs,
                    literature=literature_api,
                    cleanup=SqliteNoUsableContentCleanup(engine),
                    max_concurrency=configuration.execution.max_concurrency,
                )
            graph = DatabaseCompletionObjectGraph(
                configuration=configuration,
                entry_api=_DatabaseCompletionEntry(completion),
            )
    except BaseException:
        _rollback_fresh_storage(storage.foundation.ownership)
        raise
    return cast(
        TopicDiscoveryObjectGraph
        | CitationDiscoveryObjectGraph
        | DatabaseCompletionObjectGraph
        | ManualPdfObjectGraph
        | BibliographyExchangeObjectGraph,
        _finish_scoped_graph(
            storage,
            graph,
            configure_process_logging=configure_process_logging,
            logging_level=logging_level,
        ),
    )


def build_production_object_graph(  # noqa: C901
    configuration: Configuration,
    *,
    scope: ProductionEntryScope | None = None,
    credentials_home: str | Path | None = None,
    configure_process_logging: bool = True,
    logging_level: int = logging.INFO,
) -> (
    ApplicationObjectGraph
    | LocalLibraryObjectGraph
    | TopicDiscoveryObjectGraph
    | CitationDiscoveryObjectGraph
    | DatabaseCompletionObjectGraph
    | ManualPdfObjectGraph
    | BibliographyExchangeObjectGraph
):
    """Build the real graph after a complete no-storage static preflight."""

    try:
        if not isinstance(configuration, Configuration):
            raise BootstrapError("configuration-invalid")
        if scope is not None and not isinstance(scope, ProductionEntryScope):
            raise BootstrapError("configuration-invalid")
        if scope is ProductionEntryScope.LOCAL_LIBRARY:
            return _build_local_library_graph(
                configuration,
                configure_process_logging=configure_process_logging,
                logging_level=logging_level,
            )
        if scope is not None:
            return _build_scoped_production_graph(
                configuration,
                scope=scope,
                credentials_home=credentials_home,
                configure_process_logging=configure_process_logging,
                logging_level=logging_level,
            )
        _required_production_configuration(configuration)
        # Load ADR 0014 credentials exactly once.  The same short-lived bundle
        # is consumed by every readiness check and Provider adapter below.
        credentials = load_credentials(home=credentials_home)
        secrets = load_runtime_secrets(configuration, credentials=credentials)
        dependencies = _production_dependencies(configuration, secrets)
        return build_object_graph(
            configuration,
            catalog_path=configuration.paths.catalog_path or "",
            artifact_root=configuration.paths.artifact_root or "",
            external_dependencies=dependencies,
            credentials=credentials,
            configure_process_logging=configure_process_logging,
            logging_level=logging_level,
        )
    except BootstrapError:
        raise
    except ConfigurationError:
        raise BootstrapError("configuration-invalid") from None
    except Exception as error:
        _raise_production_assembly_error(error)


__all__ = (
    "ApplicationObjectGraph",
    "BibliographyExchangeObjectGraph",
    "BootstrapError",
    "BootstrapExternalDependencies",
    "CitationDiscoveryObjectGraph",
    "DatabaseCompletionObjectGraph",
    "LocalLibraryObjectGraph",
    "ManualPdfObjectGraph",
    "ProductionConfigurationProbeSession",
    "ProductionEntryScope",
    "TopicDiscoveryObjectGraph",
    "build_object_graph",
    "build_production_configuration_probe_session",
    "build_production_object_graph",
)
