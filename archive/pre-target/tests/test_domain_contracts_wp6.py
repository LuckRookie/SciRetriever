import ast
import json
from pathlib import Path
import subprocess
import sys
import traceback
import unittest

from sciretriever.core.curation import (
    CurationAction,
    CurationOperation,
    CurationOperationId,
    CurationResult,
    CurationSubjectKind,
    ReviewDecision,
)
from sciretriever.core.snapshots import SafeSnapshot, SnapshotBoundaryError
from sciretriever.diagnostics.contracts import (
    ProductFailureAction,
    ProductFailureReason,
    ProductFailureStage,
)
from sciretriever.diagnostics.product import (
    DiagnosticSubjectKind,
    ProductFailure,
    ProductFailureBoundaryError,
    RerunGuidance,
)


class Python310CompatibilityTests(unittest.TestCase):
    MODULE_PATHS = (
        Path("src/sciretriever/core/curation.py"),
        Path("src/sciretriever/diagnostics/product.py"),
    )

    def test_todo3_modules_import_when_python311_typing_and_enum_apis_are_unavailable(self) -> None:
        script = """
import enum
import typing

del enum.StrEnum
del typing.assert_never

import sciretriever.core.curation
import sciretriever.diagnostics.product
"""

        completed = subprocess.run(
            [sys.executable, "-c", script],
            check=False,
            capture_output=True,
            text=True,
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)

    def test_todo3_modules_do_not_import_python311_only_symbols(self) -> None:
        forbidden = {("enum", "StrEnum"), ("typing", "assert_never")}

        for path in self.MODULE_PATHS:
            with self.subTest(path=path):
                imported = {
                    (node.module, alias.name)
                    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8")))
                    if isinstance(node, ast.ImportFrom)
                    for alias in node.names
                }
                self.assertTrue(forbidden.isdisjoint(imported), forbidden & imported)


