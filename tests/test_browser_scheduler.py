from __future__ import annotations

import threading
import unittest

from sciretriever.network.browser_scheduler import (
    BrowserArticleAttempt,
    BrowserSchedulerCancellation,
)


class _AdvancingClock:
    def __init__(self) -> None:
        self.current = 0.0
        self.waited_until: list[float] = []
        self._lock = threading.Lock()

    def now(self) -> float:
        with self._lock:
            return self.current

    def wait_until(
        self,
        deadline: float,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None:
        del cancel_event
        with self._lock:
            self.waited_until.append(deadline)
            self.current = max(self.current, deadline)


class BrowserGroupSchedulerContractTests(unittest.TestCase):
    def _attempt(
        self,
        key: str,
        group: str,
        *,
        interval: float = 0.0,
    ) -> BrowserArticleAttempt:
        from sciretriever.network.browser_scheduler import (
            BrowserArticleAttempt,
            BrowserGroupPolicy,
        )

        return BrowserArticleAttempt(
            attempt_key=key,
            rate_limit_group=group,
            session_key=group,
            policy=BrowserGroupPolicy(
                rate_limit_group=group,
                minimum_start_interval=interval,
            ),
        )

    def test_different_groups_overlap_while_one_group_never_overlaps(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        scheduler = BrowserGroupScheduler(clock=_AdvancingClock(), max_concurrency=2)
        entered = {"wiley": threading.Event(), "elsevier": threading.Event()}
        release = threading.Event()
        active_by_group: dict[str, int] = {}
        maximum_by_group: dict[str, int] = {}
        lock = threading.Lock()

        def run(attempt: BrowserArticleAttempt) -> str:
            with lock:
                active_by_group[attempt.rate_limit_group] = (
                    active_by_group.get(attempt.rate_limit_group, 0) + 1
                )
                maximum_by_group[attempt.rate_limit_group] = max(
                    maximum_by_group.get(attempt.rate_limit_group, 0),
                    active_by_group[attempt.rate_limit_group],
                )
            entered[attempt.rate_limit_group].set()
            if not all(event.wait(1.0) for event in entered.values()):
                raise AssertionError("independent Browser groups did not overlap")
            release.set()
            release.wait(1.0)
            with lock:
                active_by_group[attempt.rate_limit_group] -= 1
            return attempt.attempt_key

        result = scheduler.execute(
            (
                self._attempt("w1", "wiley"),
                self._attempt("e1", "elsevier"),
                self._attempt("w2", "wiley"),
            ),
            run,
        )

        self.assertEqual(result, ("w1", "e1", "w2"))
        self.assertEqual(maximum_by_group, {"wiley": 1, "elsevier": 1})

    def test_group_interval_is_measured_between_article_starts(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        clock = _AdvancingClock()
        scheduler = BrowserGroupScheduler(clock=clock, max_concurrency=2)
        starts: list[float] = []

        scheduler.execute(
            (
                self._attempt("w1", "wiley", interval=12.0),
                self._attempt("w2", "wiley", interval=12.0),
                self._attempt("w3", "wiley", interval=12.0),
            ),
            lambda _attempt: starts.append(clock.now()),
        )

        self.assertEqual(starts, [0.0, 12.0, 24.0])
        self.assertEqual(clock.waited_until, [12.0, 24.0])


if __name__ == "__main__":
    unittest.main()
