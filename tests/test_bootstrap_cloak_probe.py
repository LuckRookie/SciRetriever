from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from sciretriever.bootstrap.browser import _new_browser_runtime
from sciretriever.configuration import initialize_browser_profile, parse_configuration
from sciretriever.configuration.cloak_runtime import (
    CLOAKBROWSER_BROWSER_VERSION,
    CloakRuntimeStatus,
)
from sciretriever.model.access import AccessFailure, BrowserCaptureKind
from sciretriever.model.configuration import Configuration, ProbeOutcome
from sciretriever.network.admission import AccessCoordinator
from sciretriever.network.browser import (
    BrowserCaptureCorrelation,
    BrowserCaptureDecision,
    BrowserCaptureEvidence,
)
from sciretriever.network.cloakbrowser import CloakBrowserRuntimeAvailability


class CloakProbeAssemblyTests(unittest.TestCase):
    def _configuration(self) -> Configuration:
        return parse_configuration(
            """
            [browser]
            enabled = true
            profile = "fixture-profile"
            """
        )

    @staticmethod
    def _ready_status() -> CloakRuntimeStatus:
        return CloakRuntimeStatus(
            presence="configured",
            ready=True,
            version=CLOAKBROWSER_BROWSER_VERSION,
            signature_verified=True,
        )

    @staticmethod
    def _ready_availability() -> CloakBrowserRuntimeAvailability:
        return CloakBrowserRuntimeAvailability(
            cloak_wrapper_available=True,
            playwright_api_available=True,
            binary_executable_available=True,
            headed_display_available=True,
            browser_version=CLOAKBROWSER_BROWSER_VERSION,
        )

    def test_configuration_probe_uses_only_cloak_production_factory(self) -> None:
        import sciretriever.bootstrap as bootstrap

        runtime_factory = mock.Mock(name="cloak-runtime-factory")
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-probe-") as raw:
            home = Path(raw) / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            with (
                mock.patch(
                    "sciretriever.bootstrap.browser.CloakRuntimeManager.status",
                    return_value=self._ready_status(),
                ),
                mock.patch(
                    "sciretriever.bootstrap.browser.cloakbrowser_runtime_availability",
                    return_value=self._ready_availability(),
                ),
                mock.patch(
                    "sciretriever.bootstrap.browser.CloakBrowserFactory",
                    return_value=runtime_factory,
                ) as build_runtime,
            ):
                session = bootstrap.build_production_configuration_probe_session(
                    self._configuration(),
                    credentials_home=home,
                )

            self.assertTrue(session.browser_status.automatic_acquisition_available)
            self.assertEqual(len(session.browser_probe_port.supported_access_keys), 9)
            build_runtime.assert_called_once()
            self.assertIs(
                session.browser_probe_port._client._factory,  # type: ignore[attr-defined]
                runtime_factory,
            )
            session.close()

    def test_missing_cloak_runtime_is_reported_without_creating_a_factory(self) -> None:
        import sciretriever.bootstrap as bootstrap

        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-probe-missing-") as raw:
            home = Path(raw) / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            with (
                mock.patch(
                    "sciretriever.bootstrap.browser.CloakRuntimeManager.status",
                    return_value=CloakRuntimeStatus(presence="missing", ready=False),
                ),
                mock.patch(
                    "sciretriever.bootstrap.browser.cloakbrowser_runtime_availability",
                    return_value=CloakBrowserRuntimeAvailability(
                        cloak_wrapper_available=True,
                        playwright_api_available=True,
                        binary_executable_available=False,
                        headed_display_available=True,
                        browser_version=CLOAKBROWSER_BROWSER_VERSION,
                    ),
                ),
                mock.patch(
                    "sciretriever.bootstrap.browser.CloakBrowserFactory",
                    side_effect=AssertionError("missing runtime must not create a factory"),
                ),
            ):
                session = bootstrap.build_production_configuration_probe_session(
                    self._configuration(),
                    credentials_home=home,
                )
                result = session.run_browser("springerlink")
                session.close()

            self.assertFalse(session.browser_status.automatic_acquisition_available)
            self.assertIs(result.outcome, ProbeOutcome.SKIPPED)
            self.assertEqual(result.navigation_count, 0)

    def test_runtime_failure_is_carried_into_acquisition_execution(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-runtime-failure-") as raw:
            home = Path(raw) / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            with (
                mock.patch(
                    "sciretriever.bootstrap.browser.CloakRuntimeManager.status",
                    return_value=CloakRuntimeStatus(presence="missing", ready=False),
                ),
                mock.patch(
                    "sciretriever.bootstrap.browser.cloakbrowser_runtime_availability",
                    return_value=CloakBrowserRuntimeAvailability(
                        cloak_wrapper_available=True,
                        playwright_api_available=True,
                        binary_executable_available=False,
                        headed_display_available=True,
                        browser_version=CLOAKBROWSER_BROWSER_VERSION,
                    ),
                ),
            ):
                assembly = _new_browser_runtime(
                    self._configuration(),
                    access_coordinator=AccessCoordinator(),
                    resolver=lambda _hostname: (),
                    browser_profile_home=home,
                )

            try:
                self.assertFalse(assembly.ready)
                self.assertEqual(assembly.failure_code, "browser-cloak-binary-unavailable")
                self.assertIsNotNone(assembly.failure)
                self.assertEqual(
                    assembly.failure,
                    assembly.execution.browser_runtime_failure,
                )
                self.assertEqual(
                    assembly.execution.browser_runtime_failure.code
                    if assembly.execution.browser_runtime_failure is not None
                    else None,
                    "browser-cloak-binary-unavailable",
                )
            finally:
                assembly.execution.close()

    def test_probe_disables_capture_and_allows_only_admitted_subresources(self) -> None:
        import sciretriever.bootstrap as bootstrap
        from sciretriever.network.browser import BrowserClient

        runtime_factory = mock.Mock(name="cloak-runtime-factory")
        with tempfile.TemporaryDirectory(prefix="sciretriever-cloak-probe-contract-") as raw:
            home = Path(raw) / "home"
            home.mkdir(mode=0o700)
            initialize_browser_profile("fixture-profile", home=home)
            with (
                mock.patch(
                    "sciretriever.bootstrap.browser.CloakRuntimeManager.status",
                    return_value=self._ready_status(),
                ),
                mock.patch(
                    "sciretriever.bootstrap.browser.cloakbrowser_runtime_availability",
                    return_value=self._ready_availability(),
                ),
                mock.patch(
                    "sciretriever.bootstrap.browser.CloakBrowserFactory",
                    return_value=runtime_factory,
                ),
                mock.patch.object(
                    BrowserClient,
                    "run",
                    return_value=AccessFailure(
                        code="no-download",
                        reason="fixture",
                        action="fixture",
                        retryable=False,
                    ),
                ) as run,
            ):
                session = bootstrap.build_production_configuration_probe_session(
                    self._configuration(),
                    credentials_home=home,
                )
                session.run_browser("wiley-online-library")
                session.close()

            kwargs = run.call_args.kwargs
            self.assertFalse(kwargs["navigation_only"])
            self.assertTrue(kwargs["discard_unapproved_subresources"])
            self.assertIs(
                kwargs["capture_policy"].decide(
                    BrowserCaptureEvidence(
                        locator="https://example.invalid/",
                        kind=BrowserCaptureKind.RESPONSE,
                        media_type="application/pdf",
                        correlation=BrowserCaptureCorrelation.DIRECT_REQUEST,
                        request_navigation=False,
                        from_exact_start=False,
                        redirect_depth=0,
                    )
                ),
                BrowserCaptureDecision.REJECT,
            )


if __name__ == "__main__":
    unittest.main()
