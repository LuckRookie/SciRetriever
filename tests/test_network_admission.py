from __future__ import annotations

import inspect
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from sciretriever.network.admission import (
    AccessCancelled,
    AccessCoordinator,
    AccessFeedback,
    AccessPermit,
    AccessPolicy,
    AccessScope,
    AdmissionError,
    AdmissionTimeout,
    HostPermit,
    PeriodicQuota,
    PolicyRequired,
)


class _FakeClock:
    def __init__(self) -> None:
        self.value = 0.0
        self._lock = threading.Lock()

    def __call__(self) -> float:
        with self._lock:
            return self.value

    def advance(self, seconds: float) -> None:
        with self._lock:
            self.value += seconds


def _wait_for(event: threading.Event) -> None:
    if not event.wait(1.0):
        raise AssertionError("worker did not reach the expected admission state")


class _FeedbackFailureCoordinator(AccessCoordinator):
    def record_feedback(self, source: AccessPermit | AccessScope, feedback: AccessFeedback) -> None:
        raise RuntimeError("feedback application failed")


class _ReleaseBarrierCoordinator(AccessCoordinator):
    def __init__(self) -> None:
        super().__init__()
        self.release_entered = threading.Event()
        self.release_continue = threading.Event()

    def _release_scope(self, permit: AccessPermit) -> None:
        self.release_entered.set()
        if not self.release_continue.wait(1.0):
            raise AssertionError("scope release did not reach its barrier")
        super()._release_scope(permit)


class _FeedbackBoundaryCoordinator(AccessCoordinator):
    def __init__(self) -> None:
        super().__init__()
        self.feedback_applied = threading.Event()
        self.finish_feedback = threading.Event()

    def record_feedback(self, source: AccessPermit | AccessScope, feedback: AccessFeedback) -> None:
        super().record_feedback(source, feedback)
        self.feedback_applied.set()
        if not self.finish_feedback.wait(5.0):
            raise AssertionError("feedback boundary did not resume")


