from __future__ import annotations

import os
import pickle
import stat
import tempfile
import unittest
from pathlib import Path
from typing import cast
from unittest import mock

from pydantic import ValidationError

import sciretriever.configuration as configuration
import sciretriever.configuration.credential_edits as credential_edits_module
import sciretriever.configuration.credentials as credentials_module
from sciretriever.configuration import (
    ConfigurationError,
    configurable_credential_providers,
    credential_diagnostic,
    credential_field_specs,
    credential_path,
    credential_section_exists,
    credential_status_for,
    load_credentials,
    load_runtime_secrets,
    parse_configuration,
    remove_credentials,
    set_core_credentials,
    set_credentials,
    set_model_provider_credentials,
    tightened_browser_group_policies,
)
from sciretriever.configuration.file_store import _MAX_CREDENTIALS_BYTES
from sciretriever.model.configuration import (
    AgentProtocol,
    AgentReasoningEffort,
    AnalysisConfig,
    BrowserConfig,
    BrowserPolicyOverrideConfig,
    Configuration,
    CoreCredentialService,
    CredentialStatus,
    ModelConfig,
    ModelProviderConfig,
    ModelProvidersConfig,
    ModelsConfig,
    ParsingConfig,
    ProviderCapability,
)
from sciretriever.network.browser_scheduler import BrowserGroupPolicy

SENTINEL = "CONFIGURATION-SECRET-SENTINEL"


