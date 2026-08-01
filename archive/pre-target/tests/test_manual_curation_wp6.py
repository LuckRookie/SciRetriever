from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
from uuid import uuid4

from sciretriever.catalog import (
    TagRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.curation import (
    CurationNoChangeError,
    CurationOperationOwner,
    CurationRequest,
    CurationStaleError,
)
from sciretriever.catalog.manual_metadata_curation import (
    ManualMetadataClearHandler,
    ManualMetadataCurationConflictError,
    ManualMetadataSetHandler,
)
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot
from sciretriever.core.timestamps import utc_now_rfc3339


class ManualCurationCharacterizationTests(unittest.TestCase):
    catalog: CatalogEngine
    temporary: TemporaryDirectory[str]

    def setUp(self) -> None:
        workspace_guard = patch("sciretriever.catalog.engine.require_staged_write_override")
        workspace_guard.start()
        self.addCleanup(workspace_guard.stop)
        self.temporary = TemporaryDirectory(prefix="sciretriever-manual-curation-wp6-")
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)

    def test_provider_projection_returns_after_manual_override_is_cleared(self) -> None:
        works = WorkRepository(self.catalog)
        version = works.ingest_version(
            provider="provider-a", provider_record_id="record-a", title="Provider title",
            doi="10.14/metadata", metadata={"language": "en"},
        )
        from manual_curation_fixture import clear_manual_metadata, set_manual_metadata
        set_manual_metadata(self.catalog, version.id, "language", "fr")

        works.ingest_version(
            provider="provider-b", provider_record_id="record-b", title="Provider title",
            doi="10.14/metadata", provider_precedence=-1, metadata={"language": "de"},
        )
        clear_manual_metadata(self.catalog, version.id, "language")

        with self.catalog.connect() as connection:
            language = connection.exec_driver_sql(
                "SELECT language FROM work_versions WHERE id=?", (version.id,),
            ).scalar_one()
            observations = connection.exec_driver_sql(
                "SELECT count(*) FROM metadata_observations WHERE work_version_id=?",
                (version.id,),
            ).scalar_one()
        self.assertEqual(language, "de")
        self.assertGreaterEqual(observations, 2)

    def test_generated_tag_replacement_does_not_change_manual_tag_links(self) -> None:
        version = WorkRepository(self.catalog).ingest_version(
            provider="provider", provider_record_id="record", title="Tagged work",
            doi="10.14/tags",
        )
        tags = TagRepository(self.catalog)
        collision = tags.add("collision")
        generated_only = tags.add("generated-only")
        from manual_curation_fixture import add_manual_tag
        add_manual_tag(self.catalog, version.work_id, collision.id)

        with self.catalog.transaction() as connection:
            raw_id, artifact = str(uuid4()), str(uuid4())
            now = utc_now_rfc3339()
            connection.exec_driver_sql(
                "INSERT INTO raw_assets "
                "(id,sha256,storage_path,media_type,format,byte_size,provenance_json,created_at) "
                "VALUES (?,?,'raw/bb/'||?,'application/pdf','pdf',1,'{}',?)",
                (raw_id, "b" * 64, "b" * 64, now),
            )
            connection.exec_driver_sql(
                "INSERT INTO normalized_artifacts "
                "(id,work_version_id,raw_asset_id,kind,schema_version,storage_path,sha256,"
                "media_type,byte_size,provenance_json,created_at) "
                "VALUES (?,?,?,'analysis','1',?,?,'application/json',1,'{}',?)",
                (artifact, version.id, raw_id, f"derived/analysis/{artifact}.json", "a" * 64, now),
            )
            connection.exec_driver_sql(
                "INSERT INTO generated_work_version_tags "
                "(work_version_id,tag_id,source_artifact_id) VALUES (?,?,?),(?,?,?)",
                (version.id, collision.id, artifact, version.id, generated_only.id, artifact),
            )
            connection.exec_driver_sql(
                "DELETE FROM generated_work_version_tags WHERE work_version_id=?",
                (version.id,),
            )

        with self.catalog.connect() as connection:
            manual = connection.exec_driver_sql(
                "SELECT tag_id FROM manual_work_tags WHERE work_id=?", (version.work_id,),
            ).scalars().all()
            generated = connection.exec_driver_sql(
                "SELECT tag_id FROM generated_work_version_tags WHERE work_version_id=?",
                (version.id,),
            ).scalars().all()
        self.assertEqual(manual, [collision.id])
        self.assertEqual(generated, [])


