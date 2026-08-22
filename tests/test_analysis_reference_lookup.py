from __future__ import annotations

import json
import threading
import unittest
from collections.abc import Callable, Iterable
from typing import cast

from sciretriever.agents import (
    AgentFailure,
    AgentPort,
    AgentProvenance,
    AgentRequest,
    AgentStructuredResponse,
)
from sciretriever.agents.failures import agent_failure
from sciretriever.analysis.api import AnalysisApi
from sciretriever.analysis.ports import (
    ContentAnalysisInput,
)
from sciretriever.analysis.references import (
    ReferenceLookupBudget,
    ReferenceLookupFailure,
    ReferenceLookupStage,
)
from sciretriever.model.analysis import ReferenceLookup
from sciretriever.model.primitives import Sha256, sha256_digest
from sciretriever.model.report import StableFailure

_MODEL = "fixture-reference-model"
_PROVIDER = "fixture-reference-provider"
_REFERENCE_SENTINEL = "REFERENCE-PRIVATE-SENTINEL"
_RESPONSE_SENTINEL = "RESPONSE-PRIVATE-SENTINEL"


def _lookup(
    reference_index: int,
    *,
    identifiers: list[dict[str, object]] | None = None,
    title: str | None = None,
    authors: list[object] | None = None,
    publication_year: int | None = None,
) -> dict[str, object]:
    return {
        "authors": [] if authors is None else authors,
        "identifiers": [] if identifiers is None else identifiers,
        "publication_year": publication_year,
        "reference_index": reference_index,
        "title": title,
    }


def _payload(*lookups: dict[str, object]) -> str:
    return json.dumps({"lookups": list(lookups)}, ensure_ascii=False)


def _response_for(
    call: AgentRequest,
    result: str,
    *,
    provider: str = _PROVIDER,
    model: str | None = None,
    input_sha256: Sha256 | None = None,
) -> AgentStructuredResponse:
    return AgentStructuredResponse(
        result=result,
        provenance=AgentProvenance(
            provider=provider,
            model=call.model if model is None else model,
            input_sha256=(call.input_sha256 if input_sha256 is None else input_sha256),
            parameters_sha256=sha256_digest(b"reference fixture parameters"),
        ),
    )


class _FakeLLM:
    def __init__(
        self,
        actions: Iterable[
            str
            | BaseException
            | AgentStructuredResponse
            | Callable[[AgentRequest], AgentStructuredResponse]
        ],
    ) -> None:
        self.actions = list(actions)
        self.calls: list[AgentRequest] = []

    @property
    def provider_name(self) -> str:
        return _PROVIDER

    def complete(self, call: AgentRequest) -> AgentStructuredResponse:
        self.calls.append(call)
        action = self.actions.pop(0)
        if isinstance(action, BaseException):
            raise action
        if isinstance(action, AgentStructuredResponse):
            return action
        if callable(action):
            return action(call)
        try:
            return _response_for(call, action)
        except ValueError:
            raise agent_failure("structured-response") from None


def _stage(
    llm: _FakeLLM,
    *,
    budget: ReferenceLookupBudget | None = None,
) -> ReferenceLookupStage:
    return ReferenceLookupStage(
        agents=cast(AgentPort, llm),
        model=_MODEL,
        max_output_tokens=2_048,
        budget=ReferenceLookupBudget() if budget is None else budget,
    )