class ConfigurationModelBoundaryTests(unittest.TestCase):
    def test_sci_hub_uses_one_ordered_closed_multi_mirror_configuration(self) -> None:
        selected = parse_configuration(
            "[sources.acquisition]\n"
            'mode = "custom"\n'
            'providers = ["sci-hub"]\n'
            "[sources.acquisition.sci-hub]\n"
            'urls = ["https://MIRROR-ONE.example:443/base/", '
            '"https://mirror-two.example"]\n'
        )
        settings = selected.sources.acquisition.sci_hub
        self.assertIsNotNone(settings)
        assert settings is not None
        self.assertEqual(
            settings.urls,
            (
                "https://mirror-one.example/base",
                "https://mirror-two.example",
            ),
        )
        self.assertEqual(
            selected.model_dump(mode="json", by_alias=True)["sources"]["acquisition"]["sci-hub"],
            {"urls": list(settings.urls)},
        )

        invalid = (
            "urls = []\n",
            'urls = ["http://mirror.example"]\n',
            'urls = ["https://127.0.0.1"]\n',
            'urls = ["https://localhost"]\n',
            'urls = ["https://mirror.localhost"]\n',
            'urls = ["https://user:secret@mirror.example"]\n',
            'urls = ["https://mirror.example/path?token=secret"]\n',
            'urls = ["https://mirror.example/path#fragment"]\n',
            'urls = ["https://mirror.example:8443"]\n',
            'urls = ["https://MIRROR.example/", "https://mirror.example"]\n',
            'urls = ["https://one.example", "https://two.example", '
            '"https://three.example", "https://four.example", "https://five.example", '
            '"https://six.example", "https://seven.example", "https://eight.example", '
            '"https://nine.example"]\n',
            'url = "https://mirror.example"\n',
            'urls = ["https://mirror.example"]\nselector = "forbidden"\n',
        )
        for fields in invalid:
            with self.subTest(fields=fields), self.assertRaises(ConfigurationError):
                parse_configuration("[sources.acquisition.sci-hub]\n" + fields)

    def test_reasoning_is_owned_by_each_configured_model(self) -> None:
        default_model = ModelConfig(reference="fixture/model")
        self.assertIs(default_model.reasoning, AgentReasoningEffort.PROVIDER_DEFAULT)
        self.assertTrue(default_model.stream)
        for effort in AgentReasoningEffort:
            with self.subTest(effort=effort.value):
                selected = parse_configuration(
                    "[providers.openai]\n"
                    'api = "openai-responses"\n'
                    'base_url = "https://api.openai.com/v1"\n'
                    '[models."openai/fixture-model"]\n'
                    f'reasoning = "{effort.value}"\n'
                    "image = false\n"
                    "[analyze]\n"
                    'model = "openai/fixture-model"\n'
                )
                model = selected.models.get("openai/fixture-model")
                self.assertIsNotNone(model)
                assert model is not None
                self.assertIs(model.reasoning, effort)
                self.assertTrue(model.stream)
        for value in ("ultra", "", 1, True):
            with self.subTest(value=value), self.assertRaises(ConfigurationError):
                parse_configuration(
                    "[providers.openai]\n"
                    'api = "openai-responses"\n'
                    'base_url = "https://api.openai.com/v1"\n'
                    '[models."openai/fixture-model"]\n'
                    f"reasoning = {value!r}\n"
                )
        for value in ("true", 1, 0, "off"):
            with self.subTest(stream=value), self.assertRaises(ConfigurationError):
                parse_configuration(
                    "[providers.openai]\n"
                    'api = "openai-responses"\n'
                    'base_url = "https://api.openai.com/v1"\n'
                    '[models."openai/fixture-model"]\n'
                    f"stream = {value!r}\n"
                )

    def test_browser_configuration_is_independent_and_rejects_legacy_keys(self) -> None:
        self.assertEqual(Configuration().browser, BrowserConfig())
        self.assertEqual(
            set(BrowserConfig.model_fields),
            {
                "model",
                "enabled",
                "profile",
                "max_concurrency",
                "policy_overrides",
            },
        )
        legacy = (
            '[download]\nbrowser_controller = "agent"\n',
            "[download]\nbrowser_enabled = true\n",
            '[download]\nbrowser_profile = "fixture-profile"\n',
            "[download]\nbrowser_max_concurrency = 2\n",
            "[download]\nbrowser_policy_overrides = []\n",
            '[browser]\ncontroller = "agent"\n',
        )
        for payload in legacy:
            with self.subTest(payload=payload), self.assertRaises(ConfigurationError):
                parse_configuration(payload)

    def test_browser_cross_publisher_concurrency_is_unbounded_above_one(self) -> None:
        self.assertEqual(Configuration().browser.max_concurrency, 5)
        self.assertEqual(
            parse_configuration("[browser]\nmax_concurrency = 2\n").browser.max_concurrency,
            2,
        )
        self.assertEqual(
            parse_configuration("[browser]\nmax_concurrency = 128\n").browser.max_concurrency,
            128,
        )

        for value in (1, 0, -1, True, 2.5):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                BrowserConfig(max_concurrency=value)  # type: ignore[arg-type]

    def test_browser_access_selects_an_opaque_profile_without_session_material(self) -> None:
        selected = parse_configuration(
            """
            [browser]
            enabled = true
            profile = "fixture-profile"
            max_concurrency = 3
            """
        )
        self.assertTrue(selected.browser.enabled)
        self.assertEqual(selected.browser.max_concurrency, 3)
        self.assertEqual(selected.browser.policy_overrides, ())
        self.assertEqual(
            set(BrowserConfig.model_fields),
            {
                "model",
                "enabled",
                "profile",
                "max_concurrency",
                "policy_overrides",
            },
        )
        rendered = selected.browser.model_dump_json()
        for forbidden in ("cookie", "local_storage", "profile_path", SENTINEL):
            self.assertNotIn(forbidden.casefold(), rendered.casefold())

        invalid = (
            '[browser]\nprofile = "/tmp/browser-profile"\n',
            '[browser]\nprofile = "../browser-profile"\n',
            '[browser]\nprofile = "https://publisher.example"\n',
            '[browser]\nprofile = "publisher-token"\n',
            '[browser]\nprofile = "a50e8400-e29b-41d4-a716-446655440000"\n',
            "[browser]\nmax_concurrency = 1\n",
            "[browser]\nmax_concurrency = 0\n",
            f'[browser]\ncookie = "{SENTINEL}"\n',
            '[browser]\nprofile_path = "/tmp/profile"\n',
        )
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(ConfigurationError) as caught:
                    parse_configuration(payload)
                self.assertNotIn(SENTINEL, str(caught.exception))

    def test_all_production_browser_probe_targets_are_eligible_without_local_grants(
        self,
    ) -> None:
        selected = parse_configuration('[browser]\nenabled = true\nprofile = "fixture-profile"\n')
        self.assertEqual(
            len(configuration.eligible_production_browser_access_keys(selected.browser)),
            9,
        )
        with self.assertRaises(ConfigurationError) as caught:
            parse_configuration(
                '[download]\nbrowser_machine_access_grants = ["acs-publications"]\n'
            )
        self.assertEqual(str(caught.exception), "configuration section is unknown")

    def test_browser_policy_override_shape_rejects_unknown_duplicate_and_unbounded_values(
        self,
    ) -> None:
        unknown = (
            "[browser]\n"
            "policy_overrides = ["
            '{ rate_limit_group = "unknown-group", minimum_start_interval = 30.0 }'
            "]\n"
        )
        with self.assertRaises(ConfigurationError) as caught:
            parse_configuration(unknown)
        self.assertEqual(str(caught.exception), "browser policy group is unknown")

        invalid = (
            ('[browser]\npolicy_overrides = [{ rate_limit_group = "fixture-group" }]\n'),
            (
                "[browser]\n"
                "policy_overrides = ["
                '{ rate_limit_group = "fixture-group", minimum_start_interval = 10.0 }, '
                '{ rate_limit_group = "fixture-group", failure_cooldown = 10.0 }'
                "]\n"
            ),
            (
                "[browser]\n"
                "policy_overrides = ["
                '{ rate_limit_group = "fixture-group", max_concurrency = 2 }'
                "]\n"
            ),
            (
                "[browser]\n"
                "policy_overrides = ["
                '{ rate_limit_group = "fixture-group", minimum_start_interval = -1.0 }'
                "]\n"
            ),
            (
                "[browser]\n"
                "policy_overrides = ["
                '{ rate_limit_group = "fixture-group", window_seconds = 60.0 }'
                "]\n"
            ),
            (
                "[browser]\n"
                "policy_overrides = ["
                '{ rate_limit_group = "fixture-group", maximum_starts_per_window = 1 }'
                "]\n"
            ),
            (
                "[browser]\n"
                "policy_overrides = ["
                '{ rate_limit_group = "fixture-group", window_seconds = inf, '
                "maximum_starts_per_window = 1 }"
                "]\n"
            ),
            (
                "[browser]\n"
                "policy_overrides = ["
                '{ rate_limit_group = "fixture-group", rate_limit_cooldown = nan }'
                "]\n"
            ),
            (
                "[browser]\n"
                "policy_overrides = ["
                '{ rate_limit_group = "fixture-group", runtime_failure_threshold = 0 }'
                "]\n"
            ),
        )
        for payload in invalid:
            with self.subTest(payload=payload), self.assertRaises(ConfigurationError):
                parse_configuration(payload)

    def test_browser_policy_overrides_can_only_tighten_every_baseline_dimension(self) -> None:
        baseline = BrowserGroupPolicy(
            rate_limit_group="fixture-publisher",
            policy_revision="fixture-r1",
            minimum_start_interval=10.0,
            rate_limit_cooldown=60.0,
            runtime_failure_threshold=3,
            maximum_starts_per_window=4,
            window_seconds=120.0,
            cooldown_after_completion=5.0,
            failure_cooldown=30.0,
        )
        other = BrowserGroupPolicy(
            rate_limit_group="other-publisher",
            policy_revision="other-r1",
            minimum_start_interval=15.0,
            rate_limit_cooldown=90.0,
            runtime_failure_threshold=2,
        )
        access = BrowserConfig(
            policy_overrides=(
                BrowserPolicyOverrideConfig(
                    rate_limit_group="fixture-publisher",
                    max_concurrency=1,
                    minimum_start_interval=20.0,
                    maximum_starts_per_window=2,
                    window_seconds=240.0,
                    cooldown_after_completion=10.0,
                    rate_limit_cooldown=120.0,
                    failure_cooldown=60.0,
                    runtime_failure_threshold=2,
                ),
            )
        )
        policies = tightened_browser_group_policies(
            access,
            {
                baseline.rate_limit_group: baseline,
                other.rate_limit_group: other,
            },
        )
        tightened = policies[baseline.rate_limit_group]
        self.assertEqual(tightened.max_concurrency, 1)
        self.assertEqual(tightened.minimum_start_interval, 20.0)
        self.assertEqual(tightened.maximum_starts_per_window, 2)
        self.assertEqual(tightened.window_seconds, 240.0)
        self.assertEqual(tightened.cooldown_after_completion, 10.0)
        self.assertEqual(tightened.rate_limit_cooldown, 120.0)
        self.assertEqual(tightened.failure_cooldown, 60.0)
        self.assertEqual(tightened.runtime_failure_threshold, 2)
        self.assertIs(policies[other.rate_limit_group], other)
        with self.assertRaises(TypeError):
            cast(dict[str, BrowserGroupPolicy], policies)["replacement"] = baseline

        relaxations = (
            BrowserPolicyOverrideConfig(
                rate_limit_group=baseline.rate_limit_group,
                minimum_start_interval=9.0,
            ),
            BrowserPolicyOverrideConfig(
                rate_limit_group=baseline.rate_limit_group,
                maximum_starts_per_window=5,
                window_seconds=120.0,
            ),
            BrowserPolicyOverrideConfig(
                rate_limit_group=baseline.rate_limit_group,
                maximum_starts_per_window=4,
                window_seconds=60.0,
            ),
            BrowserPolicyOverrideConfig(
                rate_limit_group=baseline.rate_limit_group,
                cooldown_after_completion=4.0,
            ),
            BrowserPolicyOverrideConfig(
                rate_limit_group=baseline.rate_limit_group,
                rate_limit_cooldown=59.0,
            ),
            BrowserPolicyOverrideConfig(
                rate_limit_group=baseline.rate_limit_group,
                failure_cooldown=29.0,
            ),
            BrowserPolicyOverrideConfig(
                rate_limit_group=baseline.rate_limit_group,
                runtime_failure_threshold=4,
            ),
        )
        for override in relaxations:
            with self.subTest(override=override):
                with self.assertRaises(ConfigurationError) as caught:
                    tightened_browser_group_policies(
                        BrowserConfig(policy_overrides=(override,)),
                        {baseline.rate_limit_group: baseline},
                    )
                self.assertEqual(
                    str(caught.exception),
                    "browser policy override would relax the baseline",
                )

        no_window = BrowserGroupPolicy(
            rate_limit_group="windowless-publisher",
            policy_revision="windowless-r1",
            minimum_start_interval=10.0,
            rate_limit_cooldown=60.0,
            runtime_failure_threshold=3,
        )
        introduced = tightened_browser_group_policies(
            BrowserConfig(
                policy_overrides=(
                    BrowserPolicyOverrideConfig(
                        rate_limit_group=no_window.rate_limit_group,
                        maximum_starts_per_window=2,
                        window_seconds=300.0,
                    ),
                )
            ),
            {no_window.rate_limit_group: no_window},
        )[no_window.rate_limit_group]
        self.assertEqual(introduced.maximum_starts_per_window, 2)
        self.assertEqual(introduced.window_seconds, 300.0)

    def test_private_secret_containers_explicitly_reject_pickle_without_leakage(self) -> None:
        selected = parse_configuration(
            """
            [parsing]
            base_url = "https://mineru.example.invalid"
            connection_mode = "remote"
            model_identity = "mineru-3.4.4-vlm"
            remote_upload_authorized = true
            [providers.openai]
            api = "openai-responses"
            base_url = "https://api.openai.com/v1"
            [models."openai/fixture-model"]
            reasoning = "default"
            image = false
            [analyze]
            model = "openai/fixture-model"
            """
        )
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_credentials("web-of-science", {"api_key": SENTINEL}, home=home)
            set_core_credentials(
                CoreCredentialService.MINERU,
                secret=f"mineru-{SENTINEL}",
                origin="https://mineru.example.invalid",
                home=home,
            )
            set_model_provider_credentials(
                "openai",
                secret=f"analysis-{SENTINEL}",
                origin="https://api.openai.com",
                home=home,
            )
            credentials = load_credentials(home=home)
            runtime = load_runtime_secrets(selected, credentials=credentials)

            for container in (runtime, credentials):
                with self.subTest(container=type(container).__name__):
                    with self.assertRaises(TypeError) as caught:
                        pickle.dumps(container)
                    self.assertEqual(str(caught.exception), "secret container is not serializable")
                    self.assertNotIn(SENTINEL, str(caught.exception))
                    self.assertNotIn(SENTINEL, repr(caught.exception))
                    self.assertNotIn(SENTINEL, repr(container))

    def test_runtime_secret_selection_uses_only_requested_core_services(self) -> None:
        selected = parse_configuration(
            """
            [parsing]
            base_url = "https://mineru.example.invalid"
            connection_mode = "remote"
            model_identity = "mineru-3.4.4-vlm"
            remote_upload_authorized = true
            [providers.openai]
            api = "openai-responses"
            base_url = "https://api.openai.com/v1"
            [models."openai/fixture-model"]
            reasoning = "default"
            image = false
            [analyze]
            model = "openai/fixture-model"
            """
        )
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_core_credentials(
                "mineru",
                secret="mineru-secret",
                origin="https://mineru.example.invalid",
                home=home,
            )
            credentials = set_model_provider_credentials(
                "openai",
                secret="analysis-secret",
                origin="https://api.openai.com",
                home=home,
            )
            cases = (
                (True, False, "mineru-secret", None),
                (False, True, None, "analysis-secret"),
                (False, False, None, None),
            )
            for include_parser, include_agents, expected_parser, expected_agents in cases:
                with self.subTest(parser=include_parser, agents=include_agents):
                    runtime = load_runtime_secrets(
                        selected,
                        credentials=credentials,
                        include_parser=include_parser,
                        include_agents=include_agents,
                    )
                    self.assertEqual(runtime.mineru_bearer_token, expected_parser)
                    self.assertEqual(runtime.model_api_key("openai"), expected_agents)

    def test_only_ten_responsibility_groups_are_ordinary_configuration(self) -> None:
        configuration_model = parse_configuration(
            """
            [paths]
            [sources]
            [assets]
            [parsing]
            [providers]
            [models]
            [analyze]
            [execution]
            [library]
            [browser]
            """
        )
        self.assertIsInstance(configuration_model, Configuration)
        self.assertEqual(
            set(Configuration.model_fields),
            {
                "paths",
                "sources",
                "assets",
                "parsing",
                "providers",
                "models",
                "analysis",
                "execution",
                "library",
                "browser",
            },
        )
        self.assertNotIn("credentials", Configuration.model_fields)
        self.assertNotIn("schema_version", Configuration.model_fields)

    def test_unknown_sections_keys_duplicate_toml_and_secret_reference_fail_closed(self) -> None:
        invalid = (
            "[collection]\n",
            "[paths]\nunknown = 1\n",
            "schema_version = 2\n",
            '[analyze]\nsecret_ref = "env:SECRET"\n',
            "[paths]\na = 1\na = 2\n",
        )
        for payload in invalid:
            with self.subTest(payload=payload):
                with self.assertRaises(ConfigurationError) as caught:
                    parse_configuration(payload)
                self.assertNotIn(SENTINEL, str(caught.exception))

    def test_model_provider_urls_and_analysis_budgets_fail_before_runtime(self) -> None:
        valid_analysis = {
            "metadata_max_output_tokens": 512,
            "content_max_output_tokens": 2_048,
            "reference_max_output_tokens": 512,
            "max_input_bytes": 262_144,
            "max_chunk_bytes": 131_072,
            "max_chunk_count": 2,
            "max_total_llm_requests": 4,
            "max_total_output_tokens": 4_096,
        }
        invalid_urls = (
            "http://llm.example.invalid/v1",
            "https://user@llm.example.invalid/v1",
            "https://llm.example.invalid/v1?key=value",
            "https://llm.example.invalid/v1#fragment",
            "https://llm.example.invalid:0443/v1",
            "https://127.0.0.1/v1",
            "https://192.0.2.1/v1",
            "https://llm.example.invalid/v1/../v2",
            "https://llm.example.invalid/v1%2fhidden",
        )
        for base_url in invalid_urls:
            with self.subTest(base_url=base_url), self.assertRaises(ValidationError):
                ModelProviderConfig(
                    name="fixture-provider",
                    api=AgentProtocol.OPENAI_RESPONSES,
                    base_url=base_url,
                )

        invalid_budgets = (
            {"max_chunk_bytes": 262_145},
            {"max_total_llm_requests": 1},
            {"max_total_output_tokens": 2_559},
            {"content_max_output_tokens": 4_097},
        )
        for changes in invalid_budgets:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                AnalysisConfig.model_validate({**valid_analysis, **changes})
        with self.assertRaises(ValidationError):
            Configuration(
                providers=ModelProvidersConfig(
                    values=(
                        ModelProviderConfig(
                            name="fixture-provider",
                            api=AgentProtocol.OPENAI_RESPONSES,
                            base_url="https://llm.example.invalid/v1",
                        ),
                    )
                ),
                models=ModelsConfig(
                    values=(
                        ModelConfig(
                            reference="fixture-provider/fixture-model",
                            image=False,
                        ),
                    )
                ),
                browser=BrowserConfig(model="fixture-provider/fixture-model"),
            )

    def test_agent_model_identity_fails_before_readiness_or_runtime(self) -> None:
        decomposed = "fixture-e\u0301-model"
        self.assertEqual(
            ModelConfig(reference=f"fixture/{decomposed}").model,
            "fixture-\u00e9-model",
        )

        for invalid in (
            "fixture\nforged",
            "fixture\u0085forged",
            "\u754c" * 171,
        ):
            with self.subTest(invalid=invalid[:16]), self.assertRaises(ValidationError):
                ModelConfig(reference=f"fixture/{invalid}")

        exact_byte_limit = "\u754c" * 170 + "ab"
        self.assertEqual(
            ModelConfig(reference=f"fixture/{exact_byte_limit}").model,
            exact_byte_limit,
        )
        with self.assertRaises(ConfigurationError):
            parse_configuration(
                '[providers.fixture]\napi = "openai-responses"\n'
                'base_url = "https://llm.example.invalid/v1"\n'
                '[models."fixture/fixture\\nforged"]\n'
            )

    def test_model_provider_and_mineru_urls_match_adapter_endpoint_policy(self) -> None:
        accepted_providers = (
            {
                "name": "openai",
                "api": "openai-responses",
                "base_url": "https://api.openai.com:8443/v1",
            },
            {
                "name": "anthropic",
                "api": "anthropic-messages",
                "base_url": "https://api.anthropic.com/v1/extra",
            },
            {
                "name": "local",
                "api": "anthropic-messages",
                "base_url": "http://127.0.0.1:1234/v1",
            },
        )
        for payload in accepted_providers:
            with self.subTest(payload=payload):
                provider = ModelProviderConfig.model_validate(payload)
                self.assertEqual(provider.requires_api_key, provider.name != "local")

        parser_cases = (
            {
                "base_url": "https://192.0.2.1",
                "connection_mode": "remote",
                "model_identity": "mineru-3.4.4-vlm",
                "remote_upload_authorized": True,
            },
            {
                "base_url": "https://mineru.example.invalid?token=value",
                "connection_mode": "remote",
                "model_identity": "mineru-3.4.4-vlm",
                "remote_upload_authorized": True,
            },
            {
                "base_url": "http://localhost:8000",
                "connection_mode": "loopback",
                "model_identity": "mineru-3.4.4-vlm",
                "remote_upload_authorized": True,
            },
        )
        for payload in parser_cases:
            with self.subTest(payload=payload), self.assertRaises(ValidationError):
                ParsingConfig(**payload)

    def test_model_contracts_are_frozen_and_secret_free(self) -> None:
        model = parse_configuration("[paths]\n")
        with self.assertRaises(ValidationError):
            model.paths = model.paths  # type: ignore[misc]
        self.assertNotIn(SENTINEL, repr(model))
        self.assertNotIn(SENTINEL, model.model_dump_json())
        self.assertNotIn(
            "CredentialsConfig",
            vars(__import__("sciretriever.model.configuration", fromlist=["configuration"])),
        )


