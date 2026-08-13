"""Pure identity decisions for concrete Literature versions.

The identity boundary consumes only the neutral Model objects.  Identifier
canonicalization is owned by :class:`sciretriever.model.literature.Identifier`;
this module compares those canonical values and never parses provider URLs,
record payloads, paths, SQL rows, or vendor objects.

The pure identity operations are intentionally separate:

* :func:`resolve_literature_identity` decides whether one metadata projection
  describes an existing concrete ``Literature``.  It uses exact stable
  identifiers first and an all-fields-present bibliographic key only when both
  sides have no stable identifier.
* :func:`provider_key_matches_seed` checks whether one provider-scoped key is
  fully supported by the committed observation closure of one concrete seed.
* :func:`resolve_meta_literature` decides whether a source observation has
  enough explicit ``version_links`` evidence to move another concrete version
  into the current ``MetaLiterature`` aggregate.  A provider record ID is only
  compared with another observation's provider record ID in the same provider
  scope; it is never treated as a Literature identifier.

No function in this module creates or mutates a Model object, performs I/O, or
assigns business state.  The returned decisions are inputs for the later
Literature service and storage transaction.
"""

from __future__ import annotations

import json
import unicodedata
from collections.abc import Iterable
from typing import Literal, TypeAlias

from pydantic import BaseModel, ConfigDict, model_validator

from sciretriever.model.literature import Literature
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
)
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    Sha256,
    SourceKind,
    sha256_digest,
)

StableIdentifierKey: TypeAlias = tuple[str, str]
FallbackIdentityKey: TypeAlias = tuple[str, tuple[str, ...], int, str]
IdentityIndex: TypeAlias = tuple[StableIdentifierKey, ...]
IdentityDecisionKind: TypeAlias = Literal["created", "matched", "identity-conflict"]
MetaLiteratureDecisionKind: TypeAlias = Literal["linked", "independent", "identity-conflict"]

# Only namespaces whose official Literature semantics are fixed by the target
# contract participate in cross-source identity matching.  An Identifier in a
# different namespace remains valid Model data, but its value is deliberately
# not guessed to be a Literature identity here.
STABLE_IDENTIFIER_NAMESPACES = frozenset({"doi", "arxiv", "pmid", "pmcid"})

_FALLBACK_IDENTITY_HASH_TAG = "sciretriever-literature-fallback-identity-v1"


class _IdentityModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class IdentityDecision(_IdentityModel):
    """Pure result of matching metadata against existing Literature values."""

    decision: IdentityDecisionKind
    literature: Literature | None = None
    reason: str | None = None

    @model_validator(mode="after")
    def validate_combination(self) -> "IdentityDecision":
        if self.decision == "matched" and self.literature is None:
            raise ValueError("matched identity decision requires literature")
        if self.decision != "matched" and self.literature is not None:
            raise ValueError("non-matched identity decision cannot carry literature")
        return self


class VersionEvidence(_IdentityModel):
    """A concrete Literature together with its source observations.

    ``MetadataObservation`` intentionally has no Literature ID.  This small
    service-side value lets a caller provide the already-resolved observation
    ownership needed to check a provider-scoped ``version_links`` target,
    without introducing a persistent relation or a vendor-shaped object.
    """

    literature: Literature
    observations: tuple[MetadataObservation, ...]


class MetaLiteratureDecision(_IdentityModel):
    """Pure result of checking an explicit version-link aggregation claim."""

    decision: MetaLiteratureDecisionKind
    meta_literature_id: MetaLiteratureId | None = None
    linked_literature_ids: tuple[LiteratureId, ...] = ()

    @model_validator(mode="after")
    def validate_combination(self) -> "MetaLiteratureDecision":
        if self.decision == "linked":
            if self.meta_literature_id is None or not self.linked_literature_ids:
                raise ValueError("linked decision requires aggregate and Literature IDs")
        elif self.meta_literature_id is not None or self.linked_literature_ids:
            raise ValueError("non-linked decision cannot carry aggregation IDs")
        return self


