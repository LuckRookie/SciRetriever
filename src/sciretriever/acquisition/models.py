"""Typed contracts for single-provider P4 acquisition."""

from __future__ import annotations

from dataclasses import dataclass, field
import re
from typing import Mapping, Protocol

from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.core.validation import normalize_media_type
from sciretriever.network import HttpResponse, Transport


_PROVIDER_NAME = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


def validate_provider_name(value: str) -> str:
    if not isinstance(value, str):
        raise TypeError("provider must be a string")
    normalized = value.strip()
    if not _PROVIDER_NAME.fullmatch(normalized):
        raise ValueError("provider must be a lowercase name using letters, digits, and hyphens")
    return normalized


class AcquisitionTransport(Transport, Protocol):
    def resolve_host(self, hostname: str) -> tuple[str, ...]: ...

@dataclass(frozen=True, slots=True)
class AcquisitionTarget:
    identifiers: tuple[Identifier, ...]
    direct_url: str | None = None
    role: AssetRole = AssetRole.PRIMARY_PDF

    def __post_init__(self) -> None:
        if not isinstance(self.role, AssetRole):
            raise TypeError("role must be an AssetRole")


@dataclass(frozen=True, slots=True)
class ProviderContent:
    role: AssetRole
    media_type: str
    format: str
    source_url: str
    provider: str
    data: bytes
    provenance: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "media_type", normalize_media_type(self.media_type))


class AcquisitionProvider(Protocol):
    name: str

    def initial_url(self, target: AcquisitionTarget) -> str: ...

    def acquire(self, target: AcquisitionTarget, *, timeout: float) -> ProviderContent: ...


@dataclass(frozen=True, slots=True)
class AdmissionResult:
    work_version_id: str
    job_id: str | None
    request_key: str
    provider: str
    asset_role: AssetRole = AssetRole.PRIMARY_PDF
    reused_asset_id: str | None = None
    work_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "provider", validate_provider_name(self.provider))
        if not isinstance(self.asset_role, AssetRole):
            raise TypeError("asset_role must be an AssetRole")


@dataclass(frozen=True, slots=True)
class AcquisitionResult:
    work_version_id: str
    job_id: str | None
    status: str
    raw_asset_id: str | None = None
    attempt_id: str | None = None
    error: str | None = None
    work_id: str | None = None
