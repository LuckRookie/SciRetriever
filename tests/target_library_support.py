from __future__ import annotations

import os
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.literature_store.sqlite import (
    SqliteLiteratureRepository,
    create_or_open_catalog,
)
from sciretriever.literature_store.sqlite.publisher_support import (
    StatementFailpoint,
    publish_bibliography,
)
from sciretriever.model.literature import BibliographicObservation, Identifier, InitialMetadata
from sciretriever.model.primitives import UtcTimestamp
from sciretriever.services.literature.api import prepare_initial_ingest


class LibraryCase(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-target-library-")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.catalog = self.root / "catalog.sqlite"
        with create_or_open_catalog(self.catalog):
            pass

    def _publish(self, title: str, role: str, suffix: str) -> tuple[str, str]:
        observation = BibliographicObservation(
            provider="crossref",
            provider_record_id=f"record-{suffix}",
            source_priority=0,
            observed_at=UtcTimestamp("2026-07-31T00:00:00Z"),
            identifiers=(Identifier(namespace="doi", value=f"10.1000/{suffix}"),),
            metadata=InitialMetadata(
                title=title,
                authors=("Ada Lovelace",),
                year=2024,
                item_type="article",
                abstract="metadata alpha",
                venue="Journal Alpha",
                language="en",
            ),
            version_role=role,
        )
        prepared = prepare_initial_ingest(SqliteLiteratureRepository(self.catalog), (observation,))
        with create_or_open_catalog(self.catalog) as connection:
            connection.execute("BEGIN IMMEDIATE")
            publish_bibliography(connection, StatementFailpoint(None), prepared)
            connection.commit()
        return str(prepared.work_id), str(prepared.work_version_id)


__all__ = ("LibraryCase",)
