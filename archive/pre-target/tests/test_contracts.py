import importlib
import json
import sys
from dataclasses import FrozenInstanceError, fields
from pathlib import Path
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

contracts = importlib.import_module("sciretriever.core.contracts")
IDENTIFIER_NAMESPACE_ARXIV = contracts.IDENTIFIER_NAMESPACE_ARXIV
IDENTIFIER_NAMESPACE_DOI = contracts.IDENTIFIER_NAMESPACE_DOI
IDENTIFIER_NAMESPACE_OPENALEX = contracts.IDENTIFIER_NAMESPACE_OPENALEX
IDENTIFIER_NAMESPACE_PMID = contracts.IDENTIFIER_NAMESPACE_PMID
IDENTIFIER_NAMESPACE_S2 = contracts.IDENTIFIER_NAMESPACE_S2
IDENTIFIER_NAMESPACE_URL = contracts.IDENTIFIER_NAMESPACE_URL
MANIFEST_ENTRY_SCHEMA_VERSION = contracts.MANIFEST_ENTRY_SCHEMA_VERSION
CandidateMetadata = contracts.CandidateMetadata
DownloadManifestEntry = contracts.DownloadManifestEntry
Identifier = contracts.Identifier
Provenance = contracts.Provenance
SearchSpec = contracts.SearchSpec


