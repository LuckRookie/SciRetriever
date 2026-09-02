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
    configuration_path,
    load_configuration,
    load_credentials,
    load_runtime_secrets,
    load_user_configuration,
    parse_configuration,
    remove_model_provider_credentials,
    set_core_credentials,
    set_model_provider_credentials,
    update_configuration_sections,
    update_model_provider_configuration,
)
from sciretriever.model.configuration import (
    AccessConfig,
    AcquisitionSourcesConfig,
    AgentProtocol,
    AgentReasoningEffort,
    AnalysisConfig,
    BrowserPolicyOverrideConfig,
    CoreCredentialService,
    ModelConfig,
    ModelProviderConfig,
    ModelProvidersConfig,
    ModelsConfig,
    ParserConnectionMode,
    ProviderName,
    SciHubAcquisitionConfig,
    SourceMode,
    SourcesConfig,
)
from sciretriever.network.browser_scheduler import BrowserGroupPolicy

_SECRET = "CORE-CONFIGURATION-SECRET-SENTINEL"


def _models(
    *,
    reasoning: AgentReasoningEffort = AgentReasoningEffort.PROVIDER_DEFAULT,
) -> ModelsConfig:
    return ModelsConfig(
        values=(
            ModelConfig(
                reference="main/fixture-model",
                reasoning=reasoning,
                image=False,
            ),
        ),
    )


def _providers(*, base_url: str = "https://api.openai.com/v1") -> ModelProvidersConfig:
    return ModelProvidersConfig(
        values=(
            ModelProviderConfig(
                name="main",
                api=AgentProtocol.OPENAI_RESPONSES,
                base_url=base_url,
            ),
        ),
    )


def _analyze() -> AnalysisConfig:
    return AnalysisConfig(model="main/fixture-model")


