import importlib
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from dataclasses import FrozenInstanceError
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

catalog_api = importlib.import_module("sciretriever.catalog")
contracts = importlib.import_module("sciretriever.core.contracts")
sqlalchemy_exc = importlib.import_module("sqlalchemy.exc")
CatalogError = importlib.import_module("sciretriever.errors").CatalogError


class IdentityTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.path = Path(self.temporary_directory.name) / "catalog.sqlite"
        self.catalog = catalog_api.create_catalog_engine(self.path)
        self.addCleanup(self.catalog.dispose)
        catalog_api.apply_migrations(self.catalog)
        self.repository = catalog_api.CatalogRepository(self.catalog)
        self.resolver = catalog_api.IdentityResolver(self.repository)

    def counts(self) -> dict[str, int]:
        with self.catalog.connect() as connection:
            tables = tuple(
                row[0]
                for row in connection.exec_driver_sql(
                    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
                )
            )
            return {
                table: connection.exec_driver_sql(f'SELECT count(*) FROM "{table}"').scalar_one()
                for table in tables
            }

    def test_create_reuse_attach_alias_and_fill_only_missing_metadata(self) -> None:
        created = self.resolver.create_or_reuse_work(
            (contracts.Identifier(" DOI ", "https://doi.org/10.1000/EXAMPLE"),),
            {"title": "Original title"},
        )
        self.assertEqual(created.decision, "created")
        self.assertEqual(created.identifiers[0].value, "10.1000/example")
        self.assertIsNotNone(created.work)
        with self.assertRaises(FrozenInstanceError):
            created.work.title = "changed"

        reused = self.resolver.create_or_reuse_work(
            (
                contracts.Identifier("doi", "10.1000/example"),
                contracts.Identifier("pmid", "123"),
            ),
            {"title": "Replacement title", "abstract": "New abstract", "year": 2026},
        )
        self.assertEqual(reused.decision, "reused")
        self.assertEqual(reused.work.id, created.work.id)
        self.assertEqual(reused.work.title, "Original title")
        self.assertEqual(reused.work.abstract, "New abstract")
        self.assertEqual(reused.work.publication_year, 2026)
        self.assertEqual(self.repository.lookup_work(contracts.Identifier("pmid", "123")).id, created.work.id)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM identifiers").scalar_one(), 2)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM events").scalar_one(), 2)

    def test_ambiguity_creates_review_without_merge_alias_or_new_work(self) -> None:
        first = self.resolver.create_or_reuse_work({"doi": "10.1000/one"})
        second = self.resolver.create_or_reuse_work({"pmid": "200"})
        before = self.counts()

        result = self.resolver.create_or_reuse_work(
            {
                "doi": "10.1000/one",
                "pmid": "200",
                "arxiv": "2401.01234",
            },
            {"title": "Must not drive a merge"},
        )
        self.assertEqual(result.decision, "review_required")
        self.assertIsNone(result.work)
        self.assertEqual(result.review.state, "pending")
        self.assertEqual(
            json.loads(result.review.candidate_work_ids_json),
            sorted((first.work.id, second.work.id)),
        )
        self.assertEqual(
            result.review.identifiers_json,
            catalog_api.canonical_json(json.loads(result.review.identifiers_json)),
        )
        after = self.counts()
        self.assertEqual(after["works"], before["works"])
        self.assertEqual(after["identifiers"], before["identifiers"])
        self.assertEqual(after["identity_reviews"], before["identity_reviews"] + 1)
        self.assertEqual(after["events"], before["events"] + 1)

        repeated = self.resolver.create_or_reuse_work(
            {
                "arxiv": "2401.01234",
                "pmid": "200",
                "doi": "10.1000/one",
            }
        )
        self.assertEqual(repeated.review, result.review)
        repeated_counts = self.counts()
        for table in ("identity_reviews", "events", "works", "identifiers"):
            with self.subTest(table=table):
                self.assertEqual(repeated_counts[table], after[table])

    def test_threaded_same_doi_converges_to_one_work(self) -> None:
        def resolve(_: int):
            resolver = catalog_api.IdentityResolver(self.catalog)
            return resolver.create_or_reuse_work(
                (contracts.Identifier("doi", "https://doi.org/10.1000/CONCURRENT"),)
            )

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = tuple(executor.map(resolve, range(16)))
        self.assertEqual(len({result.work.id for result in results}), 1)
        self.assertEqual(sum(result.decision == "created" for result in results), 1)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM identifiers").scalar_one(), 1)

    def test_threaded_arxiv_url_and_prefix_forms_converge_to_one_work(self) -> None:
        forms = (
            "arXiv:2401.01234v2",
            "https://arxiv.org/abs/2401.01234v2?context=cs#record",
            "https://www.arxiv.org/pdf/2401.01234V2.pdf?download=1",
            "http://export.arxiv.org/abs/2401.01234v2",
        )

        def resolve(index: int):
            return catalog_api.IdentityResolver(self.catalog).create_or_reuse_work(
                (contracts.Identifier("arxiv", forms[index % len(forms)]),)
            )

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = tuple(executor.map(resolve, range(16)))
        self.assertEqual(len({result.work.id for result in results}), 1)
        self.assertEqual(sum(result.decision == "created" for result in results), 1)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM identifiers").scalar_one(), 1)
            value = connection.exec_driver_sql("SELECT value FROM identifiers").scalar_one()
        self.assertEqual(value, "2401.01234v2")

    def test_read_only_view_lookup_labels_and_row_counts_are_unchanged(self) -> None:
        resolution = self.resolver.create_or_reuse_work({"doi": "10.1000/read-only"})
        label = self.repository.add_metadata_label(
            resolution.work.id,
            "topic",
            "v1",
            "a" * 64,
            "retrieval",
        )
        before = self.counts()
        read_only_engine = catalog_api.open_read_only_catalog_engine(self.path)
        self.addCleanup(read_only_engine.dispose)
        view = catalog_api.ReadOnlyCatalogView(read_only_engine)
        self.assertEqual(view.lookup_work(contracts.Identifier("doi", "10.1000/read-only")), resolution.work)
        self.assertEqual(
            view.get_reusable_metadata_labels(resolution.work.id, "topic", "v1", "a" * 64),
            (label,),
        )
        for method in ("add_metadata_label", "append_event", "append_failure", "create_or_reuse_work"):
            self.assertFalse(hasattr(view, method))
        self.assertEqual(self.counts(), before)
        with self.assertRaises(CatalogError):
            catalog_api.ReadOnlyCatalogView(self.catalog)

    def test_integrity_error_is_translated_with_root_cause(self) -> None:
        with self.assertRaises(CatalogError) as caught:
            self.repository.add_metadata_label(
                "00000000-0000-4000-8000-000000000000",
                "topic",
                "v1",
                "b" * 64,
                "missing work",
            )
        self.assertIsInstance(caught.exception.__cause__, sqlalchemy_exc.IntegrityError)


if __name__ == "__main__":
    import unittest

    unittest.main()
