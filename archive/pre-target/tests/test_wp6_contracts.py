import argparse
from enum import Enum
from importlib import import_module
import unittest

from sciretriever.catalog import CompletionStage
from sciretriever.cli.main import _build_parser
from sciretriever.completion import BatchItemStatus
from sciretriever.diagnostics.contracts import ActionCode, ReasonCode


def _enum_values(module_name: str, symbol_name: str) -> tuple[str, ...]:
    try:
        module = import_module(module_name)
    except ModuleNotFoundError:
        raise AssertionError(f"missing WP6 symbol {module_name}.{symbol_name}") from None
    symbol = getattr(module, symbol_name, None)
    if not isinstance(symbol, type) or not issubclass(symbol, Enum):
        raise AssertionError(f"missing WP6 symbol {module_name}.{symbol_name}")
    return tuple(member.value for member in symbol)


def _subparsers(parser: argparse.ArgumentParser) -> argparse._SubParsersAction:
    return next(
        action for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    )


def _parser_commands(parser: argparse.ArgumentParser) -> set[str]:
    return set(_subparsers(parser).choices)


class WP5BaselineCharacterizationTests(unittest.TestCase):
    def test_current_fact_and_recovery_contracts_remain_available(self) -> None:
        self.assertEqual(
            tuple(stage.value for stage in CompletionStage),
            ("metadata_pending", "asset_pending", "analysis_pending", "complete"),
        )
        self.assertEqual(
            tuple(status.value for status in BatchItemStatus),
            ("succeeded", "exhausted", "duplicate", "failed", "interrupted"),
        )
        self.assertIn(ReasonCode.CONFIGURATION_INVALID, ReasonCode)
        self.assertIn(ActionCode.RETRY_LATER, ActionCode)


class WP6TargetContractTests(unittest.TestCase):
    def test_final_product_command_tree_is_explicit(self) -> None:
        parser = _build_parser()
        root = _subparsers(parser)
        commands = set(root.choices)
        required = {"search", "expand", "download", "analyze", "library", "failures", "config"}
        missing = sorted(required - commands)
        self.assertFalse(missing, f"missing WP6 commands: {', '.join(missing)}")
        library_commands = _parser_commands(root.choices["library"])
        required_library = {
            "show", "search", "references", "cited-by", "export", "review",
            "merge-work", "regroup-version", "preferred", "metadata", "tag",
            "author", "audit", "undo",
        }
        self.assertFalse(
            sorted(required_library - library_commands),
            "missing WP6 library commands",
        )
        self.assertEqual(_parser_commands(root.choices["config"]), {"check"})

    def test_product_failure_stage_reason_and_action_enums_are_frozen(self) -> None:
        self.assertEqual(
            _enum_values("sciretriever.diagnostics.contracts", "ProductFailureStage"),
            ("metadata", "acquisition", "analysis", "expansion"),
        )
        self.assertEqual(
            _enum_values("sciretriever.diagnostics.contracts", "ProductFailureReason"),
            ("configuration", "provider", "identity", "content", "storage", "catalog", "interrupted"),
        )
        self.assertEqual(
            _enum_values("sciretriever.diagnostics.contracts", "ProductFailureAction"),
            ("check_configuration", "check_credentials", "retry", "try_another_source", "review", "repair_storage", "none"),
        )

    def test_progress_count_vocabulary_is_frozen(self) -> None:
        self.assertEqual(
            _enum_values("sciretriever.completion.counts", "ProgressCount"),
            (
                "provider_returned", "deduplicated_works", "created", "reused",
                "selected", "unique_targets", "succeeded", "exhausted", "failed",
                "duplicates", "interrupted", "accepted", "missing",
                "analysis_succeeded", "analysis_failed", "discovered", "existing", "completed",
            ),
        )

    def test_curation_action_vocabulary_is_frozen(self) -> None:
        self.assertEqual(
            _enum_values("sciretriever.core.curation", "CurationAction"),
            (
                "resolve_review", "merge_work", "regroup_work_version",
                "set_preferred", "clear_preferred", "set_metadata", "clear_metadata",
                "add_tag", "remove_tag", "merge_author", "undo",
            ),
        )

    def test_graph_direction_and_depth_contracts_are_frozen(self) -> None:
        self.assertEqual(
            _enum_values("sciretriever.integrations.graph", "GraphDirection"),
            ("references", "cited-by", "both"),
        )
        try:
            graph = import_module("sciretriever.integrations.graph")
            depth_type = getattr(graph, "ExpansionDepth")
        except (ModuleNotFoundError, AttributeError):
            self.fail("missing WP6 symbol sciretriever.integrations.graph.ExpansionDepth")
        self.assertEqual(int(depth_type(0)), 0)
        self.assertEqual(int(depth_type(2)), 2)
        with self.assertRaises(ValueError):
            depth_type(-1)

    def test_reading_and_package_export_modes_are_frozen(self) -> None:
        self.assertEqual(
            _enum_values("sciretriever.core.export", "ExportMode"),
            ("reading", "package"),
        )
        self.assertEqual(
            _enum_values("sciretriever.core.export", "ReadingExportReferences"),
            ("omit", "include"),
        )
        self.assertEqual(
            _enum_values("sciretriever.core.export", "PackageReferencePolicy"),
            ("always_include",),
        )

    def test_config_check_modes_are_frozen(self) -> None:
        self.assertEqual(
            _enum_values("sciretriever.config", "ConfigCheckMode"),
            ("offline", "runtime"),
        )


if __name__ == "__main__":
    unittest.main()
