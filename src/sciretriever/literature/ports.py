"""Literature-owned persistence capabilities.

The interfaces in this module are consumed by :mod:`sciretriever.literature`
and implemented by Storage.  They accept only already validated neutral Model
values and small closed operation commands.  No SQL connection, file path,
HTTP response, vendor payload, parser object, or LLM object crosses this
boundary.
"""

from __future__ import annotations

import json
from contextlib import AbstractContextManager
from typing import BinaryIO, Protocol, TypeAlias, TypeVar, cast, runtime_checkable

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from sciretriever.literature.content import (
    ContentAcceptanceReplacement,
    canonical_literature_content_json,
    literature_content_artifact,
    metadata_sha256,
)
from sciretriever.literature.query import (
    LiteratureCursorError,
    ReferenceCursorPosition,
    SearchCursorPosition,
    decode_reference_cursor,
    decode_search_cursor,
    encode_reference_cursor,
    encode_search_cursor,
    first_missing_step,
    fts5_index_text,
    normalize_contains_text,
    normalized_contains,
    quoted_fts5_and_query,
    reference_sort_key,
    relevance_sort_key,
)
from sciretriever.literature.references import ReferenceCleanupDecision
from sciretriever.literature.state import (
    CurrentContentLineage,
    CurrentLiteratureFacts,
    CurrentPrimaryPdf,
    derive_status,
)
from sciretriever.model.acquisition import Asset
from sciretriever.model.analysis import ArtifactRef, analysis_input_sha256
from sciretriever.model.library import (
    LibrarySearchPage,
    LibrarySearchRequest,
    LiteratureDetail,
    LiteratureReferencePage,
    LiteratureReferenceRequest,
    ReferenceDetail,
)
from sciretriever.model.literature import (
    Literature,
    MetaLiterature,
    Reference,
    ReferenceSupport,
)
from sciretriever.model.metadata import MetadataObservation, ProviderRelationObservation
from sciretriever.model.parsing import ParserArtifactRef
from sciretriever.model.primitives import (
    AssetId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ReferenceId,
    Sha256,
    sha256_digest,
)

_CONTENT_REFERENCE_CLOSURE_HASH_TAG = "sciretriever-content-reference-closure-v1"
_T = TypeVar("_T")

LiteratureArtifactReference: TypeAlias = Asset | ParserArtifactRef | ArtifactRef


@runtime_checkable
class StructuredContentArtifactContent(Protocol):
    """Path-free, repeatably-openable canonical structured JSON bytes."""

    def open(self) -> AbstractContextManager[BinaryIO]: ...


class LiteratureArtifactReadError(RuntimeError):
    """Stable, path-free failure at Literature's artifact-read boundary."""

    _DEFAULT_MESSAGE = "literature artifact read failed"

    def __init__(self, _message: object | None = None) -> None:
        super().__init__(self._DEFAULT_MESSAGE)


class _PortModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


def _tuple_if_list(value: object) -> object:
    if isinstance(value, list):
        return tuple(cast(list[object], value))
    return value


def _nested_tuple_if_list(value: object) -> object:
    if isinstance(value, list):
        return tuple(
            tuple(cast(list[object], item)) if isinstance(item, list) else item
            for item in cast(list[object], value)
        )
    return value


def _typed_tuple(value: object, expected: type[_T], message: str) -> tuple[_T, ...]:
    if not isinstance(value, tuple):
        raise TypeError(message)
    items = cast(tuple[object, ...], value)
    if any(not isinstance(item, expected) for item in items):
        raise TypeError(message)
    return cast(tuple[_T, ...], items)


class LiteratureObservation(_PortModel):
    """One already resolved observation-to-Literature relation."""

    literature_id: LiteratureId
    observation: MetadataObservation


class ContentReferenceClosureToken(_PortModel):
    """CAS token for every outbound Reference and support of one Literature."""

    source_literature_id: LiteratureId
    reference_count: int = Field(strict=True, ge=0)
    support_count: int = Field(strict=True, ge=0)
    closure_sha256: Sha256


