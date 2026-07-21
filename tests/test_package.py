import hashlib
import importlib
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

contracts = importlib.import_module("sciretriever.core.contracts")
enums = importlib.import_module("sciretriever.core.enums")
ids = importlib.import_module("sciretriever.core.ids")
package_module = importlib.import_module("sciretriever.core.package")
timestamps = importlib.import_module("sciretriever.core.timestamps")

Identifier = contracts.Identifier
AssetRole = enums.AssetRole
PackageQuality = enums.PackageQuality
ProcessingStage = enums.ProcessingStage
ArtifactRecord = package_module.ArtifactRecord
DocumentPackageVersion = package_module.DocumentPackageVersion
EvidenceLocator = package_module.EvidenceLocator
FileRecord = package_module.FileRecord
LightStructure = package_module.LightStructure
Lineage = package_module.Lineage
NormalizedContent = package_module.NormalizedContent
ReferenceRecord = package_module.ReferenceRecord
SectionRecord = package_module.SectionRecord
SourceProvenance = package_module.SourceProvenance
TableCell = package_module.TableCell
TableRecord = package_module.TableRecord


UUIDS = tuple(f"00000000-0000-4000-8000-{index:012x}" for index in range(1, 60))
SHA_A = "a" * 64
SHA_B = "b" * 64
NOW = "2026-07-20T12:00:00Z"
LATER = "2026-07-20T12:00:01Z"


