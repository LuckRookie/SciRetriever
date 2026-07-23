import importlib
import sys
from dataclasses import FrozenInstanceError
from pathlib import Path
from unittest import TestCase
from uuid import uuid4


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

catalog = importlib.import_module("sciretriever.catalog")
enums = importlib.import_module("sciretriever.core.enums")


def new_id() -> str:
    return str(uuid4())


class AssetRecordTests(TestCase):
    def raw_values(self) -> dict[str, object]:
        sha256 = "a" * 64
        return {
            "id": new_id(),
            "sha256": sha256,
            "storage_path": f"raw/{sha256[:2]}/{sha256}",
            "media_type": "application/pdf",
            "format": "pdf_v1",
            "byte_size": 42,
            "provenance_json": '{"provider":"example"}',
            "created_at": "2026-07-20T12:00:00.000Z",
        }

    def intent_values(self) -> dict[str, object]:
        intent_id = new_id()
        sha256 = "b" * 64
        return {
            "id": intent_id,
            "work_version_id": new_id(),
            "job_id": new_id(),
            "attempt_id": None,
            "raw_asset_id": None,
            "asset_role": enums.AssetRole.PRIMARY_PDF,
            "state": enums.AssetIntentState.PENDING,
            "temporary_path": f"staging/{intent_id}.part",
            "storage_path": f"raw/{sha256[:2]}/{sha256}",
            "expected_sha256": sha256,
            "media_type": "application/pdf",
            "format": "pdf",
            "expected_byte_size": 42,
            "provenance_json": '{"provider":"example"}',
            "created_at": "2026-07-20T12:00:00.000Z",
            "updated_at": "2026-07-20T12:00:00.000Z",
        }

    def test_records_are_frozen_slotted_and_map_rows(self) -> None:
        raw = catalog.RawAssetRecord.from_row(self.raw_values())
        self.assertFalse(hasattr(raw, "__dict__"))
        with self.assertRaises(FrozenInstanceError):
            raw.byte_size = 1

        work_asset = catalog.WorkVersionAssetRecord.from_row(
            {
                "work_version_id": new_id(),
                "raw_asset_id": raw.id,
                "asset_role": "primary_pdf",
                "linked_at": raw.created_at,
            }
        )
        self.assertIs(work_asset.asset_role, enums.AssetRole.PRIMARY_PDF)

        values = self.intent_values()
        values["asset_role"] = "primary_pdf"
        values["state"] = "pending"
        intent = catalog.AssetIntentRecord.from_row(values)
        self.assertIs(intent.state, enums.AssetIntentState.PENDING)
        self.assertFalse(hasattr(intent, "__dict__"))

    def test_raw_asset_record_rejects_invalid_shapes(self) -> None:
        invalid = {
            "id": "not-a-uuid",
            "sha256": "A" * 64,
            "storage_path": "raw/aa/wrong",
            "media_type": "Application/PDF",
            "format": "PDF",
            "byte_size": 0,
            "provenance_json": '{ "a": 1 }',
            "created_at": "2026-07-20 12:00:00",
        }
        for field, value in invalid.items():
            with self.subTest(field=field):
                values = self.raw_values()
                values[field] = value
                with self.assertRaises((TypeError, ValueError)):
                    catalog.RawAssetRecord(**values)

        for media_type in (
            "application/pdf; charset=utf-8",
            "!application/pdf",
            "application/!pdf",
        ):
            with self.subTest(media_type=media_type):
                values = self.raw_values()
                values["media_type"] = media_type
                with self.assertRaises(ValueError):
                    catalog.RawAssetRecord(**values)

    def test_asset_intent_record_rejects_invalid_shapes_and_state_coupling(self) -> None:
        changes = (
            ("temporary_path", "staging/wrong.part"),
            ("storage_path", "raw/bb/wrong"),
            ("media_type", "application/pdf; charset=utf-8"),
            ("format", "pdf-v1"),
            ("expected_byte_size", False),
            ("provenance_json", '{"z":1,"a":2}'),
            ("state", "pending"),
        )
        for field, value in changes:
            with self.subTest(field=field):
                values = self.intent_values()
                values[field] = value
                with self.assertRaises((TypeError, ValueError)):
                    catalog.AssetIntentRecord(**values)

        for media_type in ("Application/PDF", "!application/pdf", "application/!pdf"):
            with self.subTest(media_type=media_type):
                values = self.intent_values()
                values["media_type"] = media_type
                with self.assertRaises(ValueError):
                    catalog.AssetIntentRecord(**values)

        values = self.intent_values()
        values["raw_asset_id"] = new_id()
        with self.assertRaisesRegex(ValueError, "must match"):
            catalog.AssetIntentRecord(**values)

        values["state"] = enums.AssetIntentState.PUBLISHED
        self.assertIsNotNone(catalog.AssetIntentRecord(**values).raw_asset_id)


if __name__ == "__main__":
    import unittest

    unittest.main()
