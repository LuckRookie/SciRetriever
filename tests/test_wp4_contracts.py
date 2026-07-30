from pathlib import Path
import json
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from uuid import uuid4

from sqlalchemy.exc import IntegrityError

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    ArtifactRegistration, ArtifactRepository, CurrentAnalysisRepository,
    ExternalParserAttemptRepository, IdentityResolver, ProcessingRunRepository,
    canonical_json, create_catalog_engine, initialize_catalog,
)
from sciretriever.core.enums import ProcessingStage
from sciretriever.core.derivation import canonical_sha256
from sciretriever.errors import CatalogError


class WP4CatalogContractTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.catalog = create_catalog_engine(Path(self.temporary.name) / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.work_version_id = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1/wp4"}).work_version.id
        self.raw_id = str(uuid4())
        sha = "a" * 64
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (self.raw_id, sha, f"raw/aa/{sha}", "application/pdf", "pdf", 12, "{}"),
            )

    def _register_artifacts(self, parser_kind: str = "mineru_parser", source_map_kind: str = "mineru_source_map"):
        parser_hash = uuid4().hex * 2
        source_map_hash = uuid4().hex * 2
        analysis_hash = uuid4().hex * 2
        parser_id = str(uuid4())
        source_map_id = str(uuid4())
        return ArtifactRepository(self.catalog).register_pair_after_publication(
            self.work_version_id,
            self.raw_id,
            (
                ArtifactRegistration(parser_id, parser_kind, "1", f"derived/{parser_kind}/aa/{uuid4()}", parser_hash, "application/vnd.sciretriever.mineru-parser.v1+json", 10, {"service": "mineru"}),
                ArtifactRegistration(source_map_id, source_map_kind, "1", f"derived/{source_map_kind}/bb/{uuid4()}", source_map_hash, "application/vnd.sciretriever.mineru-source-map.v1+json", 10,
                                     {"parser_artifact_id": parser_id, "parser_artifact_sha256": parser_hash,
                                      "input_raw_asset_id": self.raw_id, "input_raw_asset_sha256": "a" * 64,
                                      "source_map_artifact_sha256": source_map_hash}),
                ArtifactRegistration(str(uuid4()), "analysis", "1", f"derived/analysis/cc/{uuid4()}", analysis_hash, "application/vnd.sciretriever.analysis.v1+json", 11, {"provider": "neutral"}),
            ),
        )

    def _succeeded_analysis_run(self, source_map_id: str, analysis_id: str, *, producer: str = "sciretriever.analysis"):
        runs = ProcessingRunRepository(self.catalog)
        parameters = {"schema_version": "1", "provider": "fixture", "model": "fixture",
                      "schema_sha256": "a" * 64, "provider_sha256": "b" * 64, "model_sha256": "c" * 64,
                      "configuration_sha256": "d" * 64, "input_sha256": "e" * 64,
            "document_hash_algorithm": "canonical_sha256", "max_completion_tokens": 100,
            "target_revision": 1}
        run = runs.claim_or_resume(
            self.work_version_id,
            ProcessingStage.ANALYSIS,
            producer,
            "1",
            parameters,
            input_raw_asset_ids=(self.raw_id,), input_artifact_ids=(source_map_id,),
        )
        return runs.succeed(run.id, output_artifact_ids=(analysis_id,))

    def _content(self, parser_id: str, source_map_id: str):
        evidence_id = str(uuid4())
        locator = {"evidence_id": evidence_id, "raw_asset_id": self.raw_id, "raw_asset_sha256": "a" * 64,
                   "parser_artifact_id": parser_id, "source_map_artifact_id": source_map_id,
                   "source_unit_id": str(uuid4()), "page_index": 0,
                   "structural_span_path": "/pdf_info/0/para_blocks/0/lines/0/spans/0",
                   "bbox": [0.0, 0.0, 1.0, 1.0], "source_start": 0, "source_end": 1,
                   "document_start": 0, "document_end": 1}
        sections = [{"section_id": name, "heading": name, "content": "content", "insufficient_evidence": False,
                     "evidence_ids": [evidence_id], "locators": [locator]} for name in (
            "document_information", "abstract", "research_background", "research_question_and_objectives",
            "research_approach", "methods", "data_and_materials", "results", "conclusion", "limitations")]
        return {"sections": sections, "canonical_fields": [], "references": [], "generated_tags": [],
                "new_tag_proposals": [], "new_entity_proposals": [], "evidence": [locator]}

    def _bind_provenance(self, artifact_id: str, content: object, run_id: str,
                         parser_id: str, source_map_id: str) -> dict[str, object]:
        provenance: dict[str, object] = {"document_sha256": canonical_sha256(content), "analysis_run_id": run_id,
            "schema_version": "1", "raw_asset_id": self.raw_id, "parser_artifact_id": parser_id,
            "source_map_artifact_id": source_map_id}
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE normalized_artifacts SET provenance_json = ? WHERE id = ?",
                                       (canonical_json(provenance), artifact_id))
        return provenance

    def test_fresh_schema_has_wp4_tables_columns_and_active_attempt_index(self) -> None:
        with self.catalog.connect() as connection:
            tables = {row[0] for row in connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'")}
            attempt_columns = {row[1] for row in connection.exec_driver_sql('PRAGMA table_info("external_parser_attempts")')}
            current_columns = {row[1] for row in connection.exec_driver_sql('PRAGMA table_info("current_analyses")')}
            indexes = {row[1]: bool(row[2]) for row in connection.exec_driver_sql('PRAGMA index_list("external_parser_attempts")')}
        self.assertTrue({"external_parser_attempts", "current_analyses", "provider_canonical_projections",
                         "manual_metadata_overrides", "generated_work_version_metadata"}.issubset(tables))
        self.assertTrue({"processing_run_id", "sequence", "state", "external_task_id", "metadata_json"}.issubset(attempt_columns))
        self.assertTrue({"work_version_id", "revision", "parser_artifact_id", "analysis_artifact_id", "content_json", "provenance_json"}.issubset(current_columns))
        self.assertTrue(indexes["uq_external_parser_attempts_active_run"])

    def test_external_attempts_are_sequenced_under_one_parsing_run(self) -> None:
        run = ProcessingRunRepository(self.catalog).claim_or_resume(
            self.work_version_id, ProcessingStage.PARSING, "mineru", "3.4.4", {"backend": "vlm-engine"}, input_raw_asset_ids=(self.raw_id,)
        )
        attempts = ExternalParserAttemptRepository(self.catalog)
        first_task_id = str(uuid4())
        second_task_id = str(uuid4())
        first = attempts.create(run.id, {"reason": "initial"}, external_task_id=first_task_id)
        with self.assertRaisesRegex(CatalogError, "already has an active"):
            ExternalParserAttemptRepository(self.catalog).create(run.id, {"reason": "replay"})
        with self.assertRaises(IntegrityError):
            with self.catalog.transaction() as connection:
                connection.exec_driver_sql(
                    "INSERT INTO external_parser_attempts (id, processing_run_id, sequence, state, metadata_json) VALUES (?, ?, ?, 'active', '{}')",
                    (str(uuid4()), run.id, 2),
                )
        attempts.finish(first.id, "expired")
        second = attempts.create(run.id, {"reason": "remote_404"}, external_task_id=second_task_id)
        self.assertEqual((first.sequence, second.sequence), (1, 2))
        self.assertEqual(
            [item.external_task_id for item in attempts.list_for_run(run.id)],
            [first_task_id, second_task_id],
        )
        self.assertNotIn(first_task_id, json.loads(first.metadata_json).values())

    def test_external_attempt_create_rejects_malformed_task_id_before_insert(self) -> None:
        run = ProcessingRunRepository(self.catalog).claim_or_resume(
            self.work_version_id, ProcessingStage.PARSING, "mineru", "3.4.4",
            {"backend": "vlm-engine"}, input_raw_asset_ids=(self.raw_id,),
        )
        attempts = ExternalParserAttemptRepository(self.catalog)

        with self.assertRaisesRegex(ValueError, "canonical lowercase UUID"):
            attempts.create(run.id, {"reason": "initial"}, external_task_id="task-1")

        self.assertEqual(attempts.list_for_run(run.id), ())

    def test_current_analysis_replacement_is_atomic_and_has_no_history(self) -> None:
        artifacts = self._register_artifacts()
        run = self._succeeded_analysis_run(artifacts[1].id, artifacts[2].id)
        repository = CurrentAnalysisRepository(self.catalog)
        content = self._content(artifacts[0].id, artifacts[1].id)
        provenance = self._bind_provenance(artifacts[2].id, content, run.id, artifacts[0].id, artifacts[1].id)
        first = repository.replace(self.work_version_id, run.id, artifacts[0].id, artifacts[2].id, content, provenance, projection={"title": "title"}, expected_current_id=None, expected_revision=0)
        self.assertEqual(json.loads(first.content_json), content)
        with self.assertRaisesRegex(CatalogError, "lineage"):
            repository.replace(self.work_version_id, run.id, artifacts[0].id, artifacts[2].id, content, provenance, projection={"title": "title"}, expected_current_id=first.id, expected_revision=1)
        with self.assertRaises(CatalogError):
            repository.replace(self.work_version_id, run.id, artifacts[0].id, artifacts[2].id, content, provenance, expected_current_id=first.id, expected_revision=1)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM current_analyses").scalar_one(), 1)
            self.assertNotIn("analysis_history", {row[0] for row in connection.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'")})

    def test_current_analysis_rejects_wrong_artifact_kind_and_unbound_lineage(self) -> None:
        generic_artifacts = self._register_artifacts("normalized_content")
        generic_run = self._succeeded_analysis_run(generic_artifacts[1].id, generic_artifacts[2].id)
        repository = CurrentAnalysisRepository(self.catalog)
        with self.assertRaisesRegex(CatalogError, "MinerU parser"):
            repository.replace(
                self.work_version_id, generic_run.id, generic_artifacts[0].id,
                generic_artifacts[2].id, self._content(generic_artifacts[0].id, generic_artifacts[1].id), {}, expected_current_id=None, expected_revision=0,
            )

        bound_artifacts = self._register_artifacts()
        unrelated_artifacts = self._register_artifacts()
        bound_run = self._succeeded_analysis_run(bound_artifacts[1].id, bound_artifacts[2].id)
        with self.assertRaisesRegex(CatalogError, "lineage"):
            repository.replace(
                self.work_version_id, bound_run.id, bound_artifacts[0].id,
                unrelated_artifacts[2].id, self._content(bound_artifacts[0].id, bound_artifacts[1].id), {}, expected_current_id=None, expected_revision=0,
            )

    def test_current_analysis_rejects_wrong_run_producer_schema_and_media(self) -> None:
        repository = CurrentAnalysisRepository(self.catalog)
        producer_artifacts = self._register_artifacts()
        producer_run = self._succeeded_analysis_run(producer_artifacts[1].id, producer_artifacts[2].id, producer="wrong")
        with self.assertRaisesRegex(CatalogError, "lineage"):
            repository.replace(self.work_version_id, producer_run.id, producer_artifacts[0].id, producer_artifacts[2].id,
                self._content(producer_artifacts[0].id, producer_artifacts[1].id), {}, expected_current_id=None, expected_revision=0)

        for column, value in (("schema_version", "2"), ("media_type", "application/json")):
            artifacts = self._register_artifacts()
            run = self._succeeded_analysis_run(artifacts[1].id, artifacts[2].id)
            with self.catalog.transaction() as connection:
                connection.exec_driver_sql(f"UPDATE normalized_artifacts SET {column} = ? WHERE id = ?", (value, artifacts[2].id))
            with self.subTest(column=column), self.assertRaisesRegex(CatalogError, "artifacts"):
                repository.replace(self.work_version_id, run.id, artifacts[0].id, artifacts[2].id,
                    self._content(artifacts[0].id, artifacts[1].id), {}, expected_current_id=None, expected_revision=0)


if __name__ == "__main__":
    import unittest
    unittest.main()
