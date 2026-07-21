"""Fail-closed URL and resolved-address policy for network requests."""

from __future__ import annotations

import ipaddress
from urllib.parse import urlsplit

class NetworkPolicyError(OSError):
    """A request was rejected by shared network policy."""


class UrlPolicy:
    def __init__(self, *, forbidden_urls: tuple[str, ...] = ()) -> None:
        self._forbidden = tuple(item.strip() for item in forbidden_urls if item.strip())

    def validate(self, url: str, resolved_addresses: tuple[str, ...]) -> None:
        try:
            parsed = urlsplit(url)
            port = parsed.port
        except ValueError as error:
            raise NetworkPolicyError(f"invalid URL: {url!r}") from error
        if parsed.scheme.lower() != "https":
            raise NetworkPolicyError("acquisition URLs must use HTTPS")
        if parsed.username is not None or parsed.password is not None:
            raise NetworkPolicyError("URL credentials are forbidden")
        if not parsed.hostname or port not in (None, 443):
            raise NetworkPolicyError("URL requires a valid host and HTTPS port")
        normalized = url.lower()
        if any(normalized.startswith(item.lower()) for item in self._forbidden):
            raise NetworkPolicyError("URL is forbidden by policy")
        if not resolved_addresses:
            raise NetworkPolicyError("URL host did not resolve")
        for value in resolved_addresses:
            try:
                address = ipaddress.ip_address(value)
            except ValueError as error:
                raise NetworkPolicyError(f"invalid resolved address: {value!r}") from error
            if not address.is_global:
                raise NetworkPolicyError(f"URL resolves to a non-public address: {value}")


__all__ = ("NetworkPolicyError", "UrlPolicy")
