"""Pure matching, ordering, fingerprint and cursor rules for local queries.

This module owns the Literature-side semantics that a read-model adapter must
reuse.  It deliberately has no SQLite, filesystem, Provider, Entry or report
dependency: adapters turn these normalized values into parameterized queries
inside their own read-only snapshot.
"""

from __future__ import annotations

import base64
import binascii
import hashlib
import json
import math
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any, Final, NoReturn, TypeVar, cast

from sciretriever.literature.state import CurrentLiteratureFacts, derive_status
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySort,
    LiteratureMissingStep,
    LiteratureReferenceRequest,
    ReferenceDirection,
)
from sciretriever.model.literature import LiteratureStatus
from sciretriever.model.primitives import LiteratureId, Sha256, sha256_digest

_T = TypeVar("_T")

_QUERY_FINGERPRINT_SCHEMA: Final[str] = "sciretriever-library-query-v1"
_CURSOR_VERSION: Final[int] = 1
_SEARCH_CURSOR_KIND: Final[str] = "library-search"
_REFERENCE_CURSOR_KIND: Final[str] = "literature-references"
_CURSOR_ERROR_MESSAGE: Final[str] = "literature query cursor is invalid"
_SEARCH_SORTS: Final[frozenset[str]] = frozenset(
    {
        "publication-year-desc",
        "publication-year-asc",
        "title-asc",
        "title-desc",
        "relevance",
    }
)
_REFERENCE_DIRECTIONS: Final[frozenset[str]] = frozenset({"references", "cited-by"})

# FTS5 recognizes these ASCII words as syntax.  Removing only this closed set
# keeps an ordinary word such as ``drop`` searchable while making every actual
# FTS word operator a delimiter.  Punctuation is already a delimiter under the
# Unicode category tokenizer below.
_FTS_WORD_OPERATORS: Final[frozenset[str]] = frozenset({"and", "near", "not", "or"})


class LiteratureQueryError(RuntimeError):
    """A stable failure in a pure local-Literature query rule."""


class LiteratureCursorError(LiteratureQueryError):
    """An opaque query cursor is malformed, tampered with, or wrongly bound."""


@dataclass(frozen=True, slots=True)
class SearchCursorPosition:
    """The complete stable position for exactly one ``LibrarySort``.

    Year and title use ``None`` as their explicit missing value.  A relevance
    position instead carries one finite FTS5 ``bm25`` score.  The encoder
    rejects fields that do not belong to the selected sort.
    """

    literature_id: LiteratureId
    publication_year: int | None = None
    normalized_title: str | None = None
    relevance: float | None = None


@dataclass(frozen=True, slots=True)
class ReferenceCursorPosition:
    """The complete fixed-order position of one related Literature."""

    related_literature_id: LiteratureId
    publication_year: int | None
    normalized_title: str | None


def normalize_query_text(value: str) -> str:
    """Normalize ordinary full-text input in the frozen order.

    The order is Unicode NFC, Unicode casefold, then collapsing every run of
    Unicode whitespace to one ASCII space.  No NFKC, transliteration, fuzzy
    expansion or query-language parsing is performed.
    """

    if not isinstance(value, str):
        raise TypeError("query text must be a string")
    normalized = unicodedata.normalize("NFC", value).casefold()
    return " ".join(normalized.split())


def _fts5_tokens(value: str) -> tuple[str, ...]:
    """Tokenize one value for both the FTS index and generated query side."""

    normalized = normalize_query_text(value)
    terms: list[str] = []
    current: list[str] = []

    def finish_term() -> None:
        if not current:
            return
        term = "".join(current)
        current.clear()
        if term not in _FTS_WORD_OPERATORS:
            terms.append(term)

    for character in normalized:
        category = unicodedata.category(character)[:1]
        if category in {"L", "N"}:
            current.append(character)
        elif category == "M" and current:
            # Casefold can introduce a combining mark even after NFC (for
            # example U+0130 -> ``i`` + U+0307).  Keeping that mark attached
            # prevents the query and index pipelines from splitting the same
            # display word into different tokens.
            current.append(character)
        else:
            finish_term()
    finish_term()
    return tuple(terms)


def fts5_index_text(value: str) -> str:
    """Return the authoritative FTS5 index text for one display value.

    Tokens keep occurrence count for real FTS ranking, while punctuation and
    reserved FTS word operators become separators.  Storage writes only this
    generated text; it never imports private Literature query internals.
    """

    return " ".join(_fts5_tokens(value))


