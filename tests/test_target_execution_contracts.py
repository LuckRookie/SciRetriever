from __future__ import annotations

import ast
import importlib
import unittest
from pathlib import Path

from pydantic import BaseModel

from sciretriever.model.canonical_json import CanonicalJsonObject
from sciretriever.model.primitives import BatchRunId, WorkVersionId

ROOT = Path(__file__).parents[1]
SRC = ROOT / "src" / "sciretriever"
EXECUTION_NAMES = (
    "CurrentFailure",
    "TargetResult",
    "TargetResultEnvelope",
    "TargetProjection",
    "ImportResult",
    "ImportRecordProjection",
    "BatchSummary",
    "BatchDetail",
)


class TargetExecutionContractTests(unittest.TestCase):
    def test_execution_contracts_have_one_strict_frozen_model_owner(self) -> None:
        target = importlib.import_module("sciretriever.model.execution")
        for name in EXECUTION_NAMES:
            contract = getattr(target, name, None)
            self.assertIsNotNone(contract, name)
            assert contract is not None
            self.assertTrue(issubclass(contract, BaseModel), name)
            self.assertIs(contract.__module__, target.__name__, name)
            self.assertTrue(contract.model_config["frozen"], name)
            self.assertTrue(contract.model_config["strict"], name)
            self.assertEqual(contract.model_config["extra"], "forbid", name)

    def test_execution_models_have_no_business_methods(self) -> None:
        target = importlib.import_module("sciretriever.model.execution")
        for name in (*EXECUTION_NAMES, "Reason", "Action", "FailureEvidence"):
            contract = getattr(target, name)
            self.assertNotIn("__str__", contract.__dict__, name)
            self.assertNotIn("__post_init__", contract.__dict__, name)
            self.assertNotIn("canonical", contract.__dict__, name)
            self.assertNotIn("result_envelope", contract.__dict__, name)

    def test_batching_no_longer_defines_execution_data_contracts(self) -> None:
        path = SRC / "batching" / "publisher_contracts.py"
        tree = ast.parse(path.read_text(encoding="utf-8"))
        defined = {
            node.name
            for node in ast.walk(tree)
            if isinstance(node, (ast.ClassDef, ast.FunctionDef))
        }
        self.assertTrue(
            defined.isdisjoint(
                {
                    "CurrentFailure",
                    "TargetResult",
                    "TargetResultEnvelope",
                    "TargetProjection",
                    "ImportResult",
                    "ImportRecordProjection",
                    "BatchSummary",
                    "BatchDetail",
                }
            )
        )

    def test_core_canonicalization_preserves_target_payload_bytes(self) -> None:
        execution = importlib.import_module("sciretriever.model.execution")
        core = importlib.import_module("sciretriever.core.execution")
        version_id = WorkVersionId("20000000-0000-0000-0000-000000000001")
        target = execution.TargetProjection(
            batch_run_id=BatchRunId("10000000-0000-0000-0000-000000000001"),
            work_version_id=version_id,
            result=execution.TargetResult(
                subject_type="work-version",
                subject_id=str(version_id),
                outcome="partially-advanced",
                initial_state="unreviewed",
                target_state="asset-ready",
                final_state="asset-ready",
                stage="asset",
                failure=None,
            ),
            details=CanonicalJsonObject(()),
            failure_stages_to_clear=("asset",),
        )

        self.assertEqual(
            core.canonical_target_projection(target),
            b'{"batch_run_id":"10000000-0000-0000-0000-000000000001",'
            b'"details":{},"failure_stages_to_clear":["asset"],'
            b'"result":"partially-advanced",'
            b'"work_version_id":"20000000-0000-0000-0000-000000000001"}',
        )

    def test_core_rejects_cross_work_version_alignment_before_write(self) -> None:
        execution = importlib.import_module("sciretriever.model.execution")
        core = importlib.import_module("sciretriever.core.execution")
        target = execution.TargetProjection(
            batch_run_id=BatchRunId("10000000-0000-0000-0000-000000000001"),
            work_version_id=WorkVersionId("20000000-0000-0000-0000-000000000001"),
            result=execution.TargetResult(
                subject_type="work-version",
                subject_id="20000000-0000-0000-0000-000000000001",
                outcome="completed",
                initial_state="light-text-ready",
                target_state="completed",
                final_state="completed",
                stage="completion",
                failure=None,
            ),
            details=CanonicalJsonObject(()),
            failure_stages_to_clear=("analysis", "completion"),
        )

        with self.assertRaises(core.ExecutionRejectedError):
            core.validate_target_alignment(
                target,
                WorkVersionId("20000000-0000-0000-0000-000000000002"),
            )


if __name__ == "__main__":
    unittest.main()
