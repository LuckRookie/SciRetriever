from __future__ import annotations

import sqlite3
import time
import unittest
from collections.abc import Iterable, Iterator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.literature.api import LiteratureApi, ObservationAcceptanceResult
from sciretriever.literature.metadata import MetadataProjectionDecision
from sciretriever.metadata.publication import (
    MAX_PROVIDER_RELATION_PUBLICATION_BATCH,
    MetadataPublication,
    ProviderRelationObservationPublicationPort,
)
from sciretriever.model.literature import (
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
    VersionRole,
)
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_writer import (
    LiteratureWriter,
    LiteratureWriterConflictError,
)
from sciretriever.storage.sqlite.metadata_publication import (
    SqliteProviderRelationObservationPublication,
)

_ID_1 = "123e4567-e89b-12d3-a456-426614174000"
_ID_2 = "223e4567-e89b-12d3-a456-426614174000"
_HASH = Sha256("a" * 64)


def _provenance(identifier: str = _ID_1) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(identifier),
        source_kind=SourceKind.METADATA_PROVIDER,
        source_name="fixture-provider",
        source_record_id="record-1",
        observed_at=UtcTimestamp("2026-08-11T00:00:00Z"),
        input_sha256=_HASH,
        parameters_sha256=None,
    )


def _observation() -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_ID_1),
        provenance=_provenance(),
        metadata=LiteratureMetadata(
            title="A paper",
            authors=(),
            abstract=None,
            publication_date=None,
            publication_year=2026,
            document_type="journal-article",
            language=None,
            venue=None,
            publisher=None,
            volume=None,
            issue=None,
            pages=None,
            identifiers=(Identifier(namespace="doi", value="10.1000/example"),),
            keywords=(),
        ),
        version_role=None,
        version_links=(),
        declared_keywords=(),
        reference_texts=(),
        reference_count=None,
        cited_by_count=None,
        asset_hints=(),
    )


def _relation(identifier: str = _ID_2) -> ProviderRelationObservation:
    return ProviderRelationObservation(
        observation_id=ObservationId(identifier),
        provenance=_provenance(identifier),
        citing=ProviderLiteratureKey(record_id="source-record"),
        cited=ProviderLiteratureKey(record_id="target-record"),
    )


def _relation_id(index: int) -> str:
    return f"{index:08x}-e89b-12d3-a456-426614174000"


class _RecordingLiteratureApi(LiteratureApi):
    def __init__(self, result: ObservationAcceptanceResult) -> None:
        self.result = result
        self.calls: list[tuple[MetadataObservation, tuple[str, ...]]] = []

    def accept_observation(
        self,
        observation: MetadataObservation,
        *,
        provider_precedence: Iterable[str] = (),
    ) -> ObservationAcceptanceResult:
        self.calls.append((observation, tuple(provider_precedence)))
        return self.result


class _RecordingRelationPort:
    def __init__(self) -> None:
        self.calls: list[tuple[ProviderRelationObservation, ...]] = []

    def publish_provider_relation_observations(
        self,
        observations: tuple[ProviderRelationObservation, ...],
    ) -> None:
        self.calls.append(observations)


class _CountingCatalogEngine(CatalogEngine):
    __slots__ = ("write_transaction_count",)

    write_transaction_count: int

    def __init__(self, catalog_path: Path) -> None:
        super().__init__(catalog_path)
        object.__setattr__(self, "write_transaction_count", 0)

    @contextmanager
    def write_transaction(self) -> Iterator[sqlite3.Connection]:
        object.__setattr__(self, "write_transaction_count", self.write_transaction_count + 1)
        with super().write_transaction() as connection:
            yield connection


