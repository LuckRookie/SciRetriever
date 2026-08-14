"""Exercise installed-wheel database completion with test-owned external Ports.

This driver runs under the fresh virtual environment created by the acceptance
fixture.  Entry orchestration, Acquisition validation/publication, Parsing,
Analysis, Literature, SQLite, and ArtifactStore all come from the installed
wheel.  Only the external PDF Source, Parser, and language-model capabilities,
plus deterministic identities and time, are owned by this test.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import threading
from collections import Counter
from contextlib import AbstractContextManager, closing, contextmanager
from pathlib import Path
from typing import BinaryIO, Callable, Iterator

from PyPDF2 import PdfWriter

import sciretriever.acquisition.tiered_service as acquisition_service_module
import sciretriever.analysis.service as analysis_service_module
import sciretriever.entry.completion as entry_completion_module
import sciretriever.literature.service as literature_service_module
import sciretriever.parsing.service as parsing_service_module
import sciretriever.storage.completion as storage_completion_module
from sciretriever.acquisition.access_profiles import PublisherAccessProfileCatalog
from sciretriever.acquisition.api import AcquisitionApi
from sciretriever.acquisition.outcomes import RouteExecutionResult
from sciretriever.acquisition.planning import (
    AcquisitionPlanBuilder,
    ProgressiveAcquisitionPlanner,
    PublisherAccessResolver,
    RouteCapability,
    RouteReadiness,
    RouteSpec,
)
from sciretriever.acquisition.ports import (
    CandidateKeyTracker,
    TemporaryPdf,
)
from sciretriever.acquisition.publication import (
    PrimaryPdfPublisher,
    ValidatedPrimaryPdfPublisher,
)
from sciretriever.acquisition.routes import (
    AcquisitionRouteRegistry,
    RouteAdapterBinding,
    RouteExecutionContext,
    delivery_results,
)
from sciretriever.acquisition.routing import AcquisitionRequest
from sciretriever.acquisition.tiered_service import TieredAcquisitionService
from sciretriever.analysis.api import AnalysisApi
from sciretriever.analysis.content import ContentAnalysisLimits
from sciretriever.analysis.ports import AnalysisLLMCall, AnalysisLLMFailure
from sciretriever.analysis.references import ReferenceLookupStage
from sciretriever.analysis.service import AnalysisService
from sciretriever.entry.completion import DatabaseCompletionOperation
from sciretriever.literature.api import LiteratureApi
from sciretriever.literature.ports import LiteratureArtifactReference
from sciretriever.literature.service import LiteratureService
from sciretriever.metadata.publication import MetadataPublication
from sciretriever.model.acquisition import AcquisitionPath, PdfCandidate
from sciretriever.model.execution import AllPendingSelector, BatchRequest, LiteratureSelector
from sciretriever.model.literature import Identifier
from sciretriever.model.llm import (
    LLMProvenance,
    LLMRequestKind,
    LLMStructuredResponse,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.parsing import ParserArtifactRef, ParserProvenance, ParserRequest
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.parsing.api import ParsingApi
from sciretriever.parsing.ports import ParsingFailure, StagedParserArtifact, StagedParserOutput
from sciretriever.parsing.service import ParsingService
from sciretriever.storage.analysis_artifacts import AnalysisArtifactPublisher
from sciretriever.storage.completion import CompletionInputBuilder
from sciretriever.storage.files.paths import StorageRoot, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.reconciliation import ArtifactStoreReconciler
from sciretriever.storage.files.store import ArtifactStore
from sciretriever.storage.literature_artifacts import LiteratureArtifactReader
from sciretriever.storage.locking import CatalogWriteLock
from sciretriever.storage.pdf_validation_staging import SystemPdfValidationStaging
from sciretriever.storage.sqlite.acquisition_publication import SqliteAcquisitionPublication
from sciretriever.storage.sqlite.analysis_artifacts import AnalysisArtifactReader
from sciretriever.storage.sqlite.analysis_inputs import SqliteAnalysisCurrentInputs
from sciretriever.storage.sqlite.artifact_references import SqliteArtifactReferenceStore
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.discovery_repository import SqliteDiscoveryRepository
from sciretriever.storage.sqlite.engine import CatalogEngine
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

_TIME = UtcTimestamp("2026-08-12T16:00:00Z")
_SOURCE_NAME = "acceptance-pdf-source"
_PARSER_NAME = "acceptance-parser"
_LLM_PROVIDER = "acceptance-llm"
_LLM_MODEL = "acceptance-model"
_SUCCESS_TITLE = "Controlled completion study"
_REPLACEMENT_TITLE = "Controlled candidate replacement study"
_EXHAUSTION_TITLE = "Controlled exhaustion retry study"
_PARSER_FAILURE_TITLE = "Controlled parser retry study"
_LLM_FAILURE_TITLE = "Controlled LLM retry study"
_PARTIAL_SUCCESS_TITLE = "Controlled partial batch success study"


def _uuid(namespace: int, number: int) -> str:
    return f"{namespace:08x}-0000-4000-8000-{number:012x}"


def _pdf_bytes(label: str) -> bytes:
    buffer = io.BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({"/Title": label})
    writer.write(buffer)
    return buffer.getvalue()


def _parser_markdown(title: str) -> str:
    return f"""# {title}

