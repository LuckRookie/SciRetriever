from __future__ import annotations

from enum import Enum
from typing import assert_never

from pydantic import ValidationError

from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
    canonical_json_bytes,
    parse_canonical_json,
)
from sciretriever.model.collection import (
    CitationCollectionRequest,
    CitationRunInput,
    CollectionSeed,
    IdentifierSeed,
    SeedSelector,
    ValidatedCitationInput,
    WorkSeed,
    WorkVersionSeed,
)
from sciretriever.model.literature import Identifier
from sciretriever.model.primitives import (
    CitationDirection,
    CollectionId,
    WorkId,
    WorkVersionId,
    sha256_digest,
)


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
            return CanonicalJsonObject(
                (
                    ("kind", "identifier"),
                    ("namespace", identifier.namespace),
                    ("value", identifier.value),
                )
            )
        case CollectionSeed(collection_id=collection_id):
            return CanonicalJsonObject((("kind", "collection"), ("value", str(collection_id))))
        case unreachable:
            assert_never(unreachable)


def validate_citation_collection_request(value: CitationCollectionRequest) -> None:
    if not value.seed_selectors:
        raise BoundaryError.for_field("seed_selectors", "must be nonempty")
    if not value.providers:
        raise BoundaryError.for_field("providers", "must be nonempty names")
    if len(set(value.providers)) != len(value.providers):
        raise BoundaryError.for_field("providers", "must be unique")


def validated_citation_run_input(value: CitationRunInput) -> ValidatedCitationInput:
    payload = CanonicalJsonObject(
        (
            ("depth", value.depth),
            ("direction", value.direction.value),
            ("max_new", value.max_new),
            ("providers", value.providers),
            ("resolved_work_ids", tuple(str(item) for item in value.resolved_work_ids)),
            (
                "seed_selectors",
                tuple(_selector_value(item) for item in value.original_selectors),
            ),
        )
    )
    encoded = canonical_json_bytes(payload)
    return ValidatedCitationInput(
        canonical_json=encoded.decode("ascii"),
        sha256=sha256_digest(encoded),
    )


def validate_validated_citation_input(value: ValidatedCitationInput) -> None:
    payload = canonical_json_bytes(parse_canonical_json(value.canonical_json))
    if payload.decode("ascii") != value.canonical_json or sha256_digest(payload) != value.sha256:
        raise BoundaryError.for_field("citation_input", "must be canonical JSON with matching hash")


def _citation_run_input_from_validated(  # noqa: C901
    value: ValidatedCitationInput,
) -> CitationRunInput:
    payload = parse_canonical_json(value.canonical_json)
    if not isinstance(payload, CanonicalJsonObject):
        raise BoundaryError.for_field("citation_input", "must be an object")
    fields = dict(payload.entries)
    if fields.keys() != {
        "depth",
        "direction",
        "max_new",
        "providers",
        "resolved_work_ids",
        "seed_selectors",
    }:
        raise BoundaryError.for_field("citation_input", "must contain the approved fields")
    selectors_value = fields["seed_selectors"]
    resolved_value = fields["resolved_work_ids"]
    providers_value = fields["providers"]
    if (
        not isinstance(selectors_value, tuple)
        or not isinstance(resolved_value, tuple)
        or not isinstance(providers_value, tuple)
    ):
        raise BoundaryError.for_field("citation_input", "has invalid arrays")
    selectors: list[SeedSelector] = []
    for item in selectors_value:
        if not isinstance(item, CanonicalJsonObject):
            raise BoundaryError.for_field("seed_selectors", "must contain objects")
        selector = dict(item.entries)
        kind = _SeedKind(str(selector["kind"]))
        match kind:
            case _SeedKind.WORK:
                selectors.append(WorkSeed(work_id=WorkId(str(selector["value"]))))
            case _SeedKind.WORK_VERSION:
                selectors.append(
                    WorkVersionSeed(work_version_id=WorkVersionId(str(selector["value"])))
                )
            case _SeedKind.IDENTIFIER:
                selectors.append(
                    IdentifierSeed(
                        identifier=Identifier(
                            namespace=str(selector["namespace"]),
                            value=str(selector["value"]),
                        )
                    )
                )
            case _SeedKind.COLLECTION:
                selectors.append(CollectionSeed(collection_id=CollectionId(str(selector["value"]))))
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
        original_selectors=tuple(selectors),
        resolved_work_ids=tuple(resolved),
        providers=tuple(providers),
        direction=CitationDirection(direction),
        depth=depth,
        max_new=max_new,
    )


def citation_run_input_from_validated(value: ValidatedCitationInput) -> CitationRunInput:
    try:
        validate_validated_citation_input(value)
        return _citation_run_input_from_validated(value)
    except ValidationError as error:
        raise BoundaryError.for_field(
            "citation_input", "must contain valid primitive values"
        ) from error


__all__ = (
    "citation_run_input_from_validated",
    "validate_citation_collection_request",
    "validate_validated_citation_input",
    "validated_citation_run_input",
)