class ContractTests(TestCase):
    def provenance(self, providers: tuple[str, ...] = ("crossref",)) -> Provenance:
        return Provenance(
            providers=providers,
            retrieved_at="2026-07-20T12:00:00Z",
            intake_run_id="intake-001",
        )

    def entry(self) -> DownloadManifestEntry:
        return DownloadManifestEntry(
            identifiers=(Identifier(IDENTIFIER_NAMESPACE_DOI, "10.1000/example"),),
            metadata=CandidateMetadata(
                title="A neutral paper",
                abstract=None,
                authors=("Ada Lovelace",),
                year=2026,
                venue="Example Journal",
                keywords=("literature retrieval",),
            ),
            labels=("candidate",),
            missing_abstract=True,
            needs_review=True,
            review_reason="Abstract unavailable",
            provenance=self.provenance(),
        )

    def test_contracts_are_frozen_and_hashable(self) -> None:
        identifier = Identifier(IDENTIFIER_NAMESPACE_PMID, "123")
        metadata = CandidateMetadata(title="Title")
        provenance = self.provenance()
        entry = self.entry()
        search = SearchSpec("query", ("crossref",), 10)

        for contract in (identifier, metadata, provenance, entry, search):
            with self.subTest(contract=type(contract).__name__):
                hash(contract)
                with self.assertRaises((FrozenInstanceError, TypeError)):
                    setattr(contract, "unexpected", "change")

    def test_identifier_namespaces_are_strings_and_extensible(self) -> None:
        namespaces = (
            IDENTIFIER_NAMESPACE_DOI,
            IDENTIFIER_NAMESPACE_ARXIV,
            IDENTIFIER_NAMESPACE_PMID,
            IDENTIFIER_NAMESPACE_URL,
            IDENTIFIER_NAMESPACE_OPENALEX,
            IDENTIFIER_NAMESPACE_S2,
        )
        self.assertEqual(namespaces, ("doi", "arxiv", "pmid", "url", "openalex", "s2"))
        self.assertEqual(Identifier("custom-registry", "ABC-123").namespace, "custom-registry")

    def test_whitespace_doi_and_arxiv_are_normalized(self) -> None:
        metadata = CandidateMetadata(
            title="  A   spaced\n title ",
            abstract=" First\tabstract. ",
            authors=("  Ada   Lovelace ",),
            venue=" Example   Journal ",
            keywords=(" key   phrase ",),
        )
        self.assertEqual(metadata.title, "A spaced title")
        self.assertEqual(metadata.abstract, "First abstract.")
        self.assertEqual(metadata.authors, ("Ada Lovelace",))
        self.assertEqual(metadata.venue, "Example Journal")
        self.assertEqual(metadata.keywords, ("key phrase",))
        self.assertEqual(
            Identifier(" DOI ", " HTTPS://DOI.ORG/10.1000/Example "),
            Identifier(IDENTIFIER_NAMESPACE_DOI, "10.1000/example"),
        )
        self.assertEqual(
            Identifier(IDENTIFIER_NAMESPACE_ARXIV, " arXiv: 2401.01234v2 ").value,
            "2401.01234v2",
        )

    def test_arxiv_prefix_url_pdf_and_old_style_forms_are_canonical(self) -> None:
        canonical = "2401.01234v2"
        equivalent = (
            "arXiv:2401.01234v2",
            "https://arxiv.org/abs/2401.01234v2",
            "https://www.arxiv.org/abs/2401.01234V2?context=cs#record",
            "https://arxiv.org/pdf/2401.01234v2.pdf?download=1#page=1",
            "http://export.arxiv.org/pdf/2401.01234V2.PDF",
        )
        self.assertEqual(
            {Identifier(IDENTIFIER_NAMESPACE_ARXIV, value).value for value in equivalent},
            {canonical},
        )
        self.assertEqual(
            Identifier(IDENTIFIER_NAMESPACE_ARXIV, "arXiv:HEP-TH/9901001V2").value,
            "hep-th/9901001v2",
        )
        self.assertEqual(
            Identifier(
                IDENTIFIER_NAMESPACE_ARXIV,
                "https://export.arxiv.org/abs/HEP-TH/9901001V2?source=legacy",
            ).value,
            "hep-th/9901001v2",
        )

    def test_title_only_and_identifier_only_entries_are_valid(self) -> None:
        title_only = DownloadManifestEntry(
            identifiers=(),
            metadata=CandidateMetadata(title="Title only"),
            labels=(),
            missing_abstract=True,
            needs_review=False,
            review_reason=None,
            provenance=self.provenance(),
        )
        identifier_only = DownloadManifestEntry(
            identifiers=(Identifier(IDENTIFIER_NAMESPACE_DOI, "10.1000/id-only"),),
            metadata=CandidateMetadata(),
            labels=(),
            missing_abstract=True,
            needs_review=False,
            review_reason=None,
            provenance=self.provenance(),
        )
        self.assertEqual(title_only.metadata.title, "Title only")
        self.assertIsNone(identifier_only.metadata.title)

    def test_entry_requires_title_or_identifier_but_not_doi_or_abstract(self) -> None:
        with self.assertRaisesRegex(ValueError, "title or at least one identifier"):
            DownloadManifestEntry(
                identifiers=(),
                metadata=CandidateMetadata(),
                labels=(),
                missing_abstract=True,
                needs_review=False,
                review_reason=None,
                provenance=self.provenance(),
            )
        valid_without_doi = DownloadManifestEntry(
            identifiers=(Identifier(IDENTIFIER_NAMESPACE_PMID, "123"),),
            metadata=CandidateMetadata(),
            labels=(),
            missing_abstract=True,
            needs_review=False,
            review_reason=None,
            provenance=self.provenance(),
        )
        self.assertIsNone(valid_without_doi.metadata.abstract)

    def test_missing_abstract_must_match_metadata(self) -> None:
        common = {
            "identifiers": (Identifier(IDENTIFIER_NAMESPACE_PMID, "123"),),
            "labels": (),
            "needs_review": False,
            "review_reason": None,
            "provenance": self.provenance(),
        }
        with self.assertRaisesRegex(ValueError, "missing_abstract must match"):
            DownloadManifestEntry(
                metadata=CandidateMetadata(abstract=None),
                missing_abstract=False,
                **common,
            )
        with self.assertRaisesRegex(ValueError, "missing_abstract must match"):
            DownloadManifestEntry(
                metadata=CandidateMetadata(abstract="Available abstract"),
                missing_abstract=True,
                **common,
            )

    def test_missing_abstract_and_review_fields_round_trip(self) -> None:
        entry = self.entry()
        self.assertEqual(DownloadManifestEntry.from_dict(entry.to_dict()), entry)
        decoded = DownloadManifestEntry.from_json_line(entry.to_json_line())
        self.assertEqual(decoded, entry)
        self.assertTrue(decoded.missing_abstract)
        self.assertTrue(decoded.needs_review)
        self.assertEqual(decoded.review_reason, "Abstract unavailable")
        self.assertEqual(decoded.schema_version, MANIFEST_ENTRY_SCHEMA_VERSION)

    def test_json_output_is_deterministic_compact_and_one_object_line(self) -> None:
        entry = self.entry()
        first = entry.to_json_line()
        second = DownloadManifestEntry.from_dict(entry.to_dict()).to_json_line()
        self.assertEqual(first, second)
        self.assertNotIn("\n", first)
        self.assertNotIn("\r", first)
        self.assertNotIn(": ", first)
        self.assertIsInstance(json.loads(first), dict)
        self.assertEqual(DownloadManifestEntry.from_json_line(first + "\n"), entry)
        self.assertEqual(DownloadManifestEntry.from_json_line(first + "\r\n"), entry)
        with self.assertRaises(TypeError):
            DownloadManifestEntry.from_json_line("[]")
        invalid_lines = (
            "",
            " \t",
            "\n",
            first[:1] + "\n" + first[1:],
            first + "\n" + first,
            first + "\n\n",
            first + first,
        )
        for line in invalid_lines:
            with self.subTest(line=line), self.assertRaises(ValueError):
                DownloadManifestEntry.from_json_line(line)

    def test_invalid_dict_shapes_are_rejected(self) -> None:
        with self.assertRaises(ValueError):
            Identifier.from_dict({"namespace": "doi", "value": "10.1/x", "extra": True})
        with self.assertRaises(TypeError):
            CandidateMetadata.from_dict(
                {
                    "title": "Title",
                    "abstract": None,
                    "authors": "Ada",
                    "year": None,
                    "venue": None,
                    "keywords": [],
                }
            )
        data = self.entry().to_dict()
        data["needs_review"] = "yes"
        with self.assertRaises(TypeError):
            DownloadManifestEntry.from_dict(data)

    def test_duplicate_json_object_keys_are_rejected_at_every_level(self) -> None:
        duplicate_top_level = (
            '{"query":"first","query":"second","sources":["openalex"],'
            '"limit":1,"filters":{}}'
        )
        with self.assertRaisesRegex(ValueError, "duplicate JSON object key: 'query'"):
            SearchSpec.from_json_line(duplicate_top_level)

        manifest_line = self.entry().to_json_line()
        duplicate_nested = manifest_line.replace(
            '"metadata":{',
            '"metadata":{"abstract":"duplicate",',
            1,
        )
        with self.assertRaisesRegex(ValueError, "duplicate JSON object key: 'abstract'"):
            DownloadManifestEntry.from_json_line(duplicate_nested + "\r\n")

    def test_provider_names_are_extensible(self) -> None:
        provenance = self.provenance(("custom-provider", "provider-v2"))
        self.assertEqual(provenance.providers, ("custom-provider", "provider-v2"))
        self.assertEqual(Provenance.from_dict(provenance.to_dict()), provenance)
        with self.assertRaisesRegex(ValueError, "providers must not be empty"):
            self.provenance(())

    def test_search_spec_validation_and_round_trip(self) -> None:
        spec = SearchSpec(
            query="  battery   interfaces ",
            sources=(" openalex ", "custom-source"),
            limit=25,
            filters=((" year_from ", " 2020 "), ("venue", " Test  Journal ")),
        )
        self.assertEqual(spec.query, "battery interfaces")
        self.assertEqual(spec.sources, ("openalex", "custom-source"))
        self.assertEqual(spec.filters, (("venue", "Test Journal"), ("year_from", "2020")))
        self.assertEqual(SearchSpec.from_dict(spec.to_dict()), spec)
        self.assertEqual(SearchSpec.from_json_line(spec.to_json_line()), spec)
        self.assertNotIn("\n", spec.to_json_line())

        invalid_specs = (
            (" ", ("openalex",), 1, ()),
            ("query", (), 1, ()),
            ("query", ("openalex",), 0, ()),
            ("query", ("openalex",), 1, (("year", "2020"), ("year", "2021"))),
        )
        for query, sources, limit, filters_ in invalid_specs:
            with self.subTest(query=query, sources=sources, limit=limit, filters=filters_):
                with self.assertRaises(ValueError):
                    SearchSpec(query, sources, limit, filters_)
        with self.assertRaises(TypeError):
            SearchSpec("query", ("openalex",), True)

    def test_candidate_metadata_has_only_neutral_fields(self) -> None:
        self.assertEqual(
            {field_.name for field_ in fields(CandidateMetadata)},
            {"title", "abstract", "authors", "year", "venue", "keywords"},
        )
        forbidden = {"reaction", "molecule", "route", "yield", "confidence", "priority", "score"}
        for contract in (Identifier, CandidateMetadata, Provenance, DownloadManifestEntry, SearchSpec):
            with self.subTest(contract=contract.__name__):
                self.assertTrue(forbidden.isdisjoint(field_.name for field_ in fields(contract)))


if __name__ == "__main__":
    import unittest

    unittest.main()
