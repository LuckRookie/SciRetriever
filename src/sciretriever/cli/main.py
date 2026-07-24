"""SciRetriever command-line entry point."""

import argparse
import os
from pathlib import Path
import sys

from sciretriever import __version__
from sciretriever.cli import catalog, discover, download, library, package, preflight, search
from sciretriever.config import CONFIG_ENV, SciRetrieverConfig, load_config
from sciretriever.errors import ConfigError


COMMANDS = ("discover", "search", "download", "library", "preflight", "catalog", "package")
PLACEHOLDER_COMMANDS: tuple[str, ...] = ()


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="sciretriever")
    selectors = parser.add_mutually_exclusive_group()
    selectors.add_argument(
        "--config",
        metavar="PATH",
        help=f"load config.toml (overrides {CONFIG_ENV} and ./config.toml)",
    )
    selectors.add_argument(
        "--no-config",
        action="store_true",
        help="disable environment and implicit config loading",
    )
    parser.add_argument(
        "--version",
        action="store_true",
        help="show the SciRetriever version and exit",
    )
    subparsers = parser.add_subparsers(dest="command", metavar="COMMAND")
    discover_parser = subparsers.add_parser(
        "discover", help="discover literature metadata and write a JSONL manifest"
    )
    discover.configure_parser(discover_parser)
    search_parser = subparsers.add_parser(
        "search", help="search metadata providers and persist canonical Works"
    )
    search.configure_parser(search_parser)
    download_parser = subparsers.add_parser(
        "download", help="backfill assets for existing WorkVersions"
    )
    download.configure_parser(download_parser)
    library_parser = subparsers.add_parser(
        "library", help="read canonical Work library projections"
    )
    library.configure_parser(library_parser)
    preflight_parser = subparsers.add_parser(
        "preflight", help="validate acquisition policy without downloading a body"
    )
    preflight.configure_parser(preflight_parser)
    catalog_parser = subparsers.add_parser(
        "catalog", help="create a v2 catalog or import explicit existing assets"
    )
    catalog.configure_parser(catalog_parser)
    package_parser = subparsers.add_parser(
        "package", help="normalize and publish an offline DocumentPackageVersion"
    )
    package.configure_parser(package_parser)
    for command in PLACEHOLDER_COMMANDS:
        subparsers.add_parser(command, help="reserved for a later implementation phase")
    return parser


def _extract_config_selectors(argv: list[str]) -> tuple[list[str], str | None, bool]:
    cleaned: list[str] = []
    configured: list[str] = []
    no_config = False
    index = 0
    while index < len(argv):
        token = argv[index]
        if token == "--":
            cleaned.extend(argv[index:])
            break
        if token == "--config":
            if index + 1 >= len(argv) or argv[index + 1].startswith("--"):
                raise ConfigError("argument --config requires a path")
            configured.append(argv[index + 1])
            index += 2
            continue
        if token.startswith("--config="):
            configured.append(token.split("=", 1)[1])
            index += 1
            continue
        if token == "--no-config":
            no_config = True
            index += 1
            continue
        cleaned.append(token)
        index += 1
    if len(configured) > 1:
        raise ConfigError("argument --config may be supplied only once")
    if configured and no_config:
        raise ConfigError("--config cannot be combined with --no-config")
    if configured and not configured[0].strip():
        raise ConfigError("argument --config requires a nonblank path")
    return cleaned, configured[0] if configured else None, no_config


def _version_requested(argv: list[str]) -> bool:
    for token in argv:
        if token == "--" or token in COMMANDS:
            return False
        if token == "--version":
            return True
    return False


def _selected_config(explicit: str | None, no_config: bool) -> SciRetrieverConfig | None:
    if no_config:
        return None
    selected = explicit
    required = explicit is not None
    if selected is None:
        selected = os.environ.get(CONFIG_ENV)
        required = selected is not None
    if selected is None:
        implicit = Path.cwd() / "config.toml"
        try:
            implicit.lstat()
        except FileNotFoundError:
            return None
        except OSError as error:
            raise ConfigError("implicit config path is not accessible") from error
        selected = str(implicit)
    if not selected.strip():
        raise ConfigError(f"{CONFIG_ENV} must name a nonblank config path")
    path = Path(selected).expanduser()
    if required and not path.exists():
        raise ConfigError("selected config file does not exist")
    return load_config(path)


def _present_options(argv: list[str]) -> set[str]:
    return {token.split("=", 1)[0] for token in argv if token.startswith("--")}


def _add_scalar(tokens: list[str], present: set[str], option: str, value: object | None) -> None:
    if value is not None and option not in present:
        tokens.extend((option, str(value)))


def _option_value(argv: list[str], option: str) -> str | None:
    for index, token in enumerate(argv):
        if token.startswith(option + "="):
            return token.split("=", 1)[1]
        if token == option and index + 1 < len(argv):
            return argv[index + 1]
    return None


