from __future__ import annotations

import base64
import hashlib
import json
import math
import unittest
from typing import Any, cast

from sciretriever.literature.query import (
    LiteratureCursorError,
    ReferenceCursorPosition,
    SearchCursorPosition,
    decode_reference_cursor,
    decode_search_cursor,
    encode_reference_cursor,
    encode_search_cursor,
    fts5_index_text,
    matches_all_requested_values,
    matches_any_requested_value,
    normalize_contains_text,
    normalize_query_text,
    normalized_contains,
    query_fingerprint,
    quoted_fts5_and_query,
    reference_sort_key,
    relevance_sort_key,
    text_search_terms,
)
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySearchRequest,
    LibrarySort,
    LiteratureReferenceRequest,
)
from sciretriever.model.literature import Identifier, LiteratureStatus, VersionRole
from sciretriever.model.primitives import DiscoveryRunId, LiteratureId

_ID_1 = LiteratureId("123e4567-e89b-12d3-a456-426614174000")
_ID_2 = LiteratureId("223e4567-e89b-12d3-a456-426614174000")
_ID_3 = LiteratureId("323e4567-e89b-12d3-a456-426614174000")
_RUN_1 = DiscoveryRunId("423e4567-e89b-12d3-a456-426614174000")
_RUN_2 = DiscoveryRunId("523e4567-e89b-12d3-a456-426614174000")


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


def _cursor_envelope(cursor: str) -> dict[str, Any]:
    padding = b"=" * (-len(cursor) % 4)
    decoded = base64.b64decode(cursor.encode("ascii") + padding, altchars=b"-_", validate=True)
    value: Any = json.loads(decoded.decode("utf-8"))
    if not isinstance(value, dict):
        raise AssertionError("test cursor must contain an object")
    return cast(dict[str, Any], value)


def _resign(envelope: dict[str, Any]) -> str:
    core = {
        "kind": envelope["kind"],
        "payload": envelope["payload"],
        "version": envelope["version"],
    }
    envelope["checksum"] = hashlib.sha256(_canonical_json(core)).hexdigest()
    return _base64url(_canonical_json(envelope))


def _clone_envelope(cursor: str) -> dict[str, Any]:
    return cast(dict[str, Any], json.loads(json.dumps(_cursor_envelope(cursor))))


class QueryTextRuleTests(unittest.TestCase):
    def test_plain_text_normalization_uses_nfc_casefold_then_unicode_space_collapse(self) -> None:
        decomposed = "E\N{COMBINING ACUTE ACCENT}COLE"

        self.assertEqual(
            normalize_query_text(
                f" \N{EM SPACE}{decomposed}\tStra\N{LATIN SMALL LETTER SHARP S}e\n "
            ),
            "\N{LATIN SMALL LETTER E WITH ACUTE}cole strasse",
        )

    def test_terms_are_maximal_unicode_letters_or_numbers_and_operators_are_separators(
        self,
    ) -> None:
        self.assertEqual(
            text_search_terms(
                "Alpha OR beta; NOT NEAR(\N{GREEK CAPITAL LETTER GAMMA}_2026) AND x-y"
            ),
            ("alpha", "beta", "\N{GREEK SMALL LETTER GAMMA}", "2026", "x", "y"),
        )

    def test_index_and_query_share_casefold_tokens_including_combining_marks(self) -> None:
        display = (
            "Stra\N{LATIN SMALL LETTER SHARP S}e "
            "\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}STANBUL "
            "Cafe\N{COMBINING ACUTE ACCENT} "
            "\N{CJK UNIFIED IDEOGRAPH-6771}\N{CJK UNIFIED IDEOGRAPH-4EAC}"
        )

        self.assertEqual(
            fts5_index_text(display),
            "strasse i\N{COMBINING DOT ABOVE}stanbul "
            "caf\N{LATIN SMALL LETTER E WITH ACUTE} "
            "\N{CJK UNIFIED IDEOGRAPH-6771}\N{CJK UNIFIED IDEOGRAPH-4EAC}",
        )
        self.assertEqual(
            text_search_terms("\N{LATIN CAPITAL LETTER I WITH DOT ABOVE}STANBUL"),
            ("i\N{COMBINING DOT ABOVE}stanbul",),
        )
        self.assertEqual(fts5_index_text("Alpha alpha ALPHA"), "alpha alpha alpha")

    def test_safe_fts_query_quotes_every_term_and_never_executes_user_syntax(self) -> None:
        user_text = 'alpha" OR * beta); DROP TABLE literature;--'

        self.assertEqual(
            quoted_fts5_and_query(user_text),
            '"alpha" AND "beta" AND "drop" AND "table" AND "literature"',
        )

    def test_duplicate_terms_are_idempotent_and_punctuation_only_is_stable_no_match(self) -> None:
        self.assertEqual(text_search_terms("Alpha alpha ALPHA"), ("alpha",))
        self.assertEqual(text_search_terms('  -- "" () ***  '), ())
        self.assertIsNone(quoted_fts5_and_query('  -- "" () ***  '))

    def test_contains_normalization_preserves_punctuation_and_hyphens(self) -> None:
        value = "  Foo\N{NON-BREAKING HYPHEN}Bar,\tBAZ  "

        self.assertEqual(normalize_contains_text(value), "foo\N{NON-BREAKING HYPHEN}bar, baz")
        self.assertTrue(normalized_contains(value, " FOO\N{NON-BREAKING HYPHEN}BAR, "))
        self.assertFalse(normalized_contains(None, "foo"))
        self.assertFalse(normalized_contains("foo-bar", "foo bar"))

    def test_general_multi_value_filters_use_or_and_keywords_use_and(self) -> None:
        available = ("physics", "graph", "retrieval")

        self.assertTrue(matches_any_requested_value(available, ("biology", "graph")))
        self.assertFalse(matches_any_requested_value(available, ("biology", "chemistry")))
        self.assertTrue(matches_any_requested_value(available, ()))
        self.assertTrue(matches_all_requested_values(available, ("physics", "graph")))
        self.assertFalse(matches_all_requested_values(available, ("physics", "biology")))
        self.assertTrue(matches_all_requested_values(available, ()))


