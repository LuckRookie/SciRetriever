from __future__ import annotations

from dataclasses import replace
from copy import deepcopy
from io import BytesIO
import hashlib
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4
import zipfile

from PyPDF2 import PdfWriter

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import IdentityResolver, create_catalog_engine, initialize_catalog
from sciretriever.config import MinerUConfig
from sciretriever.errors import NormalizationError
from sciretriever.normalization import (
    MINERU_SOURCE_MAP_KIND,
    MinerUParsingService,
    MinerUResult,
    MinerUResultState,
    MinerUSourceMapService,
    MinerUTask,
    MinerUTaskStatus,
    SourceUnit,
)
from sciretriever.storage import DerivedArtifactStore, RawAssetStore


TASK_ID = "11111111-1111-4111-8111-111111111111"


def pdf_bytes(*, second_page: bool = True) -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=300)
    if second_page:
        writer.add_blank_page(width=300, height=200)
        writer.pages[-1].rotation = 90
    output = BytesIO()
    writer.write(output)
    return output.getvalue()


def middle_value(*, pages: int = 2, first_size: tuple[float, float] = (200, 300), bad_bbox: bool = False) -> dict[str, object]:
    first_right = 220 if bad_bbox else 80
    values: list[dict[str, object]] = [{
        "page_idx": 0,
        "page_size": list(first_size),
        "para_blocks": [{
            "bbox": [10, 10, 180, 100],
            "type": "text",
            "blocks": [{
                "bbox": [10, 10, 180, 100],
                "lines": [{
                    "bbox": [10, 10, 180, 30],
                    "spans": [
                        {"bbox": [10, 10, first_right, 30], "type": "text", "content": "原文 alpha"},
                        {"bbox": [85, 10, 150, 30], "type": "formula", "content": "E=mc²"},
                    ],
                }],
            }],
            "lines": [{
                "bbox": [10, 50, 180, 80],
                "spans": [{"bbox": [10, 50, 180, 80], "type": "formula", "html": "<math>x+y</math>"}],
            }],
        }, {
            "bbox": [10, 110, 30, 130],
            "type": "image",
            "lines": [{"bbox": [10, 110, 30, 130], "spans": [{"bbox": [10, 110, 30, 130], "type": "image"}]}],
        }],
        "discarded_blocks": [],
    }]
    if pages == 2:
        values.append({
            "page_idx": 1, "page_size": [200, 300],
            "para_blocks": [{
                "bbox": [5, 5, 100, 25], "type": "text",
                "lines": [{"bbox": [5, 5, 100, 25], "spans": [{"bbox": [5, 5, 100, 25], "content": "second"}]}],
            }], "discarded_blocks": [],
        })
    return {"_backend": "vlm", "_version_name": "3.4.4", "pdf_info": values}


def archive_bytes(middle: dict[str, object]) -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("doc_middle.json", json.dumps(middle, ensure_ascii=False, separators=(",", ":")).encode())
        archive.writestr("doc_model.json", b'{"model":"fixture"}')
        archive.writestr("doc_content_list.json", b"[]")
    return output.getvalue()


class CompletedClient:
    def __init__(self, archive: bytes) -> None:
        self.archive = archive

    def health(self, timeout: float):
        return None

    def submit(self, filename: str, pdf: bytes, timeout: float) -> MinerUTask:
        return MinerUTask(TASK_ID, MinerUTaskStatus.PENDING)

    def status(self, task_id: str, timeout: float) -> MinerUTask:
        return MinerUTask(task_id, MinerUTaskStatus.COMPLETED)

    def result(self, task_id: str, timeout: float) -> MinerUResult:
        return MinerUResult(MinerUResultState.COMPLETED, self.archive)


