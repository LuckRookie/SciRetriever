from __future__ import annotations

import ast
from importlib import import_module
from pathlib import Path
from unittest import TestCase

from pydantic import ValidationError

from sciretriever.kernel import (
    Action,
    BoundaryError,
    CanonicalJsonObject,
    CanonicalJsonValue,
    FailureEvidence,
    OpaqueExtensionRecord,
    OpaqueExtensionRecordStorePort,
    Reason,
    canonical_json_bytes,
    parse_canonical_json,
    validate_page_request,
)
from sciretriever.model.documents import (
    EvidenceText,
    SourceLocator,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    AssetId,
    ExtensionRecordId,
    ProvenanceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
    WorkId,
    WorkVersionId,
    sha256_digest,
)
from sciretriever.model.sources import Provenance

UUIDS = tuple(f"00000000-0000-4000-8000-{index:012x}" for index in range(1, 12))
SHA_A = "a" * 64
NOW = "2026-07-31T12:00:00.123Z"


class InMemoryOpaqueStore:
    def __init__(self) -> None:
        self._records: dict[tuple[str, ExtensionRecordId], OpaqueExtensionRecord] = {}

    def get(self, namespace: str, record_id: ExtensionRecordId) -> OpaqueExtensionRecord | None:
        return self._records.get((namespace, record_id))

    def list_namespace(
        self, namespace: str, after_record_id: ExtensionRecordId | None, limit: int
    ) -> tuple[OpaqueExtensionRecord, ...]:
        validate_page_request(after_record_id=after_record_id, limit=limit)
        records = tuple(
            sorted(
                (
                    record
                    for (record_namespace, _record_id), record in self._records.items()
                    if record_namespace == namespace
                    and (after_record_id is None or record.record_id.root > after_record_id.root)
                ),
                key=lambda record: record.record_id.root,
            )
        )
        return records[:limit]

    def compare_and_set(
        self,
        namespace: str,
        record_id: ExtensionRecordId,
        expected_revision: int | None,
        payload: CanonicalJsonValue,
    ) -> OpaqueExtensionRecord:
        current = self.get(namespace, record_id)
        actual_revision = None if current is None else current.revision
        if actual_revision != expected_revision:
            raise BoundaryError.for_field("expected_revision", "does not match current revision")
        record = OpaqueExtensionRecord(
            namespace=namespace,
            record_id=record_id,
            revision=1 if current is None else current.revision + 1,
            payload_sha256=sha256_digest(canonical_json_bytes(payload)),
            payload=payload,
        )
        self._records[(namespace, record_id)] = record
        return record

    def delete(self, namespace: str, record_id: ExtensionRecordId, expected_revision: int) -> None:
        current = self.get(namespace, record_id)
        if current is None or current.revision != expected_revision:
            raise BoundaryError.for_field("expected_revision", "does not match current revision")
        del self._records[(namespace, record_id)]


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
    def make_record(self) -> OpaqueExtensionRecord:
        payload = parse_canonical_json('{"status":"prepared","attempt":1}')
        return OpaqueExtensionRecord(
            namespace="example.extension.v1",
            record_id=ExtensionRecordId(UUIDS[0]),
            revision=1,
            payload_sha256=sha256_digest(canonical_json_bytes(payload)),
            payload=payload,
        )

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

    def test_opaque_record_round_trip_and_payload_hash_are_strict(self) -> None:
        record = self.make_record()

        self.assertEqual(OpaqueExtensionRecord.from_json(record.to_json()), record)
        with self.assertRaisesRegex(BoundaryError, "payload_sha256 does not match"):
            OpaqueExtensionRecord(
                namespace=record.namespace,
                record_id=record.record_id,
                revision=record.revision,
                payload_sha256=Sha256("b" * 64),
                payload=record.payload,
            )

        with self.assertRaises(BoundaryError):
            OpaqueExtensionRecord.from_json(record.to_json()[:-1] + ',"unknown":true}')

        malformed_id = record.to_json().replace(str(record.record_id), "not-a-uuid")
        with self.assertRaisesRegex(BoundaryError, "extension_record"):
            OpaqueExtensionRecord.from_json(malformed_id)

    def test_compare_and_set_is_deterministic_and_rejects_stale_revision(self) -> None:
        store: OpaqueExtensionRecordStorePort = InMemoryOpaqueStore()
        record_id = ExtensionRecordId(UUIDS[0])
        first_payload = parse_canonical_json('{"b":2,"a":1}')
        equivalent_payload = parse_canonical_json('{"a":1,"b":2}')

        first = store.compare_and_set("example.extension.v1", record_id, None, first_payload)
        with self.assertRaisesRegex(BoundaryError, "does not match current revision"):
            store.compare_and_set("example.extension.v1", record_id, None, equivalent_payload)
        second = store.compare_and_set("example.extension.v1", record_id, 1, equivalent_payload)

        self.assertEqual(first.payload_sha256, second.payload_sha256)
        self.assertEqual(second.revision, 2)
        self.assertEqual(store.list_namespace("example.extension.v1", None, 1), (second,))

    def test_store_port_is_schema_opaque_and_page_bounds_are_closed(self) -> None:
        self.assertTrue(hasattr(OpaqueExtensionRecordStorePort, "compare_and_set"))
        self.assertTrue(hasattr(OpaqueExtensionRecordStorePort, "list_namespace"))
        self.assertEqual(validate_page_request(after_record_id=None, limit=1), (None, 1))
        self.assertEqual(
            validate_page_request(after_record_id=ExtensionRecordId(UUIDS[0]), limit=1000),
            (ExtensionRecordId(UUIDS[0]), 1000),
        )
        for invalid_limit in (0, 1001, True):
            with self.subTest(limit=invalid_limit), self.assertRaises(BoundaryError):
                validate_page_request(after_record_id=None, limit=invalid_limit)

    def test_reason_action_errors_have_stable_typed_fields(self) -> None:
        evidence = FailureEvidence(
            code="invalid-boundary",
            reason=Reason("The supplied value is invalid."),
            action=Action("Supply a canonical value."),
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
