from __future__ import annotations

import json
import pickle
import unittest

from sciretriever.acquisition.browser_admission import (
    BrowserAdmissionCandidate,
    BrowserAdmissionConfiguration,
    BrowserAdmissionController,
    BrowserAdmissionDisposition,
    BrowserGroupAdmissionState,
    BrowserGroupReadiness,
)
from sciretriever.acquisition.planning import RouteReadiness
from sciretriever.model.report import StableFailure
from sciretriever.network.browser_scheduler import (
    BrowserCircuitReason,
    BrowserGroupPolicy,
    BrowserGroupRuntimeSnapshot,
)


def _candidate(
    work_key: str = "paper-1",
    *,
    group: str = "browser-generic",
    readiness: RouteReadiness = RouteReadiness.READY,
    failure: StableFailure | None = None,
) -> BrowserAdmissionCandidate:
    return BrowserAdmissionCandidate(
        work_key=work_key,
        route_key="browser:generic",
        rate_limit_group=group,
        readiness=readiness,
        failure=failure,
    )


def _group(
    group: str = "browser-generic",
    *,
    readiness: BrowserGroupReadiness = BrowserGroupReadiness.READY,
    interval: float = 12.0,
    earliest: float = 3.0,
) -> BrowserGroupAdmissionState:
    return BrowserGroupAdmissionState(
        policy=BrowserGroupPolicy(
            rate_limit_group=group,
            policy_revision="fixture-v1",
            minimum_start_interval=interval,
            rate_limit_cooldown=60.0,
            runtime_failure_threshold=3,
        ),
        session_key=group,
        readiness=readiness,
        earliest_start_in_seconds=earliest,
    )


def _controller(
    *groups: BrowserGroupAdmissionState,
    enabled: bool = True,
    confirmed: bool = True,
    runtime_ready: bool = True,
) -> BrowserAdmissionController:
    return BrowserAdmissionController(
        BrowserAdmissionConfiguration(
            explicitly_enabled=enabled,
            execution_confirmed=confirmed,
            runtime_ready=runtime_ready,
            groups=tuple(groups),
        )
    )