class QueryFingerprintTests(unittest.TestCase):
    def _query(self, *, reverse: bool) -> LibraryQuery:
        return LibraryQuery(
            text="BETA and alpha" if reverse else "Alpha beta alpha",
            title="  A\tSTUDY  " if reverse else "a study",
            author="Ada Lovelace",
            author_orcids=(
                ("0000-0001-5109-3700", "0000-0002-1825-0097")
                if reverse
                else ("0000-0002-1825-0097", "0000-0001-5109-3700")
            ),
            identifiers=(
                (
                    Identifier(namespace="pmid", value="123"),
                    Identifier(namespace="doi", value="10.1000/example"),
                )
                if reverse
                else (
                    Identifier(namespace="doi", value="10.1000/example"),
                    Identifier(namespace="pmid", value="123"),
                )
            ),
            publication_year_from=2020,
            publication_year_to=2026,
            venue="Journal-of-Tests",
            publisher="Example Press",
            document_types=("review", "article") if reverse else ("article", "review"),
            languages=("zh", "en") if reverse else ("en", "zh"),
            keywords=("retrieval", "graph") if reverse else ("graph", "retrieval"),
            version_roles=(
                (VersionRole.PREPRINT, VersionRole.PUBLISHED)
                if reverse
                else (VersionRole.PUBLISHED, VersionRole.PREPRINT)
            ),
            statuses=(
                (LiteratureStatus.ASSET_READY, LiteratureStatus.CONTENT_READY)
                if reverse
                else (LiteratureStatus.CONTENT_READY, LiteratureStatus.ASSET_READY)
            ),
            missing_steps=(
                ("parser-result", "primary-pdf") if reverse else ("primary-pdf", "parser-result")
            ),
            needs_manual_pdf=False,
            discovery_run_ids=(_RUN_2, _RUN_1) if reverse else (_RUN_1, _RUN_2),
        )

    def test_fingerprint_uses_query_semantics_not_caller_tuple_or_and_term_order(self) -> None:
        self.assertEqual(
            query_fingerprint(self._query(reverse=False)),
            query_fingerprint(self._query(reverse=True)),
        )

    def test_fingerprint_changes_when_matching_semantics_change(self) -> None:
        base = self._query(reverse=False)

        changed_keyword = base.model_copy(update={"keywords": ("graph",)})
        changed_contains = base.model_copy(update={"title": "another study"})
        punctuation_only = LibraryQuery(text="***")

        self.assertNotEqual(query_fingerprint(base), query_fingerprint(changed_keyword))
        self.assertNotEqual(query_fingerprint(base), query_fingerprint(changed_contains))
        self.assertNotEqual(query_fingerprint(punctuation_only), query_fingerprint(LibraryQuery()))

    def test_sort_limit_and_cursor_are_not_part_of_query_fingerprint(self) -> None:
        query = self._query(reverse=False)
        first = LibrarySearchRequest(query=query, sort="title-asc", limit=1)
        second = LibrarySearchRequest(query=query, sort="publication-year-desc", limit=500)

        self.assertEqual(query_fingerprint(first.query), query_fingerprint(second.query))


class SearchCursorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.query = LibraryQuery(text="Graph retrieval", keywords=("science", "data"))

    def test_all_search_sort_positions_round_trip_including_nulls(self) -> None:
        cases: tuple[tuple[LibrarySort, SearchCursorPosition], ...] = (
            (
                "publication-year-desc",
                SearchCursorPosition(literature_id=_ID_1, publication_year=2024),
            ),
            (
                "publication-year-asc",
                SearchCursorPosition(literature_id=_ID_1, publication_year=None),
            ),
            (
                "title-asc",
                SearchCursorPosition(literature_id=_ID_2, normalized_title="a-study"),
            ),
            (
                "title-desc",
                SearchCursorPosition(literature_id=_ID_2, normalized_title=None),
            ),
            (
                "relevance",
                SearchCursorPosition(literature_id=_ID_3, relevance=-0.75),
            ),
        )

        for sort, position in cases:
            with self.subTest(sort=sort, position=position):
                cursor = encode_search_cursor(self.query, sort, position)
                self.assertNotIn("=", cursor)
                self.assertEqual(decode_search_cursor(cursor, self.query, sort), position)

    def test_search_cursor_binds_semantic_query_and_sort_but_not_limit(self) -> None:
        first = LibrarySearchRequest(query=self.query, sort="title-asc", limit=1)
        later = LibrarySearchRequest(query=self.query, sort="title-asc", limit=200)
        position = SearchCursorPosition(literature_id=_ID_1, normalized_title="graph")
        cursor = encode_search_cursor(first.query, first.sort, position)

        self.assertEqual(decode_search_cursor(cursor, later.query, later.sort), position)
        with self.assertRaises(LiteratureCursorError):
            decode_search_cursor(cursor, LibraryQuery(text="different"), later.sort)
        with self.assertRaises(LiteratureCursorError):
            decode_search_cursor(cursor, later.query, "title-desc")

    def test_cursor_rejects_malformed_noncanonical_tampered_and_wrongly_typed_data(self) -> None:
        position = SearchCursorPosition(literature_id=_ID_1, publication_year=2024)
        cursor = encode_search_cursor(self.query, "publication-year-desc", position)

        invalid_cursors = ["%%%", "a", cursor + "=", _base64url(b"\xff")]

        bad_checksum = _clone_envelope(cursor)
        bad_checksum["checksum"] = "0" * 64
        invalid_cursors.append(_base64url(_canonical_json(bad_checksum)))

        wrong_version = _clone_envelope(cursor)
        wrong_version["version"] = 2
        invalid_cursors.append(_resign(wrong_version))

        wrong_kind = _clone_envelope(cursor)
        wrong_kind["kind"] = "literature-references"
        invalid_cursors.append(_resign(wrong_kind))

        extra_envelope_key = _clone_envelope(cursor)
        extra_envelope_key["extra"] = None
        invalid_cursors.append(_base64url(_canonical_json(extra_envelope_key)))

        missing_envelope_key = _clone_envelope(cursor)
        del missing_envelope_key["checksum"]
        invalid_cursors.append(_base64url(_canonical_json(missing_envelope_key)))

        extra_payload_key = _clone_envelope(cursor)
        cast(dict[str, Any], extra_payload_key["payload"])["limit"] = 50
        invalid_cursors.append(_resign(extra_payload_key))

        bool_year = _clone_envelope(cursor)
        bool_position = cast(dict[str, Any], cast(dict[str, Any], bool_year["payload"])["position"])
        bool_position["publication_year"] = True
        invalid_cursors.append(_resign(bool_year))

        wrong_position_for_sort = _clone_envelope(cursor)
        cast(dict[str, Any], wrong_position_for_sort["payload"])["sort"] = "title-asc"
        invalid_cursors.append(_resign(wrong_position_for_sort))

        noncanonical_json = json.dumps(
            _cursor_envelope(cursor),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        ).encode("utf-8")
        invalid_cursors.append(_base64url(noncanonical_json))

        nan_envelope = _clone_envelope(cursor)
        nan_position = cast(
            dict[str, Any], cast(dict[str, Any], nan_envelope["payload"])["position"]
        )
        nan_position["publication_year"] = math.nan
        invalid_cursors.append(
            _base64url(
                json.dumps(
                    nan_envelope,
                    allow_nan=True,
                    ensure_ascii=False,
                    separators=(",", ":"),
                    sort_keys=True,
                ).encode("utf-8")
            )
        )

        for invalid in invalid_cursors:
            with self.subTest(cursor=invalid[:24]):
                with self.assertRaisesRegex(
                    LiteratureCursorError,
                    "^literature query cursor is invalid$",
                ):
                    decode_search_cursor(invalid, self.query, "publication-year-desc")

    def test_relevance_order_is_lower_bm25_then_literature_id(self) -> None:
        values = (
            (relevance_sort_key(-0.5, _ID_2), "tie-later"),
            (relevance_sort_key(-1.0, _ID_3), "lower-score"),
            (relevance_sort_key(-0.5, _ID_1), "tie-earlier"),
        )

        self.assertEqual(
            tuple(label for _, label in sorted(values)),
            ("lower-score", "tie-earlier", "tie-later"),
        )


