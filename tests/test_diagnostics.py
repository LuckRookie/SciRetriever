import asyncio
import json
from pathlib import Path
import sys
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.providers import ProviderAcquisitionError
from sciretriever.diagnostics import (
    ActionCode,
    AttemptMetadata,
    FailureStage,
    ReasonCode,
    decode_diagnostic,
    diagnostic_from_details,
    encode_diagnostic,
    map_exception,
)
from sciretriever.errors import CatalogError, StorageCorruptionError, ValidationError


class DiagnosticTests(TestCase):
    def test_typed_mapping_is_closed_and_deterministic(self):
        cases = (
            (ProviderAcquisitionError.for_status("example", 401), ReasonCode.AUTHENTICATION_REQUIRED, ActionCode.CHECK_CREDENTIALS, FailureStage.PROVIDER),
            (ProviderAcquisitionError.for_status("example", 429), ReasonCode.RATE_LIMITED, ActionCode.RETRY_LATER, FailureStage.PROVIDER),
            (ValidationError("sensitive source text"), ReasonCode.CONTENT_INVALID, ActionCode.REVIEW_CONTENT, FailureStage.VALIDATION),
            (StorageCorruptionError("sensitive source text"), ReasonCode.STORAGE_CORRUPTION, ActionCode.REPAIR_STORAGE, FailureStage.STORAGE),
            (CatalogError("sensitive source text"), ReasonCode.CATALOG_FAILURE, ActionCode.CONTACT_MAINTAINER, FailureStage.CATALOG),
            (RuntimeError("sensitive source text"), ReasonCode.UNKNOWN_FAILURE, ActionCode.CONTACT_MAINTAINER, FailureStage.ORCHESTRATION),
        )
        attempt = AttemptMetadata("candidate-1", 2, 15)
        for error, reason, action, stage in cases:
            with self.subTest(error=type(error).__name__):
                first = map_exception(error, provider="example", retryable=False, attempt=attempt)
                second = map_exception(error, provider="example", retryable=False, attempt=attempt)
                self.assertEqual(first, second)
                self.assertEqual((first.reason_code, first.action_code, first.stage), (reason, action, stage))
                self.assertNotIn("sensitive source text", first.summary)

    def test_codec_round_trip_and_strict_rejections(self):
        envelope = map_exception(
            ProviderAcquisitionError.for_status("example", 503),
            attempt=AttemptMetadata("candidate-1", 1, 20),
        )
        encoded = encode_diagnostic(envelope)
        self.assertEqual(decode_diagnostic(encoded), envelope)
        value = envelope.to_dict()
        invalid = (
            json.dumps(value),
            json.dumps({**value, "schema_version": 2}, sort_keys=True, separators=(",", ":")),
            json.dumps({key: item for key, item in value.items() if key != "stage"}, sort_keys=True, separators=(",", ":")),
            json.dumps({**value, "reason_code": "new_reason"}, sort_keys=True, separators=(",", ":")),
            json.dumps({**value, "diagnostic_id": "0" * 24}, sort_keys=True, separators=(",", ":")),
            json.dumps({**value, "schema_version": True}, sort_keys=True, separators=(",", ":")),
            json.dumps({**value, "extra": True}, sort_keys=True, separators=(",", ":")),
        )
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ValueError):
                decode_diagnostic(payload)

    def test_legacy_projection_is_stable_and_does_not_require_mutation(self):
        details = '{"provider":"legacy"}'
        first = diagnostic_from_details(details, category="transport", retryable=True, provider="legacy")
        second = diagnostic_from_details(details, category="transport", retryable=True, provider="legacy")
        self.assertEqual(first, second)
        self.assertEqual(first.reason_code, ReasonCode.PROVIDER_UNAVAILABLE)
        self.assertEqual(details, '{"provider":"legacy"}')

    def test_cancellation_and_untrusted_source_identifiers_are_closed(self):
        cancelled = map_exception(asyncio.CancelledError(), provider="example")
        self.assertEqual(
            (cancelled.reason_code, cancelled.action_code, cancelled.retryable),
            (ReasonCode.CANCELLED, ActionCode.NONE, False),
        )
        oversized_provider = map_exception(RuntimeError("ignored"), provider="x" * 81)
        self.assertIsNone(oversized_provider.provider)
        unsafe_provider = map_exception(RuntimeError("ignored"), provider="provider secret")
        self.assertIsNone(unsafe_provider.provider)
        with self.assertRaises(ValueError):
            AttemptMetadata("candidate" + "x" * 64, 1, 1)
        with self.assertRaises(ValueError):
            AttemptMetadata("Candidate Unsafe", 1, 1)
        with self.assertRaises(ValueError):
            AttemptMetadata("candidate", 2_147_483_648, 1)
        with self.assertRaises(ValueError):
            AttemptMetadata("candidate", 1, 2_147_483_648)


if __name__ == "__main__":
    import unittest

    unittest.main()