def text_search_terms(value: str) -> tuple[str, ...]:
    """Return safe, idempotent full-text terms in first-occurrence order.

    A term starts with a Unicode letter or number and retains following
    Unicode combining marks.  Everything else is a separator.  FTS word
    operators are separators as well, never executable syntax.
    """

    terms: list[str] = []
    for term in _fts5_tokens(value):
        if term not in terms:
            terms.append(term)
    return tuple(terms)


def quoted_fts5_and_query(value: str) -> str | None:
    """Build a generated-only quoted FTS5 AND expression.

    ``None`` means the caller supplied text but it contained no searchable
    term.  A read-model adapter must treat that result as *no match*, not as an
    absent text filter or a request for the whole library.
    """

    terms = text_search_terms(value)
    if not terms:
        return None
    return " AND ".join(f'"{term}"' for term in terms)


def normalize_contains_text(value: str) -> str:
    """Return the exact key for title/author/venue/publisher containment.

    This rule performs NFC, Unicode whitespace collapse and casefold, in that
    order.  It intentionally preserves punctuation and hyphens and performs
    no NFKC, ASCII transliteration or fuzzy comparison.
    """

    if not isinstance(value, str):
        raise TypeError("contains text must be a string")
    normalized = unicodedata.normalize("NFC", value)
    return " ".join(normalized.split()).casefold()


def normalized_contains(candidate: str | None, query: str) -> bool:
    """Apply the frozen case-insensitive contains rule to two display values."""

    if candidate is None:
        return False
    normalized_query = normalize_contains_text(query)
    if not normalized_query:
        return False
    return normalized_query in normalize_contains_text(candidate)


def matches_any_requested_value(
    available_values: Iterable[_T],
    requested_values: Iterable[_T],
) -> bool:
    """Implement an optional multi-value field's internal OR semantics."""

    available = tuple(available_values)
    requested = tuple(requested_values)
    return not requested or any(value in available for value in requested)


def matches_all_requested_values(
    available_values: Iterable[_T],
    requested_values: Iterable[_T],
) -> bool:
    """Implement the keyword field's internal AND semantics."""

    available = tuple(available_values)
    requested = tuple(requested_values)
    return all(value in available for value in requested)


def first_missing_step(facts: CurrentLiteratureFacts) -> LiteratureMissingStep | None:
    """Derive only the earliest missing processing fact from one current view."""

    if not isinstance(facts, CurrentLiteratureFacts):
        raise TypeError("facts must be CurrentLiteratureFacts")
    status = derive_status(facts)
    if status is LiteratureStatus.UNREVIEWED:
        return "primary-pdf"

    # A valid ASSET_READY/CONTENT_READY view necessarily has exactly one valid
    # current primary PDF under ``derive_status``.
    primary = facts.current_primary_pdfs[0]
    parser = facts.current_parser_result
    if (
        parser is None
        or parser.source_asset_id != primary.asset.asset_id
        or parser.source_sha256 != primary.asset.sha256
    ):
        return "parser-result"
    if status is LiteratureStatus.CONTENT_READY:
        return None
    return "literature-content"


def query_fingerprint(query: LibraryQuery) -> Sha256:
    """Hash the canonical matching semantics of one ``LibraryQuery``.

    Every tuple with set semantics is sorted.  Full-text AND terms are sorted
    and de-duplicated independently of caller order; contains fields use their
    exact comparison keys.  Presentation and pagination values are absent by
    construction because this function accepts ``LibraryQuery``, not a search
    request.
    """

    if not isinstance(query, LibraryQuery):
        raise TypeError("query must be a LibraryQuery")

    payload = {
        "author": _optional_contains_key(query.author),
        "author_orcids": sorted(query.author_orcids),
        "discovery_run_ids": sorted(str(value) for value in query.discovery_run_ids),
        "document_types": sorted(query.document_types),
        "identifiers": sorted(
            (
                {"namespace": identifier.namespace, "value": identifier.value}
                for identifier in query.identifiers
            ),
            key=lambda value: (value["namespace"], value["value"]),
        ),
        "keywords": sorted(query.keywords),
        "languages": sorted(query.languages),
        "missing_steps": sorted(query.missing_steps),
        "needs_manual_pdf": query.needs_manual_pdf,
        "publication_year_from": query.publication_year_from,
        "publication_year_to": query.publication_year_to,
        "publisher": _optional_contains_key(query.publisher),
        "schema": _QUERY_FINGERPRINT_SCHEMA,
        "statuses": sorted(value.value for value in query.statuses),
        "text_terms": (None if query.text is None else sorted(set(text_search_terms(query.text)))),
        "title": _optional_contains_key(query.title),
        "venue": _optional_contains_key(query.venue),
        "version_roles": sorted(value.value for value in query.version_roles),
    }
    return sha256_digest(_canonical_json(payload))


