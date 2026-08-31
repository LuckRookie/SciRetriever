from __future__ import annotations

import argparse
import io
import json
import unittest
from contextlib import redirect_stdout
from types import SimpleNamespace
from unittest.mock import Mock, patch

from sciretriever.acquisition.api import BUILTIN_SCI_HUB_MIRROR_URLS
from sciretriever.entry.cli.config_center import status
from sciretriever.model.configuration import Configuration


class ConfigurationStatusTests(unittest.TestCase):
    def test_sci_hub_status_distinguishes_builtin_and_custom_mirrors(self) -> None:
        builtin = status.ordinary_provider_settings(Configuration(), "sci-hub")
        custom_configuration = Configuration.model_validate(
            {
                "sources": {
                    "acquisition": {
                        "mode": "custom",
                        "providers": [],
                        "sci-hub": {"urls": ["https://mirror.example.invalid"]},
                    }
                }
            }
        )
        custom = status.ordinary_provider_settings(custom_configuration, "sci-hub")

        self.assertEqual(builtin["mode"], "builtin")
        self.assertEqual(builtin["urls"], list(BUILTIN_SCI_HUB_MIRROR_URLS))
        self.assertEqual(
            custom,
            {"mode": "custom", "urls": ["https://mirror.example.invalid"]},
        )

    def test_json_status_uses_local_owner_boundaries_and_one_payload(self) -> None:
        arguments = argparse.Namespace(json=True, theme="mono")
        credentials = Mock()
        capability_status = SimpleNamespace(capabilities=())
        expected = {"models": {"providers": [], "models": []}, "browser": "local"}
        with (
            patch.object(status, "load_user_configuration", return_value=Configuration()),
            patch.object(status, "load_credentials", return_value=credentials),
            patch.object(status, "configuration_status", return_value=capability_status),
            patch.object(status, "configuration_runtime_status", return_value=Mock()),
            patch.object(status, "browser_access_status", return_value=Mock()),
            patch.object(status, "status_payload", return_value=expected) as assemble,
            redirect_stdout(io.StringIO()) as output,
        ):
            result = status.run_status(arguments)

        self.assertEqual(result, 0)
        self.assertEqual(json.loads(output.getvalue()), expected)
        self.assertEqual(assemble.call_count, 1)


if __name__ == "__main__":
    unittest.main()