def normalize_identity_text(value: str) -> str:
    """Build the exact comparison key for a title or author display name.

    The operation is intentionally limited to Unicode NFC, boundary trimming,
    consecutive Unicode-whitespace folding, and casefold.  Punctuation,
    hyphens, name order, initials, and other display semantics remain intact.
    """

    if type(value) is not str:
        raise TypeError("identity text must be a string")
    normalized = unicodedata.normalize("NFC", value)
    return " ".join(normalized.split()).casefold()


def stable_identifier_keys(metadata: LiteratureMetadata) -> frozenset[StableIdentifierKey]:
    """Return only canonical, identity-bearing Identifier values.

    Unknown namespaces are intentionally excluded.  Their canonical Model
    values can still be retained in metadata and provenance, but the identity
    module has no authority to infer their official semantics.
    """

    _require_metadata(metadata)
    return frozenset(
        (identifier.namespace, identifier.value)
        for identifier in metadata.identifiers
        if identifier.namespace in STABLE_IDENTIFIER_NAMESPACES
    )


def stable_identifier_index(metadata: LiteratureMetadata) -> IdentityIndex:
    """Return the deterministic ordered identity index for stable identifiers.

    The set-returning :func:`stable_identifier_keys` function remains useful to
    the pure matching rules.  Ports and Storage need a deterministic value,
    however, so this public helper supplies the same canonical keys in a stable
    order without exposing any private matcher implementation.
    """

    return tuple(sorted(stable_identifier_keys(metadata)))


def provider_key_matches_seed(
    *,
    provider_name: str,
    key: ProviderLiteratureKey,
    seed_observations: tuple[MetadataObservation, ...],
) -> bool:
    """Return whether a provider key reliably locates one concrete seed.

    ``record_id`` is provider-scoped source identity and therefore matches only
    an exact record ID on a metadata-provider observation from ``provider_name``.
    Stable Literature identifiers are canonical Model values and may be
    contributed by any observation in the seed closure, including a user
    bibliographic import.  When both forms are supplied, both must be supported,
    although they need not occur on the same observation.

    Unknown identifier namespaces are retained Model data but provide no match
    evidence.  Multiple distinct values in one stable namespace on ``key`` are
    contradictory and fail closed.
    """

    if type(provider_name) is not str:
        raise TypeError("provider_name must be a string")
    if not provider_name.strip():
        raise ValueError("provider_name must be nonblank")
    if not isinstance(key, ProviderLiteratureKey):
        raise TypeError("key must be a ProviderLiteratureKey")
    if not isinstance(seed_observations, tuple):
        raise TypeError("seed_observations must be a tuple")
    if any(not isinstance(value, MetadataObservation) for value in seed_observations):
        raise TypeError("seed_observations must contain MetadataObservation values")

    key_stable = stable_identifier_keys(LiteratureMetadata(identifiers=key.identifiers))
    if any(len(values) > 1 for values in _by_namespace(key_stable).values()):
        return False

    seed_stable: set[StableIdentifierKey] = set()
    for observation in seed_observations:
        seed_stable.update(stable_identifier_keys(observation.metadata))

    record_matches = key.record_id is not None and any(
        observation.provenance.source_kind is SourceKind.METADATA_PROVIDER
        and observation.provenance.source_name == provider_name
        and observation.provenance.source_record_id == key.record_id
        for observation in seed_observations
    )
    if key.record_id is not None and not record_matches:
        return False
    if key_stable and not key_stable.issubset(seed_stable):
        return False
    return record_matches or bool(key_stable)


def fallback_identity_key(metadata: LiteratureMetadata) -> FallbackIdentityKey | None:
    """Return the strict four-field fallback key, or ``None`` if incomplete."""

    _require_metadata(metadata)
    if (
        metadata.title is None
        or not metadata.authors
        or metadata.publication_year is None
        or metadata.document_type is None
    ):
        return None
    return (
        normalize_identity_text(metadata.title),
        tuple(normalize_identity_text(author.display_name) for author in metadata.authors),
        metadata.publication_year,
        metadata.document_type,
    )