def relevance_sort_key(score: float, literature_id: LiteratureId) -> tuple[float, str]:
    """Order equal-weight FTS5 ``bm25`` scores low-first, then by identity."""

    relevance = _finite_relevance(score)
    return relevance, _literature_id_text(literature_id)


def reference_sort_key(
    publication_year: int | None,
    title: str | None,
    related_literature_id: LiteratureId,
) -> tuple[bool, int, bool, str, str]:
    """Return the fixed relation order key.

    The key is year descending with null last, normalized title ascending with
    null last, and related LiteratureId as the final stable tie-break.
    """

    year_is_null, year = _year_components(publication_year)
    normalized_title = None if title is None else normalize_contains_text(title)
    if normalized_title == "":
        raise ValueError("present reference title must be nonblank")
    return (
        year_is_null,
        0 if year is None else -year,
        normalized_title is None,
        "" if normalized_title is None else normalized_title,
        _literature_id_text(related_literature_id),
    )


def encode_search_cursor(
    query: LibraryQuery,
    sort: LibrarySort,
    position: SearchCursorPosition,
) -> str:
    """Encode a canonical versioned search cursor without base64 padding."""

    if not isinstance(query, LibraryQuery):
        raise TypeError("query must be a LibraryQuery")
    validated_sort = _validate_sort(sort)
    position_payload = _search_position_payload(validated_sort, position)
    return _encode_cursor(
        _SEARCH_CURSOR_KIND,
        {
            "position": position_payload,
            "query_fingerprint": str(query_fingerprint(query)),
            "sort": validated_sort,
        },
    )


def decode_search_cursor(
    cursor: str,
    query: LibraryQuery,
    sort: LibrarySort,
) -> SearchCursorPosition:
    """Decode and strictly validate a cursor against query and sort semantics."""

    if not isinstance(query, LibraryQuery):
        raise TypeError("query must be a LibraryQuery")
    try:
        validated_sort = _validate_sort(sort)
        payload = _decode_cursor(cursor, _SEARCH_CURSOR_KIND)
        _require_exact_keys(payload, {"position", "query_fingerprint", "sort"})
        encoded_fingerprint = payload["query_fingerprint"]
        encoded_sort = payload["sort"]
        if type(encoded_fingerprint) is not str or type(encoded_sort) is not str:
            _raise_invalid_cursor()
        if encoded_fingerprint != str(query_fingerprint(query)) or encoded_sort != validated_sort:
            _raise_invalid_cursor()
        return _decode_search_position(validated_sort, payload["position"])
    except LiteratureCursorError:
        raise
    except Exception:
        raise LiteratureCursorError(_CURSOR_ERROR_MESSAGE) from None


def encode_reference_cursor(
    request: LiteratureReferenceRequest,
    position: ReferenceCursorPosition,
) -> str:
    """Encode a reference cursor bound to endpoint and direction, not limit."""

    if not isinstance(request, LiteratureReferenceRequest):
        raise TypeError("request must be a LiteratureReferenceRequest")
    direction = _validate_direction(request.direction)
    return _encode_cursor(
        _REFERENCE_CURSOR_KIND,
        {
            "direction": direction,
            "literature_id": str(request.literature_id),
            "position": _reference_position_payload(position),
        },
    )


def decode_reference_cursor(
    cursor: str,
    request: LiteratureReferenceRequest,
) -> ReferenceCursorPosition:
    """Decode and strictly validate a reference cursor's complete binding."""

    if not isinstance(request, LiteratureReferenceRequest):
        raise TypeError("request must be a LiteratureReferenceRequest")
    try:
        direction = _validate_direction(request.direction)
        payload = _decode_cursor(cursor, _REFERENCE_CURSOR_KIND)
        _require_exact_keys(payload, {"direction", "literature_id", "position"})
        encoded_direction = payload["direction"]
        encoded_literature_id = payload["literature_id"]
        if type(encoded_direction) is not str or type(encoded_literature_id) is not str:
            _raise_invalid_cursor()
        if encoded_direction != direction or encoded_literature_id != str(request.literature_id):
            _raise_invalid_cursor()
        return _decode_reference_position(payload["position"])
    except LiteratureCursorError:
        raise
    except Exception:
        raise LiteratureCursorError(_CURSOR_ERROR_MESSAGE) from None


