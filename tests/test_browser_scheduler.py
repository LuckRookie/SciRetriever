from __future__ import annotations

import pickle
import threading
import unittest

from sciretriever.network.browser_scheduler import (
    BrowserArticleAttempt,
    BrowserAttemptCompletion,
    BrowserAttemptDisposition,
    BrowserCircuitReason,
    BrowserGroupFeedback,
    BrowserScheduledDisposition,
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

    def advance(self, seconds: float) -> None:
        with self._lock:
            self.current += seconds

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
        maximum_starts_per_window: int | None = None,
        window_seconds: float | None = None,
        cooldown_after_completion: float = 0.0,
        failure_cooldown: float = 0.0,
        rate_limit_cooldown: float = 30.0,
        runtime_failure_threshold: int = 3,
        revision: str = "fixture-v1",
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
                policy_revision=revision,
                minimum_start_interval=interval,
                rate_limit_cooldown=rate_limit_cooldown,
                runtime_failure_threshold=runtime_failure_threshold,
                maximum_starts_per_window=maximum_starts_per_window,
                window_seconds=window_seconds,
                cooldown_after_completion=cooldown_after_completion,
                failure_cooldown=failure_cooldown,
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

        def run(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
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
            return BrowserAttemptCompletion(
                attempt.attempt_key,
                BrowserAttemptDisposition.COMPLETED,
                BrowserGroupFeedback.SUCCESS,
            )

        result = scheduler.execute(
            (
                self._attempt("w1", "wiley"),
                self._attempt("e1", "elsevier"),
                self._attempt("w2", "wiley"),
            ),
            run,
        )

        self.assertEqual(tuple(item.value for item in result), ("w1", "e1", "w2"))
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
            lambda _attempt: BrowserAttemptCompletion(
                starts.append(clock.now()),
                BrowserAttemptDisposition.COMPLETED,
                BrowserGroupFeedback.SUCCESS,
            ),
        )

        self.assertEqual(starts, [0.0, 12.0, 24.0])
        self.assertEqual(clock.waited_until, [12.0, 24.0])

    def test_window_completion_and_failure_cooldowns_are_all_enforced(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        clock = _AdvancingClock()
        scheduler = BrowserGroupScheduler(clock=clock, max_concurrency=2)
        starts: list[float] = []
        attempts = tuple(
            self._attempt(
                f"w{index}",
                "wiley",
                interval=1.0,
                maximum_starts_per_window=2,
                window_seconds=10.0,
                cooldown_after_completion=2.0,
                failure_cooldown=5.0,
            )
            for index in range(1, 5)
        )

        def run(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
            starts.append(clock.now())
            disposition = (
                BrowserAttemptDisposition.FAILED
                if attempt.attempt_key == "w2"
                else BrowserAttemptDisposition.COMPLETED
            )
            return BrowserAttemptCompletion(
                attempt.attempt_key,
                disposition,
                (
                    BrowserGroupFeedback.NONE
                    if disposition is BrowserAttemptDisposition.FAILED
                    else BrowserGroupFeedback.SUCCESS
                ),
            )

        result = scheduler.execute(attempts, run)

        self.assertEqual(
            tuple(item.value for item in result),
            ("w1", "w2", "w3", "w4"),
        )
        self.assertEqual(starts, [0.0, 2.0, 10.0, 12.0])
        self.assertEqual(clock.waited_until, [2.0, 10.0, 12.0])

    def test_callback_exception_retains_failure_cooldown_for_next_execution(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        clock = _AdvancingClock()
        scheduler = BrowserGroupScheduler(clock=clock, max_concurrency=1)
        first = self._attempt("w1", "wiley", failure_cooldown=10.0)

        def fail(_attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[None]:
            clock.advance(3.0)
            raise RuntimeError("fixture Browser crash")

        with self.assertRaisesRegex(RuntimeError, "fixture Browser crash"):
            scheduler.execute((first,), fail)

        starts: list[float] = []
        second = self._attempt("w2", "wiley", failure_cooldown=10.0)
        scheduler.execute(
            (second,),
            lambda _attempt: BrowserAttemptCompletion(
                starts.append(clock.now()),
                BrowserAttemptDisposition.COMPLETED,
                BrowserGroupFeedback.SUCCESS,
            ),
        )
        self.assertEqual(starts, [13.0])
        self.assertEqual(clock.waited_until, [13.0])

    def test_cancelled_waiter_never_enters_or_releases_an_active_group(self) -> None:
        from sciretriever.network.browser_scheduler import (
            BrowserGroupScheduler,
            BrowserSchedulingCancelled,
        )

        scheduler = BrowserGroupScheduler(clock=_AdvancingClock(), max_concurrency=2)
        entered = threading.Event()
        release = threading.Event()
        first_result: list[tuple[str | None, ...]] = []

        def hold(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
            entered.set()
            release.wait(1.0)
            return BrowserAttemptCompletion(
                attempt.attempt_key,
                BrowserAttemptDisposition.COMPLETED,
                BrowserGroupFeedback.SUCCESS,
            )

        worker = threading.Thread(
            target=lambda: first_result.append(
                tuple(
                    item.value for item in scheduler.execute((self._attempt("w1", "wiley"),), hold)
                )
            )
        )
        worker.start()
        self.assertTrue(entered.wait(1.0))

        cancelled = threading.Event()
        cancelled.set()
        second_entered = False

        def should_not_run(
            _attempt: BrowserArticleAttempt,
        ) -> BrowserAttemptCompletion[None]:
            nonlocal second_entered
            second_entered = True
            return BrowserAttemptCompletion(
                None,
                BrowserAttemptDisposition.COMPLETED,
                BrowserGroupFeedback.SUCCESS,
            )

        with self.assertRaises(BrowserSchedulingCancelled):
            scheduler.execute(
                (self._attempt("w2", "wiley"),),
                should_not_run,
                cancel_event=cancelled,
            )

        self.assertFalse(second_entered)
        self.assertFalse(release.is_set())
        release.set()
        worker.join(1.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(first_result, [("w1",)])

    def test_rate_limit_blocks_queued_and_new_attempts_until_exact_deadline(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        clock = _AdvancingClock()
        scheduler = BrowserGroupScheduler(clock=clock, max_concurrency=2)
        calls: list[str] = []

        def run(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
            calls.append(attempt.attempt_key)
            if attempt.attempt_key == "w1":
                return BrowserAttemptCompletion(
                    attempt.attempt_key,
                    BrowserAttemptDisposition.FAILED,
                    BrowserGroupFeedback.RATE_LIMITED,
                )
            return BrowserAttemptCompletion(
                attempt.attempt_key,
                BrowserAttemptDisposition.COMPLETED,
                BrowserGroupFeedback.SUCCESS,
            )

        first = scheduler.execute(
            (
                self._attempt("w1", "wiley", rate_limit_cooldown=30.0),
                self._attempt("w2", "wiley", rate_limit_cooldown=30.0),
            ),
            run,
        )

        self.assertEqual(calls, ["w1"])
        self.assertIs(first[0].disposition, BrowserScheduledDisposition.EXECUTED)
        self.assertIs(first[1].disposition, BrowserScheduledDisposition.DEFERRED)
        blocked = first[1].runtime_state
        self.assertIsNotNone(blocked)
        if blocked is None:
            self.fail("rate-limited attempt did not expose its safe runtime state")
        self.assertEqual(blocked.blocked_for_seconds, 30.0)

        clock.advance(29.999)
        before_deadline = scheduler.execute(
            (self._attempt("w3", "wiley", rate_limit_cooldown=30.0),),
            run,
        )
        self.assertIs(before_deadline[0].disposition, BrowserScheduledDisposition.DEFERRED)
        self.assertEqual(calls, ["w1"])

        clock.advance(0.001)
        at_deadline = scheduler.execute(
            (self._attempt("w4", "wiley", rate_limit_cooldown=30.0),),
            run,
        )
        self.assertIs(at_deadline[0].disposition, BrowserScheduledDisposition.EXECUTED)
        self.assertEqual(calls, ["w1", "w4"])

    def test_action_required_circuit_stops_same_group_and_other_group_continues(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        scheduler = BrowserGroupScheduler(clock=_AdvancingClock(), max_concurrency=2)
        calls: list[str] = []
        lock = threading.Lock()

        def run(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
            with lock:
                calls.append(attempt.attempt_key)
            feedback = (
                BrowserGroupFeedback.CHALLENGE_REQUIRED
                if attempt.attempt_key == "w1"
                else BrowserGroupFeedback.SUCCESS
            )
            return BrowserAttemptCompletion(
                attempt.attempt_key,
                (
                    BrowserAttemptDisposition.FAILED
                    if feedback is BrowserGroupFeedback.CHALLENGE_REQUIRED
                    else BrowserAttemptDisposition.COMPLETED
                ),
                feedback,
            )

        results = scheduler.execute(
            (
                self._attempt("w1", "wiley"),
                self._attempt("w2", "wiley"),
                self._attempt("e1", "elsevier"),
            ),
            run,
        )

        self.assertEqual(set(calls), {"w1", "e1"})
        self.assertIs(results[1].disposition, BrowserScheduledDisposition.ACTION_REQUIRED)
        runtime_state = results[1].runtime_state
        self.assertIsNotNone(runtime_state)
        if runtime_state is None:
            self.fail("open circuit did not expose its safe runtime state")
        self.assertIs(runtime_state.circuit_reason, BrowserCircuitReason.CHALLENGE_REQUIRED)
        self.assertIs(results[2].disposition, BrowserScheduledDisposition.EXECUTED)

        new_route = scheduler.execute((self._attempt("w3", "wiley"),), run)
        self.assertIs(new_route[0].disposition, BrowserScheduledDisposition.ACTION_REQUIRED)
        self.assertNotIn("w3", calls)

        acknowledged = scheduler.acknowledge_circuit("wiley", "fixture-v1")
        self.assertIsNone(acknowledged.circuit_reason)
        resumed = scheduler.execute((self._attempt("w4", "wiley"),), run)
        self.assertIs(resumed[0].disposition, BrowserScheduledDisposition.EXECUTED)
        self.assertIn("w4", calls)

    def test_each_action_required_feedback_opens_only_manual_reset_path(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        expected = {
            BrowserGroupFeedback.LOGIN_REQUIRED: BrowserCircuitReason.LOGIN_REQUIRED,
            BrowserGroupFeedback.MFA_REQUIRED: BrowserCircuitReason.MFA_REQUIRED,
            BrowserGroupFeedback.CHALLENGE_REQUIRED: BrowserCircuitReason.CHALLENGE_REQUIRED,
            BrowserGroupFeedback.IP_BLOCKED: BrowserCircuitReason.IP_BLOCKED,
            BrowserGroupFeedback.ACCOUNT_WARNING: BrowserCircuitReason.ACCOUNT_WARNING,
            BrowserGroupFeedback.CLEANUP_FAILURE: BrowserCircuitReason.CLEANUP_FAILURE,
        }
        for feedback, reason in expected.items():
            with self.subTest(feedback=feedback.value):
                scheduler = BrowserGroupScheduler(clock=_AdvancingClock(), max_concurrency=1)
                calls: list[str] = []

                def run(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
                    calls.append(attempt.attempt_key)
                    return BrowserAttemptCompletion(
                        attempt.attempt_key,
                        BrowserAttemptDisposition.FAILED,
                        feedback,
                    )

                results = scheduler.execute(
                    (self._attempt("w1", "wiley"), self._attempt("w2", "wiley")),
                    run,
                )
                self.assertEqual(calls, ["w1"])
                self.assertIs(
                    results[1].disposition,
                    BrowserScheduledDisposition.ACTION_REQUIRED,
                )
                state = results[1].runtime_state
                self.assertIsNotNone(state)
                if state is None:
                    self.fail("action-required feedback did not open a circuit")
                self.assertIs(state.circuit_reason, reason)
                with self.assertRaises(ValueError):
                    scheduler.acknowledge_circuit("wiley", "wrong-revision")
                self.assertIsNone(
                    scheduler.acknowledge_circuit("wiley", "fixture-v1").circuit_reason
                )

    def test_consecutive_runtime_failure_threshold_is_explicit_and_success_resets_it(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        scheduler = BrowserGroupScheduler(clock=_AdvancingClock(), max_concurrency=1)
        calls: list[str] = []

        def fail(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
            calls.append(attempt.attempt_key)
            return BrowserAttemptCompletion(
                attempt.attempt_key,
                BrowserAttemptDisposition.FAILED,
                BrowserGroupFeedback.RUNTIME_FAILURE,
            )

        results = scheduler.execute(
            tuple(
                self._attempt(
                    f"w{index}",
                    "wiley",
                    runtime_failure_threshold=2,
                )
                for index in range(1, 4)
            ),
            fail,
        )
        self.assertEqual(calls, ["w1", "w2"])
        self.assertIs(results[2].disposition, BrowserScheduledDisposition.ACTION_REQUIRED)
        runtime_state = results[2].runtime_state
        self.assertIsNotNone(runtime_state)
        if runtime_state is None:
            self.fail("runtime circuit did not expose its safe runtime state")
        self.assertEqual(runtime_state.consecutive_runtime_failures, 2)
        self.assertIs(runtime_state.circuit_reason, BrowserCircuitReason.RUNTIME_FAILURE)

        reset_scheduler = BrowserGroupScheduler(clock=_AdvancingClock(), max_concurrency=1)
        policy_attempts = (
            self._attempt("r1", "wiley", runtime_failure_threshold=2),
            self._attempt("r2", "wiley", runtime_failure_threshold=2),
            self._attempt("r3", "wiley", runtime_failure_threshold=2),
            self._attempt("r4", "wiley", runtime_failure_threshold=2),
        )

        def intermittent(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
            failed = attempt.attempt_key in {"r1", "r3"}
            return BrowserAttemptCompletion(
                attempt.attempt_key,
                (
                    BrowserAttemptDisposition.FAILED
                    if failed
                    else BrowserAttemptDisposition.COMPLETED
                ),
                (BrowserGroupFeedback.RUNTIME_FAILURE if failed else BrowserGroupFeedback.SUCCESS),
            )

        reset_results = reset_scheduler.execute(policy_attempts, intermittent)
        self.assertTrue(
            all(
                result.disposition is BrowserScheduledDisposition.EXECUTED
                for result in reset_results
            )
        )
        self.assertEqual(
            reset_scheduler.runtime_snapshot(
                policy_attempts[0].policy
            ).consecutive_runtime_failures,
            0,
        )

    def test_logging_explains_group_wait_pause_feedback_and_cleanup(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        clock = _AdvancingClock()
        scheduler = BrowserGroupScheduler(clock=clock, max_concurrency=1)

        def run(attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[str]:
            feedback = (
                BrowserGroupFeedback.RATE_LIMITED
                if attempt.attempt_key == "w2"
                else BrowserGroupFeedback.SUCCESS
            )
            return BrowserAttemptCompletion(
                attempt.attempt_key,
                (
                    BrowserAttemptDisposition.FAILED
                    if feedback is BrowserGroupFeedback.RATE_LIMITED
                    else BrowserAttemptDisposition.COMPLETED
                ),
                feedback,
            )

        with self.assertLogs("sciretriever.network.browser_scheduler", level="DEBUG") as captured:
            result = scheduler.execute(
                (
                    self._attempt("w1", "wiley", interval=5.0),
                    self._attempt("w2", "wiley", interval=5.0),
                    self._attempt("w3", "wiley", interval=5.0),
                ),
                run,
            )

        output = "\n".join(captured.output)
        self.assertIs(result[2].disposition, BrowserScheduledDisposition.DEFERRED)
        self.assertIn("event=browser-provider-group-waiting", output)
        self.assertIn("wait_seconds=5", output)
        self.assertIn("next_allowed_in_seconds=5", output)
        self.assertIn("cooldown_reason=provider-policy", output)
        self.assertIn("event=browser-provider-group-feedback", output)
        self.assertIn("feedback=rate-limited", output)
        self.assertIn("event=browser-provider-group-paused", output)
        self.assertIn("cooldown_reason=rate-limit", output)
        self.assertIn("action=review-group-state-before-retry", output)
        self.assertIn("resource=global-permit outcome=released", output)
        self.assertIn("resource=group-permit outcome=released", output)
        self.assertIn("provider_group=wiley", output)

    def test_runtime_state_and_scheduler_refuse_serialization(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupScheduler

        scheduler = BrowserGroupScheduler(clock=_AdvancingClock(), max_concurrency=1)
        attempt = self._attempt("w1", "wiley")
        snapshot = scheduler.runtime_snapshot(attempt.policy)

        self.assertEqual(
            set(snapshot.__dataclass_fields__),
            {
                "rate_limit_group",
                "policy_revision",
                "observed_at",
                "blocked_until",
                "consecutive_runtime_failures",
                "circuit_reason",
            },
        )
        for value in (snapshot, scheduler):
            with self.assertRaisesRegex(TypeError, "cannot be serialized"):
                pickle.dumps(value)

    def test_policy_is_explicit_fixed_serial_and_operator_can_only_tighten(self) -> None:
        from sciretriever.network.browser_scheduler import BrowserGroupPolicy

        declared = BrowserGroupPolicy(
            rate_limit_group="wiley",
            policy_revision="2026-08-15",
            minimum_start_interval=10.0,
            rate_limit_cooldown=60.0,
            runtime_failure_threshold=4,
            maximum_starts_per_window=4,
            window_seconds=120.0,
            cooldown_after_completion=2.0,
            failure_cooldown=30.0,
        )
        operator = BrowserGroupPolicy(
            rate_limit_group="WILEY",
            policy_revision="2026-08-15",
            minimum_start_interval=20.0,
            rate_limit_cooldown=120.0,
            runtime_failure_threshold=2,
            maximum_starts_per_window=2,
            window_seconds=180.0,
            cooldown_after_completion=5.0,
            failure_cooldown=45.0,
        )

        tightened = declared.tightened_by(operator)

        self.assertEqual(tightened.rate_limit_group, "wiley")
        self.assertEqual(tightened.max_concurrency, 1)
        self.assertEqual(tightened.minimum_start_interval, 20.0)
        self.assertEqual(tightened.rate_limit_cooldown, 120.0)
        self.assertEqual(tightened.runtime_failure_threshold, 2)
        self.assertEqual(tightened.maximum_starts_per_window, 2)
        self.assertEqual(tightened.window_seconds, 180.0)
        self.assertEqual(tightened.cooldown_after_completion, 5.0)
        self.assertEqual(tightened.failure_cooldown, 45.0)

        with self.assertRaises(ValueError):
            BrowserGroupPolicy(
                rate_limit_group="wiley",
                policy_revision="2026-08-15",
                minimum_start_interval=10.0,
                rate_limit_cooldown=60.0,
                runtime_failure_threshold=4,
                max_concurrency=2,
            )
        with self.assertRaises(ValueError):
            BrowserGroupPolicy(
                rate_limit_group="wiley",
                policy_revision="2026-08-15",
                minimum_start_interval=10.0,
                rate_limit_cooldown=60.0,
                runtime_failure_threshold=4,
                maximum_starts_per_window=2,
            )
        with self.assertRaises(ValueError):
            BrowserGroupPolicy(
                rate_limit_group="wiley",
                policy_revision="2026-08-15",
                minimum_start_interval=10.0,
                rate_limit_cooldown=0.0,
                runtime_failure_threshold=4,
            )
        with self.assertRaises(ValueError):
            BrowserGroupPolicy(
                rate_limit_group="wiley",
                policy_revision="2026-08-15",
                minimum_start_interval=10.0,
                rate_limit_cooldown=60.0,
                runtime_failure_threshold=0,
            )
        with self.assertRaises(ValueError):
            declared.tightened_by(
                BrowserGroupPolicy(
                    rate_limit_group="wiley",
                    policy_revision="2026-08-15",
                    minimum_start_interval=5.0,
                    rate_limit_cooldown=30.0,
                    runtime_failure_threshold=8,
                    maximum_starts_per_window=8,
                    window_seconds=60.0,
                )
            )


if __name__ == "__main__":
    unittest.main()
