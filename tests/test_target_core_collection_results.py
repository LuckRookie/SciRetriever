from __future__ import annotations

import unittest
from collections.abc import Callable
from typing import TypeVar

import sciretriever.model.collection as cm
import sciretriever.model.primitives as pm
from sciretriever.core.collection import run_results as rr
from sciretriever.core.collection.errors import CollectionRuleError

UUIDS = tuple(f"10000000-0000-4000-8000-{value:012d}" for value in range(1, 5))
ValueT = TypeVar("ValueT")


def _counts() -> cm.CollectionCounts:
    return cm.CollectionCounts(
        discovered=0, accepted=0, new_members=0, existing_members=0, missing=0, source_failures=0
    )


def _source() -> cm.CollectionSourceResult:
    return cm.CollectionSourceResult(ordinal=0, source="alpha", discovered=0, accepted=0, missing=0)


def _finish(
    status: pm.CollectionRunStatus,
    stop_reason: str | None = None,
) -> cm.FinishCollectionRun:
    return cm.FinishCollectionRun(
        run_id=pm.CollectionRunId(UUIDS[3]),
        status=status,
        stop_reason=stop_reason,
        counts=_counts(),
        source_results=(),
    )


class TargetCoreCollectionResultTests(unittest.TestCase):
    def _reject(self, function: Callable[[ValueT], None], value: ValueT) -> None:
        with self.assertRaises(CollectionRuleError):
            function(value)

    def test_counts_and_sources_reject_inconsistent_or_partial_failure_data(self) -> None:
        counts = _counts().model_copy(
            update={"discovered": 2, "accepted": 1, "new_members": 1, "missing": 1}
        )
        rr.validate_collection_counts(counts)
        for update in ({"new_members": 0}, {"discovered": 1}):
            with self.subTest(update=update):
                self._reject(rr.validate_collection_counts, counts.model_copy(update=update))
        source = _source().model_copy(update={"discovered": 1, "accepted": 1})
        rr.validate_collection_source_result(source)
        failed = source.model_copy(
            update={
                "failure_code": "provider-failed",
                "failure_reason": "source failed",
                "failure_action": "retry",
                "retryable": True,
            }
        )
        rr.validate_collection_source_result(failed)
        self._reject(
            rr.validate_collection_source_result, failed.model_copy(update={"failure_reason": None})
        )
        self.assertFalse(rr.collection_source_failed(source))
        self.assertTrue(rr.collection_source_failed(failed))

    def test_terminal_rules_distinguish_no_target_partial_failed_and_interrupted(self) -> None:
        no_target = _finish(pm.CollectionRunStatus.NO_TARGET)
        rr.validate_finish_collection_run(no_target)
        for status in (pm.CollectionRunStatus.CREATED, pm.CollectionRunStatus.RUNNING):
            with self.subTest(status=status):
                self._reject(
                    rr.validate_finish_collection_run,
                    no_target.model_copy(update={"status": status}),
                )
        for status in (
            pm.CollectionRunStatus.PARTIAL,
            pm.CollectionRunStatus.FAILED,
            pm.CollectionRunStatus.INTERRUPTED,
        ):
            with self.subTest(status=status):
                self._reject(
                    rr.validate_finish_collection_run,
                    no_target.model_copy(update={"status": status}),
                )
        self._reject(
            rr.validate_finish_collection_run,
            no_target.model_copy(update={"stop_reason": "reason"}),
        )
        rr.validate_finish_collection_run(_finish(pm.CollectionRunStatus.COMPLETED, "reason"))

    def test_terminal_rules_reconcile_source_order_totals_and_failures(self) -> None:
        source = _source().model_copy(
            update={
                "discovered": 1,
                "accepted": 1,
                "failure_code": "provider-failed",
                "failure_reason": "source failed",
                "failure_action": "retry",
                "retryable": True,
            }
        )
        counts = _counts().model_copy(
            update={"discovered": 1, "accepted": 1, "new_members": 1, "source_failures": 1}
        )
        command = cm.FinishCollectionRun(
            run_id=pm.CollectionRunId(UUIDS[3]),
            status=pm.CollectionRunStatus.PARTIAL,
            stop_reason="source-or-publication-failure",
            counts=counts,
            source_results=(source,),
        )
        rr.validate_finish_collection_run(command)
        invalid = (
            command.model_copy(update={"counts": counts.model_copy(update={"source_failures": 0})}),
            command.model_copy(
                update={"source_results": (source.model_copy(update={"ordinal": 1}),)}
            ),
            command.model_copy(
                update={"source_results": (source, source.model_copy(update={"source": "alpha"}))}
            ),
        )
        for value in invalid:
            with self.subTest(value=value):
                self._reject(rr.validate_finish_collection_run, value)


if __name__ == "__main__":
    unittest.main()