def _inject_config(argv: list[str], config: SciRetrieverConfig) -> list[str]:
    if not argv:
        return argv
    present = _present_options(argv)
    injected: list[str] = []
    command = next((token for token in argv if token in COMMANDS), None)
    if command == "discover":
        values = config.discovery
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
        _add_scalar(injected, present, "--limit", values.limit)
        _add_scalar(injected, present, "--timeout", values.timeout)
        _add_scalar(injected, present, "--taxonomy", values.taxonomy)
        _add_scalar(injected, present, "--taxonomy-version", values.taxonomy_version)
        _add_scalar(injected, present, "--crossref-mailto", values.crossref_mailto)
        if "--source" not in present and values.sources is not None:
            for source in values.sources:
                injected.extend(("--source", source))
        if "--filter" not in present:
            for name, value in values.filters:
                injected.extend(("--filter", f"{name}={value}"))
        if "--label-rule" not in present:
            for label, terms in values.label_rules:
                for term in terms:
                    injected.extend(("--label-rule", f"{label}={term}"))
    elif command == "search":
        values = config.search
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
        _add_scalar(injected, present, "--level", values.level)
        _add_scalar(injected, present, "--limit", values.limit)
        _add_scalar(injected, present, "--provider-timeout", values.provider_timeout)
        _add_scalar(injected, present, "--max-concurrency", values.max_concurrency)
        _add_scalar(injected, present, "--crossref-mailto", values.crossref_mailto)
        if "--provider" not in present and values.providers is not None:
            for provider in values.providers:
                injected.extend(("--provider", provider))
        if (
            "--provider" not in present
            and "--precedence" not in present
            and values.precedence is not None
        ):
            for provider in values.precedence:
                injected.extend(("--precedence", provider))
        effective_level = _option_value(argv, "--level") or values.level
        if effective_level == "download":
            acquisition = config.acquisition
            _add_scalar(injected, present, "--storage-root", config.paths.storage_root)
            _add_scalar(injected, present, "--download-timeout", acquisition.timeout)
            _add_scalar(injected, present, "--download-provider-concurrency", acquisition.provider_concurrency)
            _add_scalar(injected, present, "--host-concurrency", acquisition.host_concurrency)
            _add_scalar(injected, present, "--host-min-interval", acquisition.host_min_interval)
            _add_scalar(injected, present, "--max-asset-bytes", acquisition.max_asset_bytes)
            _add_scalar(injected, present, "--forbidden-urls", acquisition.forbidden_urls)
            if "--download-provider" not in present and acquisition.providers is not None:
                for provider in acquisition.providers:
                    injected.extend(("--download-provider", provider))
            if not present.intersection({"--xml", "--no-xml"}) and acquisition.include_xml is not None:
                injected.append("--xml" if acquisition.include_xml else "--no-xml")
            if not present.intersection({"--html", "--no-html"}) and acquisition.include_html is not None:
                injected.append("--html" if acquisition.include_html else "--no-html")
    elif command == "download":
        values = config.acquisition
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
        _add_scalar(injected, present, "--storage-root", config.paths.storage_root)
        _add_scalar(injected, present, "--timeout", values.timeout)
        _add_scalar(injected, present, "--provider-concurrency", values.provider_concurrency)
        _add_scalar(injected, present, "--host-concurrency", values.host_concurrency)
        _add_scalar(injected, present, "--host-min-interval", values.host_min_interval)
        _add_scalar(injected, present, "--max-asset-bytes", values.max_asset_bytes)
        _add_scalar(injected, present, "--forbidden-urls", values.forbidden_urls)
        if "--provider" not in present and values.providers is not None:
            for provider in values.providers:
                injected.extend(("--provider", provider))
        if not present.intersection({"--xml", "--no-xml"}) and values.include_xml is not None:
            injected.append("--xml" if values.include_xml else "--no-xml")
        if not present.intersection({"--html", "--no-html"}) and values.include_html is not None:
            injected.append("--html" if values.include_html else "--no-html")
    elif command == "library":
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
    elif command == "catalog":
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
        catalog_command = next(
            (token for token in argv if token in {"create", "import-asset"}),
            None,
        )
        if catalog_command == "import-asset":
            _add_scalar(injected, present, "--storage-root", config.paths.storage_root)
    elif command == "package":
        values = config.package
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
        _add_scalar(injected, present, "--storage-root", config.paths.storage_root)
        for name in (
            "max_input_bytes", "max_pages", "max_structural_units", "max_depth",
            "max_elements", "max_text_characters", "summary_max_characters",
        ):
            _add_scalar(injected, present, "--" + name.replace("_", "-"), getattr(values, name))
        if not present.intersection({"--enrichment", "--no-enrichment"}) and values.enrichment is not None:
            injected.append("--enrichment" if values.enrichment else "--no-enrichment")
    return [*argv, *injected]


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
                args._loaded_config = loaded_config
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

    if args.command == "download":
        download.validate_arguments(parser, args)
        return download.run(args)

    if args.command == "library":
        return library.run(args)


    if args.command == "preflight":
        return preflight.run(args)

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
