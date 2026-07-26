from __future__ import annotations

import os
from pathlib import Path
from collections.abc import Callable

from sciretriever.config import CONFIG_ENV, SciRetrieverConfig
from sciretriever.errors import ConfigError


def extract_config_selectors(argv: list[str]) -> tuple[list[str], str | None, bool]:
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


def selected_config(
    explicit: str | None,
    no_config: bool,
    loader: Callable[[Path], SciRetrieverConfig],
) -> SciRetrieverConfig | None:
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
    return loader(path)


def _present_options(argv: list[str]) -> set[str]:
    return {token.split("=", 1)[0] for token in argv if token.startswith("--")}


def _add_scalar(
    tokens: list[str], present: set[str], option: str,
    value: str | int | float | Path | None,
) -> None:
    if value is not None and option not in present:
        tokens.extend((option, str(value)))


def _option_value(argv: list[str], option: str) -> str | None:
    for index, token in enumerate(argv):
        if token.startswith(option + "="):
            return token.split("=", 1)[1]
        if token == option and index + 1 < len(argv):
            return argv[index + 1]
    return None


def inject_config(argv: list[str], config: SciRetrieverConfig) -> list[str]:
    if not argv:
        return argv
    present = _present_options(argv)
    injected: list[str] = []
    command = next((token for token in argv if token in {
        "discover", "search", "expand", "download", "analyze", "library", "catalog", "package",
    }), None)
    if command == "discover":
        values = config.discovery
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
        for option, value in (
            ("--limit", values.limit), ("--timeout", values.timeout), ("--taxonomy", values.taxonomy),
            ("--taxonomy-version", values.taxonomy_version), ("--crossref-mailto", values.crossref_mailto),
        ):
            _add_scalar(injected, present, option, value)
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
        for option, value in (
            ("--level", values.level), ("--limit", values.limit),
            ("--provider-timeout", values.provider_timeout), ("--max-concurrency", values.max_concurrency),
            ("--crossref-mailto", values.crossref_mailto),
        ):
            _add_scalar(injected, present, option, value)
        if "--provider" not in present and values.providers is not None:
            for provider in values.providers:
                injected.extend(("--provider", provider))
        if "--provider" not in present and "--precedence" not in present and values.precedence is not None:
            for provider in values.precedence:
                injected.extend(("--precedence", provider))
        if (_option_value(argv, "--level") or values.level) in {"download", "analyze"}:
            injected.extend(_acquisition_tokens(config, present, "--download-"))
    elif command == "download":
        injected.extend(_acquisition_tokens(config, present, "--"))
    elif command == "expand":
        values = config.expansion
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
        _add_scalar(injected, present, "--storage-root", config.paths.storage_root)
        _add_scalar(injected, present, "--direction", values.direction)
        _add_scalar(injected, present, "--depth", values.depth)
        _add_scalar(injected, present, "--max-provider-calls", values.max_provider_calls)
        _add_scalar(injected, present, "--provider-page-size", values.page_size)
        if "--graph-provider" not in present:
            for provider in values.providers:
                injected.extend(("--graph-provider", provider))
    elif command in {"analyze", "package"}:
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
        _add_scalar(injected, present, "--storage-root", config.paths.storage_root)
        if command == "package":
            for name in (
                "max_input_bytes", "max_pages", "max_structural_units", "max_depth",
                "max_elements", "max_text_characters",
            ):
                _add_scalar(injected, present, "--" + name.replace("_", "-"), getattr(config.package, name))
    elif command == "library":
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
        if "export" in argv and _option_value(argv, "--mode") == "package":
            _add_scalar(injected, present, "--storage-root", config.paths.storage_root)
    elif command == "catalog":
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
        if "import-asset" in argv:
            _add_scalar(injected, present, "--storage-root", config.paths.storage_root)
    return [*argv, *injected]


def _acquisition_tokens(
    config: SciRetrieverConfig, present: set[str], prefix: str,
) -> list[str]:
    injected: list[str] = []
    values = config.acquisition
    if prefix == "--":
        _add_scalar(injected, present, "--catalog", config.paths.catalog)
    _add_scalar(injected, present, "--storage-root", config.paths.storage_root)
    for name in ("timeout", "provider_concurrency", "host_concurrency", "host_min_interval", "max_asset_bytes", "forbidden_urls"):
        option_name = name
        if prefix == "--download-" and name in {"host_concurrency", "host_min_interval", "max_asset_bytes", "forbidden_urls"}:
            option = "--" + name.replace("_", "-")
        else:
            option = prefix + option_name.replace("_", "-")
        _add_scalar(injected, present, option, getattr(values, name))
    provider_option = prefix + "provider"
    if provider_option not in present and values.providers is not None:
        for provider in values.providers:
            injected.extend((provider_option, provider))
    for name, enabled in (("xml", values.include_xml), ("html", values.include_html)):
        if not present.intersection({f"--{name}", f"--no-{name}"}) and enabled is not None:
            injected.append(f"--{name}" if enabled else f"--no-{name}")
    return injected


__all__ = ("extract_config_selectors", "inject_config", "selected_config")