The controlled offline study evaluates retrieval for quantum materials.
The study appears in Acceptance Journal in 2026.

# References

Controlled offline reference.
"""


def _content_draft() -> str:
    return """# 研究背景与目标

The controlled offline study evaluates retrieval for quantum materials.

# 研究方法

未提供

# 数据

未提供

# 结论与局限性

未提供

# 参考文献

1. Controlled offline reference.
"""


class _Ids:
    def __init__(self) -> None:
        self._next_value = 100_000

    def _next(self) -> str:
        self._next_value += 1
        return _uuid(90, self._next_value)

    def new_literature_id(self) -> LiteratureId:
        return LiteratureId(self._next())

    def new_meta_literature_id(self) -> MetaLiteratureId:
        return MetaLiteratureId(self._next())

    def new_reference_id(self) -> ReferenceId:
        return ReferenceId(self._next())


class _WriteAdmission:
    def __init__(
        self,
        catalog_path: Path,
        reconciler: ArtifactStoreReconciler,
    ) -> None:
        self._catalog_path = catalog_path
        self._reconciler = reconciler

    @contextmanager
    def acquire_nowait(self) -> Iterator[None]:
        with CatalogWriteLock(self._catalog_path):
            self._reconciler.reconcile_admitted()
            try:
                yield None
            except BaseException:
                raise
            else:
                self._reconciler.reconcile_admitted()


class _TemporaryBytes:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.open_count = 0
        self.discard_count = 0

    def open(self) -> AbstractContextManager[BinaryIO]:
        self.open_count += 1
        return closing(io.BytesIO(self._payload))

    def discard(self) -> None:
        if self.discard_count == 0:
            self.discard_count = 1


class _ArtifactBytes:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload

    def open(self) -> AbstractContextManager[BinaryIO]:
        return closing(io.BytesIO(self._payload))


class _Source:
    def __init__(self, pdf_by_candidate: dict[str, bytes]) -> None:
        self._pdf_by_candidate = dict(pdf_by_candidate)
        self.candidates_by_title: dict[str, list[str]] = {}
        self.requests: list[dict[str, object]] = []
        self.temporary_content: list[_TemporaryBytes] = []
        self.before_acquire_by_title: dict[str, Callable[[AcquisitionRequest], None]] = {}

    @property
    def source_name(self) -> str:
        return _SOURCE_NAME

    @property
    def acquisition_path(self) -> AcquisitionPath:
        return AcquisitionPath.PUBLIC

    @property
    def route_key(self) -> str:
        return "public:acceptance-fixture"

    def execute(self, context: RouteExecutionContext) -> Iterator[RouteExecutionResult]:
        if not isinstance(context, RouteExecutionContext):
            raise TypeError("context must be RouteExecutionContext")
        return delivery_results(self._deliveries(context.request, context.candidate_keys))

    def _deliveries(
        self,
        request: AcquisitionRequest,
        candidate_keys: CandidateKeyTracker,
    ) -> Iterator[TemporaryPdf]:
        title = request.literature.metadata.title
        if title is None:
            raise RuntimeError("controlled Literature must have a title")
        configured = tuple(self.candidates_by_title.get(title, ()))
        self.requests.append(
            {
                "title": title,
                "configured": configured,
                "excluded": tuple(sorted(request.excluded_candidate_keys)),
            }
        )
        before_acquire = self.before_acquire_by_title.get(title)
        if before_acquire is not None:
            before_acquire(request)
        for ordinal, candidate_key in enumerate(configured, start=1):
            if not candidate_keys.claim(candidate_key):
                continue
            content = _TemporaryBytes(self._pdf_by_candidate[candidate_key])
            self.temporary_content.append(content)
            yield TemporaryPdf(
                candidate=PdfCandidate(
                    candidate_key=candidate_key,
                    source_name=self.source_name,
                    acquisition_path=self.acquisition_path,
                    declared_media_type="application/pdf",
                ),
                content=content,
                safe_source_url=f"https://offline.invalid/{ordinal}.pdf",
                provenance=Provenance(
                    provenance_id=ProvenanceId(_uuid(20, len(self.temporary_content))),
                    source_kind=SourceKind.ASSET_PROVIDER,
                    source_name=self.source_name,
                    source_record_id=f"candidate-{candidate_key}",
                    observed_at=_TIME,
                    input_sha256=sha256_digest(candidate_key.encode()),
                    parameters_sha256=None,
                ),
            )


class _Parser:
    def __init__(self, pdf_by_candidate: dict[str, bytes]) -> None:
        self._candidate_by_sha256 = {
            sha256_digest(payload): candidate_key
            for candidate_key, payload in pdf_by_candidate.items()
        }
        self._pdf_by_candidate = dict(pdf_by_candidate)
        self.requests: list[ParserRequest] = []
        self.candidate_keys: list[str] = []
        self.fail_once_candidate_keys: set[str] = set()
        self.attempts_by_candidate: Counter[str] = Counter()

    def parse(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> StagedParserOutput:
        if cancel_event is not None and cancel_event.is_set():
            raise RuntimeError("parser received a cancelled request")
        with request.content_ref.open() as stream:
            payload = stream.read()
        candidate_key = self._candidate_by_sha256.get(request.source_sha256)
        if (
            candidate_key is None
            or sha256_digest(payload) != request.source_sha256
            or self._pdf_by_candidate[candidate_key] != payload
        ):
            raise RuntimeError("parser did not receive the exact acquired PDF bytes")
        self.requests.append(request)
        self.candidate_keys.append(candidate_key)
        self.attempts_by_candidate[candidate_key] += 1
        if (
            candidate_key in self.fail_once_candidate_keys
            and self.attempts_by_candidate[candidate_key] == 1
        ):
            raise ParsingFailure(
                StableFailure(
                    code="acceptance-parser-failed-once",
                    reason="The controlled Parser failed on its first attempt.",
                    action="Retry Parsing from the persisted primary PDF.",
                    retryable=True,
                )
            )
        parser_title = _SUCCESS_TITLE if candidate_key == "success-candidate" else candidate_key
        markdown_bytes = _parser_markdown(parser_title).encode()
        markdown = StagedParserArtifact(
            artifact=ParserArtifactRef(
                sha256=sha256_digest(markdown_bytes),
                media_type="text/markdown",
                byte_size=len(markdown_bytes),
            ),
            content=_ArtifactBytes(markdown_bytes),
        )
        return StagedParserOutput(
            source_asset_id=request.source_asset_id,
            source_sha256=request.source_sha256,
            page_count=1,
            markdown=markdown,
            resources=(),
            provenance=ParserProvenance(
                provenance=Provenance(
                    provenance_id=ProvenanceId(_uuid(30, len(self.requests))),
                    source_kind=SourceKind.PARSER,
                    source_name=_PARSER_NAME,
                    source_record_id=None,
                    observed_at=_TIME,
                    input_sha256=request.source_sha256,
                    parameters_sha256=sha256_digest(b"acceptance-parser-parameters"),
                ),
                parser_version="1.0",
                mode="offline",
                model_identity=None,
            ),
        )


class _LLM:
    def __init__(self) -> None:
        self.calls: list[AnalysisLLMCall] = []
        self.no_usable_once_titles: set[str] = set()
        self.fail_metadata_once_titles: set[str] = set()
        self.metadata_attempts: Counter[str] = Counter()

    @property
    def provider_name(self) -> str:
        return _LLM_PROVIDER

    def complete(self, call: AnalysisLLMCall) -> LLMStructuredResponse:
        self.calls.append(call)
        structured = json.loads(call.structured_input)
        if call.request.kind is LLMRequestKind.METADATA:
            initial = LiteratureMetadata.model_validate(structured["initial_metadata"])
            title = initial.title or ""
            self.metadata_attempts[title] += 1
            if title in self.fail_metadata_once_titles and self.metadata_attempts[title] == 1:
                raise AnalysisLLMFailure(
                    StableFailure(
                        code="acceptance-llm-failed-once",
                        reason="The controlled language model failed on its first attempt.",
                        action="Retry Analysis from the persisted Parser result.",
                        retryable=True,
                    )
                )
            if title in self.no_usable_once_titles and self.metadata_attempts[title] == 1:
                result = '{"metadata":null,"outcome":"no_usable_content"}'
            else:
                result = json.dumps(
                    {
                        "metadata": initial.model_dump(mode="json"),
                        "outcome": "usable",
                    },
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                )
        elif call.request.kind is LLMRequestKind.CONTENT:
            result = json.dumps(
                {"markdown": _content_draft()},
                ensure_ascii=False,
                separators=(",", ":"),
            )
        else:
            raise AssertionError("database completion must not run reference lookup")
        return LLMStructuredResponse(
            result=result,
            provenance=LLMProvenance(
                provider=self.provider_name,
                model=call.request.model,
                input_sha256=call.request.input_sha256,
                parameters_sha256=sha256_digest(f"{call.request.kind.value}-parameters".encode()),
            ),
        )


def _metadata_observation(
    number: int,
    title: str,
) -> MetadataObservation:
    metadata = LiteratureMetadata(
        title=title,
        publication_year=2026,
        venue="Acceptance Journal",
        identifiers=(Identifier(namespace="doi", value=f"10.5555/completion.{number}"),),
        keywords=("retrieval", "quantum materials"),
    )
    return MetadataObservation(
        observation_id=ObservationId(_uuid(10, number)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_uuid(11, number)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name="acceptance-metadata-provider",
            source_record_id=f"record-{number}",
            observed_at=_TIME,
            input_sha256=sha256_digest(f"metadata-{number}".encode()),
            parameters_sha256=None,
        ),
        metadata=metadata,
    )


def _artifact_bytes(
    literature: LiteratureApi,
    reference: LiteratureArtifactReference,
) -> bytes:
    with literature.open_artifact(reference) as stream:
        return stream.read()


def _configuration(catalog: Path, artifacts: Path) -> str:
    return f"""