class ReferenceCursorTests(unittest.TestCase):
    def test_reference_cursor_binds_request_and_complete_stable_position_not_limit(self) -> None:
        first = LiteratureReferenceRequest(
            literature_id=_ID_1,
            direction="references",
            limit=1,
        )
        later = LiteratureReferenceRequest(
            literature_id=_ID_1,
            direction="references",
            limit=200,
        )
        position = ReferenceCursorPosition(
            related_literature_id=_ID_2,
            publication_year=None,
            normalized_title="a-title",
        )
        cursor = encode_reference_cursor(first, position)

        self.assertNotIn("=", cursor)
        self.assertEqual(decode_reference_cursor(cursor, later), position)

        with self.assertRaises(LiteratureCursorError):
            decode_reference_cursor(
                cursor,
                LiteratureReferenceRequest(literature_id=_ID_3, direction="references"),
            )
        with self.assertRaises(LiteratureCursorError):
            decode_reference_cursor(
                cursor,
                LiteratureReferenceRequest(literature_id=_ID_1, direction="cited-by"),
            )

    def test_reference_cursor_round_trips_title_null_and_rejects_inconsistent_null_flags(
        self,
    ) -> None:
        request = LiteratureReferenceRequest(literature_id=_ID_1, direction="cited-by")
        position = ReferenceCursorPosition(
            related_literature_id=_ID_2,
            publication_year=2026,
            normalized_title=None,
        )
        cursor = encode_reference_cursor(request, position)

        self.assertEqual(decode_reference_cursor(cursor, request), position)

        envelope = _clone_envelope(cursor)
        cursor_position = cast(
            dict[str, Any], cast(dict[str, Any], envelope["payload"])["position"]
        )
        cursor_position["year_is_null"] = True
        tampered = _resign(envelope)
        with self.assertRaises(LiteratureCursorError):
            decode_reference_cursor(tampered, request)

    def test_reference_order_is_year_desc_null_last_title_asc_null_last_then_id(self) -> None:
        values = (
            (reference_sort_key(None, "Alpha", _ID_1), "year-null"),
            (reference_sort_key(2025, None, _ID_1), "title-null"),
            (reference_sort_key(2026, "Zulu", _ID_3), "newer"),
            (reference_sort_key(2025, "beta", _ID_2), "title-b"),
            (reference_sort_key(2025, "Alpha", _ID_2), "id-later"),
            (reference_sort_key(2025, "alpha", _ID_1), "id-earlier"),
        )

        self.assertEqual(
            tuple(label for _, label in sorted(values)),
            ("newer", "id-earlier", "id-later", "title-b", "title-null", "year-null"),
        )


if __name__ == "__main__":
    unittest.main()