def _optional_contains_key(value: str | None) -> str | None:
    return None if value is None else normalize_contains_text(value)


def _canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _encode_cursor(kind: str, payload: dict[str, object]) -> str:
    core: dict[str, object] = {
        "kind": kind,
        "payload": payload,
        "version": _CURSOR_VERSION,
    }
    envelope = {
        "checksum": hashlib.sha256(_canonical_json(core)).hexdigest(),
        **core,
    }
    return _base64url(_canonical_json(envelope))


def _reject_json_constant(_value: str) -> NoReturn:
    raise ValueError("non-finite JSON number")


def _decode_cursor(cursor: str, expected_kind: str) -> dict[str, object]:
    try:
        if type(cursor) is not str or not cursor or "=" in cursor:
            _raise_invalid_cursor()
        encoded = cursor.encode("ascii")
        padding = b"=" * (-len(encoded) % 4)
        raw = base64.b64decode(encoded + padding, altchars=b"-_", validate=True)
        if _base64url(raw) != cursor:
            _raise_invalid_cursor()
        decoded: Any = json.loads(
            raw.decode("utf-8"),
            parse_constant=_reject_json_constant,
        )
        if type(decoded) is not dict:
            _raise_invalid_cursor()
        envelope = cast(dict[str, object], decoded)
        if _canonical_json(envelope) != raw:
            _raise_invalid_cursor()
        _require_exact_keys(envelope, {"checksum", "kind", "payload", "version"})

        checksum = envelope["checksum"]
        kind = envelope["kind"]
        payload = envelope["payload"]
        version = envelope["version"]
        if (
            type(checksum) is not str
            or len(checksum) != 64
            or any(character not in "0123456789abcdef" for character in checksum)
            or type(kind) is not str
            or type(version) is not int
            or type(payload) is not dict
        ):
            _raise_invalid_cursor()
        if version != _CURSOR_VERSION or kind != expected_kind:
            _raise_invalid_cursor()
        core = {"kind": kind, "payload": payload, "version": version}
        if checksum != hashlib.sha256(_canonical_json(core)).hexdigest():
            _raise_invalid_cursor()
        return cast(dict[str, object], payload)
    except LiteratureCursorError:
        raise
    except (UnicodeError, ValueError, TypeError, binascii.Error):
        raise LiteratureCursorError(_CURSOR_ERROR_MESSAGE) from None


def _require_exact_keys(value: dict[str, object], keys: set[str]) -> None:
    if set(value) != keys:
        _raise_invalid_cursor()


def _validate_sort(sort: LibrarySort) -> LibrarySort:
    if type(sort) is not str or sort not in _SEARCH_SORTS:
        _raise_invalid_cursor()
    return cast(LibrarySort, sort)


def _validate_direction(direction: ReferenceDirection) -> ReferenceDirection:
    if type(direction) is not str or direction not in _REFERENCE_DIRECTIONS:
        _raise_invalid_cursor()
    return cast(ReferenceDirection, direction)


def _literature_id_text(value: LiteratureId) -> str:
    if not isinstance(value, LiteratureId):
        raise TypeError("literature_id must be a LiteratureId")
    return str(value)


def _decode_literature_id(value: object) -> LiteratureId:
    if type(value) is not str:
        _raise_invalid_cursor()
    try:
        return LiteratureId(value)
    except ValueError:
        _raise_invalid_cursor()


def _year_components(value: int | None) -> tuple[bool, int | None]:
    if value is None:
        return True, None
    if type(value) is not int or not 1 <= value <= 9999:
        raise ValueError("publication year must be an integer from 1 through 9999")
    return False, value


def _decode_year(value: object, is_null: object) -> int | None:
    if type(is_null) is not bool:
        _raise_invalid_cursor()
    if is_null:
        if value is not None:
            _raise_invalid_cursor()
        return None
    if type(value) is not int or not 1 <= value <= 9999:
        _raise_invalid_cursor()
    return value


def _normalized_title_components(value: str | None) -> tuple[bool, str | None]:
    if value is None:
        return True, None
    if type(value) is not str or not value or normalize_contains_text(value) != value:
        raise ValueError("normalized title must use the Literature query key")
    return False, value


def _decode_normalized_title(value: object, is_null: object) -> str | None:
    if type(is_null) is not bool:
        _raise_invalid_cursor()
    if is_null:
        if value is not None:
            _raise_invalid_cursor()
        return None
    if type(value) is not str or not value or normalize_contains_text(value) != value:
        _raise_invalid_cursor()
    return value


