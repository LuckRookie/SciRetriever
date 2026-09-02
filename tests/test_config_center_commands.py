from __future__ import annotations

import argparse
import io
import json
import unittest
from contextlib import redirect_stderr, redirect_stdout
from unittest.mock import patch

from sciretriever.entry.cli.config_center import commands
from sciretriever.entry.cli.config_center.probes import ConfigurationTestExecution
from sciretriever.model.configuration import (
    AgentConfigurationProbeDetails,
    CoreConfigurationProbeResult,
    ProbeOutcome,
)


def _arguments(**updates: object) -> argparse.Namespace:
    values: dict[str, object] = {
        "action": "test",
        "browser_test_target": None,
        "debug": False,
        "json": True,
        "target": None,
        "test_area_all": False,
        "test_global_all": False,
        "test_image": False,
        "test_owner": "parse",
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

    def test_structured_targets_map_to_one_owner_scoped_request(self) -> None:
        cases = (
            (_arguments(test_global_all=True, test_owner=None), ("all", None, False, False)),
            (_arguments(test_owner="provider", target="main"), ("provider", "main", False, False)),
            (
                _arguments(test_owner="model", target="main/model", test_image=True),
                ("model", "main/model", False, True),
            ),
            (
                _arguments(test_owner="search", target="crossref"),
                ("search", "crossref", False, False),
            ),
            (
                _arguments(test_owner="search", test_area_all=True),
                ("search", None, True, False),
            ),
            (
                _arguments(test_owner="download", target="sci-hub"),
                ("download", "sci-hub", False, False),
            ),
            (_arguments(test_owner="parse"), ("parse", None, False, False)),
            (_arguments(test_owner="analyze"), ("analyze", None, False, False)),
            (
                _arguments(test_owner="browser", browser_test_target="model"),
                ("browser-model", None, False, False),
            ),
            (
                _arguments(
                    test_owner="browser",
                    browser_test_target="site",
                    target="springerlink",
                ),
                ("browser-site", "springerlink", False, False),
            ),
        )
        for arguments, expected in cases:
            with self.subTest(expected=expected):
                request = commands._test_request(arguments)
                self.assertEqual(
                    (
                        request.owner,
                        request.target,
                        request.all_targets,
                        request.image_input,
                    ),
                    expected,
                )

    def test_human_probe_requires_confirmation_before_execution(self) -> None:
        arguments = _arguments(test_owner="analyze", json=False)
        with (
            patch.object(commands, "confirm", return_value=False) as confirm,
            patch.object(commands, "execute_configuration_test") as execute,
            redirect_stderr(io.StringIO()) as error,
        ):
            result = commands._run_test(arguments)

        self.assertEqual(result, 0)
        self.assertIn("minimal strict-schema request", confirm.call_args.args[0])
        self.assertIn("cancelled", error.getvalue())
        execute.assert_not_called()

    def test_json_probe_is_machine_readable_and_uses_execution_exit_status(self) -> None:
        execution = ConfigurationTestExecution(payload=_agent_pass(), passed=False)
        arguments = _arguments(test_owner="analyze", json=True)
        with (
            patch.object(commands, "confirm") as confirm,
            patch.object(commands, "execute_configuration_test", return_value=execution),
            redirect_stdout(io.StringIO()) as output,
        ):
            result = commands._run_test(arguments)

        self.assertEqual(result, 3)
        self.assertEqual(json.loads(output.getvalue())["outcome"], "passed")
        confirm.assert_not_called()


if __name__ == "__main__":
    unittest.main()
