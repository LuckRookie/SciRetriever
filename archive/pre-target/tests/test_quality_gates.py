import hashlib
from dataclasses import replace
from pathlib import Path
import sys
from unittest import TestCase
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.core.enums import AssetRole, PackageQuality
from sciretriever.errors import PackagingError
from sciretriever.normalization import RawNormalizationInput, normalize_inputs
from sciretriever.packaging import QualityGate


class QualityGateTests(TestCase):
    def draft(self):
        payload = b"<article><p>Text</p></article>"
        value = RawNormalizationInput(str(uuid4()), AssetRole.XML, "application/xml", hashlib.sha256(payload).hexdigest(), payload)
        return normalize_inputs((value,))

    def test_quality_selection_and_supplement_only_rejection(self) -> None:
        gate = QualityGate()
        limited = gate.validate((AssetRole.XML,), self.draft())
        self.assertIs(limited.quality, PackageQuality.LIMITED_XML_HTML)
        self.assertEqual(limited.limitations, ("missing_primary_pdf",))
        pdf = gate.validate((AssetRole.PRIMARY_PDF,), self.draft())
        self.assertIs(pdf.quality, PackageQuality.PDF_BACKED)
        with self.assertRaises(PackagingError):
            gate.validate((AssetRole.SUPPLEMENTARY_PDF,), self.draft())

    def test_bidirectional_evidence_rejects_gaps_overlaps_and_orphans(self) -> None:
        gate = QualityGate()
        draft = self.draft()
        evidence = draft.evidence[0]
        gap = replace(
            draft,
            evidence=(replace(evidence, source_start=1, normalized_start=1),),
        )
        overlap = replace(
            draft,
            evidence=(evidence, replace(evidence, evidence_id=str(uuid4()))),
        )
        section = replace(draft.content.sections[0], text="TextX")
        normalized_gap = replace(
            draft,
            content=replace(draft.content, sections=(section,)),
        )
        orphan_source = replace(
            draft,
            source_units=draft.source_units + (replace(draft.source_units[0], unit_id="orphan"),),
        )
        for candidate in (gap, overlap, normalized_gap, orphan_source):
            with self.subTest(candidate=candidate), self.assertRaises(PackagingError):
                gate.validate((AssetRole.XML,), candidate)


if __name__ == "__main__":
    import unittest
    unittest.main()