class MinerUSourceMapTests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.catalog = create_catalog_engine(root / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.work_id = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1/wp43"}).work_version.id
        storage = root / "storage"
        storage.mkdir()
        self.raw_store = RawAssetStore(storage)
        self.derived_store = DerivedArtifactStore(storage)
        self.pdf = pdf_bytes()
        staged = self.raw_store.stage(BytesIO(self.pdf), intent_id=str(uuid4()))
        published = self.raw_store.publish(staged)
        self.raw_store.remove_staged(staged)
        self.raw_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, '{}')",
                (self.raw_id, published.sha256, published.storage_path, "application/pdf", "pdf", published.byte_size),
            )
            connection.exec_driver_sql(
                "INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) VALUES (?, ?, 'primary_pdf')",
                (self.work_id, self.raw_id),
            )

    def parse(self, middle: dict[str, object]):
        config = MinerUConfig(model="operator/model@fixture", poll_interval=0.01)
        return MinerUParsingService(
            self.catalog, self.derived_store, config, CompletedClient(archive_bytes(middle)), sleep=lambda _: None,
        ).run(self.work_id, self.raw_id, self.pdf)

    def test_nested_units_offsets_geometry_lineage_provenance_and_replay_are_deterministic(self) -> None:
        parsed = self.parse(middle_value())
        service = MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store)
        first = service.run(self.work_id, parsed)
        with patch.object(service, "_build", side_effect=AssertionError("rebuilt")):
            replay = service.run(self.work_id, parsed)
        self.assertEqual(first, replay)
        source_map = first.source_map
        self.assertEqual(first.artifact.kind, MINERU_SOURCE_MAP_KIND)
        self.assertEqual([unit.text for unit in source_map.source_units], ["原文 alpha", "E=mc²", "<math>x+y</math>", "second"])
        self.assertEqual([unit.document_start for unit in source_map.source_units], [0, 8, 13, 29])
        self.assertEqual([unit.document_end for unit in source_map.source_units], [8, 13, 29, 35])
        self.assertEqual(source_map.source_units[0].structural_span_path, "/pdf_info/0/para_blocks/0/blocks/0/lines/0/spans/0")
        self.assertEqual(source_map.source_units[2].structural_span_path, "/pdf_info/0/para_blocks/0/lines/0/spans/0")
        self.assertEqual(source_map.page_geometry[1].to_dict(), {"page_index": 1, "width": 200.0, "height": 300.0})
        self.assertEqual(source_map.raw_asset_sha256, hashlib.sha256(self.pdf).hexdigest())
        self.assertTrue(all(unit.extraction_method == "mineru_vlm" for unit in source_map.source_units))
        self.assertEqual([item.source_unit_id for item in source_map.evidence], [item.unit_id for item in source_map.source_units])
        provenance = json.loads(first.artifact.provenance_json)
        self.assertEqual(provenance["service_version"], "3.4.4")
        self.assertEqual(provenance["api_protocol"], 2)
        self.assertEqual(provenance["backend"], "vlm-engine")
        self.assertEqual(provenance["model_identity"], "operator_attested")
        self.assertEqual(provenance["source_map_artifact_sha256"], first.artifact.sha256)
        self.assertIsNotNone(first.run.details_json)
        self.assertEqual(json.loads(first.run.details_json or "{}")["input_artifact_ids"], [parsed.parser_artifact.id])
        self.assertEqual((replay.run.id, replay.artifact.id), (first.run.id, first.artifact.id))
        replay_provenance = json.loads(replay.artifact.provenance_json)
        self.assertEqual(replay_provenance, provenance)
        publication = self.derived_store.find_published(first.artifact.kind, first.artifact.id)
        self.assertIsNotNone(publication)
        if publication is None:
            self.fail("source map publication is missing")
        self.assertNotIn(first.artifact.sha256.encode(), self.derived_store.read_verified(publication))

    def test_missing_primary_pdf_link_is_rejected_without_source_map(self) -> None:
        parsed = self.parse(middle_value())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("DELETE FROM work_version_assets WHERE work_version_id = ?", (self.work_id,))
        with self.assertRaisesRegex(NormalizationError, "exactly one primary PDF"):
            MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store).run(self.work_id, parsed)
        other_pdf = pdf_bytes(second_page=False)
        staged = self.raw_store.stage(BytesIO(other_pdf), intent_id=str(uuid4()))
        published = self.raw_store.publish(staged)
        self.raw_store.remove_staged(staged)
        other_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, '{}')",
                (other_id, published.sha256, published.storage_path, "application/pdf", "pdf", published.byte_size),
            )
            connection.exec_driver_sql(
                "INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) VALUES (?, ?, 'primary_pdf')",
                (self.work_id, other_id),
            )
        with self.assertRaisesRegex(NormalizationError, "parser artifact"):
            MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store).run(self.work_id, parsed)
        self.assertFalse(any(item.kind == MINERU_SOURCE_MAP_KIND for item in MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store).artifacts.list_for_work(self.work_id)))

    def test_page_count_size_and_bbox_mismatches_are_rejected(self) -> None:
        parsed = self.parse(middle_value())
        service = MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store)
        verified = service._validate_inputs(self.work_id, parsed)
        fixtures = (
            (middle_value(pages=1), "page count"),
            (middle_value(first_size=(201, 300)), "page size"),
            (middle_value(bad_bbox=True), "bbox"),
        )
        for index, (middle, message) in enumerate(fixtures):
            with self.subTest(case=index):
                with self.assertRaisesRegex(NormalizationError, message):
                    service._build(replace(verified, middle=middle))

        no_text = middle_value()
        pages = no_text["pdf_info"]
        if not isinstance(pages, list):
            self.fail("fixture pages are invalid")
        for page in pages:
            if not isinstance(page, dict):
                self.fail("fixture page is invalid")
            page["para_blocks"] = []
        with self.assertRaisesRegex(NormalizationError, "no textual source units"):
            service._build(replace(verified, middle=no_text))

    def test_failed_geometry_construction_marks_run_failed_without_publication_or_current_mutation(self) -> None:
        parsed = self.parse(middle_value(first_size=(201, 300)))
        service = MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store)
        with self.catalog.connect() as connection:
            current_before = connection.exec_driver_sql("SELECT count(*) FROM current_analyses").scalar_one()
        with self.assertRaisesRegex(NormalizationError, "page size"):
            service.run(self.work_id, parsed)
        with self.catalog.connect() as connection:
            normalization = connection.exec_driver_sql(
                "SELECT state, output_artifact_id FROM processing_runs WHERE stage = 'normalization'"
            ).one()
            current_after = connection.exec_driver_sql("SELECT count(*) FROM current_analyses").scalar_one()
        self.assertEqual(normalization, ("failed", None))
        self.assertEqual(current_after, current_before)
        self.assertFalse(any(item.kind == MINERU_SOURCE_MAP_KIND for item in service.artifacts.list_for_work(self.work_id)))

    def test_parser_raw_association_is_rejected_and_transient_archive_mutation_is_ignored(self) -> None:
        parsed = self.parse(middle_value())
        service = MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store)
        wrong_parser = replace(parsed.parser_artifact, raw_asset_id=str(uuid4()))
        with self.assertRaisesRegex(NormalizationError, "parser artifact"):
            service.run(self.work_id, replace(parsed, parser_artifact=wrong_parser))
        mutated_payload = b"x" * len(parsed.archive.middle.payload)
        changed_middle = replace(
            parsed.archive.middle,
            payload=mutated_payload,
            sha256=hashlib.sha256(mutated_payload).hexdigest(),
        )
        mutated = replace(parsed, archive=replace(parsed.archive, middle=changed_middle))
        result = service.run(self.work_id, mutated)
        self.assertEqual(result.source_map.source_units[0].text, "原文 alpha")
        publication = self.derived_store.find_published(result.artifact.kind, result.artifact.id)
        self.assertIsNotNone(publication)
        if publication is None:
            self.fail("source map publication is missing")
        self.assertNotIn(mutated_payload, self.derived_store.read_verified(publication))

    def test_parser_outputs_and_passed_supporting_records_must_exactly_match_catalog(self) -> None:
        parsed = self.parse(middle_value())
        service = MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store)
        changed_support = replace(parsed.supporting_artifacts[0], media_type="application/xml")
        with self.assertRaisesRegex(NormalizationError, "does not match the catalog"):
            service.run(
                self.work_id,
                replace(parsed, supporting_artifacts=(changed_support, *parsed.supporting_artifacts[1:])),
            )

        details = json.loads(parsed.run.details_json or "{}")
        details["output_artifact_ids"].append(str(uuid4()))
        details_json = json.dumps(details, ensure_ascii=True, allow_nan=False, separators=(",", ":"), sort_keys=True)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE processing_runs SET details_json = ? WHERE id = ?",
                (details_json, parsed.run.id),
            )
        changed_run = service.runs.get(parsed.run.id)
        self.assertIsNotNone(changed_run)
        if changed_run is None:
            self.fail("parsing run is missing")
        with self.assertRaisesRegex(NormalizationError, "outputs are incomplete"):
            service.run(self.work_id, replace(parsed, run=changed_run))

    def test_malformed_serialized_replay_is_fail_closed(self) -> None:
        parsed = self.parse(middle_value())
        service = MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store)
        first = service.run(self.work_id, parsed)
        publication = self.derived_store.find_published(first.artifact.kind, first.artifact.id)
        self.assertIsNotNone(publication)
        if publication is None:
            self.fail("source map publication is missing")
        original_read = self.derived_store.read_verified
        original_value = json.loads(original_read(publication))

        malformed_values = []
        unknown = deepcopy(original_value)
        unknown["unknown"] = True
        malformed_values.append(unknown)
        boolean_offset = deepcopy(original_value)
        boolean_offset["source_units"][0]["source_start"] = False
        malformed_values.append(boolean_offset)
        bbox_object = deepcopy(original_value)
        bbox_object["evidence"][0]["bbox"] = {"left": 10.0}
        malformed_values.append(bbox_object)
        bad_path = deepcopy(original_value)
        bad_path["source_units"][0]["structural_span_path"] = "/pdf_info/0/not-a-span"
        malformed_values.append(bad_path)
        noncontiguous = deepcopy(original_value)
        noncontiguous["source_units"][1]["document_start"] += 1
        malformed_values.append(noncontiguous)

        for index, malformed in enumerate(malformed_values):
            payload = json.dumps(malformed, ensure_ascii=False, allow_nan=False, separators=(",", ":"), sort_keys=True).encode()

            def read(publication_value, *, corrupt=payload):
                if publication_value.kind == MINERU_SOURCE_MAP_KIND:
                    return corrupt
                return original_read(publication_value)

            with self.subTest(case=index), patch.object(self.derived_store, "read_verified", side_effect=read):
                with self.assertRaises(NormalizationError):
                    service.run(self.work_id, parsed)

    def test_successful_replay_rejects_provenance_and_run_identity_tampering(self) -> None:
        parsed = self.parse(middle_value())
        service = MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store)
        first = service.run(self.work_id, parsed)
        provenance = json.loads(first.artifact.provenance_json)
        provenance["source_map_artifact_sha256"] = "0" * 64
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE normalized_artifacts SET provenance_json = ? WHERE id = ?",
                (json.dumps(provenance, ensure_ascii=True, separators=(",", ":"), sort_keys=True), first.artifact.id),
            )
        with self.assertRaisesRegex(NormalizationError, "provenance lineage"):
            service.run(self.work_id, parsed)
        with self.assertRaisesRegex(NormalizationError, "run lineage"):
            service._load_success(replace(first.run, work_version_id=str(uuid4())))

        provenance = json.loads(first.artifact.provenance_json)
        provenance["parser_configuration"]["model"] = "tampered"
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE normalized_artifacts SET provenance_json = ? WHERE id = ?",
                (json.dumps(provenance, ensure_ascii=True, separators=(",", ":"), sort_keys=True), first.artifact.id),
            )
        with self.assertRaisesRegex(NormalizationError, "provenance lineage"):
            service.run(self.work_id, parsed)

    def test_generic_source_unit_cannot_masquerade_as_mineru_pdf_evidence(self) -> None:
        generic = SourceUnit(str(uuid4()), self.raw_id, 0, "text", "/pdf/page/0")
        self.assertFalse(hasattr(generic, "bbox"))
        self.assertFalse(hasattr(generic, "extraction_method"))
        self.assertNotEqual(MINERU_SOURCE_MAP_KIND, "source_map")


if __name__ == "__main__":
    import unittest
    unittest.main()
