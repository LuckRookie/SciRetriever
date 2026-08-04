from __future__ import annotations

import unittest
from dataclasses import replace
from uuid import uuid4

from sciretriever.infrastructure.storage.sqlite import (
    ContentAcceptancePublisher,
    create_or_open_catalog,
)
from sciretriever.model.assets import (
    ArtifactKind,
    PrimaryPdfAcceptance,
    SupplementaryAssetAcceptance,
)
from sciretriever.model.canonical_json import CanonicalJsonObject, canonical_json_bytes
from sciretriever.model.execution import ContentAcceptanceCommand
from sciretriever.model.primitives import (
    AssetId,
    AssetRole,
    BatchRunId,
    MetadataSnapshotId,
    WorkId,
    WorkVersionAssetId,
    WorkVersionId,
)
from sciretriever.services.assets import accept_content
from tests.target_publisher_support import ScenarioFactory


class TargetAssetPublicationReuseTests(unittest.TestCase):
    def setUp(self) -> None:
        self.factory = ScenarioFactory()
        self.addCleanup(self.factory.cleanup)

    def test_identical_bytes_reuse_artifact_while_each_relation_keeps_its_source(self) -> None:
        first = self.factory.primary()
        assert isinstance(first.command, ContentAcceptanceCommand)
        first_acceptance = first.command.acceptance
        assert isinstance(first_acceptance, PrimaryPdfAcceptance)
        first_source = CanonicalJsonObject((("provider", "first"),))
        first_command = first.command.model_copy(
            update={"acceptance": first_acceptance.model_copy(update={"source": first_source})}
        )
        replace(first, command=first_command).invoke()

        work_id = WorkId(str(uuid4()))
        work_version_id = WorkVersionId(str(uuid4()))
        metadata_id = MetadataSnapshotId(str(uuid4()))
        with create_or_open_catalog(first.path) as connection:
            metadata = connection.execute(
                "SELECT revision,sha256,values_json,provenance_json FROM metadata_snapshots "
                "WHERE id=?",
                (str(first_acceptance.expected_metadata_id),),
            ).fetchone()
            assert metadata is not None
            connection.execute("INSERT INTO works(id) VALUES(?)", (str(work_id),))
            connection.execute(
                "INSERT INTO work_versions(id,work_id,version_role) VALUES(?,?,'formal')",
                (str(work_version_id), str(work_id)),
            )
            connection.execute(
                "INSERT INTO metadata_snapshots(id,work_version_id,revision,sha256,values_json,"
                "provenance_json) VALUES(?,?,?,?,?,?)",
                (str(metadata_id), str(work_version_id), *metadata),
            )
            connection.execute(
                "INSERT INTO work_version_current_metadata(work_version_id,metadata_snapshot_id) "
                "VALUES(?,?)",
                (str(work_version_id), str(metadata_id)),
            )
            connection.commit()
        batch_id = BatchRunId(str(uuid4()))
        self.factory.batch(first.path, batch_id, work_version_id)
        second_source = CanonicalJsonObject((("provider", "second"),))
        second_acceptance = first_acceptance.model_copy(
            update={
                "work_version_id": work_version_id,
                "expected_metadata_id": metadata_id,
                "expected_metadata_revision": metadata[0],
                "expected_metadata_sha256": metadata[1],
                "artifact_id": AssetId(str(uuid4())),
                "relation_id": WorkVersionAssetId(str(uuid4())),
                "source": second_source,
            }
        )
        second_target = first.command.target.model_copy(
            update={
                "batch_run_id": batch_id,
                "work_version_id": work_version_id,
                "result": first.command.target.result.model_copy(
                    update={"subject_id": str(work_version_id)}
                ),
            }
        )

        accept_content(ContentAcceptancePublisher(first.path), second_acceptance, second_target)

        with create_or_open_catalog(first.path) as connection:
            self.assertEqual(
                connection.execute("SELECT count(*) FROM artifacts WHERE kind='raw'").fetchone(),
                (1,),
            )
            self.assertEqual(
                connection.execute(
                    "SELECT count(*),count(DISTINCT artifact_id) FROM work_version_assets"
                ).fetchone(),
                (2, 1),
            )
            sources = {
                row[0]
                for row in connection.execute(
                    "SELECT source_json FROM work_version_assets ORDER BY id"
                ).fetchall()
            }
        self.assertEqual(
            sources,
            {
                canonical_json_bytes(first_source).decode("ascii"),
                canonical_json_bytes(second_source).decode("ascii"),
            },
        )

    def test_supplementary_replay_reuses_relation_and_new_source_keeps_provenance(self) -> None:
        first = self.factory.primary()
        first.invoke()
        assert isinstance(first.command, ContentAcceptanceCommand)
        primary = first.command.acceptance
        assert isinstance(primary, PrimaryPdfAcceptance)
        body = b"<article>supplement</article>"
        source = CanonicalJsonObject((("provider", "first"),))
        acceptance = SupplementaryAssetAcceptance(
            work_version_id=primary.work_version_id,
            expected_metadata_id=primary.expected_metadata_id,
            expected_metadata_revision=primary.expected_metadata_revision,
            expected_metadata_sha256=primary.expected_metadata_sha256,
            expected_primary_sha256=primary.artifact.sha256,
            artifact_id=AssetId(str(uuid4())),
            relation_id=WorkVersionAssetId(str(uuid4())),
            role=AssetRole.XML,
            media_type="application/xml",
            artifact=self.factory.artifact(ArtifactKind.SUPPLEMENTARY, body),
            source=source,
        )
        publisher = ContentAcceptancePublisher(first.path)
        initial = self._publish_asset(first, publisher, acceptance)
        replay = self._publish_asset(
            first,
            publisher,
            acceptance.model_copy(
                update={
                    "artifact_id": AssetId(str(uuid4())),
                    "relation_id": WorkVersionAssetId(str(uuid4())),
                }
            ),
        )
        second_source = CanonicalJsonObject((("provider", "second"),))
        additional = self._publish_asset(
            first,
            publisher,
            acceptance.model_copy(
                update={
                    "artifact_id": AssetId(str(uuid4())),
                    "relation_id": WorkVersionAssetId(str(uuid4())),
                    "media_type": "text/xml",
                    "source": second_source,
                }
            ),
        )

        assert initial is not None
        assert replay is not None
        assert additional is not None
        self.assertFalse(initial.replayed)
        self.assertTrue(replay.replayed)
        self.assertEqual(replay.relation_id, initial.relation_id)
        self.assertEqual(
            (initial.asset_id, replay.asset_id, additional.asset_id),
            (initial.asset_id, initial.asset_id, initial.asset_id),
        )
        with create_or_open_catalog(first.path) as connection:
            rows = connection.execute(
                "SELECT role,source_json FROM work_version_assets WHERE artifact_id=? "
                "ORDER BY source_json",
                (str(initial.asset_id),),
            ).fetchall()
        self.assertEqual(
            rows,
            [
                ("xml", canonical_json_bytes(source).decode("ascii")),
                ("xml", canonical_json_bytes(second_source).decode("ascii")),
            ],
        )

    def _publish_asset(
        self,
        scenario,
        publisher: ContentAcceptancePublisher,
        acceptance: SupplementaryAssetAcceptance,
    ):
        batch_id = BatchRunId(str(uuid4()))
        self.factory.batch(scenario.path, batch_id, acceptance.work_version_id)
        target = scenario.command.target.model_copy(update={"batch_run_id": batch_id})
        return accept_content(publisher, acceptance, target)


if __name__ == "__main__":
    unittest.main()