def _write_user_configuration(home: Path, payload: str) -> Path:
    path = configuration_path(home=home)
    path.parent.mkdir(mode=0o700, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    path.chmod(0o600)
    return path


class OrdinaryConfigurationEditingTests(unittest.TestCase):
    def test_sci_hub_mirror_list_round_trips_in_sources_without_credentials(self) -> None:
        settings = SciHubAcquisitionConfig(
            urls=("https://mirror-one.example", "https://mirror-two.example/base")
        )
        sources = SourcesConfig(
            acquisition=AcquisitionSourcesConfig.model_validate(
                {
                    "mode": SourceMode.CUSTOM,
                    "providers": (ProviderName.SCI_HUB,),
                    "sci-hub": settings,
                }
            )
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = _write_user_configuration(
                root,
                "# operator heading\n[sources.acquisition]\nproviders = []\n",
            )

            updated = update_configuration_sections(sources=sources, home=root)
            reloaded = load_user_configuration(home=root)
            rendered = path.read_text(encoding="utf-8")

        self.assertEqual(updated, reloaded)
        self.assertEqual(reloaded.sources.acquisition.sci_hub, settings)
        self.assertIn("# operator heading", rendered)
        self.assertIn("[sources.acquisition.sci-hub]", rendered)
        self.assertIn('"https://mirror-one.example"', rendered)
        self.assertIn('"https://mirror-two.example/base"', rendered)
        self.assertNotIn("api_key", rendered)

    def test_sci_hub_reset_removes_custom_table_while_provider_stays_enabled(self) -> None:
        custom = SourcesConfig(
            acquisition=AcquisitionSourcesConfig.model_validate(
                {
                    "mode": SourceMode.CUSTOM,
                    "providers": (ProviderName.SCI_HUB,),
                    "sci-hub": SciHubAcquisitionConfig(urls=("https://mirror-one.example",)),
                }
            )
        )
        builtin = SourcesConfig(
            acquisition=AcquisitionSourcesConfig(
                mode=SourceMode.CUSTOM,
                providers=(ProviderName.SCI_HUB,),
            )
        )
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = _write_user_configuration(root, "# operator heading\n")
            update_configuration_sections(sources=custom, home=root)

            updated = update_configuration_sections(sources=builtin, home=root)
            reloaded = load_user_configuration(home=root)
            rendered = path.read_text(encoding="utf-8")

        self.assertEqual(updated, reloaded)
        self.assertIn(ProviderName.SCI_HUB, reloaded.sources.acquisition.providers)
        self.assertIsNone(reloaded.sources.acquisition.sci_hub)
        self.assertIn("# operator heading", rendered)
        self.assertNotIn("[sources.acquisition.sci-hub]", rendered)
        self.assertNotIn("mirror-one.example", rendered)

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
            path = _write_user_configuration(
                root,
                "# operator heading\n"
                "[paths]\n"
                "# keep unrelated section comments\n"
                'catalog_path = "catalog.sqlite3"\n\n'
                "[download]\n"
                "# keep Browser switch comment\n"
                "browser_enabled = false\n"
                "browser_max_concurrency = 2\n",
            )

            with patch(
                "sciretriever.configuration.browser_access._production_browser_group_policies",
                return_value={baseline.rate_limit_group: baseline},
            ):
                updated = update_configuration_sections(access=access, home=root)
                reloaded = load_user_configuration(home=root)

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
            self.assertFalse((root / ".sciretriever" / "credentials.toml").exists())
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_user_configuration_path_is_fixed_and_ignores_environment_and_cwd(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            private = home / ".sciretriever"
            private.mkdir(mode=0o700)
            fixed = private / "config.toml"
            fixed.write_text(
                "[download]\nbrowser_max_concurrency = 7\n",
                encoding="utf-8",
            )
            fixed.chmod(0o600)

            alternate = root / "alternate.toml"
            alternate.write_text(
                "[download]\nbrowser_max_concurrency = 8\n",
                encoding="utf-8",
            )
            working = root / "working"
            working.mkdir()
            (working / "config.toml").write_text(
                "[download]\nbrowser_max_concurrency = 9\n",
                encoding="utf-8",
            )

            with (
                patch.dict(
                    os.environ,
                    {"SCIRETRIEVER_CONFIG": os.fspath(alternate)},
                ),
                patch("pathlib.Path.cwd", return_value=working),
            ):
                selected = load_user_configuration(home=home)

            self.assertEqual(configuration_path(home=home), fixed)
            self.assertEqual(selected.access.browser_max_concurrency, 7)

    def test_missing_user_configuration_does_not_fall_back_to_old_sources(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            alternate = root / "alternate.toml"
            alternate.write_text("[download]\n", encoding="utf-8")
            working = root / "working"
            working.mkdir()
            (working / "config.toml").write_text("[download]\n", encoding="utf-8")

            with (
                patch.dict(
                    os.environ,
                    {"SCIRETRIEVER_CONFIG": os.fspath(alternate)},
                ),
                patch("pathlib.Path.cwd", return_value=working),
                self.assertRaises(ConfigurationError),
            ):
                load_user_configuration(home=home)

    def test_first_confirmed_edit_creates_private_user_directory_and_file(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)

            configured = update_configuration_sections(
                access=AccessConfig(browser_max_concurrency=6),
                home=home,
            )

            path = configuration_path(home=home)
            self.assertEqual(configured, load_user_configuration(home=home))
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertFalse((path.parent / "credentials.toml").exists())

    def test_user_configuration_rejects_unsafe_directory_and_file_links(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            unsafe_mode_home = root / "unsafe-mode-home"
            unsafe_mode_home.mkdir(mode=0o700)
            unsafe_private = unsafe_mode_home / ".sciretriever"
            unsafe_private.mkdir(mode=0o755)
            unsafe_private.chmod(0o755)
            unsafe_file = unsafe_private / "config.toml"
            unsafe_file.write_text("[download]\n", encoding="utf-8")
            unsafe_file.chmod(0o600)
            with self.assertRaisesRegex(
                ConfigurationError,
                "configuration directory has unsafe ownership or permissions",
            ):
                load_user_configuration(home=unsafe_mode_home)

            linked_home = root / "linked-home"
            linked_home.mkdir(mode=0o700)
            actual_private = root / "actual-private"
            actual_private.mkdir(mode=0o700)
            (linked_home / ".sciretriever").symlink_to(actual_private, target_is_directory=True)
            with self.assertRaisesRegex(
                ConfigurationError,
                "configuration directory is a symbolic link",
            ):
                load_user_configuration(home=linked_home)

    def test_user_configuration_rejects_unsafe_file_mode_symlink_and_hardlink(self) -> None:
        for kind in ("mode", "symlink", "hardlink"):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary) / "home"
                home.mkdir(mode=0o700)
                path = configuration_path(home=home)
                path.parent.mkdir(mode=0o700)
                outside = Path(temporary) / "outside.toml"
                outside.write_text("[download]\n", encoding="utf-8")
                outside.chmod(0o600)
                if kind == "mode":
                    path.write_text("[download]\n", encoding="utf-8")
                    path.chmod(0o644)
                    expected = "configuration file has unsafe ownership or permissions"
                elif kind == "symlink":
                    path.symlink_to(outside)
                    expected = "configuration file is a symbolic link"
                else:
                    os.link(outside, path)
                    expected = "configuration file has unsafe ownership or permissions"

                with self.assertRaisesRegex(ConfigurationError, expected):
                    load_user_configuration(home=home)

    def test_round_trip_edit_preserves_other_sections_comments_and_publishes_mode_0600(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = _write_user_configuration(
                root,
                "# operator heading\n"
                "[paths]\n"
                "# keep this path comment\n"
                'catalog_path = "/private/catalog.sqlite3"\n\n'
                "[providers.main]\n"
                'api = "openai-responses"\n'
                'base_url = "https://api.openai.com/v1"\n'
                '[models."main/fixture-model"]\n'
                "# replace this reasoning, preserving its comment\n"
                'reasoning = "low"\n'
                "image = true\n",
            )

            updated = update_configuration_sections(models=_models(), home=root)

            rendered = path.read_text(encoding="utf-8")
            self.assertIn("# operator heading", rendered)
            self.assertIn("# keep this path comment", rendered)
            self.assertIn("# replace this reasoning, preserving its comment", rendered)
            self.assertIn('[models."main/fixture-model"]', rendered)
            self.assertEqual(updated, load_configuration(path))
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_model_reasoning_is_published_and_round_trips_in_user_toml(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            updated = update_configuration_sections(
                providers=_providers(),
                models=_models(reasoning=AgentReasoningEffort.HIGH),
                home=root,
            )

            rendered = configuration_path(home=root).read_text(encoding="utf-8")
            self.assertIn('reasoning = "high"', rendered)
            model = updated.models.get("main/fixture-model")
            self.assertIsNotNone(model)
            assert model is not None
            self.assertIs(
                model.reasoning,
                AgentReasoningEffort.HIGH,
            )
            self.assertEqual(updated, load_user_configuration(home=root))

    def test_model_stream_false_is_published_and_round_trips_in_user_toml(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            models = _models()
            selected = models.values[0].model_copy(update={"stream": False})

            updated = update_configuration_sections(
                providers=_providers(),
                models=ModelsConfig(values=(selected,)),
                home=root,
            )

            rendered = configuration_path(home=root).read_text(encoding="utf-8")
            self.assertIn("stream = false", rendered)
            saved = updated.models.get("main/fixture-model")
            self.assertIsNotNone(saved)
            assert saved is not None
            self.assertFalse(saved.stream)
            self.assertEqual(updated, load_user_configuration(home=root))

    def test_precommit_failure_retains_original_bytes_and_cleans_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            path = configuration_path(home=root)
            path.parent.mkdir(mode=0o700)
            original = b"[models]\n"
            path.write_bytes(original)
            path.chmod(0o600)

            def failpoint(name: str) -> None:
                if name == "before-replace":
                    raise RuntimeError("private failure")

            with self.assertRaises(ConfigurationError):
                update_configuration_sections(
                    providers=_providers(),
                    models=_models(),
                    home=root,
                    failpoint=failpoint,
                )

            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(tuple(path.parent.glob(".config-*.staging")), ())

    def test_diff_is_section_scoped_secret_free_and_stable(self) -> None:
        before = parse_configuration("[models]\n")
        after = before.model_copy(update={"models": _models()})

        changes = configuration_diff(before, after, sections=("models",))

        self.assertTrue(
            any(
                field == "models.main/fixture-model"
                and isinstance(new, dict)
                and new.get("reasoning") == "default"
                for field, _old, new in changes
            )
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
            sections=("download",),
        )
        self.assertIn(("download.browser_enabled", False, True), access_changes)
        self.assertNotIn("machine_access", repr(access_changes))
        self.assertIn(
            ("download.browser_profile", None, "fixture-profile"),
            access_changes,
        )
        self.assertIn(("download.browser_max_concurrency", 5, 3), access_changes)
        self.assertNotIn(_SECRET, repr(access_changes))


class ModelProviderCredentialTests(unittest.TestCase):
    def _configure_remote_model(self, home: Path) -> Path:
        path = configuration_path(home=home)
        update_configuration_sections(
            providers=_providers(),
            models=_models(),
            analysis=_analyze(),
            home=home,
        )
        set_model_provider_credentials(
            "main",
            secret="old-secret",
            origin="https://api.openai.com",
            home=home,
        )
        return path

    def test_model_mineru_and_provider_credentials_have_distinct_owners(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            from sciretriever.configuration import set_credentials

            set_credentials("web-of-science", {"api_key": "provider-secret"}, home=home)
            set_model_provider_credentials(
                "main",
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
            self.assertTrue(credentials.has_model_provider("main"))
            self.assertEqual(
                credentials.model_provider_field_names("main"),
                ("api_key", "origin"),
            )
            self.assertTrue(credentials.has_core_service("mineru"))
            self.assertNotIn(_SECRET, repr(credentials))

            removed = remove_model_provider_credentials("main", home=home)
            self.assertFalse(removed.has_model_provider("main"))
            self.assertTrue(removed.has_core_service("mineru"))
            self.assertTrue(removed.has_provider("web-of-science"))

    def test_runtime_secret_requires_the_exact_model_provider_origin(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_model_provider_credentials(
                "main",
                secret=_SECRET,
                origin="https://api.openai.com",
                home=home,
            )
            credentials = load_credentials(home=home)
            configuration = update_configuration_sections(
                providers=_providers(),
                models=_models(),
                analysis=_analyze(),
                home=home,
            )
            secrets = load_runtime_secrets(
                configuration,
                credentials=credentials,
                include_parser=False,
            )
            self.assertEqual(secrets.model_api_key("main"), _SECRET)
            self.assertNotIn(_SECRET, repr(secrets))

            wrong_origin = configuration.model_copy(
                update={"providers": _providers(base_url="https://other.example.invalid/v1")}
            )
            with self.assertRaises(ConfigurationError):
                load_runtime_secrets(
                    wrong_origin,
                    credentials=credentials,
                    include_parser=False,
                )

    def test_loopback_model_provider_and_parser_require_no_secret(self) -> None:
        configuration = parse_configuration(
            """
            [parsing]
            base_url = "http://127.0.0.1:8000"
            connection_mode = "loopback"
            model_identity = "mineru-3.4.4-vlm"

            [providers.local]
            api = "openai-chat-completions"
            base_url = "http://127.0.0.1:1234/v1"
            [models."local/local-model"]
            reasoning = "default"
            image = false
            [analyze]
            model = "local/local-model"
            """
        )
        with patch(
            "sciretriever.configuration.credentials.load_credentials",
            side_effect=AssertionError("local Providers must not read credentials.toml"),
        ) as load:
            secrets = load_runtime_secrets(configuration)
        load.assert_not_called()
        self.assertIsNone(secrets.mineru_bearer_token)
        self.assertIsNone(secrets.model_api_key("local"))
        self.assertIs(configuration.parsing.connection_mode, ParserConnectionMode.LOOPBACK)

    def test_cross_file_endpoint_change_keeps_both_origins_runnable_at_commits(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            path = self._configure_remote_model(home)
            replacement = _providers(base_url="https://llm.example.invalid/v1")
            observations: dict[str, tuple[str, str]] = {}

            def observe(name: str) -> None:
                if name not in {
                    "credentials-transition-published",
                    "configuration-published",
                }:
                    return
                credentials = load_credentials(home=home)
                current = load_configuration(path)
                provider = current.providers.get("main")
                assert provider is not None
                secret = load_runtime_secrets(
                    current,
                    credentials=credentials,
                    include_parser=False,
                ).model_api_key("main")
                observations[name] = (provider.base_url, secret or "")

            update_model_provider_configuration(
                provider="main",
                providers=replacement,
                models=_models(),
                analysis=_analyze(),
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
            self.assertEqual(
                final.model_provider_field_names("main"),
                ("api_key", "origin"),
            )
            self.assertIsNone(final.model_secret_for_origin("main", "https://api.openai.com"))
            self.assertEqual(
                final.model_secret_for_origin("main", "https://llm.example.invalid"),
                "new-secret",
            )

    def test_cross_file_failure_before_config_publish_leaves_old_model_runnable(
        self,
    ) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            path = self._configure_remote_model(home)

            def interrupt(name: str) -> None:
                if name == "credentials-transition-published":
                    raise RuntimeError("simulated interruption")

            with self.assertRaises(ConfigurationError):
                update_model_provider_configuration(
                    provider="main",
                    providers=_providers(base_url="https://llm.example.invalid/v1"),
                    models=_models(),
                    analysis=_analyze(),
                    secret="new-secret",
                    origin="https://llm.example.invalid",
                    home=home,
                    failpoint=interrupt,
                )

            current = load_configuration(path)
            credentials = load_credentials(home=home)
            provider = current.providers.get("main")
            assert provider is not None
            self.assertEqual(provider.base_url, "https://api.openai.com/v1")
            self.assertEqual(
                load_runtime_secrets(
                    current,
                    credentials=credentials,
                    include_parser=False,
                ).model_api_key("main"),
                "old-secret",
            )
            self.assertNotIn("old-secret", repr(credentials))
            self.assertNotIn("new-secret", repr(credentials))

    def test_all_stagings_are_validated_before_the_first_cross_file_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            path = self._configure_remote_model(home)
            original_config = path.read_bytes()
            credentials_path = home / ".sciretriever" / "credentials.toml"
            original_credentials = credentials_path.read_bytes()

            def interrupt(name: str) -> None:
                if name == "all-stagings-validated":
                    self.assertEqual(len(tuple(path.parent.glob(".config-*.staging"))), 1)
                    self.assertEqual(
                        len(tuple(path.parent.glob(".credentials-*.staging"))),
                        2,
                    )
                    raise RuntimeError("simulated precommit interruption")

            with self.assertRaises(ConfigurationError):
                update_model_provider_configuration(
                    provider="main",
                    providers=_providers(base_url="https://llm.example.invalid/v1"),
                    models=_models(),
                    analysis=_analyze(),
                    secret="new-secret",
                    origin="https://llm.example.invalid",
                    home=home,
                    failpoint=interrupt,
                )

            self.assertEqual(path.read_bytes(), original_config)
            self.assertEqual(credentials_path.read_bytes(), original_credentials)
            self.assertEqual(tuple(path.parent.glob(".config-*.staging")), ())
            self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())

    def test_failure_before_final_key_cleanup_leaves_new_model_runnable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            path = self._configure_remote_model(home)

            def interrupt(name: str) -> None:
                if name == "before-credentials-finalize":
                    raise RuntimeError("simulated finalization interruption")

            with self.assertRaises(ConfigurationError):
                update_model_provider_configuration(
                    provider="main",
                    providers=_providers(base_url="https://llm.example.invalid/v1"),
                    models=_models(),
                    analysis=_analyze(),
                    secret="new-secret",
                    origin="https://llm.example.invalid",
                    home=home,
                    failpoint=interrupt,
                )

            current = load_configuration(path)
            credentials = load_credentials(home=home)
            provider = current.providers.get("main")
            assert provider is not None
            self.assertEqual(provider.base_url, "https://llm.example.invalid/v1")
            self.assertEqual(
                load_runtime_secrets(
                    current,
                    credentials=credentials,
                    include_parser=False,
                ).model_api_key("main"),
                "new-secret",
            )
            self.assertEqual(
                credentials.model_provider_field_names("main"),
                ("api_key", "origin"),
            )
            self.assertNotIn("next_api_key", repr(credentials))

    def test_switch_to_loopback_can_run_if_old_key_cleanup_is_interrupted(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            path = self._configure_remote_model(home)
            loopback = _providers(base_url="http://127.0.0.1:1234/v1")

            def interrupt(name: str) -> None:
                if name == "before-credentials-finalize":
                    raise RuntimeError("simulated cleanup interruption")

            with self.assertRaises(ConfigurationError):
                update_model_provider_configuration(
                    provider="main",
                    providers=loopback,
                    models=_models(),
                    analysis=_analyze(),
                    secret=None,
                    origin=None,
                    home=home,
                    failpoint=interrupt,
                )

            current = load_configuration(path)
            provider = current.providers.get("main")
            assert provider is not None
            self.assertFalse(provider.requires_api_key)
            with patch(
                "sciretriever.configuration.credentials.load_credentials",
                side_effect=AssertionError("loopback must ignore an unreferenced old key"),
            ):
                secrets = load_runtime_secrets(current, include_parser=False)
            self.assertIsNone(secrets.model_api_key("main"))
            self.assertTrue(load_credentials(home=home).has_model_provider("main"))

    def test_same_origin_key_update_publishes_one_credential_version(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            path = self._configure_remote_model(home)

            update_model_provider_configuration(
                provider="main",
                providers=_providers(),
                models=_models(),
                analysis=_analyze(),
                secret="new-secret",
                origin="https://api.openai.com",
                home=home,
            )

            credentials_path = home / ".sciretriever" / "credentials.toml"
            payload = credentials_path.read_text(encoding="utf-8")
            credentials = load_credentials(home=home)
            self.assertNotIn("next_", payload)
            self.assertEqual(
                credentials.model_secret_for_origin("main", "https://api.openai.com"),
                "new-secret",
            )
            self.assertEqual(tuple(path.parent.glob(".config-*.staging")), ())
            self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())


if __name__ == "__main__":
    unittest.main()
