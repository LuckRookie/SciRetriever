"""Temporary, source-aligned lookup hints extracted from reference text.

This module owns the third Analysis-private request meaning.  It sends an
ordered, bounded tuple of reference texts through the existing Analysis LLM
port, accepts one closed lookup object for every input index, and verifies that
every returned hint is explicit in the corresponding source text.  The result
is only a tuple of neutral :class:`ReferenceLookup` values; raw text, prompts,
responses, call provenance, and persistence concerns do not cross this edge.
"""

from __future__ import annotations

import re
import threading
import unicodedata
from dataclasses import dataclass, replace
from typing import Final, cast

from pydantic import ValidationError

from sciretriever.agents import (
    AgentBudget,
    AgentFailure,
    AgentPort,
    AgentStructuredResponse,
    open_session,
)
from sciretriever.analysis.ports import (
    AnalysisCall,
    AnalysisRequest,
    AnalysisRequestKind,
    canonical_json_bytes,
    parse_strict_json_object,
)
from sciretriever.model.analysis import ReferenceLookup
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import sha256_digest
from sciretriever.model.report import StableFailure

_PROMPT_VERSION: Final[str] = "analysis-reference-lookup-v1"
_PROMPT: Final[str] = """You extract temporary search hints from reference text.

The input is an ordered array. Return exactly one lookup for every input item,
in the same order and with the unchanged reference_index. Extract only facts
explicitly written in that item's raw_text. Never infer, complete, translate,
or repair a title, author, publication year, or identifier. Identifiers may use
only DOI, arXiv, PMID, or PMCID namespaces. Use null for an absent title or
publication year and an empty array for absent identifiers or authors. Every
lookup must contain at least one explicit stable identifier or an explicit
nonblank title. Return no explanations, confidence, provenance, metadata,
relations, or persistence instructions.
"""

_SUPPORTED_IDENTIFIER_NAMESPACES: Final[frozenset[str]] = frozenset(
    {"arxiv", "doi", "pmcid", "pmid"}
)
_LOOKUP_FIELDS: Final[frozenset[str]] = frozenset(
    {"authors", "identifiers", "publication_year", "reference_index", "title"}
)
_IDENTIFIER_FIELDS: Final[frozenset[str]] = frozenset({"namespace", "value"})

