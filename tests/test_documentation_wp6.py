from __future__ import annotations

import argparse
from pathlib import Path
import unittest

from sciretriever.cli.main import _build_parser
from sciretriever.config import load_config


REPOSITORY = Path(__file__).resolve().parents[1]
FINAL_RELEASE_MARKER = "<!-- WP6_FINAL_RELEASE_RECEIPT: TODO31_940 -->"
FINAL_RELEASE_COUNT = "Todo 31 最终 `full` harness 940 项通过"
FINAL_RELEASE_RECEIPT = "`.omo/evidence/wp6/task-31.txt`"


def _subparsers(parser: argparse.ArgumentParser) -> argparse._SubParsersAction:
    return next(
        action for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    )


def _option(parser: argparse.ArgumentParser, name: str) -> argparse.Action:
    return next(action for action in parser._actions if name in action.option_strings)


class Wp6DocumentationSnapshotTests(unittest.TestCase):
    def test_final_help_tree_and_defaults_match_the_command_contract(self) -> None:
        # Given the installed parser used to render every --help surface
        parser = _build_parser()
        root = _subparsers(parser)

        # When the final root and nested command trees are inspected
        commands = tuple(root.choices)
        library = tuple(_subparsers(root.choices["library"]).choices)
        config = tuple(_subparsers(root.choices["config"]).choices)
        expand = root.choices["expand"]
        failures = root.choices["failures"]

        # Then the documented command tree and machine defaults are exact
        self.assertEqual(commands, (
            "discover", "search", "expand", "download", "analyze", "failures",
            "library", "preflight", "catalog", "package", "config",
        ))
        self.assertEqual(library, (
            "show", "search", "references", "cited-by", "export", "review",
            "merge-work", "regroup-version", "preferred", "metadata", "tag",
            "author", "audit", "undo",
        ))
        self.assertEqual(config, ("check",))
        self.assertEqual(_option(expand, "--direction").default, "references")
        self.assertTrue(_option(expand, "--depth").required)
        self.assertEqual(_option(expand, "--max-provider-calls").default, 10)
        self.assertEqual(_option(expand, "--provider-page-size").default, 100)
        self.assertTrue(_option(failures, "--latest").default)
        self.assertFalse(_option(failures, "--details").default)

    def test_full_and_minimal_toml_are_strictly_loadable(self) -> None:
        # Given the complete annotated template and the minimal starter template
        full_path = REPOSITORY / "docs" / "guides" / "config.toml"
        minimal_path = REPOSITORY / "docs" / "guides" / "config.minimal.toml"

        # When both public configuration surfaces are parsed
        full = load_config(full_path)
        minimal = load_config(minimal_path)

        # Then each exposes its intended machine-consumed configuration level
        self.assertEqual(full.schema_version, 1)
        self.assertEqual(full.document_start_interval_seconds, 30.0)
        self.assertEqual(full.discovery.limit, 1000)
        self.assertEqual((full.search.limit, full.search.completion_limit), (1000, 100))
        self.assertEqual(full.expansion.max_provider_calls, 5)
        self.assertEqual(full.package.max_pages, 2000)
        self.assertEqual(minimal.schema_version, 1)
        self.assertEqual(minimal.document_start_interval_seconds, 30.0)
        self.assertIsNone(minimal.discovery.limit)
        self.assertEqual((minimal.search.limit, minimal.search.completion_limit), (None, None))
        self.assertEqual(minimal.search.level, "metadata")
        self.assertEqual(minimal.analysis.mineru.mode, "disabled")

    def test_stage_help_exposes_independent_batch_defaults(self) -> None:
        # Given the four independently runnable stage command parsers
        root = _subparsers(_build_parser())

        # When their public help is rendered
        help_text = {name: root.choices[name].format_help() for name in (
            "discover", "search", "download", "analyze",
        )}

        # Then metadata, deep completion, acquisition, and analysis limits are distinct
        self.assertIn("metadata results (default: 1000)", help_text["discover"])
        self.assertIn("metadata results (default: 1000)", help_text["search"])
        self.assertIn("deep completion targets (default: 100)", help_text["search"])
        self.assertIn("acquisition targets (default: 100)", help_text["download"])
        self.assertIn("analysis targets (default: 100)", help_text["analyze"])

    def test_readme_and_progress_publish_one_current_wp6_surface(self) -> None:
        # Given the current-behavior README and sole progress ledger
        readme = (REPOSITORY / "README.md").read_text(encoding="utf-8")
        progress = (
            REPOSITORY / "docs" / "archive" / "2026-07-literature-library"
            / "implementation-progress.md"
        ).read_text(encoding="utf-8")

        # When their command and final-release statements are inspected
        current_commands = (
            "`sciretriever expand`", "`sciretriever failures`",
            "`sciretriever config check`",
        )

        # Then WP6 is current and publishes the observed Todo 31 release truth
        for command in current_commands:
            self.assertIn(command, readme)
        self.assertEqual(progress.count(FINAL_RELEASE_MARKER), 1)
        self.assertEqual(progress.count(FINAL_RELEASE_COUNT), 1)
        self.assertEqual(progress.count(FINAL_RELEASE_RECEIPT), 1)
        self.assertNotIn("Reference expansion | 未实现", progress)
        self.assertNotIn("WP6 引用扩展与产品收口 | approved | not started", progress)


if __name__ == "__main__":
    unittest.main()
