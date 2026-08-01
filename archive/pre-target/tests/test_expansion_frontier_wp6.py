import sys
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    ReferenceRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.expansion import CatalogFrontier
from sciretriever.integrations.graph import (
    GraphDirection,
    GraphIdentifier,
    GraphIdentifierNamespace,
)


class CatalogFrontierCharacterizationTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-expansion-frontier-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(
            Path(self.temporary.name) / "catalog.sqlite",
            allow_repository_write=True,
        )
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        works = WorkRepository(self.catalog)
        self.source = works.ingest_version(
            provider="fixture", provider_record_id="source",
            title="Source", doi="10.2000/source",
        )
        self.reference = works.ingest_version(
            provider="fixture", provider_record_id="reference",
            title="Reference", doi="10.2000/reference",
        )
        self.citer = works.ingest_version(
            provider="fixture", provider_record_id="citer",
            title="Citer", doi="10.2000/citer",
        )
        references = ReferenceRepository(self.catalog)
        references.add(
            self.source.id, 0, "reference", cited_work_id=self.reference.work_id
        )
        references.add(
            self.citer.id, 0, "source", cited_work_id=self.source.work_id
        )

    def test_exact_seed_and_preferred_use_stable_graph_identity(self) -> None:
        # Given
        frontier = CatalogFrontier(self.catalog)

        # When
        seed = frontier.seed(self.source.id)
        preferred = frontier.preferred(self.source.work_id)

        # Then
        self.assertEqual(seed, preferred)
        self.assertEqual(
            seed.identifier,
            GraphIdentifier(GraphIdentifierNamespace.DOI, "10.2000/source"),
        )

    def test_local_directions_stream_stable_work_identity(self) -> None:
        # Given
        frontier = CatalogFrontier(self.catalog)
        seed = frontier.seed(self.source.id)

        # When
        references = tuple(frontier.neighbors(seed, GraphDirection.REFERENCES))
        cited_by = tuple(frontier.neighbors(seed, GraphDirection.CITED_BY))

        # Then
        self.assertEqual(references, (self.reference.work_id,))
        self.assertEqual(cited_by, (self.citer.work_id,))


if __name__ == "__main__":
    import unittest

    unittest.main()