_DOI_EVIDENCE = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(?:(?:doi\s*:\s*)|(?:https?://(?:dx\.)?doi\.org/))?"
    r"(?P<value>10\.\d{4,9}/\S+)",
    re.IGNORECASE,
)
_ARXIV_EVIDENCE = re.compile(
    r"(?<![A-Za-z0-9])"
    r"(?:(?:arxiv\s*:\s*)|(?:https?://(?:www\.)?arxiv\.org/(?:abs|pdf)/))?"
    r"(?P<value>"
    r"(?:\d{4}\.\d{4,5}|[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z]{2})?/\d{7})"
    r"(?:v\d+)?"
    r")"
    r"(?:\.pdf)?"
    r"(?![A-Za-z0-9])",
    re.IGNORECASE,
)
_PMID_EVIDENCE = re.compile(r"\bpmid\s*:?\s*(?P<value>\d+)\b", re.IGNORECASE)
_PMCID_EVIDENCE = re.compile(
    r"\b(?:pmcid\s*:?\s*)?(?P<value>pmc\d+)\b",
    re.IGNORECASE,
)
_POSSIBLE_PUBLICATION_YEAR = re.compile(r"(?<!\d)(?:1[5-9]\d{2}|20\d{2}|21\d{2})(?!\d)")
_WHITESPACE = re.compile(r"\s+")
_ALIGNMENT_TRANSLATION: Final[dict[int, str]] = str.maketrans(
    {
        "\u2010": "-",
        "\u2011": "-",
        "\u2012": "-",
        "\u2013": "-",
        "\u2014": "-",
        "\u2015": "-",
        "\u2212": "-",
        "\u2018": "'",
        "\u2019": "'",
        "\u201b": "'",
        "\u2032": "'",
        "\u201c": '"',
        "\u201d": '"',
        "\u201f": '"',
        "\u2033": '"',
    }
)


def _optional_string_schema() -> dict[str, object]:
    return {"anyOf": [{"type": "string"}, {"type": "null"}]}


def _response_schema_value() -> dict[str, object]:
    identifier = {
        "additionalProperties": False,
        "properties": {
            "namespace": {
                "enum": sorted(_SUPPORTED_IDENTIFIER_NAMESPACES),
                "type": "string",
            },
            "value": {"type": "string"},
        },
        "required": sorted(_IDENTIFIER_FIELDS),
        "type": "object",
    }
    lookup = {
        "additionalProperties": False,
        "properties": {
            "authors": {"items": {"type": "string"}, "type": "array"},
            "identifiers": {"items": identifier, "type": "array"},
            "publication_year": {
                "anyOf": [
                    {"maximum": 9999, "minimum": 1, "type": "integer"},
                    {"type": "null"},
                ]
            },
            "reference_index": {"minimum": 0, "type": "integer"},
            "title": _optional_string_schema(),
        },
        "required": sorted(_LOOKUP_FIELDS),
        "type": "object",
    }
    return {
        "additionalProperties": False,
        "properties": {"lookups": {"items": lookup, "type": "array"}},
        "required": ["lookups"],
        "type": "object",
    }


_RESPONSE_SCHEMA: Final[str] = canonical_json_bytes(_response_schema_value()).decode("utf-8")


@dataclass(frozen=True, slots=True, repr=False)
class ReferenceLookupBudget:
    """Request-local limits applied before and after the private LLM call."""

    max_references: int = 4_096
    max_reference_bytes: int = 65_536
    max_total_reference_bytes: int = 4 * 1024 * 1024
    max_result_bytes: int = 4 * 1024 * 1024
    max_identifiers_per_lookup: int = 16
    max_authors_per_lookup: int = 256

    def __post_init__(self) -> None:
        for field_name in (
            "max_references",
            "max_reference_bytes",
            "max_total_reference_bytes",
            "max_result_bytes",
        ):
            value = getattr(self, field_name)
            if type(value) is not int or value < 1:
                raise ValueError(f"{field_name} must be a positive integer")
        for field_name in (
            "max_identifiers_per_lookup",
            "max_authors_per_lookup",
        ):
            value = getattr(self, field_name)
            if type(value) is not int or value < 0:
                raise ValueError(f"{field_name} must be a nonnegative integer")

    def __repr__(self) -> str:
        return "<ReferenceLookupBudget>"


class ReferenceLookupFailure(RuntimeError):
    """Stable, redacted failure from temporary reference-hint extraction."""

    _MESSAGE = "reference lookup analysis failed"

    def __init__(self, failure: StableFailure) -> None:
        if not isinstance(failure, StableFailure):
            raise TypeError("failure must be a StableFailure")
        super().__init__(self._MESSAGE)
        self.failure = failure

    def __repr__(self) -> str:
        return "<ReferenceLookupFailure>"


class _ReferenceBudgetError(ValueError):
    pass


class _ReferenceAlignmentError(ValueError):
    pass


class _NoExecutableLookupError(ValueError):
    pass


class ReferenceLookupStage:
    """Execute one bounded lookup call and return only temporary neutral hints."""

    def __init__(
        self,
        *,
        agents: AgentPort,
        model: str,
        max_output_tokens: int,
        budget: ReferenceLookupBudget | None = None,
        agent_budget: AgentBudget | None = None,
    ) -> None:
        if not isinstance(agents, AgentPort):
            raise TypeError("agent must implement AgentPort")
        if type(model) is not str or not model.strip() or len(model.strip()) > 512:
            raise ValueError("model must be stable bounded text")
        if type(max_output_tokens) is not int or max_output_tokens < 1:
            raise ValueError("max_output_tokens must be a positive integer")
        selected_budget = ReferenceLookupBudget() if budget is None else budget
        if not isinstance(selected_budget, ReferenceLookupBudget):
            raise TypeError("budget must be a ReferenceLookupBudget")
        selected_agent_budget = (
            AgentBudget(max_output_tokens=max_output_tokens)
            if agent_budget is None
            else agent_budget
        )
        if not isinstance(selected_agent_budget, AgentBudget):
            raise TypeError("agent_budget must be an AgentBudget")
        if max_output_tokens > selected_agent_budget.max_output_tokens:
            raise ValueError("stage output must fit the Agent budget")
        self._agents = agents
        self._model = model.strip()
        self._max_output_tokens = max_output_tokens
        self._budget = selected_budget
        self._agent_budget = replace(
            selected_agent_budget,
            max_output_tokens=max_output_tokens,
        )

    def __repr__(self) -> str:
        return "<ReferenceLookupStage>"

    def extract(
        self,
        reference_texts: tuple[str, ...],
        *,
        cancel_event: threading.Event | None = None,
    ) -> tuple[ReferenceLookup, ...]:
        """Extract source-explicit lookup hints without retaining private material."""

        if type(reference_texts) is tuple and not reference_texts:
            return ()
        call = build_reference_lookup_call(
            model=self._model,
            reference_texts=reference_texts,
            max_output_tokens=self._max_output_tokens,
            cancel_event=cancel_event,
            budget=self._budget,
        )
        response = self._complete(call)
        return parse_reference_lookup_response(
            response,
            reference_texts=reference_texts,
            budget=self._budget,
        )

    def _complete(self, call: AnalysisCall) -> AgentStructuredResponse:
        try:
            request = call.to_agent_request(budget=self._agent_budget)
            with open_session(
                self._agents,
                max_turns=1,
                cancel_event=call.cancel_event,
                budget=self._agent_budget,
            ) as session:
                response = session.complete(request)
        except AgentFailure as error:
            if error.failure.code == "agent-structured-response":
                raise ReferenceLookupFailure(
                    _failure_for("analysis-reference-structure", retryable=False)
                ) from None
            raise ReferenceLookupFailure(
                _failure_for(
                    "analysis-reference-llm",
                    retryable=error.failure.retryable,
                )
            ) from None
        except Exception:
            raise ReferenceLookupFailure(
                _failure_for("analysis-reference-llm", retryable=True)
            ) from None

        if not isinstance(response, AgentStructuredResponse):
            raise ReferenceLookupFailure(_failure_for("analysis-reference-llm", retryable=False))
        try:
            provider_name = self._agents.provider_name
            aligned = (
                type(provider_name) is str
                and bool(provider_name.strip())
                and response.provenance.provider == provider_name.strip()
                and response.provenance.model == call.request.model
                and response.provenance.input_sha256 == call.request.input_sha256
            )
        except Exception:
            aligned = False
        if not aligned:
            raise ReferenceLookupFailure(_failure_for("analysis-reference-llm", retryable=False))
        return response


def build_reference_lookup_call(
    *,
    model: str,
    reference_texts: tuple[str, ...],
    max_output_tokens: int,
    cancel_event: threading.Event | None = None,
    budget: ReferenceLookupBudget | None = None,
) -> AnalysisCall:
    """Build the only Analysis-private request for the ordered reference tuple."""

    selected_budget = ReferenceLookupBudget() if budget is None else budget
    if not isinstance(selected_budget, ReferenceLookupBudget):
        raise TypeError("budget must be a ReferenceLookupBudget")
    try:
        checked = _validated_reference_texts(reference_texts, selected_budget)
        structured_bytes = canonical_json_bytes(
            {
                "references": [
                    {"raw_text": raw_text, "reference_index": index}
                    for index, raw_text in enumerate(checked)
                ]
            }
        )
        structured_input = structured_bytes.decode("utf-8", errors="strict")
        return AnalysisCall(
            request=AnalysisRequest(
                kind=AnalysisRequestKind.REFERENCE_LOOKUP,
                input_sha256=sha256_digest(structured_bytes),
                model=model,
                max_output_tokens=max_output_tokens,
            ),
            prompt_version=_PROMPT_VERSION,
            prompt=_PROMPT,
            structured_input=structured_input,
            response_schema=_RESPONSE_SCHEMA,
            cancel_event=cancel_event,
        )
    except _ReferenceBudgetError:
        raise ReferenceLookupFailure(
            _failure_for("analysis-reference-budget", retryable=False)
        ) from None
    except (
        ValidationError,
        UnicodeError,
        TypeError,
        ValueError,
        RecursionError,
    ):
        raise ReferenceLookupFailure(
            _failure_for("analysis-reference-input", retryable=False)
        ) from None


def parse_reference_lookup_response(
    response: AgentStructuredResponse,
    *,
    reference_texts: tuple[str, ...],
    budget: ReferenceLookupBudget | None = None,
) -> tuple[ReferenceLookup, ...]:
    """Strictly parse and align one provider-neutral reference lookup response."""

    selected_budget = ReferenceLookupBudget() if budget is None else budget
    if not isinstance(selected_budget, ReferenceLookupBudget):
        raise TypeError("budget must be a ReferenceLookupBudget")
    try:
        checked = _validated_reference_texts(reference_texts, selected_budget)
    except _ReferenceBudgetError:
        raise ReferenceLookupFailure(
            _failure_for("analysis-reference-budget", retryable=False)
        ) from None
    except (UnicodeError, TypeError, ValueError, RecursionError):
        raise ReferenceLookupFailure(
            _failure_for("analysis-reference-input", retryable=False)
        ) from None

    try:
        return _parse_aligned_response(response, checked, selected_budget)
    except _ReferenceBudgetError:
        raise ReferenceLookupFailure(
            _failure_for("analysis-reference-budget", retryable=False)
        ) from None
    except _NoExecutableLookupError:
        raise ReferenceLookupFailure(
            _failure_for("analysis-reference-no-lookup", retryable=False)
        ) from None
    except _ReferenceAlignmentError:
        raise ReferenceLookupFailure(
            _failure_for("analysis-reference-alignment", retryable=False)
        ) from None
    except (
        ValidationError,
        UnicodeError,
        TypeError,
        ValueError,
        RecursionError,
    ):
        raise ReferenceLookupFailure(
            _failure_for("analysis-reference-structure", retryable=False)
        ) from None


def _parse_aligned_response(
    response: AgentStructuredResponse,
    reference_texts: tuple[str, ...],
    budget: ReferenceLookupBudget,
) -> tuple[ReferenceLookup, ...]:
    if not isinstance(response, AgentStructuredResponse):
        raise TypeError("invalid reference lookup response")
    try:
        result_bytes = response.result.encode("utf-8", errors="strict")
    except UnicodeEncodeError:
        raise ValueError("invalid reference lookup response encoding") from None
    if len(result_bytes) > budget.max_result_bytes:
        raise _ReferenceBudgetError
    root = parse_strict_json_object(response.result)
    if frozenset(root) != frozenset({"lookups"}):
        raise ValueError("invalid reference lookup response envelope")
    raw_lookups = root.get("lookups")
    if not isinstance(raw_lookups, list):
        raise TypeError("reference lookups must be an array")
    if len(raw_lookups) != len(reference_texts):
        raise ValueError("reference lookup indices do not cover the input")

    lookups: list[ReferenceLookup] = []
    for expected_index, (raw_lookup, raw_text) in enumerate(
        zip(raw_lookups, reference_texts, strict=True)
    ):
        lookup = _parse_lookup(
            raw_lookup,
            expected_index=expected_index,
            budget=budget,
        )
        _validate_lookup_alignment(lookup, raw_text)
        lookups.append(lookup)
    return tuple(lookups)


def _validated_reference_texts(
    reference_texts: object,
    budget: ReferenceLookupBudget,
) -> tuple[str, ...]:
    if type(reference_texts) is not tuple:
        raise TypeError("reference_texts must be a tuple")
    if len(reference_texts) > budget.max_references:
        raise _ReferenceBudgetError
    total_bytes = 0
    checked: list[str] = []
    for value in reference_texts:
        if type(value) is not str or not value.strip() or "\x00" in value:
            raise ValueError("reference text must be nonblank text")
        encoded = value.encode("utf-8", errors="strict")
        if len(encoded) > budget.max_reference_bytes:
            raise _ReferenceBudgetError
        total_bytes += len(encoded)
        if total_bytes > budget.max_total_reference_bytes:
            raise _ReferenceBudgetError
        checked.append(value)
    return tuple(checked)


def _parse_lookup(
    raw_lookup: object,
    *,
    expected_index: int,
    budget: ReferenceLookupBudget,
) -> ReferenceLookup:
    lookup_object = _checked_lookup_object(raw_lookup)
    identifiers, title = _validate_lookup_shape(
        lookup_object,
        expected_index=expected_index,
        budget=budget,
    )
    if not identifiers and (title is None or not title.strip()):
        raise _NoExecutableLookupError
    lookup = ReferenceLookup.model_validate(lookup_object)
    _reject_duplicate_hints(lookup)
    return lookup


def _checked_lookup_object(raw_lookup: object) -> dict[str, object]:
    if not isinstance(raw_lookup, dict) or frozenset(raw_lookup) != _LOOKUP_FIELDS:
        raise ValueError("invalid reference lookup object")
    return cast(dict[str, object], raw_lookup)


def _validate_lookup_shape(
    raw_lookup: dict[str, object],
    *,
    expected_index: int,
    budget: ReferenceLookupBudget,
) -> tuple[list[object], str | None]:
    reference_index = raw_lookup.get("reference_index")
    identifiers = raw_lookup.get("identifiers")
    title = raw_lookup.get("title")
    authors = raw_lookup.get("authors")
    publication_year = raw_lookup.get("publication_year")
    if type(reference_index) is not int or reference_index != expected_index:
        raise ValueError("reference lookup index is not aligned")
    if not isinstance(identifiers, list) or not isinstance(authors, list):
        raise TypeError("reference lookup collections must be arrays")
    if len(identifiers) > budget.max_identifiers_per_lookup:
        raise _ReferenceBudgetError
    if len(authors) > budget.max_authors_per_lookup:
        raise _ReferenceBudgetError
    if title is not None and type(title) is not str:
        raise TypeError("reference lookup title must be text or null")
    if any(type(author) is not str for author in authors):
        raise TypeError("reference lookup authors must be text")
    if publication_year is not None and type(publication_year) is not int:
        raise TypeError("reference lookup year must be an integer or null")
    _validate_raw_identifiers(identifiers)
    return identifiers, title


def _validate_raw_identifiers(identifiers: list[object]) -> None:
    for raw_identifier in identifiers:
        if not isinstance(raw_identifier, dict) or frozenset(raw_identifier) != _IDENTIFIER_FIELDS:
            raise ValueError("invalid reference lookup identifier")
        namespace = raw_identifier.get("namespace")
        value = raw_identifier.get("value")
        if type(namespace) is not str or type(value) is not str:
            raise TypeError("reference lookup identifier fields must be text")
        if namespace.strip().lower() not in _SUPPORTED_IDENTIFIER_NAMESPACES:
            raise ValueError("unsupported reference lookup identifier namespace")


def _reject_duplicate_hints(lookup: ReferenceLookup) -> None:
    identifier_keys = [(item.namespace, item.value) for item in lookup.identifiers]
    if len(identifier_keys) != len(set(identifier_keys)):
        raise ValueError("reference lookup identifiers must be unique")
    author_keys = [_alignment_key(author) for author in lookup.authors]
    if len(author_keys) != len(set(author_keys)):
        raise ValueError("reference lookup authors must be unique")


def _validate_lookup_alignment(lookup: ReferenceLookup, raw_text: str) -> None:
    evidence = _identifier_evidence(raw_text)
    proposed_namespaces = {identifier.namespace for identifier in lookup.identifiers}
    for namespace in proposed_namespaces:
        candidates = evidence.get(namespace, set())
        if len(candidates) > 1:
            raise _ReferenceAlignmentError
    for identifier in lookup.identifiers:
        if identifier.value not in evidence.get(identifier.namespace, set()):
            raise _ReferenceAlignmentError

    if lookup.title is not None and _explicit_occurrence_count(raw_text, lookup.title) != 1:
        raise _ReferenceAlignmentError
    for author in lookup.authors:
        if _explicit_occurrence_count(raw_text, author) != 1:
            raise _ReferenceAlignmentError
    if lookup.publication_year is not None:
        _validate_publication_year(raw_text, lookup.publication_year)


def _identifier_evidence(raw_text: str) -> dict[str, set[str]]:
    evidence: dict[str, set[str]] = {
        namespace: set() for namespace in _SUPPORTED_IDENTIFIER_NAMESPACES
    }
    doi_spans: list[tuple[int, int]] = []
    for match in _DOI_EVIDENCE.finditer(raw_text):
        candidate = _trim_doi_evidence(match.group("value"))
        canonical = _canonical_identifier("doi", candidate)
        if canonical is not None:
            evidence["doi"].add(canonical)
            doi_spans.append(match.span())

    for match in _ARXIV_EVIDENCE.finditer(raw_text):
        if any(_spans_overlap(match.span(), doi_span) for doi_span in doi_spans):
            continue
        canonical = _canonical_identifier("arxiv", match.group("value"))
        if canonical is not None:
            evidence["arxiv"].add(canonical)
    for match in _PMID_EVIDENCE.finditer(raw_text):
        canonical = _canonical_identifier("pmid", match.group("value"))
        if canonical is not None:
            evidence["pmid"].add(canonical)
    for match in _PMCID_EVIDENCE.finditer(raw_text):
        canonical = _canonical_identifier("pmcid", match.group("value"))
        if canonical is not None:
            evidence["pmcid"].add(canonical)
    return evidence


def _canonical_identifier(namespace: str, value: str) -> str | None:
    try:
        return Identifier(namespace=namespace, value=value).value
    except (ValidationError, TypeError, ValueError):
        return None


def _trim_doi_evidence(value: str) -> str:
    candidate = value.rstrip(".,;:'\"\u2019\u201d\u2026\u00bb\u203a")
    pairs = (("(", ")"), ("[", "]"), ("{", "}"), ("<", ">"))
    changed = True
    while changed and candidate:
        changed = False
        for opening, closing in pairs:
            if candidate.endswith(closing) and candidate.count(closing) > candidate.count(opening):
                candidate = candidate[:-1]
                changed = True
    return candidate


def _spans_overlap(left: tuple[int, int], right: tuple[int, int]) -> bool:
    return left[0] < right[1] and right[0] < left[1]


def _alignment_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).translate(_ALIGNMENT_TRANSLATION)
    return _WHITESPACE.sub(" ", normalized).strip().casefold()