[paths]
catalog_path = {json.dumps(os.fspath(catalog))}
artifact_root = {json.dumps(os.fspath(artifacts))}
"""


def _console_detail(
    *,
    root: Path,
    configuration: Path,
    literature_id: LiteratureId,
) -> dict[str, object]:
    environment = dict(os.environ)
    environment["SCIRETRIEVER_CONFIG"] = os.fspath(configuration)
    completed = subprocess.run(
        (
            os.fspath(Path(sys.executable).with_name("sciretriever")),
            "literature",
            "show",
            literature_id.root,
            "--json",
        ),
        cwd=root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    return {
        "returncode": completed.returncode,
        "stderr": completed.stderr,
        "stdout": completed.stdout,
    }


def _console_export(
    *,
    root: Path,
    configuration: Path,
    action: str,
    literature_id: LiteratureId,
    target: Path,
) -> dict[str, object]:
    environment = dict(os.environ)
    environment["SCIRETRIEVER_CONFIG"] = os.fspath(configuration)
    completed = subprocess.run(
        (
            os.fspath(Path(sys.executable).with_name("sciretriever")),
            "export",
            action,
            literature_id.root,
            os.fspath(target),
            "--json",
        ),
        cwd=root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    exported = target.read_bytes() if target.is_file() else None
    return {
        "bytes": None if exported is None else len(exported),
        "returncode": completed.returncode,
        "sha256": None if exported is None else sha256_digest(exported).root,
        "stderr": completed.stderr,
        "stdout": completed.stdout,
    }


root = Path(os.environ["SCIRETRIEVER_ACCEPTANCE_ROOT"]) / "database-completion"
root.mkdir(mode=0o700)
catalog = root / "catalog.sqlite3"
artifacts = root / "artifacts"
engine = CatalogEngine(catalog)
storage_root = StorageRoot(artifacts)
artifact_store = ArtifactStore(storage_root)
verified_reader = VerifiedReader(storage_root)
artifact_reconciler = ArtifactStoreReconciler(
    storage_root,
    SqliteArtifactReferenceStore(engine),
)
writer = LiteratureWriter(engine)
literature = LiteratureApi(
    LiteratureService(
        read_port=LiteraturePreconditionReader(engine, verified_reader),
        identity_port=writer,
        content_port=SqliteContentPublication(engine, artifact_store, verified_reader),
        reference_port=writer,
        maintenance_port=writer,
        id_factory=_Ids(),
        query_port=LiteratureReader(engine, verified_reader),
        artifact_read_port=LiteratureArtifactReader(engine, verified_reader),
    )
)
metadata_publication = MetadataPublication(
    literature,
    SqliteProviderRelationObservationPublication(writer),
)
accepted = []
for number, title in (
    (1, _SUCCESS_TITLE),
    (2, _REPLACEMENT_TITLE),
    (3, _EXHAUSTION_TITLE),
):
    result = metadata_publication.publish_observation(_metadata_observation(number, title))
    if result.decision != "created" or result.literature is None:
        raise RuntimeError("controlled metadata seed was not created")
    accepted.append(result.literature)
success_literature, replacement_literature, exhaustion_literature = accepted

pdf_by_candidate = {
    candidate_key: _pdf_bytes(candidate_key)
    for candidate_key in (
        "success-candidate",
        "rejected-content-candidate",
        "replacement-candidate",
        "exhaustion-retry-candidate",
        "parser-failure-candidate",
        "llm-failure-candidate",
        "partial-success-candidate",
    )
}
source = _Source(pdf_by_candidate)
source.candidates_by_title = {
    success_literature.metadata.title or "": ["success-candidate"],
    replacement_literature.metadata.title or "": [
        "rejected-content-candidate",
        "replacement-candidate",
    ],
    exhaustion_literature.metadata.title or "": [],
}
parser = _Parser(pdf_by_candidate)
llm = _LLM()
llm.no_usable_once_titles.add(replacement_literature.metadata.title or "")

acquisition_publication = SqliteAcquisitionPublication(
    engine,
    artifact_store,
    verified_reader,
)
acquisition_profile_catalog = PublisherAccessProfileCatalog(())
acquisition_route_spec = RouteSpec(
    route_key=source.route_key,
    tier=source.acquisition_path,
    capability=RouteCapability.DIRECT_PDF,
    readiness=RouteReadiness.READY,
)
acquisition = AcquisitionApi(
    TieredAcquisitionService(
        route_registry=AcquisitionRouteRegistry(
            profile_catalog=acquisition_profile_catalog,
            bindings=(
                RouteAdapterBinding(
                    spec=acquisition_route_spec,
                    adapter=source,
                ),
            ),
        ),
        planner=ProgressiveAcquisitionPlanner(
            resolver=PublisherAccessResolver(acquisition_profile_catalog),
            builder=AcquisitionPlanBuilder(acquisition_profile_catalog),
            route_specs=(acquisition_route_spec,),
            doi_landing_resolver=None,
        ),
        publication_port=PrimaryPdfPublisher(
            ValidatedPrimaryPdfPublisher(acquisition_publication),
            staging=SystemPdfValidationStaging(parent=root),
        ),
        exhaustion_port=acquisition_publication,
        exhaustion_clear_port=acquisition_publication,
    )
)
parsing = ParsingApi(
    ParsingService(
        parser=parser,
        result_store=SqliteParserResultPublication(
            engine,
            artifact_store,
            verified_reader,
        ),
    )
)
analysis = AnalysisApi(
    content_service=AnalysisService(
        llm=llm,
        artifact_reader=AnalysisArtifactReader(engine, verified_reader),
        current_inputs=SqliteAnalysisCurrentInputs(engine),
        artifact_publisher=AnalysisArtifactPublisher(artifact_store),
        model=_LLM_MODEL,
        metadata_max_output_tokens=2_048,
        content_max_output_tokens=4_096,
        limits=ContentAnalysisLimits(
            max_input_bytes=1_048_576,
            max_chunk_bytes=1_048_576,
            max_chunk_count=1,
            max_total_llm_requests=2,
            max_total_output_tokens=8_192,
        ),
        provenance_id_factory=lambda: ProvenanceId(_uuid(40, len(llm.calls) + 1)),
        clock=lambda: _TIME,
    ),
    reference_lookup_stage=ReferenceLookupStage(
        llm=llm,
        model=_LLM_MODEL,
        max_output_tokens=2_048,
    ),
)
entry_reader = SqliteEntryReader(engine, verified_reader)
completion_inputs = CompletionInputBuilder(engine, verified_reader)
repository = SqliteDiscoveryRepository(engine)
operation = DatabaseCompletionOperation(
    selector_reader=entry_reader,
    current_facts_reader=entry_reader,
    write_admission=_WriteAdmission(catalog, artifact_reconciler),
    recovery=repository,
    acquisition=acquisition,
    acquisition_requests=completion_inputs,
    parsing=parsing,
    parser_requests=completion_inputs,
    analysis=analysis,
    analysis_inputs=completion_inputs,
    literature=literature,
    cleanup=SqliteNoUsableContentCleanup(engine),
    max_concurrency=1,
)

success_report = operation(
    BatchRequest(
        selector=LiteratureSelector(
            kind="literatures",
            literature_ids=(success_literature.literature_id,),
        ),
        goal="CONTENT_READY",
    )
)
success_detail = literature.read_detail(success_literature.literature_id)
if (
    success_detail.primary_pdf is None
    or success_detail.parser_result is None
    or success_detail.content is None
):
    raise RuntimeError("complete success path did not persist all three stages")
success_artifacts = {
    "pdf": _artifact_bytes(literature, success_detail.primary_pdf.asset),
    "parser_markdown": _artifact_bytes(literature, success_detail.parser_result.markdown),
    "content_markdown": _artifact_bytes(literature, success_detail.content.markdown),
}

replacement_title = replacement_literature.metadata.title or ""
cleanup_observation: dict[str, object] = {}


def _observe_cleanup_before_reacquisition(request: AcquisitionRequest) -> None:
    if request.excluded_candidate_keys != frozenset({"rejected-content-candidate"}):
        return
    old_pdf = pdf_by_candidate["rejected-content-candidate"]
    old_pdf_path = content_addressed_reference(
        sha256_digest(old_pdf),
        len(old_pdf),
    ).root
    old_parser = _parser_markdown("rejected-content-candidate").encode()
    old_parser_path = content_addressed_reference(
        sha256_digest(old_parser),
        len(old_parser),
    ).root
    old_relative_paths = (old_pdf_path, old_parser_path)
    cleanup_observation["old_closure_paths"] = old_relative_paths
    cleanup_observation["physical_exists"] = tuple(
        (artifacts / path).exists() for path in old_relative_paths
    )
    with engine.read_snapshot() as connection:
        cleanup_observation["artifact_rows"] = tuple(
            int(
                connection.execute(
                    "SELECT count(*) FROM artifact_objects WHERE relative_path=?",
                    (path,),
                ).fetchone()[0]
            )
            for path in old_relative_paths
        )
        cleanup_observation["primary_rows"] = int(
            connection.execute(
                "SELECT count(*) FROM literature_assets WHERE literature_id=?",
                (replacement_literature.literature_id.root,),
            ).fetchone()[0]
        )
        cleanup_observation["parser_rows"] = int(
            connection.execute(
                "SELECT count(*) FROM parser_results WHERE source_sha256=?",
                (sha256_digest(old_pdf).root,),
            ).fetchone()[0]
        )
        cleanup_observation["content_rows"] = int(
            connection.execute(
                "SELECT count(*) FROM literature_contents WHERE literature_id=?",
                (replacement_literature.literature_id.root,),
            ).fetchone()[0]
        )
    source.before_acquire_by_title.pop(replacement_title, None)


source.before_acquire_by_title[replacement_title] = _observe_cleanup_before_reacquisition
replacement_report = operation(
    BatchRequest(
        selector=LiteratureSelector(
            kind="literatures",
            literature_ids=(replacement_literature.literature_id,),
        ),
        goal="CONTENT_READY",
    )
)
old_closure_paths = cleanup_observation.get("old_closure_paths")
if not isinstance(old_closure_paths, tuple):
    raise RuntimeError("NoUsableContent cleanup observation was not captured")
cleanup_observation["physical_exists_after_operation"] = tuple(
    (artifacts / path).exists() for path in old_closure_paths
)
replacement_detail = literature.read_detail(replacement_literature.literature_id)
if replacement_detail.primary_pdf is None or replacement_detail.content is None:
    raise RuntimeError("no-content candidate replacement did not finish")
if source.before_acquire_by_title:
    raise RuntimeError(
        "NoUsableContent did not reach reacquisition after cleanup: "
        + replacement_report.model_dump_json()
    )

# A first explicit request with no available candidate commits one durable
# automatic-exhaustion fact.  Broad all-pending execution must freeze that
# target out without touching the Source.  A later concrete Literature retry
# clears the fact under CAS before Source work and can then acquire a newly
# available candidate.
exhaustion_initial_report = operation(
    BatchRequest(
        selector=LiteratureSelector(
            kind="literatures",
            literature_ids=(exhaustion_literature.literature_id,),
        ),
        goal="ASSET_READY",
    )
)
exhaustion_detail_before_retry = literature.read_detail(exhaustion_literature.literature_id)
with engine.read_snapshot() as connection:
    exhaustion_rows_before_wide = tuple(
        str(row[0])
        for row in connection.execute(
            "SELECT literature_id FROM automatic_pdf_acquisition_exhaustions ORDER BY literature_id"
        ).fetchall()
    )
source_requests_before_wide = len(source.requests)
exhaustion_wide_report = operation(
    BatchRequest(
        selector=AllPendingSelector(kind="all-pending"),
        goal="ASSET_READY",
    )
)
source_requests_after_wide = len(source.requests)
with engine.read_snapshot() as connection:
    exhaustion_rows_after_wide = tuple(
        str(row[0])
        for row in connection.execute(
            "SELECT literature_id FROM automatic_pdf_acquisition_exhaustions ORDER BY literature_id"
        ).fetchall()
    )

source.candidates_by_title[exhaustion_literature.metadata.title or ""] = [
    "exhaustion-retry-candidate"
]
exhaustion_retry_report = operation(
    BatchRequest(
        selector=LiteratureSelector(
            kind="literatures",
            literature_ids=(exhaustion_literature.literature_id,),
        ),
        goal="ASSET_READY",
    )
)
exhaustion_detail_after_retry = literature.read_detail(exhaustion_literature.literature_id)
with engine.read_snapshot() as connection:
    exhaustion_rows_after_retry = tuple(
        str(row[0])
        for row in connection.execute(
            "SELECT literature_id FROM automatic_pdf_acquisition_exhaustions ORDER BY literature_id"
        ).fetchall()
    )

# Seed a three-target batch only after the broad exhaustion check so that the
# latter proves a true zero-target freeze.  Parser and LLM adapters each fail
# exactly once for different Literatures; the third target succeeds.  A rerun
# must continue from each target's already committed durable facts.
partial_literatures = []
for number, title in (
    (4, _PARSER_FAILURE_TITLE),
    (5, _LLM_FAILURE_TITLE),
    (6, _PARTIAL_SUCCESS_TITLE),
):
    result = metadata_publication.publish_observation(_metadata_observation(number, title))
    if result.decision != "created" or result.literature is None:
        raise RuntimeError("controlled partial-failure seed was not created")
    partial_literatures.append(result.literature)
parser_failure_literature, llm_failure_literature, partial_success_literature = partial_literatures
source.candidates_by_title.update(
    {
        parser_failure_literature.metadata.title or "": ["parser-failure-candidate"],
        llm_failure_literature.metadata.title or "": ["llm-failure-candidate"],
        partial_success_literature.metadata.title or "": ["partial-success-candidate"],
    }
)
parser.fail_once_candidate_keys.add("parser-failure-candidate")
llm.fail_metadata_once_titles.add(llm_failure_literature.metadata.title or "")
partial_selector = LiteratureSelector(
    kind="literatures",
    literature_ids=tuple(item.literature_id for item in partial_literatures),
)
partial_first_report = operation(BatchRequest(selector=partial_selector, goal="CONTENT_READY"))
partial_details_after_first = {
    "llm_failure": literature.read_detail(llm_failure_literature.literature_id),
    "parser_failure": literature.read_detail(parser_failure_literature.literature_id),
    "success": literature.read_detail(partial_success_literature.literature_id),
}
partial_counts_after_first = {
    "llm_kinds": [call.request.kind.value for call in llm.calls],
    "parser_attempts": dict(parser.attempts_by_candidate),
    "source_request_count": len(source.requests),
}
partial_second_report = operation(BatchRequest(selector=partial_selector, goal="CONTENT_READY"))
partial_details_after_second = {
    "llm_failure": literature.read_detail(llm_failure_literature.literature_id),
    "parser_failure": literature.read_detail(parser_failure_literature.literature_id),
    "success": literature.read_detail(partial_success_literature.literature_id),
}
partial_counts_after_second = {
    "llm_kinds": [call.request.kind.value for call in llm.calls],
    "parser_attempts": dict(parser.attempts_by_candidate),
    "source_request_count": len(source.requests),
}

configuration = root / "config.toml"
configuration.write_text(_configuration(catalog, artifacts), encoding="utf-8")
console_details = {
    "exhaustion_retry": _console_detail(
        root=root,
        configuration=configuration,
        literature_id=exhaustion_literature.literature_id,
    ),
    "llm_failure": _console_detail(
        root=root,
        configuration=configuration,
        literature_id=llm_failure_literature.literature_id,
    ),
    "parser_failure": _console_detail(
        root=root,
        configuration=configuration,
        literature_id=parser_failure_literature.literature_id,
    ),
    "partial_success": _console_detail(
        root=root,
        configuration=configuration,
        literature_id=partial_success_literature.literature_id,
    ),
    "replacement": _console_detail(
        root=root,
        configuration=configuration,
        literature_id=replacement_literature.literature_id,
    ),
    "success": _console_detail(
        root=root,
        configuration=configuration,
        literature_id=success_literature.literature_id,
    ),
}
console_exports = {
    "content": _console_export(
        root=root,
        configuration=configuration,
        action="content",
        literature_id=success_literature.literature_id,
        target=root / "console-success.md",
    ),
    "pdf": _console_export(
        root=root,
        configuration=configuration,
        action="pdf",
        literature_id=success_literature.literature_id,
        target=root / "console-success.pdf",
    ),
}

with engine.read_snapshot() as connection:
    table_counts = {
        table: int(connection.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0])
        for table in (
            "assets",
            "literature_assets",
            "parser_results",
            "literature_contents",
            "artifact_objects",
        )
    }
    replacement_primary_rows = connection.execute(
        "SELECT a.sha256,la.source_url FROM literature_assets la "
        "JOIN assets a ON a.asset_id=la.asset_id "
        "WHERE la.literature_id=? AND la.role='primary-pdf'",
        (replacement_literature.literature_id.root,),
    ).fetchall()

llm_kinds_by_title: dict[str, list[str]] = {}
for call in llm.calls:
    structured = json.loads(call.structured_input)
    if call.request.kind is LLMRequestKind.METADATA:
        title = structured["initial_metadata"]["title"]
    elif call.request.kind is LLMRequestKind.CONTENT:
        title = structured["final_metadata"]["title"]
    else:
        title = "reference-lookup"
    llm_kinds_by_title.setdefault(title, []).append(call.request.kind.value)

payload = {
    "catalog": {
        "catalog_relative_path": "database-completion/catalog.sqlite3",
        "configuration_name": configuration.name,
        "literature_ids": {
            "exhaustion_retry": exhaustion_literature.literature_id.root,
            "llm_failure": llm_failure_literature.literature_id.root,
            "parser_failure": parser_failure_literature.literature_id.root,
            "partial_success": partial_success_literature.literature_id.root,
            "replacement": replacement_literature.literature_id.root,
            "success": success_literature.literature_id.root,
        },
        "root_name": root.name,
    },
    "console_details": console_details,
    "console_exports": console_exports,
    "exhaustion_retry": {
        "detail_after_retry": exhaustion_detail_after_retry.model_dump(mode="json"),
        "detail_before_retry": exhaustion_detail_before_retry.model_dump(mode="json"),
        "initial_report": exhaustion_initial_report.model_dump(mode="json"),
        "rows_after_retry": exhaustion_rows_after_retry,
        "rows_after_wide": exhaustion_rows_after_wide,
        "rows_before_wide": exhaustion_rows_before_wide,
        "source_requests_after_wide": source_requests_after_wide,
        "source_requests_before_wide": source_requests_before_wide,
        "retry_report": exhaustion_retry_report.model_dump(mode="json"),
        "wide_report": exhaustion_wide_report.model_dump(mode="json"),
    },
    "fake_boundary": {
        "llm_kinds_by_title": llm_kinds_by_title,
        "parser_attempts_by_candidate": dict(parser.attempts_by_candidate),
        "parser_candidate_keys": parser.candidate_keys,
        "parser_request_count": len(parser.requests),
        "source_requests": source.requests,
        "temporary_content": [
            {"discard_count": item.discard_count, "open_count": item.open_count}
            for item in source.temporary_content
        ],
    },
    "product_module_files": {
        "acquisition": acquisition_service_module.__file__,
        "analysis": analysis_service_module.__file__,
        "entry": entry_completion_module.__file__,
        "literature": literature_service_module.__file__,
        "parsing": parsing_service_module.__file__,
        "storage": storage_completion_module.__file__,
    },
    "partial_failure": {
        "counts_after_first": partial_counts_after_first,
        "counts_after_second": partial_counts_after_second,
        "details_after_first": {
            name: detail.model_dump(mode="json")
            for name, detail in partial_details_after_first.items()
        },
        "details_after_second": {
            name: detail.model_dump(mode="json")
            for name, detail in partial_details_after_second.items()
        },
        "first_report": partial_first_report.model_dump(mode="json"),
        "second_report": partial_second_report.model_dump(mode="json"),
    },
    "replacement": {
        "cleanup_observation": cleanup_observation,
        "detail": replacement_detail.model_dump(mode="json"),
        "primary_rows": replacement_primary_rows,
        "report": replacement_report.model_dump(mode="json"),
    },
    "storage": {
        "table_counts": table_counts,
    },
    "success": {
        "artifact_sha256": {
            name: sha256_digest(value).root for name, value in success_artifacts.items()
        },
        "content_markdown": success_artifacts["content_markdown"].decode(),
        "detail": success_detail.model_dump(mode="json"),
        "parser_markdown": success_artifacts["parser_markdown"].decode(),
        "pdf_sha256": sha256_digest(success_artifacts["pdf"]).root,
        "report": success_report.model_dump(mode="json"),
    },
}
print(json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":")))
