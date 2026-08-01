import hashlib
import json
import sys
import unicodedata
from dataclasses import FrozenInstanceError, fields, replace
from pathlib import Path
from unittest import TestCase

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole, PackageQuality, ProcessingStage
from sciretriever.core.package import (
    ANALYSIS_SECTION_IDS, SOURCE_MAP_KIND, SOURCE_MAP_MEDIA_TYPE, AnalysisProvenanceSnapshot,
    AnalysisReferenceSnapshot, AnalysisSectionSnapshot, ArtifactRecord, CanonicalFieldSnapshot,
    CurrentAnalysisSnapshot, DocumentPackageVersion, EvidenceLocator, FileRecord, GeneratedTagSnapshot,
    Lineage, NewTagProposalSnapshot, NormalizedContent, PdfAnalysisLocator, ReferenceRecord,
    SectionRecord, SourceProvenance, TableCell, TableRecord, canonical_json,
)
from sciretriever.core import ids, timestamps

UUIDS = tuple(f"00000000-0000-4000-8000-{index:012x}" for index in range(1, 80))
SHA_A = "a" * 64
SHA_B = "b" * 64
NOW = "2026-07-20T12:00:00Z"
LATER = "2026-07-20T12:00:01Z"


class PackageTests(TestCase):
    def make_package(self, reverse=False):
        file = FileRecord(UUIDS[1], AssetRole.PRIMARY_PDF, "application/pdf", "raw/document.pdf", SHA_A, 42)
        provenance = SourceProvenance(UUIDS[2], file.file_id, "provider", "download", "agent", NOW, NOW)
        source_map = ArtifactRecord(UUIDS[7], SOURCE_MAP_KIND, SOURCE_MAP_MEDIA_TYPE, "derived/map.json", SHA_B, 12)
        normalized = ArtifactRecord(UUIDS[8], "normalized_content", "application/json", "derived/content.json", SHA_A, 30)
        content = NormalizedContent(normalized.artifact_id,
            (SectionRecord(UUIDS[3], None, 0, "Cafe\u0301", "Alpha\r\nbeta"),),
            (TableRecord(UUIDS[4], 0, "Values", (TableCell(0, 0, "A", True),), UUIDS[3], "Note"),),
            (ReferenceRecord(UUIDS[5], 0, "Citation", (Identifier("doi", "10.1/x"),)),))
        targets = (("/sections/0/title", content.sections[0].title), ("/sections/0/text", content.sections[0].text),
            ("/tables/0/caption", "Values"), ("/tables/0/notes", "Note"),
            ("/tables/0/cells/0/text", "A"), ("/references/0/text", "Citation"))
        evidence = tuple(EvidenceLocator(UUIDS[20 + i], file.file_id, source_map.artifact_id,
            f"unit-{i}", 0, len(text or ""), path, 0, len(text or "")) for i, (path, text) in enumerate(targets))
        run = UUIDS[40]
        lineage = (
            Lineage(UUIDS[41], run, ProcessingStage.RAW_ACCEPTANCE, "accept", "1", NOW, NOW, (), (), (file.file_id,), (), SHA_A),
            Lineage(UUIDS[42], run, ProcessingStage.NORMALIZATION, "normalize", "1", NOW, NOW,
                (file.file_id,), (), (), (source_map.artifact_id, normalized.artifact_id), SHA_A),
            Lineage(UUIDS[43], run, ProcessingStage.PACKAGE_VALIDATION, "validate", "1", NOW, NOW,
                (), (source_map.artifact_id, normalized.artifact_id), (), (), SHA_A),
            Lineage(UUIDS[44], run, ProcessingStage.PUBLICATION, "publish", "1", NOW, NOW,
                (), (source_map.artifact_id, normalized.artifact_id), (), (), SHA_A),
        )
        if reverse:
            evidence, lineage = tuple(reversed(evidence)), tuple(reversed(lineage))
        return DocumentPackageVersion.create(document_id=UUIDS[0], package_version=1, published_at=NOW,
            quality=PackageQuality.PDF_BACKED, limitations=(), identifiers=(Identifier("doi", "10.1/x"),),
            source_provenance=(provenance,), files=(file,), normalized_content=content, evidence=evidence,
            current_analysis=None, artifacts=(source_map, normalized), lineage=lineage)

    def locator(self, evidence_id=UUIDS[60]):
        return PdfAnalysisLocator(evidence_id, UUIDS[1], SHA_A, UUIDS[6], UUIDS[7], "unit", 0,
            "/pdf_info/0/para_blocks/0/lines/0/spans/0", (0.0, 0.0, 1.0, 1.0), 0, 1, 0, 1)

    def snapshot(self):
        locator = self.locator()
        sections = tuple(AnalysisSectionSnapshot(name, name, "content", False,
            (locator.evidence_id,), (locator,)) for name in ANALYSIS_SECTION_IDS)
        document = {"sections": [item.to_dict() for item in sections], "canonical_fields": [],
            "references": [], "generated_tags": [], "new_tag_proposals": [], "new_entity_proposals": [],
            "evidence": [locator.to_dict()]}
        values = {"analysis_run_id": UUIDS[10], "provider": "fixture", "model": "fixture-v1",
            "schema_version": "1", "schema_sha256": SHA_A, "provider_sha256": SHA_A,
            "model_sha256": SHA_A, "configuration_sha256": SHA_A, "input_sha256": SHA_A,
            "raw_asset_id": locator.raw_asset_id, "raw_asset_sha256": locator.raw_asset_sha256,
            "parser_artifact_id": locator.parser_artifact_id, "parser_artifact_sha256": SHA_A,
            "source_map_artifact_id": locator.source_map_artifact_id, "source_map_artifact_sha256": SHA_B,
            "document_sha256": hashlib.sha256(canonical_json(document).encode()).hexdigest(),
            "analysis_artifact_sha256": SHA_A}
        provenance = AnalysisProvenanceSnapshot(tuple(values.items()))
        return CurrentAnalysisSnapshot(UUIDS[9], 1, UUIDS[10], UUIDS[6], SHA_A, UUIDS[7], SHA_B,
            UUIDS[8], SHA_A, sections, (), (), (), (), (), (locator,), provenance)

    @staticmethod
    def replace_evidence(package, old, new):
        return tuple(new if item.evidence_id == old.evidence_id else item for item in package.evidence)

    def test_round_trip_exact_hash_and_compact_ascii_json(self):
        package = self.make_package()
        payload = package.to_json()
        raw = package.to_dict()
        supplied = raw.pop("package_sha256")
        self.assertEqual(supplied, hashlib.sha256(canonical_json(raw).encode()).hexdigest())
        self.assertEqual(DocumentPackageVersion.from_json(payload), package)
        self.assertNotIn("Cafe", payload)
        self.assertNotIn(": ", payload)

    def test_semantically_unordered_tuples_serialize_deterministically(self):
        package = self.make_package()
        self.assertEqual(self.make_package(reverse=True), package)
        self.assertEqual(self.make_package(reverse=True).to_json(), package.to_json())
        self.assertEqual(package.normalized_content.sections[0].ordinal, 0)

    def test_unknown_additive_top_level_fields_round_trip_with_original_hash(self):
        package = self.make_package()
        raw = package.to_dict()
        raw["future"] = {"neutral": [True, "value"]}
        raw["package_sha256"] = hashlib.sha256(canonical_json({k: v for k, v in raw.items() if k != "package_sha256"}).encode()).hexdigest()
        parsed = DocumentPackageVersion.from_dict(raw)
        parsed.validate_hash()
        self.assertEqual(parsed.to_dict()["future"], raw["future"])
        self.assertEqual(DocumentPackageVersion.from_json(parsed.to_json()), parsed)

    def test_contracts_are_frozen_slotted_and_hashable(self):
        package, snapshot = self.make_package(), self.snapshot()
        values = (package, package.files[0], package.source_provenance[0], package.normalized_content.sections[0],
            package.normalized_content.tables[0], package.normalized_content.tables[0].cells[0],
            package.normalized_content.references[0], package.normalized_content, package.evidence[0],
            package.artifacts[0], package.lineage[0], snapshot, snapshot.sections[0], snapshot.evidence[0], snapshot.provenance)
        for value in values:
            hash(value)
            self.assertFalse(hasattr(value, "__dict__"))
            with self.assertRaises((FrozenInstanceError, TypeError)):
                setattr(value, "new", True)
        with self.assertRaises(TypeError):
            replace(snapshot, evidence=list(snapshot.evidence))
        with self.assertRaises(TypeError):
            replace(snapshot.sections[0], evidence_ids=list(snapshot.sections[0].evidence_ids))

    def test_uuid_hash_path_media_type_time_size_and_version_are_strict(self):
        self.assertEqual(ids.validate_uuid(UUIDS[0]), UUIDS[0])
        self.assertEqual(len(ids.new_uuid4()), 36)
        self.assertEqual(timestamps.parse_rfc3339(NOW).isoformat(), "2026-07-20T12:00:00+00:00")
        for value in ("ABCDEFAB-0000-4000-8000-000000000001", "not-a-uuid", " " + UUIDS[0]):
            with self.subTest(value=value), self.assertRaises(ValueError):
                ids.validate_uuid(value)
        for value in ("A" * 64, "a" * 63, "g" * 64):
            with self.subTest(hash=value), self.assertRaises(ValueError):
                FileRecord(UUIDS[0], AssetRole.HTML, "text/html", "raw/a.html", value, 1)
        for path in ("/raw/a.pdf", "../a.pdf", "raw/../a.pdf", "raw\\a.pdf", "https://x/a.pdf", "C:/a.pdf", "raw//a.pdf", "raw/a.pdf?x=1"):
            with self.subTest(path=path), self.assertRaises(ValueError):
                FileRecord(UUIDS[0], AssetRole.PRIMARY_PDF, "application/pdf", path, SHA_A, 1)
        with self.assertRaises(ValueError):
            FileRecord(UUIDS[0], AssetRole.PRIMARY_PDF, "Application/PDF", "raw/a.pdf", SHA_A, 1)
        with self.assertRaises(ValueError):
            ArtifactRecord(UUIDS[0], "x", "application/json", "a.json", SHA_A, 0)
        with self.assertRaisesRegex(ValueError, "at least 1"):
            replace(self.make_package(), package_version=0)
        for value in ("2026-07-20T12:00:00+00:00", "2026-07-20 12:00:00Z", "invalid"):
            with self.subTest(timestamp=value), self.assertRaises(ValueError):
                timestamps.parse_rfc3339(value)

    def test_normalized_content_preserves_whitespace_except_nfc_and_line_endings(self):
        section = SectionRecord(UUIDS[0], None, 0, None, "  Cafe\u0301  \r\nnext\tword  ")
        self.assertEqual(section.text, unicodedata.normalize("NFC", "  Cafe\u0301  \nnext\tword  "))

    def test_section_and_table_references_and_cycles_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "existing section"):
            NormalizedContent(UUIDS[2], (SectionRecord(UUIDS[0], UUIDS[1], 0, None, "text"),), (), ())
        with self.assertRaisesRegex(ValueError, "acyclic"):
            NormalizedContent(UUIDS[2], (SectionRecord(UUIDS[0], UUIDS[1], 0, None, "a"),
                SectionRecord(UUIDS[1], UUIDS[0], 1, None, "b")), (), ())
        with self.assertRaisesRegex(ValueError, "table section_id"):
            NormalizedContent(UUIDS[2], (SectionRecord(UUIDS[0], None, 0, None, "a"),),
                (TableRecord(UUIDS[3], 0, None, (), UUIDS[1], None),), ())

    def test_artifact_references_quality_and_publication_time_are_enforced(self):
        package = self.make_package()
        with self.assertRaisesRegex(ValueError, "NormalizedContent artifact_id"):
            replace(package, normalized_content=replace(package.normalized_content, artifact_id=UUIDS[70]))
        with self.assertRaisesRegex(ValueError, "primary PDF"):
            replace(package, files=tuple(replace(item, role=AssetRole.XML, media_type="application/xml") for item in package.files))
        with self.assertRaisesRegex(ValueError, "forbids a primary PDF"):
            replace(package, quality=PackageQuality.LIMITED_XML_HTML, limitations=("missing_primary_pdf",))
        with self.assertRaisesRegex(ValueError, "published_at"):
            replace(package, source_provenance=(replace(package.source_provenance[0], completed_at=LATER),))
        with self.assertRaisesRegex(ValueError, "published_at"):
            replace(package, lineage=(replace(package.lineage[0], completed_at=LATER),) + package.lineage[1:])

    def test_evidence_fields_source_map_spans_and_complete_coverage(self):
        package = self.make_package()
        evidence = package.evidence[0]
        source_map = next(item for item in package.artifacts if item.kind == SOURCE_MAP_KIND)
        with self.assertRaisesRegex(ValueError, "source_map"):
            replace(package, artifacts=tuple(replace(item, kind="other") if item == source_map else item for item in package.artifacts))
        with self.assertRaisesRegex(ValueError, "unknown file_id"):
            replace(package, evidence=self.replace_evidence(package, evidence, replace(evidence, file_id=UUIDS[70])))
        with self.assertRaisesRegex(ValueError, "normalized text"):
            replace(package, evidence=self.replace_evidence(package, evidence, replace(evidence, normalized_path="/artifact_id")))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            replace(package, evidence=self.replace_evidence(package, evidence, replace(evidence, normalized_end=999)))
        with self.assertRaisesRegex(ValueError, "source span"):
            replace(evidence, source_start=5, source_end=5)
        with self.assertRaisesRegex(ValueError, "evidence gap"):
            replace(package, evidence=package.evidence[1:])
        midpoint = evidence.normalized_end // 2
        first = replace(evidence, normalized_end=midpoint, source_end=midpoint)
        second = replace(evidence, evidence_id=UUIDS[70], normalized_start=midpoint,
            source_start=midpoint, source_end=evidence.normalized_end)
        replace(package, evidence=package.evidence[1:] + (first, second))
        overlap = replace(second, evidence_id=UUIDS[71], normalized_start=max(0, midpoint - 1))
        replace(package, evidence=package.evidence[1:] + (first, overlap))

    def test_lineage_exact_fields_stage_and_reference_requirements(self):
        package = self.make_package()
        expected = {"lineage_id", "run_id", "stage", "producer", "producer_version", "started_at",
            "completed_at", "input_file_ids", "input_artifact_ids", "output_file_ids", "output_artifact_ids",
            "parameters_sha256"}
        self.assertEqual({field.name for field in fields(Lineage)}, expected)
        with self.assertRaisesRegex(ValueError, "missing required stages"):
            replace(package, lineage=tuple(item for item in package.lineage if item.stage is not ProcessingStage.PUBLICATION))
        publication = next(item for item in package.lineage if item.stage is ProcessingStage.PUBLICATION)
        with self.assertRaisesRegex(ValueError, "requires input artifacts"):
            replace(package, lineage=tuple(replace(item, input_artifact_ids=()) if item == publication else item for item in package.lineage))
        with self.assertRaisesRegex(ValueError, "unknown artifact_id"):
            replace(package, lineage=tuple(replace(item, input_artifact_ids=(UUIDS[70],)) if item == publication else item for item in package.lineage))

    def test_tampering_duplicate_keys_noncanonical_json_and_invalid_hash_are_rejected(self):
        package = self.make_package()
        raw = package.to_dict()
        raw["published_at"] = LATER
        with self.assertRaisesRegex(ValueError, "package_sha256"):
            DocumentPackageVersion.from_dict(raw)
        duplicate = package.to_json().replace('"schema_version":"1"', '"schema_version":"1","schema_version":"1"', 1)
        with self.assertRaisesRegex(ValueError, "duplicate JSON"):
            DocumentPackageVersion.from_json(duplicate)
        with self.assertRaises(ValueError):
            canonical_json({"nan": float("nan")})

    def test_public_contracts_have_only_frozen_neutral_fields(self):
        self.assertEqual({field.name for field in fields(TableCell)},
            {"row_index", "column_index", "text", "is_header", "row_span", "column_span"})
        self.assertEqual({field.name for field in fields(NormalizedContent)},
            {"artifact_id", "sections", "tables", "references"})
        self.assertIn("current_analysis", {field.name for field in fields(DocumentPackageVersion)})
        forbidden = {"reaction", "molecule", "route", "yield", "confidence", "score", "blob", "bytes"}
        for contract in (FileRecord, SourceProvenance, SectionRecord, TableCell, TableRecord, ReferenceRecord,
                         NormalizedContent, ArtifactRecord, EvidenceLocator, CurrentAnalysisSnapshot, Lineage,
                         DocumentPackageVersion):
            self.assertTrue(forbidden.isdisjoint(field.name for field in fields(contract)))

    def test_current_analysis_snapshot_semantics_lineage_tamper_and_round_trip(self):
        snapshot = self.snapshot()
        self.assertEqual(CurrentAnalysisSnapshot.from_dict(snapshot.to_dict()), snapshot)
        with self.assertRaises(TypeError):
            replace(snapshot, evidence=list(snapshot.evidence))
        with self.assertRaisesRegex(ValueError, "fields are incomplete"):
            AnalysisProvenanceSnapshot(snapshot.provenance.values[:-1])
        with self.assertRaisesRegex(ValueError, "provenance"):
            replace(snapshot, provenance=AnalysisProvenanceSnapshot(tuple(
                (key, UUIDS[12] if key == "analysis_run_id" else value) for key, value in snapshot.provenance.values)))
        with self.assertRaisesRegex(ValueError, "document_sha256"):
            replace(snapshot, provenance=AnalysisProvenanceSnapshot(tuple(
                (key, SHA_B if key == "document_sha256" else value) for key, value in snapshot.provenance.values)))
        locator = snapshot.evidence[0]
        with self.assertRaisesRegex(ValueError, "locator lineage"):
            replace(snapshot, evidence=(replace(locator, raw_asset_id=UUIDS[12]),),
                sections=tuple(replace(item, locators=(replace(locator, raw_asset_id=UUIDS[12]),)) for item in snapshot.sections))

    def test_snapshot_value_geometry_duplicates_and_identifier_rules(self):
        locator = self.locator()
        for bbox in ((0.0, 0.0, 0.0, 1.0), (-1.0, 0.0, 1.0, 1.0), (0.0, 0.0, float("inf"), 1.0)):
            with self.subTest(bbox=bbox), self.assertRaises((TypeError, ValueError)):
                replace(locator, bbox=bbox)
        with self.assertRaisesRegex(ValueError, "equal length"):
            replace(locator, document_end=2)
        CanonicalFieldSnapshot("publication_year", 2024, (locator.evidence_id,), (locator,))
        with self.assertRaises(TypeError):
            CanonicalFieldSnapshot("publication_year", "2024", (locator.evidence_id,), (locator,))
        with self.assertRaises(ValueError):
            CanonicalFieldSnapshot("publication_date", "2024/01/01", (locator.evidence_id,), (locator,))
        reference = AnalysisReferenceSnapshot(UUIDS[61], 0, "reference", None, "DOI",
            "https://doi.org/10.1/ABC", (locator.evidence_id,), (locator,))
        self.assertEqual((reference.identifier_namespace, reference.identifier_value), ("doi", "10.1/abc"))
        with self.assertRaises(ValueError):
            NewTagProposalSnapshot("name", "definition", ("alias", "alias"))


if __name__ == "__main__":
    import unittest
    unittest.main()
