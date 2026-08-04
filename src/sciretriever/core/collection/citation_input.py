from __future__ import annotations

from collections.abc import Mapping
from enum import Enum

from typing_extensions import assert_never

from sciretriever.model.canonical_json import (
    CanonicalJsonObject,
    CanonicalJsonValue,
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

from .errors import CollectionRuleError


class _SeedKind(str, Enum):
    WORK = "work"
    WORK_VERSION = "work-version"
    IDENTIFIER = "identifier"
    COLLECTION = "collection"


def _selector_value(selector: SeedSelector) -> CanonicalJsonObject:
    match selector:
        case WorkSeed(work_id=work_id):
            return CanonicalJsonObject(
                (
                    ("kind", "work"),
                    ("value", str(work_id)),
                )
            )
        case WorkVersionSeed(work_version_id=version_id):
            return CanonicalJsonObject(
                (
                    ("kind", "work-version"),
                    ("value", str(version_id)),
                )
            )
        case IdentifierSeed(identifier=identifier):
            return CanonicalJsonObject(
                (
                    ("kind", "identifier"),
                    ("namespace", identifier.namespace),
                    ("value", identifier.value),
                )
            )
        case CollectionSeed(collection_id=collection_id):
            return CanonicalJsonObject(
                (
                    ("kind", "collection"),
                    ("value", str(collection_id)),
                )
            )
        case unreachable:
            assert_never(unreachable)


def validate_citation_collection_request(value: CitationCollectionRequest) -> None:
    """Validate the user-facing controls required to start citation collection."""
    if not value.seed_selectors:
        raise CollectionRuleError.for_field("seed_selectors", "must be nonempty")
    if not value.providers:
        raise CollectionRuleError.for_field("providers", "must be nonempty names")
    if len(set(value.providers)) != len(value.providers):
        raise CollectionRuleError.for_field("providers", "must be unique")


def validated_citation_run_input(value: CitationRunInput) -> ValidatedCitationInput:
    """Create the canonical, hashed representation of resolved citation input."""
    payload = CanonicalJsonObject(
        (
            ("depth", value.depth),
            ("direction", value.direction.value),
            ("max_new", value.max_new),
            ("providers", value.providers),
            ("resolved_work_ids", tuple(str(item) for item in value.resolved_work_ids)),
            ("seed_selectors", tuple(_selector_value(item) for item in value.original_selectors)),
        )
    )
    encoded = canonical_json_bytes(payload)
    return ValidatedCitationInput(
        canonical_json=encoded.decode("ascii"),
        sha256=sha256_digest(encoded),
    )


def validate_validated_citation_input(value: ValidatedCitationInput) -> None:
    """Reject citation input whose canonical bytes or hash changed."""
    try:
        payload = canonical_json_bytes(parse_canonical_json(value.canonical_json))
    except (TypeError, ValueError) as error:
        raise CollectionRuleError.for_field(
            "citation_input", "must be canonical JSON with matching hash"
        ) from error
    if payload.decode("ascii") != value.canonical_json or sha256_digest(payload) != value.sha256:
        raise CollectionRuleError.for_field(
            "citation_input", "must be canonical JSON with matching hash"
        )


def _selector_text(selector: Mapping[str, CanonicalJsonValue], key: str) -> str:
    value = selector.get(key)
    if not isinstance(value, str) or not value.strip():
        raise CollectionRuleError.for_field("seed_selectors", f"{key} must be nonblank text")
    return value


def _parse_selector(value: CanonicalJsonObject) -> SeedSelector:
    selector = dict(value.entries)
    kind = _SeedKind(_selector_text(selector, "kind"))
    match kind:
        case _SeedKind.WORK:
            if selector.keys() != {"kind", "value"}:
                raise CollectionRuleError.for_field("seed_selectors", "has invalid work fields")
            return WorkSeed(work_id=WorkId(_selector_text(selector, "value")))
        case _SeedKind.WORK_VERSION:
            if selector.keys() != {"kind", "value"}:
                raise CollectionRuleError.for_field(
                    "seed_selectors", "has invalid work-version fields"
                )
            return WorkVersionSeed(work_version_id=WorkVersionId(_selector_text(selector, "value")))
        case _SeedKind.IDENTIFIER:
            if selector.keys() != {"kind", "namespace", "value"}:
                raise CollectionRuleError.for_field(
                    "seed_selectors", "has invalid identifier fields"
                )
            return IdentifierSeed(
                identifier=Identifier(
                    namespace=_selector_text(selector, "namespace"),
                    value=_selector_text(selector, "value"),
                )
            )
        case _SeedKind.COLLECTION:
            if selector.keys() != {"kind", "value"}:
                raise CollectionRuleError.for_field(
                    "seed_selectors", "has invalid collection fields"
                )
            return CollectionSeed(collection_id=CollectionId(_selector_text(selector, "value")))
        case unreachable:
            assert_never(unreachable)


def _citation_run_input_from_validated(  # noqa: C901
    value: ValidatedCitationInput,
) -> CitationRunInput:
    payload = parse_canonical_json(value.canonical_json)
    if not isinstance(payload, CanonicalJsonObject):
        raise CollectionRuleError.for_field("citation_input", "must be an object")
    fields = dict(payload.entries)
    approved_fields = {
        "depth",
        "direction",
        "max_new",
        "providers",
        "resolved_work_ids",
        "seed_selectors",
    }
    if fields.keys() != approved_fields:
        raise CollectionRuleError.for_field("citation_input", "must contain the approved fields")
    selectors_value = fields["seed_selectors"]
    resolved_value = fields["resolved_work_ids"]
    providers_value = fields["providers"]
    if (
        not isinstance(selectors_value, tuple)
        or not isinstance(resolved_value, tuple)
        or not isinstance(providers_value, tuple)
    ):
        raise CollectionRuleError.for_field("citation_input", "has invalid arrays")
    selectors: list[SeedSelector] = []
    for item in selectors_value:
        if not isinstance(item, CanonicalJsonObject):
            raise CollectionRuleError.for_field("seed_selectors", "must contain objects")
        selectors.append(_parse_selector(item))
    direction = fields["direction"]
    depth = fields["depth"]
    max_new = fields["max_new"]
    if (
        not isinstance(direction, str)
        or not isinstance(depth, int)
        or isinstance(depth, bool)
        or not isinstance(max_new, int)
        or isinstance(max_new, bool)
    ):
        raise CollectionRuleError.for_field("citation_input", "has invalid controls")
    resolved: list[WorkId] = []
    for item in resolved_value:
        if not isinstance(item, str):
            raise CollectionRuleError.for_field("resolved_work_ids", "must contain strings")
        resolved.append(WorkId(item))
    providers: list[str] = []
    for item in providers_value:
        if not isinstance(item, str):
            raise CollectionRuleError.for_field("providers", "must contain strings")
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
    """Parse and verify persisted citation input into the typed Model contract."""
    try:
        validate_validated_citation_input(value)
        return _citation_run_input_from_validated(value)
    except CollectionRuleError:
        raise
    except (KeyError, TypeError, ValueError) as error:
        raise CollectionRuleError.for_field(
            "citation_input", "must contain valid primitive values"
        ) from error


__all__ = (
    "citation_run_input_from_validated",
    "validate_citation_collection_request",
    "validate_validated_citation_input",
    "validated_citation_run_input",
)