class AnalysisReferenceLookupTests(unittest.TestCase):
    def _failure(self, operation: Callable[[], object]) -> ReferenceLookupFailure:
        with self.assertRaises(ReferenceLookupFailure) as caught:
            operation()
        return caught.exception

    def test_reference_lookup_only_api_is_real_and_content_fails_closed(self) -> None:
        reference = "A. Author. Explicit work. doi:10.5555/ONLY."
        llm = _FakeLLM(
            [
                _payload(
                    _lookup(
                        0,
                        identifiers=[{"namespace": "doi", "value": "10.5555/ONLY"}],
                        title="Explicit work",
                        authors=["A. Author"],
                    )
                )
            ]
        )
        api = AnalysisApi.for_reference_lookup(_stage(llm))

        with self.assertRaisesRegex(RuntimeError, "content analysis is not assembled"):
            api.analyze_content(cast(ContentAnalysisInput, object()))
        self.assertEqual(llm.calls, [])

        result = api.extract_reference_lookups((reference,))
        self.assertEqual(result[0].identifiers[0].value, "10.5555/only")
        self.assertEqual(len(llm.calls), 1)

        with self.assertRaisesRegex(TypeError, "reference_lookup_stage"):
            AnalysisApi.for_reference_lookup(object())

    def test_builds_one_private_closed_call_and_preserves_input_and_result_order(self) -> None:
        references = (
            f"A. Author. First work. doi:10.5555/FIRST. {_REFERENCE_SENTINEL}",
            "B. Author. Second Work. PMID: 24680.",
        )
        response = _payload(
            _lookup(
                0,
                identifiers=[{"namespace": "doi", "value": "10.5555/FIRST"}],
                title="First work",
                authors=["A. Author"],
            ),
            _lookup(
                1,
                identifiers=[{"namespace": "pmid", "value": "24680"}],
                title="Second Work",
                authors=["B. Author"],
            ),
        )
        llm = _FakeLLM([response])
        cancel_event = threading.Event()

        result = _stage(llm).extract(references, cancel_event=cancel_event)

        self.assertEqual([lookup.reference_index for lookup in result], [0, 1])
        self.assertTrue(all(isinstance(lookup, ReferenceLookup) for lookup in result))
        self.assertEqual(len(llm.calls), 1)
        call = llm.calls[0]
        self.assertEqual(call.role.value, "analysis")
        self.assertEqual(call.model, _MODEL)
        self.assertEqual(call.max_output_tokens, 2_048)
        self.assertIs(call.cancel_event, cancel_event)
        self.assertEqual(
            call.input_sha256,
            sha256_digest(call.structured_input.encode("utf-8")),
        )
        private_input = json.loads(call.structured_input)
        self.assertEqual(
            private_input,
            {
                "references": [
                    {"raw_text": references[0], "reference_index": 0},
                    {"raw_text": references[1], "reference_index": 1},
                ]
            },
        )

        schema_value = call.response_schema
        self.assertIsNotNone(schema_value)
        assert schema_value is not None
        schema = json.loads(schema_value)

        def assert_closed_objects(value: object) -> None:
            if isinstance(value, dict):
                if value.get("type") == "object":
                    self.assertFalse(value.get("additionalProperties"))
                    properties = cast(dict[str, object], value.get("properties"))
                    required = cast(list[str], value.get("required"))
                    self.assertEqual(set(properties), set(required))
                for nested in value.values():
                    assert_closed_objects(nested)
            elif isinstance(value, list):
                for nested in value:
                    assert_closed_objects(nested)

        assert_closed_objects(schema)
        rendered = "\n".join((repr(_stage(llm)), repr(call), repr(result)))
        self.assertNotIn(_REFERENCE_SENTINEL, rendered)
        self.assertNotIn(call.prompt, rendered)

    def test_doi_only_and_title_only_references_are_executable(self) -> None:
        references = (
            "doi: 10.1000/ONLY.ID",
            "A. Writer. An Explicit Title Without an Identifier. Journal X.",
        )
        llm = _FakeLLM(
            [
                _payload(
                    _lookup(
                        0,
                        identifiers=[{"namespace": "DOI", "value": "doi:10.1000/ONLY.ID"}],
                    ),
                    _lookup(1, title="An Explicit Title Without an Identifier"),
                )
            ]
        )

        result = _stage(llm).extract(references)

        self.assertEqual(result[0].identifiers[0].namespace, "doi")
        self.assertEqual(result[0].identifiers[0].value, "10.1000/only.id")
        self.assertIsNone(result[0].title)
        self.assertEqual(result[1].identifiers, ())
        self.assertEqual(result[1].title, "An Explicit Title Without an Identifier")

    def test_supported_identifiers_are_code_validated_and_canonicalized(self) -> None:
        references = (
            "DOI https://doi.org/10.5555/Mixed.Case.",
            "Preprint arXiv:2608.01234v3.",
            "Database record PMID: 0012345.",
            "Full text is indexed as PMCID: pmc7654321.",
        )
        llm = _FakeLLM(
            [
                _payload(
                    _lookup(
                        0,
                        identifiers=[
                            {
                                "namespace": "doi",
                                "value": "https://doi.org/10.5555/Mixed.Case",
                            }
                        ],
                    ),
                    _lookup(
                        1,
                        identifiers=[{"namespace": "arxiv", "value": "2608.01234v3"}],
                    ),
                    _lookup(
                        2,
                        identifiers=[{"namespace": "pmid", "value": "0012345"}],
                    ),
                    _lookup(
                        3,
                        identifiers=[{"namespace": "pmcid", "value": "pmc7654321"}],
                    ),
                )
            ]
        )

        result = _stage(llm).extract(references)

        self.assertEqual(
            [(item.namespace, item.value) for lookup in result for item in lookup.identifiers],
            [
                ("doi", "10.5555/mixed.case"),
                ("arxiv", "2608.01234"),
                ("pmid", "0012345"),
                ("pmcid", "PMC7654321"),
            ],
        )

    def test_doi_alignment_uses_the_identifier_contract_not_a_narrow_url_alphabet(self) -> None:
        doi = "10.1002/(SICI)1097-0312(199706)50:6<442::AID-CPA7>3.0.CO;2-L"
        llm = _FakeLLM(
            [
                _payload(
                    _lookup(
                        0,
                        identifiers=[{"namespace": "doi", "value": doi}],
                    )
                )
            ]
        )

        result = _stage(llm).extract((f"Complex identifier DOI: {doi}.",))

        self.assertEqual(result[0].identifiers[0].value, doi.lower())

    def test_title_author_and_year_allow_only_limited_unambiguous_equivalence(self) -> None:
        decomposed = "Cafe\u0301 Retrieval—A Study"
        reference = f"J. DOE. “{decomposed}”. Example Journal (2024)."
        llm = _FakeLLM(
            [
                _payload(
                    _lookup(
                        0,
                        title="Café Retrieval-A Study",
                        authors=["J. Doe"],
                        publication_year=2024,
                    )
                )
            ]
        )

        result = _stage(llm).extract((reference,))

        self.assertEqual(result[0].title, "Café Retrieval-A Study")
        self.assertEqual(result[0].authors, ("J. Doe",))
        self.assertEqual(result[0].publication_year, 2024)

    def test_empty_reference_tuple_is_a_no_call_empty_result(self) -> None:
        llm = _FakeLLM([])

        self.assertEqual(_stage(llm).extract(()), ())
        self.assertEqual(llm.calls, [])

    def test_input_shape_utf8_and_budgets_fail_before_call_without_leaking_text(self) -> None:
        cases: tuple[tuple[object, ReferenceLookupBudget, str], ...] = (
            (["reference"], ReferenceLookupBudget(), "analysis-reference-input"),
            (("   ",), ReferenceLookupBudget(), "analysis-reference-input"),
            (("bad\ud800",), ReferenceLookupBudget(), "analysis-reference-input"),
            (
                ("one", "two"),
                ReferenceLookupBudget(max_references=1),
                "analysis-reference-budget",
            ),
            (
                (f"{_REFERENCE_SENTINEL}x",),
                ReferenceLookupBudget(max_reference_bytes=4),
                "analysis-reference-budget",
            ),
            (
                ("abcd", "efgh"),
                ReferenceLookupBudget(max_total_reference_bytes=7),
                "analysis-reference-budget",
            ),
        )
        for references, budget, code in cases:
            with self.subTest(code=code, references_type=type(references).__name__):
                llm = _FakeLLM([])
                failure = self._failure(
                    lambda: _stage(llm, budget=budget).extract(cast(tuple[str, ...], references))
                )
                self.assertEqual(failure.failure.code, code)
                self.assertEqual(llm.calls, [])
                rendered = f"{failure!r}\n{failure}\n{failure.failure!r}"
                self.assertNotIn(_REFERENCE_SENTINEL, rendered)

    def test_response_requires_exact_closed_envelope_and_nested_shapes(self) -> None:
        valid = _lookup(0, title="Explicit Title")
        wrong_identifier = _lookup(
            0,
            identifiers=[{"namespace": "doi", "value": "10.1000/x", "extra": True}],
        )
        wrong_author = _lookup(0, title="Explicit Title", authors=[7])
        cases: tuple[object, ...] = (
            [],
            {},
            {"lookups": [valid], "extra": None},
            {"lookups": valid},
            {"lookups": [{"reference_index": 0, "title": "Explicit Title"}]},
            {"lookups": [wrong_identifier]},
            {"lookups": [wrong_author]},
            {"lookups": [_lookup(True, title="Explicit Title")]},
            {"lookups": [_lookup(0, title=cast(str, 42))]},
        )
        for value in cases:
            with self.subTest(value_type=type(value).__name__):
                llm = _FakeLLM([json.dumps(value)])
                failure = self._failure(lambda: _stage(llm).extract(("Explicit Title",)))
                self.assertEqual(failure.failure.code, "analysis-reference-structure")

    def test_duplicate_keys_nonfinite_values_and_malformed_json_are_rejected(self) -> None:
        cases = (
            '{"lookups":[],"lookups":[]}',
            '{"lookups":[{"reference_index":0,"identifiers":[],"title":"Title",'
            '"authors":[],"publication_year":NaN}]}',
            '{"lookups":',
        )
        for response in cases:
            with self.subTest(response=response[:16]):
                failure = self._failure(lambda: _stage(_FakeLLM([response])).extract(("Title",)))
                self.assertEqual(failure.failure.code, "analysis-reference-structure")
                self.assertNotIn(response, repr(failure))

    def test_indices_must_cover_the_input_once_in_stable_order(self) -> None:
        references = ("First Title", "Second Title")
        cases: tuple[list[dict[str, object]], ...] = (
            [_lookup(0, title="First Title")],
            [
                _lookup(0, title="First Title"),
                _lookup(0, title="First Title"),
            ],
            [
                _lookup(1, title="Second Title"),
                _lookup(0, title="First Title"),
            ],
            [
                _lookup(0, title="First Title"),
                _lookup(2, title="Second Title"),
            ],
        )
        for lookups in cases:
            with self.subTest(indices=[value["reference_index"] for value in lookups]):
                failure = self._failure(
                    lambda: _stage(_FakeLLM([_payload(*lookups)])).extract(references)
                )
                self.assertEqual(failure.failure.code, "analysis-reference-structure")

    def test_model_cannot_invent_any_lookup_evidence(self) -> None:
        reference = "A. Author. Real Title. Journal (2023). doi:10.1000/real"
        cases: tuple[dict[str, object], ...] = (
            _lookup(
                0,
                identifiers=[{"namespace": "doi", "value": "10.1000/invented"}],
            ),
            _lookup(0, title="Invented Title"),
            _lookup(0, title="Real Title", authors=["Invented Author"]),
            _lookup(0, title="Real Title", publication_year=2022),
        )
        for lookup in cases:
            with self.subTest(lookup=lookup):
                failure = self._failure(
                    lambda: _stage(_FakeLLM([_payload(lookup)])).extract((reference,))
                )
                self.assertEqual(failure.failure.code, "analysis-reference-alignment")
                self.assertNotIn(reference, repr(failure))

    def test_unknown_or_invalid_identifier_namespaces_are_rejected_by_code(self) -> None:
        cases: tuple[dict[str, object], ...] = (
            {"namespace": "isbn", "value": "9780123456789"},
            {"namespace": "doi", "value": "not-a-doi"},
            {"namespace": "arxiv", "value": "123"},
            {"namespace": "pmid", "value": "12A"},
            {"namespace": "pmcid", "value": "7654"},
        )
        for identifier in cases:
            with self.subTest(namespace=identifier["namespace"]):
                raw = f"Identifier {identifier['value']}"
                failure = self._failure(
                    lambda: _stage(
                        _FakeLLM([_payload(_lookup(0, identifiers=[identifier]))])
                    ).extract((raw,))
                )
                self.assertEqual(failure.failure.code, "analysis-reference-structure")

    def test_ambiguous_identifier_title_author_or_year_evidence_is_rejected(self) -> None:
        cases = (
            (
                "doi:10.1000/first; alternate doi:10.1000/second",
                _lookup(
                    0,
                    identifiers=[{"namespace": "doi", "value": "10.1000/first"}],
                ),
            ),
            (
                "Repeated Title; commentary on Repeated Title.",
                _lookup(0, title="Repeated Title"),
            ),
            (
                "A. Smith and A. Smith. Explicit Title.",
                _lookup(0, title="Explicit Title", authors=["A. Smith"]),
            ),
            (
                "A. Author. Explicit Title. First published 2020; corrected 2021.",
                _lookup(0, title="Explicit Title", publication_year=2020),
            ),
        )
        for reference, lookup in cases:
            with self.subTest(reference=reference):
                failure = self._failure(
                    lambda: _stage(_FakeLLM([_payload(lookup)])).extract((reference,))
                )
                self.assertEqual(failure.failure.code, "analysis-reference-alignment")

    def test_duplicate_hints_and_lookup_without_identifier_or_title_are_rejected(self) -> None:
        duplicate_identifiers = _lookup(
            0,
            identifiers=[
                {"namespace": "doi", "value": "10.1000/same"},
                {"namespace": "DOI", "value": "doi:10.1000/SAME"},
            ],
        )
        duplicate_authors = _lookup(
            0,
            title="Explicit Title",
            authors=["A. Author", "a. author"],
        )
        cases = (
            ("doi:10.1000/same", duplicate_identifiers, "analysis-reference-structure"),
            (
                "A. Author. Explicit Title.",
                duplicate_authors,
                "analysis-reference-structure",
            ),
            (
                "A. Author (2024). Journal only.",
                _lookup(0, authors=["A. Author"], publication_year=2024),
                "analysis-reference-no-lookup",
            ),
        )
        for reference, lookup, code in cases:
            with self.subTest(code=code):
                failure = self._failure(
                    lambda: _stage(_FakeLLM([_payload(lookup)])).extract((reference,))
                )
                self.assertEqual(failure.failure.code, code)

    def test_provider_failures_and_provenance_mismatch_are_stable_and_redacted(self) -> None:
        provider_failure = AgentFailure(
            StableFailure(
                code="agent-refusal",
                reason="Provider refused a private request.",
                action="Retry with another configured model.",
                retryable=False,
            )
        )
        cases: tuple[
            tuple[
                str | BaseException | Callable[[AgentRequest], AgentStructuredResponse],
                bool,
            ],
            ...,
        ] = (
            (provider_failure, False),
            (RuntimeError(_RESPONSE_SENTINEL), True),
            (
                lambda call: _response_for(
                    call,
                    _payload(_lookup(0, title="Explicit Title")),
                    provider="different-provider",
                ),
                False,
            ),
            (
                lambda call: _response_for(
                    call,
                    _payload(_lookup(0, title="Explicit Title")),
                    model="different-model",
                ),
                False,
            ),
            (
                lambda call: _response_for(
                    call,
                    _payload(_lookup(0, title="Explicit Title")),
                    input_sha256=Sha256("f" * 64),
                ),
                False,
            ),
        )
        for action, retryable in cases:
            with self.subTest(action=type(action).__name__):
                failure = self._failure(
                    lambda: _stage(_FakeLLM([action])).extract(
                        (f"Explicit Title {_REFERENCE_SENTINEL}",)
                    )
                )
                self.assertEqual(failure.failure.code, "analysis-reference-llm")
                self.assertEqual(failure.failure.retryable, retryable)
                rendered = f"{failure!r}\n{failure}\n{failure.failure!r}"
                self.assertNotIn(_REFERENCE_SENTINEL, rendered)
                self.assertNotIn(_RESPONSE_SENTINEL, rendered)

    def test_response_and_collection_budgets_are_enforced_after_provider_call(self) -> None:
        response = _payload(_lookup(0, title="Explicit Title", authors=["A. Author"]))
        budget_cases = (
            ReferenceLookupBudget(max_result_bytes=8),
            ReferenceLookupBudget(max_authors_per_lookup=0),
        )
        for budget in budget_cases:
            with self.subTest(budget=repr(budget)):
                llm = _FakeLLM([response])
                failure = self._failure(
                    lambda: _stage(llm, budget=budget).extract(("A. Author. Explicit Title.",))
                )
                self.assertEqual(failure.failure.code, "analysis-reference-budget")
                self.assertEqual(len(llm.calls), 1)

    def test_result_is_only_the_temporary_neutral_lookup_contract(self) -> None:
        result = _stage(
            _FakeLLM(
                [
                    _payload(
                        _lookup(
                            0,
                            identifiers=[{"namespace": "doi", "value": "10.1000/temp"}],
                            title="Temporary Lookup",
                        )
                    )
                ]
            )
        ).extract(("Temporary Lookup. doi:10.1000/temp",))

        self.assertIsInstance(result, tuple)
        self.assertEqual(
            set(type(result[0]).model_fields),
            {"authors", "identifiers", "publication_year", "reference_index", "title"},
        )
        serialized = result[0].model_dump_json().casefold()
        for forbidden in (
            "literature_id",
            "reference_id",
            "provenance",
            "raw_text",
            "persist",
            "confidence",
        ):
            self.assertNotIn(forbidden, serialized)


if __name__ == "__main__":
    unittest.main()