class BrowserAdmissionTests(unittest.TestCase):
    def test_default_configuration_rejects_without_opening_browser(self) -> None:
        result = BrowserAdmissionController().evaluate((_candidate(),))

        self.assertIs(
            result.decisions[0].disposition,
            BrowserAdmissionDisposition.REJECTED,
        )
        self.assertIsNone(result.decisions[0].failure)
        self.assertEqual(result.summary.groups[0].rejected_count, 1)
        self.assertEqual(result.summary.groups[0].eligible_count, 0)

    def test_confirmation_is_required_but_summary_still_estimates_work(self) -> None:
        result = _controller(_group(), confirmed=False).evaluate(
            (_candidate("paper-1"), _candidate("paper-2")),
        )

        self.assertTrue(
            all(
                decision.disposition is BrowserAdmissionDisposition.ACTION_REQUIRED
                for decision in result.decisions
            )
        )
        self.assertEqual(
            {decision.failure.code for decision in result.decisions if decision.failure},
            {"acquisition-browser-confirmation-required"},
        )
        summary = result.summary.groups[0]
        self.assertEqual(summary.eligible_count, 2)
        self.assertEqual(summary.allowed_count, 0)
        self.assertEqual(summary.conservative_minimum_duration_seconds, 15.0)
        self.assertIn("explicitly confirm", summary.required_actions[0])

    def test_runtime_and_route_readiness_fail_closed(self) -> None:
        cases = (
            (
                _controller(_group(), runtime_ready=False),
                _candidate(),
                BrowserAdmissionDisposition.ACTION_REQUIRED,
                "acquisition-browser-runtime-unavailable",
            ),
            (
                _controller(_group()),
                _candidate(readiness=RouteReadiness.UNCONFIGURED),
                BrowserAdmissionDisposition.ACTION_REQUIRED,
                "acquisition-browser-route-unconfigured",
            ),
            (
                _controller(_group()),
                _candidate(readiness=RouteReadiness.TEMPORARILY_UNAVAILABLE),
                BrowserAdmissionDisposition.DEFERRED,
                "acquisition-browser-route-temporarily-unavailable",
            ),
        )
        for controller, candidate, disposition, code in cases:
            with self.subTest(code=code):
                decision = controller.evaluate((candidate,)).decisions[0]
                self.assertIs(decision.disposition, disposition)
                failure = decision.failure
                self.assertIsNotNone(failure)
                if failure is None:
                    self.fail("failure outcome did not carry a stable failure")
                self.assertEqual(failure.code, code)

    def test_route_failure_is_preserved_by_browser_admission(self) -> None:
        runtime_failure = StableFailure(
            code="browser-cloak-binary-unavailable",
            reason="The pinned CloakBrowser binary is not present in the local runtime cache.",
            action="Install the pinned CloakBrowser binary from the configuration center.",
            retryable=False,
        )

        decision = (
            _controller(_group())
            .evaluate(
                (
                    _candidate(
                        readiness=RouteReadiness.UNCONFIGURED,
                        failure=runtime_failure,
                    ),
                )
            )
            .decisions[0]
        )

        self.assertIs(
            decision.disposition,
            BrowserAdmissionDisposition.ACTION_REQUIRED,
        )
        self.assertEqual(decision.failure, runtime_failure)

    def test_disabled_and_unsupported_routes_are_rejected(self) -> None:
        controller = _controller(_group())
        for candidate in (
            _candidate(readiness=RouteReadiness.DISABLED),
            _candidate(readiness=RouteReadiness.UNSUPPORTED),
        ):
            with self.subTest(candidate=candidate):
                decision = controller.evaluate((candidate,)).decisions[0]
                self.assertIs(decision.disposition, BrowserAdmissionDisposition.REJECTED)
                self.assertIsNone(decision.failure)

    def test_group_state_maps_to_stable_admission_outcomes(self) -> None:
        deferred = {
            BrowserGroupReadiness.RATE_LIMITED,
        }
        action_required = set(BrowserGroupReadiness) - {
            BrowserGroupReadiness.READY,
            *deferred,
        }
        for readiness in BrowserGroupReadiness:
            with self.subTest(readiness=readiness):
                decision = (
                    _controller(_group(readiness=readiness)).evaluate((_candidate(),)).decisions[0]
                )
                if readiness is BrowserGroupReadiness.READY:
                    self.assertIs(
                        decision.disposition,
                        BrowserAdmissionDisposition.ALLOWED,
                    )
                    self.assertIsNone(decision.failure)
                elif readiness in deferred:
                    self.assertIs(
                        decision.disposition,
                        BrowserAdmissionDisposition.DEFERRED,
                    )
                else:
                    self.assertIn(readiness, action_required)
                    self.assertIs(
                        decision.disposition,
                        BrowserAdmissionDisposition.ACTION_REQUIRED,
                    )
                    failure = decision.failure
                    self.assertIsNotNone(failure)
                    if failure is None:
                        self.fail("action-required outcome did not carry a failure")
                    self.assertEqual(
                        failure.code,
                        f"acquisition-browser-{readiness.value}",
                    )

    def test_dynamic_cooldown_and_circuit_override_ready_group_in_summary(self) -> None:
        controller = _controller(_group(earliest=3.0))
        blocked = BrowserGroupRuntimeSnapshot(
            rate_limit_group="browser-generic",
            policy_revision="fixture-v1",
            observed_at=10.0,
            blocked_until=25.0,
            consecutive_runtime_failures=0,
        )

        deferred = controller.evaluate((_candidate(),), runtime_states=(blocked,))

        self.assertIs(
            deferred.decisions[0].disposition,
            BrowserAdmissionDisposition.DEFERRED,
        )
        self.assertEqual(deferred.summary.groups[0].readiness, "rate-limited")
        self.assertEqual(deferred.summary.groups[0].earliest_start_in_seconds, 15.0)
        self.assertEqual(deferred.summary.groups[0].deferred_count, 1)

        circuit = BrowserGroupRuntimeSnapshot(
            rate_limit_group="browser-generic",
            policy_revision="fixture-v1",
            observed_at=10.0,
            blocked_until=25.0,
            consecutive_runtime_failures=0,
            circuit_reason=BrowserCircuitReason.IP_BLOCKED,
        )
        action_required = controller.evaluate(
            (_candidate(),),
            runtime_states=(circuit,),
        )

        decision = action_required.decisions[0]
        self.assertIs(
            decision.disposition,
            BrowserAdmissionDisposition.ACTION_REQUIRED,
        )
        self.assertEqual(action_required.summary.groups[0].readiness, "ip-blocked")
        self.assertEqual(action_required.summary.groups[0].action_required_count, 1)
        self.assertIsNotNone(decision.failure)
        if decision.failure is None:
            self.fail("circuit outcome did not carry a stable failure")
        self.assertEqual(decision.failure.code, "acquisition-browser-ip-blocked")

    def test_missing_group_requires_configuration(self) -> None:
        decision = _controller().evaluate((_candidate(),)).decisions[0]

        self.assertIs(
            decision.disposition,
            BrowserAdmissionDisposition.ACTION_REQUIRED,
        )
        failure = decision.failure
        self.assertIsNotNone(failure)
        if failure is None:
            self.fail("action-required outcome did not carry a failure")
        self.assertEqual(
            failure.code,
            "acquisition-browser-group-unavailable",
        )

    def test_generic_group_summary_is_deterministic_and_redacted(self) -> None:
        result = _controller(
            _group(interval=10.0, earliest=5.0),
        ).evaluate(
            (
                _candidate("paper-cookie-token-profile"),
                _candidate("paper-2"),
                _candidate("paper-3"),
            )
        )

        self.assertEqual(
            tuple(group.rate_limit_group for group in result.summary.groups),
            ("browser-generic",),
        )
        self.assertEqual(
            result.summary.groups[0].conservative_minimum_duration_seconds,
            25.0,
        )
        rendered_json = json.dumps(result.summary.to_json_value(), sort_keys=True)
        rendered_text = result.summary.render_text()
        self.assertEqual(
            result.summary.to_json_value(),
            result.summary.to_json_value(),
        )
        for private_value in (
            "paper-cookie-token-profile",
            "browser:generic",
            "https://publisher.invalid/signed.pdf",
            "session-cookie-value",
            "css-selector",
        ):
            self.assertNotIn(private_value, rendered_json)
            self.assertNotIn(private_value, rendered_text)

    def test_summary_and_result_cannot_be_pickled(self) -> None:
        result = _controller(_group()).evaluate((_candidate(),))

        with self.assertRaisesRegex(TypeError, "cannot be serialized"):
            pickle.dumps(result.summary)
        with self.assertRaisesRegex(TypeError, "cannot be serialized"):
            pickle.dumps(result)


if __name__ == "__main__":
    unittest.main()