def _explicit_occurrence_count(raw_text: str, hint: str) -> int:
    source_key = _alignment_key(raw_text)
    hint_key = _alignment_key(hint)
    if not hint_key:
        return 0
    left_boundary = r"(?<!\w)" if hint_key[0].isalnum() or hint_key[0] == "_" else ""
    right_boundary = r"(?!\w)" if hint_key[-1].isalnum() or hint_key[-1] == "_" else ""
    expression = re.compile(left_boundary + re.escape(hint_key) + right_boundary)
    return sum(1 for _ in expression.finditer(source_key))


def _validate_publication_year(raw_text: str, publication_year: int) -> None:
    without_identifiers = _without_identifier_tokens(raw_text)
    year_text = str(publication_year)
    occurrences = re.findall(rf"(?<!\d){re.escape(year_text)}(?!\d)", without_identifiers)
    if not occurrences:
        raise _ReferenceAlignmentError
    possible_years = set(_POSSIBLE_PUBLICATION_YEAR.findall(without_identifiers))
    if 1500 <= publication_year <= 2199 and possible_years != {year_text}:
        raise _ReferenceAlignmentError


def _without_identifier_tokens(raw_text: str) -> str:
    value = _DOI_EVIDENCE.sub(" ", raw_text)
    value = _ARXIV_EVIDENCE.sub(" ", value)
    value = _PMID_EVIDENCE.sub(" ", value)
    return _PMCID_EVIDENCE.sub(" ", value)


