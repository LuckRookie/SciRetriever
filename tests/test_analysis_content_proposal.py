from __future__ import annotations

import io
import json
import threading
import unittest
from collections.abc import Callable, Iterable
from contextlib import AbstractContextManager, closing
from typing import BinaryIO, cast

from sciretriever.analysis.content import (
    ContentAnalysisFailure,
    ContentAnalysisLimits,
)
from sciretriever.analysis.markdown import render_canonical_markdown
from sciretriever.analysis.metadata_rules import metadata_input_sha256
from sciretriever.analysis.ports import (
    AnalysisLLMCall,
    AnalysisLLMFailure,
    ContentAnalysisInput,
    ContentInputIdentity,
    StagedContentMarkdown,
    canonical_json_bytes,
)
from sciretriever.analysis.service import AnalysisService
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContentProposal,
    NoUsableContent,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.literature import Author, AuthorKind, Identifier
from sciretriever.model.llm import (
    LLMProvenance,
    LLMRequestKind,
    LLMStructuredResponse,
)
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResult,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure

_LITERATURE_ID = LiteratureId("10000001-e89b-12d3-a456-426614174000")
_ASSET_ID = AssetId("10000002-e89b-12d3-a456-426614174000")
_PARSER_PROVENANCE_ID = ProvenanceId("10000003-e89b-12d3-a456-426614174000")
_ANALYSIS_PROVENANCE_ID = ProvenanceId("10000004-e89b-12d3-a456-426614174000")
_TIME = UtcTimestamp("2026-08-12T08:09:10Z")
_PDF_SHA256 = sha256_digest(b"fixture primary PDF")
_MODEL = "fixture-analysis-model"
_PROVIDER = "fixture-provider"
_PRIVATE_SOURCE = "PRIVATE-PARSER-MARKDOWN-SENTINEL"
_PRIVATE_RESPONSE = "PRIVATE-LLM-RESPONSE-SENTINEL"
_PRIVATE_PATH = "/private/catalog/objects/parser.md"


def _metadata() -> LiteratureMetadata:
    return LiteratureMetadata(
        title="User Supplied Title",
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
        identifiers=(Identifier(namespace="doi", value="10.5555/analysis.fixture"),),
        keywords=("retrieval", "quantum materials"),
    )


def _parser_markdown() -> str:
    return f"""# User Supplied Title

{_PRIVATE_SOURCE}

Ada Lovelace reports a complete retrieval study for quantum materials.
The article appears in Fixture Journal, volume 7, issue 2, pages 101-109,
published by Example Publishing on 2026-08-12.
DOI: 10.5555/analysis.fixture.

# References

Ada A. Source work. Fixture Journal. 2025.
"""


def _content_draft() -> str:
    return """# 研究背景与目标

The study evaluates retrieval for quantum materials.

# 研究方法

未提供

# 数据

未提供

# 结论与局限性

未提供

# 参考文献

1. Ada A. Source work. Fixture Journal. 2025.
"""


