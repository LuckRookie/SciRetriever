from __future__ import annotations

import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from sciretriever.config_models import (
    BrowserConfig,
    BrowserRuleConfig,
    SciHubConfig,
    TranslatorConfig,
    TranslatorRuleConfig,
)
from sciretriever.errors import ConfigError

from .acquisition_security import (
    doi_template,
    exact_hostname,
    safe_doi_template,
    sci_hub_base_url,
)
from .common import boolean, config_error, nonblank, positive_int, table


def parse_browser(table_value: Mapping[str, Any], parent: Path) -> BrowserConfig:
    section = table(
        table_value,
        "browser",
        {"enabled", "profile_dir", "max_profile_bytes", "max_profile_files", "rules"},
    )
    enabled = False if "enabled" not in section else boolean(
        section["enabled"], "acquisition.browser.enabled"
    )
    profile_reference = None
    profile = None
    if "profile_dir" in section:
        profile_reference = Path(
            nonblank(section["profile_dir"], "acquisition.browser.profile_dir")
        ).expanduser()
        if not profile_reference.is_absolute():
            profile_reference = parent / profile_reference
        profile = profile_reference.resolve(strict=False)
    max_bytes = 512 * 1024 * 1024 if "max_profile_bytes" not in section else positive_int(
        section["max_profile_bytes"], "acquisition.browser.max_profile_bytes"
    )
    max_files = 20_000 if "max_profile_files" not in section else positive_int(
        section["max_profile_files"], "acquisition.browser.max_profile_files"
    )
    if max_bytes > 4 * 1024 * 1024 * 1024:
        raise config_error(
            "acquisition.browser.max_profile_bytes", "exceeds the supported bound"
        )
    if max_files > 100_000:
        raise config_error(
            "acquisition.browser.max_profile_files", "exceeds the supported bound"
        )
    raw_rules = section.get("rules", [])
    if not isinstance(raw_rules, list):
        raise config_error("acquisition.browser.rules", "must be an array of tables")
    rules: list[BrowserRuleConfig] = []
    names: set[str] = set()
    required = {
        "name", "landing_url_template", "allowed_landing_hosts",
        "allowed_pdf_hosts", "allowed_network_hosts",
    }
    for index, raw_rule in enumerate(raw_rules):
        prefix = f"acquisition.browser.rules[{index}]"
        if not isinstance(raw_rule, dict):
            raise config_error(prefix, "must be a table")
        unknown = sorted(set(raw_rule) - required)
        if unknown:
            raise ConfigError(f"unknown config field: {prefix}.{unknown[0]}")
        missing = sorted(required - set(raw_rule))
        if missing:
            raise config_error(f"{prefix}.{missing[0]}", "is required")
        rule_name = nonblank(raw_rule["name"], f"{prefix}.name")
        if re.fullmatch(r"[a-z][a-z0-9-]{0,31}", rule_name) is None:
            raise config_error(f"{prefix}.name", "must be a bounded lowercase name")
        if rule_name in names:
            raise config_error("acquisition.browser.rules", "must have unique names")
        names.add(rule_name)
        template, template_host = safe_doi_template(
            raw_rule["landing_url_template"], f"{prefix}.landing_url_template"
        )
        landing = tuple(dict.fromkeys(
            (template_host, *_hosts(raw_rule, "allowed_landing_hosts", prefix))
        ))
        pdf = _hosts(raw_rule, "allowed_pdf_hosts", prefix)
        network = tuple(dict.fromkeys(
            (template_host, *_hosts(raw_rule, "allowed_network_hosts", prefix), *pdf)
        ))
        rules.append(BrowserRuleConfig(rule_name, template, landing, pdf, network))
    if enabled and profile is None:
        raise config_error("acquisition.browser.profile_dir", "is required when enabled")
    if enabled and not rules:
        raise config_error("acquisition.browser.rules", "must be nonempty when enabled")
    if not enabled and (profile is not None or rules):
        raise config_error(
            "acquisition.browser", "must not configure profile or rules when disabled"
        )
    return BrowserConfig(
        enabled,
        profile,
        max_bytes,
        max_files,
        tuple(rules),
        profile_reference,
    )


