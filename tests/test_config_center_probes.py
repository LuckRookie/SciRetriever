from __future__ import annotations

import unittest
from types import SimpleNamespace
from typing import cast
from unittest.mock import Mock, patch

from sciretriever.configuration import ConfigurationError
from sciretriever.entry.cli.config_center import probes
from sciretriever.model.configuration import (
    AgentConfigurationProbeDetails,
    AgentProtocol,
    AgentReasoningEffort,
    BrowserConfig,
    Configuration,
    ConfigurationProbeResult,
    ConfigurationProbeSummary,
    CoreConfigurationProbeFailureEvidence,
    CoreConfigurationProbeResult,
    MinerUConfigurationProbeDetails,
    ModelConfigurationProbeDetails,
    ProbeOutcome,
    ProviderCapability,
    ProviderName,
)


def _source_pass() -> ConfigurationProbeSummary:
    return ConfigurationProbeSummary(
        results=(
            ConfigurationProbeResult(
                provider=ProviderName.CROSSREF,
                capability=ProviderCapability.METADATA,
                outcome=ProbeOutcome.PASSED,
                local_ready=True,
                network_reachable=True,
                authentication_accepted=True,
                api_product_usable=True,
                minimal_response_parseable=True,
            ),
        )
    )


def _download_unavailable() -> ConfigurationProbeSummary:
    return ConfigurationProbeSummary(
        results=(
            ConfigurationProbeResult(
                provider=ProviderName.CROSSREF,
                capability=ProviderCapability.ACQUISITION,
                outcome=ProbeOutcome.SKIPPED,
                local_ready=False,
                failure_code="acquisition-probe-unavailable",
            ),
        )
    )


def _download_not_ready() -> ConfigurationProbeSummary:
    return ConfigurationProbeSummary(
        results=(
            ConfigurationProbeResult(
                provider=ProviderName.CORE,
                capability=ProviderCapability.ACQUISITION,
                outcome=ProbeOutcome.SKIPPED,
                local_ready=False,
                failure_code="missing-required-credential",
            ),
        )
    )


def _analysis_pass() -> CoreConfigurationProbeResult:
    return CoreConfigurationProbeResult(
        service="agents",
        outcome=ProbeOutcome.PASSED,
        local_ready=True,
        details=AgentConfigurationProbeDetails(strict_response_parseable=True),
    )


def _mineru_pass() -> CoreConfigurationProbeResult:
    return CoreConfigurationProbeResult(
        service="mineru",
        outcome=ProbeOutcome.PASSED,
        local_ready=True,
        details=MinerUConfigurationProbeDetails(
            health="healthy",
            release="3.4.4",
            api_protocol=2,
        ),
    )


def _browser_model_skip() -> CoreConfigurationProbeResult:
    return CoreConfigurationProbeResult(
        service="agents",
        outcome=ProbeOutcome.SKIPPED,
        local_ready=False,
        failure_code="browser-agent-not-ready",
        details=AgentConfigurationProbeDetails(
            role="browser-agent",
            request_kind="browser-agent-tool",
            image_input=True,
            tool_decision=True,
            image_count=1,
            tool_count=1,
        ),
    )


class ConfigurationTestRequestTests(unittest.TestCase):
    def test_request_shape_rejects_ambiguous_targets(self) -> None:
        invalid = (
            {"owner": "provider"},
            {"owner": "search"},
            {"owner": "search", "target": "crossref", "all_targets": True},
            {"owner": "analyze", "image_input": True},
            {"owner": "all", "all_targets": True},
        )
        for values in invalid:
            with self.subTest(values=values), self.assertRaises(ValueError):
                probes.ConfigurationTestRequest(**values)  # type: ignore[arg-type]

    def test_confirmation_text_discloses_the_external_boundary(self) -> None:
        download = probes.confirmation_message(
            probes.ConfigurationTestRequest(owner="download", target="crossref")
        )
        global_all = probes.confirmation_message(probes.ConfigurationTestRequest(owner="all"))
        site = probes.confirmation_message(
            probes.ConfigurationTestRequest(owner="browser-site", target="springerlink")
        )

        self.assertIsNone(download)
        self.assertIn("PDF download", global_all or "")
        self.assertIn("approved minimal site target", site or "")