class CredentialStatusTests(unittest.TestCase):
    def test_interactive_set_catalog_exposes_only_current_credential_contracts(self) -> None:
        self.assertEqual(
            tuple(provider.value for provider in configurable_credential_providers()),
            (
                "web-of-science",
                "semantic-scholar",
                "openalex",
                "elsevier",
                "springer",
                "core",
                "opencitations",
                "wiley",
            ),
        )
        self.assertEqual(
            tuple(field.name for field in credential_field_specs("springer")),
            ("api_key",),
        )
        self.assertEqual(
            tuple(field.name for field in credential_field_specs("wiley")),
            ("tdm_api_token",),
        )
        self.assertEqual(credential_field_specs("crossref"), ())

    def test_provider_matrix_and_exact_status_vocabulary(self) -> None:
        expected = {
            "web-of-science": ("metadata",),
            "crossref": ("metadata", "acquisition"),
            "semantic-scholar": ("metadata", "acquisition"),
            "arxiv": ("metadata", "acquisition"),
            "openalex": ("metadata", "acquisition"),
            "europe-pmc": ("metadata", "acquisition"),
            "elsevier": ("metadata", "acquisition"),
            "springer": ("metadata", "acquisition"),
            "datacite": ("metadata", "acquisition"),
            "core": ("metadata", "acquisition"),
            "opencitations": ("metadata",),
            "unpaywall": ("acquisition",),
            "wiley": ("acquisition",),
            "sci-hub": ("acquisition",),
        }
        with tempfile.TemporaryDirectory() as temporary:
            credentials = load_credentials(home=Path(temporary))
        with mock.patch.object(
            configuration,
            "load_credentials",
            side_effect=AssertionError("offline status must not read default credentials"),
        ):
            for provider, capabilities in expected.items():
                diagnostic = credential_diagnostic(
                    provider,
                    credentials=credentials,
                    supported_capabilities=capabilities,
                )
                self.assertEqual(
                    tuple(item.capability.value for item in diagnostic.capabilities), capabilities
                )
                for item in diagnostic.capabilities:
                    self.assertIn(item.status, tuple(CredentialStatus))
            self.assertEqual(
                credential_status_for(
                    "web-of-science",
                    "metadata",
                    credentials=credentials,
                    supported_capabilities=(ProviderCapability.METADATA,),
                ).status,
                CredentialStatus.MISSING,
            )
            self.assertEqual(
                credential_status_for(
                    "semantic-scholar",
                    "metadata",
                    credentials=credentials,
                    supported_capabilities=("metadata",),
                ).status,
                CredentialStatus.OPTIONAL_MISSING,
            )
            self.assertEqual(
                credential_status_for(
                    "crossref",
                    "metadata",
                    credentials=credentials,
                    supported_capabilities=("metadata",),
                ).status,
                CredentialStatus.NOT_REQUIRED,
            )
            self.assertEqual(
                credential_status_for(
                    "wiley",
                    "acquisition",
                    credentials=credentials,
                    supported_capabilities=("acquisition",),
                ).status,
                CredentialStatus.MISSING,
            )
            with self.assertRaises(ConfigurationError):
                credential_status_for(
                    "web-of-science",
                    "acquisition",
                    credentials=credentials,
                    supported_capabilities=("acquisition",),
                )
            self.assertEqual(
                credential_status_for(
                    "sci-hub",
                    "acquisition",
                    credentials=credentials,
                    supported_capabilities=("acquisition",),
                ).status,
                CredentialStatus.NOT_REQUIRED,
            )
            self.assertEqual(
                credential_status_for(
                    "web-of-science",
                    "metadata",
                    credentials=credentials,
                ).status,
                CredentialStatus.UNSUPPORTED,
            )
            with self.assertRaises(ConfigurationError):
                credential_diagnostic(
                    "web-of-science",
                    credentials=credentials,
                    supported_capabilities=("acquisition",),
                )
            with self.assertRaises(ConfigurationError):
                credential_status_for(
                    "web-of-science",
                    "metadata",
                    credentials=credentials,
                    supported_capabilities=("metadata", "acquisition"),
                )

    def test_configured_partial_and_optional_missing_statuses_have_presence_only(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_credentials("web-of-science", {"api_key": SENTINEL}, home=home)
            status = credential_status_for(
                "web-of-science", "metadata", home=home, supported_capabilities=("metadata",)
            )
            self.assertEqual(status.status, CredentialStatus.CONFIGURED)
            self.assertEqual(status.fields[0].present, True)
            self.assertNotIn(SENTINEL, repr(status))
            self.assertNotIn(SENTINEL, status.model_dump_json())

            set_credentials("elsevier", {"api_key": SENTINEL}, home=home)
            status = credential_status_for(
                "elsevier", "metadata", home=home, supported_capabilities=("metadata",)
            )
            self.assertEqual(status.status, CredentialStatus.OPTIONAL_MISSING)
            self.assertEqual(
                tuple(field.name for field in status.fields),
                ("api_key", "institution_token"),
            )

            set_credentials("elsevier", {"institution_token": "institution"}, home=home)
            status = credential_status_for(
                "elsevier", "metadata", home=home, supported_capabilities=("metadata",)
            )
            self.assertEqual(status.status, CredentialStatus.PARTIAL)

            springer = credential_diagnostic(
                "springer",
                home=home,
                supported_capabilities=("metadata", "acquisition"),
            )
            self.assertEqual(
                tuple(field.name for field in springer.capabilities[0].fields),
                ("api_key",),
            )
            self.assertEqual(springer.capabilities[1].status, CredentialStatus.UNSUPPORTED)


class CredentialFileSecurityTests(unittest.TestCase):
    def _secure_dir(self, home: Path) -> Path:
        directory = home / ".sciretriever"
        directory.mkdir(mode=0o700)
        os.chmod(directory, 0o700)
        return directory

    def _write(self, home: Path, payload: bytes) -> Path:
        directory = self._secure_dir(home)
        path = directory / "credentials.toml"
        path.write_bytes(payload)
        os.chmod(path, 0o600)
        return path

    def test_fixed_path_and_missing_file_do_not_read_an_arbitrary_credentials_path(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            self.assertEqual(path, home / ".sciretriever" / "credentials.toml")
            self.assertEqual(load_credentials(home=home).field_names("web-of-science"), ())
            self.assertEqual(path.name, "credentials.toml")

    def test_credential_section_presence_is_secret_free_and_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            self.assertIs(credential_section_exists("web-of-science", home=home), False)
            set_credentials("web-of-science", {"api_key": SENTINEL}, home=home)
            present = credential_section_exists("web-of-science", home=home)
            self.assertIs(present, True)
            self.assertNotIn(SENTINEL, repr(present))

            for provider in ("crossref", "sci-hub"):
                with self.subTest(provider=provider):
                    with self.assertRaises(ConfigurationError) as caught:
                        credential_section_exists(provider, home=home)
                    self.assertEqual(str(caught.exception), "credentials provider is unsupported")
            self.assertIs(credential_section_exists("wiley", home=home), False)

            os.chmod(credential_path(home=home), 0o644)
            with self.assertRaises(ConfigurationError) as caught:
                credential_section_exists("web-of-science", home=home)
            self.assertEqual(
                str(caught.exception),
                "credentials file has unsafe ownership or permissions",
            )

    def test_credential_section_presence_does_not_construct_network_or_storage(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            with (
                mock.patch(
                    "sciretriever.network.http.HttpClient",
                    side_effect=AssertionError("credential presence must not construct Network"),
                ),
                mock.patch(
                    "sciretriever.storage.sqlite.engine.CatalogEngine",
                    side_effect=AssertionError("credential presence must not construct Storage"),
                ),
            ):
                self.assertFalse(credential_section_exists("elsevier", home=home))

    def test_directory_and_file_owner_mode_regular_nofollow_and_single_link(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = self._write(home, b'[web-of-science]\napi_key = "value"\n')
            self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertEqual(path.stat().st_nlink, 1)
            self.assertEqual(load_credentials(home=home).get("web-of-science", "api_key"), "value")

            os.chmod(path.parent, 0o755)
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)
            os.chmod(path.parent, 0o700)
            os.chmod(path, 0o644)
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)

    def test_symlink_directory_file_and_hardlink_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir()
            target = root / "target"
            target.mkdir()
            (home / ".sciretriever").symlink_to(target, target_is_directory=True)
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)

            (home / ".sciretriever").unlink()
            directory = self._secure_dir(home)
            real = root / "real.toml"
            real.write_text('[web-of-science]\napi_key = "value"\n', encoding="utf-8")
            os.chmod(real, 0o600)
            (directory / "credentials.toml").symlink_to(real)
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)

            (directory / "credentials.toml").unlink()
            path = directory / "credentials.toml"
            path.write_text('[web-of-science]\napi_key = "value"\n', encoding="utf-8")
            os.chmod(path, 0o600)
            os.link(path, root / "hardlink.toml")
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)

    def test_wrong_owner_is_fail_closed_without_reading_values(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            self._write(home, f'[web-of-science]\napi_key = "{SENTINEL}"\n'.encode())
            with mock.patch.object(
                credentials_module,
                "_current_uid",
                return_value=os.getuid() + 1,
            ):
                with self.assertRaises(ConfigurationError) as caught:
                    load_credentials(home=home)
            self.assertNotIn(SENTINEL, str(caught.exception))

    def test_bounded_read_and_duplicate_unknown_empty_non_string_toml_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = self._write(home, b"x" * (_MAX_CREDENTIALS_BYTES + 1))
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)
            path.write_text('[unknown]\napi_key = "value"\n', encoding="utf-8")
            os.chmod(path, 0o600)
            with self.assertRaises(ConfigurationError):
                load_credentials(home=home)
            for payload in (
                '[web-of-science]\nother = "value"\n',
                '[web-of-science]\napi_key = ""\n',
                "[web-of-science]\napi_key = 1\n",
                '[web-of-science]\napi_key = "a"\napi_key = "b"\n',
                '[wiley]\napi_key = "value"\n',
                '[agents]\napi_key = "value"\norigin = "https://api.openai.com"\n',
            ):
                path.write_text(payload, encoding="utf-8")
                os.chmod(path, 0o600)
                with self.subTest(payload=payload):
                    with self.assertRaises(ConfigurationError) as caught:
                        load_credentials(home=home)
                    self.assertNotIn(SENTINEL, str(caught.exception))


