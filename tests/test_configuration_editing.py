from __future__ import annotations

import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from sciretriever.configuration import (
    ConfigurationError,
    configuration_diff,
    load_configuration,
    load_credentials,
    load_runtime_secrets,
    parse_configuration,
    remove_core_credentials,
    select_configuration_edit_path,
    set_core_credentials,
    update_configuration_sections,
    update_core_service_configuration,
)
from sciretriever.model.configuration import (
    AccessConfig,
    AgentAuthentication,
    AgentProtocol,
    AgentProvider,
    AgentRoleConfig,
    AgentsConfig,
    BrowserPolicyOverrideConfig,
    CoreCredentialService,
    ParserConnectionMode,
)
from sciretriever.network.browser_scheduler import BrowserGroupPolicy

_SECRET = "CORE-CONFIGURATION-SECRET-SENTINEL"


def _agents(*, base_url: str = "https://api.openai.com/v1") -> AgentsConfig:
    return AgentsConfig(
        provider=AgentProvider.OPENAI,
        protocol=AgentProtocol.OPENAI_RESPONSES,
        base_url=base_url,
        authentication=AgentAuthentication.API_KEY,
        analysis=AgentRoleConfig(
            model="fixture-model",
            context_window_tokens=128_000,
            max_output_tokens=2_048,
            structured_output=True,
        ),
    )


def _custom_agents(
    *,
    base_url: str,
    service_name: str = "fixture-service",
) -> AgentsConfig:
    return AgentsConfig(
        **{
            **_agents().model_dump(mode="python"),
            "provider": AgentProvider.CUSTOM,
            "service_name": service_name,
            "base_url": base_url,
        }
    )