def content_reference_closure_token(
    source_literature_id: LiteratureId,
    references: tuple[Reference, ...],
    supports: tuple[ReferenceSupport, ...],
) -> ContentReferenceClosureToken:
    """Build the complete tagged cleanup closure token.

    The token is a concurrency/completeness precondition, not a new Reference
    fact.  It prevents an omitted or concurrently appended last support from
    making Literature delete a still-supported Reference during content
    replacement.
    """

    source_value = cast(object, source_literature_id)
    references_value = cast(object, references)
    supports_value = cast(object, supports)
    if not isinstance(source_value, LiteratureId):
        raise TypeError("source_literature_id must be LiteratureId")
    validated_references = _typed_tuple(
        references_value,
        Reference,
        "references must be a tuple of Reference values",
    )
    validated_supports = _typed_tuple(
        supports_value,
        ReferenceSupport,
        "supports must be a tuple of ReferenceSupport values",
    )
    if any(item.source_literature_id != source_value for item in validated_references):
        raise ValueError("content reference closure may contain only outbound References")
    reference_ids = tuple(item.reference_id for item in validated_references)
    if len(reference_ids) != len(set(reference_ids)):
        raise ValueError("content reference closure cannot contain duplicate References")
    if len(validated_supports) != len({item.model_dump_json() for item in validated_supports}):
        raise ValueError("content reference closure cannot contain duplicate supports")
    reference_id_set = set(reference_ids)
    if any(item.reference_id not in reference_id_set for item in validated_supports):
        raise ValueError("content reference closure support must belong to a Reference")
    supported_ids = {item.reference_id for item in validated_supports}
    if supported_ids != reference_id_set:
        raise ValueError("every content reference closure Reference requires support")

    reference_payloads = sorted(
        (item.model_dump(mode="json") for item in validated_references),
        key=_canonical_json_sort_key,
    )
    support_payloads = sorted(
        (item.model_dump(mode="json") for item in validated_supports),
        key=_canonical_json_sort_key,
    )
    payload = {
        "references": reference_payloads,
        "schema": _CONTENT_REFERENCE_CLOSURE_HASH_TAG,
        "source_literature_id": str(source_value),
        "supports": support_payloads,
    }
    encoded = json.dumps(
        payload,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return ContentReferenceClosureToken(
        source_literature_id=source_value,
        reference_count=len(validated_references),
        support_count=len(validated_supports),
        closure_sha256=sha256_digest(encoded),
    )


def _canonical_json_sort_key(value: dict[str, object]) -> str:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


class LiteratureIdentityToken(_PortModel):
    """The complete current identity/metadata token checked on publish."""

    literature_id: LiteratureId
    meta_literature_id: MetaLiteratureId
    metadata_revision: int = Field(strict=True, ge=1)
    metadata_sha256: Sha256


class MetaLiteratureIdentityToken(_PortModel):
    """The complete current membership token for one MetaLiterature."""

    meta_literature_id: MetaLiteratureId
    representative_literature_id: LiteratureId
    member_literature_ids: tuple[LiteratureId, ...]

    @field_validator("member_literature_ids", mode="before")
    @classmethod
    def normalize_members(cls, value: object) -> object:
        return _tuple_if_list(value)

    @model_validator(mode="after")
    def validate_members(self) -> "MetaLiteratureIdentityToken":
        if len(set(self.member_literature_ids)) != len(self.member_literature_ids):
            raise ValueError("meta identity token cannot contain duplicate members")
        if tuple(sorted(self.member_literature_ids, key=str)) != self.member_literature_ids:
            raise ValueError("meta identity token members must be sorted")
        if self.representative_literature_id not in self.member_literature_ids:
            raise ValueError("meta identity token representative must be a member")
        return self


class FallbackIdentityIndex(_PortModel):
    """One bounded, collision-checked fallback lookup index."""

    literature_id: LiteratureId
    fallback_identity_sha256: Sha256


class UserObservationIndex(_PortModel):
    """A bounded user-semantic lookup; the digest is not identity proof."""

    observation_id: ObservationId
    semantic_sha256: Sha256


class ProviderRecordReadKey(_PortModel):
    """One provider-scoped record lookup for an incoming observation."""

    source_name: str
    source_record_id: str

    @field_validator("source_name", "source_record_id")
    @classmethod
    def validate_nonblank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("provider record lookup values must be nonblank")
        return value


class VersionLinkReadKey(_PortModel):
    """One provider-scoped, all-conditions version-link lookup key."""

    source_name: str
    record_id: str | None = None
    stable_identifier_keys: tuple[tuple[str, str], ...] = ()

    @field_validator("stable_identifier_keys", mode="before")
    @classmethod
    def normalize_stable_keys(cls, value: object) -> object:
        return _nested_tuple_if_list(value)

    @model_validator(mode="after")
    def validate_key(self) -> "VersionLinkReadKey":
        if self.record_id is None and not self.stable_identifier_keys:
            raise ValueError("version link lookup requires record_id or stable identifiers")
        return self


class IdentityReadRequest(_PortModel):
    """Literature-owned equality indexes for one observation admission."""

    observation_id: ObservationId
    provider_record_key: ProviderRecordReadKey | None = None
    stable_identifier_keys: tuple[tuple[str, str], ...] = ()
    fallback_identity_sha256: Sha256 | None = None
    user_observation_semantic_sha256: Sha256 | None = None
    version_link_keys: tuple[VersionLinkReadKey, ...] = ()

    @field_validator("stable_identifier_keys", mode="before")
    @classmethod
    def normalize_stable_keys(cls, value: object) -> object:
        return _nested_tuple_if_list(value)

    @field_validator("version_link_keys", mode="before")
    @classmethod
    def normalize_version_link_keys(cls, value: object) -> object:
        return _tuple_if_list(value)

    @model_validator(mode="after")
    def validate_indexes(self) -> "IdentityReadRequest":
        if len(set(self.stable_identifier_keys)) != len(self.stable_identifier_keys):
            raise ValueError("stable identifier lookup keys must be unique")
        if tuple(sorted(self.stable_identifier_keys)) != self.stable_identifier_keys:
            raise ValueError("stable identifier lookup keys must be sorted")
        return self


class IdentityReadContext(_PortModel):
    """All identity/observation candidates in one consistent read closure.

    Storage evaluates ``provider_record_key`` only within metadata-provider
    provenance scope, evaluates every ``stable_identifier_keys`` item
    independently (ANY), uses the tagged fallback/user hashes only as bounded
    lookup keys, and evaluates all conditions in one ``VersionLinkReadKey``
    against the same target MetadataObservation.  It then expands every seed
    hit to the complete observation, current-facts and MetaLiterature-member
    closure.  Every hash collision, duplicate owner and ambiguous hit is
    returned.  Literature owns complete-key/object comparison, conflict
    detection and winner selection; this context deliberately exposes no
    canonical result.
    """

    literatures: tuple[Literature, ...] = ()
    meta_literatures: tuple[MetaLiterature, ...] = ()
    observations: tuple[LiteratureObservation, ...] = ()
    facts: tuple[CurrentLiteratureFacts, ...] = ()

    @field_validator(
        "literatures",
        "meta_literatures",
        "observations",
        "facts",
        mode="before",
    )
    @classmethod
    def normalize_collections(cls, value: object) -> object:
        return _tuple_if_list(value)


class ContentReadRequest(_PortModel):
    """The concrete Literature identity whose content closure is needed."""

    literature_id: LiteratureId


class ContentReadContext(_PortModel):
    """Current facts and graph rows relevant to content replacement cleanup."""

    literatures: tuple[Literature, ...] = ()
    facts: tuple[CurrentLiteratureFacts, ...] = ()
    references: tuple[Reference, ...] = ()
    supports: tuple[ReferenceSupport, ...] = ()
    reference_closure_token: ContentReferenceClosureToken

    @field_validator(
        "literatures",
        "facts",
        "references",
        "supports",
        mode="before",
    )
    @classmethod
    def normalize_collections(cls, value: object) -> object:
        return _tuple_if_list(value)


class ReferenceReadRequest(_PortModel):
    """The two concrete endpoints whose reference closure is needed."""

    source_literature_id: LiteratureId
    target_literature_id: LiteratureId
    provider_relation_observation_ids: tuple[ObservationId, ...] = ()
    metadata_reference_keys: tuple[tuple[ObservationId, int], ...] = ()
    content_reference_keys: tuple[tuple[Sha256, int], ...] = ()

    @field_validator(
        "provider_relation_observation_ids",
        "metadata_reference_keys",
        "content_reference_keys",
        mode="before",
    )
    @classmethod
    def normalize_evidence_keys(cls, value: object) -> object:
        return _nested_tuple_if_list(value)


class ReferenceReadContext(_PortModel):
    """All endpoint, edge, support and token facts for one reference decision."""

    literatures: tuple[Literature, ...] = ()
    observations: tuple[LiteratureObservation, ...] = ()
    provider_relations: tuple[ProviderRelationObservation, ...] = ()
    facts: tuple[CurrentLiteratureFacts, ...] = ()
    references: tuple[Reference, ...] = ()
    supports: tuple[ReferenceSupport, ...] = ()

    @field_validator(
        "literatures",
        "observations",
        "provider_relations",
        "facts",
        "references",
        "supports",
        mode="before",
    )
    @classmethod
    def normalize_collections(cls, value: object) -> object:
        return _tuple_if_list(value)


class DeletionReadRequest(_PortModel):
    """The concrete Literature identity whose membership is being checked."""

    literature_id: LiteratureId


class DeletionReadContext(_PortModel):
    """Complete membership/reference closure for a deletion decision."""

    literatures: tuple[Literature, ...] = ()
    meta_literatures: tuple[MetaLiterature, ...] = ()
    facts: tuple[CurrentLiteratureFacts, ...] = ()
    references: tuple[Reference, ...] = ()

    @field_validator(
        "literatures",
        "meta_literatures",
        "facts",
        "references",
        mode="before",
    )
    @classmethod
    def normalize_collections(cls, value: object) -> object:
        return _tuple_if_list(value)


class CurrentFactsReadRequest(_PortModel):
    """The concrete Literature identity whose current facts are requested."""

    literature_id: LiteratureId


class CurrentFactsReadContext(_PortModel):
    """All matching fact rows; duplicate/ambiguous rows remain visible."""

    facts: tuple[CurrentLiteratureFacts, ...] = ()

    @field_validator("facts", mode="before")
    @classmethod
    def normalize_facts(cls, value: object) -> object:
        return _tuple_if_list(value)


class IdentityObservationPublicationCommand(_PortModel):
    """Atomic identity, observation, metadata and member publication."""

    literatures: tuple[Literature, ...]
    meta_literatures: tuple[MetaLiterature, ...]
    observations: tuple[LiteratureObservation, ...]
    facts: tuple[CurrentLiteratureFacts, ...]
    expected_tokens: tuple[LiteratureIdentityToken, ...]
    expected_meta_tokens: tuple[MetaLiteratureIdentityToken, ...]
    fallback_identity_indexes: tuple[FallbackIdentityIndex, ...] = ()
    user_observation_indexes: tuple[UserObservationIndex, ...] = ()
    retired_meta_literature_ids: tuple[MetaLiteratureId, ...] = ()
    clear_automatic_pdf_exhaustion_for: tuple[LiteratureId, ...] = ()

    @field_validator(
        "literatures",
        "meta_literatures",
        "observations",
        "facts",
        "expected_tokens",
        "expected_meta_tokens",
        "fallback_identity_indexes",
        "user_observation_indexes",
        "retired_meta_literature_ids",
        "clear_automatic_pdf_exhaustion_for",
        mode="before",
    )
    @classmethod
    def normalize_collections(cls, value: object) -> object:
        return _tuple_if_list(value)


class ContentPublicationCommand(_PortModel):
    """Atomic current metadata/content replacement and support cleanup."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
        arbitrary_types_allowed=True,
    )

    expected_token: LiteratureIdentityToken
    expected_primary_asset_id: AssetId
    expected_primary_pdf_sha256: Sha256
    expected_parser_result_sha256: Sha256
    replacement: ContentAcceptanceReplacement
    structured_artifact: ArtifactRef
    structured_content: StructuredContentArtifactContent = Field(repr=False)
    fallback_identity_index: FallbackIdentityIndex | None = None
    cleanup: ReferenceCleanupDecision | None = None
    expected_reference_closure_token: ContentReferenceClosureToken | None = None

    @model_validator(mode="after")
    def validate_binding(self) -> "ContentPublicationCommand":
        literature_id = self.replacement.literature_id
        if self.expected_token.literature_id != literature_id:
            raise ValueError("content expected token must identify the replacement Literature")
        if self.structured_artifact.media_type != "application/json":
            raise ValueError("structured LiteratureContent artifact must be application/json")
        if self.structured_artifact != literature_content_artifact(self.replacement.content):
            raise ValueError("structured artifact must describe the replacement content")
        structured_content = cast(object, self.structured_content)
        if not isinstance(structured_content, StructuredContentArtifactContent):
            raise TypeError("structured content must be a path-free artifact capability")
        if (
            self.fallback_identity_index is not None
            and self.fallback_identity_index.literature_id != literature_id
        ):
            raise ValueError("fallback index must identify the replacement Literature")
        if self.cleanup is not None:
            token = self.expected_reference_closure_token
            if token is None or token.source_literature_id != literature_id:
                raise ValueError("content cleanup requires its complete Reference closure token")
        elif self.expected_reference_closure_token is not None:
            raise ValueError("content command without cleanup cannot carry a Reference token")
        return self


class MetaLiteratureReadRequest(_PortModel):
    """Explicit MetaLiterature identities whose complete member facts are needed."""

    meta_literature_ids: tuple[MetaLiteratureId, ...]

    @field_validator("meta_literature_ids", mode="before")
    @classmethod
    def normalize_ids(cls, value: object) -> object:
        return _tuple_if_list(value)

    @model_validator(mode="after")
    def validate_ids(self) -> "MetaLiteratureReadRequest":
        if not self.meta_literature_ids:
            raise ValueError("meta Literature read requires at least one identity")
        if len(set(self.meta_literature_ids)) != len(self.meta_literature_ids):
            raise ValueError("meta Literature read identities must be unique")
        return self


class MetaLiteratureReadContext(_PortModel):
    """Complete, unordered member current facts for explicit MetaLiteratures.

    Storage returns facts, not a persisted candidate list.  Literature/Entry
    applies completion and VersionRole ordering in memory.
    """

    meta_literatures: tuple[MetaLiterature, ...] = ()
    facts: tuple[CurrentLiteratureFacts, ...] = ()

    @field_validator("meta_literatures", "facts", mode="before")
    @classmethod
    def normalize_collections(cls, value: object) -> object:
        return _tuple_if_list(value)


class ProviderRelationObservationReadRequest(_PortModel):
    """Explicit immutable provider-relation observations to reread."""

    observation_ids: tuple[ObservationId, ...]

    @field_validator("observation_ids", mode="before")
    @classmethod
    def normalize_ids(cls, value: object) -> object:
        return _tuple_if_list(value)

    @model_validator(mode="after")
    def validate_ids(self) -> "ProviderRelationObservationReadRequest":
        if not self.observation_ids:
            raise ValueError("provider relation read requires at least one observation")
        if len(set(self.observation_ids)) != len(self.observation_ids):
            raise ValueError("provider relation observation identities must be unique")
        return self


class ProviderRelationObservationReadContext(_PortModel):
    """Every exact provider-relation observation hit, without canonicalization."""

    observations: tuple[ProviderRelationObservation, ...] = ()

    @field_validator("observations", mode="before")
    @classmethod
    def normalize_observations(cls, value: object) -> object:
        return _tuple_if_list(value)


class ReferencePublicationCommand(_PortModel):
    """Atomic creation of one Reference and its first support set."""

    source_token: LiteratureIdentityToken
    target_token: LiteratureIdentityToken
    reference: Reference
    supports: tuple[ReferenceSupport, ...]

    @field_validator("supports", mode="before")
    @classmethod
    def normalize_supports(cls, value: object) -> object:
        return _tuple_if_list(value)


class ReferenceSupportAppendCommand(_PortModel):
    """Idempotent append of additional locators to an existing Reference."""

    source_token: LiteratureIdentityToken
    target_token: LiteratureIdentityToken
    reference: Reference
    supports: tuple[ReferenceSupport, ...]

    @field_validator("supports", mode="before")
    @classmethod
    def normalize_supports(cls, value: object) -> object:
        return _tuple_if_list(value)


class LiteratureDeletionCommand(_PortModel):
    """Deletion request after Literature-owned invariant checks."""

    expected_token: LiteratureIdentityToken
    expected_meta_token: MetaLiteratureIdentityToken
    literature_id: LiteratureId
    replacement_representative_id: LiteratureId | None = None


class LiteratureReadPort(Protocol):
    """Read only the complete closure needed by one Literature use case."""

    def read_identity(self, request: IdentityReadRequest) -> IdentityReadContext: ...

    def read_content(self, request: ContentReadRequest) -> ContentReadContext: ...

    def read_reference(self, request: ReferenceReadRequest) -> ReferenceReadContext: ...

    def read_deletion(self, request: DeletionReadRequest) -> DeletionReadContext: ...

    def read_current_facts(self, request: CurrentFactsReadRequest) -> CurrentFactsReadContext: ...


class LiteratureQueryPort(Protocol):
    """The unified read-only boundary implemented by the L7 read model.

    Search/detail/reference projections and auxiliary Entry closures all come
    from one Storage snapshot per call.  The Port exposes no SQL, table, path,
    cursor encoding, or persisted candidate/read-model object.
    """

    def search(self, request: LibrarySearchRequest) -> LibrarySearchPage: ...

    def read_detail(self, literature_id: LiteratureId) -> LiteratureDetail: ...

    def read_references(
        self,
        request: LiteratureReferenceRequest,
    ) -> LiteratureReferencePage: ...

    def read_reference_detail(self, reference_id: ReferenceId) -> ReferenceDetail: ...

    def read_meta_literatures(
        self,
        request: MetaLiteratureReadRequest,
    ) -> MetaLiteratureReadContext: ...

    def read_provider_relation_observations(
        self,
        request: ProviderRelationObservationReadRequest,
    ) -> ProviderRelationObservationReadContext: ...


class LiteratureArtifactReadPort(Protocol):
    """Open one accepted Detail artifact as a verified managed stream."""

    def open_artifact(
        self,
        reference: LiteratureArtifactReference,
    ) -> AbstractContextManager[BinaryIO]: ...


class StalePreconditionError(RuntimeError):
    """A Port refused a command because its read snapshot is no longer current."""


class IdentityObservationPublicationPort(Protocol):
    """Persist identity, observations and current initial metadata atomically."""

    def publish_identity_and_observation(
        self,
        command: IdentityObservationPublicationCommand,
    ) -> None: ...


class ContentPublicationPort(Protocol):
    """Persist a validated current content replacement atomically."""

    def publish_content(self, command: ContentPublicationCommand) -> None: ...


class ReferencePublicationPort(Protocol):
    """Persist Reference/support facts with first-publish and append semantics."""

    def publish_reference(self, command: ReferencePublicationCommand) -> None: ...

    def append_reference_support(self, command: ReferenceSupportAppendCommand) -> None: ...


class LiteratureMaintenancePort(Protocol):
    """Apply a previously validated Literature deletion."""

    def delete_literature(self, command: LiteratureDeletionCommand) -> None: ...


__all__ = (
    "ContentAcceptanceReplacement",
    "ContentReadContext",
    "ContentReadRequest",
    "ContentPublicationCommand",
    "ContentPublicationPort",
    "ContentReferenceClosureToken",
    "CurrentContentLineage",
    "CurrentLiteratureFacts",
    "CurrentPrimaryPdf",
    "CurrentFactsReadContext",
    "CurrentFactsReadRequest",
    "DeletionReadContext",
    "DeletionReadRequest",
    "FallbackIdentityIndex",
    "IdentityReadContext",
    "IdentityReadRequest",
    "IdentityObservationPublicationCommand",
    "IdentityObservationPublicationPort",
    "LiteratureDeletionCommand",
    "LiteratureArtifactReadError",
    "LiteratureArtifactReadPort",
    "LiteratureArtifactReference",
    "LiteratureCursorError",
    "LiteratureIdentityToken",
    "LiteratureMaintenancePort",
    "LiteratureObservation",
    "LiteratureQueryPort",
    "LiteratureReadPort",
    "MetaLiteratureReadContext",
    "MetaLiteratureReadRequest",
    "MetaLiteratureIdentityToken",
    "ProviderRecordReadKey",
    "ProviderRelationObservationReadContext",
    "ProviderRelationObservationReadRequest",
    "ReferenceReadContext",
    "ReferenceReadRequest",
    "ReferencePublicationCommand",
    "ReferencePublicationPort",
    "ReferenceCleanupDecision",
    "ReferenceCursorPosition",
    "ReferenceSupportAppendCommand",
    "StalePreconditionError",
    "StructuredContentArtifactContent",
    "SearchCursorPosition",
    "UserObservationIndex",
    "VersionLinkReadKey",
    "analysis_input_sha256",
    "canonical_literature_content_json",
    "content_reference_closure_token",
    "decode_reference_cursor",
    "decode_search_cursor",
    "derive_status",
    "encode_reference_cursor",
    "encode_search_cursor",
    "first_missing_step",
    "fts5_index_text",
    "literature_content_artifact",
    "metadata_sha256",
    "normalize_contains_text",
    "normalized_contains",
    "quoted_fts5_and_query",
    "reference_sort_key",
    "relevance_sort_key",
)
