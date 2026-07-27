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

    def test_example_toml_lists_wp6_fields_once_with_parser_defaults(self) -> None:
        # Given the exhaustive example consumed by the strict parser
        example = REPOSITORY / "config.example.toml"
        text = example.read_text(encoding="utf-8")

        # When the example is parsed and its WP6 field declarations are counted
        config = load_config(example)
        declarations = (
            "document_start_interval_seconds =", "[expansion]",
            "max_provider_calls =", "page_size =",
        )

        # Then every field is present once and uses the implemented defaults
        for declaration in declarations:
            self.assertEqual(text.count(declaration), 1, declaration)
        self.assertEqual(config.document_start_interval_seconds, 30.0)
        self.assertEqual(config.expansion.direction, "references")
        self.assertEqual(config.expansion.depth, 0)
        self.assertEqual(config.expansion.providers, ("openalex", "semantic-scholar"))
        self.assertEqual(config.expansion.max_provider_calls, 10)
        self.assertEqual(config.expansion.page_size, 100)
        self.assertNotIn("[curation]", text)
        self.assertNotIn("[export]", text)

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