class ProductFailureContractTests(unittest.TestCase):
    def test_vocabulary_is_frozen_when_contracts_are_imported(self) -> None:
        self.assertEqual(
            tuple(item.value for item in ProductFailureStage),
            ("metadata", "acquisition", "analysis", "expansion"),
        )
        self.assertEqual(
            tuple(item.value for item in ProductFailureReason),
            ("configuration", "provider", "identity", "content", "storage", "catalog", "interrupted"),
        )
        self.assertEqual(
            tuple(item.value for item in ProductFailureAction),
            ("check_configuration", "check_credentials", "retry", "try_another_source", "review", "repair_storage", "none"),
        )

    def test_failure_round_trip_is_canonical_when_valid(self) -> None:
        failure = ProductFailure(
            stage=ProductFailureStage.ACQUISITION,
            subject_kind=DiagnosticSubjectKind.WORK_VERSION,
            subject_id="123e4567-e89b-42d3-a456-426614174000",
            reason=ProductFailureReason.PROVIDER,
            action=ProductFailureAction.TRY_ANOTHER_SOURCE,
            rerun=RerunGuidance.AFTER_SOURCE_CHANGE,
        )

        encoded = failure.to_json_bytes()
        decoded = ProductFailure.from_json_bytes(encoded)

        self.assertEqual(decoded, failure)
        self.assertEqual(decoded.to_json_bytes(), encoded)

    def test_failure_rejects_unknown_and_duplicate_keys_without_echoing_input(self) -> None:
        sentinel = "TOKEN-SENTINEL"
        malformed = (
            b'{"action":"retry","reason":"provider","rerun":"retry","stage":"metadata",'
            b'"subject_id":"sha256:' + sentinel.encode() + b'","subject_kind":"input","unknown":true}',
            b'{"action":"retry","action":"none","reason":"provider","rerun":"retry",'
            b'"stage":"metadata","subject_id":"sha256:' + b"0" * 64 + b'","subject_kind":"input"}',
        )

        for payload in malformed:
            with self.subTest(payload=payload), self.assertRaises(ProductFailureBoundaryError) as caught:
                ProductFailure.from_json_bytes(payload)
            self.assertNotIn(sentinel, str(caught.exception))

    def test_hostile_action_is_absent_from_the_complete_failure_traceback(self) -> None:
        sentinel = "SECRET-SENTINEL"
        payload = json.dumps(
            {
                "action": sentinel,
                "reason": "provider",
                "rerun": "retry",
                "stage": "metadata",
                "subject_id": "sha256:" + "0" * 64,
                "subject_kind": "input",
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("ascii")

        with self.assertRaises(ProductFailureBoundaryError) as caught:
            ProductFailure.from_json_bytes(payload)

        rendered = "".join(traceback.format_exception(caught.exception))
        self.assertNotIn(sentinel, rendered)


class CurationContractTests(unittest.TestCase):
    def test_action_vocabulary_is_frozen_when_contracts_are_imported(self) -> None:
        self.assertEqual(
            tuple(item.value for item in CurationAction),
            (
                "resolve_review", "merge_work", "regroup_work_version", "set_preferred",
                "clear_preferred", "set_metadata", "clear_metadata", "add_tag",
                "remove_tag", "merge_author", "undo",
            ),
        )

    def test_operation_round_trip_preserves_hash_when_valid(self) -> None:
        before = SafeSnapshot.from_pairs((("preferred_work_version_id", None),))
        after = SafeSnapshot.from_pairs(
            (("preferred_work_version_id", "123e4567-e89b-42d3-a456-426614174000"),)
        )
        operation = CurationOperation.create(
            action=CurationAction.SET_PREFERRED,
            subject_kind=CurationSubjectKind.WORK,
            subject_id="123e4567-e89b-42d3-a456-426614174001",
            before=before,
            after=after,
            review_decision=ReviewDecision.CONFIRMED,
        )

        encoded = operation.to_json_bytes()
        decoded = CurationOperation.from_json_bytes(encoded)

        self.assertEqual(decoded, operation)
        self.assertEqual(decoded.to_json_bytes(), encoded)
        self.assertEqual(decoded.result, CurationResult.APPLIED)
        self.assertEqual(len(decoded.operation_sha256), 64)

    def test_undo_requires_an_operation_subject_and_explicit_target(self) -> None:
        snapshot = SafeSnapshot.from_pairs((("work_id", "123e4567-e89b-42d3-a456-426614174001"),))

        with self.assertRaises(SnapshotBoundaryError):
            CurationOperation.create(
                action=CurationAction.UNDO,
                subject_kind=CurationSubjectKind.WORK,
                subject_id="123e4567-e89b-42d3-a456-426614174001",
                before=snapshot,
                after=snapshot,
                review_decision=ReviewDecision.NOT_REQUIRED,
            )

    def test_action_subject_matrix_and_undo_round_trip_match_catalog_schema(self) -> None:
        identifier = "123e4567-e89b-42d3-a456-426614174001"
        snapshot = SafeSnapshot.from_pairs((("work_id", identifier),))
        subjects = {
            CurationAction.RESOLVE_REVIEW: CurationSubjectKind.REVIEW,
            CurationAction.MERGE_WORK: CurationSubjectKind.WORK,
            CurationAction.REGROUP_WORK_VERSION: CurationSubjectKind.WORK_VERSION,
            CurationAction.SET_PREFERRED: CurationSubjectKind.WORK,
            CurationAction.CLEAR_PREFERRED: CurationSubjectKind.WORK,
            CurationAction.SET_METADATA: CurationSubjectKind.WORK_VERSION,
            CurationAction.CLEAR_METADATA: CurationSubjectKind.WORK_VERSION,
            CurationAction.ADD_TAG: CurationSubjectKind.WORK,
            CurationAction.REMOVE_TAG: CurationSubjectKind.WORK,
            CurationAction.MERGE_AUTHOR: CurationSubjectKind.AUTHOR,
            CurationAction.UNDO: CurationSubjectKind.OPERATION,
        }

        for action, subject in subjects.items():
            with self.subTest(action=action):
                undo_of = CurationOperationId(identifier) if action is CurationAction.UNDO else None
                operation = CurationOperation.create(
                    action=action,
                    subject_kind=subject,
                    subject_id=identifier,
                    before=snapshot,
                    after=snapshot,
                    review_decision=ReviewDecision.NOT_REQUIRED,
                    undo_of=undo_of,
                )
                self.assertEqual(CurationOperation.from_json_bytes(operation.to_json_bytes()), operation)

        for action, compatible_subject in subjects.items():
            for subject in CurationSubjectKind:
                if subject is compatible_subject:
                    continue
                with self.subTest(action=action, rejected_subject=subject), self.assertRaises(SnapshotBoundaryError):
                    CurationOperation.create(
                        action=action,
                        subject_kind=subject,
                        subject_id=identifier,
                        before=snapshot,
                        after=snapshot,
                        review_decision=ReviewDecision.NOT_REQUIRED,
                        undo_of=CurationOperationId(identifier) if action is CurationAction.UNDO else None,
                    )

        with self.assertRaises(SnapshotBoundaryError):
            CurationOperation.create(
                action=CurationAction.MERGE_WORK,
                subject_kind=CurationSubjectKind.WORK,
                subject_id=identifier,
                before=snapshot,
                after=snapshot,
                review_decision=ReviewDecision.NOT_REQUIRED,
                undo_of=CurationOperationId(identifier),
            )

    def test_operation_hash_detects_stale_or_tampered_payload(self) -> None:
        operation = CurationOperation.create(
            action=CurationAction.ADD_TAG,
            subject_kind=CurationSubjectKind.WORK,
            subject_id="123e4567-e89b-42d3-a456-426614174001",
            before=SafeSnapshot.from_pairs((("tag_id", None),)),
            after=SafeSnapshot.from_pairs((("tag_id", "123e4567-e89b-42d3-a456-426614174002"),)),
            review_decision=ReviewDecision.NOT_REQUIRED,
        )
        payload = json.loads(operation.to_json_bytes())
        payload["result"] = "undone"
        tampered = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("ascii")

        with self.assertRaises(SnapshotBoundaryError):
            CurationOperation.from_json_bytes(tampered)

    def test_snapshot_rejects_secret_path_url_and_unbounded_values(self) -> None:
        sentinel = "SECRET-SENTINEL"
        invalid = (
            (("token", sentinel),),
            (("title", f"https://example.test/{sentinel}"),),
            (("storage_path", f"/tmp/{sentinel}"),),
            (("title", "x" * 513),),
            (("unknown_field", "value"),),
        )

        for pairs in invalid:
            with self.subTest(pairs=pairs), self.assertRaises(SnapshotBoundaryError) as caught:
                SafeSnapshot.from_pairs(pairs)
            self.assertNotIn(sentinel, str(caught.exception))


if __name__ == "__main__":
    unittest.main()