class CredentialPublicationTests(unittest.TestCase):
    def test_set_remove_are_atomic_and_keep_providers_separate(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            set_credentials("web-of-science", {"api_key": SENTINEL}, home=home)
            original = credential_path(home=home).read_bytes()
            set_credentials("elsevier", {"api_key": "elsevier"}, home=home)
            self.assertIn(b"web-of-science", credential_path(home=home).read_bytes())
            remove_credentials("web-of-science", home=home)
            payload = credential_path(home=home).read_bytes()
            self.assertNotIn(SENTINEL.encode(), payload)
            self.assertIn(b"elsevier", payload)
            self.assertEqual(
                remove_credentials("web-of-science", home=home).field_names("web-of-science"), ()
            )
            self.assertNotEqual(original, payload)

    def test_wiley_tdm_token_has_one_private_set_remove_contract(self) -> None:
        token = "12345678-1234-4234-9234-123456789abc"
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            returned = set_credentials("wiley", {"tdm_api_token": token}, home=home)
            self.assertEqual(returned.field_names("wiley"), ("tdm_api_token",))
            self.assertEqual(returned.get("wiley", "tdm_api_token"), token)
            self.assertNotIn(token, repr(returned))
            removed = remove_credentials("wiley", home=home)
            self.assertEqual(removed.field_names("wiley"), ())
            self.assertNotIn(b"wiley", credential_path(home=home).read_bytes())

    def test_each_prepublication_failure_keeps_old_bytes_and_cleans_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            set_credentials("web-of-science", {"api_key": "old"}, home=home)
            old = path.read_bytes()
            for fail_name in (
                "staging-created",
                "staging-written",
                "staging-fsynced",
                "staging-validated",
                "before-replace",
            ):

                def failpoint(name: str, expected: str = fail_name) -> None:
                    if name == expected:
                        raise RuntimeError("publication fault")

                with self.subTest(fail_name=fail_name):
                    with self.assertRaises(ConfigurationError):
                        set_credentials(
                            "web-of-science",
                            {"api_key": SENTINEL},
                            home=home,
                            failpoint=failpoint,
                        )
                    self.assertEqual(path.read_bytes(), old)
                    self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())

    def test_replacement_race_is_detected_before_atomic_replace(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            set_credentials("web-of-science", {"api_key": "old"}, home=home)
            old = path.read_bytes()

            def replace_before_publish(name: str) -> None:
                if name == "staging-validated":
                    replacement = path.with_name("replacement.toml")
                    replacement.write_bytes(b'[web-of-science]\napi_key = "other"\n')
                    os.chmod(replacement, 0o600)
                    os.replace(replacement, path)

            with self.assertRaises(ConfigurationError):
                set_credentials(
                    "web-of-science",
                    {"api_key": SENTINEL},
                    home=home,
                    failpoint=replace_before_publish,
                )
            self.assertNotEqual(path.read_bytes(), old)
            self.assertNotIn(SENTINEL.encode(), path.read_bytes())
            self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())

    def test_after_commit_injection_returns_complete_new_file_without_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            set_credentials("web-of-science", {"api_key": "old"}, home=home)

            def fail_after_replace(name: str) -> None:
                if name == "after-replace":
                    raise RuntimeError("post-publication fault")

            returned = set_credentials(
                "web-of-science",
                {"api_key": SENTINEL},
                home=home,
                failpoint=fail_after_replace,
            )
            self.assertEqual(returned.get("web-of-science", "api_key"), SENTINEL)
            self.assertEqual(
                path.read_bytes(), f'[web-of-science]\napi_key = "{SENTINEL}"\n\n'.encode()
            )
            self.assertNotIn(SENTINEL, repr(returned))
            self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())
            self.assertEqual(tuple(path.parent.glob("*.bak")), ())

    def test_directory_fsync_is_attempted_after_commit(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            set_credentials("web-of-science", {"api_key": "old"}, home=home)
            events: list[str] = []

            def observe(name: str) -> None:
                events.append(name)

            set_credentials(
                "web-of-science",
                {"api_key": SENTINEL},
                home=home,
                failpoint=observe,
            )
            self.assertIn("before-directory-fsync", events)
            self.assertIn("directory-fsynced", events)
            self.assertEqual(
                path.read_bytes(), f'[web-of-science]\napi_key = "{SENTINEL}"\n\n'.encode()
            )
            self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())
            self.assertEqual(tuple(path.parent.glob("*.bak")), ())

    def test_directory_fsync_failure_after_commit_does_not_report_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            path = credential_path(home=home)
            set_credentials("web-of-science", {"api_key": "old"}, home=home)
            real_fsync = os.fsync

            def fail_directory_fsync(descriptor: int) -> None:
                if stat.S_ISDIR(os.fstat(descriptor).st_mode):
                    raise OSError("directory fsync fault")
                real_fsync(descriptor)

            with mock.patch.object(
                credential_edits_module.os,
                "fsync",
                side_effect=fail_directory_fsync,
            ):
                returned = set_credentials(
                    "web-of-science",
                    {"api_key": SENTINEL},
                    home=home,
                )

            self.assertEqual(returned.get("web-of-science", "api_key"), SENTINEL)
            self.assertEqual(
                path.read_bytes(), f'[web-of-science]\napi_key = "{SENTINEL}"\n\n'.encode()
            )
            self.assertEqual(tuple(path.parent.glob(".credentials-*.staging")), ())
            self.assertEqual(tuple(path.parent.glob("*.bak")), ())


if __name__ == "__main__":
    unittest.main()
