import importlib
import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import IsolatedAsyncioTestCase, TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    IdentityResolver,
    ReferenceRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.catalog.models import version_references
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.core.contracts import CandidateMetadata, Identifier
from sciretriever.discovery.search_contracts import (
    ExactMetadataOutput,
    ExactMetadataRequest,
    MetadataSearchResult,
)
from sciretriever.integrations.graph import (
    CitationEdge,
    GraphIdentifier,
    GraphIdentifierNamespace,
)


references_api = importlib.import_module("sciretriever.references")


class ExactMetadataFixture:
    def __init__(self, catalog: CatalogEngine) -> None:
        self.catalog = catalog
        self.enabled = False
        self.calls = 0

    def resolve(self, request: ExactMetadataRequest) -> ExactMetadataOutput:
        self.calls += 1
        if not self.enabled:
            return ExactMetadataOutput(request.doi, None, ())
        version = WorkRepository(self.catalog).ingest_version(
            provider="metadata-fixture",
            provider_record_id=request.doi,
            title="Resolved target",
            doi=request.doi,
        )
        result = MetadataSearchResult(
            version,
            ("metadata-fixture",),
            (Identifier("doi", request.doi),),
            CandidateMetadata(title="Resolved target"),
        )
        return ExactMetadataOutput(request.doi, result, ())


class ReferenceResolutionCharacterizationTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-reference-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(
            Path(self.temporary.name) / "catalog.sqlite",
            allow_repository_write=True,
        )
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)

    def test_stored_reference_preserves_raw_order_and_evidence(self) -> None:
        # Given
        source = WorkRepository(self.catalog).ingest_version(
            provider="fixture",
            provider_record_id="source",
            title="Source",
            doi="10.1000/source",
        )
        raw_reference = "  A. Author\tTitle. DOI:10.1000/TARGET\n"
        locator = {"page": 7, "span": [101, 149]}

        # When
        stored = ReferenceRepository(self.catalog).add(
            source.id,
            17,
            raw_reference,
            identifier=Identifier("doi", "10.1000/target"),
            locator=locator,
        )

        # Then
        with self.catalog.connect() as connection:
            row = connection.execute(
                version_references.select().where(
                    version_references.c.id == stored.id
                )
            ).mappings().one()
        self.assertEqual(row["raw_reference"], raw_reference)
        self.assertEqual(row["reference_order"], 17)
        self.assertEqual(row["locator_json"], '{"page":7,"span":[101,149]}')
        self.assertIsNone(row["cited_work_id"])

    def test_exact_doi_identity_reuses_one_work(self) -> None:
        # Given
        resolver = IdentityResolver(self.catalog)
        created = resolver.create_or_reuse_work(
            (Identifier("doi", "https://doi.org/10.1000/EXACT"),),
            {"title": "Exact target"},
        )

        # When
        reused = resolver.create_or_reuse_work(
            (Identifier("doi", "doi:10.1000/exact"),),
            {"title": "Different provider title"},
        )

        # Then
        self.assertEqual(reused.decision, "reused")
        self.assertEqual(reused.work.id, created.work.id)
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(),
                1,
            )


