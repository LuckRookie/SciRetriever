from __future__ import annotations

from sciretriever.catalog import CurationOperationOwner
from sciretriever.catalog.curation import CurationRequest
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.snapshots import SafeSnapshot

from curation_wp6_fixture import CurationCatalogCase


class InjectedCurationFailure(Exception):
    __slots__ = ("point",)

    def __init__(self, point: str) -> None:
        self.point = point

    def __str__(self) -> str:
        return f"injected:{self.point}"


class CurationRollbackTests(CurationCatalogCase):
    def request(self) -> CurationRequest:
        return CurationRequest(
            handler=self.handler,
            review_decision=ReviewDecision.NOT_REQUIRED,
            evidence=SafeSnapshot.from_pairs((("decision", "rollback"),)),
        )

    def test_every_forward_failpoint_restores_exact_pre_state(self) -> None:
        before = self.state()
        for failpoint in CurationOperationOwner.apply_failpoints(self.handler):
            with self.subTest(failpoint=failpoint):
                def inject(point: str, expected: str = failpoint) -> None:
                    if point == expected:
                        raise InjectedCurationFailure(point)

                owner = CurationOperationOwner(self.catalog, test_failpoint=inject)
                with self.assertRaisesRegex(InjectedCurationFailure, f"injected:{failpoint}"):
                    owner.apply(self.request())
                self.assertEqual(self.state(), before)

    def test_every_undo_failpoint_restores_exact_applied_state(self) -> None:
        for failpoint in CurationOperationOwner.undo_failpoints(self.handler):
            with self.subTest(failpoint=failpoint):
                owner = CurationOperationOwner(self.catalog)
                applied = owner.apply(self.request())
                before = self.state()

                def inject(point: str, expected: str = failpoint) -> None:
                    if point == expected:
                        raise InjectedCurationFailure(point)

                failing_owner = CurationOperationOwner(self.catalog, test_failpoint=inject)
                with self.assertRaisesRegex(InjectedCurationFailure, f"injected:{failpoint}"):
                    failing_owner.undo(applied.id, self.handler)
                self.assertEqual(self.state(), before)
                owner.undo(applied.id, self.handler)


if __name__ == "__main__":
    import unittest

    unittest.main()
