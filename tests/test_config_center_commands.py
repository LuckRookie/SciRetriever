from __future__ import annotations

import argparse
import io
import json
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

from sciretriever.entry.cli.config_center import commands
from sciretriever.model.configuration import (
    AccessConfig,
    AgentConfigurationProbeDetails,
    BrowserController,
    Configuration,
    ConfigurationProbeSummary,
    CoreConfigurationProbeResult,
    MinerUConfigurationProbeDetails,
    ProbeOutcome,
)


def _arguments(**updates: object) -> argparse.Namespace:
    values: dict[str, object] = {
        "browser_access_key": None,
        "provider": None,
        "test_all": False,
        "json": True,
        "theme": "mono",
    }
    values.update(updates)
    return argparse.Namespace(**values)


def _agent_pass() -> CoreConfigurationProbeResult:
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


class ConfigurationCommandTests(unittest.TestCase):
    def test_run_config_dispatches_manager_status_and_test_without_main_private_bridges(
        self,
    ) -> None:
        base = {"debug": False, "theme": "mono"}
        with (
            patch.object(commands, "run_config_manager", return_value=11) as manager,
            patch.object(commands, "run_status", return_value=12) as status,
            patch.object(commands, "_run_test", return_value=13) as test,
        ):
            self.assertEqual(commands.run_config(argparse.Namespace(action=None, **base)), 11)
            self.assertEqual(commands.run_config(argparse.Namespace(action="status", **base)), 12)
            self.assertEqual(commands.run_config(argparse.Namespace(action="test", **base)), 13)

        manager.assert_called_once_with("mono")
        status.assert_called_once()
        test.assert_called_once()

    def test_all_rules_controller_does_not_probe_unused_browser_model(self) -> None:
        session = Mock()
        session.configuration = Configuration()
        session.run.return_value = ConfigurationProbeSummary(results=())
        session.run_agents.return_value = _agent_pass()
        session.run_mineru.return_value = _mineru_pass()
        with redirect_stdout(io.StringIO()) as output:
            result = commands._run_test_session(_arguments(test_all=True), session)

        self.assertEqual(result, 0)
        self.assertNotIn("browser-agent", json.loads(output.getvalue()))
        session.run_browser_agent.assert_not_called()

    def test_all_agent_controller_requires_browser_model_probe_to_pass(self) -> None:
        session = Mock()
        session.configuration = Configuration(
            download=AccessConfig(browser_controller=BrowserController.AGENT)
        )
        session.run.return_value = ConfigurationProbeSummary(results=())
        session.run_agents.return_value = _agent_pass()
        session.run_mineru.return_value = _mineru_pass()
        session.run_browser_agent.return_value = CoreConfigurationProbeResult(
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
        with redirect_stdout(io.StringIO()) as output:
            result = commands._run_test_session(_arguments(test_all=True), session)

        payload = json.loads(output.getvalue())
        self.assertEqual(result, 3)
        self.assertEqual(payload["browser-agent"]["outcome"], "skipped")
        session.run_browser_agent.assert_called_once_with()

    def test_human_browser_probe_requires_explicit_confirmation(self) -> None:
        session = Mock()
        arguments = _arguments(
            browser_access_key="springerlink",
            json=False,
        )
        with patch.object(commands, "confirm", return_value=False) as confirm:
            result = commands._run_test_session(arguments, session)

        self.assertEqual(result, 0)
        prompt = confirm.call_args.args[0]
        self.assertIn("starts one controlled headed Browser", prompt)
        self.assertIn("does not prove institution-IP or article entitlement", prompt)
        session.run_browser.assert_not_called()


if __name__ == "__main__":
    unittest.main()