class ManualMetadataCurationTests(ManualCurationCharacterizationTests):
    def setUp(self) -> None:
        super().setUp()
        self.version = WorkRepository(self.catalog).ingest_version(
            provider="provider", provider_record_id="curated", title="Provider title",
            doi="10.14/curated", metadata={"language": "en"},
        )

    @staticmethod
    def request(handler: ManualMetadataSetHandler | ManualMetadataClearHandler) -> CurationRequest:
        return CurationRequest(
            handler, ReviewDecision.NOT_REQUIRED, SafeSnapshot(()),
            operation_id=handler.operation_id,
        )

    def state(self) -> tuple[str | None, str | None, int]:
        with self.catalog.connect() as connection:
            row = connection.exec_driver_sql(
                "SELECT v.language,m.value_json FROM work_versions v "
                "LEFT JOIN manual_metadata_overrides m ON m.work_version_id=v.id "
                "AND m.field_name='language' WHERE v.id=?", (self.version.id,),
            ).one()
            audits = connection.exec_driver_sql("SELECT count(*) FROM curation_operations").scalar_one()
        return row[0], row[1], int(audits)

    def test_set_clear_and_each_undo_restore_exact_canonical_value_and_link(self) -> None:
        owner = CurationOperationOwner(self.catalog)
        set_handler = ManualMetadataSetHandler.load(self.catalog, self.version.id, "language", "fr")
        set_record = owner.apply(self.request(set_handler))
        self.assertEqual(self.state(), ("fr", '"fr"', 1))
        owner.undo(set_record.id, set_handler)
        self.assertEqual(self.state(), ("en", None, 2))

        applied = owner.apply(self.request(ManualMetadataSetHandler.load(
            self.catalog, self.version.id, "language", "fr",
        )))
        clear_handler = ManualMetadataClearHandler.load(self.catalog, self.version.id, "language")
        clear_record = owner.apply(self.request(clear_handler))
        self.assertEqual(self.state(), ("en", None, 4))
        owner.undo(clear_record.id, clear_handler)
        self.assertEqual(self.state(), ("fr", '"fr"', 5))
        self.assertEqual(applied.operation.action.value, "set_metadata")

    def test_invalid_merged_duplicate_and_absent_clear_are_zero_audit(self) -> None:
        for version_id, field, value, code in (
            ("bad", "language", "fr", "malformed_id"),
            (str(uuid4()), "language", "fr", "unknown_version"),
            (self.version.id, "provider_payload", "x", "unsupported_field"),
            (self.version.id, "publication_year", -1, "invalid_value"),
        ):
            with self.subTest(code=code), self.assertRaises(ManualMetadataCurationConflictError) as raised:
                ManualMetadataSetHandler.load(self.catalog, version_id, field, value)
            self.assertEqual(raised.exception.code, code)
        owner = CurationOperationOwner(self.catalog)
        with self.assertRaises(CurationNoChangeError):
            owner.apply(self.request(ManualMetadataClearHandler.load(
                self.catalog, self.version.id, "language",
            )))
        first = ManualMetadataSetHandler.load(self.catalog, self.version.id, "language", "fr")
        owner.apply(self.request(first))
        with self.assertRaises(CurationNoChangeError):
            owner.apply(self.request(ManualMetadataSetHandler.load(
                self.catalog, self.version.id, "language", "fr",
            )))
        self.assertEqual(self.state()[2], 1)

    def test_load_apply_and_undo_stale_guards_preserve_independent_state(self) -> None:
        stale = ManualMetadataSetHandler.load(self.catalog, self.version.id, "language", "fr")
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE work_versions SET language='de' WHERE id=?", (self.version.id,),
            )
        owner = CurationOperationOwner(self.catalog)
        with self.assertRaises(CurationStaleError):
            owner.apply(self.request(stale))
        current = ManualMetadataSetHandler.load(self.catalog, self.version.id, "language", "fr")
        record = owner.apply(self.request(current))
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE work_versions SET language='it' WHERE id=?", (self.version.id,),
            )
        with self.assertRaises(CurationStaleError):
            owner.undo(record.id, current)
        self.assertEqual(self.state(), ("it", '"fr"', 1))

    def test_all_metadata_table_family_failpoints_are_zero_write(self) -> None:
        handler = ManualMetadataSetHandler.load(self.catalog, self.version.id, "language", "fr")
        for phase in CurationOperationOwner.apply_failpoints(handler):
            with self.subTest(phase=phase):
                def failpoint(point: str, expected: str = phase) -> None:
                    if point == expected:
                        raise RuntimeError(expected)
                with self.assertRaises(RuntimeError):
                    CurationOperationOwner(self.catalog, test_failpoint=failpoint).apply(
                        self.request(handler),
                    )
                self.assertEqual(self.state(), ("en", None, 0))
        record = CurationOperationOwner(self.catalog).apply(self.request(handler))
        for phase in CurationOperationOwner.undo_failpoints(handler):
            with self.subTest(phase=phase):
                def failpoint(point: str, expected: str = phase) -> None:
                    if point == expected:
                        raise RuntimeError(expected)
                with self.assertRaises(RuntimeError):
                    CurationOperationOwner(self.catalog, test_failpoint=failpoint).undo(
                        record.id, handler,
                    )
                self.assertEqual(self.state(), ("fr", '"fr"', 1))


if __name__ == "__main__":
    unittest.main()
