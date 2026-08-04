from __future__ import annotations

import os
from collections.abc import Mapping
from typing import Protocol


class SecretResolutionError(Exception):
    __slots__ = ("reference",)

    def __init__(self, reference: str) -> None:
        self.reference = reference
        super().__init__(reference)

    def __str__(self) -> str:
        return f"secret reference {self.reference!r} could not be resolved"


class SecretResolver(Protocol):
    def resolve(self, reference: str) -> str: ...


class EnvironmentSecretResolver:
    __slots__ = ("_environment",)

    def __init__(self, environment: Mapping[str, str] | None = None) -> None:
        self._environment = os.environ if environment is None else environment

    def resolve(self, reference: str) -> str:
        if not reference.startswith("env:"):
            raise SecretResolutionError(reference)
        value = self._environment.get(reference[4:])
        if value is None or not value:
            raise SecretResolutionError(reference)
        return value


def resolve_secret_reference(reference: str, resolver: SecretResolver) -> str:
    """Resolve one validated reference without retaining or exposing its value."""
    error: SecretResolutionError | None = None
    value = ""
    try:
        value = resolver.resolve(reference)
    except Exception:  # noqa: BLE001  # noqa: BROAD_EXCEPT_OK
        error = SecretResolutionError(reference)
    if error is not None:
        raise error from None
    if not isinstance(value, str) or not value:
        raise SecretResolutionError(reference) from None
    return value


resolve_secret = resolve_secret_reference


__all__ = (
    "EnvironmentSecretResolver",
    "SecretResolutionError",
    "SecretResolver",
    "resolve_secret",
    "resolve_secret_reference",
)
