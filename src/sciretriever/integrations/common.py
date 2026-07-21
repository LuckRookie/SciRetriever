"""Shared parsing and request helpers for vendor integrations."""

from __future__ import annotations

import json
from typing import Any, Mapping

from sciretriever.network import HttpResponse, QueryParams, Transport

MAX_ABSTRACT_CHARACTERS = 100_000


class IntegrationError(Exception):
    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def parse_json(response: HttpResponse, vendor: str) -> Mapping[str, Any]:
    if not 200 <= response.status < 300:
        raise IntegrationError(
            f"{vendor} returned HTTP {response.status}", status=response.status
        )
    try:
        value = json.loads(response.body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IntegrationError(f"{vendor} returned malformed JSON") from error
    if not isinstance(value, dict):
        raise IntegrationError(f"{vendor} returned a non-object payload")
    return value


def string_value(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def integer_value(value: object) -> int | None:
    if isinstance(value, int) and not isinstance(value, bool):
        return value
    if isinstance(value, str) and value.isascii() and value.isdecimal():
        return int(value)
    return None


def abstract_value(value: object) -> str | None:
    text = string_value(value)
    return None if text is None else text[:MAX_ABSTRACT_CHARACTERS]


def publication_year(date: str | None, fallback: object = None) -> int | None:
    value = integer_value(fallback)
    if value is not None:
        return value
    if date and len(date) >= 4 and date[:4].isdigit():
        return int(date[:4])
    return None


class BaseClient:
    vendor = "vendor"
    endpoint = ""

    def __init__(
        self, transport: Transport, *, timeout: float | None = 30.0
    ) -> None:
        self.transport = transport
        self._default_timeout = timeout

    def request_timeout(self, timeout: float | None) -> float | None:
        return self._default_timeout if timeout is None else timeout

    def get_json(
        self,
        *,
        params: QueryParams,
        headers: Mapping[str, str],
        timeout: float | None = None,
    ) -> Mapping[str, Any]:
        response = self.transport.get(
            self.endpoint,
            params=params,
            headers=headers,
            timeout=self.request_timeout(timeout),
        )
        return parse_json(response, self.vendor)


__all__ = (
    "BaseClient",
    "IntegrationError",
    "abstract_value",
    "integer_value",
    "parse_json",
    "publication_year",
    "string_value",
)
