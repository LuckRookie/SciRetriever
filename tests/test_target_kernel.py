from __future__ import annotations

import ast
from importlib import import_module
from pathlib import Path
from unittest import TestCase

from pydantic import ValidationError

from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
    canonical_json_bytes,
    parse_canonical_json,
)
from sciretriever.model import primitives
from sciretriever.model.documents import (
    EvidenceText,
    SourceLocator,
)
from sciretriever.model.execution import Action, FailureEvidence, Reason
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    AssetId,
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
    WorkId,
    WorkVersionId,
)
from sciretriever.model.sources import Provenance

UUIDS = tuple(f"00000000-0000-4000-8000-{index:012x}" for index in range(1, 12))
SHA_A = "a" * 64
NOW = "2026-07-31T12:00:00.123Z"


class KernelValueTests(TestCase):
    def test_branded_ids_are_strict_and_not_interchangeable(self) -> None:
        work_id = WorkId(UUIDS[0])
        duplicate_work_id = WorkId(UUIDS[0])
        version_id = WorkVersionId(UUIDS[0])

        self.assertEqual(str(work_id), UUIDS[0])
        self.assertNotEqual(work_id, version_id)
        self.assertEqual(hash(work_id), hash(duplicate_work_id))
        self.assertNotEqual(hash(work_id), hash(version_id))
        self.assertEqual(len({work_id, duplicate_work_id, version_id}), 2)
        self.assertEqual(work_id.model_dump_json(), f'"{UUIDS[0]}"')
        with self.assertRaisesRegex(ValidationError, "valid string"):
            WorkVersionId.model_validate(work_id)
        with self.assertRaises(ValidationError):
            WorkId.model_validate(1)
        with self.assertRaisesRegex(ValidationError, "Instance is frozen"):
            setattr(work_id, "root", UUIDS[1])

    def test_malformed_id_hash_path_and_time_are_rejected(self) -> None:
        invalid_values = (
            (WorkId, "not-a-uuid"),
            (WorkId, "abcdefab-0000-4000-8000-000000000001".upper()),
            (Sha256, "A" * 64),
            (Sha256, "a" * 63),
            (RelativeArtifactPath, "/absolute/file.json"),
            (RelativeArtifactPath, "artifacts/../file.json"),
            (RelativeArtifactPath, "artifacts\\file.json"),
            (UtcTimestamp, "2026-07-31T12:00:00+00:00"),
            (UtcTimestamp, "2026-07-31T12:00:00"),
        )

        for value_type, raw in invalid_values:
            with (
                self.subTest(value_type=value_type.__name__, raw=raw),
                self.assertRaises(ValidationError),
            ):
                value_type(raw)

    def test_value_serialization_is_deterministic(self) -> None:
        first = CanonicalJsonObject(
            (
                ("z", (3, 2, 1)),
                ("a", CanonicalJsonObject((("unicode", "Café"),))),
            )
        )
        second = CanonicalJsonObject(
            (
                ("a", CanonicalJsonObject((("unicode", "Café"),))),
                ("z", (3, 2, 1)),
            )
        )

        expected = b'{"a":{"unicode":"Caf\\u00e9"},"z":[3,2,1]}'
        self.assertEqual(canonical_json_bytes(first), expected)
        self.assertEqual(canonical_json_bytes(second), expected)


