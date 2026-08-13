from __future__ import annotations

import json
import threading
import unittest
from collections.abc import Callable, Iterable
from typing import cast

from sciretriever.analysis.metadata import (
    MetadataAnalysisFailure,
    MetadataAnalysisReceipt,
    MetadataAnalysisStage,
    MetadataStageInput,
)
from sciretriever.analysis.metadata_rules import metadata_input_sha256
from sciretriever.analysis.ports import AnalysisLLMCall, AnalysisLLMFailure, AnalysisLLMPort
from sciretriever.literature.metadata import project_metadata
from sciretriever.model.analysis import FinalMetadataProposal, NoUsableContent
from sciretriever.model.literature import Affiliation, Author, AuthorKind, Identifier
from sciretriever.model.llm import (
    LLMProvenance,
    LLMRequestKind,
    LLMStructuredResponse,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResult,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure

_ASSET_ID = AssetId("00000001-e89b-12d3-a456-426614174000")
_PARSER_PROVENANCE_ID = ProvenanceId("00000002-e89b-12d3-a456-426614174000")
_USER_PROVENANCE_ID = ProvenanceId("00000003-e89b-12d3-a456-426614174000")
_USER_OBSERVATION_ID = ObservationId("00000004-e89b-12d3-a456-426614174000")
_USER_PROVENANCE_ID_2 = ProvenanceId("00000005-e89b-12d3-a456-426614174000")
_USER_OBSERVATION_ID_2 = ObservationId("00000006-e89b-12d3-a456-426614174000")
_TIME = UtcTimestamp("2026-08-12T00:00:00Z")
_PDF_SHA256 = sha256_digest(b"fixture primary PDF")
_PARSER_PARAMETERS = sha256_digest(b"fixture parser parameters")
_MODEL = "fixture-metadata-model"
_PRIVATE_MARKDOWN_SENTINEL = "PRIVATE-MARKDOWN-SENTINEL"
_PRIVATE_RESPONSE_SENTINEL = "PRIVATE-RESPONSE-SENTINEL"
_DOI = Identifier(namespace="doi", value="10.5555/analysis.fixture")
_ORCID = "0000-0002-1825-0097"
_ROR = "03yrm5c26"
_METADATA_GOLDEN_SHA256 = Sha256("d04b1b40ff6fd1adc2f8e3b41c366a94b6906a8361d4bb9480fddedc6d3c8349")


class _FakeLLM:
    def __init__(self, actions: Iterable[object]) -> None:
        self.actions = list(actions)
        self.calls: list[AnalysisLLMCall] = []

    @property
    def provider_name(self) -> str:
        return "fixture-provider"

    def complete(self, call: AnalysisLLMCall) -> LLMStructuredResponse:
        self.calls.append(call)
        action = self.actions.pop(0)
        if isinstance(action, BaseException):
            raise action
        if callable(action):
            value = action(call)
            if not isinstance(value, LLMStructuredResponse):
                raise TypeError("fake action must return LLMStructuredResponse")
            return value
        if not isinstance(action, str):
            raise TypeError("fake action must be result text, failure, or callable")
        return _llm_response(call, action)


def _llm_response(
    call: AnalysisLLMCall,
    result: str,
    *,
    model: str | None = None,
    input_sha256: Sha256 | None = None,
) -> LLMStructuredResponse:
    return LLMStructuredResponse(
        result=result,
        provenance=LLMProvenance(
            provider="fixture-provider",
            model=call.request.model if model is None else model,
            input_sha256=(call.request.input_sha256 if input_sha256 is None else input_sha256),
            parameters_sha256=sha256_digest(b"fixture metadata response parameters"),
        ),
    )


def _author(
    *,
    display_name: str = "Ada Lovelace",
    kind: AuthorKind = AuthorKind.PERSON,
    given_name: str | None = "Ada",
    family_name: str | None = "Lovelace",
    orcid: str | None = _ORCID,
    affiliations: tuple[Affiliation, ...] = (),
) -> Author:
    return Author(
        kind=kind,
        display_name=display_name,
        given_name=given_name,
        family_name=family_name,
        orcid=orcid,
        affiliations=affiliations,
    )


def _initial_metadata(*, complete: bool = False) -> LiteratureMetadata:
    values: dict[str, object] = {
        "title": "User Supplied Title",
        "authors": (_author(orcid=None, affiliations=()),),
        "abstract": None,
        "publication_date": "2026-08-12",
        "publication_year": 2026,
        "document_type": "article",
        "language": "en",
        "venue": "Fixture Journal",
        "publisher": "Example Publishing, Inc.",
        "volume": "7",
        "issue": "2",
        "pages": None,
        "identifiers": (_DOI,),
        "keywords": ("imported keyword",),
    }
    if complete:
        values.update(
            {
                "abstract": "Imported abstract",
                "pages": "101-109",
            }
        )
    return LiteratureMetadata.model_validate(values)


def _final_metadata(
    initial: LiteratureMetadata | None = None,
    **updates: object,
) -> LiteratureMetadata:
    source = _initial_metadata() if initial is None else initial
    values = source.model_dump(mode="python")
    values.update(
        {
            "abstract": "The paper reports a complete short study.",
            "publisher": "Example Publishing",
            "pages": "101-109",
            "keywords": ("retrieval", "quantum materials"),
        }
    )
    values.update(updates)
    return LiteratureMetadata.model_validate(values)


def _usable(metadata: LiteratureMetadata) -> str:
    return json.dumps(
        {
            "outcome": "usable",
            "metadata": metadata.model_dump(mode="json"),
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def _no_usable() -> str:
    return '{"metadata":null,"outcome":"no_usable_content"}'


def _parser_result(markdown_bytes: bytes, *, page_count: int = 2) -> ParserResult:
    markdown = ParserArtifactRef(
        sha256=sha256_digest(markdown_bytes),
        media_type="text/markdown",
        byte_size=len(markdown_bytes),
    )
    provenance = ParserProvenance(
        provenance=Provenance(
            provenance_id=_PARSER_PROVENANCE_ID,
            source_kind=SourceKind.PARSER,
            source_name="fixture-parser",
            source_record_id=None,
            observed_at=_TIME,
            input_sha256=_PDF_SHA256,
            parameters_sha256=_PARSER_PARAMETERS,
        ),
        parser_version="1.0",
        mode="fixture",
        model_identity=None,
    )
    result_sha256 = parser_result_sha256(
        source_asset_id=_ASSET_ID,
        source_sha256=_PDF_SHA256,
        page_count=page_count,
        markdown=markdown,
        resources=(),
        provenance=provenance,
    )
    return ParserResult(
        source_asset_id=_ASSET_ID,
        source_sha256=_PDF_SHA256,
        page_count=page_count,
        markdown=markdown,
        resources=(),
        result_sha256=result_sha256,
        provenance=provenance,
    )


def _user_observation(
    metadata: LiteratureMetadata,
    *,
    observation_id: ObservationId = _USER_OBSERVATION_ID,
    provenance_id: ProvenanceId = _USER_PROVENANCE_ID,
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=observation_id,
        provenance=Provenance(
            provenance_id=provenance_id,
            source_kind=SourceKind.USER,
            source_name="bibliographic-import",
            source_record_id=None,
            observed_at=_TIME,
            input_sha256=None,
            parameters_sha256=None,
        ),
        metadata=metadata,
        version_role=None,
        version_links=(),
        declared_keywords=(),
        reference_texts=(),
        reference_count=None,
        cited_by_count=None,
        asset_hints=(),
    )


def _stage_input(
    markdown: str,
    *,
    metadata: LiteratureMetadata | None = None,
    page_count: int = 2,
    markdown_bytes: bytes | None = None,
    input_metadata_sha256: Sha256 | None = None,
    user_observations: tuple[MetadataObservation, ...] | None = None,
) -> MetadataStageInput:
    initial = _initial_metadata() if metadata is None else metadata
    payload = markdown.encode("utf-8") if markdown_bytes is None else markdown_bytes
    result = _parser_result(markdown.encode("utf-8"), page_count=page_count)
    return MetadataStageInput(
        parser_result=result,
        parser_markdown_bytes=payload,
        initial_metadata=initial,
        input_metadata_revision=3,
        input_metadata_sha256=(
            metadata_input_sha256(initial)
            if input_metadata_sha256 is None
            else input_metadata_sha256
        ),
        user_observations=(
            (_user_observation(initial),) if user_observations is None else user_observations
        ),
    )


def _stage(llm: _FakeLLM) -> MetadataAnalysisStage:
    return MetadataAnalysisStage(
        llm=cast(AnalysisLLMPort, llm),
        model=_MODEL,
        max_output_tokens=4_096,
    )


def _valid_markdown() -> str:
    return f"""# User Supplied Title

Ada Lovelace

## Abstract

The paper reports a complete short study.

## Main text

This one-page communication studies retrieval for quantum materials.
It reports methods, observations, and conclusions.
Pages: 101-109.
Publisher: Example Publishing, Inc.
DOI: 10.5555/analysis.fixture

{_PRIVATE_MARKDOWN_SENTINEL}
"""


class AnalysisMetadataStageTests(unittest.TestCase):
    def _failure(
        self,
        operation: Callable[[], object],
    ) -> MetadataAnalysisFailure:
        with self.assertRaises(MetadataAnalysisFailure) as caught:
            operation()
        return caught.exception

    def test_first_stage_builds_one_private_metadata_call_and_returns_existing_model(self) -> None:
        final = _final_metadata()
        llm = _FakeLLM([_usable(final)])
        stage_input = _stage_input(_valid_markdown(), page_count=1)
        stage = _stage(llm)

        result = stage.analyze(stage_input)

        self.assertIsInstance(result, FinalMetadataProposal)
        self.assertEqual(cast(FinalMetadataProposal, result).metadata, final)
        self.assertEqual(len(llm.calls), 1)
        call = llm.calls[0]
        self.assertEqual(call.request.kind, LLMRequestKind.METADATA)
        self.assertEqual(call.request.model, _MODEL)
        self.assertEqual(call.request.max_output_tokens, 4_096)
        self.assertEqual(
            call.request.input_sha256,
            sha256_digest(call.structured_input.encode("utf-8")),
        )
        private_input = json.loads(call.structured_input)
        self.assertEqual(private_input["parser"]["page_count"], 1)
        self.assertEqual(private_input["parser_markdown"], _valid_markdown())
        self.assertEqual(
            private_input["initial_metadata"], _initial_metadata().model_dump(mode="json")
        )
        serialized = call.structured_input.casefold()
        for forbidden in (
            "declared_keywords",
            "metadata-provider",
            "bibliographic-import",
            "classification",
            "tags",
            "provenance",
        ):
            self.assertNotIn(forbidden, serialized)
        rendered = "\n".join((repr(stage), repr(stage_input), repr(call)))
        self.assertNotIn(_PRIVATE_MARKDOWN_SENTINEL, rendered)
        self.assertNotIn(call.prompt, rendered)

    def test_metadata_schema_is_one_closed_common_provider_object_envelope(self) -> None:
        llm = _FakeLLM([_no_usable()])

        _stage(llm).analyze(_stage_input("# Cover\n\nCover page only"))

        schema = json.loads(llm.calls[0].response_schema)
        self.assertEqual(
            set(schema),
            {"additionalProperties", "properties", "required", "type"},
        )
        self.assertEqual(schema["type"], "object")
        self.assertFalse(schema["additionalProperties"])
        self.assertEqual(set(schema["required"]), {"metadata", "outcome"})
        self.assertEqual(
            schema["properties"]["outcome"],
            {
                "enum": ["no_usable_content", "usable"],
                "type": "string",
            },
        )

        def assert_closed_objects(value: object) -> None:
            if isinstance(value, dict):
                if value.get("type") == "object":
                    self.assertFalse(value.get("additionalProperties"))
                    properties = value.get("properties")
                    required = value.get("required")
                    self.assertIsInstance(properties, dict)
                    self.assertIsInstance(required, list)
                    self.assertEqual(
                        set(cast(dict[str, object], properties)),
                        set(cast(list[str], required)),
                    )
                for nested in value.values():
                    assert_closed_objects(nested)
            elif isinstance(value, list):
                for nested in value:
                    assert_closed_objects(nested)

        assert_closed_objects(schema)

    def test_exact_no_usable_content_is_accepted_for_the_only_allowed_categories(self) -> None:
        cases = {
            "cover": "# User Supplied Title\n\nCover page only",
            "toc": "# Contents\n\n1. Introduction ........ 1",
            "metadata-abstract": "# User Supplied Title\n\nAbstract: source abstract only",
            "access-error": "Access denied. Download the article from the publisher.",
            "wrong-work": "# A Different Work\n\nThis is explicitly DOI 10.5555/other.work.",
        }
        for name, markdown in cases.items():
            with self.subTest(name=name):
                llm = _FakeLLM([_no_usable()])

                result = _stage(llm).analyze(_stage_input(markdown))

                self.assertEqual(result, NoUsableContent(outcome="no_usable_content"))
                self.assertEqual(set(type(result).model_fields), {"outcome"})

    def test_one_page_complete_short_work_and_off_topic_work_remain_usable(self) -> None:
        cases = (
            _valid_markdown(),
            _valid_markdown().replace(
                "retrieval for quantum materials",
                "a complete humanities argument outside the collection topic",
            ),
        )
        for markdown in cases:
            with self.subTest(markdown=markdown[:40]):
                final = _final_metadata(
                    keywords=(
                        "retrieval",
                        "quantum materials",
                    )
                    if "quantum" in markdown
                    else ("humanities argument",),
                )
                if "quantum" not in markdown:
                    markdown += "\nHumanities argument.\n"
                llm = _FakeLLM([_usable(final)])

                result = _stage(llm).analyze(_stage_input(markdown, page_count=1))

                self.assertIsInstance(result, FinalMetadataProposal)

    def test_indeterminate_or_decorated_no_content_never_becomes_cleanup_result(self) -> None:
        cases = (
            ("garbled", '{"outcome":"unable_to_determine"}'),
            ("truncated", '{"outcome":"usable"}'),
            ("resource-only", '{"outcome":"unknown"}'),
            (
                "reason",
                '{"metadata":null,"outcome":"no_usable_content","reason":"garbled"}',
            ),
            (
                "confidence",
                '{"confidence":0.99,"metadata":null,"outcome":"no_usable_content"}',
            ),
            (
                "no-content-with-metadata",
                _usable(_final_metadata()).replace('"usable"', '"no_usable_content"', 1),
            ),
            ("usable-with-null-metadata", '{"metadata":null,"outcome":"usable"}'),
            ("malformed", '{"outcome":'),
        )
        for name, response in cases:
            with self.subTest(name=name):
                llm = _FakeLLM([response])
                failure = self._failure(
                    lambda: _stage(llm).analyze(_stage_input("![page](resources/page.png)"))
                )
                self.assertEqual(failure.failure.code, "analysis-metadata-structure")
                self.assertNotIsInstance(failure, NoUsableContent)

    def test_provider_and_untrusted_port_failures_are_redacted_analysis_failures(self) -> None:
        provider_failure = AnalysisLLMFailure(
            StableFailure(
                code="analysis-llm-refusal",
                reason="The provider refused the structured request.",
                action="Review the private prompt before retrying.",
                retryable=False,
            )
        )
        cases: tuple[tuple[BaseException, bool], ...] = (
            (provider_failure, False),
            (RuntimeError(_PRIVATE_RESPONSE_SENTINEL), True),
        )
        for error, retryable in cases:
            with self.subTest(error=type(error).__name__):
                llm = _FakeLLM([error])
                failure = self._failure(
                    lambda: _stage(llm).analyze(_stage_input(_valid_markdown()))
                )
                self.assertEqual(failure.failure.code, "analysis-metadata-llm")
                self.assertEqual(failure.failure.retryable, retryable)
                self.assertNotIn(_PRIVATE_RESPONSE_SENTINEL, repr(failure))
                self.assertNotIn(_PRIVATE_MARKDOWN_SENTINEL, repr(failure))

    def test_usable_response_requires_every_metadata_field_and_rejects_parallel_results(
        self,
    ) -> None:
        base = {
            "outcome": "usable",
            "metadata": _final_metadata().model_dump(mode="json"),
        }
        missing = json.loads(json.dumps(base))
        del missing["metadata"]["abstract"]
        top_level_extra = json.loads(json.dumps(base))
        top_level_extra["classification"] = ["parallel"]
        metadata_extra = json.loads(json.dumps(base))
        metadata_extra["metadata"]["tags"] = ["parallel"]
        provenance = json.loads(json.dumps(base))
        provenance["provenance"] = {"provider": "must-not-enter"}
        for value in (missing, top_level_extra, metadata_extra, provenance):
            with self.subTest(keys=tuple(value)):
                llm = _FakeLLM([json.dumps(value)])
                failure = self._failure(
                    lambda: _stage(llm).analyze(_stage_input(_valid_markdown()))
                )
                self.assertEqual(failure.failure.code, "analysis-metadata-structure")

    def test_parser_bytes_utf8_artifact_and_metadata_hash_are_rechecked_before_call(self) -> None:
        markdown = _valid_markdown()
        cases = (
            _stage_input(markdown, markdown_bytes=b"different bytes"),
            _stage_input(markdown, markdown_bytes=b"\xff"),
            _stage_input(markdown, input_metadata_sha256=Sha256("f" * 64)),
        )
        for stage_input in cases:
            with self.subTest(stage_input=repr(stage_input)):
                llm = _FakeLLM([_usable(_final_metadata())])
                failure = self._failure(lambda: _stage(llm).analyze(stage_input))
                self.assertEqual(failure.failure.code, "analysis-metadata-input")
                self.assertEqual(llm.calls, [])

    def test_metadata_input_hash_matches_the_literature_canonical_golden(self) -> None:
        self.assertEqual(metadata_input_sha256(_initial_metadata()), _METADATA_GOLDEN_SHA256)

    def test_existing_nonempty_scalar_values_cannot_be_rewritten(self) -> None:
        initial = _initial_metadata(complete=True)
        changes: dict[str, object] = {
            "title": "Rewritten Title",
            "abstract": "Rewritten abstract",
            "publication_date": "2025-01-01",
            "publication_year": 2025,
            "document_type": "book",
            "language": "fr",
            "venue": "Different Venue",
            "volume": "8",
            "issue": "3",
            "pages": "1-9",
        }
        for field_name, changed_value in changes.items():
            with self.subTest(field=field_name):
                proposed = _final_metadata(initial, **{field_name: changed_value})
                markdown = _valid_markdown() + f"\n{changed_value}\n"
                llm = _FakeLLM([_usable(proposed)])
                failure = self._failure(
                    lambda: _stage(llm).analyze(_stage_input(markdown, metadata=initial))
                )
                self.assertEqual(failure.failure.code, "analysis-metadata-proposal")

    def test_publisher_only_allows_provable_legal_suffix_normalization(self) -> None:
        initial = _initial_metadata()
        allowed = _final_metadata(initial, publisher="Example Publishing")
        llm = _FakeLLM([_usable(allowed)])
        result = _stage(llm).analyze(_stage_input(_valid_markdown(), metadata=initial))
        self.assertEqual(
            cast(FinalMetadataProposal, result).metadata.publisher, "Example Publishing"
        )

        unrelated = _final_metadata(initial, publisher="Unrelated Publishing")
        llm = _FakeLLM([_usable(unrelated)])
        failure = self._failure(
            lambda: _stage(llm).analyze(_stage_input(_valid_markdown(), metadata=initial))
        )
        self.assertEqual(failure.failure.code, "analysis-metadata-proposal")

        for before, after in (
            ("Example Publishing Ltd", "Example Publishing"),
            ("Example Publishing", "Example Publishing Ltd"),
        ):
            with self.subTest(before=before, after=after):
                initial = _initial_metadata().model_copy(update={"publisher": before})
                llm = _FakeLLM([_usable(_final_metadata(initial, publisher=after))])
                result = _stage(llm).analyze(_stage_input(_valid_markdown(), metadata=initial))
                self.assertEqual(
                    cast(FinalMetadataProposal, result).metadata.publisher,
                    after,
                )

        for before, after in (("Acme AG", "Acme SA"), ("Acme LLC", "Acme Inc")):
            with self.subTest(before=before, after=after):
                initial = _initial_metadata().model_copy(update={"publisher": before})
                llm = _FakeLLM([_usable(_final_metadata(initial, publisher=after))])
                failure = self._failure(
                    lambda: _stage(llm).analyze(_stage_input(_valid_markdown(), metadata=initial))
                )
                self.assertEqual(failure.failure.code, "analysis-metadata-proposal")

    def test_missing_pdf_fields_are_filled_only_from_explicit_markdown_evidence(self) -> None:
        final = _final_metadata()
        llm = _FakeLLM([_usable(final)])
        result = _stage(llm).analyze(_stage_input(_valid_markdown()))
        self.assertEqual(cast(FinalMetadataProposal, result).metadata.abstract, final.abstract)
        self.assertEqual(cast(FinalMetadataProposal, result).metadata.pages, "101-109")

        invented = _final_metadata(abstract="An invented source abstract.")
        llm = _FakeLLM([_usable(invented)])
        failure = self._failure(lambda: _stage(llm).analyze(_stage_input(_valid_markdown())))
        self.assertEqual(failure.failure.code, "analysis-metadata-alignment")

    def test_keywords_are_flat_unique_full_text_terms_and_declared_keywords_are_absent(
        self,
    ) -> None:
        final = _final_metadata(keywords=("retrieval", "quantum materials"))
        llm = _FakeLLM([_usable(final)])
        result = _stage(llm).analyze(_stage_input(_valid_markdown()))
        proposal = cast(FinalMetadataProposal, result)
        self.assertEqual(
            proposal.metadata.keywords,
            ("retrieval", "quantum materials"),
        )
        self.assertNotEqual(proposal.metadata.keywords, _initial_metadata().keywords)
        self.assertNotIn("declared_keywords", llm.calls[0].structured_input)

        for keywords in (("retrieval", "Retrieval"), ("invented method",)):
            with self.subTest(keywords=keywords):
                llm = _FakeLLM([_usable(_final_metadata(keywords=keywords))])
                failure = self._failure(
                    lambda: _stage(llm).analyze(_stage_input(_valid_markdown()))
                )
                self.assertEqual(failure.failure.code, "analysis-metadata-alignment")

    def test_existing_author_order_identity_and_nonempty_fields_are_hard_protected(self) -> None:
        institute = Affiliation(name="Analytical Engine Institute", ror=_ROR)
        initial = _initial_metadata().model_copy(
            update={"authors": (_author(affiliations=(institute,)),)}
        )
        cases = (
            (),
            (_author(display_name="A. Lovelace", affiliations=(institute,)),),
            (_author(given_name=None, affiliations=(institute,)),),
            (_author(orcid=None, affiliations=(institute,)),),
            (_author(affiliations=()),),
        )
        for authors in cases:
            with self.subTest(authors=authors):
                proposed = _final_metadata(initial, authors=authors)
                llm = _FakeLLM([_usable(proposed)])
                failure = self._failure(
                    lambda: _stage(llm).analyze(_stage_input(_valid_markdown(), metadata=initial))
                )
                self.assertEqual(failure.failure.code, "analysis-metadata-proposal")

    def test_pdf_explicit_author_orcid_affiliation_mapping_and_organization_are_preserved(
        self,
    ) -> None:
        initial = _initial_metadata().model_copy(update={"authors": ()})
        institute = Affiliation(name="Analytical Engine Institute", ror=_ROR)
        authors = (
            _author(affiliations=(institute,)),
            _author(
                display_name="Fixture Research Consortium",
                kind=AuthorKind.ORGANIZATION,
                given_name=None,
                family_name=None,
                orcid=None,
                affiliations=(),
            ),
        )
        markdown = (
            _valid_markdown()
            + f"""

Authors:
Ada Lovelace [1]
Given Name: Ada
Family Name: Lovelace
ORCID: {_ORCID}
[1] Analytical Engine Institute; ROR: {_ROR}
Fixture Research Consortium
"""
        )
        llm = _FakeLLM([_usable(_final_metadata(initial, authors=authors))])

        result = _stage(llm).analyze(_stage_input(markdown, metadata=initial))
        proposal = cast(FinalMetadataProposal, result)

        self.assertEqual(proposal.metadata.authors, authors)
        self.assertEqual(proposal.metadata.authors[0].affiliations, (institute,))
        self.assertIs(proposal.metadata.authors[1].kind, AuthorKind.ORGANIZATION)

    def test_html_superscript_markers_bind_each_author_to_only_its_affiliation(self) -> None:
        initial = _initial_metadata().model_copy(update={"authors": ()})
        analytical = Affiliation(name="Analytical Engine Institute")
        computing = Affiliation(name="Computing Institute")
        authors = (
            _author(
                given_name=None,
                family_name=None,
                orcid=None,
                affiliations=(analytical,),
            ),
            _author(
                display_name="Grace Hopper",
                given_name=None,
                family_name=None,
                orcid=None,
                affiliations=(computing,),
            ),
        )
        markdown = (
            _valid_markdown()
            + """

Ada Lovelace<sup>1</sup>
Grace Hopper<sup>2</sup>
Analytical Engine Institute<sup>1</sup>
Computing Institute<sup>2</sup>
"""
        )
        llm = _FakeLLM([_usable(_final_metadata(initial, authors=authors))])

        result = _stage(llm).analyze(_stage_input(markdown, metadata=initial))

        self.assertEqual(cast(FinalMetadataProposal, result).metadata.authors, authors)

    def test_family_comma_given_is_explicit_but_display_name_is_never_mechanically_split(
        self,
    ) -> None:
        initial = _initial_metadata().model_copy(update={"authors": ()})
        explicit = _author(
            display_name="Lovelace, Ada",
            given_name="Ada",
            family_name="Lovelace",
            orcid=None,
        )
        markdown = _valid_markdown() + "\nLovelace, Ada\n"
        llm = _FakeLLM([_usable(_final_metadata(initial, authors=(explicit,)))])

        result = _stage(llm).analyze(_stage_input(markdown, metadata=initial))

        self.assertEqual(cast(FinalMetadataProposal, result).metadata.authors, (explicit,))

    def test_guessed_name_parts_orcid_ror_and_ambiguous_all_to_all_affiliations_fail(self) -> None:
        empty_authors = _initial_metadata().model_copy(update={"authors": ()})
        institute = Affiliation(name="Analytical Engine Institute")
        other = Affiliation(name="Difference Institute")
        markdown = _valid_markdown() + "\nAda Lovelace\nGrace Hopper\nAnalytical Engine Institute\n"
        cases = (
            (
                "mechanical-name-split",
                (_author(orcid=None),),
            ),
            (
                "guessed-orcid",
                (_author(given_name=None, family_name=None, orcid=_ORCID),),
            ),
            (
                "guessed-ror",
                (
                    _author(
                        given_name=None,
                        family_name=None,
                        orcid=None,
                        affiliations=(Affiliation(name=institute.name, ror=_ROR),),
                    ),
                ),
            ),
            (
                "all-to-all",
                (
                    _author(
                        given_name=None,
                        family_name=None,
                        orcid=None,
                        affiliations=(institute, other),
                    ),
                    _author(
                        display_name="Grace Hopper",
                        given_name=None,
                        family_name=None,
                        orcid=None,
                        affiliations=(institute, other),
                    ),
                ),
            ),
        )
        for name, authors in cases:
            with self.subTest(name=name):
                llm = _FakeLLM([_usable(_final_metadata(empty_authors, authors=authors))])
                failure = self._failure(
                    lambda: _stage(llm).analyze(_stage_input(markdown, metadata=empty_authors))
                )
                self.assertEqual(failure.failure.code, "analysis-metadata-alignment")

    def test_identifiers_are_preserved_and_only_pdf_explicit_additions_are_allowed(self) -> None:
        initial = _initial_metadata()
        arxiv = Identifier(namespace="arxiv", value="2608.01234")
        markdown = _valid_markdown() + "\narXiv:2608.01234\n"
        proposed = _final_metadata(initial, identifiers=(*initial.identifiers, arxiv))
        llm = _FakeLLM([_usable(proposed)])
        result = _stage(llm).analyze(_stage_input(markdown, metadata=initial))
        self.assertEqual(cast(FinalMetadataProposal, result).metadata.identifiers[-1], arxiv)

        cases = (
            _final_metadata(initial, identifiers=()),
            _final_metadata(
                initial,
                identifiers=(
                    *initial.identifiers,
                    Identifier(namespace="pmid", value="99999999"),
                ),
            ),
        )
        for value in cases:
            llm = _FakeLLM([_usable(value)])
            failure = self._failure(
                lambda: _stage(llm).analyze(_stage_input(markdown, metadata=initial))
            )
            self.assertIn(
                failure.failure.code,
                {"analysis-metadata-proposal", "analysis-metadata-alignment"},
            )

    def test_user_import_observations_are_local_protection_inputs_not_llm_payload(self) -> None:
        first_metadata = _initial_metadata()
        second_metadata = _initial_metadata().model_copy(
            update={
                "title": "Other User Title",
                "identifiers": (Identifier(namespace="pmid", value="12345678"),),
            }
        )
        observations = (
            _user_observation(first_metadata),
            _user_observation(
                second_metadata,
                observation_id=_USER_OBSERVATION_ID_2,
                provenance_id=_USER_PROVENANCE_ID_2,
            ),
        )
        projection = project_metadata(observations)
        self.assertEqual(projection.outcome, "projected")
        assert projection.metadata is not None
        initial = projection.metadata
        self.assertEqual(initial.title, first_metadata.title)
        self.assertEqual(
            initial.identifiers,
            (
                _DOI,
                Identifier(namespace="pmid", value="12345678"),
            ),
        )
        stage_input = _stage_input(
            _valid_markdown(),
            metadata=initial,
            user_observations=observations,
        )
        llm = _FakeLLM([_usable(_final_metadata(initial))])

        result = _stage(llm).analyze(stage_input)

        self.assertIsInstance(result, FinalMetadataProposal)
        self.assertEqual(len(llm.calls), 1)
        serialized = llm.calls[0].structured_input
        self.assertNotIn("Other User Title", serialized)
        self.assertNotIn("bibliographic-import", serialized)
        self.assertNotIn("observation_id", serialized)
        self.assertNotIn("provenance", serialized)
        self.assertNotIn("Other User Title", repr(stage_input))

    def test_user_observation_source_contract_is_still_fail_closed(self) -> None:
        initial = _initial_metadata()
        invalid = _user_observation(initial).model_copy(
            update={
                "provenance": _user_observation(initial).provenance.model_copy(
                    update={"source_name": "not-bibliographic-import"}
                )
            }
        )
        llm = _FakeLLM([_usable(_final_metadata(initial))])

        failure = self._failure(
            lambda: _stage(llm).analyze(
                _stage_input(
                    _valid_markdown(),
                    metadata=initial,
                    user_observations=(invalid,),
                )
            )
        )

        self.assertEqual(failure.failure.code, "analysis-metadata-input")
        self.assertEqual(llm.calls, [])

    def test_execute_forwards_cancellation_and_returns_only_safe_an4_receipt(self) -> None:
        responses: list[LLMStructuredResponse] = []

        def response_for(call: AnalysisLLMCall) -> LLMStructuredResponse:
            response = _llm_response(call, _usable(_final_metadata()))
            responses.append(response)
            return response

        llm = _FakeLLM([response_for])
        cancel_event = threading.Event()
        stage_input = _stage_input(_valid_markdown())

        receipt = _stage(llm).execute(stage_input, cancel_event=cancel_event)

        self.assertIsInstance(receipt, MetadataAnalysisReceipt)
        self.assertIs(llm.calls[0].cancel_event, cancel_event)
        self.assertEqual(receipt.request, llm.calls[0].request)
        self.assertEqual(receipt.provenance, responses[0].provenance)
        self.assertEqual(receipt.prompt_version, llm.calls[0].prompt_version)
        self.assertIsInstance(receipt.result, FinalMetadataProposal)
        rendered = repr(receipt)
        for private_value in (
            _PRIVATE_MARKDOWN_SENTINEL,
            _PRIVATE_RESPONSE_SENTINEL,
            _final_metadata().title,
            llm.calls[0].prompt,
            llm.calls[0].structured_input,
            llm.calls[0].response_schema,
        ):
            self.assertNotIn(private_value, rendered)

    def test_response_provenance_must_align_with_the_exact_metadata_request(self) -> None:
        actions = (
            lambda call: _llm_response(
                call,
                _usable(_final_metadata()),
                input_sha256=Sha256("e" * 64),
            ),
            lambda call: _llm_response(
                call,
                _usable(_final_metadata()),
                model="different-model",
            ),
        )
        for action in actions:
            llm = _FakeLLM([action])
            failure = self._failure(lambda: _stage(llm).analyze(_stage_input(_valid_markdown())))
            self.assertEqual(failure.failure.code, "analysis-metadata-llm")


if __name__ == "__main__":
    unittest.main()
