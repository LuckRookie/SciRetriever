"""Pure construction of ordered Acquisition routing evidence.

This module performs no network, credential, policy, filesystem, or database
work.  It only reshapes already accepted neutral Literature/Metadata facts and
an optional landing origin that Network has resolved safely for this request.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum, unique

from sciretriever.acquisition.ports import AcquisitionRequest
from sciretriever.model.acquisition import AssetHint
from sciretriever.model.literature import Identifier
from sciretriever.model.metadata import LiteratureMetadata
from sciretriever.model.primitives import SourceKind

_CONTROL_CHARACTER = re.compile(r"[\x00-\x1f\x7f]")


def _nonblank(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    candidate = value.strip()
    if not candidate:
        raise ValueError(f"{field_name} must be nonblank")
    if _CONTROL_CHARACTER.search(candidate) is not None:
        raise ValueError(f"{field_name} must not contain control characters")
    return candidate


@dataclass(frozen=True, slots=True)
class ProviderRecordIdentity:
    """The exact provider and record locator carried by one observation."""

    provider_name: str
    record_id: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "provider_name",
            _nonblank(self.provider_name, field_name="provider_name"),
        )
        object.__setattr__(
            self,
            "record_id",
            _nonblank(self.record_id, field_name="record_id"),
        )


@dataclass(frozen=True, slots=True)
class ObservedAssetHint:
    """An AssetHint paired with its observation identity without vendor data."""

    hint: AssetHint
    source_name: str
    provider_record_identity: ProviderRecordIdentity | None

    def __post_init__(self) -> None:
        if not isinstance(self.hint, AssetHint):
            raise TypeError("hint must be an AssetHint")
        object.__setattr__(
            self,
            "source_name",
            _nonblank(self.source_name, field_name="source_name"),
        )
        if self.provider_record_identity is not None and not isinstance(
            self.provider_record_identity,
            ProviderRecordIdentity,
        ):
            raise TypeError("provider_record_identity must be neutral or None")


@dataclass(frozen=True, slots=True)
class StableProviderLocator:
    """A provider-oriented stable identifier other than a global DOI."""

    namespace: str
    value: str

    def __post_init__(self) -> None:
        object.__setattr__(
            self,
            "namespace",
            _nonblank(self.namespace, field_name="namespace").casefold(),
        )
        object.__setattr__(self, "value", _nonblank(self.value, field_name="value"))


@dataclass(frozen=True, slots=True)
class WeakRoutingHints:
    """Publisher/DOI-prefix hints that can never independently prove applicability."""

    publisher: str | None
    doi_prefixes: tuple[str, ...]

    def __post_init__(self) -> None:
        if self.publisher is not None:
            object.__setattr__(
                self,
                "publisher",
                _nonblank(self.publisher, field_name="publisher"),
            )
        if not isinstance(self.doi_prefixes, tuple):
            raise TypeError("doi_prefixes must be a tuple")
        object.__setattr__(
            self,
            "doi_prefixes",
            tuple(_nonblank(value, field_name="DOI prefix") for value in self.doi_prefixes),
        )


@unique
class RoutingEvidenceKind(str, Enum):
    """The Accepted order in which local Source evidence is interpreted."""

    ASSET_HINT = "asset-hint"
    STABLE_PROVIDER_LOCATOR = "stable-provider-locator"
    PROVIDER_RECORD_IDENTITY = "provider-record-identity"
    RESOLVED_LANDING_ORIGIN = "resolved-landing-origin"
    WEAK_PUBLISHER_OR_DOI_PREFIX = "weak-publisher-or-doi-prefix"


@dataclass(frozen=True, slots=True)
class AcquisitionEvidence:
    """Immutable request-local evidence consumed by planning and route execution."""

    metadata: LiteratureMetadata
    identifiers: tuple[Identifier, ...]
    asset_hints: tuple[ObservedAssetHint, ...]
    stable_provider_locators: tuple[StableProviderLocator, ...]
    provider_record_identities: tuple[ProviderRecordIdentity, ...]
    resolved_landing_origin: str | None
    weak_hints: WeakRoutingHints

    @property
    def priority(self) -> tuple[RoutingEvidenceKind, ...]:
        """Return only present evidence classes in their mandatory route order."""

        result: list[RoutingEvidenceKind] = []
        if self.asset_hints:
            result.append(RoutingEvidenceKind.ASSET_HINT)
        if self.stable_provider_locators:
            result.append(RoutingEvidenceKind.STABLE_PROVIDER_LOCATOR)
        if self.provider_record_identities:
            result.append(RoutingEvidenceKind.PROVIDER_RECORD_IDENTITY)
        if self.resolved_landing_origin is not None:
            result.append(RoutingEvidenceKind.RESOLVED_LANDING_ORIGIN)
        if self.weak_hints.publisher is not None or self.weak_hints.doi_prefixes:
            result.append(RoutingEvidenceKind.WEAK_PUBLISHER_OR_DOI_PREFIX)
        return tuple(result)


def build_acquisition_evidence(request: AcquisitionRequest) -> AcquisitionEvidence:
    """Build all routing evidence locally, preserving observation/config order."""

    if not isinstance(request, AcquisitionRequest):
        raise TypeError("request must be an AcquisitionRequest")

    provider_identities: list[ProviderRecordIdentity] = []
    asset_hints: list[ObservedAssetHint] = []
    for observation in request.observations:
        provenance = observation.provenance
        provider_identity: ProviderRecordIdentity | None = None
        if provenance.source_kind is SourceKind.METADATA_PROVIDER:
            record_id = provenance.source_record_id
            if record_id is None:
                raise ValueError("provider observation must carry a record identity")
            provider_identity = ProviderRecordIdentity(
                provider_name=provenance.source_name,
                record_id=record_id,
            )
            if provider_identity not in provider_identities:
                provider_identities.append(provider_identity)
        for hint in observation.asset_hints:
            asset_hints.append(
                ObservedAssetHint(
                    hint=hint,
                    source_name=provenance.source_name,
                    provider_record_identity=provider_identity,
                )
            )

    identifiers = request.literature.metadata.identifiers
    stable_locators = tuple(
        StableProviderLocator(namespace=identifier.namespace, value=identifier.value)
        for identifier in identifiers
        if identifier.namespace != "doi"
    )
    doi_prefixes: list[str] = []
    for identifier in identifiers:
        if identifier.namespace != "doi":
            continue
        prefix = identifier.value.partition("/")[0]
        if prefix not in doi_prefixes:
            doi_prefixes.append(prefix)

    return AcquisitionEvidence(
        metadata=request.literature.metadata,
        identifiers=identifiers,
        asset_hints=tuple(asset_hints),
        stable_provider_locators=stable_locators,
        provider_record_identities=tuple(provider_identities),
        resolved_landing_origin=request.resolved_landing_origin,
        weak_hints=WeakRoutingHints(
            publisher=request.literature.metadata.publisher,
            doi_prefixes=tuple(doi_prefixes),
        ),
    )


__all__ = (
    "AcquisitionEvidence",
    "ObservedAssetHint",
    "ProviderRecordIdentity",
    "RoutingEvidenceKind",
    "StableProviderLocator",
    "WeakRoutingHints",
    "build_acquisition_evidence",
)
