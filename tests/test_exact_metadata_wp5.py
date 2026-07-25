from pathlib import Path
import ast
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import WorkRepository, create_catalog_engine, initialize_catalog
from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery import ProviderRecord
from sciretriever.discovery.search import ExactMetadataResolver
from sciretriever.discovery.search_contracts import ExactMetadataRequest


class FakeProvider:
    def __init__(self, name, records=(), *, error=None):
        self.name = name
        self.records = tuple(records)
        self.error = error
        self.specs = []

    def search(self, spec: SearchSpec):
        self.specs.append(spec)
        if self.error is not None:
            raise self.error
        return self.records


def record(
    provider,
    rank,
    title,
    doi=None,
    *,
    abstract=None,
    authors=(),
    year=None,
    venue=None,
    provider_record_id=None,
):
    identifiers = () if doi is None else (("doi", doi),)
    return ProviderRecord(
        provider,
        rank,
        identifiers,
        title=title,
        abstract=abstract,
        authors=tuple(authors),
        year=year,
        venue=venue,
        provider_record_id=provider_record_id,
    )


class ExactMetadataWp5Tests(TestCase):
    def setUp(self):
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.catalog = create_catalog_engine(
            Path(self.temporary_directory.name) / "catalog.sqlite"
        )
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.repository = WorkRepository(self.catalog)

    def counts(self, *tables):
        with self.catalog.connect() as connection:
            return tuple(
                connection.exec_driver_sql(
                    f'SELECT count(*) FROM "{table}"'
                ).scalar_one()
                for table in tables
            )

    def request(self, doi, providers, *, precedence=None):
        selected = tuple(providers)
        return ExactMetadataRequest(
            doi,
            selected,
            tuple(precedence or selected),
            provider_timeout_seconds=2,
            max_concurrency=4,
        )

    def test_doi_prefix_and_case_are_normalized_once_for_provider_query(self):
        provider = FakeProvider(
            "p", (record("p", 1, "Exact", "https://doi.org/10.1234/EXACT"),)
        )
        output = ExactMetadataResolver(
            {"p": provider}, self.repository
        ).resolve(self.request(" DOI:10.1234/Exact ", ("p",)))

        self.assertEqual(output.doi, "10.1234/exact")
        self.assertIsNotNone(output.result)
        self.assertEqual(provider.specs, [SearchSpec("10.1234/exact", ("p",), 100)])
        self.assertEqual(self.counts("works", "work_versions"), (1, 1))

    def test_invalid_doi_is_rejected_before_provider_or_catalog_access(self):
        with self.assertRaisesRegex(ValueError, "invalid DOI"):
            self.request("not-a-doi", ("p",))
        self.assertEqual(self.counts("works", "work_versions"), (0, 0))

    def test_only_exact_doi_records_survive_before_atomic_ingestion(self):
        providers = {
            "high": FakeProvider(
                "high",
                (
                    record("high", 1, "Exact title", "10.1234/target", abstract="preferred"),
                    record("high", 2, "Neighbor", "10.1234/neighbor"),
                ),
            ),
            "low": FakeProvider(
                "low",
                (
                    record("low", 1, "Exact fallback", "DOI:10.1234/TARGET", year=2026),
                    record("low", 2, "Missing DOI", year=2025),
                ),
            ),
        }
        output = ExactMetadataResolver(providers, self.repository).resolve(
            self.request(
                "10.1234/target", ("low", "high"), precedence=("high", "low")
            )
        )

        self.assertIsNotNone(output.result)
        assert output.result is not None
        self.assertEqual(
            (output.result.metadata.title, output.result.metadata.abstract, output.result.metadata.year),
            ("Exact title", "preferred", 2026),
        )
        self.assertEqual(output.result.providers, ("high", "low"))
        self.assertEqual(self.counts("works", "work_versions"), (1, 1))
        with self.catalog.connect() as connection:
            observed_dois = set(
                connection.exec_driver_sql(
                    "SELECT value_json FROM metadata_observations WHERE field_name = 'doi'"
                ).scalars()
            )
        self.assertEqual(observed_dois, {'"10.1234/target"'})

    def test_partial_provider_failure_keeps_exact_result_and_sanitizes_failure(self):
        secret = "token=do-not-expose"
        output = ExactMetadataResolver(
            {
                "good": FakeProvider("good", (record("good", 1, "Exact", "10.1234/x"),)),
                "bad": FakeProvider("bad", error=RuntimeError(secret)),
            },
            self.repository,
        ).resolve(self.request("10.1234/x", ("good", "bad")))

        self.assertIsNotNone(output.result)
        self.assertEqual(output.failures[0].message, "provider search failed")
        self.assertNotIn(secret, repr(output.failures))

    def test_all_provider_failure_returns_no_result_and_creates_no_rows(self):
        output = ExactMetadataResolver(
            {
                "a": FakeProvider("a", error=RuntimeError("a")),
                "b": FakeProvider("b", error=RuntimeError("b")),
            },
            self.repository,
        ).resolve(self.request("10.1234/missing", ("b", "a")))

        self.assertIsNone(output.result)
        self.assertEqual(tuple(item.provider for item in output.failures), ("a", "b"))
        self.assertEqual(
            self.counts("works", "work_versions", "metadata_observations"), (0, 0, 0)
        )

    def test_no_exact_result_including_valid_missing_doi_creates_no_rows(self):
        for index, records in enumerate(
            (
                (record("p", 1, "No DOI"),),
                (record("p", 1, "Neighbor", "10.1234/neighbor"),),
                (),
            )
        ):
            with self.subTest(index=index):
                output = ExactMetadataResolver(
                    {"p": FakeProvider("p", records)}, self.repository
                ).resolve(self.request("10.1234/target", ("p",)))
                self.assertIsNone(output.result)
                self.assertEqual(output.failures, ())
                self.assertEqual(
                    self.counts("works", "work_versions", "metadata_observations"),
                    (0, 0, 0),
                )

    def test_precedence_is_deterministic_and_replay_preserves_observation_counts(self):
        providers = {
            "high": FakeProvider(
                "high",
                (record("high", 2, "Preferred", "10.1234/replay", abstract="high"),),
            ),
            "low": FakeProvider(
                "low",
                (record("low", 1, "Fallback", "10.1234/replay", year=2024),),
            ),
        }
        resolver = ExactMetadataResolver(providers, self.repository)
        request = self.request(
            "10.1234/replay", ("low", "high"), precedence=("high", "low")
        )
        first = resolver.resolve(request)
        before = self.counts(
            "works", "work_versions", "metadata_observations", "provider_canonical_projections"
        )
        second = resolver.resolve(request)

        self.assertIsNotNone(first.result)
        self.assertIsNotNone(second.result)
        assert first.result is not None and second.result is not None
        self.assertEqual(first.result.work_version.id, second.result.work_version.id)
        self.assertEqual(first.result.metadata, second.result.metadata)
        self.assertEqual(
            (first.result.metadata.title, first.result.metadata.abstract, first.result.metadata.year),
            ("Preferred", "high", 2024),
        )
        self.assertEqual(
            self.counts(
                "works", "work_versions", "metadata_observations", "provider_canonical_projections"
            ),
            before,
        )

    def test_search_services_share_public_collaborators_with_bounded_modules(self):
        discovery = SRC / "sciretriever" / "discovery"
        search_path = discovery / "search.py"
        source = search_path.read_text(encoding="utf-8")
        pure_loc = sum(
            1
            for line in source.splitlines()
            if line.strip() and not line.lstrip().startswith("#")
        )
        self.assertLessEqual(pure_loc, 250)

        tree = ast.parse(source)
        exact_resolver = next(
            node
            for node in tree.body
            if isinstance(node, ast.ClassDef) and node.name == "ExactMetadataResolver"
        )
        private_cross_service = tuple(
            node.attr
            for node in ast.walk(exact_resolver)
            if isinstance(node, ast.Attribute)
            and node.attr.startswith("_")
            and isinstance(node.value, ast.Attribute)
            and node.value.attr.startswith("_")
        )
        self.assertEqual(private_cross_service, ())

        imported_names = {
            alias.name
            for node in tree.body
            if isinstance(node, ast.ImportFrom)
            for alias in node.names
        }
        self.assertTrue(
            {"ProviderCollector", "MetadataRecordPreparer", "MetadataIngestor"}
            <= imported_names
        )


if __name__ == "__main__":
    import unittest

    unittest.main()
