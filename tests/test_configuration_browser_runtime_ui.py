from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import sciretriever.configuration as configuration_boundary
import sciretriever.entry.cli.config_center.browser as browser_ui
from sciretriever.configuration.cloak_runtime import (
    CLOAKBROWSER_BROWSER_VERSION,
    CloakRuntimeStatus,
)
from sciretriever.entry.cli.config_ui import ConfigConsole
from sciretriever.model.configuration import (
    AccessConfig,
    Configuration,
    CoreCredentialService,
)
from sciretriever.network.cloakbrowser import CloakBrowserRuntimeAvailability


class ConfigurationBrowserRuntimeUiTests(unittest.TestCase):
    def test_status_exposes_cloak_tuple_and_fixed_manifest_without_profile_content(self) -> None:
        with tempfile.TemporaryDirectory(prefix="sciretriever-config-cloak-status-") as raw:
            home = Path(raw)
            configuration_boundary.initialize_browser_profile("fixture", home=home)
            with patch(
                "sciretriever.configuration.browser_access._cloak_local_status",
                return_value=(
                    True,
                    True,
                    True,
                    CLOAKBROWSER_BROWSER_VERSION,
                    True,
                    True,
                    "sciretriever.browser-identity.v1",
                ),
            ):
                status = configuration_boundary.browser_access_status(
                    Configuration(
                        download=AccessConfig(
                            browser_enabled=True,
                            browser_profile="fixture",
                        )
                    ),
                    home=home,
                    runtime_availability=CloakBrowserRuntimeAvailability(
                        cloak_wrapper_available=True,
                        playwright_api_available=True,
                        binary_executable_available=True,
                        headed_display_available=True,
                        browser_version=CLOAKBROWSER_BROWSER_VERSION,
                    ),
                )

        runtime = status.runtime.model_dump(mode="json")
        self.assertIn("cloak_wrapper_available", runtime)
        self.assertIn("playwright_api_available", runtime)
        self.assertIn("binary_presence", runtime)
        self.assertIn("binary_version", runtime)
        self.assertIn("binary_verified", runtime)
        self.assertTrue(runtime["fixed_identity_manifest"])
        self.assertEqual(runtime["identity_schema"], "sciretriever.browser-identity.v1")
        self.assertNotIn("cutover_pending", runtime)
        self.assertNotIn("chromium_executable_available", runtime)
        rendered = status.model_dump_json()
        self.assertNotIn("fingerprint_seed", rendered)
        self.assertNotIn("profile_path", rendered)
        self.assertNotIn("cookie", rendered.casefold())

    def test_optional_cloak_key_is_origin_bound_but_never_a_runtime_readiness_claim(self) -> None:
        secret = "cloak-pro-secret-sentinel"
        with tempfile.TemporaryDirectory(prefix="sciretriever-config-cloak-key-") as raw:
            home = Path(raw)
            credentials = configuration_boundary.set_core_credentials(
                CoreCredentialService.CLOAKBROWSER,
                secret=secret,
                origin="https://cloakbrowser.dev",
                home=home,
            )
            self.assertTrue(credentials.has_core_service(CoreCredentialService.CLOAKBROWSER))
            self.assertEqual(
                credentials.core_field_names(CoreCredentialService.CLOAKBROWSER),
                ("license_key", "origin"),
            )
            loaded = configuration_boundary.load_credentials(home=home)
            self.assertTrue(loaded.has_core_service("cloakbrowser"))
            self.assertNotIn(secret, repr(loaded))
            configuration_boundary.remove_core_credentials(
                CoreCredentialService.CLOAKBROWSER,
                home=home,
            )
            self.assertFalse(
                configuration_boundary.load_credentials(home=home).has_core_service("cloakbrowser")
            )

    def test_install_requires_two_confirmations_and_never_passes_saved_pro_key(self) -> None:
        manager = Mock()
        manager.status.return_value = CloakRuntimeStatus(presence="missing", ready=False)
        manager.install.return_value = CloakRuntimeStatus(
            presence="configured",
            ready=True,
            version=CLOAKBROWSER_BROWSER_VERSION,
            signature_verified=True,
        )
        with (
            patch.object(browser_ui, "CloakRuntimeManager", return_value=manager),
            patch.object(browser_ui, "confirm", side_effect=(True, True)),
        ):
            browser_ui._install_or_update("install", ConfigConsole("mono"))
        manager.install.assert_called_once_with(CLOAKBROWSER_BROWSER_VERSION)
        self.assertNotIn("license_key", manager.install.call_args.kwargs)

    def test_install_cancellation_before_network_has_no_manager_write(self) -> None:
        manager = Mock()
        manager.status.return_value = CloakRuntimeStatus(presence="missing", ready=False)
        with (
            patch.object(browser_ui, "CloakRuntimeManager", return_value=manager),
            patch.object(browser_ui, "confirm", return_value=False),
        ):
            browser_ui._install_or_update("install", ConfigConsole("mono"))
        manager.install.assert_not_called()
        manager.update.assert_not_called()


if __name__ == "__main__":
    unittest.main()