def fallback_identity_sha256(key: FallbackIdentityKey) -> Sha256:
    """Hash one complete fallback key under its own stable domain tag.

    The digest is only a bounded Storage lookup key.  A hit is never identity
    proof: :func:`resolve_literature_identity` recomputes and compares the
    complete four-field key from every returned Literature, so a SHA-256
    collision cannot turn a different bibliographic record into a match.
    """

    if (
        not isinstance(key, tuple)
        or len(key) != 4
        or not isinstance(key[0], str)
        or not isinstance(key[1], tuple)
        or any(not isinstance(author, str) for author in key[1])
        or type(key[2]) is not int
        or not isinstance(key[3], str)
    ):
        raise TypeError("key must be a FallbackIdentityKey")
    payload = {
        "schema": _FALLBACK_IDENTITY_HASH_TAG,
        "value": key,
    }
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return sha256_digest(encoded)


def resolve_literature_identity(  # noqa: C901
    incoming: LiteratureMetadata,
    existing: Iterable[Literature],
) -> IdentityDecision:
    """Resolve one metadata projection against existing concrete Literature.

    A stable identifier match is accepted only when every matched identifier
    points to the same concrete Literature and no same-namespace value on that
    Literature conflicts with the incoming evidence.  Any stable conflict is a
    fail-closed ``identity-conflict`` result.  If no stable identifier is
    present on either side, an exact four-field fallback key may match one
    existing Literature; ambiguous fallback matches also fail closed.
    """

    _require_metadata(incoming)
    candidates = _materialize_literature(existing)
    incoming_stable = stable_identifier_keys(incoming)
    incoming_by_namespace = _by_namespace(incoming_stable)

    if any(len(values) > 1 for values in incoming_by_namespace.values()):
        return IdentityDecision(
            decision="identity-conflict",
            reason="incoming-stable-identifier-conflict",
        )

    matched_by_identifier: dict[LiteratureId, Literature] = {}
    for literature in candidates:
        existing_stable = stable_identifier_keys(literature.metadata)
        if incoming_stable & existing_stable:
            matched_by_identifier[literature.literature_id] = literature

    matched = tuple(matched_by_identifier.values())
    if len(matched) > 1:
        return IdentityDecision(
            decision="identity-conflict",
            reason="stable-identifier-ambiguity",
        )

    if matched:
        literature = matched[0]
        existing_stable = stable_identifier_keys(literature.metadata)
        existing_by_namespace = _by_namespace(existing_stable)
        for namespace, values in incoming_by_namespace.items():
            if len(values) > 1:
                return IdentityDecision(
                    decision="identity-conflict",
                    reason="incoming-stable-identifier-conflict",
                )
            if existing_by_namespace.get(namespace, frozenset()) - values:
                return IdentityDecision(
                    decision="identity-conflict",
                    reason="stable-identifier-conflict",
                )
        return IdentityDecision(
            decision="matched",
            literature=literature,
            reason="stable-identifier",
        )

    if incoming_stable:
        return IdentityDecision(decision="created", reason="no-stable-identifier-match")

    fallback = fallback_identity_key(incoming)
    if fallback is None:
        return IdentityDecision(decision="created", reason="incomplete-fallback-key")
    fallback_matches = tuple(
        literature
        for literature in candidates
        if not stable_identifier_keys(literature.metadata)
        and fallback_identity_key(literature.metadata) == fallback
    )
    if len(fallback_matches) > 1:
        return IdentityDecision(decision="identity-conflict", reason="fallback-ambiguity")
    if fallback_matches:
        return IdentityDecision(
            decision="matched",
            literature=fallback_matches[0],
            reason="fallback",
        )
    return IdentityDecision(decision="created", reason="no-fallback-match")


