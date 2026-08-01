import hashlib
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    CatalogDiagnosticService,
    CompletionFactsRepository,
    IdentityResolver,
    ProcessingRunRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.diagnostics import DiagnosticQuery
from sciretriever.diagnostics.owners import (
    AcquisitionFailureOwner,
    MetadataFailureOwner,
)
from sciretriever.diagnostics.product import (
    DiagnosticSubjectKind,
    ProductFailureAction,
    ProductFailureReason,
    ProductFailureStage,
)
from sciretriever.core.contracts import SearchSpec
from sciretriever.discovery import (
    MetadataSearchRequest,
    MetadataSearchService,
    ProviderRecord,
)
from sciretriever.errors import SearchError


SECRET = "OWNER-SENTINEL-SECRET"


class FixtureProvider:
    def __init__(
        self,
        name: str,
        records: tuple[ProviderRecord, ...] = (),
        *,
        fails: bool = False,
    ) -> None:
        self.name = name
        self._records = records
        self._fails = fails

    def search(self, spec: SearchSpec) -> tuple[ProviderRecord, ...]:
        del spec
        if self._fails:
            raise RuntimeError(f"provider failure {SECRET}")
        return self._records


class FailureOwnerWp6Tests(TestCase):
    def setUp(self) -> None:
        temporary = TemporaryDirectory(prefix="sciretriever-wp6-")
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "catalog.sqlite"
        self.catalog = create_catalog_engine(self.path)
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.diagnostics = CatalogDiagnosticService(self.catalog)

    def test_metadata_total_failure_uses_normalized_input_fingerprint_without_work(self) -> None:
        # Given
        owner = MetadataFailureOwner(self.diagnostics)
        normalized_doi = "10.1234/example"

        # When
        row = owner.provider_total_failure(
            normalized_doi,
            ("crossref", "openalex"),
            {"exception": RuntimeError(SECRET), "url": f"https://x.test/p?token={SECRET}"},
        )

        # Then
        expected = "sha256:" + hashlib.sha256(normalized_doi.encode("utf-8")).hexdigest()
        self.assertEqual(row.failure.subject_id, expected)
        self.assertEqual(row.failure.stage, ProductFailureStage.METADATA)
        self.assertEqual(row.failure.reason, ProductFailureReason.PROVIDER)
        self.assertEqual(row.failure.action, ProductFailureAction.RETRY)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 0)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM work_versions").scalar_one(), 0)

    def test_metadata_search_with_failed_and_successful_empty_provider_is_empty_success(self) -> None:
        # Given
        providers = {
            "failed": FixtureProvider("failed", fails=True),
            "empty": FixtureProvider("empty"),
        }
        request = MetadataSearchRequest("Query", ("failed", "empty"), ("failed", "empty"))

        # When
        output = MetadataSearchService(providers, WorkRepository(self.catalog)).search(request)

        # Then
        self.assertEqual(output.results, ())
        self.assertEqual(tuple(item.provider for item in output.failures), ("failed",))
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql("SELECT count(*) FROM diagnostic_records").scalar_one(),
                0,
            )

    def test_metadata_search_with_all_requested_providers_failed_writes_once_and_raises(self) -> None:
        # Given
        providers = {
            "first": FixtureProvider("first", fails=True),
            "second": FixtureProvider("second", fails=True),
        }
        request = MetadataSearchRequest("Query", ("first", "second"), ("first", "second"))

        # When / Then
        with self.assertRaisesRegex(SearchError, "all metadata search providers failed"):
            MetadataSearchService(providers, WorkRepository(self.catalog)).search(request)
        rows = self.diagnostics.query(DiagnosticQuery(stage=ProductFailureStage.METADATA))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0].details["providers"], ["first", "second"])
        self.assertNotIn(SECRET, repr(rows))
        self.assertNotIn(SECRET.encode("utf-8"), self.path.read_bytes())

    def test_metadata_search_partial_records_preserve_provider_failure_without_diagnostic(self) -> None:
        # Given
        providers = {
            "failed": FixtureProvider("failed", fails=True),
            "successful": FixtureProvider(
                "successful",
                (ProviderRecord("successful", 1, (("doi", "10.1234/partial"),), title="Partial"),),
            ),
        }
        request = MetadataSearchRequest(
            "Query", ("failed", "successful"), ("successful", "failed")
        )

        # When
        output = MetadataSearchService(providers, WorkRepository(self.catalog)).search(request)

        # Then
        self.assertEqual(len(output.results), 1)
        self.assertEqual(tuple(item.provider for item in output.failures), ("failed",))
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql("SELECT count(*) FROM diagnostic_records").scalar_one(),
                0,
            )

    def test_metadata_query_forms_share_normalized_fingerprint_history_identity(self) -> None:
        # Given
        service = MetadataSearchService(
            {"failed": FixtureProvider("failed", fails=True)},
            WorkRepository(self.catalog),
        )
        queries = ("Query", "  Query  ", "qUeRy")

        # When
        for query in queries:
            with self.assertRaises(SearchError):
                service.search(MetadataSearchRequest(query, ("failed",), ("failed",)))

        # Then
        expected_digest = hashlib.sha256(b"query").hexdigest()
        expected = "sha256:" + expected_digest
        rows = self.diagnostics.query(DiagnosticQuery(stage=ProductFailureStage.METADATA))
        self.assertEqual(len(rows), 3)
        self.assertEqual({row.failure.subject_id for row in rows}, {expected})
        with self.catalog.connect() as connection:
            fingerprints = tuple(connection.exec_driver_sql(
                "SELECT input_fingerprint FROM diagnostic_records ORDER BY occurred_at, id"
            ).scalars())
        self.assertEqual(fingerprints, (expected_digest, expected_digest, expected_digest))
        database_bytes = self.path.read_bytes()
        for query in queries:
            self.assertNotIn(query.encode("utf-8"), database_bytes)

    def test_acquisition_failure_is_workversion_owned_and_source_details_are_bounded(self) -> None:
        # Given
        version = WorkRepository(self.catalog).ingest_version(
            provider="fixture", provider_record_id="one", title="Asset", doi="10.1/asset"
        )
        owner = AcquisitionFailureOwner(self.diagnostics)
        facts = CompletionFactsRepository(self.catalog).get(version.id)
        sources = tuple(
            {"provider": f"source-{index}", "outcome": "failed", "body": SECRET}
            for index in range(100)
        )

        # When
        row = owner.exhausted(version.id, "primary_pdf", sources)

        # Then
        self.assertEqual(row.failure.subject_kind, DiagnosticSubjectKind.WORK_VERSION)
        self.assertEqual(row.failure.reason, ProductFailureReason.PROVIDER)
        self.assertEqual(row.failure.action, ProductFailureAction.TRY_ANOTHER_SOURCE)
        source_details = row.details["sources"]
        self.assertIsInstance(source_details, list)
        assert isinstance(source_details, list)
        self.assertLessEqual(len(source_details), 50)
        self.assertEqual(CompletionFactsRepository(self.catalog).get(version.id), facts)
        rendered = repr(self.diagnostics.query(DiagnosticQuery()))
        self.assertNotIn(SECRET, rendered)

    def test_parser_and_analysis_failures_use_processing_target_and_preserve_facts(self) -> None:
        # Given
        version = IdentityResolver(self.catalog).create_or_reuse_work(
            {"doi": "10.1/processing-owner"}
        ).work_version
        assert version is not None
        runs = ProcessingRunRepository(self.catalog)
        parser = runs.claim_or_resume(version.id, "parsing", "mineru", "3.4.4", {})
        analysis = runs.claim_or_resume(version.id, "analysis", "analysis", "1", {})
        facts = CompletionFactsRepository(self.catalog).get(version.id)

        # When
        runs.fail(parser.id, "remote_failed", f"parser {SECRET}", retryable=True)
        runs.fail(analysis.id, "analysis_failed", f"analysis {SECRET}")

        # Then
        rows = self.diagnostics.query(DiagnosticQuery(stage=ProductFailureStage.ANALYSIS))
        self.assertEqual({row.failure.subject_id for row in rows}, {parser.id, analysis.id})
        self.assertEqual({row.failure.subject_kind for row in rows}, {DiagnosticSubjectKind.PROCESSING_RUN})
        self.assertEqual({row.failure.reason for row in rows}, {ProductFailureReason.PROVIDER})
        self.assertEqual(CompletionFactsRepository(self.catalog).get(version.id), facts)
        self.assertNotIn(SECRET, repr(rows))

    def test_fresh_schema_and_public_catalog_api_have_no_retired_failure_surfaces(self) -> None:
        # Given / When
        with self.catalog.connect() as connection:
            tables = set(connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).scalars())
        import sciretriever.catalog as catalog
        from sciretriever.catalog import models, records, repository

        # Then
        retired = {"events", "failures", "acquisition_diagnostics"}
        self.assertTrue(retired.isdisjoint(tables))
        for module, names in (
            (models, retired),
            (records, {"EventRecord", "FailureRecord"}),
            (repository, {"_append_event", "_event_record", "_failure_record"}),
            (catalog, {"EventRecord", "FailureRecord"}),
        ):
            self.assertTrue(names.isdisjoint(vars(module)))


if __name__ == "__main__":
    import unittest

    unittest.main()