class ReferenceResolutionServiceTests(IsolatedAsyncioTestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-reference-service-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(
            Path(self.temporary.name) / "catalog.sqlite",
            allow_repository_write=True,
        )
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.source = WorkRepository(self.catalog).ingest_version(
            provider="fixture",
            provider_record_id="source",
            title="Source",
            doi="10.1000/source",
        )
        self.metadata = ExactMetadataFixture(self.catalog)

    def service(self):
        policy = references_api.ReferenceResolutionPolicy(
            providers=("metadata-fixture",),
            precedence=("metadata-fixture",),
        )
        return references_api.ReferenceResolutionService(
            self.catalog, self.metadata, policy
        )

    def test_unresolved_reference_retries_then_resolves_once_without_mutating_evidence(self) -> None:
        # Given
        raw = "  Exact target. DOI:10.1000/RETRY\n"
        stored = ReferenceRepository(self.catalog).add(
            self.source.id,
            3,
            raw,
            identifier=Identifier("doi", "10.1000/retry"),
            locator={"page": 2, "span": [4, 18]},
        )

        # When
        first = self.service().resolve_stored(self.source.id)
        self.metadata.enabled = True
        second = self.service().resolve_stored(self.source.id)
        third = self.service().resolve_stored(self.source.id)

        # Then
        self.assertEqual((first.resolved, first.unresolved), (0, 1))
        self.assertEqual((second.resolved, second.unresolved), (1, 0))
        self.assertEqual((third.resolved, third.unresolved), (0, 0))
        with self.catalog.connect() as connection:
            row = connection.execute(
                version_references.select().where(version_references.c.id == stored.id)
            ).mappings().one()
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 2)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM version_references").scalar_one(), 1)
        self.assertEqual(row["raw_reference"], raw)
        self.assertEqual(row["reference_order"], 3)
        self.assertEqual(row["locator_json"], '{"page":2,"span":[4,18]}')

    def test_conflicting_stable_identifiers_remain_unresolved_with_diagnostic(self) -> None:
        # Given
        ReferenceRepository(self.catalog).add(
            self.source.id,
            0,
            "Conflicting DOI values 10.1000/one and 10.1000/two",
            identifier=Identifier("doi", "10.1000/one"),
        )

        # When
        result = self.service().resolve_stored(self.source.id)

        # Then
        self.assertEqual((result.resolved, result.conflicts), (0, 1))
        with self.catalog.connect() as connection:
            self.assertIsNone(connection.exec_driver_sql(
                "SELECT cited_work_id FROM version_references"
            ).scalar_one())
            diagnostic = connection.exec_driver_sql(
                "SELECT reason,action,retryable,details_json FROM diagnostic_records"
            ).one()
        self.assertEqual(diagnostic[:3], ("identity", "review", 0))
        self.assertNotIn("Conflicting DOI values", diagnostic[3])

    def test_missing_stable_identifier_stays_retryable_without_placeholder(self) -> None:
        # Given
        ReferenceRepository(self.catalog).add(
            self.source.id,
            0,
            "Citation without a stable public identifier",
        )

        # When
        result = self.service().resolve_stored(self.source.id)

        # Then
        self.assertEqual((result.resolved, result.unresolved), (0, 1))
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(),
                1,
            )
            diagnostic = connection.exec_driver_sql(
                "SELECT reason,action,retryable FROM diagnostic_records"
            ).one()
        self.assertEqual(diagnostic, ("identity", "retry", 1))

    def test_local_cited_by_precedes_remote_graph_and_duplicate_edges_converge(self) -> None:
        # Given
        local = WorkRepository(self.catalog).ingest_version(
            provider="fixture",
            provider_record_id="local",
            title="Local citer",
            doi="10.1000/local",
        )
        ReferenceRepository(self.catalog).add(
            local.id, 0, "local raw", cited_work_id=self.source.work_id
        )
        seed = GraphIdentifier(GraphIdentifierNamespace.DOI, "10.1000/source")
        remote = GraphIdentifier(GraphIdentifierNamespace.DOI, "10.1000/remote")
        self.metadata.enabled = True

        # When
        first = self.service().resolve_graph(
            self.source.id,
            (CitationEdge(remote, seed), CitationEdge(remote, seed)),
        )
        with self.catalog.connect() as connection:
            observation_count = connection.exec_driver_sql(
                "SELECT count(*) FROM metadata_observations"
            ).scalar_one()
        second = self.service().resolve_graph(
            self.source.id,
            (CitationEdge(remote, seed),),
        )

        # Then
        self.assertEqual(first.local_cited_by, (local.work_id,))
        self.assertEqual((first.resolved, first.duplicates), (1, 1))
        self.assertEqual((second.resolved, second.duplicates), (0, 1))
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM works").scalar_one(), 3)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM version_references").scalar_one(), 2)
            self.assertEqual(
                connection.exec_driver_sql(
                    "SELECT count(*) FROM metadata_observations"
                ).scalar_one(),
                observation_count,
            )


if __name__ == "__main__":
    import unittest

    unittest.main()