class PackageTests(TestCase):
    def make_package(
        self,
        *,
        quality: PackageQuality = PackageQuality.PDF_BACKED,
        light_structure: LightStructure | None = None,
        reverse: bool = False,
    ) -> DocumentPackageVersion:
        role = AssetRole.PRIMARY_PDF if quality is PackageQuality.PDF_BACKED else AssetRole.XML
        media_type = "application/pdf" if role is AssetRole.PRIMARY_PDF else "application/xml"
        suffix = "pdf" if role is AssetRole.PRIMARY_PDF else "xml"
        file_record = FileRecord(UUIDS[1], role, media_type, f"raw/document.{suffix}", SHA_A, 42)
        provenance = SourceProvenance(
            UUIDS[2], file_record.file_id, "test-provider", "download", "test-agent", NOW,
            NOW, "https://example.test/document",
        )
        source_map = ArtifactRecord(
            UUIDS[7], package_module.SOURCE_MAP_KIND, package_module.SOURCE_MAP_MEDIA_TYPE,
            "derived/source-map.json", SHA_B, 12,
        )
        normalized_artifact = ArtifactRecord(
            UUIDS[8], "normalized_content", "application/json", "derived/content.json", SHA_A, 30,
        )
        light_artifact = ArtifactRecord(
            UUIDS[9], "light_structure", "application/json", "derived/light.json", SHA_B, 10,
        )
        content = NormalizedContent(
            artifact_id=normalized_artifact.artifact_id,
            sections=(
                SectionRecord(UUIDS[4], UUIDS[3], 1, "Methods", "line one\r\nline two"),
                SectionRecord(UUIDS[3], None, 0, "Cafe\u0301", "Alpha beta"),
            ),
            tables=(
                TableRecord(
                    UUIDS[5], 0, "Values", (TableCell(0, 0, "A", True),),
                    section_id=UUIDS[4], notes="Table note",
                ),
            ),
            references=(
                ReferenceRecord(UUIDS[6], 0, "Neutral citation", (Identifier("doi", "10.1/x"),)),
            ),
        )
        structure = light_structure or LightStructure(
            "A neutral summary", ("tag-b", "tag-a"), (UUIDS[20],), light_artifact.artifact_id
        )
        run_id = UUIDS[21]
        lineage = (
            Lineage(
                UUIDS[10], run_id, ProcessingStage.RAW_ACCEPTANCE, "acceptor", "1.0", NOW,
                NOW, (), (), (file_record.file_id,), (), SHA_A,
            ),
            Lineage(
                UUIDS[11], run_id, ProcessingStage.NORMALIZATION, "normalizer", "1.0", NOW,
                NOW, (file_record.file_id,), (), (),
                (source_map.artifact_id, normalized_artifact.artifact_id), SHA_A,
            ),
            Lineage(
                UUIDS[12], run_id, ProcessingStage.ENRICHMENT, "enricher", "1.0", NOW,
                NOW, (), (normalized_artifact.artifact_id,), (), (light_artifact.artifact_id,), SHA_A,
            ),
            Lineage(
                UUIDS[13], run_id, ProcessingStage.PACKAGE_VALIDATION, "validator", "1.0", NOW,
                NOW, (), (normalized_artifact.artifact_id, source_map.artifact_id), (), (), SHA_A,
            ),
            Lineage(
                UUIDS[14], run_id, ProcessingStage.PUBLICATION, "publisher", "1.0", NOW,
                NOW, (), (normalized_artifact.artifact_id, source_map.artifact_id), (), (), SHA_A,
            ),
        )
        text_targets = {
            "/sections/0/title": content.sections[0].title,
            "/sections/0/text": content.sections[0].text,
            "/sections/1/title": content.sections[1].title,
            "/sections/1/text": content.sections[1].text,
            "/tables/0/caption": content.tables[0].caption,
            "/tables/0/notes": content.tables[0].notes,
            "/tables/0/cells/0/text": content.tables[0].cells[0].text,
            "/references/0/text": content.references[0].text,
        }
        evidence = tuple(
            EvidenceLocator(
                UUIDS[22 + index], file_record.file_id, source_map.artifact_id,
                f"unit-{index}", 10 * index, 10 * index + len(text), path, 0, len(text),
            )
            for index, (path, value) in enumerate(text_targets.items())
            if (text := value) is not None and text != ""
        )
        artifacts = (source_map, normalized_artifact, light_artifact)
        if reverse:
            lineage = tuple(reversed(lineage))
            artifacts = tuple(reversed(artifacts))
            evidence = tuple(reversed(evidence))
        limitations = () if quality is PackageQuality.PDF_BACKED else (package_module.MISSING_PRIMARY_PDF,)
        return DocumentPackageVersion.create(
            document_id=UUIDS[0], package_version=1, published_at=NOW, quality=quality,
            limitations=limitations,
            identifiers=(Identifier("pmid", "123"), Identifier("doi", "10.1/x")),
            source_provenance=(provenance,), files=(file_record,), normalized_content=content,
            evidence=evidence, light_structure=structure, artifacts=artifacts, lineage=lineage,
        )

    @staticmethod
    def replace_evidence(
        package: DocumentPackageVersion, old: EvidenceLocator, new: EvidenceLocator
    ) -> tuple[EvidenceLocator, ...]:
        return tuple(new if item.evidence_id == old.evidence_id else item for item in package.evidence)

    def test_round_trip_exact_hash_and_compact_ascii_json(self) -> None:
        package = self.make_package()
        payload = package.to_json()
        raw = package.to_dict()
        supplied = raw.pop("package_sha256")
        expected = hashlib.sha256(
            json.dumps(
                raw, allow_nan=False, ensure_ascii=True, separators=(",", ":"), sort_keys=True
            ).encode("utf-8")
        ).hexdigest()
        self.assertEqual(package.package_sha256, supplied)
        self.assertEqual(package.package_sha256, expected)
        self.assertEqual(DocumentPackageVersion.from_json(payload), package)
        self.assertNotIn("Cafe", payload)
        self.assertNotIn(": ", payload)

    def test_semantically_unordered_tuples_serialize_deterministically(self) -> None:
        first = self.make_package()
        second = self.make_package(reverse=True)
        self.assertEqual(first, second)
        self.assertEqual(first.to_json(), second.to_json())
        self.assertEqual(first.normalized_content.sections[0].ordinal, 0)
        self.assertEqual(first.light_structure.tags, ("tag-a", "tag-b"))

    def test_unknown_additive_top_level_fields_round_trip_with_original_hash(self) -> None:
        raw = self.make_package().to_dict()
        raw["future_optional_field"] = {"neutral": [True, "value"]}
        raw["package_sha256"] = hashlib.sha256(
            package_module.canonical_json(
                {key: value for key, value in raw.items() if key != "package_sha256"}
            ).encode("utf-8")
        ).hexdigest()
        read_package = DocumentPackageVersion.from_dict(raw)
        read_package.validate_hash()
        payload = read_package.to_json()
        self.assertEqual(json.loads(payload)["future_optional_field"], raw["future_optional_field"])
        reparsed = DocumentPackageVersion.from_json(payload)
        self.assertEqual(reparsed, read_package)
        self.assertEqual(reparsed.package_sha256, raw["package_sha256"])
        self.assertNotIn("future_optional_field", {field_.name for field_ in fields(read_package)})

    def test_contracts_are_frozen_slotted_and_hashable(self) -> None:
        package = self.make_package()
        values = (
            package, package.files[0], package.source_provenance[0],
            package.normalized_content.sections[0], package.normalized_content.tables[0],
            package.normalized_content.tables[0].cells[0], package.normalized_content.references[0],
            package.normalized_content, package.evidence[0], package.light_structure,
            package.artifacts[0], package.lineage[0],
        )
        for value in values:
            with self.subTest(type=type(value).__name__):
                hash(value)
                self.assertFalse(hasattr(value, "__dict__"))
                with self.assertRaises((FrozenInstanceError, TypeError)):
                    setattr(value, "new_field", True)

    def test_uuid_hash_path_media_type_time_size_and_version_are_strict(self) -> None:
        self.assertEqual(ids.validate_uuid(UUIDS[0]), UUIDS[0])
        self.assertEqual(len(ids.new_uuid4()), 36)
        self.assertEqual(timestamps.parse_rfc3339(NOW).isoformat(), "2026-07-20T12:00:00+00:00")
        self.assertTrue(timestamps.utc_now_rfc3339().endswith("Z"))
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
            FileRecord(UUIDS[0], AssetRole.HTML, "Text/HTML", "raw/a.html", SHA_A, 1)
        with self.assertRaisesRegex(ValueError, "greater than zero"):
            FileRecord(UUIDS[0], AssetRole.HTML, "text/html", "raw/a.html", SHA_A, 0)
        with self.assertRaisesRegex(ValueError, "greater than zero"):
            ArtifactRecord(UUIDS[0], "source_map", "application/json", "a.json", SHA_A, 0)
        with self.assertRaisesRegex(ValueError, "at least 1"):
            replace(self.make_package(), package_version=0)
        for value in ("2026-07-20T12:00:00+00:00", "2026-07-20 12:00:00Z", "invalid"):
            with self.subTest(timestamp=value), self.assertRaises(ValueError):
                timestamps.parse_rfc3339(value)

    def test_normalized_content_preserves_whitespace_except_nfc_and_line_endings(self) -> None:
        section = SectionRecord(UUIDS[0], None, 0, None, "  Cafe\u0301  \r\nnext\tword  ")
        self.assertEqual(section.text, unicodedata.normalize("NFC", "  Cafe\u0301  \nnext\tword  "))

    def test_section_and_table_references_and_cycles_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "existing section"):
            NormalizedContent(
                UUIDS[2], (SectionRecord(UUIDS[0], UUIDS[1], 0, None, "text"),), (), ()
            )
        with self.assertRaisesRegex(ValueError, "acyclic"):
            NormalizedContent(
                UUIDS[2],
                (SectionRecord(UUIDS[0], UUIDS[1], 0, None, "a"), SectionRecord(UUIDS[1], UUIDS[0], 1, None, "b")),
                (), (),
            )
        with self.assertRaisesRegex(ValueError, "table section_id"):
            NormalizedContent(
                UUIDS[2], (SectionRecord(UUIDS[0], None, 0, None, "a"),),
                (TableRecord(UUIDS[3], 0, None, (), UUIDS[1], None),), (),
            )

    def test_artifact_references_quality_and_publication_time_are_enforced(self) -> None:
        package = self.make_package()
        normalized = package.normalized_content
        with self.assertRaisesRegex(ValueError, "NormalizedContent artifact_id"):
            replace(package, normalized_content=replace(normalized, artifact_id=UUIDS[50]))
        with self.assertRaisesRegex(ValueError, "LightStructure artifact_id"):
            replace(package, light_structure=replace(package.light_structure, artifact_id=UUIDS[50]))
        with self.assertRaisesRegex(ValueError, "light data requires"):
            replace(package, light_structure=replace(package.light_structure, artifact_id=None))
        xml_package = self.make_package(quality=PackageQuality.LIMITED_XML_HTML)
        with self.assertRaisesRegex(ValueError, "primary PDF"):
            replace(xml_package, quality=PackageQuality.PDF_BACKED)
        with self.assertRaisesRegex(ValueError, "missing_primary_pdf"):
            replace(xml_package, limitations=())
        with self.assertRaisesRegex(ValueError, "forbids a primary PDF"):
            replace(package, quality=PackageQuality.LIMITED_XML_HTML, limitations=(package_module.MISSING_PRIMARY_PDF,))
        with self.assertRaisesRegex(ValueError, "published_at"):
            replace(package, source_provenance=(replace(package.source_provenance[0], completed_at=LATER),))
        with self.assertRaisesRegex(ValueError, "published_at"):
            replace(package, lineage=(replace(package.lineage[0], completed_at=LATER),) + package.lineage[1:])

    def test_evidence_fields_source_map_spans_and_complete_coverage(self) -> None:
        package = self.make_package()
        evidence = package.evidence[0]
        source_map = next(item for item in package.artifacts if item.kind == package_module.SOURCE_MAP_KIND)
        bad_source_map = replace(source_map, kind="other")
        with self.assertRaisesRegex(ValueError, "source_map"):
            replace(package, artifacts=tuple(bad_source_map if item == source_map else item for item in package.artifacts))
        with self.assertRaisesRegex(ValueError, "unknown file_id"):
            replace(package, evidence=self.replace_evidence(package, evidence, replace(evidence, file_id=UUIDS[50])))
        with self.assertRaisesRegex(ValueError, "normalized text"):
            replace(package, evidence=self.replace_evidence(package, evidence, replace(evidence, normalized_path="/artifact_id")))
        with self.assertRaisesRegex(ValueError, "exceeds"):
            replace(package, evidence=self.replace_evidence(package, evidence, replace(evidence, normalized_end=999)))
        with self.assertRaisesRegex(ValueError, "source span"):
            replace(evidence, source_start=5, source_end=5)
        with self.assertRaisesRegex(ValueError, "normalized span"):
            replace(evidence, normalized_start=5, normalized_end=5)
        with self.assertRaisesRegex(ValueError, "evidence gap"):
            replace(package, evidence=tuple(item for item in package.evidence if item.evidence_id != evidence.evidence_id))

        midpoint = evidence.normalized_end // 2
        first = replace(evidence, normalized_end=midpoint, source_end=evidence.source_start + midpoint)
        second = replace(
            evidence, evidence_id=UUIDS[45], normalized_start=midpoint,
            source_start=first.source_end, source_end=first.source_end + evidence.normalized_end - midpoint,
        )
        split_evidence = tuple(item for item in package.evidence if item.evidence_id != evidence.evidence_id) + (first, second)
        replace(package, evidence=split_evidence)
        overlapping_second = replace(
            second, evidence_id=UUIDS[46], normalized_start=max(0, midpoint - 1)
        )
        overlapping_evidence = (
            tuple(item for item in package.evidence if item.evidence_id != evidence.evidence_id)
            + (first, overlapping_second)
        )
        replace(package, evidence=overlapping_evidence)

    def test_lineage_exact_fields_stage_and_reference_requirements(self) -> None:
        package = self.make_package()
        expected = {
            "lineage_id", "run_id", "stage", "producer", "producer_version", "started_at",
            "completed_at", "input_file_ids", "input_artifact_ids", "output_file_ids",
            "output_artifact_ids", "parameters_sha256",
        }
        self.assertEqual({field_.name for field_ in fields(Lineage)}, expected)
        without_publication = tuple(item for item in package.lineage if item.stage is not ProcessingStage.PUBLICATION)
        with self.assertRaisesRegex(ValueError, "missing required stages"):
            replace(package, lineage=without_publication)
        publication = next(item for item in package.lineage if item.stage is ProcessingStage.PUBLICATION)
        with self.assertRaisesRegex(ValueError, "requires input artifacts"):
            replace(package, lineage=tuple(replace(item, input_artifact_ids=()) if item == publication else item for item in package.lineage))
        with self.assertRaisesRegex(ValueError, "unknown artifact_id"):
            replace(package, lineage=tuple(replace(item, input_artifact_ids=(UUIDS[50],)) if item == publication else item for item in package.lineage))

    def test_tampering_duplicate_keys_noncanonical_json_and_invalid_hash_are_rejected(self) -> None:
        package = self.make_package()
        raw = package.to_dict()
        raw["published_at"] = LATER
        with self.assertRaisesRegex(ValueError, "package_sha256"):
            DocumentPackageVersion.from_dict(raw)
        duplicate = package.to_json().replace(
            '"schema_version":"1"', '"schema_version":"1","schema_version":"1"', 1
        )
        with self.assertRaisesRegex(ValueError, "duplicate JSON object key"):
            DocumentPackageVersion.from_json(duplicate)
        with self.assertRaises(ValueError):
            package_module.canonical_json({"not_standard_json": float("nan")})

    def test_public_contracts_have_only_frozen_neutral_fields(self) -> None:
        self.assertEqual(
            {field_.name for field_ in fields(TableCell)},
            {"row_index", "column_index", "text", "is_header", "row_span", "column_span"},
        )
        self.assertEqual(
            {field_.name for field_ in fields(TableRecord)},
            {"table_id", "ordinal", "caption", "cells", "section_id", "notes"},
        )
        self.assertEqual(
            {field_.name for field_ in fields(NormalizedContent)},
            {"artifact_id", "sections", "tables", "references"},
        )
        self.assertEqual(
            {field_.name for field_ in fields(LightStructure)},
            {"summary", "tags", "citation_document_ids", "artifact_id"},
        )
        self.assertEqual(
            {field_.name for field_ in fields(EvidenceLocator)},
            {
                "evidence_id", "file_id", "source_artifact_id", "source_unit_id",
                "source_start", "source_end", "normalized_path", "normalized_start",
                "normalized_end",
            },
        )
        contract_types = (
            FileRecord, SourceProvenance, SectionRecord, TableCell, TableRecord,
            ReferenceRecord, NormalizedContent, ArtifactRecord, EvidenceLocator,
            LightStructure, Lineage, DocumentPackageVersion,
        )
        forbidden = {
            "reaction", "molecule", "route", "yield", "confidence", "priority", "score",
            "page", "xpath", "css", "bounding_box", "bytes", "blob", "extensions",
        }
        for contract_type in contract_types:
            with self.subTest(contract=contract_type.__name__):
                self.assertTrue(forbidden.isdisjoint(field_.name for field_ in fields(contract_type)))


if __name__ == "__main__":
    import unittest

    unittest.main()