class MetadataPublicationTests(unittest.TestCase):
    def test_observation_publication_delegates_unchanged_to_literature_api(self) -> None:
        observation = _observation()
        literature_value = Literature(
            literature_id=LiteratureId(_ID_1),
            meta_literature_id=MetaLiteratureId(_ID_2),
            version_role=VersionRole.OTHER,
            metadata=observation.metadata,
            status=LiteratureStatus.UNREVIEWED,
        )
        expected = ObservationAcceptanceResult(
            decision="created",
            literature=literature_value,
            meta_literature=MetaLiterature(
                meta_literature_id=literature_value.meta_literature_id,
                representative_literature_id=literature_value.literature_id,
            ),
            observation=observation,
            projection=MetadataProjectionDecision(
                outcome="projected",
                metadata=observation.metadata,
                metadata_revision=1,
                changed=True,
                observations_projection_changed=True,
            ),
            metadata_revision=1,
            meta_literature_created=True,
        )
        literature = _RecordingLiteratureApi(expected)
        relations = _RecordingRelationPort()
        publication = MetadataPublication(literature, relations)

        actual = publication.publish_observation(
            observation,
            provider_precedence=("fixture-provider", "other-provider"),
        )

        self.assertIs(actual, expected)
        self.assertTrue(actual.meta_literature_created)
        self.assertEqual(
            literature.calls,
            [(observation, ("fixture-provider", "other-provider"))],
        )
        self.assertEqual(relations.calls, [])

    def test_relation_publication_forwards_one_frozen_bounded_batch_only(self) -> None:
        literature = _RecordingLiteratureApi(
            ObservationAcceptanceResult(decision="rejected", reason="unused")
        )
        relations = _RecordingRelationPort()
        self.assertIsInstance(relations, ProviderRelationObservationPublicationPort)
        publication = MetadataPublication(literature, relations)
        relation = _relation()

        publication.publish_relation_observations((relation,))

        self.assertEqual(relations.calls, [(relation,)])
        self.assertEqual(literature.calls, [])
        self.assertFalse(hasattr(publication, "publish_relation_observation"))

    def test_relation_publication_rejects_mutable_empty_and_oversized_batches(self) -> None:
        literature = _RecordingLiteratureApi(
            ObservationAcceptanceResult(decision="rejected", reason="unused")
        )
        relations = _RecordingRelationPort()
        publication = MetadataPublication(literature, relations)
        relation = _relation()

        with self.assertRaises(TypeError):
            publication.publish_relation_observations([relation])  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            publication.publish_relation_observations(())
        with self.assertRaises(ValueError):
            publication.publish_relation_observations(
                (relation,) * (MAX_PROVIDER_RELATION_PUBLICATION_BATCH + 1)
            )

        self.assertEqual(relations.calls, [])
        self.assertEqual(literature.calls, [])

    def test_invalid_publication_dependencies_fail_before_any_call(self) -> None:
        literature = _RecordingLiteratureApi(
            ObservationAcceptanceResult(decision="rejected", reason="unused")
        )
        relations = _RecordingRelationPort()
        with self.assertRaises(TypeError):
            MetadataPublication(object(), relations)  # type: ignore[arg-type]
        with self.assertRaises(TypeError):
            MetadataPublication(literature, object())  # type: ignore[arg-type]


class SqliteMetadataPublicationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-metadata-publication-")
        self.addCleanup(self.temporary.cleanup)
        self.engine = CatalogEngine(Path(self.temporary.name) / "catalog.sqlite")

    def _count(self, table: str) -> int:
        with self.engine.read_snapshot() as connection:
            row = connection.execute(f'SELECT count(*) FROM "{table}"').fetchone()
        assert row is not None
        return int(row[0])

    def test_sqlite_adapter_delegates_idempotent_relation_without_creating_targets(self) -> None:
        adapter = SqliteProviderRelationObservationPublication(LiteratureWriter(self.engine))
        relation = _relation()
        replay = relation.model_copy(
            update={
                "provenance": relation.provenance.model_copy(
                    update={
                        "provenance_id": ProvenanceId(_ID_1),
                        "observed_at": UtcTimestamp("2026-08-12T00:00:00Z"),
                    }
                )
            }
        )

        adapter.publish_provider_relation_observations((relation,))
        adapter.publish_provider_relation_observations((replay,))

        self.assertEqual(self._count("provider_relation_observations"), 1)
        self.assertEqual(self._count("provenances"), 1)
        self.assertEqual(self._count("literatures"), 0)
        self.assertEqual(self._count("literature_references"), 0)
        self.assertEqual(self._count("provider_relation_reference_supports"), 0)
        self.assertEqual(self._count("metadata_reference_text_supports"), 0)
        self.assertEqual(self._count("content_reference_text_supports"), 0)

    def test_sqlite_adapter_rejects_mutable_empty_and_oversized_batches(self) -> None:
        adapter = SqliteProviderRelationObservationPublication(LiteratureWriter(self.engine))
        relation = _relation()

        with self.assertRaises(TypeError):
            adapter.publish_provider_relation_observations([relation])  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            adapter.publish_provider_relation_observations(())
        with self.assertRaises(ValueError):
            adapter.publish_provider_relation_observations(
                (relation,) * (MAX_PROVIDER_RELATION_PUBLICATION_BATCH + 1)
            )

        self.assertEqual(self._count("provider_relation_observations"), 0)
        self.assertEqual(self._count("provenances"), 0)

    def test_batch_is_atomic_and_failure_keeps_prior_successful_batch(self) -> None:
        successful = SqliteProviderRelationObservationPublication(LiteratureWriter(self.engine))
        successful.publish_provider_relation_observations((_relation(_ID_1),))

        checkpoints = 0

        def fail_after_relation(name: str) -> None:
            nonlocal checkpoints
            if name != "provider-relation-after":
                return
            checkpoints += 1
            if checkpoints == 2:
                raise RuntimeError("fixture failpoint")

        failing = SqliteProviderRelationObservationPublication(
            LiteratureWriter(self.engine, failpoint=fail_after_relation)
        )
        with self.assertRaises(RuntimeError):
            failing.publish_provider_relation_observations(
                (_relation(_ID_2), _relation(_relation_id(3)))
            )

        self.assertEqual(self._count("provider_relation_observations"), 1)
        with self.engine.read_snapshot() as connection:
            rows = connection.execute(
                "SELECT observation_id FROM provider_relation_observations"
            ).fetchall()
        self.assertEqual(rows, [(_ID_1,)])

    def test_same_relation_observation_id_cannot_replace_an_immutable_edge(self) -> None:
        adapter = SqliteProviderRelationObservationPublication(LiteratureWriter(self.engine))
        original = _relation()
        adapter.publish_provider_relation_observations((original,))
        conflicting = original.model_copy(
            update={"cited": ProviderLiteratureKey(record_id="different-target")}
        )

        with self.assertRaises(LiteratureWriterConflictError):
            adapter.publish_provider_relation_observations(
                (_relation(_relation_id(3)), conflicting)
            )

        self.assertEqual(self._count("provider_relation_observations"), 1)
        with self.engine.read_snapshot() as connection:
            cited = connection.execute(
                "SELECT record_id FROM provider_relation_endpoints "
                "WHERE observation_id=? AND endpoint_kind='cited'",
                (_ID_2,),
            ).fetchone()
        self.assertEqual(cited, ("target-record",))
        self.assertEqual(self._count("provenances"), 1)

    def test_14k_relations_use_bounded_transactions_and_replay_idempotently(self) -> None:
        engine = _CountingCatalogEngine(Path(self.temporary.name) / "counted.sqlite")
        adapter = SqliteProviderRelationObservationPublication(LiteratureWriter(engine))
        relations = tuple(_relation(_relation_id(index)) for index in range(1, 14_001))

        started = time.monotonic()
        for offset in range(0, len(relations), MAX_PROVIDER_RELATION_PUBLICATION_BATCH):
            adapter.publish_provider_relation_observations(
                relations[offset : offset + MAX_PROVIDER_RELATION_PUBLICATION_BATCH]
            )
        first_elapsed = time.monotonic() - started

        expected_transactions = 55
        self.assertEqual(engine.write_transaction_count, expected_transactions)
        with engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM provider_relation_observations"
                ).fetchone(),
                (14_000,),
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM provenances").fetchone(), (14_000,)
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM provider_relation_endpoints").fetchone(),
                (28_000,),
            )
        self.assertLess(first_elapsed, 30.0)

        for offset in range(0, len(relations), MAX_PROVIDER_RELATION_PUBLICATION_BATCH):
            adapter.publish_provider_relation_observations(
                relations[offset : offset + MAX_PROVIDER_RELATION_PUBLICATION_BATCH]
            )

        self.assertEqual(engine.write_transaction_count, expected_transactions * 2)
        with engine.read_snapshot() as connection:
            self.assertEqual(
                connection.execute(
                    "SELECT count(*) FROM provider_relation_observations"
                ).fetchone(),
                (14_000,),
            )
            self.assertEqual(
                connection.execute("SELECT count(*) FROM provenances").fetchone(), (14_000,)
            )

    def test_batch_preserves_endpoint_identifiers_and_provenance_foreign_keys(self) -> None:
        adapter = SqliteProviderRelationObservationPublication(LiteratureWriter(self.engine))
        relation = _relation().model_copy(
            update={
                "citing": ProviderLiteratureKey(
                    record_id="source-record",
                    identifiers=(Identifier(namespace="doi", value="10.1000/source"),),
                ),
                "cited": ProviderLiteratureKey(
                    record_id="target-record",
                    identifiers=(Identifier(namespace="doi", value="10.1000/target"),),
                ),
            }
        )

        adapter.publish_provider_relation_observations((relation,))

        with self.engine.read_snapshot() as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])
            rows = connection.execute(
                "SELECT endpoint_kind,ordinal,namespace,value "
                "FROM provider_relation_endpoint_identifiers ORDER BY endpoint_kind,ordinal"
            ).fetchall()
            self.assertEqual(
                rows,
                [
                    ("cited", 0, "doi", "10.1000/target"),
                    ("citing", 0, "doi", "10.1000/source"),
                ],
            )

    def test_concurrent_bounded_batches_commit_consistent_rows(self) -> None:
        first = tuple(_relation(_relation_id(index)) for index in range(1, 513))
        second = tuple(_relation(_relation_id(index)) for index in range(513, 1_025))

        def publish(relations: tuple[ProviderRelationObservation, ...]) -> None:
            adapter = SqliteProviderRelationObservationPublication(LiteratureWriter(self.engine))
            for offset in range(0, len(relations), MAX_PROVIDER_RELATION_PUBLICATION_BATCH):
                adapter.publish_provider_relation_observations(
                    relations[offset : offset + MAX_PROVIDER_RELATION_PUBLICATION_BATCH]
                )

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = (executor.submit(publish, first), executor.submit(publish, second))
            for future in futures:
                future.result()

        self.assertEqual(self._count("provider_relation_observations"), 1_024)
        self.assertEqual(self._count("provenances"), 1_024)
        with self.engine.read_snapshot() as connection:
            self.assertEqual(connection.execute("PRAGMA foreign_key_check").fetchall(), [])


if __name__ == "__main__":
    unittest.main()
