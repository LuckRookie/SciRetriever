from __future__ import annotations

import unittest
from datetime import datetime, timedelta, timezone

from pydantic import ValidationError

from sciretriever.model.primitives import (
    AssetId,
    DiscoveryRunId,
    InternalId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance

_ID = "123e4567-e89b-12d3-a456-426614174000"
_HASH = "a" * 64
_TIMESTAMP = "2026-08-10T12:34:56.123Z"


class PrimitiveTests(unittest.TestCase):
    def test_internal_ids_are_canonical_nonempty_immutable_values(self) -> None:
        for value_type in (
            InternalId,
            ProvenanceId,
            MetaLiteratureId,
            LiteratureId,
            ObservationId,
            ReferenceId,
            AssetId,
            LiteratureAssetId,
            DiscoveryRunId,
        ):
            self.assertEqual(str(value_type(_ID)), _ID)
            self.assertEqual(value_type(_ID), value_type(_ID))
            self.assertEqual(hash(value_type(_ID)), hash(value_type(_ID)))
            with self.subTest(value_type=value_type.__name__):
                for invalid in ("", " ", _ID.upper(), "not-an-id", f" {_ID} "):
                    with self.assertRaises(ValidationError):
                        value_type(invalid)

    def test_sha256_accepts_only_lowercase_64_hex(self) -> None:
        self.assertEqual(Sha256(_HASH).root, _HASH)
        self.assertEqual(
            sha256_digest(b"hello").root,
            "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        )
        for invalid in ("", "a" * 63, "a" * 65, "A" * 64, "g" * 64, "a" * 63 + "!"):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValidationError):
                    Sha256(invalid)
        with self.assertRaises(TypeError):
            sha256_digest("hello")  # type: ignore[arg-type]

    def test_utc_timestamp_rejects_naive_and_non_utc_values(self) -> None:
        self.assertEqual(UtcTimestamp(_TIMESTAMP).root, _TIMESTAMP)
        self.assertEqual(
            UtcTimestamp.model_validate(
                datetime(2026, 8, 10, 12, 34, 56, 123000, tzinfo=timezone.utc)
            ).root,
            _TIMESTAMP,
        )
        self.assertEqual(
            UtcTimestamp("2026-08-10T12:34:56.123+00:00").root,
            _TIMESTAMP,
        )
        invalid = (
            "2026-08-10T12:34:56.123",
            "2026-08-10T12:34:56.123+08:00",
            datetime(2026, 8, 10, 12, 34, 56),
            datetime(2026, 8, 10, 12, 34, 56, tzinfo=timezone(timedelta(hours=8))),
        )
        for value in invalid:
            with self.subTest(value=value):
                with self.assertRaises(ValidationError):
                    UtcTimestamp(value)  # type: ignore[arg-type]

    def test_relative_artifact_path_is_normalized_posix_relative_path(self) -> None:
        for value in ("pdf/ab/file.pdf", "artifact.json", "目录/结果.md"):
            with self.subTest(value=value):
                self.assertEqual(RelativeArtifactPath(value).root, value)
        for invalid in (
            "",
            "/absolute/file.pdf",
            "../outside.pdf",
            "nested/../../outside.pdf",
            "./file.pdf",
            "nested//file.pdf",
            "nested/./file.pdf",
            "nested\\file.pdf",
            "https://example.test/file.pdf",
            "C:/file.pdf",
            "file.pdf?download=1",
            "file.pdf#fragment",
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(ValidationError):
                    RelativeArtifactPath(invalid)

    def test_source_kind_is_a_closed_five_value_enum(self) -> None:
        self.assertEqual(
            {item.value for item in SourceKind},
            {"metadata-provider", "asset-provider", "parser", "analysis", "user"},
        )
        with self.assertRaises(ValueError):
            SourceKind("analysis-model")
        with self.assertRaises(ValueError):
            SourceKind("unknown")


class ProvenanceTests(unittest.TestCase):
    def _provenance(self, **overrides: object) -> Provenance:
        values: dict[str, object] = {
            "provenance_id": ProvenanceId(_ID),
            "source_kind": SourceKind.METADATA_PROVIDER,
            "source_name": "crossref",
            "source_record_id": "record-123",
            "observed_at": UtcTimestamp(_TIMESTAMP),
            "input_sha256": Sha256(_HASH),
            "parameters_sha256": None,
        }
        values.update(overrides)
        return Provenance.model_validate(values)

    def test_provenance_has_exact_seven_fields(self) -> None:
        self.assertEqual(
            set(Provenance.model_fields),
            {
                "provenance_id",
                "source_kind",
                "source_name",
                "source_record_id",
                "observed_at",
                "input_sha256",
                "parameters_sha256",
            },
        )

    def test_provenance_round_trips_as_deterministic_json(self) -> None:
        original = self._provenance()
        encoded = original.model_dump_json()
        self.assertEqual(Provenance.model_validate_json(encoded), original)
        self.assertEqual(Provenance.model_validate_json(encoded).model_dump_json(), encoded)

    def test_provenance_is_immutable_and_rejects_unknown_fields(self) -> None:
        original = self._provenance()
        with self.assertRaises(ValidationError):
            original.source_name = "changed"  # type: ignore[misc]
        with self.assertRaises(ValidationError) as caught:
            Provenance(
                provenance_id=ProvenanceId(_ID),
                source_kind=SourceKind.USER,
                source_name="bibliographic-import",
                source_record_id=None,
                observed_at=UtcTimestamp(_TIMESTAMP),
                input_sha256=None,
                parameters_sha256=None,
                secret="SENSITIVE-SENTINEL",  # type: ignore[call-arg]
            )
        self.assertNotIn("SENSITIVE-SENTINEL", str(caught.exception))

    def test_provenance_rejects_blank_source_name_and_invalid_source_kind(self) -> None:
        with self.assertRaises(ValidationError):
            self._provenance(source_name=" ")
        with self.assertRaises(ValidationError):
            self._provenance(source_kind="not-a-source-kind")


if __name__ == "__main__":
    unittest.main()
