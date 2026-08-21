from __future__ import annotations

import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from pydantic import ValidationError

import sciretriever.configuration as configuration_boundary
from sciretriever.configuration import (
    browser_access_status,
    initialize_browser_profile,
    run_browser_configuration_probe,
)
from sciretriever.model.configuration import (
    BrowserAccessStatus,
    BrowserConfigurationProbeResult,
    BrowserPolicyStatus,
    BrowserProbeAvailabilityStatus,
    BrowserProfilePresence,
    BrowserProfileSelectionStatus,
    BrowserRouteStatus,
    BrowserRuntimeStatus,
    Configuration,
    ProbeOutcome,
)
from sciretriever.network.browser_scheduler import (
    BrowserArticleAttempt,
    BrowserAttemptCompletion,
    BrowserAttemptDisposition,
    BrowserGroupFeedback,
    BrowserGroupPolicy,
    BrowserGroupScheduler,
    BrowserSchedulerCancellation,
)

_ACCESS_KEY = "fixture-publisher"
_GROUP = "fixture-publisher"


class _FixtureClock:
    def __init__(self) -> None:
        self.current = 0.0

    def now(self) -> float:
        return self.current

    def wait_until(
        self,
        deadline: float,
        cancel_event: BrowserSchedulerCancellation | None,
    ) -> None:
        del cancel_event
        self.current = max(self.current, deadline)


def _approved_status() -> BrowserAccessStatus:
    policy = BrowserPolicyStatus(
        evidence="official",
        policy_revision="fixture-browser-policy-v1",
        verification_date=date(2026, 8, 15),
        notes_reference="docs/notes/providers/fixture.md",
        minimum_start_interval=10.0,
        rate_limit_cooldown=60.0,
        cooldown_after_completion=1.0,
        failure_cooldown=5.0,
        runtime_failure_threshold=2,
    )
    route = BrowserRouteStatus(
        access_key=_ACCESS_KEY,
        display_name="Fixture Publisher",
        route_key="browser:fixture-publisher",
        rate_limit_group=_GROUP,
        policy=policy,
    )
    return BrowserAccessStatus(
        enabled=True,
        local_max_concurrency=2,
        runtime=BrowserRuntimeStatus(
            framework_available=True,
            python_dependency_available=True,
            chromium_executable_available=True,
            headed_display_available=True,
        ),
        profile=BrowserProfileSelectionStatus(
            selected="fixture-profile",
            presence=BrowserProfilePresence.CONFIGURED,
        ),
        automatic_acquisition_available=True,
        production_route_count=1,
        automatic_route_count=1,
        routes=(route,),
        probe=BrowserProbeAvailabilityStatus(
            available=True,
            supported_access_keys=(_ACCESS_KEY,),
        ),
    )


class _UnavailableBrowserProbe:
    supported_access_keys = frozenset({"springerlink"})

    def __init__(self) -> None:
        self.calls: list[str] = []

    def probe(self, access_key: str) -> BrowserConfigurationProbeResult:
        self.calls.append(access_key)
        raise AssertionError("an unavailable Browser probe must not execute")


class _ScheduledFixtureBrowserProbe:
    supported_access_keys = frozenset({_ACCESS_KEY})

    def __init__(self, fixture_path: Path) -> None:
        self._fixture_path = fixture_path
        self._scheduler = BrowserGroupScheduler(clock=_FixtureClock(), max_concurrency=2)
        self.calls: list[str] = []
        self.navigation_count = 0

    def probe(self, access_key: str) -> BrowserConfigurationProbeResult:
        self.calls.append(access_key)
        fixture = json.loads(self._fixture_path.read_text(encoding="utf-8"))
        page = fixture["authenticated-and-entitled"]
        policy = BrowserGroupPolicy(
            rate_limit_group=_GROUP,
            policy_revision="fixture-browser-policy-v1",
            minimum_start_interval=10.0,
            rate_limit_cooldown=60.0,
            cooldown_after_completion=1.0,
            failure_cooldown=5.0,
            runtime_failure_threshold=2,
        )
        attempt = BrowserArticleAttempt(
            attempt_key="configuration-probe-fixture-publisher",
            rate_limit_group=_GROUP,
            session_key=_GROUP,
            policy=policy,
        )

        def run(_attempt: BrowserArticleAttempt) -> BrowserAttemptCompletion[object]:
            self.navigation_count += 1
            result = BrowserConfigurationProbeResult(
                access_key=access_key,
                outcome=ProbeOutcome.PASSED,
                local_ready=True,
                browser_launched=True,
                minimal_target_reached=page["status_code"] == 200,
                navigation_count=self.navigation_count,
            )
            return BrowserAttemptCompletion(
                result,
                BrowserAttemptDisposition.COMPLETED,
                BrowserGroupFeedback.SUCCESS,
            )

        scheduled = self._scheduler.execute((attempt,), run)
        result = scheduled[0].value
        if not isinstance(result, BrowserConfigurationProbeResult):
            raise AssertionError("fixture scheduler did not return a Browser probe result")
        return result