def parse_translator(table_value: Mapping[str, Any]) -> TranslatorConfig:
    section = table(table_value, "translator", {"enabled", "rules"})
    enabled = False if "enabled" not in section else boolean(
        section["enabled"], "acquisition.translator.enabled"
    )
    raw_rules = section.get("rules", [])
    if not isinstance(raw_rules, list):
        raise config_error("acquisition.translator.rules", "must be an array of tables")
    rules: list[TranslatorRuleConfig] = []
    names: set[str] = set()
    allowed = {
        "name", "landing_url_template", "allowed_landing_hosts", "allowed_pdf_hosts",
    }
    for index, raw_rule in enumerate(raw_rules):
        prefix = f"acquisition.translator.rules[{index}]"
        if not isinstance(raw_rule, dict):
            raise config_error(prefix, "must be a table")
        unknown = sorted(set(raw_rule) - allowed)
        if unknown:
            raise ConfigError(f"unknown config field: {prefix}.{unknown[0]}")
        if set(raw_rule) < {"name", "landing_url_template"}:
            missing = "name" if "name" not in raw_rule else "landing_url_template"
            raise config_error(f"{prefix}.{missing}", "is required")
        name = nonblank(raw_rule["name"], f"{prefix}.name")
        if re.fullmatch(r"[a-z][a-z0-9-]{0,31}", name) is None:
            raise config_error(f"{prefix}.name", "must be a bounded lowercase name")
        if name in names:
            raise config_error("acquisition.translator.rules", "must have unique names")
        names.add(name)
        template, _ = doi_template(
            raw_rule["landing_url_template"], f"{prefix}.landing_url_template"
        )
        rules.append(TranslatorRuleConfig(
            name,
            template,
            _optional_hosts(raw_rule, "allowed_landing_hosts", prefix),
            _optional_hosts(raw_rule, "allowed_pdf_hosts", prefix),
        ))
    if enabled and not rules:
        raise config_error("acquisition.translator.rules", "must be nonempty when enabled")
    if not enabled and rules:
        raise config_error("acquisition.translator.rules", "must be empty when disabled")
    return TranslatorConfig(enabled, tuple(rules))


def parse_sci_hub(
    table_value: Mapping[str, Any], providers: tuple[str, ...] | None
) -> SciHubConfig:
    section = table(table_value, "sci_hub", {"enabled", "base_url", "allowed_pdf_hosts"})
    enabled = False if "enabled" not in section else boolean(
        section["enabled"], "acquisition.sci_hub.enabled"
    )
    base_url = None if "base_url" not in section else sci_hub_base_url(
        section["base_url"]
    )
    allowed_hosts = _optional_hosts(
        section, "allowed_pdf_hosts", "acquisition.sci_hub"
    )
    selected = providers is not None and "sci-hub" in providers
    if selected != enabled:
        raise config_error(
            "acquisition.sci_hub.enabled",
            "must be true exactly when sci-hub is listed in acquisition.providers",
        )
    if enabled and base_url is None:
        raise config_error("acquisition.sci_hub.base_url", "is required when enabled")
    return SciHubConfig(enabled, base_url, allowed_hosts)


def _hosts(
    raw_rule: Mapping[str, Any], field_name: str, prefix: str
) -> tuple[str, ...]:
    raw = raw_rule[field_name]
    if not isinstance(raw, list):
        raise config_error(f"{prefix}.{field_name}", "must be a string list")
    result = tuple(exact_hostname(item, f"{prefix}.{field_name}") for item in raw)
    if len(set(result)) != len(result):
        raise config_error(f"{prefix}.{field_name}", "must not contain duplicate values")
    return result


def _optional_hosts(
    raw_rule: Mapping[str, Any], field_name: str, prefix: str
) -> tuple[str, ...]:
    if field_name not in raw_rule:
        return ()
    return _hosts(raw_rule, field_name, prefix)


__all__ = ("parse_browser", "parse_sci_hub", "parse_translator")
