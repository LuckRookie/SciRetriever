from __future__ import annotations

from itertools import permutations
import unittest

from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery import (
    CandidatePreparer,
    CandidateRetrievalRequest,
    ProviderFailure,
)
from sciretriever.discovery.models import ProviderRecord


def record(
    provider: str,
    rank: int,
    title: str | None,
    *identifiers: tuple[str, str],
    abstract: str | None = None,
    publisher: str | None = None,
    publication_date: str | None = None,
    open_access_status: str | None = None,
    provider_record_id: str | None = None,
) -> ProviderRecord:
    return ProviderRecord(
        provider,
        rank,
        identifiers,
        title=title,
        abstract=abstract,
        publisher=publisher,
        publication_date=publication_date,
        open_access_status=open_access_status,
        provider_record_id=provider_record_id,
    )


class CandidateRetrievalTests(unittest.TestCase):
    def request(self, limit: int = 1000) -> CandidateRetrievalRequest:
        return CandidateRetrievalRequest(
            SearchSpec("battery", ("crossref", "europe-pmc", "arxiv"), limit),
            ("crossref", "europe-pmc", "arxiv"),
            provider_timeout_seconds=3.0,
            max_concurrency=2,
        )

    def test_precedence_preserves_observations_and_failure(self) -> None:
        records = (
            record(
                "europe-pmc", 1, "Fallback title", ("doi", "10.1234/shared"),
                ("pmid", "42"), abstract="Fallback abstract",
                publisher="Fallback press", publication_date="2024-02-03",
                open_access_status="open", provider_record_id="EPMC-1",
            ),
            record(
                "crossref", 1, "Canonical title", ("doi", "10.1234/shared"),
                publisher="Canonical press", provider_record_id="CR-1",
            ),
        )
        failure = ProviderFailure("arxiv", "provider_error", "provider search failed")

        result = CandidatePreparer().prepare(self.request(), records, (failure,))

        self.assertEqual(len(result.candidates), 1)
        candidate = result.candidates[0]
        self.assertEqual(candidate.metadata.title, "Canonical title")
        self.assertEqual(candidate.metadata.abstract, "Fallback abstract")
        self.assertEqual(candidate.publisher, "Canonical press")
        self.assertEqual(candidate.publication_date, "2024-02-03")
        self.assertEqual(candidate.open_access_status, "open")
        self.assertEqual(candidate.providers, ("crossref", "europe-pmc"))
        self.assertEqual(candidate.source_ranks, (("crossref", 1), ("europe-pmc", 1)))
        self.assertEqual(
            tuple(observation.provider_record_id for observation in candidate.observations),
            ("CR-1", "EPMC-1"),
        )
        self.assertEqual(result.failures, (failure,))

    def test_distinct_dois_keep_natural_observations_and_drop_bridge_alias(self) -> None:
        records = (
            record("crossref", 1, "Alpha", ("doi", "10.1234/a"), ("pmid", "42"),
                   provider_record_id="A"),
            record("europe-pmc", 1, "Beta", ("doi", "10.1234/b"), ("pmid", "42"),
                   provider_record_id="B"),
        )

        result = CandidatePreparer().prepare(self.request(), records)

        self.assertEqual(len(result.candidates), 2)
        by_doi = {
            next(identifier.value for identifier in candidate.identifiers
                 if identifier.namespace == "doi"): candidate
            for candidate in result.candidates
        }
        self.assertEqual(tuple(item.provider_record_id for item in by_doi["10.1234/a"].observations), ("A",))
        self.assertEqual(tuple(item.provider_record_id for item in by_doi["10.1234/b"].observations), ("B",))
        self.assertTrue(all(
            all(identifier.namespace != "pmid" for identifier in candidate.identifiers)
            for candidate in result.candidates
        ))
        self.assertTrue(all(
            candidate.identity_ambiguity_reasons == ("conflicting DOI bridge evidence",)
            for candidate in result.candidates
        ))

    def test_standalone_ambiguous_evidence_keeps_its_own_observation(self) -> None:
        records = (
            record("crossref", 1, "Alpha", ("doi", "10.1234/a"), ("pmid", "42")),
            record("europe-pmc", 1, "Beta", ("doi", "10.1234/b"), ("pmid", "42")),
            record("arxiv", 1, "Unassigned evidence", ("pmid", "42"),
                   provider_record_id="standalone"),
        )

        result = CandidatePreparer().prepare(self.request(), records)

        owner = next(
            candidate for candidate in result.candidates
            if candidate.observations[0].provider_record_id == "standalone"
        )
        self.assertEqual(tuple(item.provider_record_id for item in owner.observations), ("standalone",))
        self.assertEqual(owner.identifiers, ())

    def test_observation_with_distinct_dois_is_omitted_without_losing_sibling(self) -> None:
        records = (
            record(
                "crossref", 1, "Unsafe", ("doi", "10.1234/a"),
                ("doi", "10.1234/b"), ("pmid", "42"),
                provider_record_id="unsafe",
            ),
            record(
                "europe-pmc", 1, "Valid", ("doi", "10.1234/valid"),
                ("pmid", "42"), provider_record_id="valid",
            ),
        )

        result = CandidatePreparer().prepare(self.request(), records)

        self.assertEqual(len(result.candidates), 1)
        candidate = result.candidates[0]
        self.assertEqual(candidate.metadata.title, "Valid")
        self.assertEqual(
            tuple(identifier.value for identifier in candidate.identifiers),
            ("10.1234/valid", "42"),
        )
        self.assertEqual(
            tuple(item.provider_record_id for item in candidate.observations),
            ("valid",),
        )

    def test_exact_preparation_omits_observation_with_distinct_dois(self) -> None:
        records = (
            record(
                "crossref", 1, "Unsafe", ("doi", "10.1234/a"),
                ("doi", "10.1234/b"), provider_record_id="unsafe",
            ),
        )

        candidate = CandidatePreparer().prepare_exact(
            records, "10.1234/a", ("crossref",),
        )

        self.assertIsNone(candidate)

    def test_permutations_are_equal_and_titleless_group_is_omitted(self) -> None:
        values = (
            record("europe-pmc", 2, "Fallback", ("doi", "10.1234/stable"), abstract="A"),
            record("crossref", 1, "Canonical", ("doi", "10.1234/stable")),
            record("arxiv", 1, None, ("arxiv", "titleless")),
        )
        request = self.request(limit=1)

        results = {
            CandidatePreparer().prepare(request, ordering).candidates
            for ordering in permutations(values)
        }

        self.assertEqual(len(results), 1)
        candidates = results.pop()
        self.assertEqual(len(candidates), 1)
        self.assertEqual(candidates[0].metadata.title, "Canonical")

    def test_request_rejects_precedence_not_matching_sources(self) -> None:
        with self.assertRaisesRegex(ValueError, "precedence"):
            CandidateRetrievalRequest(
                SearchSpec("query", ("crossref", "arxiv"), 10),
                ("crossref",),
            )


if __name__ == "__main__":
    unittest.main()
