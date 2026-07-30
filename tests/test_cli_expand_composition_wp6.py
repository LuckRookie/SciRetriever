from __future__ import annotations

import argparse
import json
from pathlib import Path
import subprocess
from unittest import TestCase

import anyio

from sciretriever.completion import CompletionResult, CompletionStop, DoiTarget
from sciretriever.cli.expansion_runtime import build_expand_runtime

from test_completion_acceptance_fixture import RealCompletionFixture


REPOSITORY = Path(__file__).resolve().parents[1]


class ExpandCompositionTests(TestCase):
    def test_depth_zero_uses_real_composition_without_remote_runtime(self) -> None:
        # Given
        fixture = RealCompletionFixture.create()
        self.addCleanup(fixture.close)
        completed = anyio.run(
            fixture.runtime.pipeline.ensure_complete,
            DoiTarget("10.1234/wp6-cli-depth-zero"),
            CompletionStop.COMPLETE,
        )
        self.assertIsInstance(completed, CompletionResult)
        if not isinstance(completed, CompletionResult):
            self.fail("fixture DOI did not resolve")
        before = fixture.counts()
        self.assertEqual(before, (1, 1, 3, 2, 1, 1, 1, 3, 6))
        args = argparse.Namespace(
            catalog=fixture.catalog.path,
            storage_root=fixture.storage,
            work_id=None,
            work_version_id=completed.work_version_id,
            query=None,
            direction="references",
            depth=0,
            graph_provider=["openalex"],
            max_provider_calls=1,
            provider_page_size=1,
        )

        # When
        runtime = build_expand_runtime(args)
        self.addCleanup(runtime.close)
        result = runtime.execute(args)

        # Then
        self.assertEqual(result.seed.work_version_id, completed.work_version_id)
        self.assertEqual(len(result.layers), 1)
        self.assertFalse(result.interrupted)
        self.assertEqual(result.layers[0].counts.completed, 1)
        self.assertEqual(result.layers[0].counts.provider_returned, 0)
        self.assertEqual(result.layers[0].failed_providers, ())
        self.assertEqual(fixture.counts(), before)

    def test_installed_depth_zero_accepts_every_direction_without_mutation(self) -> None:
        # Given
        fixture = RealCompletionFixture.create()
        self.addCleanup(fixture.close)
        completed = anyio.run(
            fixture.runtime.pipeline.ensure_complete,
            DoiTarget("10.1234/wp6-cli-installed"),
            CompletionStop.COMPLETE,
        )
        self.assertIsInstance(completed, CompletionResult)
        if not isinstance(completed, CompletionResult):
            self.fail("fixture DOI did not resolve")
        before = fixture.counts()
        self.assertEqual(before, (1, 1, 3, 2, 1, 1, 1, 3, 6))

        for direction in ("references", "cited-by", "both"):
            # When
            result = subprocess.run(
                [
                    "uv", "run", "--frozen", "sciretriever", "--no-config", "expand",
                    "--catalog", str(fixture.catalog.path),
                    "--storage-root", str(fixture.storage),
                    "--work-version-id", completed.work_version_id,
                    "--depth", "0", "--direction", direction,
                    "--graph-provider", "openalex",
                ],
                cwd=REPOSITORY,
                capture_output=True,
                text=True,
                check=False,
            )

            # Then
            self.assertEqual(result.returncode, 0, result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["direction"], direction)
            self.assertEqual(payload["depth"], 0)
            self.assertEqual(payload["layers"][0]["counts"]["provider_returned"], 0)
            self.assertEqual(payload["layers"][0]["diagnostics"], [])
            self.assertFalse(payload["interrupted"])
        configured = subprocess.run(
            [
                "uv", "run", "--frozen", "sciretriever",
                "--config", "docs/guides/config.minimal.toml", "expand",
                "--catalog", str(fixture.catalog.path),
                "--storage-root", str(fixture.storage),
                "--work-version-id", completed.work_version_id,
                "--depth", "0", "--graph-provider", "openalex",
            ],
            cwd=REPOSITORY,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(configured.returncode, 0, configured.stderr)
        self.assertEqual(json.loads(configured.stdout)["layers"][0]["diagnostics"], [])
        self.assertEqual(fixture.counts(), before)


if __name__ == "__main__":
    import unittest

    unittest.main()
