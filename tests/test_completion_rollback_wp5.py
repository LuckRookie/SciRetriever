from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from uuid import uuid4

from sciretriever.analysis import AnalysisService
from sciretriever.catalog import (
    CurrentAnalysisRepository,
    IdentityResolver,
    MetadataIngestionObservation,
    TagRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.config import MinerUConfig
from sciretriever.core.contracts import Identifier
from sciretriever.normalization import MinerUParsingService, MinerUSourceMapService
from sciretriever.storage import DerivedArtifactStore, RawAssetStore

from test_analysis_wp44 import FixtureProvider
from test_mineru_wp43 import CompletedClient, archive_bytes, middle_value, pdf_bytes


class CompletionRollbackTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-wp5-rollback-")
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.catalog = create_catalog_engine(root / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.work_version_id = IdentityResolver(self.catalog).create_or_reuse_work(
            {"doi": "10.1234/wp5-rollback"}
        ).work_version.id
        storage = root / "storage"
        storage.mkdir()
        self.raw_store = RawAssetStore(storage)
        self.derived_store = DerivedArtifactStore(storage)
        pdf = pdf_bytes()
        staged = self.raw_store.stage(BytesIO(pdf), intent_id=str(uuid4()))
        published = self.raw_store.publish(staged)
        self.raw_store.remove_staged(staged)
        self.raw_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) "
                "VALUES (?, ?, ?, 'application/pdf', 'pdf', ?, '{}')",
                (self.raw_id, published.sha256, published.storage_path, published.byte_size),
            )
            connection.exec_driver_sql(
                "INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) "
                "VALUES (?, ?, 'primary_pdf')",
                (self.work_version_id, self.raw_id),
            )
        parsed = MinerUParsingService(
            self.catalog, self.derived_store,
            MinerUConfig(model="operator/model@fixture", poll_interval=0.01),
            CompletedClient(archive_bytes(middle_value())), sleep=lambda _: None,
        ).run(self.work_version_id, self.raw_id, pdf)
        self.source = MinerUSourceMapService(
            self.catalog, self.raw_store, self.derived_store
        ).run(self.work_version_id, parsed)

    def service(self, model: str, mutate=None) -> AnalysisService:
        return AnalysisService(
            self.catalog, self.derived_store, FixtureProvider(model, mutate=mutate),
            configuration={"profile": model},
        )

    def state_bytes(self) -> bytes:
        statements = (
            ("work_versions", "SELECT title, abstract, language FROM work_versions WHERE id = ?", (self.work_version_id,)),
            ("current", "SELECT * FROM current_analyses WHERE work_version_id = ?", (self.work_version_id,)),
            ("metadata", "SELECT * FROM generated_work_version_metadata WHERE work_version_id = ? ORDER BY field_name", (self.work_version_id,)),
            ("references", "SELECT * FROM version_references WHERE citing_work_version_id = ? ORDER BY reference_order, id", (self.work_version_id,)),
            ("tags", "SELECT * FROM generated_work_version_tags WHERE work_version_id = ? ORDER BY tag_id", (self.work_version_id,)),
            ("runs", "SELECT * FROM processing_runs WHERE id = (SELECT processing_run_id FROM current_analyses WHERE work_version_id = ?)", (self.work_version_id,)),
            ("artifacts", "SELECT * FROM normalized_artifacts WHERE id = (SELECT analysis_artifact_id FROM current_analyses WHERE work_version_id = ?)", (self.work_version_id,)),
        )
        with self.catalog.connect() as connection:
            state = [(name, [tuple(row) for row in connection.exec_driver_sql(sql, params).all()])
                     for name, sql, params in statements]
        return json.dumps(state, ensure_ascii=False, separators=(",", ":")).encode()

    @staticmethod
    def rich_output(tag_id: str, title: str, reference: str):
        def mutate(value, source):
            evidence = source["source_units"][0]["evidence_id"]
            value["canonical_fields"] = [
                {"field_name": "title", "value": title, "evidence_ids": [evidence]},
                {"field_name": "language", "value": "zh", "evidence_ids": [evidence]},
            ]
            value["references"] = [{
                "order": 0, "raw_reference": reference, "resolved_work_id": None,
                "identifier_namespace": None, "identifier_value": None,
                "evidence_ids": [evidence],
            }]
            value["generated_tags"] = [{"tag_id": tag_id, "evidence_ids": [evidence]}]
        return mutate

    def test_each_atomic_subwrite_failure_restores_all_catalog_rows(self) -> None:
        first_tag = TagRepository(self.catalog).add("first")
        second_tag = TagRepository(self.catalog).add("second")
        first = self.service(
            "fixture-v1", self.rich_output(first_tag.id, "Generated one", "Reference one")
        )
        first.run(self.work_version_id, self.source)
        current = first.current.get(self.work_version_id)
        if current is None:
            self.fail("current analysis is missing")
        before = self.state_bytes()
        for index, failpoint in enumerate(CurrentAnalysisRepository.PROMOTION_FAILPOINTS):
            with self.subTest(failpoint=failpoint):
                service = self.service(
                    f"fixture-fail-{index}",
                    self.rich_output(second_tag.id, "Generated two", "Reference two"),
                )

                def inject(point: str, expected: str = failpoint) -> None:
                    if point == expected:
                        raise RuntimeError(f"injected:{point}")

                service.current = CurrentAnalysisRepository(
                    self.catalog, test_failpoint=inject
                )
                with self.assertRaisesRegex(RuntimeError, f"injected:{failpoint}"):
                    service.run(
                        self.work_version_id, self.source,
                        expected_current_id=current.id,
                        expected_revision=current.revision, force=True,
                    )
                self.assertEqual(self.state_bytes(), before)

    def test_empty_promotion_and_manual_generated_provider_precedence(self) -> None:
        WorkRepository(self.catalog).ingest_metadata_batch(
            title="Provider title",
            identifiers_to_persist=(Identifier("doi", "10.1234/wp5-rollback"),),
            observations=(MetadataIngestionObservation(
                "fixture", "provider-record",
                (("title", "Provider title"), ("language", "en")),
                (("provider", "fixture"),),
            ),),
            provider_precedence=("fixture",),
        )
        self.service("fixture-generated").run(self.work_version_id, self.source)
        with self.catalog.connect() as connection:
            row = connection.exec_driver_sql(
                "SELECT title, abstract, language FROM work_versions WHERE id = ?",
                (self.work_version_id,),
            ).one()
        self.assertEqual(row, ("Provider title", "原文摘要", "en"))
        from manual_curation_fixture import set_manual_metadata
        set_manual_metadata(self.catalog, self.work_version_id, "abstract", "Manual abstract")
        with self.catalog.connect() as connection:
            abstract = connection.exec_driver_sql(
                "SELECT abstract FROM work_versions WHERE id = ?", (self.work_version_id,)
            ).scalar_one()
        self.assertEqual(abstract, "Manual abstract")


if __name__ == "__main__":
    unittest.main()