class OrdinaryConfigurationEditingTests(unittest.TestCase):
    def test_browser_access_round_trip_preserves_comments_and_never_creates_credentials(
        self,
    ) -> None:
        baseline = BrowserGroupPolicy(
            rate_limit_group="fixture-publisher",
            policy_revision="fixture-r1",
            minimum_start_interval=10.0,
            rate_limit_cooldown=60.0,
            runtime_failure_threshold=3,
            maximum_starts_per_window=4,
            window_seconds=120.0,
        )
        access = AccessConfig(
            browser_enabled=True,
            browser_profile="fixture-profile",
            browser_max_concurrency=3,
            browser_policy_overrides=(
                BrowserPolicyOverrideConfig(
                    rate_limit_group=baseline.rate_limit_group,
                    minimum_start_interval=20.0,
                    maximum_starts_per_window=2,
                    window_seconds=240.0,
                ),
            ),
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "config.toml"
            path.write_text(
                "# operator heading\n"
                "[paths]\n"
                "# keep unrelated section comments\n"
                'catalog_path = "catalog.sqlite3"\n\n'
                "[access]\n"
                "# keep Browser switch comment\n"
                "browser_enabled = false\n"
                "browser_max_concurrency = 2\n",
                encoding="utf-8",
            )

            with patch(
                "sciretriever.configuration.browser_access._production_browser_group_policies",
                return_value={baseline.rate_limit_group: baseline},
            ):
                updated = update_configuration_sections(path, access=access)
                reloaded = load_configuration(path)

            rendered = path.read_text(encoding="utf-8")
            self.assertIn("# operator heading", rendered)
            self.assertIn("# keep unrelated section comments", rendered)
            self.assertIn("# keep Browser switch comment", rendered)
            self.assertIn("browser_enabled = true", rendered)
            self.assertIn('browser_profile = "fixture-profile"', rendered)
            self.assertIn("browser_max_concurrency = 3", rendered)
            self.assertNotIn("browser_machine_access_grants", rendered)
            self.assertIn('rate_limit_group = "fixture-publisher"', rendered)
            self.assertIn("minimum_start_interval = 20.0", rendered)
            self.assertEqual(updated, reloaded)
            self.assertEqual(updated.access, access)
            self.assertFalse((root / ".sciretriever").exists())
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_edit_path_selects_explicit_environment_or_cwd_without_requiring_a_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.assertEqual(
                select_configuration_edit_path("chosen.toml", environment={}, cwd=root),
                Path("chosen.toml"),
            )
            self.assertEqual(
                select_configuration_edit_path(
                    environment={"SCIRETRIEVER_CONFIG": os.fspath(root / "selected.toml")},
                    cwd=root,
                ),
                root / "selected.toml",
            )
            self.assertEqual(
                select_configuration_edit_path(environment={}, cwd=root),
                root / "config.toml",
            )

    def test_round_trip_edit_preserves_other_sections_comments_and_publishes_mode_0600(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "config.toml"
            path.write_text(
                "# operator heading\n"
                "[paths]\n"
                "# keep this path comment\n"
                'catalog_path = "/private/catalog.sqlite3"\n\n'
                "[agents]\n"
                "[agents.analysis]\n"
                "# replace this model, preserving its comment\n"
                'model = "old-model"\n',
                encoding="utf-8",
            )

            updated = update_configuration_sections(path, agents=_agents())

            rendered = path.read_text(encoding="utf-8")
            self.assertIn("# operator heading", rendered)
            self.assertIn("# keep this path comment", rendered)
            self.assertIn("# replace this model, preserving its comment", rendered)
            self.assertIn('model = "fixture-model"', rendered)
            self.assertEqual(updated, load_configuration(path))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_precommit_failure_retains_original_bytes_and_cleans_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = root / "config.toml"
            original = b"[agents]\n"
            path.write_bytes(original)

            def failpoint(name: str) -> None:
                if name == "before-replace":
                    raise RuntimeError("private failure")

            with self.assertRaises(ConfigurationError):
                update_configuration_sections(
                    path,
                    agents=_agents(),
                    failpoint=failpoint,
                )

            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(tuple(root.glob(".config-*.staging")), ())

    def test_diff_is_section_scoped_secret_free_and_stable(self) -> None:
        before = parse_configuration("[agents]\n")
        after = before.model_copy(update={"agents": _agents()})

        changes = configuration_diff(before, after, sections=("agents",))

        self.assertTrue(
            any(
                field == "agents.analysis"
                and isinstance(new, dict)
                and new.get("model") == "fixture-model"
                for field, _old, new in changes
            )
        )
        self.assertIn(
            ("agents.protocol", None, AgentProtocol.OPENAI_RESPONSES.value),
            changes,
        )
        self.assertNotIn(_SECRET, repr(changes))

        access = AccessConfig(
            browser_enabled=True,
            browser_profile="fixture-profile",
            browser_max_concurrency=3,
        )
        access_changes = configuration_diff(
            before,
            before.model_copy(update={"access": access}),
            sections=("access",),
        )
        self.assertIn(("access.browser_enabled", False, True), access_changes)
        self.assertNotIn("machine_access", repr(access_changes))
        self.assertIn(
            ("access.browser_profile", None, "fixture-profile"),
            access_changes,
        )
        self.assertIn(("access.browser_max_concurrency", 5, 3), access_changes)
        self.assertNotIn(_SECRET, repr(access_changes))


class CoreServiceCredentialTests(unittest.TestCase):
    def test_llm_and_mineru_sections_are_origin_bound_and_provider_sections_survive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            from sciretriever.configuration import set_credentials

            set_credentials("web-of-science", {"api_key": "provider-secret"}, home=home)
            set_core_credentials(
                CoreCredentialService.AGENTS,
                secret=_SECRET,
                origin="https://api.openai.com",
                home=home,
            )
            credentials = set_core_credentials(
                CoreCredentialService.MINERU,
                secret="mineru-secret",
                origin="https://mineru.example.invalid:8443",
                home=home,
            )

            self.assertTrue(credentials.has_provider("web-of-science"))
            self.assertTrue(credentials.has_core_service("agents"))
            self.assertEqual(credentials.core_field_names("agents"), ("api_key", "origin"))
            self.assertNotIn(_SECRET, repr(credentials))

            removed = remove_core_credentials("agents", home=home)
            self.assertFalse(removed.has_core_service("agents"))
            self.assertTrue(removed.has_core_service("mineru"))
            self.assertTrue(removed.has_provider("web-of-science"))

    def test_runtime_secret_requires_the_exact_saved_origin_and_ignores_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_core_credentials(
                "agents",
                secret=_SECRET,
                origin="https://api.openai.com",
                home=home,
            )
            from sciretriever.configuration import load_credentials

            credentials = load_credentials(home=home)
            configuration = parse_configuration(
                """
                [agents]
                provider = "openai"
                protocol = "openai-responses"
                base_url = "https://api.openai.com/v1"
                authentication = "api-key"
                [agents.analysis]
                model = "fixture-model"
                context_window_tokens = 128000
                """
            )
            secrets = load_runtime_secrets(
                configuration,
                credentials=credentials,
                include_parser=False,
            )
            self.assertEqual(secrets.agents_api_key, _SECRET)
            self.assertNotIn(_SECRET, repr(secrets))

            wrong_origin = configuration.model_copy(
                update={
                    "agents": AgentsConfig(
                        provider=AgentProvider.CUSTOM,
                        service_name="other-service",
                        protocol=AgentProtocol.OPENAI_RESPONSES,
                        base_url="https://other.example.invalid/v1",
                        authentication=AgentAuthentication.API_KEY,
                        analysis=AgentRoleConfig(
                            model="fixture-model",
                            context_window_tokens=128_000,
                        ),
                    ),
                }
            )
            with self.assertRaises(ConfigurationError):
                load_runtime_secrets(
                    wrong_origin,
                    credentials=credentials,
                    include_parser=False,
                )

    def test_loopback_services_require_no_secret(self) -> None:
        configuration = parse_configuration(
            """
            [parsing]
            base_url = "http://127.0.0.1:8000"
            connection_mode = "loopback"
            model_identity = "mineru-3.4.4-vlm"

            [agents]
            provider = "custom"
            service_name = "local-llm"
            protocol = "openai-chat-completions"
            base_url = "http://127.0.0.1:1234/v1"
            authentication = "none"
            [agents.analysis]
            model = "local-model"
            context_window_tokens = 32768
            """
        )
        with patch(
            "sciretriever.configuration.load_credentials",
            side_effect=AssertionError("local services must not read credentials.toml"),
        ) as load:
            secrets = load_runtime_secrets(
                configuration,
                include_parser=True,
                include_agents=True,
            )
        load.assert_not_called()
        self.assertIsNone(secrets.mineru_bearer_token)
        self.assertIsNone(secrets.agents_api_key)
        self.assertIs(configuration.parsing.connection_mode, ParserConnectionMode.LOOPBACK)

    def test_cross_file_endpoint_change_keeps_old_and_new_origins_runnable_at_commits(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            path = root / "config.toml"
            old = _agents()
            update_configuration_sections(path, agents=old)
            set_core_credentials(
                "agents",
                secret="old-secret",
                origin="https://api.openai.com",
                home=home,
            )
            replacement = AgentsConfig(
                **{
                    **old.model_dump(mode="python"),
                    "provider": AgentProvider.CUSTOM,
                    "service_name": "replacement",
                    "base_url": "https://llm.example.invalid/v1",
                }
            )
            observations: dict[str, tuple[str, str]] = {}

            def observe(name: str) -> None:
                if name not in {
                    "credentials-transition-published",
                    "configuration-published",
                }:
                    return
                credentials = load_credentials(home=home)
                current = load_configuration(path)
                current_secret = load_runtime_secrets(
                    current,
                    credentials=credentials,
                    include_parser=False,
                ).agents_api_key
                observations[name] = (current.agents.base_url or "", current_secret or "")

            update_core_service_configuration(
                path,
                "agents",
                agents=replacement,
                secret="new-secret",
                origin="https://llm.example.invalid",
                home=home,
                failpoint=observe,
            )

            self.assertEqual(
                observations,
                {
                    "credentials-transition-published": (
                        "https://api.openai.com/v1",
                        "old-secret",
                    ),
                    "configuration-published": (
                        "https://llm.example.invalid/v1",
                        "new-secret",
                    ),
                },
            )
            final = load_credentials(home=home)
            self.assertEqual(final.core_field_names("agents"), ("api_key", "origin"))
            self.assertIsNone(final.core_secret_for_origin("agents", "https://api.openai.com"))
            self.assertEqual(
                final.core_secret_for_origin("agents", "https://llm.example.invalid"),
                "new-secret",
            )

    def test_cross_file_failure_before_configuration_publish_leaves_old_config_runnable(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            path = root / "config.toml"
            old = _agents()
            update_configuration_sections(path, agents=old)
            set_core_credentials(
                "agents",
                secret="old-secret",
                origin="https://api.openai.com",
                home=home,
            )
            replacement = AgentsConfig(
                **{
                    **old.model_dump(mode="python"),
                    "provider": AgentProvider.CUSTOM,
                    "service_name": "replacement",
                    "base_url": "https://llm.example.invalid/v1",
                }
            )

            def interrupt(name: str) -> None:
                if name == "credentials-transition-published":
                    raise RuntimeError("simulated interruption")

            with self.assertRaises(ConfigurationError):
                update_core_service_configuration(
                    path,
                    "agents",
                    agents=replacement,
                    secret="new-secret",
                    origin="https://llm.example.invalid",
                    home=home,
                    failpoint=interrupt,
                )

            current = load_configuration(path)
            credentials = load_credentials(home=home)
            self.assertEqual(current.agents.base_url, "https://api.openai.com/v1")
            self.assertEqual(
                load_runtime_secrets(
                    current,
                    credentials=credentials,
                    include_parser=False,
                ).agents_api_key,
                "old-secret",
            )
            self.assertNotIn("old-secret", repr(credentials))
            self.assertNotIn("new-secret", repr(credentials))

    def test_all_stagings_are_validated_before_the_first_cross_file_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            path = root / "config.toml"
            update_configuration_sections(path, agents=_agents())
            set_core_credentials(
                "agents",
                secret="old-secret",
                origin="https://api.openai.com",
                home=home,
            )
            original_config = path.read_bytes()
            original_credentials = (home / ".sciretriever" / "credentials.toml").read_bytes()

            def interrupt(name: str) -> None:
                if name == "all-stagings-validated":
                    self.assertEqual(len(tuple(root.glob(".config-*.staging"))), 1)
                    self.assertEqual(
                        len(tuple((home / ".sciretriever").glob(".credentials-*.staging"))),
                        2,
                    )
                    raise RuntimeError("simulated precommit interruption")

            with self.assertRaises(ConfigurationError):
                update_core_service_configuration(
                    path,
                    "agents",
                    agents=_custom_agents(base_url="https://llm.example.invalid/v1"),
                    secret="new-secret",
                    origin="https://llm.example.invalid",
                    home=home,
                    failpoint=interrupt,
                )

            self.assertEqual(path.read_bytes(), original_config)
            self.assertEqual(
                (home / ".sciretriever" / "credentials.toml").read_bytes(),
                original_credentials,
            )
            self.assertEqual(tuple(root.glob(".config-*.staging")), ())
            self.assertEqual(
                tuple((home / ".sciretriever").glob(".credentials-*.staging")),
                (),
            )

    def test_failure_before_final_credential_cleanup_leaves_new_config_runnable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            path = root / "config.toml"
            update_configuration_sections(path, agents=_agents())
            set_core_credentials(
                "agents",
                secret="old-secret",
                origin="https://api.openai.com",
                home=home,
            )

            def interrupt(name: str) -> None:
                if name == "before-credentials-finalize":
                    raise RuntimeError("simulated finalization interruption")

            with self.assertRaises(ConfigurationError):
                update_core_service_configuration(
                    path,
                    "agents",
                    agents=_custom_agents(base_url="https://llm.example.invalid/v1"),
                    secret="new-secret",
                    origin="https://llm.example.invalid",
                    home=home,
                    failpoint=interrupt,
                )

            current = load_configuration(path)
            credentials = load_credentials(home=home)
            self.assertEqual(current.agents.base_url, "https://llm.example.invalid/v1")
            self.assertEqual(
                load_runtime_secrets(
                    current,
                    credentials=credentials,
                    include_parser=False,
                ).agents_api_key,
                "new-secret",
            )
            self.assertEqual(credentials.core_field_names("agents"), ("api_key", "origin"))
            self.assertNotIn("next_api_key", repr(credentials))

    def test_switch_to_loopback_none_auth_can_run_even_if_old_secret_cleanup_is_interrupted(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            path = root / "config.toml"
            update_configuration_sections(path, agents=_agents())
            set_core_credentials(
                "agents",
                secret="old-secret",
                origin="https://api.openai.com",
                home=home,
            )
            loopback = AgentsConfig(
                **{
                    **_agents().model_dump(mode="python"),
                    "provider": AgentProvider.CUSTOM,
                    "service_name": "local",
                    "base_url": "http://127.0.0.1:1234/v1",
                    "authentication": AgentAuthentication.NONE,
                }
            )

            def interrupt(name: str) -> None:
                if name == "before-credentials-finalize":
                    raise RuntimeError("simulated cleanup interruption")

            with self.assertRaises(ConfigurationError):
                update_core_service_configuration(
                    path,
                    "agents",
                    agents=loopback,
                    secret=None,
                    origin=None,
                    home=home,
                    failpoint=interrupt,
                )

            current = load_configuration(path)
            self.assertIs(current.agents.authentication, AgentAuthentication.NONE)
            with patch(
                "sciretriever.configuration.load_credentials",
                side_effect=AssertionError("loopback must ignore an unreferenced old secret"),
            ):
                secrets = load_runtime_secrets(
                    current,
                    include_parser=False,
                )
            self.assertIsNone(secrets.agents_api_key)
            self.assertTrue(load_credentials(home=home).has_core_service("agents"))

    def test_same_origin_secret_update_publishes_one_credential_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            path = root / "config.toml"
            update_configuration_sections(path, agents=_agents())
            set_core_credentials(
                "agents",
                secret="old-secret",
                origin="https://api.openai.com",
                home=home,
            )

            update_core_service_configuration(
                path,
                "agents",
                agents=_agents(),
                secret="new-secret",
                origin="https://api.openai.com",
                home=home,
            )

            payload = (home / ".sciretriever" / "credentials.toml").read_text(encoding="utf-8")
            credentials = load_credentials(home=home)
            self.assertNotIn("next_", payload)
            self.assertEqual(
                credentials.core_secret_for_origin("agents", "https://api.openai.com"),
                "new-secret",
            )
            self.assertEqual(tuple(root.glob(".config-*.staging")), ())
            self.assertEqual(
                tuple((home / ".sciretriever").glob(".credentials-*.staging")),
                (),
            )


if __name__ == "__main__":
    unittest.main()