class BrowserConfigurationStatusTests(unittest.TestCase):
    def test_production_status_has_nine_persistent_profile_routes(self) -> None:
        status = browser_access_status(
            Configuration(),
            python_dependency_available=True,
            chromium_executable_available=True,
            headed_display_available=True,
        )

        self.assertTrue(status.runtime.framework_available)
        self.assertTrue(status.runtime.python_dependency_available)
        self.assertTrue(status.runtime.chromium_executable_available)
        self.assertTrue(status.runtime.headed_display_available)
        self.assertFalse(status.runtime.launch_assessed)
        self.assertEqual(status.production_route_count, 9)
        self.assertEqual(status.automatic_route_count, 9)
        self.assertEqual(
            tuple(route.access_key for route in status.routes),
            (
                "acs-publications",
                "aip-publishing",
                "elsevier-sciencedirect",
                "iopscience",
                "oxford-academic",
                "rsc-publishing",
                "science-aaas",
                "springerlink",
                "wiley-online-library",
            ),
        )
        self.assertEqual(
            tuple(route.rate_limit_group for route in status.routes),
            (
                "acs-publications",
                "aip-publishing",
                "elsevier",
                "iopscience",
                "oxford-academic",
                "rsc-publishing",
                "science-aaas",
                "springerlink",
                "wiley",
            ),
        )
        self.assertTrue(all(route.automatic_acquisition_eligible for route in status.routes))
        self.assertFalse(status.automatic_acquisition_available)
        self.assertEqual(status.mode, "headed-persistent-profile")
        self.assertTrue(status.persistent_authentication_supported)
        self.assertEqual(status.article_entitlement, "checked-per-article")
        self.assertEqual(
            status.action_required[0].code,
            "browser-disabled",
        )

    def test_enabled_status_reports_profile_presence_without_reading_authentication(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            initialize_browser_profile("fixture-profile", home=home)
            status = browser_access_status(
                Configuration.model_validate(
                    {
                        "access": {
                            "browser_enabled": True,
                            "browser_profile": "fixture-profile",
                        }
                    }
                ),
                home=home,
                python_dependency_available=True,
                chromium_executable_available=True,
                headed_display_available=True,
            )

        rendered = status.model_dump_json()
        self.assertTrue(status.automatic_acquisition_available)
        self.assertEqual(
            tuple(item.code for item in status.action_required),
            ("browser-session-not-assessed",),
        )
        self.assertNotIn("machine_access", rendered.casefold())
        self.assertNotIn("profile_path", rendered.casefold())
        self.assertNotIn("cookie", rendered.casefold())
        self.assertEqual(status.profile.selected, "fixture-profile")
        self.assertIs(status.profile.presence, BrowserProfilePresence.CONFIGURED)
        self.assertEqual(status.session.assessment, "not-assessed")
        self.assertIsNone(status.session.authenticated)

    def test_enabled_status_requires_a_headed_display_runtime(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            initialize_browser_profile("fixture-profile", home=home)
            status = browser_access_status(
                Configuration.model_validate(
                    {
                        "access": {
                            "browser_enabled": True,
                            "browser_profile": "fixture-profile",
                        }
                    }
                ),
                home=home,
                python_dependency_available=True,
                chromium_executable_available=True,
                headed_display_available=False,
            )

        self.assertFalse(status.automatic_acquisition_available)
        self.assertFalse(status.runtime.headed_display_available)
        self.assertEqual(
            status.action_required[0].code,
            "browser-headed-display-unavailable",
        )

    def test_all_nine_routes_are_probe_eligible_when_browser_is_enabled(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            initialize_browser_profile("fixture-profile", home=home)
            status = browser_access_status(
                Configuration.model_validate(
                    {
                        "access": {
                            "browser_enabled": True,
                            "browser_profile": "fixture-profile",
                        }
                    }
                ),
                home=home,
                python_dependency_available=True,
                chromium_executable_available=True,
                headed_display_available=True,
                probe_supported_access_keys=frozenset(
                    {
                        "acs-publications",
                        "aip-publishing",
                        "elsevier-sciencedirect",
                        "iopscience",
                        "oxford-academic",
                        "rsc-publishing",
                        "science-aaas",
                        "springerlink",
                        "wiley-online-library",
                    }
                ),
            )

        self.assertEqual(status.production_route_count, 9)
        self.assertEqual(status.automatic_route_count, 9)
        self.assertTrue(status.automatic_acquisition_available)
        self.assertEqual(
            tuple(item.code for item in status.action_required),
            ("browser-session-not-assessed",),
        )
        self.assertEqual(len(status.probe.supported_access_keys), 9)
        self.assertTrue(all(route.automatic_acquisition_eligible for route in status.routes))

    def test_status_rejects_probe_targets_that_are_not_production_routes(self) -> None:
        with self.assertRaises(configuration_boundary.ConfigurationError):
            browser_access_status(
                Configuration(),
                python_dependency_available=True,
                chromium_executable_available=True,
                headed_display_available=True,
                probe_supported_access_keys=frozenset({_ACCESS_KEY}),
            )

    def test_browser_probe_model_never_accepts_article_entitlement_claims(self) -> None:
        with self.assertRaises(ValidationError):
            BrowserConfigurationProbeResult(
                access_key=_ACCESS_KEY,
                outcome=ProbeOutcome.PASSED,
                local_ready=True,
                browser_launched=True,
                minimal_target_reached=True,
                article_entitlement="proven",  # type: ignore[arg-type]
                navigation_count=1,
            )

    def test_browser_probe_rejects_a_saved_authentication_claim(self) -> None:
        with self.assertRaises(ValidationError):
            BrowserConfigurationProbeResult(
                access_key=_ACCESS_KEY,
                outcome=ProbeOutcome.PASSED,
                local_ready=True,
                browser_launched=True,
                minimal_target_reached=True,
                authentication_accepted=True,  # type: ignore[call-arg]
                navigation_count=1,
            )


class BrowserConfigurationProbeTests(unittest.TestCase):
    def test_disabled_production_probe_is_stably_skipped_without_browser_io(self) -> None:
        port = _UnavailableBrowserProbe()
        status = browser_access_status(
            Configuration(),
            python_dependency_available=True,
            chromium_executable_available=True,
            headed_display_available=True,
            probe_supported_access_keys=frozenset({"springerlink"}),
        )

        result = run_browser_configuration_probe(
            "springerlink",
            port,
            status_snapshot=status,
        )

        self.assertIs(result.outcome, ProbeOutcome.SKIPPED)
        self.assertFalse(result.local_ready)
        self.assertEqual(result.failure_code, "browser-disabled")
        self.assertFalse(result.persisted)
        self.assertEqual(result.navigation_count, 0)
        self.assertEqual(port.calls, [])

    def test_approved_fixture_probe_uses_scheduler_and_navigates_exactly_once(self) -> None:
        fixture = (
            Path(__file__).parent
            / "fixtures"
            / "acquisition"
            / "browser"
            / "access-page-states.json"
        )
        port = _ScheduledFixtureBrowserProbe(fixture)

        result = run_browser_configuration_probe(
            _ACCESS_KEY,
            port,
            status_snapshot=_approved_status(),
        )

        self.assertIs(result.outcome, ProbeOutcome.PASSED)
        self.assertEqual(result.navigation_count, 1)
        self.assertEqual(port.navigation_count, 1)
        self.assertEqual(port.calls, [_ACCESS_KEY])
        self.assertEqual(result.article_entitlement, "not-proven")
        self.assertFalse(result.persisted)

    def test_browser_probe_local_failure_prevents_port_execution(self) -> None:
        status = _approved_status().model_copy(
            update={
                "enabled": False,
                "automatic_acquisition_available": False,
            }
        )
        port = _ScheduledFixtureBrowserProbe(Path("must-not-be-read.json"))

        result = run_browser_configuration_probe(
            _ACCESS_KEY,
            port,
            status_snapshot=status,
        )

        self.assertIs(result.outcome, ProbeOutcome.SKIPPED)
        self.assertEqual(result.failure_code, "browser-disabled")
        self.assertEqual(port.calls, [])
        self.assertEqual(port.navigation_count, 0)


if __name__ == "__main__":
    unittest.main()
