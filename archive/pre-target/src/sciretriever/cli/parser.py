from __future__ import annotations

import argparse

from sciretriever.cli import analyze, catalog, discover, download, expand, failures, library, package, preflight, search
from . import config_check
from sciretriever.config import CONFIG_ENV


COMMANDS = (
    "discover", "search", "expand", "download", "analyze", "failures", "library", "preflight", "catalog", "package", "config",
)
PLACEHOLDER_COMMANDS: tuple[str, ...] = ()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sciretriever")
    selectors = parser.add_mutually_exclusive_group()
    selectors.add_argument(
        "--config", metavar="PATH", help=f"load config.toml (overrides {CONFIG_ENV} and ./config.toml)"
    )
    selectors.add_argument(
        "--no-config", action="store_true", help="disable environment and implicit config loading"
    )
    parser.add_argument("--version", action="store_true", help="show the SciRetriever version and exit")
    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")
    commands = (
        ("discover", "discover literature metadata and write a JSONL manifest", discover.configure_parser),
        ("search", "search metadata providers and persist canonical Works", search.configure_parser),
        ("expand", "expand a citation graph from one explicit seed", expand.configure_parser),
        ("download", "backfill assets for existing WorkVersions", download.configure_parser),
        ("analyze", "backfill current analysis for existing WorkVersions", analyze.configure_parser),
        ("failures", "query redacted product failure history", failures.configure_parser),
        ("library", "read canonical Work library projections", library.configure_parser),
        ("preflight", "validate acquisition policy without downloading a body", preflight.configure_parser),
        ("catalog", "create a v2 catalog or import explicit existing assets", catalog.configure_parser),
        ("package", "normalize and publish an offline DocumentPackageVersion", package.configure_parser),
    )
    for name, help_text, configure in commands:
        command_parser = subparsers.add_parser(name, help=help_text)
        configure(command_parser)
    config_parser = subparsers.add_parser("config", help="validate effective configuration")
    config_commands = config_parser.add_subparsers(dest="config_command", metavar="COMMAND", required=True)
    check_parser = config_commands.add_parser("check", help="run offline configuration checks")
    config_check.configure_parser(check_parser)
    return parser


__all__ = ("COMMANDS", "PLACEHOLDER_COMMANDS", "build_parser")
