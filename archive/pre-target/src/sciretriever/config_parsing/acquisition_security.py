from __future__ import annotations

import ipaddress
import re
from typing import Any
from urllib.parse import urlsplit

from .common import config_error, nonblank


def exact_hostname(value: Any, name: str) -> str:
    hostname = nonblank(value, name)
    if (
        hostname != hostname.lower()
        or hostname.startswith(".")
        or hostname.endswith(".")
        or "*" in hostname
        or re.fullmatch(
            r"(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
            r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?",
            hostname,
        ) is None
        or urlsplit(f"https://{hostname}").hostname != hostname
        or any(character in hostname for character in "/:@?#[]")
    ):
        raise config_error(name, "must contain exact lowercase hostnames")
    try:
        ipaddress.ip_address(hostname)
    except ValueError:
        pass
    else:
        raise config_error(name, "must contain exact lowercase hostnames")
    if hostname in {"localhost", "localhost.localdomain"} or hostname.endswith(
        ".localhost"
    ):
        raise config_error(name, "must contain exact lowercase hostnames")
    return hostname


def doi_template(value: Any, name: str) -> tuple[str, str]:
    template = nonblank(value, name)
    parsed = urlsplit(template)
    try:
        port = parsed.port
    except ValueError as error:
        raise config_error(name, "must be a safe HTTPS template") from error
    braces = re.findall(r"\{[^{}]*\}", template)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.netloc != parsed.netloc.lower()
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or port not in (None, 443)
        or any(character in parsed.netloc for character in "{}")
        or braces not in (["{doi}"], ["{doi_path}"])
        or template.count("{") != 1
        or template.count("}") != 1
    ):
        raise config_error(
            name,
            "must be a safe HTTPS template with exactly one supported DOI placeholder",
        )
    return template, parsed.hostname


def safe_doi_template(value: Any, name: str) -> tuple[str, str]:
    template, hostname = doi_template(value, name)
    return template, exact_hostname(hostname, name)


def sci_hub_base_url(value: Any) -> str:
    base_url = nonblank(value, "acquisition.sci_hub.base_url")
    parsed = urlsplit(base_url)
    try:
        port = parsed.port
    except ValueError as error:
        raise config_error(
            "acquisition.sci_hub.base_url", "must be an authorized HTTPS URL"
        ) from error
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or port not in (None, 443)
    ):
        raise config_error(
            "acquisition.sci_hub.base_url", "must be an authorized HTTPS URL"
        )
    return base_url


__all__ = (
    "doi_template",
    "exact_hostname",
    "safe_doi_template",
    "sci_hub_base_url",
)
