from __future__ import annotations

import ast
import io
import json
import threading
import unittest
from collections.abc import Callable, Generator, Iterable
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TypeAlias, cast, get_args

import sciretriever.analysis.api as analysis_api_module
import sciretriever.parsing.api as parsing_api_module
from sciretriever.agents import (
    AgentFailure,
    AgentProvenance,
    AgentRequest,
    AgentStructuredResponse,
)
from sciretriever.analysis.api import (
    AnalysisApi,
    ContentAnalysisFailure,
    ContentAnalysisInput,
    ContentAnalysisResult,
    ReferenceLookupFailure,
)
from sciretriever.analysis.content import ContentAnalysisLimits
from sciretriever.analysis.markdown import render_canonical_markdown
from sciretriever.analysis.metadata_rules import metadata_input_sha256
from sciretriever.analysis.ports import (
    AnalysisArtifactPublicationPort,
    AnalysisCurrentInputPort,
    ContentInputIdentity,
    StagedContentMarkdown,
)
from sciretriever.analysis.references import ReferenceLookupStage
from sciretriever.analysis.service import AnalysisService
from sciretriever.literature.api import LiteratureApi
from sciretriever.literature.content import (
    canonical_literature_content_json,
    literature_content_artifact,
    metadata_sha256,
)
from sciretriever.literature.ports import IdentityObservationPublicationCommand
from sciretriever.literature.service import LiteratureService
from sciretriever.literature.state import CurrentLiteratureFacts
from sciretriever.model.acquisition import Asset, AssetRole, LiteratureAsset
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContentProposal,
    NoUsableContent,
    analysis_input_sha256,
)
from sciretriever.model.literature import (
    Author,
    AuthorKind,
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserRequest,
    ParserResult,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ProvenanceId,
    ReferenceId,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.parsing.api import ParsingApi, ParsingFailure
from sciretriever.parsing.ports import StagedParserArtifact, StagedParserOutput
from sciretriever.parsing.service import ParsingService
from sciretriever.storage.analysis_artifacts import AnalysisArtifactPublisher
from sciretriever.storage.files.paths import StorageRoot, content_addressed_reference
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactStore
from sciretriever.storage.sqlite.analysis_artifacts import AnalysisArtifactReader
from sciretriever.storage.sqlite.analysis_inputs import SqliteAnalysisCurrentInputs
from sciretriever.storage.sqlite.artifacts import register_artifact
from sciretriever.storage.sqlite.content_publication import (
    ContentPublicationError,
    SqliteContentPublication,
)
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.parsing_publication import SqliteParserResultPublication

ROOT = Path(__file__).resolve().parents[1]
_TIME = UtcTimestamp("2026-08-12T12:00:00Z")
_MODEL = "offline-analysis-model"
_PROVIDER = "offline-analysis-provider"


def _uuid(number: int) -> str:
    return f"00000000-0000-4000-8000-{number:012x}"


def _initial_metadata() -> LiteratureMetadata:
    return LiteratureMetadata(
        title="Offline Retrieval Study",
        authors=(
            Author(
                kind=AuthorKind.PERSON,
                display_name="Ada Lovelace",
                given_name="Ada",
                family_name="Lovelace",
            ),
        ),
        abstract="The paper reports a complete retrieval study.",
        publication_date="2026-08-12",
        publication_year=2026,
        document_type="article",
        language="en",
        venue="Fixture Journal",
        publisher="Example Publishing",
        volume="7",
        issue="2",
        pages="101-109",
        identifiers=(Identifier(namespace="doi", value="10.5555/pipeline.fixture"),),
        keywords=(),
    )


def _final_metadata(variant: int) -> LiteratureMetadata:
    base = _initial_metadata()
    keywords = ("retrieval",) if variant == 1 else ("quantum materials",)
    return base.model_copy(update={"keywords": keywords})


def _parser_markdown() -> str:
    return """# Offline Retrieval Study

Ada Lovelace reports a complete retrieval study for quantum materials.
The study evaluates retrieval and also reports a replacement synthesis.
The article appears in Fixture Journal, volume 7, issue 2, pages 101-109,
published by Example Publishing on 2026-08-12.
DOI: 10.5555/pipeline.fixture.

# References

Ada A. Source work. Fixture Journal. 2025.
"""


def _content_draft(variant: int) -> str:
    background = (
        "The study evaluates retrieval for quantum materials."
        if variant == 1
        else "The study reports a replacement synthesis for quantum materials."
    )
    return f"""# 研究背景与目标

{background}

# 研究方法

未提供

# 数据

未提供

# 结论与局限性

未提供

# 参考文献

1. Ada A. Source work. Fixture Journal. 2025.
"""


def _usable_response(metadata: LiteratureMetadata) -> str:
    return json.dumps(
        {
            "metadata": metadata.model_dump(mode="json"),
            "outcome": "usable",
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _no_usable_response() -> str:
    return '{"metadata":null,"outcome":"no_usable_content"}'


def _content_response(variant: int) -> str:
    return json.dumps(
        {"markdown": _content_draft(variant)},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _invalid_content_response() -> str:
    return json.dumps(
        {"markdown": "# 研究背景与目标\n\nIncomplete draft.\n"},
        ensure_ascii=False,
        separators=(",", ":"),
    )


class _BytesContent:
    def __init__(self, payload: bytes) -> None:
        self._payload = payload
        self.open_count = 0

    @contextmanager
    def open(self) -> Generator[io.BytesIO, None, None]:
        self.open_count += 1
        stream = io.BytesIO(self._payload)
        try:
            yield stream
        finally:
            stream.close()


class _FakeParser:
    def __init__(
        self,
        *,
        pdf_bytes: bytes,
        markdown: str,
        number: int,
        failure: BaseException | None = None,
    ) -> None:
        self._pdf_bytes = pdf_bytes
        self._markdown = markdown
        self._number = number
        self._failure = failure
        self.requests: list[ParserRequest] = []

    def parse(
        self,
        request: ParserRequest,
        *,
        cancel_event: threading.Event | None = None,
    ) -> StagedParserOutput:
        del cancel_event
        self.requests.append(request)
        if self._failure is not None:
            raise self._failure
        with request.content_ref.open() as stream:
            if stream.read() != self._pdf_bytes:
                raise RuntimeError("fake Parser received the wrong PDF bytes")
        markdown_bytes = self._markdown.encode("utf-8")
        markdown = StagedParserArtifact(
            artifact=ParserArtifactRef(
                sha256=sha256_digest(markdown_bytes),
                media_type="text/markdown",
                byte_size=len(markdown_bytes),
            ),
            content=_BytesContent(markdown_bytes),
        )
        return StagedParserOutput(
            source_asset_id=request.source_asset_id,
            source_sha256=request.source_sha256,
            page_count=2,
            markdown=markdown,
            resources=(),
            provenance=ParserProvenance(
                provenance=Provenance(
                    provenance_id=ProvenanceId(_uuid(300_000 + self._number)),
                    source_kind=SourceKind.PARSER,
                    source_name="offline-fixture-parser",
                    source_record_id=None,
                    observed_at=_TIME,
                    input_sha256=request.source_sha256,
                    parameters_sha256=sha256_digest(f"parser-parameters-{self._number}".encode()),
                ),
                parser_version="1.0",
                mode="offline",
                model_identity=None,
            ),
        )


_LLMAction: TypeAlias = str | BaseException | Callable[[AgentRequest], AgentStructuredResponse]


def _request_stage(call: AgentRequest) -> str:
    if "references" in call.structured_input:
        return "reference"
    if "final_metadata" in call.structured_input:
        return "content"
    return "metadata"


class _FakeLLM:
    def __init__(self, actions: Iterable[_LLMAction]) -> None:
        self._actions = list(actions)
        self.calls: list[AgentRequest] = []

    @property
    def provider_name(self) -> str:
        return _PROVIDER

    def complete(self, request: AgentRequest) -> AgentStructuredResponse:
        call = request
        self.calls.append(call)
        action = self._actions.pop(0)
        if isinstance(action, BaseException):
            raise action
        if callable(action):
            return action(call)
        return AgentStructuredResponse(
            result=action,
            provenance=AgentProvenance(
                provider=_PROVIDER,
                model=call.model,
                input_sha256=call.input_sha256,
                parameters_sha256=sha256_digest(f"{_request_stage(call)}-parameters".encode()),
            ),
        )


def _llm_failure() -> AgentFailure:
    return AgentFailure(
        StableFailure(
            code="offline-llm-failure",
            reason="The offline fake language-model call failed.",
            action="Retry with a healthy fake provider.",
            retryable=True,
        )
    )


class _SequencedCurrentInputs:
    def __init__(
        self,
        delegate: SqliteAnalysisCurrentInputs,
        outcomes: Iterable[bool],
    ) -> None:
        self._delegate = delegate
        self._outcomes = list(outcomes)
        self.calls: list[ContentInputIdentity] = []

    def current_input_matches(self, identity: ContentInputIdentity) -> bool:
        self.calls.append(identity)
        current = self._delegate.current_input_matches(identity)
        return current and self._outcomes.pop(0)


class _FailingAnalysisPublisher:
    def __init__(self) -> None:
        self.calls: list[StagedContentMarkdown] = []

    def publish_markdown(self, staged: StagedContentMarkdown) -> ArtifactRef:
        self.calls.append(staged)
        raise RuntimeError("injected offline Analysis publication failure")


class _Ids:
    def __init__(self, number: int) -> None:
        self._number = number * 10_000

    def _next(self) -> str:
        self._number += 1
        return _uuid(900_000 + self._number)

    def new_literature_id(self) -> LiteratureId:
        return LiteratureId(self._next())

    def new_meta_literature_id(self) -> MetaLiteratureId:
        return MetaLiteratureId(self._next())

    def new_reference_id(self) -> ReferenceId:
        return ReferenceId(self._next())


class _PipelineEnvironment:
    _SNAPSHOT_TABLES = (
        "literatures",
        "literature_metadata",
        "literature_metadata_authors",
        "literature_metadata_author_affiliations",
        "literature_metadata_identifiers",
        "literature_metadata_keywords",
        "literature_fallback_identity_indexes",
        "assets",
        "literature_assets",
        "parser_results",
        "parser_result_resources",
        "literature_contents",
        "literature_content_reference_texts",
        "literature_references",
        "provider_relation_reference_supports",
        "metadata_reference_text_supports",
        "content_reference_text_supports",
        "literature_search_fts",
        "artifact_objects",
        "provenances",
    )

    def __init__(self, number: int) -> None:
        self.number = number
        self.temporary = TemporaryDirectory(prefix="sciretriever-an6-")
        self.base = Path(self.temporary.name)
        self.root = StorageRoot(self.base / "artifacts")
        self.engine = CatalogEngine(self.base / "catalog.sqlite")
        self.store = ArtifactStore(self.root)
        self.reader = VerifiedReader(self.root)
        self.writer = LiteratureWriter(self.engine)
        self.ids = _Ids(number)
        self.pdf_bytes = f"%PDF-1.7\noffline-pipeline-{number}\n".encode()
        self.content_checkpoints: list[str] = []
        self._parser_attempt = 0
        self._analysis_attempt = 0
        self.literature = Literature(
            literature_id=LiteratureId(_uuid(10_000 + number)),
            meta_literature_id=MetaLiteratureId(_uuid(20_000 + number)),
            version_role=VersionRole.OTHER,
            metadata=_initial_metadata(),
            status=LiteratureStatus.UNREVIEWED,
        )
        self._seed_literature()
        self.asset = self._seed_primary_pdf()

    def cleanup(self) -> None:
        self.temporary.cleanup()

    def _seed_literature(self) -> None:
        self.writer.publish_identity_and_observation(
            IdentityObservationPublicationCommand(
                literatures=(self.literature,),
                meta_literatures=(
                    MetaLiterature(
                        meta_literature_id=self.literature.meta_literature_id,
                        representative_literature_id=self.literature.literature_id,
                    ),
                ),
                observations=(),
                facts=(
                    CurrentLiteratureFacts(
                        literature=self.literature,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(self.literature.metadata),
                    ),
                ),
                expected_tokens=(),
                expected_meta_tokens=(),
            )
        )

    def _seed_primary_pdf(self) -> Asset:
        published = self.store.publish(
            self.pdf_bytes,
            sha256=sha256_digest(self.pdf_bytes),
            byte_size=len(self.pdf_bytes),
            media_type="application/pdf",
        )
        with self.reader.acquire(published) as lease:
            register_artifact(self.engine, f"an6-primary-{self.number}", lease)
        asset = Asset(
            asset_id=AssetId(_uuid(30_000 + self.number)),
            sha256=published.sha256,
            size_bytes=published.byte_size,
            media_type=published.media_type,
            path=published.path,
        )
        self.writer.publish_asset(asset)
        self.writer.publish_literature_asset(
            LiteratureAsset(
                literature_asset_id=LiteratureAssetId(_uuid(40_000 + self.number)),
                literature_id=self.literature.literature_id,
                asset_id=asset.asset_id,
                role=AssetRole.PRIMARY_PDF,
                provenance=Provenance(
                    provenance_id=ProvenanceId(_uuid(50_000 + self.number)),
                    source_kind=SourceKind.ASSET_PROVIDER,
                    source_name="offline-pipeline-assets",
                    source_record_id=f"asset-{self.number}",
                    observed_at=_TIME,
                    input_sha256=asset.sha256,
                    parameters_sha256=None,
                ),
            )
        )
        return asset

    def parsing_api(
        self,
        *,
        failure: BaseException | None = None,
    ) -> tuple[ParsingApi, _FakeParser]:
        self._parser_attempt += 1
        parser = _FakeParser(
            pdf_bytes=self.pdf_bytes,
            markdown=_parser_markdown(),
            number=self.number * 100 + self._parser_attempt,
            failure=failure,
        )
        service = ParsingService(
            parser=parser,
            result_store=SqliteParserResultPublication(
                self.engine,
                self.store,
                self.reader,
            ),
        )
        return ParsingApi(service), parser

    def parser_request(self) -> ParserRequest:
        return ParserRequest(
            source_asset_id=self.asset.asset_id,
            source_sha256=self.asset.sha256,
            media_type="application/pdf",
            content_ref=_BytesContent(self.pdf_bytes),
        )

    def literature_api(self, *, failpoint: str | None = None) -> LiteratureApi:
        def checkpoint(name: str) -> None:
            self.content_checkpoints.append(name)
            if name == failpoint:
                raise RuntimeError("injected offline Literature transaction failure")

        service = LiteratureService(
            read_port=LiteraturePreconditionReader(self.engine, self.reader),
            identity_port=self.writer,
            content_port=SqliteContentPublication(
                self.engine,
                self.store,
                self.reader,
                failpoint=checkpoint,
            ),
            reference_port=self.writer,
            maintenance_port=self.writer,
            id_factory=self.ids,
        )
        return LiteratureApi(service)

    def analysis_input(self, parser_result: ParserResult | None = None) -> ContentAnalysisInput:
        facts = self.literature_api().read_facts(self.literature.literature_id)
        selected_parser = facts.current_parser_result if parser_result is None else parser_result
        if selected_parser is None or len(facts.current_primary_pdfs) != 1:
            raise AssertionError("fixture requires one current primary PDF and ParserResult")
        primary = facts.current_primary_pdfs[0]
        input_hash = metadata_input_sha256(facts.literature.metadata)
        if input_hash != facts.metadata_sha256:
            raise AssertionError("Analysis and Literature metadata hashes drifted")
        return ContentAnalysisInput(
            literature_id=facts.literature.literature_id,
            primary_asset_id=primary.asset.asset_id,
            primary_pdf_sha256=primary.asset.sha256,
            parser_result=selected_parser,
            initial_metadata=facts.literature.metadata,
            input_metadata_revision=facts.metadata_revision,
            input_metadata_sha256=input_hash,
            user_observations=(),
        )

    def analysis_api(
        self,
        actions: Iterable[_LLMAction],
        *,
        current_inputs: AnalysisCurrentInputPort | None = None,
        publisher: AnalysisArtifactPublicationPort | None = None,
    ) -> tuple[AnalysisApi, _FakeLLM]:
        self._analysis_attempt += 1
        llm = _FakeLLM(actions)
        provenance_id = ProvenanceId(_uuid(400_000 + self.number * 100 + self._analysis_attempt))
        content_service = AnalysisService(
            agents=llm,
            artifact_reader=AnalysisArtifactReader(self.engine, self.reader),
            current_inputs=(
                SqliteAnalysisCurrentInputs(self.engine)
                if current_inputs is None
                else current_inputs
            ),
            artifact_publisher=(
                AnalysisArtifactPublisher(self.store) if publisher is None else publisher
            ),
            model=_MODEL,
            metadata_max_output_tokens=2_048,
            content_max_output_tokens=4_096,
            limits=ContentAnalysisLimits(
                max_input_bytes=1024 * 1024,
                max_chunk_bytes=1024 * 1024,
                max_chunk_count=1,
                max_total_llm_requests=2,
                max_total_output_tokens=6_144,
            ),
            provenance_id_factory=lambda: provenance_id,
            clock=lambda: _TIME,
        )
        lookup_stage = ReferenceLookupStage(
            agents=llm,
            model=_MODEL,
            max_output_tokens=2_048,
        )
        return (
            AnalysisApi(
                content_service=content_service,
                reference_lookup_stage=lookup_stage,
            ),
            llm,
        )

    def make_content_ready(
        self,
        *,
        metadata_variant: int = 1,
        content_variant: int = 1,
    ) -> tuple[ParserResult, LiteratureContentProposal, _FakeLLM]:
        parsing_api, _parser = self.parsing_api()
        prepared = parsing_api.prepare_current_primary(self.parser_request())
        parser_result = parsing_api.commit_current_primary(prepared)
        analysis_api, llm = self.analysis_api(
            (
                _usable_response(_final_metadata(metadata_variant)),
                _content_response(content_variant),
            )
        )
        result = analysis_api.analyze_content(self.analysis_input(parser_result))
        if not isinstance(result, LiteratureContentProposal):
            raise AssertionError("fixture expected one complete content proposal")
        decision = self.literature_api().accept_content(result)
        if decision.decision != "accepted" or decision.replacement is None:
            raise AssertionError("fixture expected Literature content acceptance")
        return parser_result, result, llm

    def authoritative_snapshot(self) -> tuple[tuple[tuple[object, ...], ...], ...]:
        with self.engine.read_snapshot() as connection:
            return tuple(
                tuple(
                    tuple(row)
                    for row in connection.execute(f'SELECT * FROM "{table}" ORDER BY rowid')
                )
                for table in self._SNAPSHOT_TABLES
            )

    def open_artifact(self, descriptor: ArtifactRef) -> bytes:
        path = content_addressed_reference(descriptor.sha256, descriptor.byte_size)
        with self.reader.open(
            path,
            sha256=descriptor.sha256,
            byte_size=descriptor.byte_size,
            media_type=descriptor.media_type,
        ) as stream:
            return stream.read()

    def current_content_rows(self) -> tuple[tuple[object, ...], ...]:
        with self.engine.read_snapshot() as connection:
            return tuple(
                tuple(row)
                for row in connection.execute(
                    "SELECT literature_content_sha256,metadata_revision,metadata_sha256,"
                    "parser_result_sha256,structured_artifact_path,markdown_artifact_path "
                    "FROM literature_contents WHERE literature_id=?",
                    (self.literature.literature_id.root,),
                )
            )

    def reference_counts(self) -> tuple[int, int, int, int]:
        tables = (
            "literature_references",
            "provider_relation_reference_supports",
            "metadata_reference_text_supports",
            "content_reference_text_supports",
        )
        with self.engine.read_snapshot() as connection:
            counts: list[int] = []
            for table in tables:
                row = connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()
                if row is None:
                    raise AssertionError("fixture reference count query failed")
                counts.append(int(row[0]))
        return cast(tuple[int, int, int, int], tuple(counts))


class ContentPipelineContractTests(unittest.TestCase):
    def environment(self, number: int) -> _PipelineEnvironment:
        environment = _PipelineEnvironment(number)
        self.addCleanup(environment.cleanup)
        return environment

    def test_public_boundaries_are_explicit_and_package_markers_are_inert(self) -> None:
        self.assertEqual(
            analysis_api_module.__all__,
            (
                "AnalysisApi",
                "ContentAnalysisFailure",
                "ContentAnalysisInput",
                "ContentAnalysisResult",
                "ReferenceLookupFailure",
            ),
        )
        self.assertEqual(
            parsing_api_module.__all__,
            ("ParsingApi", "ParsingFailure", "PreparedParsing"),
        )
        self.assertEqual(
            get_args(ContentAnalysisResult),
            (NoUsableContent, LiteratureContentProposal),
        )
        self.assertEqual(AnalysisApi.__module__, "sciretriever.analysis.api")
        self.assertEqual(ContentAnalysisInput.__module__, "sciretriever.analysis.ports")
        self.assertEqual(ContentAnalysisFailure.__module__, "sciretriever.analysis.content")
        self.assertEqual(
            ReferenceLookupFailure.__module__,
            "sciretriever.analysis.references",
        )
        self.assertEqual(ParsingApi.__module__, "sciretriever.parsing.api")
        self.assertEqual(ParsingFailure.__module__, "sciretriever.parsing.ports")
        for private_name in (
            "AnalysisService",
            "ReferenceLookupStage",
            "AgentPort",
            "ParsingService",
            "ParserPort",
            "StagedParserOutput",
        ):
            with self.subTest(private_name=private_name):
                self.assertNotIn(private_name, analysis_api_module.__all__)
                self.assertNotIn(private_name, parsing_api_module.__all__)
                self.assertFalse(hasattr(analysis_api_module, private_name))
                self.assertFalse(hasattr(parsing_api_module, private_name))

        valid_content_service = object.__new__(AnalysisService)
        valid_lookup_stage = object.__new__(ReferenceLookupStage)
        with self.assertRaisesRegex(TypeError, "content_service"):
            AnalysisApi(
                content_service=cast(AnalysisService, object()),
                reference_lookup_stage=valid_lookup_stage,
            )
        with self.assertRaisesRegex(TypeError, "reference_lookup_stage"):
            AnalysisApi(
                content_service=valid_content_service,
                reference_lookup_stage=cast(ReferenceLookupStage, object()),
            )
        with self.assertRaisesRegex(TypeError, "service"):
            ParsingApi(cast(ParsingService, object()))

        for relative in (
            "src/sciretriever/parsing/__init__.py",
            "src/sciretriever/analysis/__init__.py",
        ):
            with self.subTest(path=relative):
                tree = ast.parse((ROOT / relative).read_text(encoding="utf-8"))
                body = tree.body[1:] if ast.get_docstring(tree) is not None else tree.body
                self.assertEqual(len(body), 1)
                assignment = body[0]
                self.assertIsInstance(assignment, ast.Assign)
                assert isinstance(assignment, ast.Assign)
                self.assertEqual(
                    tuple(
                        target.id for target in assignment.targets if isinstance(target, ast.Name)
                    ),
                    ("__all__",),
                )
                self.assertIsInstance(assignment.value, ast.Tuple)
                assert isinstance(assignment.value, ast.Tuple)
                self.assertEqual(assignment.value.elts, [])
                self.assertFalse(
                    any(
                        isinstance(
                            node,
                            (
                                ast.Import,
                                ast.ImportFrom,
                                ast.Call,
                                ast.ClassDef,
                                ast.FunctionDef,
                                ast.AsyncFunctionDef,
                            ),
                        )
                        for node in ast.walk(tree)
                    )
                )

    def test_asset_to_parser_to_analysis_to_literature_reaches_content_ready(self) -> None:
        environment = self.environment(1)
        parsing_api, parser = environment.parsing_api()
        prepared = parsing_api.prepare_current_primary(environment.parser_request())
        parser_result = parsing_api.commit_current_primary(prepared)
        self.assertEqual(parsing_api.read_current_result(environment.asset.asset_id), parser_result)
        self.assertEqual(len(parser.requests), 1)
        self.assertEqual(parser.requests[0].source_asset_id, environment.asset.asset_id)

        literature_api = environment.literature_api()
        before = literature_api.read_facts(environment.literature.literature_id)
        analysis_input = environment.analysis_input(parser_result)
        final_metadata = _final_metadata(1)
        analysis_api, llm = environment.analysis_api(
            (_usable_response(final_metadata), _content_response(1))
        )

        result = analysis_api.analyze_content(analysis_input)

        self.assertIsInstance(result, LiteratureContentProposal)
        assert isinstance(result, LiteratureContentProposal)
        self.assertEqual(
            [_request_stage(call) for call in llm.calls],
            ["metadata", "content"],
        )
        content_input = cast(dict[str, object], json.loads(llm.calls[1].structured_input))
        self.assertEqual(
            content_input["final_metadata"],
            final_metadata.model_dump(mode="json"),
        )
        self.assertEqual(
            content_input["parser_result"],
            parser_result.model_dump(mode="json"),
        )
        self.assertEqual(content_input["parser_markdown"], _parser_markdown())
        self.assertNotIn("metadata_revision", LiteratureContentProposal.model_fields)
        self.assertEqual(result.input_metadata_revision, before.metadata_revision)

        decision = literature_api.accept_content(result)

        self.assertEqual(decision.decision, "accepted")
        self.assertIsNotNone(decision.replacement)
        assert decision.replacement is not None
        facts = literature_api.read_facts(environment.literature.literature_id)
        status = literature_api.read_status(environment.literature.literature_id)
        self.assertEqual(facts.metadata_revision, before.metadata_revision + 1)
        self.assertEqual(facts.metadata_revision, decision.replacement.metadata_revision)
        self.assertEqual(facts.literature.metadata, final_metadata)
        self.assertEqual(facts.metadata_sha256, result.metadata_sha256)
        self.assertEqual(facts.current_content, decision.replacement.content)
        self.assertEqual(status.status, LiteratureStatus.CONTENT_READY)
        self.assertEqual(status.facts, facts)
        self.assertIsNotNone(facts.current_content)
        self.assertIsNotNone(facts.current_content_lineage)
        assert facts.current_content is not None
        assert facts.current_content_lineage is not None
        self.assertEqual(
            facts.current_content.provenance.input_sha256,
            analysis_input_sha256(
                environment.asset.sha256,
                parser_result.result_sha256,
                facts.metadata_sha256,
            ),
        )
        self.assertEqual(
            facts.current_content_lineage.primary_asset_id,
            environment.asset.asset_id,
        )
        self.assertEqual(
            facts.current_content_lineage.primary_pdf_sha256,
            environment.asset.sha256,
        )
        self.assertEqual(
            facts.current_content_lineage.parser_result_sha256,
            parser_result.result_sha256,
        )
        self.assertEqual(
            environment.open_artifact(facts.current_content.markdown),
            render_canonical_markdown(
                metadata=final_metadata,
                sections=facts.current_content.sections,
                references=facts.current_content.references,
            ),
        )
        structured = literature_content_artifact(facts.current_content)
        self.assertEqual(
            environment.open_artifact(structured),
            canonical_literature_content_json(facts.current_content),
        )
        rows = environment.current_content_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0][0], facts.current_content.literature_content_sha256.root)
        self.assertEqual(rows[0][1], facts.metadata_revision)
        self.assertEqual(rows[0][2], facts.metadata_sha256.root)
        self.assertEqual(rows[0][3], parser_result.result_sha256.root)

    def test_no_usable_content_is_the_only_nonfailure_cleanup_authorization(self) -> None:
        environment = self.environment(2)
        parser_result, _proposal, _ready_llm = environment.make_content_ready()
        literature_api = environment.literature_api()
        before_facts = literature_api.read_facts(environment.literature.literature_id)
        before_snapshot = environment.authoritative_snapshot()
        before_checkpoints = len(environment.content_checkpoints)
        analysis_api, llm = environment.analysis_api((_no_usable_response(),))

        result = analysis_api.analyze_content(environment.analysis_input(parser_result))

        self.assertIsInstance(result, NoUsableContent)
        self.assertNotIsInstance(result, LiteratureContentProposal)
        self.assertEqual([_request_stage(call) for call in llm.calls], ["metadata"])
        self.assertEqual(environment.authoritative_snapshot(), before_snapshot)
        self.assertEqual(
            literature_api.read_facts(environment.literature.literature_id),
            before_facts,
        )
        self.assertEqual(len(environment.content_checkpoints), before_checkpoints)
        self.assertEqual(
            literature_api.read_status(environment.literature.literature_id).status,
            LiteratureStatus.CONTENT_READY,
        )
        self.assertEqual(before_facts.current_parser_result, parser_result)
        self.assertEqual(len(before_facts.current_primary_pdfs), 1)
        self.assertEqual(before_facts.current_primary_pdfs[0].asset, environment.asset)
        self.assertIsNotNone(before_facts.current_content)

    def test_failures_preserve_the_complete_authoritative_current_view(self) -> None:
        scenarios = (
            "parser",
            "stage-one-llm",
            "stage-two-markdown",
            "analysis-stale",
            "analysis-publisher",
            "literature-transaction",
        )
        for offset, scenario in enumerate(scenarios, start=1):
            with self.subTest(scenario=scenario):
                environment = self.environment(100 + offset)
                parser_result, _proposal, _ready_llm = environment.make_content_ready()
                literature_api = environment.literature_api()
                before_facts = literature_api.read_facts(environment.literature.literature_id)
                before_status = literature_api.read_status(environment.literature.literature_id)
                before_snapshot = environment.authoritative_snapshot()

                if scenario == "parser":
                    parsing_api, _parser = environment.parsing_api(
                        failure=RuntimeError("private Parser failure")
                    )
                    with self.assertRaises(ParsingFailure) as raised:
                        parsing_api.prepare_current_primary(environment.parser_request())
                    self.assertEqual(raised.exception.failure.code, "parsing-parser-failed")
                elif scenario == "stage-one-llm":
                    analysis_api, llm = environment.analysis_api((_llm_failure(),))
                    with self.assertRaises(ContentAnalysisFailure) as raised:
                        analysis_api.analyze_content(environment.analysis_input(parser_result))
                    self.assertEqual(len(llm.calls), 1)
                    self.assertNotEqual(
                        raised.exception.failure.code,
                        "analysis-content-input-stale",
                    )
                elif scenario == "stage-two-markdown":
                    analysis_input = environment.analysis_input(parser_result)
                    analysis_api, llm = environment.analysis_api(
                        (
                            _usable_response(analysis_input.initial_metadata),
                            _invalid_content_response(),
                        )
                    )
                    with self.assertRaises(ContentAnalysisFailure) as raised:
                        analysis_api.analyze_content(analysis_input)
                    self.assertEqual(len(llm.calls), 2)
                    self.assertEqual(raised.exception.failure.code, "analysis-content-draft")
                elif scenario == "analysis-stale":
                    analysis_input = environment.analysis_input(parser_result)
                    current_inputs = _SequencedCurrentInputs(
                        SqliteAnalysisCurrentInputs(environment.engine),
                        (True, False),
                    )
                    analysis_api, llm = environment.analysis_api(
                        (
                            _usable_response(analysis_input.initial_metadata),
                            _content_response(2),
                        ),
                        current_inputs=current_inputs,
                    )
                    with self.assertRaises(ContentAnalysisFailure) as raised:
                        analysis_api.analyze_content(analysis_input)
                    self.assertEqual(len(llm.calls), 2)
                    self.assertEqual(len(current_inputs.calls), 2)
                    self.assertEqual(
                        raised.exception.failure.code,
                        "analysis-content-input-stale",
                    )
                elif scenario == "analysis-publisher":
                    analysis_input = environment.analysis_input(parser_result)
                    publisher = _FailingAnalysisPublisher()
                    analysis_api, llm = environment.analysis_api(
                        (
                            _usable_response(analysis_input.initial_metadata),
                            _content_response(2),
                        ),
                        publisher=publisher,
                    )
                    with self.assertRaises(ContentAnalysisFailure) as raised:
                        analysis_api.analyze_content(analysis_input)
                    self.assertEqual(len(llm.calls), 2)
                    self.assertEqual(len(publisher.calls), 1)
                    self.assertEqual(
                        raised.exception.failure.code,
                        "analysis-content-artifact-publication",
                    )
                else:
                    analysis_input = environment.analysis_input(parser_result)
                    analysis_api, llm = environment.analysis_api(
                        (
                            _usable_response(_final_metadata(2)),
                            _content_response(2),
                        )
                    )
                    proposal = analysis_api.analyze_content(analysis_input)
                    self.assertIsInstance(proposal, LiteratureContentProposal)
                    assert isinstance(proposal, LiteratureContentProposal)
                    self.assertEqual(environment.authoritative_snapshot(), before_snapshot)
                    with self.assertRaises(ContentPublicationError):
                        environment.literature_api(
                            failpoint="after-metadata-replacement"
                        ).accept_content(proposal)
                    self.assertEqual(len(llm.calls), 2)
                    self.assertIn(
                        "after-metadata-replacement",
                        environment.content_checkpoints,
                    )

                self.assertEqual(environment.authoritative_snapshot(), before_snapshot)
                self.assertEqual(
                    literature_api.read_facts(environment.literature.literature_id),
                    before_facts,
                )
                self.assertEqual(
                    literature_api.read_status(environment.literature.literature_id),
                    before_status,
                )
                self.assertEqual(before_facts.current_parser_result, parser_result)
                self.assertIsNotNone(before_facts.current_content)

    def test_successful_reanalysis_atomically_replaces_the_complete_current(self) -> None:
        environment = self.environment(3)
        parser_result, _first_proposal, _first_llm = environment.make_content_ready()
        literature_api = environment.literature_api()
        old_facts = literature_api.read_facts(environment.literature.literature_id)
        old_snapshot = environment.authoritative_snapshot()
        self.assertIsNotNone(old_facts.current_content)
        assert old_facts.current_content is not None
        old_content = old_facts.current_content
        analysis_input = environment.analysis_input(parser_result)
        replacement_metadata = _final_metadata(2)
        analysis_api, llm = environment.analysis_api(
            (_usable_response(replacement_metadata), _content_response(2))
        )

        proposal = analysis_api.analyze_content(analysis_input)

        self.assertIsInstance(proposal, LiteratureContentProposal)
        assert isinstance(proposal, LiteratureContentProposal)
        self.assertEqual(environment.authoritative_snapshot(), old_snapshot)
        self.assertNotEqual(
            proposal.literature_content_sha256, old_content.literature_content_sha256
        )
        decision = literature_api.accept_content(proposal)

        self.assertEqual(decision.decision, "accepted")
        new_facts = literature_api.read_facts(environment.literature.literature_id)
        self.assertEqual(new_facts.metadata_revision, old_facts.metadata_revision + 1)
        self.assertEqual(new_facts.literature.metadata, replacement_metadata)
        self.assertEqual(new_facts.metadata_sha256, proposal.metadata_sha256)
        self.assertIsNotNone(new_facts.current_content)
        self.assertIsNotNone(new_facts.current_content_lineage)
        assert new_facts.current_content is not None
        assert new_facts.current_content_lineage is not None
        self.assertEqual(
            new_facts.current_content.literature_content_sha256,
            proposal.literature_content_sha256,
        )
        self.assertNotEqual(
            new_facts.current_content.literature_content_sha256,
            old_content.literature_content_sha256,
        )
        self.assertEqual(new_facts.current_parser_result, parser_result)
        self.assertEqual(
            new_facts.current_content_lineage.parser_result_sha256,
            parser_result.result_sha256,
        )
        self.assertEqual(
            literature_api.read_status(environment.literature.literature_id).status,
            LiteratureStatus.CONTENT_READY,
        )
        rows = environment.current_content_rows()
        self.assertEqual(len(rows), 1)
        self.assertEqual(
            rows[0][0],
            new_facts.current_content.literature_content_sha256.root,
        )
        self.assertEqual(rows[0][1], new_facts.metadata_revision)
        self.assertEqual(
            environment.open_artifact(new_facts.current_content.markdown),
            render_canonical_markdown(
                metadata=replacement_metadata,
                sections=new_facts.current_content.sections,
                references=new_facts.current_content.references,
            ),
        )
        self.assertEqual(len(llm.calls), 2)

    def test_reference_lookup_failure_does_not_revoke_accepted_content(self) -> None:
        environment = self.environment(4)
        _parser_result, _proposal, _ready_llm = environment.make_content_ready()
        literature_api = environment.literature_api()
        before_facts = literature_api.read_facts(environment.literature.literature_id)
        before_status = literature_api.read_status(environment.literature.literature_id)
        before_snapshot = environment.authoritative_snapshot()
        before_checkpoints = len(environment.content_checkpoints)
        self.assertIsNotNone(before_facts.current_content)
        assert before_facts.current_content is not None
        analysis_api, llm = environment.analysis_api((_llm_failure(),))

        with self.assertRaises(ReferenceLookupFailure) as raised:
            analysis_api.extract_reference_lookups(before_facts.current_content.references)

        self.assertEqual(raised.exception.failure.code, "analysis-reference-llm")
        self.assertEqual([_request_stage(call) for call in llm.calls], ["reference"])
        self.assertEqual(environment.authoritative_snapshot(), before_snapshot)
        self.assertEqual(
            literature_api.read_facts(environment.literature.literature_id),
            before_facts,
        )
        self.assertEqual(
            literature_api.read_status(environment.literature.literature_id),
            before_status,
        )
        self.assertEqual(before_status.status, LiteratureStatus.CONTENT_READY)
        self.assertEqual(environment.reference_counts(), (0, 0, 0, 0))
        self.assertEqual(len(environment.content_checkpoints), before_checkpoints)


if __name__ == "__main__":
    unittest.main()
