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
    AnalysisAuthentication,
    AnalysisConfig,
    AnalysisProtocol,
    AnalysisProvider,
    CoreCredentialService,
    ParserConnectionMode,
)

_SECRET = "CORE-CONFIGURATION-SECRET-SENTINEL"


def _analysis(*, base_url: str = "https://api.openai.com/v1") -> AnalysisConfig:
    return AnalysisConfig(
        provider=AnalysisProvider.OPENAI,
        protocol=AnalysisProtocol.OPENAI_RESPONSES,
        base_url=base_url,
        model="fixture-model",
        context_window_tokens=128_000,
        authentication=AnalysisAuthentication.API_KEY,
        metadata_max_output_tokens=512,
        content_max_output_tokens=2_048,
        reference_max_output_tokens=512,
        max_input_bytes=1_048_576,
        max_chunk_bytes=262_144,
        max_chunk_count=4,
        max_total_llm_requests=8,
        max_total_output_tokens=8_192,
    )


def _custom_analysis(
    *,
    base_url: str,
    service_name: str = "fixture-service",
) -> AnalysisConfig:
    return AnalysisConfig(
        **{
            **_analysis().model_dump(mode="python"),
            "provider": AnalysisProvider.CUSTOM,
            "service_name": service_name,
            "base_url": base_url,
        }
    )


class OrdinaryConfigurationEditingTests(unittest.TestCase):
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
                "[analysis]\n"
                "# replace this model, preserving its comment\n"
                'model = "old-model"\n',
                encoding="utf-8",
            )

            updated = update_configuration_sections(path, analysis=_analysis())

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
            original = b"[analysis]\n"
            path.write_bytes(original)

            def failpoint(name: str) -> None:
                if name == "before-replace":
                    raise RuntimeError("private failure")

            with self.assertRaises(ConfigurationError):
                update_configuration_sections(
                    path,
                    analysis=_analysis(),
                    failpoint=failpoint,
                )

            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(tuple(root.glob(".config-*.staging")), ())

    def test_diff_is_section_scoped_secret_free_and_stable(self) -> None:
        before = parse_configuration("[analysis]\n")
        after = before.model_copy(update={"analysis": _analysis()})

        changes = configuration_diff(before, after, sections=("analysis",))

        self.assertIn(("analysis.model", None, "fixture-model"), changes)
        self.assertIn(
            ("analysis.protocol", None, AnalysisProtocol.OPENAI_RESPONSES.value),
            changes,
        )
        self.assertNotIn(_SECRET, repr(changes))


