"""SciRetriever command-line entry point."""

import argparse
import os
import sys

from sciretriever import __version__
from sciretriever.cli import analyze, catalog, discover, download, expand, failures, library, package, preflight, search
from . import config_check
from .config_composition import extract_config_selectors, inject_config, selected_config
from .parser import COMMANDS, PLACEHOLDER_COMMANDS, build_parser
from sciretriever.config import CONFIG_ENV, SciRetrieverConfig, load_config
from sciretriever.config_loader import ConfigLoadError
from sciretriever.errors import ConfigError


def _build_parser() -> argparse.ArgumentParser:
    return build_parser()


def _extract_config_selectors(argv: list[str]) -> tuple[list[str], str | None, bool]:
    return extract_config_selectors(argv)


def _version_requested(argv: list[str]) -> bool:
    for token in argv:
        if token == "--" or token in COMMANDS:
            return False
        if token == "--version":
            return True
    return False


def _selected_config(explicit: str | None, no_config: bool) -> SciRetrieverConfig | None:
    return selected_config(explicit, no_config, load_config)


def _inject_config(argv: list[str], config: SciRetrieverConfig) -> list[str]:
    return inject_config(argv, config)


def main(argv: list[str] | None = None) -> int:
    """Run the SciRetriever command-line interface."""
    parser = _build_parser()
    raw_argv = list(sys.argv[1:] if argv is None else argv)
    try:
        cleaned, explicit_config, no_config = _extract_config_selectors(raw_argv)
        if _version_requested(cleaned):
            if not no_config and (explicit_config is not None or CONFIG_ENV in os.environ):
                _selected_config(explicit_config, no_config=False)
            args = parser.parse_args(cleaned)
        else:
            loaded_config = _selected_config(explicit_config, no_config)
            args = parser.parse_args(
                cleaned if loaded_config is None else _inject_config(cleaned, loaded_config)
            )
            if loaded_config is not None:
                args._config_credentials = loaded_config.credentials
                args._config_sci_hub = loaded_config.acquisition.sci_hub
                args._config_translator = loaded_config.acquisition.translator
                args._config_browser = loaded_config.acquisition.browser
                args._config_analysis = loaded_config.analysis
                args._document_start_interval_seconds = loaded_config.document_start_interval_seconds
                args._loaded_config = loaded_config
    except ConfigLoadError as error:
        parser.error(error.failure.value)
    except ConfigError as error:
        parser.error(str(error))

    if args.version:
        print(__version__)
        return 0

    if args.command == "discover":
        discover.validate_arguments(parser, args)
        return discover.run(args)

    if args.command == "search":
        search.validate_arguments(parser, args)
        return search.run(args)

    if args.command == "expand":
        expand.validate_arguments(parser, args)
        return expand.run(args)

    if args.command == "download":
        download.validate_arguments(parser, args)
        return download.run(args)

    if args.command == "analyze":
        analyze.validate_arguments(parser, args)
        return analyze.run(args)

    if args.command == "failures":
        return failures.run(args)

    if args.command == "library":
        library.validate_arguments(parser, args)
        return library.run(args)


    if args.command == "preflight":
        return preflight.run(args)

    if args.command == "config" and args.config_command == "check":
        return config_check.run(args)

    if args.command == "catalog":
        return catalog.run(args)

    if args.command == "package":
        return package.run(args)

    if args.command is not None:
        print(
            f"sciretriever: error: '{args.command}' is not implemented yet",
            file=sys.stderr,
        )
        return 2

    parser.print_help()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