class NetworkAdmissionTests(unittest.TestCase):
    def test_web_scope_rejects_service_name_that_could_split_cooldown(self) -> None:
        for service_name in ("content", "metadata"):
            with self.subTest(service_name=service_name):
                with self.assertRaisesRegex(ValueError, "web scopes must not specify service_name"):
                    AccessScope("fixture-provider", "web", service_name)

    def test_api_service_name_keeps_independent_scope_identity(self) -> None:
        metadata = AccessScope("fixture-provider", "api", "metadata")
        references = AccessScope("fixture-provider", "api", "references")
        self.assertNotEqual(metadata, references)

        coordinator = AccessCoordinator()
        policy = AccessPolicy(max_concurrency=1)
        metadata_permit = coordinator.acquire_scope(metadata, policy)
        references_permit = coordinator.acquire_scope(references, policy)
        references_permit.release()
        metadata_permit.release()

    def test_scope_and_policy_are_neutral_and_strictly_merged(self) -> None:
        clock = _FakeClock()
        safety = AccessPolicy(
            max_concurrency=2,
            min_start_interval=1.0,
            cooldown_after_completion=3.0,
            burst_limit=8,
            window_seconds=60.0,
        )
        official = AccessPolicy(
            max_concurrency=4,
            min_start_interval=0.5,
            cooldown_after_completion=2.0,
            burst_limit=10,
            window_seconds=30.0,
        )
        operator = AccessPolicy(
            max_concurrency=20,
            min_start_interval=0.0,
            cooldown_after_completion=0.0,
            burst_limit=100,
            window_seconds=1.0,
        )
        coordinator = AccessCoordinator(clock=clock, minimum_policy=safety)
        scope = AccessScope("fixture-provider", "api", "metadata")

        effective = coordinator.register(scope, official, operator_policy=operator)

        self.assertEqual(effective.max_concurrency, 2)
        self.assertEqual(effective.min_start_interval, 1.0)
        self.assertEqual(effective.cooldown_after_completion, 3.0)
        self.assertEqual(effective.burst_limit, 8)
        self.assertEqual(effective.window_seconds, 60.0)
        self.assertNotIn("secret", repr(scope).lower())

    def test_periodic_quota_contract_and_strict_merge_are_fail_closed(self) -> None:
        minute = PeriodicQuota(limit=10, period_seconds=60.0)
        day = PeriodicQuota(limit=1_000, period_seconds=86_400.0)
        stricter_minute = PeriodicQuota(limit=5, period_seconds=60.0)

        effective = AccessPolicy.strictest(
            AccessPolicy(max_concurrency=4, periodic_quotas=(minute, day)),
            AccessPolicy(max_concurrency=8, periodic_quotas=(stricter_minute,)),
        )

        self.assertEqual(effective.max_concurrency, 4)
        self.assertEqual(
            effective.periodic_quotas,
            (stricter_minute, day),
        )
        with self.assertRaisesRegex(ValueError, "unique reset boundaries"):
            AccessPolicy(
                max_concurrency=1,
                periodic_quotas=(minute, stricter_minute),
            )
        with self.assertRaisesRegex(ValueError, "less than period_seconds"):
            PeriodicQuota(
                limit=1,
                period_seconds=60.0,
                reset_offset_seconds=60.0,
            )

    def test_missing_policy_is_rejected_and_api_does_not_get_web_cooldown(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        api_scope = AccessScope("fixture-provider", "api")
        policy = AccessPolicy(max_concurrency=1)

        with self.assertRaises(PolicyRequired):
            coordinator.acquire_scope(api_scope)

        api = coordinator.acquire_scope(api_scope, policy)
        api_host = api.acquire_host("api.example.test")
        api_host.release()
        api.release()

        web_scope = AccessScope("shared-host-provider", "web")
        web = coordinator.acquire_scope(web_scope, policy)
        web_host = web.acquire_host("shared.example.test")
        web_host.release()
        web.release()
        self.assertEqual(coordinator.policy_for(web_scope), policy)

        api_again = coordinator.acquire_scope(api_scope)
        api_again_host = api_again.acquire_host("shared.example.test", timeout=0.1)
        api_again_host.release()
        api_again.release()

    def test_scope_permits_are_shared_but_unrelated_provider_can_progress(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        policy = AccessPolicy(max_concurrency=1)
        scope = AccessScope("provider-a", "api")
        other_scope = AccessScope("provider-b", "api")
        first = coordinator.acquire_scope(scope, policy)

        acquired = threading.Event()
        release_worker = threading.Event()
        errors: list[BaseException] = []

        def wait_for_same_scope() -> None:
            try:
                permit = coordinator.acquire_scope(scope)
                acquired.set()
                release_worker.wait(1.0)
                permit.release()
            except BaseException as error:
                errors.append(error)

        worker = threading.Thread(target=wait_for_same_scope)
        worker.start()
        self.assertFalse(acquired.wait(0.05))

        unrelated = coordinator.acquire_scope(other_scope, policy)
        unrelated.release()
        first.release()

        _wait_for(acquired)
        release_worker.set()
        worker.join(1.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])

    def test_different_providers_on_one_host_share_only_host_budget(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        policy = AccessPolicy(max_concurrency=1)
        first_scope = AccessScope("provider-a", "api")
        second_scope = AccessScope("provider-b", "api")
        independent_scope = AccessScope("provider-c", "api")
        first = coordinator.acquire_scope(first_scope, policy)
        first_host = first.acquire_host("shared.example.test")

        scope_ready = threading.Event()
        host_acquired = threading.Event()
        release_worker = threading.Event()
        errors: list[BaseException] = []

        def wait_for_shared_host() -> None:
            try:
                second = coordinator.acquire_scope(second_scope, policy)
                scope_ready.set()
                host = second.acquire_host("SHARED.EXAMPLE.TEST.")
                host_acquired.set()
                release_worker.wait(1.0)
                host.release()
                second.release()
            except BaseException as error:
                errors.append(error)

        worker = threading.Thread(target=wait_for_shared_host)
        worker.start()
        _wait_for(scope_ready)
        self.assertFalse(host_acquired.wait(0.05))

        independent = coordinator.acquire_scope(independent_scope, policy)
        independent_host = independent.acquire_host("other.example.test")
        independent_host.release()
        independent.release()
        first_host.release()

        _wait_for(host_acquired)
        release_worker.set()
        worker.join(1.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])

    def test_host_shares_start_interval_and_quota_across_providers(self) -> None:
        cases = (
            (AccessPolicy(max_concurrency=1, min_start_interval=5.0), 5.0),
            (AccessPolicy(max_concurrency=1, burst_limit=1, window_seconds=10.0), 10.0),
        )
        for policy, wait_seconds in cases:
            with self.subTest(wait_seconds=wait_seconds):
                clock = _FakeClock()
                coordinator = AccessCoordinator(clock=clock)
                first_scope = AccessScope("provider-a", "api")
                second_scope = AccessScope("provider-b", "api")
                first = coordinator.acquire_scope(first_scope, policy)
                first_host = first.acquire_host("shared.example.test")
                first_host.release()
                first.release()

                second = coordinator.acquire_scope(second_scope, policy)
                acquired = threading.Event()
                release_worker = threading.Event()
                errors: list[BaseException] = []

                def wait_for_shared_host() -> None:
                    try:
                        host = second.acquire_host("shared.example.test")
                        acquired.set()
                        release_worker.wait(1.0)
                        host.release()
                    except BaseException as error:
                        errors.append(error)

                worker = threading.Thread(target=wait_for_shared_host)
                worker.start()
                self.assertFalse(acquired.wait(0.05))
                clock.advance(wait_seconds - 0.1)
                coordinator.wake()
                self.assertFalse(acquired.wait(0.05))
                clock.advance(0.1)
                coordinator.wake()
                _wait_for(acquired)
                release_worker.set()
                worker.join(1.0)
                second.release()
                self.assertFalse(worker.is_alive())
                self.assertEqual(errors, [])

    def test_explicit_host_policy_does_not_consume_the_article_scope_interval(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        scope = AccessScope("browser-publisher", "web")
        article_policy = AccessPolicy(max_concurrency=1, min_start_interval=30.0)
        request_policy = AccessPolicy(max_concurrency=8)

        article = coordinator.acquire_scope(scope, article_policy)
        first = article.acquire_host(
            "publisher.example.test",
            host_policy=request_policy,
        )
        first.release()
        second = article.acquire_host(
            "publisher.example.test",
            host_policy=request_policy,
            timeout=0.05,
        )
        second.release()
        article.release()

        with self.assertRaises(AdmissionTimeout):
            coordinator.acquire_scope(scope, timeout=0.01)

    def test_web_scope_covers_multiple_redirect_hosts_and_cools_after_full_flow(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        policy = AccessPolicy(max_concurrency=1, cooldown_after_completion=30.0)
        web_scope = AccessScope("fixture-provider", "web")

        flow = coordinator.acquire_scope(web_scope, policy)
        first_host = flow.acquire_host("first.example.test")
        first_host.release()
        second_host = flow.acquire_host("second.example.test")
        second_host.release()

        acquired = threading.Event()
        errors: list[BaseException] = []

        def wait_for_next_flow() -> None:
            try:
                next_flow = coordinator.acquire_scope(web_scope)
                acquired.set()
                next_flow.release()
            except BaseException as error:
                errors.append(error)

        worker = threading.Thread(target=wait_for_next_flow)
        worker.start()
        self.assertFalse(acquired.wait(0.05))
        flow.release()
        self.assertFalse(acquired.wait(0.05))
        clock.advance(29.9)
        coordinator.wake()
        self.assertFalse(acquired.wait(0.05))
        clock.advance(0.1)
        coordinator.wake()
        _wait_for(acquired)
        worker.join(1.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])

    def test_web_cooldown_does_not_block_independent_api_scope_on_same_host(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        policy = AccessPolicy(max_concurrency=1)
        web_scope = AccessScope("shared-provider", "web")
        api_scope = AccessScope("shared-provider", "api")

        web = coordinator.acquire_scope(web_scope, policy)
        web_host = web.acquire_host("shared.example.test")
        web_host.release()
        web.release()

        api = coordinator.acquire_scope(api_scope, policy)
        api_host = api.acquire_host("shared.example.test", timeout=0.1)
        api_host.release()
        api.release()

    def test_feedback_is_scope_only_and_has_no_host_argument(self) -> None:
        parameters = inspect.signature(AccessCoordinator.record_feedback).parameters
        self.assertNotIn("host", parameters)

        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        web_scope = AccessScope("shared-host-provider", "web")
        api_scope = AccessScope("shared-host-provider", "api")
        policy = AccessPolicy(max_concurrency=1)
        web = coordinator.acquire_scope(web_scope, policy)
        coordinator.record_feedback(web, AccessFeedback(retry_after=60.0))
        web.release()

        api = coordinator.acquire_scope(api_scope, policy)
        api_host = api.acquire_host("shared.example.test", timeout=0.1)
        api_host.release()
        api.release()

    def test_quota_window_and_retry_after_feedback_are_shared_by_scope(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        scope = AccessScope("fixture-provider", "api")
        policy = AccessPolicy(max_concurrency=1, burst_limit=2, window_seconds=10.0)

        for _ in range(2):
            permit = coordinator.acquire_scope(scope, policy)
            permit.release()

        acquired = threading.Event()
        release_worker = threading.Event()

        def wait_for_quota_reset() -> None:
            permit = coordinator.acquire_scope(scope)
            acquired.set()
            release_worker.wait(1.0)
            permit.release()

        worker = threading.Thread(target=wait_for_quota_reset)
        worker.start()
        self.assertFalse(acquired.wait(0.05))
        clock.advance(10.0)
        coordinator.wake()
        _wait_for(acquired)
        release_worker.set()
        worker.join(1.0)
        self.assertFalse(worker.is_alive())

        feedback_coordinator = AccessCoordinator(clock=clock)
        feedback_scope = AccessScope("feedback-provider", "api")
        permit = feedback_coordinator.acquire_scope(
            feedback_scope,
            AccessPolicy(max_concurrency=1),
        )
        feedback_coordinator.record_feedback(permit, AccessFeedback(retry_after=5.0))
        permit.release()
        feedback_acquired = threading.Event()
        feedback_release = threading.Event()

        def wait_for_feedback() -> None:
            next_permit = feedback_coordinator.acquire_scope(feedback_scope)
            feedback_acquired.set()
            feedback_release.wait(1.0)
            next_permit.release()

        feedback_worker = threading.Thread(target=wait_for_feedback)
        feedback_worker.start()
        self.assertFalse(feedback_acquired.wait(0.05))
        clock.advance(4.9)
        feedback_coordinator.wake()
        self.assertFalse(feedback_acquired.wait(0.05))
        clock.advance(0.1)
        feedback_coordinator.wake()
        _wait_for(feedback_acquired)
        feedback_release.set()
        feedback_worker.join(1.0)
        self.assertFalse(feedback_worker.is_alive())

    def test_fixed_boundary_quotas_are_atomically_shared_and_reset_together(self) -> None:
        clock = _FakeClock()
        clock.advance(2.0)
        coordinator = AccessCoordinator(clock=clock, quota_clock=clock)
        scope = AccessScope("fixture-provider", "api")
        policy = AccessPolicy(
            max_concurrency=8,
            periodic_quotas=(
                PeriodicQuota(limit=2, period_seconds=10.0, reset_offset_seconds=2.0),
                PeriodicQuota(limit=3, period_seconds=100.0, reset_offset_seconds=2.0),
            ),
        )

        for _ in range(2):
            permit = coordinator.acquire_scope(scope, policy)
            permit.release()

        minute_reset = threading.Event()
        minute_release = threading.Event()
        errors: list[BaseException] = []

        def wait_for_minute_reset() -> None:
            try:
                permit = coordinator.acquire_scope(scope)
                minute_reset.set()
                minute_release.wait(1.0)
                permit.release()
            except BaseException as error:
                errors.append(error)

        minute_worker = threading.Thread(target=wait_for_minute_reset)
        minute_worker.start()
        self.assertFalse(minute_reset.wait(0.05))
        clock.advance(9.9)
        coordinator.wake()
        self.assertFalse(minute_reset.wait(0.05))
        clock.advance(0.1)
        coordinator.wake()
        _wait_for(minute_reset)
        minute_release.set()
        minute_worker.join(1.0)

        daily_reset = threading.Event()
        daily_release = threading.Event()

        def wait_for_daily_reset() -> None:
            try:
                permit = coordinator.acquire_scope(scope)
                daily_reset.set()
                daily_release.wait(1.0)
                permit.release()
            except BaseException as error:
                errors.append(error)

        daily_worker = threading.Thread(target=wait_for_daily_reset)
        daily_worker.start()
        self.assertFalse(daily_reset.wait(0.05))
        clock.advance(10.0)
        coordinator.wake()
        self.assertFalse(daily_reset.wait(0.05))
        clock.advance(79.9)
        coordinator.wake()
        self.assertFalse(daily_reset.wait(0.05))
        clock.advance(0.1)
        coordinator.wake()
        _wait_for(daily_reset)
        daily_release.set()
        daily_worker.join(1.0)

        self.assertFalse(minute_worker.is_alive())
        self.assertFalse(daily_worker.is_alive())
        self.assertEqual(errors, [])

    def test_periodic_quota_never_overadmits_concurrent_callers(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock, quota_clock=clock)
        scope = AccessScope("fixture-provider", "api")
        policy = AccessPolicy(
            max_concurrency=10,
            periodic_quotas=(PeriodicQuota(limit=3, period_seconds=60.0),),
        )
        cancel_event = threading.Event()
        acquired = threading.Barrier(4)
        release = threading.Event()
        successes: list[AccessPermit] = []
        cancelled: list[AccessCancelled] = []
        errors: list[BaseException] = []
        lock = threading.Lock()

        def contend() -> None:
            try:
                permit = coordinator.acquire_scope(
                    scope,
                    policy,
                    cancel_event=cancel_event,
                )
                with lock:
                    successes.append(permit)
                acquired.wait(1.0)
                release.wait(1.0)
                permit.release()
            except AccessCancelled as error:
                with lock:
                    cancelled.append(error)
            except BaseException as error:
                with lock:
                    errors.append(error)

        workers = [threading.Thread(target=contend) for _ in range(8)]
        for worker in workers:
            worker.start()
        acquired.wait(1.0)
        self.assertEqual(len(successes), 3)
        cancel_event.set()
        coordinator.wake()
        release.set()
        for worker in workers:
            worker.join(1.0)

        self.assertTrue(all(not worker.is_alive() for worker in workers))
        self.assertEqual(len(successes), 3)
        self.assertEqual(len(cancelled), 5)
        self.assertEqual(errors, [])

    def test_quota_feedback_can_only_reduce_remaining_or_extend_reset(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock, quota_clock=clock)
        scope = AccessScope("fixture-provider", "api")
        policy = AccessPolicy(max_concurrency=1)

        first = coordinator.acquire_scope(scope, policy)
        first.release(
            AccessFeedback(
                quota_remaining=2,
                quota_limit=10,
                quota_reset_at=20.0,
            )
        )
        second = coordinator.acquire_scope(scope)
        second.release(
            AccessFeedback(
                quota_remaining=5,
                quota_limit=20,
                quota_reset_at=15.0,
            )
        )
        third = coordinator.acquire_scope(scope)
        third.release()

        acquired = threading.Event()

        def wait_for_tightened_reset() -> None:
            permit = coordinator.acquire_scope(scope)
            acquired.set()
            permit.release()

        worker = threading.Thread(target=wait_for_tightened_reset)
        worker.start()
        self.assertFalse(acquired.wait(0.05))
        clock.advance(19.9)
        coordinator.wake()
        self.assertFalse(acquired.wait(0.05))
        clock.advance(0.1)
        coordinator.wake()
        _wait_for(acquired)
        worker.join(1.0)

        self.assertFalse(worker.is_alive())
        with self.assertRaisesRegex(ValueError, "requires quota_reset_at"):
            AccessFeedback(quota_remaining=1)
        with self.assertRaisesRegex(ValueError, "must not exceed quota_limit"):
            AccessFeedback(
                quota_remaining=2,
                quota_limit=1,
                quota_reset_at=30.0,
            )

    def test_scope_release_with_feedback_failure_releases_scope_and_host(self) -> None:
        coordinator = _FeedbackFailureCoordinator()
        scope = AccessScope("fixture-provider", "api")
        permit = coordinator.acquire_scope(scope, AccessPolicy(max_concurrency=1))
        host = permit.acquire_host("api.example.test")

        with self.assertRaisesRegex(RuntimeError, "feedback application failed"):
            permit.release(AccessFeedback(retry_after=5.0))

        self.assertTrue(permit.released)
        self.assertTrue(host.released)
        replacement = coordinator.acquire_scope(scope)
        replacement_host = replacement.acquire_host("api.example.test")
        replacement_host.release()
        replacement.release()

    def test_scope_release_keeps_one_condition_boundary_after_feedback(self) -> None:
        coordinator = _FeedbackBoundaryCoordinator()
        scope = AccessScope("fixture-provider", "api")
        permit = coordinator.acquire_scope(scope, AccessPolicy(max_concurrency=1))
        release_errors: list[BaseException] = []

        def release_with_feedback() -> None:
            try:
                permit.release(AccessFeedback(retry_after=5.0))
            except BaseException as error:
                release_errors.append(error)

        releaser = threading.Thread(target=release_with_feedback)
        releaser.start()
        _wait_for(coordinator.feedback_applied)
        condition_attempt_finished = threading.Event()
        condition_acquisitions: list[bool] = []

        def contend_for_release_boundary() -> None:
            acquired = coordinator._condition.acquire(timeout=0.05)
            condition_acquisitions.append(acquired)
            if acquired:
                coordinator._condition.release()
            condition_attempt_finished.set()

        contender = threading.Thread(target=contend_for_release_boundary)
        contender.start()
        try:
            _wait_for(condition_attempt_finished)
            self.assertEqual(condition_acquisitions, [False])
        finally:
            coordinator.finish_feedback.set()
            releaser.join(1.0)
            contender.join(1.0)

        self.assertFalse(releaser.is_alive())
        self.assertFalse(contender.is_alive())
        self.assertEqual(release_errors, [])
        self.assertTrue(permit.released)
        self.assertEqual(coordinator._active_scope_permits, {})

    def test_cancellation_and_timeout_do_not_leak_scope_or_host_waiters(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        scope = AccessScope("fixture-provider", "api")
        policy = AccessPolicy(max_concurrency=1)
        first = coordinator.acquire_scope(scope, policy)
        cancelled = threading.Event()
        errors: list[BaseException] = []

        def cancelled_waiter() -> None:
            try:
                coordinator.acquire_scope(scope, cancel_event=cancelled)
            except BaseException as error:
                errors.append(error)

        worker = threading.Thread(target=cancelled_waiter)
        worker.start()
        cancelled.set()
        coordinator.wake()
        worker.join(1.0)
        self.assertFalse(worker.is_alive())
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], AccessCancelled)
        first.release()

        owner = coordinator.acquire_scope(scope, policy)
        first_host = owner.acquire_host("shared.example.test")
        host_cancelled = threading.Event()
        host_errors: list[BaseException] = []
        other_scope = coordinator.acquire_scope(AccessScope("other-provider", "api"), policy)

        def cancelled_host_waiter() -> None:
            try:
                other_scope.acquire_host("shared.example.test", cancel_event=host_cancelled)
            except BaseException as error:
                host_errors.append(error)

        host_worker = threading.Thread(target=cancelled_host_waiter)
        host_worker.start()
        host_cancelled.set()
        coordinator.wake()
        host_worker.join(1.0)
        self.assertFalse(host_worker.is_alive())
        self.assertEqual(len(host_errors), 1)
        self.assertIsInstance(host_errors[0], AccessCancelled)

        with self.assertRaises(AdmissionTimeout):
            other_scope.acquire_host("shared.example.test", timeout=0.01)
        first_host.release()
        other_scope.release()
        owner.release()

    def test_releasing_scope_cancels_pending_host_waiter_without_late_host_permit(self) -> None:
        coordinator = AccessCoordinator()
        policy = AccessPolicy(max_concurrency=1)
        blocker_scope = coordinator.acquire_scope(AccessScope("blocker", "api"), policy)
        blocker_host = blocker_scope.acquire_host("shared.example.test")
        owner_scope = coordinator.acquire_scope(AccessScope("owner", "api"), policy)
        started = threading.Event()
        errors: list[BaseException] = []
        permits: list[HostPermit] = []

        def wait_for_host() -> None:
            started.set()
            try:
                permits.append(owner_scope.acquire_host("shared.example.test"))
            except BaseException as error:
                errors.append(error)

        worker = threading.Thread(target=wait_for_host)
        worker.start()
        _wait_for(started)
        self.assertTrue(worker.is_alive())
        owner_scope.release()
        worker.join(1.0)

        self.assertFalse(worker.is_alive())
        self.assertEqual(permits, [])
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], AdmissionError)
        blocker_host.release()
        blocker_scope.release()

        replacement_scope = coordinator.acquire_scope(AccessScope("replacement", "api"), policy)
        replacement_host = replacement_scope.acquire_host("shared.example.test")
        replacement_host.release()
        replacement_scope.release()

    def test_scope_release_marks_owner_dead_before_waking_pending_host_waiter(self) -> None:
        coordinator = _ReleaseBarrierCoordinator()
        policy = AccessPolicy(max_concurrency=1)
        blocker_scope = coordinator.acquire_scope(AccessScope("blocker", "api"), policy)
        blocker_host = blocker_scope.acquire_host("shared.example.test")
        owner_scope = coordinator.acquire_scope(AccessScope("owner", "api"), policy)
        waiter_started = threading.Event()
        permits: list[HostPermit] = []
        errors: list[BaseException] = []

        def wait_for_host() -> None:
            waiter_started.set()
            try:
                permits.append(owner_scope.acquire_host("shared.example.test"))
            except BaseException as error:
                errors.append(error)

        waiter = threading.Thread(target=wait_for_host)
        waiter.start()
        _wait_for(waiter_started)
        self.assertTrue(waiter.is_alive())

        releaser = threading.Thread(target=owner_scope.release)
        releaser.start()
        _wait_for(coordinator.release_entered)
        self.assertTrue(owner_scope.released)

        # Scope teardown now keeps the Condition for the complete feedback and
        # release boundary, so the waiter cannot race through this barrier.
        self.assertTrue(waiter.is_alive())
        coordinator.release_continue.set()
        releaser.join(1.0)
        waiter.join(1.0)

        self.assertFalse(waiter.is_alive())
        self.assertFalse(releaser.is_alive())
        self.assertEqual(permits, [])
        self.assertEqual(len(errors), 1)
        self.assertIsInstance(errors[0], AdmissionError)
        blocker_host.release()
        blocker_scope.release()

    def test_acquire_host_requires_live_scope_and_timeout_does_not_leak(self) -> None:
        clock = _FakeClock()
        coordinator = AccessCoordinator(clock=clock)
        scope = AccessScope("fixture-provider", "api")
        permit = coordinator.acquire_scope(scope, AccessPolicy(max_concurrency=1))
        host = permit.acquire_host("api.example.test")
        other_scope = coordinator.acquire_scope(
            AccessScope("other-provider", "api"), AccessPolicy(max_concurrency=1)
        )
        with self.assertRaises(AdmissionTimeout):
            other_scope.acquire_host("api.example.test", timeout=0.01)
        host.release()
        permit.release()
        other_scope.release()
        with self.assertRaises(AdmissionError):
            permit.acquire_host("api.example.test")

    def test_dynamic_state_is_process_local_and_has_no_filesystem_side_effect(self) -> None:
        clock = _FakeClock()
        scope = AccessScope("fixture-provider", "web")
        policy = AccessPolicy(max_concurrency=1)

        with TemporaryDirectory() as directory:
            root = Path(directory)
            first_coordinator = AccessCoordinator(clock=clock)
            first = first_coordinator.acquire_scope(scope, policy)
            first_host = first.acquire_host("web.example.test")
            first_host.release()
            first.release()
            self.assertEqual(tuple(root.iterdir()), ())

            second_coordinator = AccessCoordinator(clock=clock)
            second = second_coordinator.acquire_scope(scope, policy)
            second_host = second.acquire_host("web.example.test")
            second_host.release()
            second.release()
            self.assertEqual(tuple(root.iterdir()), ())
            self.assertNotIn("web.example.test", repr(second))
            self.assertNotIn("web.example.test", repr(second_host))
            self.assertNotIn("secret", repr(second).lower())


if __name__ == "__main__":
    unittest.main()
