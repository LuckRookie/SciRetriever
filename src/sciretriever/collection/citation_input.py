from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TypeAlias, assert_never

from sciretriever.kernel import (
    BoundaryError, CanonicalJsonObject, CitationDirection, CollectionId, Identifier,
    Sha256, WorkId, WorkVersionId, canonical_json_bytes, parse_canonical_json,
)


@dataclass(frozen=True, slots=True)
class WorkSeed:
    work_id: WorkId


@dataclass(frozen=True, slots=True)
class WorkVersionSeed:
    work_version_id: WorkVersionId


@dataclass(frozen=True, slots=True)
class IdentifierSeed:
    identifier: Identifier


@dataclass(frozen=True, slots=True)
class CollectionSeed:
    collection_id: CollectionId


SeedSelector: TypeAlias = WorkSeed | WorkVersionSeed | IdentifierSeed | CollectionSeed


class _SeedKind(str, Enum):
    WORK = "work"
    WORK_VERSION = "work-version"
    IDENTIFIER = "identifier"
    COLLECTION = "collection"


def _selector_value(selector: SeedSelector) -> CanonicalJsonObject:
    match selector:
        case WorkSeed(work_id=work_id):
            return CanonicalJsonObject((("kind", "work"), ("value", str(work_id))))
        case WorkVersionSeed(work_version_id=version_id):
            return CanonicalJsonObject((("kind", "work-version"), ("value", str(version_id))))
        case IdentifierSeed(identifier=identifier):
            return CanonicalJsonObject((
                ("kind", "identifier"), ("namespace", identifier.namespace),
                ("value", identifier.value),
            ))
        case CollectionSeed(collection_id=collection_id):
            return CanonicalJsonObject((("kind", "collection"), ("value", str(collection_id))))
        case unreachable:
            assert_never(unreachable)


@dataclass(frozen=True, slots=True)
class CitationCollectionRequest:
    seed_selectors: tuple[SeedSelector, ...]
    providers: tuple[str, ...]
    direction: CitationDirection
    depth: int
    max_new: int

    def __post_init__(self) -> None:
        if not self.seed_selectors:
            raise BoundaryError.for_field("seed_selectors", "must be nonempty")
        if not self.providers or any(not isinstance(item, str) or not item.strip() for item in self.providers):
            raise BoundaryError.for_field("providers", "must be nonempty names")
        if len(set(self.providers)) != len(self.providers):
            raise BoundaryError.for_field("providers", "must be unique")
        if not isinstance(self.depth, int) or isinstance(self.depth, bool) or self.depth < 0:
            raise BoundaryError.for_field("depth", "must be a nonnegative integer")
        if not isinstance(self.max_new, int) or isinstance(self.max_new, bool) or self.max_new < 1:
            raise BoundaryError.for_field("max_new", "must be a positive integer")
        if not isinstance(self.direction, CitationDirection):
            raise BoundaryError.for_field("direction", "must be a CitationDirection")


@dataclass(frozen=True, slots=True)
class CitationRunInput:
    original_selectors: tuple[SeedSelector, ...]
    resolved_work_ids: tuple[WorkId, ...]
    providers: tuple[str, ...]
    direction: CitationDirection
    depth: int
    max_new: int

    def validated(self) -> ValidatedCitationInput:
        payload = CanonicalJsonObject((
            ("depth", self.depth), ("direction", self.direction.value),
            ("max_new", self.max_new), ("providers", self.providers),
            ("resolved_work_ids", tuple(str(item) for item in self.resolved_work_ids)),
            ("seed_selectors", tuple(_selector_value(item) for item in self.original_selectors)),
        ))
        encoded = canonical_json_bytes(payload)
        return ValidatedCitationInput(encoded.decode("ascii"), Sha256.from_bytes(encoded))


@dataclass(frozen=True, slots=True)
class ValidatedCitationInput:
    canonical_json: str
    sha256: Sha256

    def __post_init__(self) -> None:
        payload = canonical_json_bytes(parse_canonical_json(self.canonical_json))
        if payload.decode("ascii") != self.canonical_json or Sha256.from_bytes(payload) != self.sha256:
            raise BoundaryError.for_field("citation_input", "must be canonical JSON with matching hash")


def citation_run_input_from_validated(value: ValidatedCitationInput) -> CitationRunInput:
    payload = parse_canonical_json(value.canonical_json)
    if not isinstance(payload, CanonicalJsonObject):
        raise BoundaryError.for_field("citation_input", "must be an object")
    fields = dict(payload.entries)
    if fields.keys() != {
        "depth", "direction", "max_new", "providers", "resolved_work_ids", "seed_selectors",
    }:
        raise BoundaryError.for_field("citation_input", "must contain the approved fields")
    selectors_value = fields["seed_selectors"]
    resolved_value = fields["resolved_work_ids"]
    providers_value = fields["providers"]
    if not isinstance(selectors_value, tuple) or not isinstance(resolved_value, tuple) or not isinstance(providers_value, tuple):
        raise BoundaryError.for_field("citation_input", "has invalid arrays")
    selectors: list[SeedSelector] = []
    for item in selectors_value:
        if not isinstance(item, CanonicalJsonObject):
            raise BoundaryError.for_field("seed_selectors", "must contain objects")
        selector = dict(item.entries)
        kind = _SeedKind(str(selector["kind"]))
        match kind:
            case _SeedKind.WORK:
                selectors.append(WorkSeed(WorkId(str(selector["value"]))))
            case _SeedKind.WORK_VERSION:
                selectors.append(WorkVersionSeed(WorkVersionId(str(selector["value"]))))
            case _SeedKind.IDENTIFIER:
                selectors.append(IdentifierSeed(Identifier(str(selector["namespace"]), str(selector["value"]))))
            case _SeedKind.COLLECTION:
                selectors.append(CollectionSeed(CollectionId(str(selector["value"]))))
            case unreachable:
                assert_never(unreachable)
    direction = fields["direction"]
    depth = fields["depth"]
    max_new = fields["max_new"]
    if not isinstance(direction, str) or not isinstance(depth, int) or not isinstance(max_new, int):
        raise BoundaryError.for_field("citation_input", "has invalid controls")
    resolved: list[WorkId] = []
    for item in resolved_value:
        if not isinstance(item, str):
            raise BoundaryError.for_field("resolved_work_ids", "must contain strings")
        resolved.append(WorkId(item))
    providers: list[str] = []
    for item in providers_value:
        if not isinstance(item, str):
            raise BoundaryError.for_field("providers", "must contain strings")
        providers.append(item)
    return CitationRunInput(
        tuple(selectors), tuple(resolved), tuple(providers),
        CitationDirection(direction), depth, max_new,
    )


__all__ = (
    "CitationCollectionRequest", "CitationRunInput", "CollectionSeed", "IdentifierSeed",
    "SeedSelector", "ValidatedCitationInput", "WorkSeed", "WorkVersionSeed",
    "citation_run_input_from_validated",
)