class ConfigurationTestExecutionTests(unittest.TestCase):
    def test_payload_mapping_adds_compact_machine_diagnosis_with_request_identity(
        self,
    ) -> None:
        payload = CoreConfigurationProbeResult(
            service="agents",
            outcome=ProbeOutcome.FAILED,
            local_ready=True,
            failure_code="agent-not-found",
            failure_evidence=CoreConfigurationProbeFailureEvidence(http_status=404),
            details=ModelConfigurationProbeDetails(
                request_kind="model-text",
                reference="main/probe-model",
                provider="main",
                model="probe-model",
                protocol=AgentProtocol.OPENAI_RESPONSES,
                reasoning=AgentReasoningEffort.MAX,
                stream=True,
                image_input=False,
                request_url="https://models.example/v1/responses",
            ),
        )

        result = probes.payload_mapping(payload)

        diagnosis = cast(dict[str, object], result["diagnosis"])
        self.assertEqual(
            diagnosis["request"],
            "POST https://models.example/v1/responses\nStream · on",
        )
        self.assertIn("Model or API endpoint", cast(str, diagnosis["reason"]))
        self.assertIn("Model name", cast(str, diagnosis["action"]))

    def test_model_failure_diagnoses_remote_and_connection_layers_from_safe_evidence(
        self,
    ) -> None:
        cases = (
            (400, None, "Provider rejected the Model request", "Model name"),
            (401, None, "did not accept the API Key", "Replace the Key"),
            (404, None, "Model or API endpoint was not found", "exact Model name"),
            (429, None, "rate limit or quota was reached", "limit to reset"),
            (None, "transport", "could not be established", "DNS"),
        )
        for status, access_code, reason, action in cases:
            with self.subTest(status=status, access_code=access_code):
                payload = CoreConfigurationProbeResult(
                    service="agents",
                    outcome=ProbeOutcome.FAILED,
                    local_ready=True,
                    failure_code="agent-access",
                    failure_evidence=CoreConfigurationProbeFailureEvidence(
                        http_status=status,
                        access_code=access_code,
                    ),
                    details=ModelConfigurationProbeDetails(
                        request_kind="model-text",
                        reference="main/probe-model",
                        provider="main",
                        model="probe-model",
                        protocol=AgentProtocol.OPENAI_RESPONSES,
                        reasoning=AgentReasoningEffort.MAX,
                        stream=True,
                        image_input=False,
                        request_url="https://models.example/v1/responses",
                    ),
                )

                result = probes.payload_mapping(payload)

                diagnosis = cast(dict[str, object], result["diagnosis"])
                self.assertEqual(
                    diagnosis["request"],
                    "POST https://models.example/v1/responses\nStream · on",
                )
                self.assertIn(reason, cast(str, diagnosis["reason"]))
                self.assertIn(action, cast(str, diagnosis["action"]))

    def test_model_contract_failure_keeps_request_identity_without_remote_text(self) -> None:
        payload = CoreConfigurationProbeResult(
            service="agents",
            outcome=ProbeOutcome.FAILED,
            local_ready=True,
            failure_code="agent-protocol",
            details=ModelConfigurationProbeDetails(
                request_kind="model-text",
                reference="main/probe-model",
                provider="main",
                model="probe-model",
                protocol=AgentProtocol.OPENAI_RESPONSES,
                reasoning=AgentReasoningEffort.MAX,
                stream=False,
                image_input=False,
                request_url="https://models.example/v1/responses",
            ),
        )

        diagnosis = cast(dict[str, object], probes.payload_mapping(payload)["diagnosis"])

        self.assertEqual(
            diagnosis["request"],
            "POST https://models.example/v1/responses\nStream · off",
        )
        self.assertIn("response did not match", cast(str, diagnosis["reason"]))
        self.assertIn("API type and exact Model name", cast(str, diagnosis["action"]))

    def test_probe_request_identity_rejects_userinfo_query_and_fragment(self) -> None:
        for request_url in (
            "https://user:secret@models.example/v1/responses",
            "https://models.example/v1/responses?api_key=secret",
            "https://models.example/v1/responses#secret",
        ):
            with self.subTest(request_url=request_url), self.assertRaises(ValueError):
                ModelConfigurationProbeDetails(
                    request_kind="model-text",
                    reference="main/probe-model",
                    provider="main",
                    model="probe-model",
                    protocol=AgentProtocol.OPENAI_RESPONSES,
                    reasoning=AgentReasoningEffort.MAX,
                    stream=True,
                    image_input=False,
                    request_url=request_url,
                )

    def test_exact_download_reports_unavailable_and_never_uses_metadata_probe(self) -> None:
        session = Mock()
        session.configuration = Configuration()
        session.status.capabilities = (
            SimpleNamespace(
                provider=ProviderName.CROSSREF,
                capability=ProviderCapability.ACQUISITION,
            ),
        )
        session.run_acquisition.return_value = _download_unavailable()
        with (
            patch.object(probes, "load_user_configuration", return_value=Configuration()),
            patch.object(
                probes,
                "build_production_configuration_probe_session",
                return_value=session,
            ),
        ):
            execution = probes.execute_configuration_test(
                probes.ConfigurationTestRequest(owner="download", target="crossref")
            )

        self.assertFalse(execution.passed)
        session.run_acquisition.assert_called_once_with(
            provider=ProviderName.CROSSREF,
            test_all=False,
        )
        session.run.assert_not_called()
        session.close.assert_called_once_with()

    def test_unknown_registry_target_fails_before_building_a_session(self) -> None:
        with (
            patch.object(probes, "load_user_configuration", return_value=Configuration()),
            patch.object(probes, "build_production_configuration_probe_session") as build,
            self.assertRaises(ConfigurationError),
        ):
            probes.execute_configuration_test(
                probes.ConfigurationTestRequest(owner="provider", target="unknown")
            )
        build.assert_not_called()

    def test_global_all_reports_download_limit_without_treating_it_as_probe_failure(
        self,
    ) -> None:
        session = Mock()
        session.configuration = Configuration()
        session.run.return_value = _source_pass()
        session.run_acquisition.return_value = _download_unavailable()
        session.run_agents.return_value = _analysis_pass()
        session.run_mineru.return_value = _mineru_pass()

        payload, passed = probes._run_all(session)

        self.assertTrue(passed)
        download = cast(dict[str, object], payload["download"])
        results = cast(list[dict[str, object]], download["results"])
        self.assertEqual(results[0]["failure_code"], "acquisition-probe-unavailable")
        self.assertNotIn("browser", payload)
        session.run_browser_agent.assert_not_called()

    def test_global_all_requires_browser_model_when_browser_is_enabled(self) -> None:
        session = Mock()
        session.configuration = Configuration(
            browser=BrowserConfig(enabled=True, profile="fixture-profile")
        )
        session.run.return_value = _source_pass()
        session.run_acquisition.return_value = _download_unavailable()
        session.run_agents.return_value = _analysis_pass()
        session.run_mineru.return_value = _mineru_pass()
        session.run_browser_agent.return_value = _browser_model_skip()

        payload, passed = probes._run_all(session)

        self.assertFalse(passed)
        browser = cast(dict[str, object], payload["browser"])
        self.assertEqual(browser["outcome"], "skipped")
        session.run_browser_agent.assert_called_once_with()

    def test_global_all_fails_for_a_real_download_readiness_failure(self) -> None:
        session = Mock()
        session.configuration = Configuration()
        session.run.return_value = _source_pass()
        session.run_acquisition.return_value = _download_not_ready()
        session.run_agents.return_value = _analysis_pass()
        session.run_mineru.return_value = _mineru_pass()

        _payload, passed = probes._run_all(session)

        self.assertFalse(passed)


if __name__ == "__main__":
    unittest.main()
