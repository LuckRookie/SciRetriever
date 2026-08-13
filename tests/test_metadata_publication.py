from __future__ import annotations

import unittest
from collections.abc import Iterable
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.literature.api import LiteratureApi, ObservationAcceptanceResult
from sciretriever.literature.metadata import MetadataProjectionDecision
from sciretriever.metadata.publication import (
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
        self.calls: list[ProviderRelationObservation] = []

    def publish_provider_relation_observation(
        self,
        observation: ProviderRelationObservation,
    ) -> None:
        self.calls.append(observation)


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

    def test_relation_publication_is_one_edge_and_does_not_publish_observation(self) -> None:
        literature = _RecordingLiteratureApi(
            ObservationAcceptanceResult(decision="rejected", reason="unused")
        )
        relations = _RecordingRelationPort()
        self.assertIsInstance(relations, ProviderRelationObservationPublicationPort)
        publication = MetadataPublication(literature, relations)
        relation = _relation()

        publication.publish_relation_observation(relation)

        self.assertEqual(relations.calls, [relation])
        self.assertEqual(literature.calls, [])
        self.assertFalse(hasattr(publication, "publish_batch"))
        self.assertFalse(hasattr(publication, "publish_item"))

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

        adapter.publish_provider_relation_observation(relation)
        adapter.publish_provider_relation_observation(replay)

        self.assertEqual(self._count("provider_relation_observations"), 1)
        self.assertEqual(self._count("provenances"), 1)
        self.assertEqual(self._count("literatures"), 0)
        self.assertEqual(self._count("literature_references"), 0)
        self.assertEqual(self._count("provider_relation_reference_supports"), 0)
        self.assertEqual(self._count("metadata_reference_text_supports"), 0)
        self.assertEqual(self._count("content_reference_text_supports"), 0)

    def test_each_relation_is_its_own_transaction_and_failure_keeps_prior_edge(self) -> None:
        successful = SqliteProviderRelationObservationPublication(LiteratureWriter(self.engine))
        successful.publish_provider_relation_observation(_relation(_ID_1))

        def fail_after_relation(name: str) -> None:
            if name == "provider-relation-after":
                raise RuntimeError("fixture failpoint")

        failing = SqliteProviderRelationObservationPublication(
            LiteratureWriter(self.engine, failpoint=fail_after_relation)
        )
        with self.assertRaises(RuntimeError):
            failing.publish_provider_relation_observation(_relation(_ID_2))

        self.assertEqual(self._count("provider_relation_observations"), 1)
        with self.engine.read_snapshot() as connection:
            rows = connection.execute(
                "SELECT observation_id FROM provider_relation_observations"
            ).fetchall()
        self.assertEqual(rows, [(_ID_1,)])

    def test_same_relation_observation_id_cannot_replace_an_immutable_edge(self) -> None:
        adapter = SqliteProviderRelationObservationPublication(LiteratureWriter(self.engine))
        original = _relation()
        adapter.publish_provider_relation_observation(original)
        conflicting = original.model_copy(
            update={"cited": ProviderLiteratureKey(record_id="different-target")}
        )

        with self.assertRaises(LiteratureWriterConflictError):
            adapter.publish_provider_relation_observation(conflicting)

        self.assertEqual(self._count("provider_relation_observations"), 1)
        with self.engine.read_snapshot() as connection:
            cited = connection.execute(
                "SELECT record_id FROM provider_relation_endpoints "
                "WHERE observation_id=? AND endpoint_kind='cited'",
                (_ID_2,),
            ).fetchone()
        self.assertEqual(cited, ("target-record",))


if __name__ == "__main__":
    unittest.main()