def resolve_meta_literature(
    current: Literature,
    observation: MetadataObservation,
    candidates: Iterable[VersionEvidence],
) -> MetaLiteratureDecision:
    """Accept only explicit provider ``version_links`` as version aggregation.

    The current observation identifies the current endpoint.  A link is valid
    only when every supplied part of its ``ProviderLiteratureKey`` is found in
    one target observation: stable identifiers compare against that target
    observation's canonical Literature identifiers, while ``record_id``
    compares only within the current observation's provider scope.  Title,
    author, version role, shared publisher, and provider record IDs in
    metadata identifiers are never used as implicit links.
    """

    if not isinstance(current, Literature):
        raise TypeError("current must be a Literature")
    if not isinstance(observation, MetadataObservation):
        raise TypeError("observation must be a MetadataObservation")
    evidence = _materialize_evidence(candidates)
    if observation.provenance.source_kind is not SourceKind.METADATA_PROVIDER:
        return MetaLiteratureDecision(decision="independent")
    if not observation.version_links:
        return MetaLiteratureDecision(decision="independent")

    matched: dict[LiteratureId, Literature] = {}
    for candidate in evidence:
        if any(
            _version_key_matches(key, observation, target_observation)
            for key in observation.version_links
            for target_observation in candidate.observations
        ):
            matched[candidate.literature.literature_id] = candidate.literature

    targets = tuple(matched.values())
    if len(targets) > 1:
        return MetaLiteratureDecision(decision="identity-conflict")
    if not targets:
        return MetaLiteratureDecision(decision="independent")

    target = targets[0]
    linked_ids = (
        (current.literature_id,)
        if target.literature_id == current.literature_id
        else (
            current.literature_id,
            target.literature_id,
        )
    )
    return MetaLiteratureDecision(
        decision="linked",
        meta_literature_id=current.meta_literature_id,
        linked_literature_ids=linked_ids,
    )


def _require_metadata(value: object) -> None:
    if not isinstance(value, LiteratureMetadata):
        raise TypeError("metadata must be a LiteratureMetadata")


def _materialize_literature(values: Iterable[Literature]) -> tuple[Literature, ...]:
    if isinstance(values, (str, bytes)):
        raise TypeError("existing must contain Literature values")
    try:
        result = tuple(values)
    except TypeError as error:
        raise TypeError("existing must be an iterable of Literature values") from error
    if any(not isinstance(value, Literature) for value in result):
        raise TypeError("existing must contain Literature values")
    return result


def _materialize_evidence(values: Iterable[VersionEvidence]) -> tuple[VersionEvidence, ...]:
    if isinstance(values, (str, bytes)):
        raise TypeError("candidates must contain VersionEvidence values")
    try:
        result = tuple(values)
    except TypeError as error:
        raise TypeError("candidates must be an iterable of VersionEvidence values") from error
    if any(not isinstance(value, VersionEvidence) for value in result):
        raise TypeError("candidates must contain VersionEvidence values")
    return result


def _by_namespace(
    identifiers: Iterable[StableIdentifierKey],
) -> dict[str, frozenset[str]]:
    values: dict[str, set[str]] = {}
    for namespace, value in identifiers:
        values.setdefault(namespace, set()).add(value)
    return {namespace: frozenset(items) for namespace, items in values.items()}


def _version_key_matches(
    key: ProviderLiteratureKey,
    current: MetadataObservation,
    target: MetadataObservation,
) -> bool:
    return provider_key_matches_seed(
        provider_name=current.provenance.source_name,
        key=key,
        seed_observations=(target,),
    )


__all__ = (
    "FallbackIdentityKey",
    "IdentityIndex",
    "IdentityDecision",
    "IdentityDecisionKind",
    "MetaLiteratureDecision",
    "MetaLiteratureDecisionKind",
    "STABLE_IDENTIFIER_NAMESPACES",
    "StableIdentifierKey",
    "VersionEvidence",
    "fallback_identity_key",
    "fallback_identity_sha256",
    "normalize_identity_text",
    "provider_key_matches_seed",
    "resolve_literature_identity",
    "resolve_meta_literature",
    "stable_identifier_keys",
    "stable_identifier_index",
)