class CanonicalJsonTests(TestCase):
    def test_public_kernel_uses_only_python_310_typing_apis(self) -> None:
        kernel_root = Path(__file__).parents[1] / "src" / "sciretriever" / "kernel"

        for source_path in kernel_root.glob("*.py"):
            source = source_path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(source_path), feature_version=(3, 10))
            typing_imports = {
                alias.name
                for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom) and node.module == "typing"
                for alias in node.names
            }
            with self.subTest(source=source_path.name):
                self.assertNotIn("assert_never", typing_imports)

    def test_parser_rejects_duplicate_nonfinite_and_invalid_values(self) -> None:
        malformed = (
            '{"duplicate":1,"duplicate":2}',
            '{"value":NaN}',
            '{"value":Infinity}',
            '"\ud800"',
        )

        for payload in malformed:
            with self.subTest(payload=payload), self.assertRaises(BoundaryError):
                parse_canonical_json(payload)

        for value in (float("nan"), float("inf"), -float("inf")):
            with self.subTest(value=value):
                with self.assertRaises(BoundaryError):
                    canonical_json_bytes(value)

    def test_parser_round_trip_preserves_canonical_value(self) -> None:
        parsed = parse_canonical_json('{"nested":[null,true,1,1.5,"text"]}')

        self.assertEqual(
            canonical_json_bytes(parsed),
            b'{"nested":[null,true,1,1.5,"text"]}',
        )


class ContractTests(TestCase):
    def test_generic_extension_kernel_surface_is_absent(self) -> None:
        kernel = import_module("sciretriever.kernel")

        self.assertFalse(hasattr(kernel, "OpaqueExtensionRecord"))
        self.assertFalse(hasattr(kernel, "OpaqueExtensionRecordStorePort"))
        self.assertFalse(hasattr(primitives, "ExtensionRecordId"))
        with self.assertRaises(ModuleNotFoundError):
            import_module("sciretriever.kernel.extensions")

    def test_foundation_contracts_are_frozen_and_round_trip(self) -> None:
        provenance = Provenance(
            provenance_id=ProvenanceId(UUIDS[0]),
            source_kind=SourceKind.PARSER,
            source_name="fixture-parser",
            source_record_id=None,
            observed_at=UtcTimestamp(NOW),
            input_sha256=Sha256(SHA_A),
            parameters_sha256=None,
        )
        locator = SourceLocator(
            asset_id=AssetId(UUIDS[1]),
            page_start=1,
            page_end=2,
            block_id="block-1",
            char_start=0,
            char_end=4,
        )
        evidence = EvidenceText(text="text", evidence=(locator,))
        identifier = Identifier(namespace="doi", value="10.1000/example")

        self.assertEqual(Provenance.model_validate_json(provenance.model_dump_json()), provenance)
        self.assertEqual(EvidenceText.model_validate_json(evidence.model_dump_json()), evidence)
        self.assertEqual(Identifier.model_validate_json(identifier.model_dump_json()), identifier)
        with self.assertRaises(ValidationError):
            setattr(provenance, "source_name", "changed")

    def test_provenance_constructor_rejects_malformed_nullable_fields(self) -> None:
        provenance_type = getattr(import_module("sciretriever.model.sources"), "Provenance")
        malformed = (
            ("source_record_id", 123),
            ("input_sha256", "not-a-sha"),
            ("parameters_sha256", False),
        )

        for field, value in malformed:
            arguments = {
                "provenance_id": ProvenanceId(UUIDS[0]),
                "source_kind": SourceKind.PARSER,
                "source_name": "fixture-parser",
                "source_record_id": None,
                "observed_at": UtcTimestamp(NOW),
                "input_sha256": None,
                "parameters_sha256": None,
            }
            arguments[field] = value
            with self.subTest(field=field):
                with self.assertRaises(ValidationError) as raised:
                    provenance_type(**arguments)
                self.assertEqual(raised.exception.errors()[0]["loc"], (field,))

    def test_reason_action_errors_have_stable_typed_fields(self) -> None:
        evidence = FailureEvidence(
            code="invalid-boundary",
            reason=Reason(value="The supplied value is invalid."),
            action=Action(value="Supply a canonical value."),
            retryable=False,
        )
        error = BoundaryError.from_evidence(evidence, field="work_id")

        self.assertEqual(error.code, "invalid-boundary")
        self.assertEqual(error.reason, evidence.reason)
        self.assertEqual(error.action, evidence.action)
        self.assertEqual(error.field, "work_id")


if __name__ == "__main__":
    import unittest

    unittest.main()