def _finite_relevance(value: float) -> float:
    if type(value) is not float or not math.isfinite(value):
        raise ValueError("relevance score must be a finite float")
    return value


def _search_position_payload(
    sort: LibrarySort,
    position: SearchCursorPosition,
) -> dict[str, object]:
    if not isinstance(position, SearchCursorPosition):
        raise TypeError("position must be a SearchCursorPosition")
    literature_id = _literature_id_text(position.literature_id)
    if sort in {"publication-year-desc", "publication-year-asc"}:
        if position.normalized_title is not None or position.relevance is not None:
            _raise_invalid_cursor()
        year_is_null, year = _year_components(position.publication_year)
        return {
            "literature_id": literature_id,
            "publication_year": year,
            "year_is_null": year_is_null,
        }
    if sort in {"title-asc", "title-desc"}:
        if position.publication_year is not None or position.relevance is not None:
            _raise_invalid_cursor()
        title_is_null, title = _normalized_title_components(position.normalized_title)
        return {
            "literature_id": literature_id,
            "normalized_title": title,
            "title_is_null": title_is_null,
        }
    if position.publication_year is not None or position.normalized_title is not None:
        _raise_invalid_cursor()
    return {
        "bm25": _finite_relevance(cast(float, position.relevance)),
        "literature_id": literature_id,
    }


def _decode_search_position(sort: LibrarySort, value: object) -> SearchCursorPosition:
    if type(value) is not dict:
        _raise_invalid_cursor()
    position = cast(dict[str, object], value)
    if sort in {"publication-year-desc", "publication-year-asc"}:
        _require_exact_keys(
            position,
            {"literature_id", "publication_year", "year_is_null"},
        )
        return SearchCursorPosition(
            literature_id=_decode_literature_id(position["literature_id"]),
            publication_year=_decode_year(
                position["publication_year"],
                position["year_is_null"],
            ),
        )
    if sort in {"title-asc", "title-desc"}:
        _require_exact_keys(
            position,
            {"literature_id", "normalized_title", "title_is_null"},
        )
        return SearchCursorPosition(
            literature_id=_decode_literature_id(position["literature_id"]),
            normalized_title=_decode_normalized_title(
                position["normalized_title"],
                position["title_is_null"],
            ),
        )
    _require_exact_keys(position, {"bm25", "literature_id"})
    score = position["bm25"]
    if type(score) is not float or not math.isfinite(score):
        _raise_invalid_cursor()
    return SearchCursorPosition(
        literature_id=_decode_literature_id(position["literature_id"]),
        relevance=score,
    )


def _reference_position_payload(position: ReferenceCursorPosition) -> dict[str, object]:
    if not isinstance(position, ReferenceCursorPosition):
        raise TypeError("position must be a ReferenceCursorPosition")
    year_is_null, year = _year_components(position.publication_year)
    title_is_null, title = _normalized_title_components(position.normalized_title)
    return {
        "normalized_title": title,
        "publication_year": year,
        "related_literature_id": _literature_id_text(position.related_literature_id),
        "title_is_null": title_is_null,
        "year_is_null": year_is_null,
    }


def _decode_reference_position(value: object) -> ReferenceCursorPosition:
    if type(value) is not dict:
        _raise_invalid_cursor()
    position = cast(dict[str, object], value)
    _require_exact_keys(
        position,
        {
            "normalized_title",
            "publication_year",
            "related_literature_id",
            "title_is_null",
            "year_is_null",
        },
    )
    return ReferenceCursorPosition(
        related_literature_id=_decode_literature_id(position["related_literature_id"]),
        publication_year=_decode_year(
            position["publication_year"],
            position["year_is_null"],
        ),
        normalized_title=_decode_normalized_title(
            position["normalized_title"],
            position["title_is_null"],
        ),
    )


def _raise_invalid_cursor() -> NoReturn:
    raise LiteratureCursorError(_CURSOR_ERROR_MESSAGE)


__all__ = (
    "LiteratureCursorError",
    "LiteratureQueryError",
    "ReferenceCursorPosition",
    "SearchCursorPosition",
    "decode_reference_cursor",
    "decode_search_cursor",
    "encode_reference_cursor",
    "encode_search_cursor",
    "first_missing_step",
    "fts5_index_text",
    "matches_all_requested_values",
    "matches_any_requested_value",
    "normalize_contains_text",
    "normalize_query_text",
    "normalized_contains",
    "query_fingerprint",
    "quoted_fts5_and_query",
    "reference_sort_key",
    "relevance_sort_key",
    "text_search_terms",
)