class CoreServiceCredentialTests(unittest.TestCase):
    def test_llm_and_mineru_sections_are_origin_bound_and_provider_sections_survive(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            from sciretriever.configuration import set_credentials

            set_credentials("web-of-science", {"api_key": "provider-secret"}, home=home)
            set_core_credentials(
                CoreCredentialService.LLM,
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
            self.assertTrue(credentials.has_core_service("llm"))
            self.assertEqual(credentials.core_field_names("llm"), ("api_key", "origin"))
            self.assertNotIn(_SECRET, repr(credentials))

            removed = remove_core_credentials("llm", home=home)
            self.assertFalse(removed.has_core_service("llm"))
            self.assertTrue(removed.has_core_service("mineru"))
            self.assertTrue(removed.has_provider("web-of-science"))

    def test_runtime_secret_requires_the_exact_saved_origin_and_ignores_environment(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_core_credentials(
                "llm",
                secret=_SECRET,
                origin="https://api.openai.com",
                home=home,
            )
            from sciretriever.configuration import load_credentials

            credentials = load_credentials(home=home)
            configuration = parse_configuration(
                """
                [analysis]
                provider = "openai"
                protocol = "openai-responses"
                base_url = "https://api.openai.com/v1"
                model = "fixture-model"
                context_window_tokens = 128000
                authentication = "api-key"
                """
            )
            secrets = load_runtime_secrets(
                configuration,
                credentials=credentials,
                include_parser=False,
            )
            self.assertEqual(secrets.analysis_api_key, _SECRET)
            self.assertNotIn(_SECRET, repr(secrets))

            wrong_origin = configuration.model_copy(
                update={
                    "analysis": AnalysisConfig(
                        provider=AnalysisProvider.CUSTOM,
                        service_name="other-service",
                        protocol=AnalysisProtocol.OPENAI_RESPONSES,
                        base_url="https://other.example.invalid/v1",
                        model="fixture-model",
                        context_window_tokens=128_000,
                        authentication=AnalysisAuthentication.API_KEY,
                    )
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

            [analysis]
            provider = "custom"
            service_name = "local-llm"
            protocol = "openai-chat-completions"
            base_url = "http://127.0.0.1:1234/v1"
            model = "local-model"
            context_window_tokens = 32768
            authentication = "none"
            """
        )
        with patch(
            "sciretriever.configuration.load_credentials",
            side_effect=AssertionError("local services must not read credentials.toml"),
        ) as load:
            secrets = load_runtime_secrets(
                configuration,
                include_parser=True,
                include_analysis=True,
            )
        load.assert_not_called()
        self.assertIsNone(secrets.mineru_bearer_token)
        self.assertIsNone(secrets.analysis_api_key)
        self.assertIs(configuration.parsing.connection_mode, ParserConnectionMode.LOOPBACK)

    def test_cross_file_endpoint_change_keeps_old_and_new_origins_runnable_at_commits(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            path = root / "config.toml"
            old = _analysis()
            update_configuration_sections(path, analysis=old)
            set_core_credentials(
                "llm",
                secret="old-secret",
                origin="https://api.openai.com",
                home=home,
            )
            replacement = AnalysisConfig(
                **{
                    **old.model_dump(mode="python"),
                    "provider": AnalysisProvider.CUSTOM,
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
                ).analysis_api_key
                observations[name] = (current.analysis.base_url or "", current_secret or "")

            update_core_service_configuration(
                path,
                "llm",
                analysis=replacement,
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
            self.assertEqual(final.core_field_names("llm"), ("api_key", "origin"))
            self.assertIsNone(final.core_secret_for_origin("llm", "https://api.openai.com"))
            self.assertEqual(
                final.core_secret_for_origin("llm", "https://llm.example.invalid"),
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
            old = _analysis()
            update_configuration_sections(path, analysis=old)
            set_core_credentials(
                "llm",
                secret="old-secret",
                origin="https://api.openai.com",
                home=home,
            )
            replacement = AnalysisConfig(
                **{
                    **old.model_dump(mode="python"),
                    "provider": AnalysisProvider.CUSTOM,
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
                    "llm",
                    analysis=replacement,
                    secret="new-secret",
                    origin="https://llm.example.invalid",
                    home=home,
                    failpoint=interrupt,
                )

            current = load_configuration(path)
            credentials = load_credentials(home=home)
            self.assertEqual(current.analysis.base_url, "https://api.openai.com/v1")
            self.assertEqual(
                load_runtime_secrets(
                    current,
                    credentials=credentials,
                    include_parser=False,
                ).analysis_api_key,
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
            update_configuration_sections(path, analysis=_analysis())
            set_core_credentials(
                "llm",
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
                    "llm",
                    analysis=_custom_analysis(base_url="https://llm.example.invalid/v1"),
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
            update_configuration_sections(path, analysis=_analysis())
            set_core_credentials(
                "llm",
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
                    "llm",
                    analysis=_custom_analysis(base_url="https://llm.example.invalid/v1"),
                    secret="new-secret",
                    origin="https://llm.example.invalid",
                    home=home,
                    failpoint=interrupt,
                )

            current = load_configuration(path)
            credentials = load_credentials(home=home)
            self.assertEqual(current.analysis.base_url, "https://llm.example.invalid/v1")
            self.assertEqual(
                load_runtime_secrets(
                    current,
                    credentials=credentials,
                    include_parser=False,
                ).analysis_api_key,
                "new-secret",
            )
            self.assertEqual(credentials.core_field_names("llm"), ("api_key", "origin"))
            self.assertNotIn("next_api_key", repr(credentials))

    def test_switch_to_loopback_none_auth_can_run_even_if_old_secret_cleanup_is_interrupted(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            path = root / "config.toml"
            update_configuration_sections(path, analysis=_analysis())
            set_core_credentials(
                "llm",
                secret="old-secret",
                origin="https://api.openai.com",
                home=home,
            )
            loopback = AnalysisConfig(
                **{
                    **_analysis().model_dump(mode="python"),
                    "provider": AnalysisProvider.CUSTOM,
                    "service_name": "local",
                    "base_url": "http://127.0.0.1:1234/v1",
                    "authentication": AnalysisAuthentication.NONE,
                }
            )

            def interrupt(name: str) -> None:
                if name == "before-credentials-finalize":
                    raise RuntimeError("simulated cleanup interruption")

            with self.assertRaises(ConfigurationError):
                update_core_service_configuration(
                    path,
                    "llm",
                    analysis=loopback,
                    secret=None,
                    origin=None,
                    home=home,
                    failpoint=interrupt,
                )

            current = load_configuration(path)
            self.assertIs(current.analysis.authentication, AnalysisAuthentication.NONE)
            with patch(
                "sciretriever.configuration.load_credentials",
                side_effect=AssertionError("loopback must ignore an unreferenced old secret"),
            ):
                secrets = load_runtime_secrets(
                    current,
                    include_parser=False,
                )
            self.assertIsNone(secrets.analysis_api_key)
            self.assertTrue(load_credentials(home=home).has_core_service("llm"))

    def test_same_origin_secret_update_publishes_one_credential_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            path = root / "config.toml"
            update_configuration_sections(path, analysis=_analysis())
            set_core_credentials(
                "llm",
                secret="old-secret",
                origin="https://api.openai.com",
                home=home,
            )

            update_core_service_configuration(
                path,
                "llm",
                analysis=_analysis(),
                secret="new-secret",
                origin="https://api.openai.com",
                home=home,
            )

            payload = (home / ".sciretriever" / "credentials.toml").read_text(encoding="utf-8")
            credentials = load_credentials(home=home)
            self.assertNotIn("next_", payload)
            self.assertEqual(
                credentials.core_secret_for_origin("llm", "https://api.openai.com"),
                "new-secret",
            )
            self.assertEqual(tuple(root.glob(".config-*.staging")), ())
            self.assertEqual(
                tuple((home / ".sciretriever").glob(".credentials-*.staging")),
                (),
            )


if __name__ == "__main__":
    unittest.main()