def _usable_response(metadata: LiteratureMetadata | None = None) -> str:
    final_metadata = _metadata() if metadata is None else metadata
    return json.dumps(
        {
            "metadata": final_metadata.model_dump(mode="json"),
            "outcome": "usable",
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _no_usable_response() -> str:
    return '{"metadata":null,"outcome":"no_usable_content"}'


def _content_response(markdown: str | None = None) -> str:
    return json.dumps(
        {"markdown": _content_draft() if markdown is None else markdown},
        ensure_ascii=False,
        separators=(",", ":"),
    )


def _parser_result(markdown: str | None = None) -> ParserResult:
    source = _parser_markdown() if markdown is None else markdown
    encoded = source.encode("utf-8")
    markdown_ref = ParserArtifactRef(
        sha256=sha256_digest(encoded),
        media_type="text/markdown",
        byte_size=len(encoded),
    )
    provenance = ParserProvenance(
        provenance=Provenance(
            provenance_id=_PARSER_PROVENANCE_ID,
            source_kind=SourceKind.PARSER,
            source_name="fixture-parser",
            source_record_id=None,
            observed_at=_TIME,
            input_sha256=_PDF_SHA256,
            parameters_sha256=sha256_digest(b"fixture parser parameters"),
        ),
        parser_version="1.0",
        mode="fixture",
        model_identity=None,
    )
    result_hash = parser_result_sha256(
        source_asset_id=_ASSET_ID,
        source_sha256=_PDF_SHA256,
        page_count=2,
        markdown=markdown_ref,
        resources=(),
        provenance=provenance,
    )
    return ParserResult(
        source_asset_id=_ASSET_ID,
        source_sha256=_PDF_SHA256,
        page_count=2,
        markdown=markdown_ref,
        resources=(),
        result_sha256=result_hash,
        provenance=provenance,
    )


def _analysis_input(markdown: str | None = None) -> ContentAnalysisInput:
    parser_result = _parser_result(markdown)
    metadata = _metadata()
    return ContentAnalysisInput(
        literature_id=_LITERATURE_ID,
        primary_asset_id=_ASSET_ID,
        primary_pdf_sha256=_PDF_SHA256,
        parser_result=parser_result,
        initial_metadata=metadata,
        input_metadata_revision=3,
        input_metadata_sha256=metadata_input_sha256(metadata),
        user_observations=(),
    )


class _FakeLLM:
    def __init__(
        self,
        actions: Iterable[str | BaseException | Callable[[AnalysisLLMCall], object]],
        *,
        provider_name: str = _PROVIDER,
    ) -> None:
        self.actions = list(actions)
        self.calls: list[AnalysisLLMCall] = []
        self._provider_name = provider_name

    @property
    def provider_name(self) -> str:
        return self._provider_name

    def complete(self, call: AnalysisLLMCall) -> LLMStructuredResponse:
        self.calls.append(call)
        action = self.actions.pop(0)
        if isinstance(action, BaseException):
            raise action
        if callable(action):
            result = action(call)
            if not isinstance(result, LLMStructuredResponse):
                raise TypeError("fake action returned a private invalid value")
            return result
        parameter_bytes = f"{call.request.kind.value}-parameters".encode()
        return _response(call, action, parameters_sha256=sha256_digest(parameter_bytes))


def _response(
    call: AnalysisLLMCall,
    result: str,
    *,
    provider: str = _PROVIDER,
    model: str | None = None,
    input_sha256: Sha256 | None = None,
    parameters_sha256: Sha256 | None = None,
) -> LLMStructuredResponse:
    return LLMStructuredResponse(
        result=result,
        provenance=LLMProvenance(
            provider=provider,
            model=call.request.model if model is None else model,
            input_sha256=call.request.input_sha256 if input_sha256 is None else input_sha256,
            parameters_sha256=(
                sha256_digest(b"fixture parameters")
                if parameters_sha256 is None
                else parameters_sha256
            ),
        ),
    )


class _Reader:
    def __init__(self, payload: bytes, *, failure: BaseException | None = None) -> None:
        self.payload = payload
        self.failure = failure
        self.calls: list[ParserArtifactRef] = []
        self.private_path = _PRIVATE_PATH

    def open_artifact(
        self,
        reference: ParserArtifactRef,
    ) -> AbstractContextManager[BinaryIO]:
        self.calls.append(reference)
        if self.failure is not None:
            raise self.failure
        return closing(io.BytesIO(self.payload))

    def __repr__(self) -> str:
        return "<_Reader>"


class _CurrentInputs:
    def __init__(self, actions: Iterable[object] = (True, True)) -> None:
        self.actions = list(actions)
        self.calls: list[ContentInputIdentity] = []

    def current_input_matches(self, identity: ContentInputIdentity) -> bool:
        self.calls.append(identity)
        action = self.actions.pop(0)
        if isinstance(action, BaseException):
            raise action
        return action  # type: ignore[return-value]


class _Publisher:
    def __init__(
        self,
        *,
        failure: BaseException | None = None,
        replacement: ArtifactRef | None = None,
    ) -> None:
        self.failure = failure
        self.replacement = replacement
        self.calls: list[StagedContentMarkdown] = []

    def publish_markdown(self, staged: StagedContentMarkdown) -> ArtifactRef:
        self.calls.append(staged)
        if self.failure is not None:
            raise self.failure
        return staged.artifact if self.replacement is None else self.replacement


class _Factory:
    def __init__(self, value: object) -> None:
        self.value = value
        self.calls = 0

    def __call__(self) -> object:
        self.calls += 1
        return self.value


def _limits(**updates: int) -> ContentAnalysisLimits:
    values = {
        "max_input_bytes": 1024 * 1024,
        "max_chunk_bytes": 1024 * 1024,
        "max_chunk_count": 1,
        "max_total_llm_requests": 2,
        "max_total_output_tokens": 6144,
    }
    values.update(updates)
    return ContentAnalysisLimits(**values)


def _service(
    llm: _FakeLLM,
    *,
    reader: _Reader | None = None,
    current_inputs: _CurrentInputs | None = None,
    publisher: _Publisher | None = None,
    limits: ContentAnalysisLimits | None = None,
    metadata_max_output_tokens: int = 2048,
    content_max_output_tokens: int = 4096,
    provenance_id_factory: Callable[[], object] | None = None,
    clock: Callable[[], object] | None = None,
) -> tuple[AnalysisService, _Reader, _CurrentInputs, _Publisher]:
    artifact_reader = _Reader(_parser_markdown().encode()) if reader is None else reader
    verifier = _CurrentInputs() if current_inputs is None else current_inputs
    artifact_publisher = _Publisher() if publisher is None else publisher
    service = AnalysisService(
        llm=llm,
        artifact_reader=artifact_reader,
        current_inputs=verifier,
        artifact_publisher=artifact_publisher,
        model=_MODEL,
        metadata_max_output_tokens=metadata_max_output_tokens,
        content_max_output_tokens=content_max_output_tokens,
        limits=_limits() if limits is None else limits,
        provenance_id_factory=cast(
            Callable[[], ProvenanceId],
            (lambda: _ANALYSIS_PROVENANCE_ID)
            if provenance_id_factory is None
            else provenance_id_factory,
        ),
        clock=cast(Callable[[], UtcTimestamp], (lambda: _TIME) if clock is None else clock),
    )
    return service, artifact_reader, verifier, artifact_publisher


class AnalysisContentProposalTests(unittest.TestCase):
    def test_content_input_has_one_ports_owned_definition(self) -> None:
        from sciretriever.analysis.content import ContentAnalysisInput as content_export

        self.assertIs(content_export, ContentAnalysisInput)
        self.assertEqual(ContentAnalysisInput.__module__, "sciretriever.analysis.ports")

    def test_complete_path_is_exactly_two_ordered_calls_and_one_complete_proposal(self) -> None:
        llm = _FakeLLM((_usable_response(), _content_response()))
        service, reader, verifier, publisher = _service(llm)
        stage_input = _analysis_input()
        cancel_event = threading.Event()

        result = service.analyze(stage_input, cancel_event=cancel_event)

        self.assertIsInstance(result, LiteratureContentProposal)
        assert isinstance(result, LiteratureContentProposal)
        self.assertEqual(
            tuple(call.request.kind for call in llm.calls),
            (LLMRequestKind.METADATA, LLMRequestKind.CONTENT),
        )
        self.assertTrue(all(call.cancel_event is cancel_event for call in llm.calls))
        self.assertEqual(reader.calls, [stage_input.parser_result.markdown])
        self.assertEqual(len(verifier.calls), 2)
        expected_identity = stage_input.input_identity()
        self.assertEqual(verifier.calls, [expected_identity, expected_identity])

        content_input = json.loads(llm.calls[1].structured_input)
        self.assertEqual(content_input["final_metadata"], _metadata().model_dump(mode="json"))
        self.assertEqual(
            content_input["parser_result"],
            stage_input.parser_result.model_dump(mode="json"),
        )
        self.assertEqual(content_input["parser_markdown"], _parser_markdown())

        final_metadata_hash = metadata_input_sha256(_metadata())
        self.assertEqual(result.final_metadata, _metadata())
        self.assertEqual(result.metadata_sha256, final_metadata_hash)
        self.assertEqual(
            result.literature_content_sha256,
            content_sha256(
                metadata_sha256=final_metadata_hash,
                sections=result.sections,
                references=result.references,
            ),
        )
        markdown_bytes = render_canonical_markdown(
            metadata=result.final_metadata,
            sections=result.sections,
            references=result.references,
        )
        self.assertEqual(
            result.markdown,
            ArtifactRef(
                sha256=sha256_digest(markdown_bytes),
                media_type="text/markdown",
                byte_size=len(markdown_bytes),
            ),
        )
        self.assertEqual(len(publisher.calls), 1)
        self.assertEqual(publisher.calls[0].artifact, result.markdown)
        self.assertEqual(publisher.calls[0].content, markdown_bytes)
        self.assertNotEqual(result.literature_content_sha256, result.markdown.sha256)

        provenance = result.provenance
        self.assertIs(provenance.source_kind, SourceKind.ANALYSIS)
        self.assertEqual(provenance.source_name, f"{_PROVIDER}/{_MODEL}")
        self.assertIsNone(provenance.source_record_id)
        self.assertEqual(
            provenance.input_sha256,
            analysis_input_sha256(
                _PDF_SHA256,
                stage_input.parser_result.result_sha256,
                final_metadata_hash,
            ),
        )
        expected_parameter_manifest = {
            "model": _MODEL,
            "provider": _PROVIDER,
            "schema": "sciretriever-analysis-content-parameters-v1",
            "stages": [
                {
                    "kind": "metadata",
                    "max_output_tokens": 2048,
                    "parameters_sha256": str(sha256_digest(b"metadata-parameters")),
                    "prompt_version": llm.calls[0].prompt_version,
                },
                {
                    "kind": "content",
                    "max_output_tokens": 4096,
                    "parameters_sha256": str(sha256_digest(b"content-parameters")),
                    "prompt_version": llm.calls[1].prompt_version,
                },
            ],
        }
        self.assertEqual(
            provenance.parameters_sha256,
            sha256_digest(canonical_json_bytes(expected_parameter_manifest)),
        )

    def test_no_usable_content_stops_after_stage_one_without_artifact_or_provenance(self) -> None:
        llm = _FakeLLM((_no_usable_response(),))
        provenance_factory = _Factory(_ANALYSIS_PROVENANCE_ID)
        service, _, verifier, publisher = _service(
            llm,
            provenance_id_factory=provenance_factory,
        )

        result = service.analyze(_analysis_input())

        self.assertEqual(result, NoUsableContent(outcome="no_usable_content"))
        self.assertEqual(len(llm.calls), 1)
        self.assertEqual(len(verifier.calls), 2)
        self.assertEqual(publisher.calls, [])
        self.assertEqual(provenance_factory.calls, 0)

    def test_stage_failures_never_return_or_publish_partial_results(self) -> None:
        provider_failure = AnalysisLLMFailure(
            StableFailure(
                code="fixture-provider-failure",
                reason="The fixture provider failed.",
                action="Retry the fixture provider.",
                retryable=True,
            )
        )
        cases = (
            ("first", (provider_failure,), 1),
            ("second", (_usable_response(), provider_failure), 2),
            (
                "invalid-second-draft",
                (_usable_response(), _content_response("# 元数据\n\nforbidden")),
                2,
            ),
        )
        for name, actions, expected_calls in cases:
            with self.subTest(name=name):
                llm = _FakeLLM(actions)
                service, _, _, publisher = _service(llm)
                with self.assertRaises(ContentAnalysisFailure) as caught:
                    service.analyze(_analysis_input())
                self.assertEqual(len(llm.calls), expected_calls)
                self.assertEqual(publisher.calls, [])
                self.assertNotIsInstance(caught.exception, NoUsableContent)
                self.assertNotIn(_PRIVATE_RESPONSE, repr(caught.exception))

    def test_verified_artifact_failure_and_byte_mismatch_happen_before_llm(self) -> None:
        cases = (
            _Reader(b"x" * len(_parser_markdown().encode())),
            _Reader(_parser_markdown().encode(), failure=RuntimeError(_PRIVATE_PATH)),
        )
        for reader in cases:
            with self.subTest(reader=reader):
                llm = _FakeLLM((_usable_response(), _content_response()))
                service, _, _, publisher = _service(llm, reader=reader)
                with self.assertRaises(ContentAnalysisFailure) as caught:
                    service.analyze(_analysis_input())
                self.assertEqual(llm.calls, [])
                self.assertEqual(publisher.calls, [])
                self.assertEqual(caught.exception.failure.code, "analysis-content-artifact-read")
                self.assertNotIn(_PRIVATE_PATH, str(caught.exception))
                self.assertNotIn(_PRIVATE_PATH, repr(caught.exception))

    def test_stale_input_is_checked_before_first_call_and_after_the_terminal_stage(self) -> None:
        cases = (
            ("before-first", (False,), 0),
            ("after-content", (True, False), 2),
        )
        for name, stale_actions, expected_llm_calls in cases:
            with self.subTest(name=name):
                llm = _FakeLLM((_usable_response(), _content_response()))
                current = _CurrentInputs(stale_actions)
                service, _, _, publisher = _service(llm, current_inputs=current)
                with self.assertRaises(ContentAnalysisFailure) as caught:
                    service.analyze(_analysis_input())
                self.assertEqual(
                    caught.exception.failure.code,
                    "analysis-content-input-stale",
                )
                self.assertEqual(len(llm.calls), expected_llm_calls)
                self.assertEqual(publisher.calls, [])

        no_content_llm = _FakeLLM((_no_usable_response(),))
        no_content_current = _CurrentInputs((True, False))
        service, _, _, _ = _service(no_content_llm, current_inputs=no_content_current)
        with self.assertRaises(ContentAnalysisFailure) as caught:
            service.analyze(_analysis_input())
        self.assertEqual(caught.exception.failure.code, "analysis-content-input-stale")

    def test_each_provider_response_must_align_provider_model_and_input_hash(self) -> None:
        def forged(
            result: str,
            **updates: object,
        ) -> Callable[[AnalysisLLMCall], LLMStructuredResponse]:
            def action(call: AnalysisLLMCall) -> LLMStructuredResponse:
                return _response(call, result, **updates)  # type: ignore[arg-type]

            return action

        for field, updates in (
            ("provider", {"provider": "other-provider"}),
            ("model", {"model": "other-model"}),
            ("input", {"input_sha256": Sha256("f" * 64)}),
        ):
            with self.subTest(stage="metadata", field=field):
                llm = _FakeLLM((forged(_usable_response(), **updates),))
                service, _, _, publisher = _service(llm)
                with self.assertRaises(ContentAnalysisFailure):
                    service.analyze(_analysis_input())
                self.assertEqual(publisher.calls, [])
            with self.subTest(stage="content", field=field):
                llm = _FakeLLM((_usable_response(), forged(_content_response(), **updates)))
                service, _, _, publisher = _service(llm)
                with self.assertRaises(ContentAnalysisFailure):
                    service.analyze(_analysis_input())
                self.assertEqual(publisher.calls, [])

    def test_complete_input_is_single_chunk_and_all_budgets_fail_closed_before_llm(self) -> None:
        payload_size = len(_parser_markdown().encode())
        budget_cases = (
            (
                "input-bytes",
                _limits(max_input_bytes=payload_size - 1),
                "analysis-content-budget",
            ),
            (
                "chunk-count",
                _limits(max_chunk_bytes=payload_size // 3, max_chunk_count=2),
                "analysis-content-budget",
            ),
            (
                "multi-fragment-unsupported",
                _limits(max_chunk_bytes=payload_size - 1, max_chunk_count=2),
                "analysis-content-chunking-unsupported",
            ),
            (
                "request-count",
                _limits(max_total_llm_requests=1),
                "analysis-content-budget",
            ),
            (
                "output-tokens",
                _limits(max_total_output_tokens=6143),
                "analysis-content-budget",
            ),
        )
        for name, limits, expected_code in budget_cases:
            with self.subTest(name=name):
                llm = _FakeLLM((_usable_response(), _content_response()))
                service, reader, _, publisher = _service(llm, limits=limits)
                with self.assertRaises(ContentAnalysisFailure) as caught:
                    service.analyze(_analysis_input())
                self.assertEqual(caught.exception.failure.code, expected_code)
                self.assertEqual(llm.calls, [])
                self.assertEqual(reader.calls, [])
                self.assertEqual(publisher.calls, [])

    def test_artifact_publication_is_last_and_must_return_the_exact_descriptor(self) -> None:
        failures = (
            _Publisher(failure=RuntimeError(_PRIVATE_PATH)),
            _Publisher(
                replacement=ArtifactRef(
                    sha256=Sha256("f" * 64),
                    media_type="text/markdown",
                    byte_size=1,
                )
            ),
        )
        for publisher in failures:
            with self.subTest(publisher=publisher):
                llm = _FakeLLM((_usable_response(), _content_response()))
                service, _, _, _ = _service(llm, publisher=publisher)
                with self.assertRaises(ContentAnalysisFailure) as caught:
                    service.analyze(_analysis_input())
                self.assertEqual(len(llm.calls), 2)
                self.assertEqual(len(publisher.calls), 1)
                self.assertEqual(
                    caught.exception.failure.code,
                    "analysis-content-artifact-publication",
                )
                self.assertNotIn(_PRIVATE_PATH, repr(caught.exception))

    def test_invalid_factories_fail_without_publishing_and_valid_factories_run_once(self) -> None:
        cases = (
            ("id", _Factory("not-a-provenance-id"), _Factory(_TIME)),
            ("clock", _Factory(_ANALYSIS_PROVENANCE_ID), _Factory("not-a-time")),
            (
                "id-exception",
                _Factory(RuntimeError(_PRIVATE_PATH)),
                _Factory(_TIME),
            ),
        )
        for name, id_factory, clock in cases:
            with self.subTest(name=name):
                if isinstance(id_factory.value, BaseException):
                    failure = id_factory.value

                    def raising_factory() -> object:
                        raise failure

                    selected_id_factory: Callable[[], object] = raising_factory
                else:
                    selected_id_factory = id_factory
                llm = _FakeLLM((_usable_response(), _content_response()))
                service, _, _, publisher = _service(
                    llm,
                    provenance_id_factory=selected_id_factory,
                    clock=clock,
                )
                with self.assertRaises(ContentAnalysisFailure) as caught:
                    service.analyze(_analysis_input())
                self.assertEqual(caught.exception.failure.code, "analysis-content-contract")
                self.assertEqual(publisher.calls, [])

        id_factory = _Factory(_ANALYSIS_PROVENANCE_ID)
        clock = _Factory(_TIME)
        llm = _FakeLLM((_usable_response(), _content_response()))
        service, _, _, _ = _service(
            llm,
            provenance_id_factory=id_factory,
            clock=clock,
        )
        service.analyze(_analysis_input())
        self.assertEqual(id_factory.calls, 1)
        self.assertEqual(clock.calls, 1)

    def test_private_material_is_not_retained_in_repr_or_public_proposal(self) -> None:
        llm = _FakeLLM((_usable_response(), _content_response()))
        service, reader, _, publisher = _service(llm)
        stage_input = _analysis_input()

        result = service.analyze(stage_input)

        self.assertIsInstance(result, LiteratureContentProposal)
        assert isinstance(result, LiteratureContentProposal)
        rendered = "\n".join(
            (
                repr(service),
                repr(stage_input),
                repr(reader),
                repr(publisher.calls[0]),
                repr(result),
            )
        )
        for private in (
            _PRIVATE_SOURCE,
            _PRIVATE_RESPONSE,
            _PRIVATE_PATH,
            llm.calls[0].prompt,
            llm.calls[1].prompt,
        ):
            self.assertNotIn(private, rendered)
        serialized = json.dumps(result.model_dump(mode="json"), ensure_ascii=False)
        for forbidden in (
            "request",
            "response",
            "prompt",
            "task",
            "endpoint",
            "path",
            "parser_version",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_cancel_event_is_forwarded_and_pre_cancelled_work_fails_without_a_call(self) -> None:
        cancel_event = threading.Event()
        cancel_event.set()
        llm = _FakeLLM((_usable_response(), _content_response()))
        service, reader, _, publisher = _service(llm)

        with self.assertRaises(ContentAnalysisFailure) as caught:
            service.analyze(_analysis_input(), cancel_event=cancel_event)

        self.assertEqual(caught.exception.failure.code, "analysis-content-cancelled")
        self.assertEqual(reader.calls, [])
        self.assertEqual(llm.calls, [])
        self.assertEqual(publisher.calls, [])


if __name__ == "__main__":
    unittest.main()
