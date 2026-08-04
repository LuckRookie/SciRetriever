from __future__ import annotations

import ipaddress
import re
import socket
from typing import Final, NoReturn
from urllib.parse import SplitResult, unquote_to_bytes, urlsplit

from typing_extensions import assert_never

from sciretriever.model.configuration import ParserProtocol, TargetConfig

from .errors import raise_configuration_error
from .paths import validate_paths

_METADATA_PROVIDERS: Final = frozenset(
    {"crossref", "europe-pmc", "arxiv", "openalex", "semantic-scholar", "elsevier", "springer"}
)
_CITATION_PROVIDERS: Final = frozenset({"openalex", "semantic-scholar"})
_ASSET_PROVIDERS: Final = frozenset(
    {
        "direct",
        "arxiv",
        "crossref",
        "unpaywall",
        "europe-pmc",
        "openalex",
        "semantic-scholar",
        "elsevier",
        "wiley",
        "springer",
        "sci-hub",
    }
)
_SAFE_ENV_NAME: Final = re.compile(r"^[A-Z][A-Z0-9_]{1,127}$", re.ASCII)
_DNS_LABEL: Final = re.compile(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", re.ASCII)
_LEGACY_IPV4_SHAPE: Final = re.compile(r"[0-9A-Fa-fxX.]+", re.ASCII)


def validate_configuration(config: TargetConfig) -> TargetConfig:
    validated = TargetConfig.model_validate(config.model_dump())
    validate_paths(validated)
    _validate_providers(validated)
    _validate_parser(validated)
    _validate_analysis(validated)
    _validate_secret_references(validated)
    return validated


def _validate_providers(config: TargetConfig) -> None:
    _require_supported(
        config.collection.citation_providers,
        _CITATION_PROVIDERS,
        ("collection", "citation_providers"),
    )
    _require_supported(config.sources.providers, _METADATA_PROVIDERS, ("sources", "providers"))
    _require_supported(config.assets.providers, _ASSET_PROVIDERS, ("assets", "providers"))


def _require_supported(
    configured: tuple[str, ...], supported: frozenset[str], location: tuple[str, ...]
) -> None:
    if any(provider not in supported for provider in configured):
        raise_configuration_error(location, "configuration names an unsupported provider")


def _validate_parser(config: TargetConfig) -> None:
    parsed = _safe_url(config.parsing.base_url, ("parsing", "base_url"))
    hostname = parsed.hostname
    if hostname is None:
        _reject_url(("parsing", "base_url"))
    match config.parsing.protocol:
        case ParserProtocol.LOOPBACK:
            if (
                parsed.scheme != "http"
                or not _is_loopback(hostname)
                or config.parsing.remote_upload
                or config.parsing.secret_ref is not None
            ):
                raise_configuration_error(
                    ("parsing",),
                    "loopback parser requires loopback HTTP and forbids remote upload",
                )
        case ParserProtocol.REMOTE:
            if (
                parsed.scheme != "https"
                or _is_loopback(hostname)
                or _is_ip_literal(hostname)
                or not config.parsing.remote_upload
                or config.parsing.secret_ref is None
            ):
                raise_configuration_error(
                    ("parsing",),
                    "remote parser requires HTTPS, a non-loopback host, and remote upload",
                )
        case unreachable:
            assert_never(unreachable)


def _validate_analysis(config: TargetConfig) -> None:
    parsed = _safe_url(config.analysis.base_url, ("analysis", "base_url"))
    hostname = parsed.hostname
    if (
        parsed.scheme != "https"
        or hostname is None
        or _is_loopback(hostname)
        or _is_ip_literal(hostname)
    ):
        _reject_url(("analysis", "base_url"))
    if parsed.port not in (None, 443):
        _reject_url(("analysis", "base_url"))


def _validate_secret_references(config: TargetConfig) -> None:
    references = (
        (config.parsing.secret_ref, ("parsing", "secret_ref")),
        (config.analysis.secret_ref, ("analysis", "secret_ref")),
        (config.credentials.metadata, ("credentials", "metadata")),
        (config.credentials.acquisition, ("credentials", "acquisition")),
    )
    for reference, location in references:
        if reference is not None and _SAFE_ENV_NAME.fullmatch(reference[4:]) is None:
            raise_configuration_error(
                location, "secret reference must name an environment variable"
            )


def _safe_url(value: str, location: tuple[str, ...]) -> SplitResult:
    if "\\" in value or _has_unsafe_text(value):
        _reject_url(location)
    try:
        parsed = urlsplit(value)
        hostname = parsed.hostname
        _ = parsed.port
    except (UnicodeError, ValueError):
        _reject_url(location)
    if (
        parsed.username is not None
        or parsed.password is not None
        or "?" in value
        or "#" in value
        or hostname is None
    ):
        _reject_url(location)
    _validate_hostname(hostname, location)
    decoded_path = _strict_decode_path(parsed.path, location)
    if _unsafe_url_path(parsed.path, decoded_path):
        _reject_url(location)
    return parsed


def _strict_decode_path(path: str, location: tuple[str, ...]) -> str:
    index = 0
    while index < len(path):
        if path[index] == "%":
            if index + 2 >= len(path) or not all(
                character in "0123456789abcdefABCDEF" for character in path[index + 1 : index + 3]
            ):
                _reject_url(location)
            if path[index + 1 : index + 3].casefold() in {"2f", "5c"}:
                _reject_url(location)
            index += 3
        else:
            index += 1
    try:
        decoded = unquote_to_bytes(path).decode("utf-8", "strict")
    except UnicodeDecodeError:
        _reject_url(location)
    if _has_unsafe_text(decoded):
        _reject_url(location)
    return decoded


def _validate_hostname(hostname: str, location: tuple[str, ...]) -> None:
    if not hostname or "%" in hostname or hostname.endswith(".") or _has_unsafe_text(hostname):
        _reject_url(location)
    if _is_canonical_ip_literal(hostname):
        return
    if _is_legacy_ipv4(hostname):
        _reject_url(location)
    try:
        ascii_hostname = hostname.encode("idna").decode("ascii")
        labels = ascii_hostname.split(".")
        for label in labels:
            decoded_label = label.casefold().encode("ascii").decode("idna")
            canonical_label = decoded_label.encode("idna").decode("ascii")
            if canonical_label.casefold() != label.casefold():
                _reject_url(location)
    except UnicodeError:
        _reject_url(location)
    if len(ascii_hostname) > 253 or any(
        not label or len(label) > 63 or _DNS_LABEL.fullmatch(label) is None for label in labels
    ):
        _reject_url(location)


def _unsafe_url_path(raw_path: str, decoded_path: str) -> bool:
    normalized_path = decoded_path.replace("\\", "/")
    return (
        "//" in normalized_path
        or any(segment == ".." for segment in normalized_path.split("/"))
        or re.search(r"%(?:2f|5c)", raw_path, re.IGNORECASE) is not None
    )


def _has_unsafe_text(value: str) -> bool:
    return any(
        character.isspace() or ord(character) < 32 or 0x7F <= ord(character) <= 0x9F
        for character in value
    )


def _is_loopback(hostname: str) -> bool:
    if hostname.casefold() == "localhost":
        return True
    return _is_ip_literal(hostname) and ipaddress.ip_address(hostname).is_loopback


def _is_ip_literal(hostname: str) -> bool:
    return _is_canonical_ip_literal(hostname)


def _is_canonical_ip_literal(hostname: str) -> bool:
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return str(address) == hostname


def _is_legacy_ipv4(hostname: str) -> bool:
    if _LEGACY_IPV4_SHAPE.fullmatch(hostname) is None:
        return False
    try:
        socket.inet_aton(hostname)
    except OSError:
        return False
    return True


def _reject_url(location: tuple[str, ...]) -> NoReturn:
    raise_configuration_error(
        location, "URL must be a safe origin without credentials or query data"
    )


__all__ = ("validate_configuration",)