def _failure_for(code: str, *, retryable: bool) -> StableFailure:
    messages: dict[str, tuple[str, str]] = {
        "analysis-reference-input": (
            "The reference lookup input is not a valid ordered text collection.",
            "Submit the current nonblank reference texts before retrying.",
        ),
        "analysis-reference-budget": (
            "The reference lookup exceeded its configured resource budget.",
            "Submit a smaller bounded reference batch before retrying.",
        ),
        "analysis-reference-llm": (
            "The reference lookup language-model call did not return an aligned result.",
            "Check the configured Analysis provider and retry the selected references.",
        ),
        "analysis-reference-structure": (
            "The reference lookup result violated the closed structure.",
            "Check the private reference prompt and model before retrying.",
        ),
        "analysis-reference-alignment": (
            "The reference lookup contains ambiguous or unsupported source hints.",
            "Retry using only search hints explicitly present in each reference text.",
        ),
        "analysis-reference-no-lookup": (
            "The reference lookup did not contain an executable search hint.",
            "Keep the original reference text and retry it in a later discovery run.",
        ),
    }
    try:
        reason, action = messages[code]
    except KeyError:
        raise ValueError("unsupported reference lookup failure code") from None
    return StableFailure(
        code=code,
        reason=reason,
        action=action,
        retryable=retryable,
    )


__all__ = (
    "ReferenceLookupBudget",
    "ReferenceLookupFailure",
    "ReferenceLookupStage",
    "build_reference_lookup_call",
    "parse_reference_lookup_response",
)
