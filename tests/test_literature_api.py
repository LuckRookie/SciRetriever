from __future__ import annotations

import json
import unittest
from collections.abc import Callable
from contextlib import AbstractContextManager
from dataclasses import dataclass, replace
from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
from types import TracebackType
from typing import BinaryIO, cast

from pydantic import ValidationError

import sciretriever.literature.api as literature_api
import sciretriever.literature.ports as literature_ports
import sciretriever.literature.service as literature_service
import sciretriever.literature.state as literature_state
from sciretriever.analysis.markdown import render_canonical_markdown
from sciretriever.literature.api import (
    CurrentLiteratureFacts,
    LiteratureApi,
    LiteratureArtifactReadError,
    LiteratureArtifactReference,
    ObservationAcceptanceResult,
    derive_status,
    provider_key_matches_seed,
)
from sciretriever.literature.content import (
    ContentAcceptanceDecision,
    canonical_literature_content_json,
    literature_content_artifact,
    metadata_sha256,
)
from sciretriever.literature.identity import (
    fallback_identity_key,
    fallback_identity_sha256,
    stable_identifier_index,
)
from sciretriever.literature.metadata import user_observation_semantic_sha256
from sciretriever.literature.ports import (
    ContentPublicationCommand,
    ContentReadContext,
    ContentReadRequest,
    CurrentFactsReadContext,
    CurrentFactsReadRequest,
    DeletionReadContext,
    DeletionReadRequest,
    IdentityObservationPublicationCommand,
    IdentityReadContext,
    IdentityReadRequest,
    LiteratureArtifactReadPort,
    LiteratureDeletionCommand,
    LiteratureIdentityToken,
    LiteratureObservation,
    LiteratureQueryPort,
    MetaLiteratureIdentityToken,
    MetaLiteratureReadContext,
    MetaLiteratureReadRequest,
    ProviderRecordReadKey,
    ProviderRelationObservationReadContext,
    ProviderRelationObservationReadRequest,
    ReferencePublicationCommand,
    ReferenceReadContext,
    ReferenceReadRequest,
    ReferenceSupportAppendCommand,
    StalePreconditionError,
    VersionLinkReadKey,
    content_reference_closure_token,
)
from sciretriever.literature.references import ProviderRelationEvidence
from sciretriever.literature.service import LiteratureInvariantError, LiteratureService
from sciretriever.literature.state import (
    CurrentContentLineage,
    CurrentPrimaryPdf,
)
from sciretriever.model.acquisition import Asset, AssetRole, LiteratureAsset
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContentProposal,
    LiteratureSection,
    LiteratureSectionRole,
    analysis_input_sha256,
    content_sha256,
)
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySearchPage,
    LibrarySearchRequest,
    LiteratureDetail,
    LiteratureReferencePage,
    LiteratureReferenceRequest,
    ReferenceDetail,
)
from sciretriever.model.literature import (
    Author,
    AuthorKind,
    ContentReferenceTextSupport,
    Identifier,
    Literature,
    LiteratureStatus,
    MetaLiterature,
    Reference,
    ReferenceSupport,
    VersionRole,
)
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.parsing import (
    ParserArtifactRef,
    ParserProvenance,
    ParserResult,
    parser_result_sha256,
)
from sciretriever.model.primitives import (
    AssetId,
    LiteratureAssetId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    RelativeArtifactPath,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactStore
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
from sciretriever.storage.sqlite.literature_reader import LiteratureReader
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter

_ID_1 = "123e4567-e89b-12d3-a456-426614174000"
_ID_2 = "223e4567-e89b-12d3-a456-426614174000"
_ID_3 = "323e4567-e89b-12d3-a456-426614174000"
_ID_4 = "423e4567-e89b-12d3-a456-426614174000"
_ID_5 = "523e4567-e89b-12d3-a456-426614174000"
_ID_6 = "623e4567-e89b-12d3-a456-426614174000"
_ID_7 = "723e4567-e89b-12d3-a456-426614174000"
_ID_8 = "823e4567-e89b-12d3-a456-426614174000"
_HASH_A = Sha256("a" * 64)
_HASH_B = Sha256("b" * 64)
_HASH_C = Sha256("c" * 64)
_TIME = UtcTimestamp("2026-08-11T12:00:00Z")


def _metadata(
    *,
    title: str = "A study",
    authors: tuple[Author, ...] = (),
    abstract: str | None = None,
    publication_year: int | None = 2026,
    document_type: str | None = None,
    identifiers: tuple[Identifier, ...] = (),
) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=title,
        authors=authors,
        abstract=abstract,
        publication_year=publication_year,
        document_type=document_type,
        identifiers=identifiers,
    )


def _provenance(
    identifier: str,
    *,
    source_kind: SourceKind = SourceKind.METADATA_PROVIDER,
    source_name: str = "provider",
    source_record_id: str | None = "record",
    input_sha256: Sha256 | None = _HASH_A,
    parameters_sha256: Sha256 | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(identifier),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=source_record_id,
        observed_at=_TIME,
        input_sha256=input_sha256,
        parameters_sha256=parameters_sha256,
    )


def _observation(
    identifier: str,
    metadata: LiteratureMetadata,
    *,
    source_name: str = "provider",
    source_record_id: str = "record",
    version_role: VersionRole | None = None,
    version_links: tuple[ProviderLiteratureKey, ...] = (),
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(identifier),
        provenance=_provenance(
            identifier,
            source_name=source_name,
            source_record_id=source_record_id,
        ),
        metadata=metadata,
        version_role=version_role,
        version_links=version_links,
    )


def _user_observation(identifier: str, metadata: LiteratureMetadata) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(identifier),
        provenance=_provenance(
            identifier,
            source_kind=SourceKind.USER,
            source_name="bibliographic-import",
            source_record_id=None,
            input_sha256=None,
        ),
        metadata=metadata,
    )


def _literature(
    identifier: str,
    metadata: LiteratureMetadata,
    *,
    meta_identifier: str | None = None,
    role: VersionRole = VersionRole.OTHER,
    status: LiteratureStatus = LiteratureStatus.UNREVIEWED,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(identifier),
        meta_literature_id=MetaLiteratureId(meta_identifier or identifier),
        version_role=role,
        metadata=metadata,
        status=status,
    )


def _version_read_key_matches(
    key: VersionLinkReadKey,
    observation: MetadataObservation,
) -> bool:
    """Mirror the Storage contract: every condition hits one observation."""

    if key.record_id is not None and (
        observation.provenance.source_kind is not SourceKind.METADATA_PROVIDER
        or observation.provenance.source_name != key.source_name
        or observation.provenance.source_record_id != key.record_id
    ):
        return False
    observation_keys = set(stable_identifier_index(observation.metadata))
    return set(key.stable_identifier_keys).issubset(observation_keys)


def _initial_facts(literature: Literature) -> CurrentLiteratureFacts:
    return CurrentLiteratureFacts(
        literature=literature,
        metadata_revision=1,
        metadata_sha256=metadata_sha256(literature.metadata),
    )


class _FakeIds:
    def __init__(self) -> None:
        self._literature = iter((_ID_2, _ID_3, _ID_4, _ID_5, _ID_6))
        self._meta = iter((_ID_7, _ID_8))
        self._reference = iter((_ID_1, _ID_6))

    def new_literature_id(self) -> LiteratureId:
        return LiteratureId(next(self._literature))

    def new_meta_literature_id(self) -> MetaLiteratureId:
        return MetaLiteratureId(next(self._meta))

    def new_reference_id(self) -> ReferenceId:
        return ReferenceId(next(self._reference))


@dataclass(frozen=True)
class _MemoryState:
    literatures: tuple[Literature, ...] = ()
    meta_literatures: tuple[MetaLiterature, ...] = ()
    observations: tuple[LiteratureObservation, ...] = ()
    facts: tuple[CurrentLiteratureFacts, ...] = ()
    references: tuple[Reference, ...] = ()
    supports: tuple[ReferenceSupport, ...] = ()
    provider_relations: tuple[ProviderRelationObservation, ...] = ()

    def model_copy(self, *, update: dict[str, object] | None = None) -> "_MemoryState":
        return replace(self, **(update or {}))


class _MemoryFacts:
    """A deliberately small in-memory fake implementing the L5 Ports."""

    def __init__(self) -> None:
        self.snapshot = _MemoryState()
        self.fail_identity = False
        self.fail_content = False
        self.fail_reference = False
        self.before_identity: Callable[[], None] | None = None
        self.identity_commands: list[IdentityObservationPublicationCommand] = []
        self.content_commands: list[ContentPublicationCommand] = []
        self.reference_commands: list[ReferencePublicationCommand] = []
        self.support_commands: list[ReferenceSupportAppendCommand] = []
        self.delete_commands: list[LiteratureDeletionCommand] = []
        self.cleared_exhaustion: list[LiteratureId] = []
        self.read_calls: dict[str, int] = {}
        self.read_requests: dict[str, list[object]] = {}
        self.fallback_hash_collision_ids: tuple[LiteratureId, ...] = ()
        self.user_hash_collision_observation_ids: tuple[ObservationId, ...] = ()
        self.omit_content_supports = False

    def _count(self, name: str, request: object) -> None:
        self.read_calls[name] = self.read_calls.get(name, 0) + 1
        self.read_requests.setdefault(name, []).append(request)

    def read_identity(  # noqa: C901
        self, request: IdentityReadRequest
    ) -> IdentityReadContext:
        self._count("identity", request)
        seed_ids: set[LiteratureId] = set()
        directly_selected_links: list[LiteratureObservation] = []

        def select_link(link: LiteratureObservation) -> None:
            if link not in directly_selected_links:
                directly_selected_links.append(link)
            seed_ids.add(link.literature_id)

        for link in self.snapshot.observations:
            if link.observation.observation_id == request.observation_id:
                select_link(link)

        if request.provider_record_key is not None:
            provider_key = request.provider_record_key
            for link in self.snapshot.observations:
                provenance = link.observation.provenance
                if (
                    provenance.source_kind is SourceKind.METADATA_PROVIDER
                    and provenance.source_name == provider_key.source_name
                    and provenance.source_record_id == provider_key.source_record_id
                ):
                    select_link(link)

        requested_stable = set(request.stable_identifier_keys)
        for literature in self.snapshot.literatures:
            if requested_stable.intersection(stable_identifier_index(literature.metadata)):
                seed_ids.add(literature.literature_id)
            if request.fallback_identity_sha256 is not None:
                key = fallback_identity_key(literature.metadata)
                if (
                    not stable_identifier_index(literature.metadata)
                    and key is not None
                    and fallback_identity_sha256(key) == request.fallback_identity_sha256
                ):
                    seed_ids.add(literature.literature_id)

        if request.user_observation_semantic_sha256 is not None:
            for link in self.snapshot.observations:
                candidate = link.observation
                if (
                    candidate.provenance.source_kind is SourceKind.USER
                    and user_observation_semantic_sha256(candidate)
                    == request.user_observation_semantic_sha256
                ):
                    select_link(link)

        for key in request.version_link_keys:
            for link in self.snapshot.observations:
                if _version_read_key_matches(key, link.observation):
                    select_link(link)

        seed_ids.update(self.fallback_hash_collision_ids)
        collision_observation_ids = set(self.user_hash_collision_observation_ids)
        for link in self.snapshot.observations:
            if link.observation.observation_id in collision_observation_ids:
                select_link(link)

        seed_literatures = tuple(
            item for item in self.snapshot.literatures if item.literature_id in seed_ids
        )
        meta_ids = {item.meta_literature_id for item in seed_literatures}
        literatures = tuple(
            item
            for item in self.snapshot.literatures
            if item.literature_id in seed_ids or item.meta_literature_id in meta_ids
        )
        literature_ids = {item.literature_id for item in literatures}
        observations = tuple(
            link
            for link in self.snapshot.observations
            if link in directly_selected_links or link.literature_id in literature_ids
        )
        return IdentityReadContext(
            literatures=literatures,
            meta_literatures=tuple(
                item
                for item in self.snapshot.meta_literatures
                if item.meta_literature_id in meta_ids
            ),
            observations=observations,
            facts=tuple(
                item
                for item in self.snapshot.facts
                if item.literature.literature_id in literature_ids
            ),
        )

    def read_content(self, request: ContentReadRequest) -> ContentReadContext:
        self._count("content", request)
        references = tuple(
            item
            for item in self.snapshot.references
            if item.source_literature_id == request.literature_id
        )
        reference_ids = {item.reference_id for item in references}
        supports = tuple(
            item for item in self.snapshot.supports if item.reference_id in reference_ids
        )
        return ContentReadContext(
            literatures=tuple(
                item
                for item in self.snapshot.literatures
                if item.literature_id == request.literature_id
            ),
            facts=tuple(
                item
                for item in self.snapshot.facts
                if item.literature.literature_id == request.literature_id
            ),
            references=references,
            supports=() if self.omit_content_supports else supports,
            reference_closure_token=content_reference_closure_token(
                request.literature_id,
                references,
                supports,
            ),
        )

    def read_reference(self, request: ReferenceReadRequest) -> ReferenceReadContext:
        self._count("reference", request)
        endpoint_ids = {request.source_literature_id, request.target_literature_id}
        observation_ids = {item[0] for item in request.metadata_reference_keys}
        relation_ids = set(request.provider_relation_observation_ids)
        references = tuple(
            item
            for item in self.snapshot.references
            if item.source_literature_id == request.source_literature_id
            and item.target_literature_id == request.target_literature_id
        )
        reference_ids = {item.reference_id for item in references}
        return ReferenceReadContext(
            literatures=tuple(
                item for item in self.snapshot.literatures if item.literature_id in endpoint_ids
            ),
            observations=tuple(
                item
                for item in self.snapshot.observations
                if item.observation.observation_id in observation_ids
            ),
            provider_relations=tuple(
                item
                for item in self.snapshot.provider_relations
                if item.observation_id in relation_ids
            ),
            facts=tuple(
                item
                for item in self.snapshot.facts
                if item.literature.literature_id in endpoint_ids
            ),
            references=references,
            supports=tuple(
                item for item in self.snapshot.supports if item.reference_id in reference_ids
            ),
        )

    def read_deletion(self, request: DeletionReadRequest) -> DeletionReadContext:
        self._count("deletion", request)
        requested = tuple(
            item
            for item in self.snapshot.literatures
            if item.literature_id == request.literature_id
        )
        meta_ids = {item.meta_literature_id for item in requested}
        literatures = tuple(
            item for item in self.snapshot.literatures if item.meta_literature_id in meta_ids
        )
        literature_ids = {item.literature_id for item in literatures}
        return DeletionReadContext(
            literatures=literatures,
            meta_literatures=tuple(
                item
                for item in self.snapshot.meta_literatures
                if item.meta_literature_id in meta_ids
            ),
            facts=tuple(
                item
                for item in self.snapshot.facts
                if item.literature.literature_id in literature_ids
            ),
            references=tuple(
                item
                for item in self.snapshot.references
                if item.source_literature_id == request.literature_id
                or item.target_literature_id == request.literature_id
            ),
        )

    def read_current_facts(self, request: CurrentFactsReadRequest) -> CurrentFactsReadContext:
        self._count("current_facts", request)
        return CurrentFactsReadContext(
            facts=tuple(
                item
                for item in self.snapshot.facts
                if item.literature.literature_id == request.literature_id
            )
        )

    def publish_identity_and_observation(  # noqa: C901
        self,
        command: IdentityObservationPublicationCommand,
    ) -> None:
        if self.before_identity is not None:
            hook = self.before_identity
            self.before_identity = None
            hook()
        if self.fail_identity:
            raise StalePreconditionError("stale-current-facts")
        for token in command.expected_tokens:
            self._check_literature_token(token)
        for token in command.expected_meta_tokens:
            self._check_meta_token(token)
        current_meta_ids = {item.meta_literature_id for item in self.snapshot.meta_literatures}
        if not set(command.retired_meta_literature_ids).issubset(current_meta_ids):
            raise StalePreconditionError("stale-meta-facts")
        self.identity_commands.append(command)
        literatures = list(self.snapshot.literatures)
        for item in command.literatures:
            literatures[:] = [
                current for current in literatures if current.literature_id != item.literature_id
            ]
            literatures.append(item)
        metas = list(self.snapshot.meta_literatures)
        metas[:] = [
            current
            for current in metas
            if current.meta_literature_id not in command.retired_meta_literature_ids
        ]
        for item in command.meta_literatures:
            metas[:] = [
                current
                for current in metas
                if current.meta_literature_id != item.meta_literature_id
            ]
            metas.append(item)
        links = list(self.snapshot.observations)
        for item in command.observations:
            if item not in links:
                links.append(item)
        facts = list(self.snapshot.facts)
        for item in command.facts:
            facts[:] = [
                current
                for current in facts
                if current.literature.literature_id != item.literature.literature_id
            ]
            facts.append(item)
        self.snapshot = self.snapshot.model_copy(
            update={
                "literatures": tuple(literatures),
                "meta_literatures": tuple(metas),
                "observations": tuple(links),
                "facts": tuple(facts),
            }
        )
        self.cleared_exhaustion.extend(command.clear_automatic_pdf_exhaustion_for)

    def publish_content(self, command: ContentPublicationCommand) -> None:
        if self.fail_content:
            raise StalePreconditionError("stale-current-facts")
        self._check_literature_token(command.expected_token)
        old = self._facts(command.replacement.literature_id)
        if len(old.current_primary_pdfs) != 1 or old.current_parser_result is None:
            raise StalePreconditionError("stale-content-inputs")
        primary = old.current_primary_pdfs[0].asset
        if (
            primary.asset_id != command.expected_primary_asset_id
            or primary.sha256 != command.expected_primary_pdf_sha256
            or old.current_parser_result.result_sha256 != command.expected_parser_result_sha256
        ):
            raise StalePreconditionError("stale-content-inputs")
        if command.structured_artifact != literature_content_artifact(command.replacement.content):
            raise StalePreconditionError("structured-content-artifact-mismatch")
        with command.structured_content.open() as stream:
            if stream.read() != canonical_literature_content_json(command.replacement.content):
                raise StalePreconditionError("structured-content-bytes-mismatch")
        if command.expected_reference_closure_token is not None:
            references = tuple(
                item
                for item in self.snapshot.references
                if item.source_literature_id == command.replacement.literature_id
            )
            reference_ids = {item.reference_id for item in references}
            supports = tuple(
                item for item in self.snapshot.supports if item.reference_id in reference_ids
            )
            if command.expected_reference_closure_token != content_reference_closure_token(
                command.replacement.literature_id,
                references,
                supports,
            ):
                raise StalePreconditionError("stale-reference-support-closure")
        self.content_commands.append(command)
        updated = old.model_copy(
            update={
                "literature": old.literature.model_copy(
                    update={
                        "metadata": command.replacement.metadata,
                        "status": LiteratureStatus.CONTENT_READY,
                    }
                ),
                "metadata_revision": command.replacement.metadata_revision,
                "metadata_sha256": command.replacement.metadata_sha256,
                "current_content": command.replacement.content,
                "current_content_lineage": CurrentContentLineage(
                    primary_asset_id=command.expected_primary_asset_id,
                    primary_pdf_sha256=command.expected_primary_pdf_sha256,
                    parser_result_sha256=command.expected_parser_result_sha256,
                ),
            }
        )
        self.snapshot = self.snapshot.model_copy(
            update={
                "literatures": tuple(
                    updated.literature
                    if item.literature_id == updated.literature.literature_id
                    else item
                    for item in self.snapshot.literatures
                ),
                "facts": tuple(
                    updated
                    if item.literature.literature_id == updated.literature.literature_id
                    else item
                    for item in self.snapshot.facts
                ),
            }
        )

    def publish_reference(self, command: ReferencePublicationCommand) -> None:
        if self.fail_reference:
            raise StalePreconditionError("stale-current-facts")
        self._check_literature_token(command.source_token)
        self._check_literature_token(command.target_token)
        self.reference_commands.append(command)
        references = tuple(self.snapshot.references) + (command.reference,)
        supports = tuple(self.snapshot.supports) + command.supports
        self.snapshot = self.snapshot.model_copy(
            update={"references": references, "supports": supports}
        )

    def append_reference_support(self, command: ReferenceSupportAppendCommand) -> None:
        self._check_literature_token(command.source_token)
        self._check_literature_token(command.target_token)
        if not any(
            item.reference_id == command.reference.reference_id for item in self.snapshot.references
        ):
            raise StalePreconditionError("stale-reference")
        self.support_commands.append(command)
        supports = list(self.snapshot.supports)
        for support in command.supports:
            if support not in supports:
                supports.append(support)
        self.snapshot = self.snapshot.model_copy(update={"supports": tuple(supports)})

    def delete_literature(self, command: LiteratureDeletionCommand) -> None:
        self._check_literature_token(command.expected_token)
        self._check_meta_token(command.expected_meta_token)
        self.delete_commands.append(command)
        literature_id = command.literature_id
        meta_id = command.expected_meta_token.meta_literature_id
        remaining_literatures = tuple(
            item for item in self.snapshot.literatures if item.literature_id != literature_id
        )
        current_meta = next(
            item for item in self.snapshot.meta_literatures if item.meta_literature_id == meta_id
        )
        remaining_meta = (
            current_meta.model_copy(
                update={
                    "representative_literature_id": command.replacement_representative_id
                    or current_meta.representative_literature_id
                }
            )
            if any(item.meta_literature_id == meta_id for item in remaining_literatures)
            else None
        )
        self.snapshot = self.snapshot.model_copy(
            update={
                "literatures": remaining_literatures,
                "meta_literatures": tuple(
                    item
                    for item in self.snapshot.meta_literatures
                    if item.meta_literature_id != meta_id
                )
                + ((remaining_meta,) if remaining_meta is not None else ()),
                "facts": tuple(
                    item
                    for item in self.snapshot.facts
                    if item.literature.literature_id != literature_id
                ),
                "observations": tuple(
                    item
                    for item in self.snapshot.observations
                    if item.literature_id != literature_id
                ),
            }
        )

    def _check_literature_token(self, token: LiteratureIdentityToken) -> None:
        matches = tuple(
            item for item in self.snapshot.literatures if item.literature_id == token.literature_id
        )
        if len(matches) != 1 or matches[0].meta_literature_id != token.meta_literature_id:
            raise StalePreconditionError("stale-literature-facts")
        facts = tuple(
            item
            for item in self.snapshot.facts
            if item.literature.literature_id == token.literature_id
        )
        if len(facts) != 1:
            raise StalePreconditionError("stale-literature-facts")
        if (
            facts[0].metadata_revision != token.metadata_revision
            or facts[0].metadata_sha256 != token.metadata_sha256
        ):
            raise StalePreconditionError("stale-literature-facts")

    def _check_meta_token(self, token: MetaLiteratureIdentityToken) -> None:
        matches = tuple(
            item
            for item in self.snapshot.meta_literatures
            if item.meta_literature_id == token.meta_literature_id
        )
        members = tuple(
            sorted(
                (
                    item.literature_id
                    for item in self.snapshot.literatures
                    if item.meta_literature_id == token.meta_literature_id
                ),
                key=str,
            )
        )
        if (
            len(matches) != 1
            or matches[0].representative_literature_id != token.representative_literature_id
            or members != token.member_literature_ids
        ):
            raise StalePreconditionError("stale-meta-facts")

    def _facts(self, literature_id: LiteratureId):
        for facts in self.snapshot.facts:
            if facts.literature.literature_id == literature_id:
                return facts
        raise AssertionError("missing facts")


class _RecordingArtifactContext(AbstractContextManager[BinaryIO]):
    def __init__(self, payload: bytes) -> None:
        self.stream = BytesIO(payload)
        self.enter_count = 0
        self.exit_count = 0

    def __enter__(self) -> BinaryIO:
        self.enter_count += 1
        return self.stream

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc_value: BaseException | None,
        traceback: TracebackType | None,
    ) -> bool:
        del exc_type, exc_value, traceback
        self.exit_count += 1
        self.stream.close()
        return False


class _RecordingArtifactPort:
    def __init__(self, context: AbstractContextManager[BinaryIO]) -> None:
        self.context = context
        self.calls: list[object] = []

    def open_artifact(
        self,
        reference: LiteratureArtifactReference,
    ) -> AbstractContextManager[BinaryIO]:
        self.calls.append(reference)
        return self.context


class LiteratureApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.memory = _MemoryFacts()
        self.service = LiteratureService(
            read_port=self.memory,
            identity_port=self.memory,
            content_port=self.memory,
            reference_port=self.memory,
            maintenance_port=self.memory,
            id_factory=_FakeIds(),
        )
        self.api = LiteratureApi(self.service)

    def test_provider_key_matcher_is_exposed_as_a_pure_public_api_function(self) -> None:
        seed = _observation(
            _ID_1,
            _metadata(identifiers=(Identifier(namespace="doi", value="10.1000/seed"),)),
            source_name="crossref",
            source_record_id="crossref-record",
        )
        key = ProviderLiteratureKey(
            record_id="crossref-record",
            identifiers=(Identifier(namespace="doi", value="doi:10.1000/SEED"),),
        )

        self.assertTrue(
            provider_key_matches_seed(
                provider_name="crossref",
                key=key,
                seed_observations=(seed,),
            )
        )
        self.assertIs(provider_key_matches_seed, literature_api.provider_key_matches_seed)
        self.assertIn("provider_key_matches_seed", literature_api.__all__)
        self.assertFalse(hasattr(literature_api, "_version_key_matches"))

    def test_public_boundary_reexports_only_the_explicit_entry_contracts(self) -> None:
        expected = {
            "ContentAcceptanceDecision": ContentAcceptanceDecision,
            "ContentReferenceClosureToken": literature_ports.ContentReferenceClosureToken,
            "CurrentContentLineage": literature_state.CurrentContentLineage,
            "CurrentLiteratureFacts": literature_state.CurrentLiteratureFacts,
            "LiteratureApi": LiteratureApi,
            "LiteratureArtifactReadError": literature_ports.LiteratureArtifactReadError,
            "LiteratureArtifactReference": literature_ports.LiteratureArtifactReference,
            "ObservationAcceptanceResult": literature_service.ObservationAcceptanceResult,
            "NoUsableContentCleanupPreparation": (
                literature_service.NoUsableContentCleanupPreparation
            ),
            "ReferenceCleanupDecision": literature_ports.ReferenceCleanupDecision,
            "StalePreconditionError": StalePreconditionError,
            "derive_status": literature_state.derive_status,
            "provider_key_matches_seed": provider_key_matches_seed,
        }

        self.assertEqual(literature_api.__all__, tuple(expected))
        for name, authoritative in expected.items():
            with self.subTest(name=name):
                self.assertIs(getattr(literature_api, name), authoritative)

        facts = _initial_facts(
            _literature(
                _ID_1,
                _metadata(),
                status=LiteratureStatus.CONTENT_READY,
            )
        )
        self.assertIs(derive_status, literature_state.derive_status)
        self.assertIs(derive_status(facts), LiteratureStatus.UNREVIEWED)

    def test_service_result_is_closed_frozen_pydantic_model(self) -> None:
        values = {
            "decision": "rejected",
            "reason": "fixture rejection",
        }
        result = ObservationAcceptanceResult.model_validate(values)
        self.assertFalse(result.meta_literature_created)
        with self.assertRaises(ValidationError):
            ObservationAcceptanceResult.model_validate({**values, "path": "/tmp/catalog.sqlite"})
        with self.assertRaises(ValidationError):
            ObservationAcceptanceResult.model_validate({**values, "meta_literature_created": True})
        with self.assertRaises(ValidationError):
            ObservationAcceptanceResult.model_validate({**values, "meta_literature_created": 1})
        with self.assertRaises(ValidationError):
            setattr(result, "reason", "changed")

    def test_port_and_operation_models_are_closed_frozen_and_do_not_accept_io_fields(self) -> None:
        with self.assertRaises(ValidationError):
            ContentReadContext.model_validate({"path": "/tmp/catalog.sqlite"})
        with self.assertRaises(ValidationError):
            IdentityObservationPublicationCommand.model_validate(
                {
                    "observations": (),
                    "literatures": (),
                    "meta_literatures": (),
                    "facts": (),
                    "expected_tokens": (),
                    "expected_meta_tokens": (),
                    "sql": "select 1",
                }
            )
        self.assertNotIn("path", ContentReadContext.model_fields)
        self.assertNotIn("vendor_payload", IdentityObservationPublicationCommand.model_fields)

    def test_artifact_read_port_is_literature_owned_and_unconfigured_service_fails_closed(
        self,
    ) -> None:
        self.assertIn("open_artifact", LiteratureArtifactReadPort.__dict__)
        reference = ArtifactRef(
            sha256=_HASH_A,
            media_type="text/markdown",
            byte_size=1,
        )

        with self.assertRaises(LiteratureArtifactReadError) as caught:
            self.api.open_artifact(reference)

        self.assertEqual(str(caught.exception), "literature artifact read failed")
        self.assertIsNone(caught.exception.__cause__)

    def test_ports_reexport_the_authoritative_adapter_facing_literature_contracts(self) -> None:
        expected_modules = {
            "ContentAcceptanceReplacement": "sciretriever.literature.content",
            "ReferenceCleanupDecision": "sciretriever.literature.references",
            "CurrentLiteratureFacts": "sciretriever.literature.state",
            "CurrentPrimaryPdf": "sciretriever.literature.state",
            "metadata_sha256": "sciretriever.literature.content",
            "canonical_literature_content_json": "sciretriever.literature.content",
            "literature_content_artifact": "sciretriever.literature.content",
            "analysis_input_sha256": "sciretriever.model.analysis",
            "derive_status": "sciretriever.literature.state",
            "LiteratureCursorError": "sciretriever.literature.query",
            "SearchCursorPosition": "sciretriever.literature.query",
            "ReferenceCursorPosition": "sciretriever.literature.query",
            "decode_search_cursor": "sciretriever.literature.query",
            "encode_search_cursor": "sciretriever.literature.query",
            "decode_reference_cursor": "sciretriever.literature.query",
            "encode_reference_cursor": "sciretriever.literature.query",
            "first_missing_step": "sciretriever.literature.query",
            "normalize_contains_text": "sciretriever.literature.query",
            "normalized_contains": "sciretriever.literature.query",
            "quoted_fts5_and_query": "sciretriever.literature.query",
            "reference_sort_key": "sciretriever.literature.query",
            "relevance_sort_key": "sciretriever.literature.query",
        }

        for name, module_name in expected_modules.items():
            with self.subTest(name=name):
                value = getattr(literature_ports, name)
                self.assertEqual(value.__module__, module_name)
                self.assertIn(name, literature_ports.__all__)

    def test_artifact_open_is_one_thin_api_and_service_delegation(self) -> None:
        context = _RecordingArtifactContext(b"verified bytes")
        artifact_port = _RecordingArtifactPort(context)
        service = LiteratureService(
            read_port=self.memory,
            identity_port=self.memory,
            content_port=self.memory,
            reference_port=self.memory,
            maintenance_port=self.memory,
            id_factory=_FakeIds(),
            artifact_read_port=artifact_port,
        )
        api = LiteratureApi(service)
        reference = ParserArtifactRef(
            sha256=_HASH_A,
            media_type="text/markdown",
            byte_size=14,
        )

        returned = api.open_artifact(reference)

        self.assertIs(returned, context)
        self.assertEqual(artifact_port.calls, [reference])
        with returned as stream:
            self.assertEqual(stream.read(), b"verified bytes")
        self.assertEqual(context.enter_count, 1)
        self.assertEqual(context.exit_count, 1)
        self.assertEqual(self.memory.read_calls, {})

    def test_unified_query_port_declares_l7_projections_and_auxiliary_scoped_reads(self) -> None:
        methods = {
            "search",
            "read_detail",
            "read_references",
            "read_reference_detail",
            "read_meta_literatures",
            "read_provider_relation_observations",
        }
        self.assertTrue(methods.issubset(LiteratureQueryPort.__dict__))
        meta_request = MetaLiteratureReadRequest(meta_literature_ids=(MetaLiteratureId(_ID_1),))
        relation_request = ProviderRelationObservationReadRequest(
            observation_ids=(ObservationId(_ID_2),)
        )
        self.assertEqual(meta_request.meta_literature_ids, (MetaLiteratureId(_ID_1),))
        self.assertEqual(relation_request.observation_ids, (ObservationId(_ID_2),))
        self.assertEqual(MetaLiteratureReadContext(), MetaLiteratureReadContext())
        self.assertEqual(
            ProviderRelationObservationReadContext(),
            ProviderRelationObservationReadContext(),
        )
        with self.assertRaises(ValidationError):
            MetaLiteratureReadRequest(meta_literature_ids=())
        with self.assertRaises(ValidationError):
            ProviderRelationObservationReadRequest(observation_ids=())

    def test_identity_and_observation_are_atomic_and_replay_is_idempotent(self) -> None:
        observation = _observation(
            _ID_1,
            _metadata(title="A paper", abstract="abstract"),
            version_role=VersionRole.PUBLISHED,
        )
        first = self.api.accept_observation(observation)
        self.assertEqual(first.decision, "created")
        self.assertTrue(first.meta_literature_created)
        created_without_meta = ObservationAcceptanceResult.model_validate(
            {**first.model_dump(mode="python"), "meta_literature_created": False}
        )
        self.assertFalse(created_without_meta.meta_literature_created)
        for noncreating_decision in ("enriched", "matched"):
            with self.subTest(noncreating_decision=noncreating_decision):
                with self.assertRaises(ValidationError):
                    ObservationAcceptanceResult.model_validate(
                        {
                            **first.model_dump(mode="python"),
                            "decision": noncreating_decision,
                        }
                    )
        first_literature = first.literature
        if first_literature is None:
            self.fail("created observation result lacks Literature")
        self.assertEqual(len(self.memory.snapshot.literatures), 1)
        self.assertEqual(len(self.memory.snapshot.meta_literatures), 1)
        self.assertEqual(len(self.memory.snapshot.observations), 1)
        self.assertEqual(tuple(self.memory.cleared_exhaustion), (first_literature.literature_id,))

        repeated = self.api.accept_observation(observation)
        self.assertEqual(repeated.decision, "matched")
        self.assertFalse(repeated.meta_literature_created)
        self.assertTrue(repeated.deduplicated)
        self.assertEqual(len(self.memory.identity_commands), 1)
        self.assertEqual(len(self.memory.snapshot.literatures), 1)
        self.assertEqual(len(self.memory.snapshot.observations), 1)
        self.assertEqual(tuple(self.memory.cleared_exhaustion), (first_literature.literature_id,))
        self.assertEqual(self.memory.read_calls["identity"], 2)

    def test_provider_record_read_key_is_built_only_for_metadata_provider_input(self) -> None:
        provider = _observation(
            _ID_1,
            _metadata(title="Provider record input"),
            source_name="provider-a",
            source_record_id="provider-record",
        )
        self.api.accept_observation(provider)

        provider_request = self.memory.read_requests["identity"][0]
        self.assertIsInstance(provider_request, IdentityReadRequest)
        assert isinstance(provider_request, IdentityReadRequest)
        self.assertEqual(
            provider_request.provider_record_key,
            ProviderRecordReadKey(
                source_name="provider-a",
                source_record_id="provider-record",
            ),
        )

        self.api.accept_observation(
            _user_observation(
                _ID_3,
                _metadata(title="User bibliographic input"),
            )
        )

        user_request = self.memory.read_requests["identity"][1]
        self.assertIsInstance(user_request, IdentityReadRequest)
        assert isinstance(user_request, IdentityReadRequest)
        self.assertIsNone(user_request.provider_record_key)

    def test_provider_owner_reuse_keeps_new_observations_and_exact_replay(
        self,
    ) -> None:
        metadata = _metadata(title="Title-only provider record", publication_year=None)
        first_observation = _observation(
            _ID_1,
            metadata,
            source_name="provider-a",
            source_record_id="shared-record",
        )
        second_observation = _observation(
            _ID_3,
            metadata,
            source_name="provider-a",
            source_record_id="shared-record",
        ).model_copy(
            update={
                "provenance": _provenance(
                    _ID_3,
                    source_name="provider-a",
                    source_record_id="shared-record",
                ).model_copy(update={"observed_at": UtcTimestamp("2026-08-12T12:00:00Z")})
            }
        )
        third_observation = _observation(
            _ID_4,
            metadata,
            source_name="provider-a",
            source_record_id="shared-record",
        )

        first = self.api.accept_observation(first_observation)
        second = self.api.accept_observation(second_observation)
        third = self.api.accept_observation(third_observation)
        replay = self.api.accept_observation(third_observation)

        self.assertEqual(first.decision, "created")
        self.assertEqual(second.decision, "matched")
        self.assertEqual(third.decision, "matched")
        self.assertEqual(replay.decision, "matched")
        self.assertFalse(first.deduplicated)
        self.assertFalse(second.deduplicated)
        self.assertFalse(third.deduplicated)
        self.assertTrue(replay.deduplicated)
        assert first.literature is not None
        self.assertEqual(second.literature, first.literature)
        self.assertEqual(third.literature, first.literature)
        self.assertEqual(len(self.memory.snapshot.literatures), 1)
        self.assertEqual(second.observation, second_observation)
        self.assertEqual(third.observation, third_observation)
        self.assertEqual(replay.observation, third_observation)
        self.assertEqual(
            tuple(link.observation for link in self.memory.snapshot.observations),
            (first_observation, second_observation, third_observation),
        )
        self.assertEqual(len(self.memory.identity_commands), 3)
        self.assertEqual(
            tuple(self.memory.cleared_exhaustion),
            (first.literature.literature_id,) * 3,
        )

    def test_provider_changed_input_or_neutral_semantics_adds_immutable_observation(
        self,
    ) -> None:
        metadata = _metadata(title="Changing provider record", publication_year=None)
        first_observation = _observation(
            _ID_1,
            metadata,
            source_name="provider-a",
            source_record_id="changing-record",
        )
        changed_input = _observation(
            _ID_3,
            metadata,
            source_name="provider-a",
            source_record_id="changing-record",
        ).model_copy(
            update={
                "provenance": _provenance(
                    _ID_3,
                    source_name="provider-a",
                    source_record_id="changing-record",
                    input_sha256=_HASH_B,
                )
            }
        )
        changed_semantics = _observation(
            _ID_4,
            metadata.model_copy(update={"abstract": "A new provider value"}),
            source_name="provider-a",
            source_record_id="changing-record",
        )

        first = self.api.accept_observation(first_observation)
        second = self.api.accept_observation(changed_input)
        third = self.api.accept_observation(changed_semantics)

        self.assertEqual(first.decision, "created")
        self.assertEqual(second.decision, "matched")
        self.assertEqual(third.decision, "enriched")
        self.assertTrue(first.meta_literature_created)
        self.assertFalse(second.meta_literature_created)
        self.assertFalse(third.meta_literature_created)
        self.assertFalse(second.deduplicated)
        self.assertFalse(third.deduplicated)
        self.assertEqual(len(self.memory.snapshot.observations), 3)
        self.assertEqual(len(self.memory.identity_commands), 3)
        assert first.literature is not None
        self.assertEqual(
            tuple(self.memory.cleared_exhaustion),
            (first.literature.literature_id,) * 3,
        )

    def test_same_provider_record_multiple_owners_fail_closed(self) -> None:
        first_owner = _literature(_ID_1, _metadata(title="First owner"))
        second_owner = _literature(_ID_2, _metadata(title="Second owner"))
        first_observation = _observation(
            _ID_3,
            first_owner.metadata,
            source_name="provider-a",
            source_record_id="ambiguous-record",
        )
        second_observation = _observation(
            _ID_4,
            second_owner.metadata,
            source_name="provider-a",
            source_record_id="ambiguous-record",
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "literatures": (first_owner, second_owner),
                "observations": (
                    LiteratureObservation(
                        literature_id=first_owner.literature_id,
                        observation=first_observation,
                    ),
                    LiteratureObservation(
                        literature_id=second_owner.literature_id,
                        observation=second_observation,
                    ),
                ),
            }
        )

        result = self.api.accept_observation(
            _observation(
                _ID_5,
                _metadata(title="Incoming ambiguity", publication_year=None),
                source_name="provider-a",
                source_record_id="ambiguous-record",
            )
        )

        self.assertEqual(result.decision, "rejected")
        self.assertFalse(result.meta_literature_created)
        self.assertEqual(result.reason, "provider record has multiple owners")
        self.assertEqual(self.memory.identity_commands, [])

    def test_exact_replay_same_provider_record_multiple_owners_fails_closed(self) -> None:
        first_owner = _literature(_ID_1, _metadata(title="First owner"))
        second_owner = _literature(_ID_2, _metadata(title="Second owner"))
        first_observation = _observation(
            _ID_3,
            first_owner.metadata,
            source_name="provider-a",
            source_record_id="ambiguous-record",
        )
        second_observation = _observation(
            _ID_4,
            second_owner.metadata,
            source_name="provider-a",
            source_record_id="ambiguous-record",
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "literatures": (first_owner, second_owner),
                "meta_literatures": (
                    MetaLiterature(
                        meta_literature_id=first_owner.meta_literature_id,
                        representative_literature_id=first_owner.literature_id,
                    ),
                    MetaLiterature(
                        meta_literature_id=second_owner.meta_literature_id,
                        representative_literature_id=second_owner.literature_id,
                    ),
                ),
                "observations": (
                    LiteratureObservation(
                        literature_id=first_owner.literature_id,
                        observation=first_observation,
                    ),
                    LiteratureObservation(
                        literature_id=second_owner.literature_id,
                        observation=second_observation,
                    ),
                ),
                "facts": (_initial_facts(first_owner), _initial_facts(second_owner)),
            }
        )

        result = self.api.accept_observation(first_observation)

        self.assertEqual(result.decision, "rejected")
        self.assertEqual(result.reason, "provider record has multiple owners")
        self.assertEqual(self.memory.identity_commands, [])

    def test_provider_record_owner_and_stable_identity_mismatch_is_rejected(self) -> None:
        doi = Identifier(namespace="doi", value="10.1000/provider-owner-conflict")
        provider_owner = _literature(_ID_1, _metadata(title="Provider owner"))
        stable_owner = _literature(
            _ID_2,
            _metadata(title="Stable owner", identifiers=(doi,)),
        )
        provider_observation = _observation(
            _ID_3,
            provider_owner.metadata,
            source_name="provider-a",
            source_record_id="conflicting-record",
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "literatures": (provider_owner, stable_owner),
                "observations": (
                    LiteratureObservation(
                        literature_id=provider_owner.literature_id,
                        observation=provider_observation,
                    ),
                ),
            }
        )

        result = self.api.accept_observation(
            _observation(
                _ID_4,
                _metadata(title="Incoming stable owner", identifiers=(doi,)),
                source_name="provider-a",
                source_record_id="conflicting-record",
            )
        )

        self.assertEqual(result.decision, "rejected")
        self.assertEqual(result.reason, "observation-owner-identity-conflict")
        self.assertEqual(self.memory.identity_commands, [])

    def test_same_observation_id_with_changed_provider_value_remains_a_conflict(self) -> None:
        first = _observation(
            _ID_1,
            _metadata(title="Immutable provider value"),
            source_name="provider-a",
            source_record_id="immutable-record",
        )
        self.api.accept_observation(first)

        conflicting = first.model_copy(
            update={"metadata": _metadata(title="Changed provider value")}
        )
        result = self.api.accept_observation(conflicting)

        self.assertEqual(result.decision, "rejected")
        self.assertEqual(
            result.reason,
            "observation ID is already bound to different source data",
        )
        self.assertEqual(len(self.memory.identity_commands), 1)
        self.assertEqual(len(self.memory.snapshot.observations), 1)

    def test_fresh_sqlite_provider_owner_reuse_retains_observations_within_scope(
        self,
    ) -> None:
        with TemporaryDirectory(prefix="sciretriever-provider-record-owner-") as temporary:
            temporary_path = Path(temporary)
            engine = CatalogEngine(temporary_path / "catalog.sqlite")
            writer = LiteratureWriter(engine)
            root = StorageRoot(temporary_path / "artifacts")
            verified_reader = VerifiedReader(root)
            reader = LiteraturePreconditionReader(engine, verified_reader)
            content = SqliteContentPublication(
                engine,
                ArtifactStore(root),
                verified_reader,
            )
            api = LiteratureApi(
                LiteratureService(
                    read_port=reader,
                    identity_port=writer,
                    content_port=content,
                    reference_port=writer,
                    maintenance_port=writer,
                    id_factory=_FakeIds(),
                )
            )
            title_only = _metadata(
                title="SQLite title-only provider record",
                publication_year=None,
            )
            first_observation = _observation(
                _ID_1,
                title_only,
                source_name="provider-a",
                source_record_id="shared-record",
            )
            second_observation = _observation(
                _ID_3,
                title_only,
                source_name="provider-a",
                source_record_id="shared-record",
            )
            first = api.accept_observation(first_observation)
            second = api.accept_observation(second_observation)
            replay = api.accept_observation(second_observation)

            self.assertEqual(first.decision, "created")
            self.assertEqual(second.decision, "matched")
            self.assertEqual(replay.decision, "matched")
            self.assertFalse(second.deduplicated)
            self.assertTrue(replay.deduplicated)
            self.assertEqual(second.literature, first.literature)
            self.assertEqual(second.observation, second_observation)
            self.assertEqual(replay.observation, second_observation)
            with engine.read_snapshot() as connection:
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM literatures").fetchone(),
                    (1,),
                )
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM metadata_observations").fetchone(),
                    (2,),
                )

            other_provider = api.accept_observation(
                _observation(
                    _ID_4,
                    title_only,
                    source_name="provider-b",
                    source_record_id="shared-record",
                )
            )

            self.assertEqual(other_provider.decision, "created")
            self.assertNotEqual(other_provider.literature, first.literature)
            with engine.read_snapshot() as connection:
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM literatures").fetchone(),
                    (2,),
                )
                self.assertEqual(
                    connection.execute("SELECT count(*) FROM metadata_observations").fetchone(),
                    (3,),
                )

    def test_fresh_sqlite_exact_replay_with_multiple_provider_record_owners_fails_closed(
        self,
    ) -> None:
        with TemporaryDirectory(prefix="sciretriever-provider-record-replay-") as temporary:
            temporary_path = Path(temporary)
            engine = CatalogEngine(temporary_path / "catalog.sqlite")
            writer = LiteratureWriter(engine)
            root = StorageRoot(temporary_path / "artifacts")
            verified_reader = VerifiedReader(root)
            reader = LiteraturePreconditionReader(engine, verified_reader)
            content = SqliteContentPublication(
                engine,
                ArtifactStore(root),
                verified_reader,
            )
            api = LiteratureApi(
                LiteratureService(
                    read_port=reader,
                    identity_port=writer,
                    content_port=content,
                    reference_port=writer,
                    maintenance_port=writer,
                    id_factory=_FakeIds(),
                )
            )
            first_owner = _literature(_ID_4, _metadata(title="First SQLite owner"))
            second_owner = _literature(_ID_5, _metadata(title="Second SQLite owner"))
            first_observation = _observation(
                _ID_1,
                first_owner.metadata,
                source_name="provider-a",
                source_record_id="ambiguous-record",
            )
            second_observation = _observation(
                _ID_3,
                second_owner.metadata,
                source_name="provider-a",
                source_record_id="ambiguous-record",
            )
            writer.publish_identity_and_observation(
                IdentityObservationPublicationCommand(
                    literatures=(first_owner, second_owner),
                    meta_literatures=(
                        MetaLiterature(
                            meta_literature_id=first_owner.meta_literature_id,
                            representative_literature_id=first_owner.literature_id,
                        ),
                        MetaLiterature(
                            meta_literature_id=second_owner.meta_literature_id,
                            representative_literature_id=second_owner.literature_id,
                        ),
                    ),
                    observations=(
                        LiteratureObservation(
                            literature_id=first_owner.literature_id,
                            observation=first_observation,
                        ),
                        LiteratureObservation(
                            literature_id=second_owner.literature_id,
                            observation=second_observation,
                        ),
                    ),
                    facts=(_initial_facts(first_owner), _initial_facts(second_owner)),
                    expected_tokens=(),
                    expected_meta_tokens=(),
                )
            )
            with engine.read_snapshot() as connection:
                before = tuple(
                    connection.execute(
                        "SELECT count(*) FROM literatures "
                        "UNION ALL SELECT count(*) FROM metadata_observations "
                        "UNION ALL SELECT count(*) FROM literature_metadata_observations "
                        "UNION ALL SELECT count(*) FROM literature_metadata"
                    ).fetchall()
                )

            result = api.accept_observation(first_observation)

            self.assertEqual(result.decision, "rejected")
            self.assertEqual(result.reason, "provider record has multiple owners")
            with engine.read_snapshot() as connection:
                after = tuple(
                    connection.execute(
                        "SELECT count(*) FROM literatures "
                        "UNION ALL SELECT count(*) FROM metadata_observations "
                        "UNION ALL SELECT count(*) FROM literature_metadata_observations "
                        "UNION ALL SELECT count(*) FROM literature_metadata"
                    ).fetchall()
                )
            self.assertEqual(after, before)

    def test_stable_identifiers_are_independent_scoped_keys_and_return_all_ambiguity(self) -> None:
        doi = Identifier(namespace="doi", value="10.1000/independent")
        pmid = Identifier(namespace="pmid", value="4242")
        doi_owner = _literature(_ID_1, _metadata(identifiers=(doi,)))
        pmid_owner = _literature(_ID_2, _metadata(identifiers=(pmid,)))
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={"literatures": (doi_owner, pmid_owner)}
        )

        result = self.api.accept_observation(
            _observation(_ID_3, _metadata(identifiers=(doi, pmid)))
        )

        self.assertEqual(result.decision, "rejected")
        self.assertEqual(result.reason, "stable-identifier-ambiguity")
        self.assertEqual(self.memory.read_calls["identity"], 1)
        request = self.memory.read_requests["identity"][0]
        self.assertIsInstance(request, IdentityReadRequest)
        assert isinstance(request, IdentityReadRequest)
        self.assertEqual(request.stable_identifier_keys, (("doi", doi.value), ("pmid", pmid.value)))

    def test_fallback_hash_collision_is_fully_checked_and_ambiguous_full_keys_fail_closed(
        self,
    ) -> None:
        author = Author(kind=AuthorKind.PERSON, display_name="Ada Lovelace")
        unrelated = _literature(
            _ID_1,
            _metadata(
                title="Unrelated",
                authors=(author,),
                document_type="article",
            ),
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(update={"literatures": (unrelated,)})
        self.memory.fallback_hash_collision_ids = (unrelated.literature_id,)
        incoming_metadata = _metadata(
            title="Incoming",
            authors=(author,),
            document_type="article",
        )

        created = self.api.accept_observation(_observation(_ID_3, incoming_metadata))

        self.assertEqual(created.decision, "created")
        assert created.literature is not None
        self.assertNotEqual(created.literature.literature_id, unrelated.literature_id)
        request = self.memory.read_requests["identity"][0]
        assert isinstance(request, IdentityReadRequest)
        key = fallback_identity_key(incoming_metadata)
        assert key is not None
        self.assertEqual(request.fallback_identity_sha256, fallback_identity_sha256(key))
        command = self.memory.identity_commands[0]
        self.assertEqual(len(command.fallback_identity_indexes), 1)
        self.assertEqual(
            command.fallback_identity_indexes[0].fallback_identity_sha256,
            fallback_identity_sha256(key),
        )

        duplicate = _literature(_ID_4, incoming_metadata)
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={"literatures": (created.literature, duplicate)}
        )
        self.memory.fallback_hash_collision_ids = ()
        ambiguous = self.api.accept_observation(_observation(_ID_5, incoming_metadata))
        self.assertEqual(ambiguous.decision, "rejected")
        self.assertEqual(ambiguous.reason, "fallback-ambiguity")

    def test_user_semantic_hash_collision_is_fully_checked_and_true_replay_reuses_index(
        self,
    ) -> None:
        existing = _literature(_ID_1, _metadata(title="Existing"))
        existing_observation = _user_observation(_ID_3, existing.metadata)
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "literatures": (existing,),
                "observations": (
                    LiteratureObservation(
                        literature_id=existing.literature_id,
                        observation=existing_observation,
                    ),
                ),
            }
        )
        self.memory.user_hash_collision_observation_ids = (existing_observation.observation_id,)
        different = _user_observation(_ID_4, _metadata(title="Different"))
        collision = self.api.accept_observation(different)
        self.assertEqual(collision.decision, "created")
        self.assertFalse(collision.deduplicated)

        fresh_memory = _MemoryFacts()
        service = LiteratureService(
            read_port=fresh_memory,
            identity_port=fresh_memory,
            content_port=fresh_memory,
            reference_port=fresh_memory,
            maintenance_port=fresh_memory,
            id_factory=_FakeIds(),
        )
        api = LiteratureApi(service)
        semantic_metadata = _metadata(
            title="Imported",
            identifiers=(Identifier(namespace="doi", value="10.1000/imported"),),
        )
        first = _user_observation(_ID_1, semantic_metadata)
        replay = _user_observation(_ID_3, semantic_metadata)
        api.accept_observation(first)
        replayed = api.accept_observation(replay)
        self.assertEqual(replayed.decision, "matched")
        self.assertTrue(replayed.deduplicated)
        self.assertEqual(len(fresh_memory.identity_commands), 1)
        index = fresh_memory.identity_commands[0].user_observation_indexes[0]
        self.assertEqual(index.observation_id, first.observation_id)
        self.assertEqual(index.semantic_sha256, user_observation_semantic_sha256(first))
        replay_request = fresh_memory.read_requests["identity"][1]
        assert isinstance(replay_request, IdentityReadRequest)
        self.assertEqual(
            replay_request.user_observation_semantic_sha256,
            user_observation_semantic_sha256(replay),
        )

    def test_unchanged_projection_publication_still_carries_complete_owner_token(self) -> None:
        metadata = _metadata(
            title="Stable",
            identifiers=(Identifier(namespace="doi", value="10.1000/stable-token"),),
        )
        first = self.api.accept_observation(_observation(_ID_1, metadata))
        assert first.literature is not None
        second = self.api.accept_observation(
            _observation(_ID_3, metadata, source_record_id="second-record")
        )
        self.assertEqual(second.decision, "matched")
        self.assertFalse(second.deduplicated)
        command = self.memory.identity_commands[1]
        self.assertEqual(command.literatures, ())
        self.assertEqual(command.facts, ())
        self.assertEqual(len(command.expected_tokens), 1)
        self.assertEqual(command.expected_tokens[0].literature_id, first.literature.literature_id)
        self.assertEqual(command.expected_tokens[0].metadata_revision, 1)
        self.assertEqual(command.expected_tokens[0].metadata_sha256, metadata_sha256(metadata))

    def test_content_ready_user_change_is_enriched_without_replacing_aligned_current_facts(
        self,
    ) -> None:
        doi = Identifier(namespace="doi", value="10.1000/content-ready-enriched")
        provider_metadata = _metadata(title="Provider title", identifiers=(doi,))
        created = self.api.accept_observation(_observation(_ID_1, provider_metadata))
        assert created.literature is not None
        initial_facts = self._with_content_inputs(self.memory.snapshot.facts[0])
        self.memory.snapshot = self.memory.snapshot.model_copy(update={"facts": (initial_facts,)})
        final_metadata = _metadata(
            title="Content-aligned title",
            abstract="Content-aligned abstract",
            identifiers=(doi,),
        )
        self.api.accept_content(
            self._content_proposal(initial_facts, final_metadata=final_metadata)
        )
        before = self.memory.snapshot.facts[0]
        observation_count = len(self.memory.snapshot.observations)

        result = self.api.accept_observation(
            _user_observation(
                _ID_3,
                _metadata(title="Explicit user title", identifiers=(doi,)),
            )
        )

        self.assertEqual(result.decision, "enriched")
        self.assertFalse(result.deduplicated)
        assert result.projection is not None
        self.assertTrue(result.projection.projection_preserved)
        self.assertTrue(result.projection.observations_projection_changed)
        self.assertEqual(len(self.memory.snapshot.observations), observation_count + 1)
        after = self.memory.snapshot.facts[0]
        self.assertEqual(after, before)
        self.assertEqual(after.literature.metadata, final_metadata)
        self.assertEqual(after.metadata_revision, before.metadata_revision)
        self.assertEqual(after.metadata_sha256, before.metadata_sha256)
        self.assertEqual(after.current_content, before.current_content)

    def test_content_ready_same_or_lower_priority_user_facts_are_matched_and_replay_deduplicates(
        self,
    ) -> None:
        memory = _MemoryFacts()
        api = LiteratureApi(
            LiteratureService(
                read_port=memory,
                identity_port=memory,
                content_port=memory,
                reference_port=memory,
                maintenance_port=memory,
                id_factory=_FakeIds(),
            )
        )
        doi = Identifier(namespace="doi", value="10.1000/content-ready-matched")
        provider_metadata = _metadata(title="Provider title", identifiers=(doi,))
        api.accept_observation(_observation(_ID_1, provider_metadata))
        first_user = _user_observation(
            _ID_3,
            _metadata(title="First user title", identifiers=(doi,)),
        )
        self.assertEqual(api.accept_observation(first_user).decision, "enriched")
        initial_facts = self._with_content_inputs(memory.snapshot.facts[0])
        memory.snapshot = memory.snapshot.model_copy(update={"facts": (initial_facts,)})
        api.accept_content(
            self._content_proposal(
                initial_facts,
                final_metadata=_metadata(title="Final title", identifiers=(doi,)),
            )
        )
        before = memory.snapshot.facts[0]

        lower_priority = api.accept_observation(
            _user_observation(
                _ID_4,
                _metadata(title="Later user title", identifiers=(doi,)),
            )
        )
        replay = api.accept_observation(
            _user_observation(
                _ID_5,
                _metadata(title="First user title", identifiers=(doi,)),
            )
        )

        self.assertEqual(lower_priority.decision, "matched")
        self.assertFalse(lower_priority.deduplicated)
        assert lower_priority.projection is not None
        self.assertFalse(lower_priority.projection.observations_projection_changed)
        self.assertEqual(replay.decision, "matched")
        self.assertTrue(replay.deduplicated)
        assert replay.projection is not None
        self.assertFalse(replay.projection.observations_projection_changed)
        self.assertEqual(memory.snapshot.facts[0], before)
        self.assertEqual(len(memory.snapshot.observations), 3)

    def test_content_ready_user_value_equal_to_provider_projection_is_matched_but_retained(
        self,
    ) -> None:
        doi = Identifier(namespace="doi", value="10.1000/content-ready-same")
        provider_metadata = _metadata(title="Same title", identifiers=(doi,))
        self.api.accept_observation(_observation(_ID_1, provider_metadata))
        initial_facts = self._with_content_inputs(self.memory.snapshot.facts[0])
        self.memory.snapshot = self.memory.snapshot.model_copy(update={"facts": (initial_facts,)})
        self.api.accept_content(
            self._content_proposal(
                initial_facts,
                final_metadata=_metadata(title="Final title", identifiers=(doi,)),
            )
        )
        before = self.memory.snapshot.facts[0]

        result = self.api.accept_observation(_user_observation(_ID_3, provider_metadata))

        self.assertEqual(result.decision, "matched")
        self.assertFalse(result.deduplicated)
        assert result.projection is not None
        self.assertFalse(result.projection.observations_projection_changed)
        self.assertEqual(len(self.memory.snapshot.observations), 2)
        self.assertEqual(self.memory.snapshot.facts[0], before)

    def test_non_content_ready_projection_change_remains_enriched(self) -> None:
        doi = Identifier(namespace="doi", value="10.1000/non-content-enriched")
        self.api.accept_observation(
            _observation(_ID_1, _metadata(title="Provider title", identifiers=(doi,)))
        )

        result = self.api.accept_observation(
            _user_observation(_ID_3, _metadata(title="User title", identifiers=(doi,)))
        )

        self.assertEqual(result.decision, "enriched")
        assert result.projection is not None
        self.assertTrue(result.projection.observations_projection_changed)
        self.assertFalse(result.projection.projection_preserved)
        self.assertEqual(result.metadata_revision, 2)

    def test_version_link_record_and_identifier_conditions_must_hit_one_observation(self) -> None:
        target_identifier = Identifier(namespace="doi", value="10.1000/version-target")
        target = _literature(_ID_1, _metadata(title="Target", identifiers=(target_identifier,)))
        record_only = _observation(
            _ID_3,
            _metadata(
                title="Record endpoint",
                identifiers=(Identifier(namespace="doi", value="10.1000/other"),),
            ),
            source_record_id="target-record",
        )
        identifier_only = _observation(
            _ID_4,
            target.metadata,
            source_record_id="other-record",
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "literatures": (target,),
                "observations": (
                    LiteratureObservation(
                        literature_id=target.literature_id,
                        observation=record_only,
                    ),
                    LiteratureObservation(
                        literature_id=target.literature_id,
                        observation=identifier_only,
                    ),
                ),
            }
        )
        incoming = _observation(
            _ID_5,
            _metadata(title="Published"),
            source_record_id="published-record",
            version_role=VersionRole.PUBLISHED,
            version_links=(
                ProviderLiteratureKey(
                    record_id="target-record",
                    identifiers=(target_identifier,),
                ),
            ),
        )

        result = self.api.accept_observation(incoming)

        self.assertEqual(result.decision, "created")
        assert result.literature is not None
        self.assertNotEqual(result.literature.meta_literature_id, target.meta_literature_id)
        self.assertEqual(self.memory.read_calls["identity"], 1)

    def test_explicit_version_link_creates_second_literature_in_existing_meta(self) -> None:
        preprint = _observation(
            _ID_1,
            _metadata(title="Preprint", abstract=None),
            source_record_id="preprint-record",
            source_name="provider",
            version_role=VersionRole.PREPRINT,
        )
        first = self.api.accept_observation(preprint)
        assert first.literature is not None
        published = _observation(
            _ID_2,
            _metadata(title="Published", abstract="final"),
            source_record_id="published-record",
            source_name="provider",
            version_role=VersionRole.PUBLISHED,
            version_links=(ProviderLiteratureKey(record_id="preprint-record"),),
        )
        second = self.api.accept_observation(published)
        self.assertEqual(second.decision, "created")
        self.assertTrue(first.meta_literature_created)
        self.assertFalse(second.meta_literature_created)
        assert second.literature is not None
        self.assertNotEqual(second.literature.literature_id, first.literature.literature_id)
        self.assertEqual(second.literature.meta_literature_id, first.literature.meta_literature_id)
        self.assertEqual(len(self.memory.snapshot.meta_literatures), 1)
        self.assertEqual(
            self.memory.snapshot.meta_literatures[0].representative_literature_id,
            second.literature.literature_id,
        )
        command = self.memory.identity_commands[1]
        self.assertEqual(
            command.clear_automatic_pdf_exhaustion_for,
            (second.literature.literature_id,),
        )
        self.assertEqual(len(command.expected_meta_tokens), 1)
        self.assertEqual(
            command.expected_meta_tokens[0].member_literature_ids,
            (first.literature.literature_id,),
        )

    def test_stale_identity_commit_rejects_without_partial_mutation(self) -> None:
        observation = _observation(_ID_1, _metadata())
        before = self.memory.snapshot
        self.memory.fail_identity = True
        with self.assertRaises(StalePreconditionError):
            self.api.accept_observation(observation)
        self.assertEqual(self.memory.snapshot, before)

    def test_existing_meta_merge_retires_old_meta_and_updates_all_member_facts(self) -> None:
        preprint_metadata = _metadata(
            title="Preprint",
            identifiers=(Identifier(namespace="doi", value="10.1000/preprint"),),
        )
        published_metadata = _metadata(
            title="Published",
            identifiers=(Identifier(namespace="doi", value="10.1000/published"),),
        )
        preprint = self.api.accept_observation(
            _observation(
                _ID_1,
                preprint_metadata,
                source_record_id="preprint-record",
                version_role=VersionRole.PREPRINT,
            )
        )
        published = self.api.accept_observation(
            _observation(
                _ID_2,
                published_metadata,
                source_record_id="published-record",
                version_role=VersionRole.PUBLISHED,
            )
        )
        assert preprint.literature is not None
        assert published.literature is not None
        old_preprint_meta = preprint.literature.meta_literature_id
        surviving_meta = published.literature.meta_literature_id
        enriched_preprint_metadata = _metadata(
            title="Preprint",
            abstract="Enriched abstract",
            identifiers=(Identifier(namespace="doi", value="10.1000/preprint"),),
        )

        merged = self.api.accept_observation(
            _observation(
                _ID_3,
                enriched_preprint_metadata,
                source_record_id="preprint-link-record",
                version_role=VersionRole.PREPRINT,
                version_links=(ProviderLiteratureKey(record_id="published-record"),),
            )
        )

        self.assertEqual(merged.decision, "enriched")
        self.assertFalse(merged.meta_literature_created)
        self.assertEqual(
            tuple(item.meta_literature_id for item in self.memory.snapshot.literatures),
            (surviving_meta, surviving_meta),
        )
        self.assertEqual(
            tuple(item.literature.meta_literature_id for item in self.memory.snapshot.facts),
            (surviving_meta, surviving_meta),
        )
        facts_by_id = {item.literature.literature_id: item for item in self.memory.snapshot.facts}
        current_facts = facts_by_id[preprint.literature.literature_id]
        migrated_target_facts = facts_by_id[published.literature.literature_id]
        self.assertEqual(current_facts.metadata_revision, 2)
        self.assertEqual(
            current_facts.metadata_sha256,
            metadata_sha256(enriched_preprint_metadata),
        )
        self.assertEqual(migrated_target_facts.metadata_revision, 1)
        self.assertEqual(
            migrated_target_facts.metadata_sha256,
            metadata_sha256(published_metadata),
        )
        self.assertEqual(
            tuple(item.meta_literature_id for item in self.memory.snapshot.meta_literatures),
            (surviving_meta,),
        )
        command = self.memory.identity_commands[2]
        self.assertEqual(command.retired_meta_literature_ids, (old_preprint_meta,))
        self.assertEqual(
            {token.meta_literature_id for token in command.expected_meta_tokens},
            {old_preprint_meta, surviving_meta},
        )
        self.assertEqual(
            {token.literature_id for token in command.expected_tokens},
            {preprint.literature.literature_id},
        )

    def test_meta_token_stale_change_rejects_identity_publication_without_partial_write(
        self,
    ) -> None:
        first = self.api.accept_observation(
            _observation(
                _ID_1,
                _metadata(title="Preprint"),
                source_record_id="preprint-record",
                version_role=VersionRole.PREPRINT,
            )
        )
        assert first.literature is not None
        assert first.meta_literature is not None
        published = _observation(
            _ID_2,
            _metadata(title="Published"),
            source_record_id="published-record",
            version_role=VersionRole.PUBLISHED,
            version_links=(ProviderLiteratureKey(record_id="preprint-record"),),
        )
        stale_meta = first.meta_literature.model_copy(
            update={"representative_literature_id": LiteratureId(_ID_8)}
        )
        self.memory.before_identity = lambda: setattr(
            self.memory,
            "snapshot",
            self.memory.snapshot.model_copy(update={"meta_literatures": (stale_meta,)}),
        )
        with self.assertRaises(StalePreconditionError):
            self.api.accept_observation(published)
        self.assertEqual(len(self.memory.identity_commands), 1)
        self.assertEqual(len(self.memory.snapshot.observations), 1)
        self.assertEqual(len(self.memory.snapshot.literatures), 1)

    def test_unresolved_version_link_keeps_new_observation_independent(self) -> None:
        first = self.api.accept_observation(
            _observation(
                _ID_1,
                _metadata(title="Known preprint"),
                source_record_id="known-record",
                version_role=VersionRole.PREPRINT,
            )
        )
        second = self.api.accept_observation(
            _observation(
                _ID_2,
                _metadata(title="Unresolved published"),
                source_record_id="published-record",
                version_role=VersionRole.PUBLISHED,
                version_links=(ProviderLiteratureKey(record_id="missing-record"),),
            )
        )
        assert first.literature is not None
        assert second.literature is not None
        self.assertEqual(second.decision, "created")
        self.assertTrue(first.meta_literature_created)
        self.assertTrue(second.meta_literature_created)
        self.assertNotEqual(
            second.literature.meta_literature_id,
            first.literature.meta_literature_id,
        )
        self.assertEqual(len(self.memory.snapshot.meta_literatures), 2)

    def test_dangling_observation_owner_is_rejected_instead_of_recreated(self) -> None:
        observation = _observation(_ID_1, _metadata(title="Dangling"))
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "observations": (
                    LiteratureObservation(
                        literature_id=LiteratureId(_ID_2),
                        observation=observation,
                    ),
                )
            }
        )
        result = self.api.accept_observation(observation)
        self.assertEqual(result.decision, "rejected")
        self.assertEqual(result.reason, "observation owner is missing or ambiguous")
        self.assertEqual(self.memory.identity_commands, [])

    def test_existing_owner_and_stable_identity_mismatch_is_rejected(self) -> None:
        observation = _observation(
            _ID_1,
            _metadata(
                title="Stable target",
                identifiers=(Identifier(namespace="doi", value="10.1000/stable"),),
            ),
        )
        owner = _literature(_ID_2, _metadata(title="Owner"))
        matching = _literature(
            _ID_3,
            _metadata(
                title="Stable target",
                identifiers=(Identifier(namespace="doi", value="10.1000/stable"),),
            ),
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "literatures": (owner, matching),
                "observations": (
                    LiteratureObservation(
                        literature_id=owner.literature_id,
                        observation=observation,
                    ),
                ),
            }
        )
        result = self.api.accept_observation(observation)
        self.assertEqual(result.decision, "rejected")
        self.assertEqual(result.reason, "observation-owner-identity-conflict")
        self.assertEqual(self.memory.identity_commands, [])

    def test_content_acceptance_replaces_current_view_and_stale_commit_keeps_old_view(self) -> None:
        facts = self._content_facts()
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={"literatures": (facts.literature,), "facts": (facts,)}
        )
        proposal = self._content_proposal(facts)
        accepted = self.api.accept_content(proposal)
        self.assertEqual(accepted.decision, "accepted")
        assert accepted.replacement is not None
        current = self.memory.snapshot.facts[0]
        self.assertEqual(current.current_content, accepted.replacement.content)
        self.assertEqual(current.metadata_revision, 2)

        old_snapshot = self.memory.snapshot
        self.memory.fail_content = True
        newer = self._content_proposal(current, title="New title")
        with self.assertRaises(StalePreconditionError):
            self.api.accept_content(newer)
        self.assertEqual(self.memory.snapshot, old_snapshot)
        self.assertEqual(self.memory.read_calls["content"], 2)

    def test_content_cleanup_rejects_an_omitted_last_support_from_the_scoped_closure(self) -> None:
        facts = self._content_facts()
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={"literatures": (facts.literature,), "facts": (facts,)}
        )
        self.api.accept_content(self._content_proposal(facts))
        current = self.memory.snapshot.facts[0]
        assert current.current_content is not None
        reference = Reference(
            reference_id=ReferenceId(_ID_8),
            source_literature_id=current.literature.literature_id,
            target_literature_id=LiteratureId(_ID_7),
        )
        support = ReferenceSupport(
            reference_id=reference.reference_id,
            source=ContentReferenceTextSupport(
                kind="content_reference_text",
                literature_content_sha256=current.current_content.literature_content_sha256,
                reference_index=0,
            ),
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={"references": (reference,), "supports": (support,)}
        )
        self.memory.omit_content_supports = True

        with self.assertRaisesRegex(
            LiteratureInvariantError,
            "cleanup closure is incomplete or ambiguous",
        ):
            self.api.accept_content(self._content_proposal(current, title="Replacement"))

        self.assertEqual(len(self.memory.content_commands), 1)
        self.assertEqual(self.memory.read_calls["content"], 2)

    def test_content_replacement_carries_the_complete_reference_closure_cas_token(self) -> None:
        facts = self._content_facts()
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={"literatures": (facts.literature,), "facts": (facts,)}
        )
        self.api.accept_content(self._content_proposal(facts))
        current = self.memory.snapshot.facts[0]

        accepted = self.api.accept_content(self._content_proposal(current, title="Replacement"))

        self.assertEqual(accepted.decision, "accepted")
        command = self.memory.content_commands[1]
        self.assertIsNotNone(command.cleanup)
        self.assertIsNotNone(command.expected_reference_closure_token)
        assert command.expected_reference_closure_token is not None
        self.assertEqual(command.expected_reference_closure_token.reference_count, 0)
        self.assertEqual(command.expected_reference_closure_token.support_count, 0)
        self.assertEqual(self.memory.read_calls["content"], 2)

    def test_content_publication_command_carries_cleanup_and_no_file_or_llm_object(self) -> None:
        facts = self._content_facts()
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={"literatures": (facts.literature,), "facts": (facts,)}
        )
        final_metadata = _metadata(
            title="Final title",
            authors=(Author(kind=AuthorKind.PERSON, display_name="Ada Lovelace"),),
            abstract="Final abstract",
            document_type="article",
        )
        proposal = self._content_proposal(facts, final_metadata=final_metadata)
        decision = self.api.accept_content(proposal)
        assert decision.replacement is not None
        accepted_content = decision.replacement.content
        command = self.memory.content_commands[0]
        self.assertEqual(command.replacement.literature_id, facts.literature.literature_id)
        self.assertEqual(command.expected_primary_asset_id, proposal.primary_asset_id)
        self.assertEqual(command.expected_primary_pdf_sha256, proposal.primary_pdf_sha256)
        self.assertEqual(command.expected_parser_result_sha256, proposal.parser_result_sha256)
        structured_bytes = canonical_literature_content_json(accepted_content)
        self.assertEqual(
            structured_bytes,
            json.dumps(
                accepted_content.model_dump(mode="json"),
                allow_nan=False,
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8"),
        )
        self.assertEqual(command.structured_artifact, literature_content_artifact(accepted_content))
        self.assertEqual(command.structured_artifact.byte_size, len(structured_bytes))
        self.assertEqual(command.structured_artifact.media_type, "application/json")
        with command.structured_content.open() as first:
            self.assertEqual(first.read(), structured_bytes)
        with command.structured_content.open() as second:
            self.assertEqual(second.read(), structured_bytes)
        fallback_key = fallback_identity_key(final_metadata)
        assert fallback_key is not None
        self.assertIsNotNone(command.fallback_identity_index)
        assert command.fallback_identity_index is not None
        self.assertEqual(
            command.fallback_identity_index.fallback_identity_sha256,
            fallback_identity_sha256(fallback_key),
        )
        self.assertNotIn("path", ContentPublicationCommand.model_fields)
        self.assertNotIn("llm_response", ContentPublicationCommand.model_fields)
        self.assertEqual(self.memory.read_calls["content"], 1)

    def test_reference_first_support_is_atomic_and_followup_support_is_idempotent(self) -> None:
        source = _literature(_ID_1, _metadata(title="Source"))
        target = _literature(_ID_2, _metadata(title="Target"))
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "literatures": (source, target),
                "facts": (_initial_facts(source), _initial_facts(target)),
            }
        )
        provider_relation = ProviderRelationObservation(
            observation_id=ObservationId(_ID_3),
            provenance=_provenance(_ID_3),
            citing=ProviderLiteratureKey(record_id="source-record"),
            cited=ProviderLiteratureKey(record_id="target-record"),
        )
        evidence = ProviderRelationEvidence(
            observation=provider_relation,
            source=source,
            target=target,
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={"provider_relations": (provider_relation,)}
        )
        first = self.api.publish_reference(
            source=source,
            target=target,
            provider_relations=(evidence,),
        )
        self.assertEqual(first.decision, "created")
        self.assertEqual(len(self.memory.snapshot.references), 1)
        self.assertEqual(len(self.memory.snapshot.supports), 1)
        repeated = self.api.publish_reference(
            source=source,
            target=target,
            provider_relations=(evidence,),
        )
        self.assertEqual(repeated.decision, "matched")
        self.assertEqual(len(self.memory.snapshot.references), 1)
        self.assertEqual(len(self.memory.snapshot.supports), 1)
        self.assertEqual(len(self.memory.support_commands), 0)

        second_relation = ProviderRelationObservation(
            observation_id=ObservationId(_ID_4),
            provenance=_provenance(_ID_4),
            citing=ProviderLiteratureKey(record_id="source-record-2"),
            cited=ProviderLiteratureKey(record_id="target-record-2"),
        )
        second_evidence = ProviderRelationEvidence(
            observation=second_relation,
            source=source,
            target=target,
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "provider_relations": self.memory.snapshot.provider_relations + (second_relation,)
            }
        )
        appended = self.api.publish_reference(
            source=source,
            target=target,
            provider_relations=(second_evidence,),
        )
        self.assertEqual(appended.decision, "matched")
        self.assertEqual(len(self.memory.support_commands), 1)
        append_command = self.memory.support_commands[0]
        self.assertEqual(append_command.source_token.literature_id, source.literature_id)
        self.assertEqual(append_command.target_token.literature_id, target.literature_id)
        self.assertEqual(len(self.memory.snapshot.supports), 2)
        self.assertEqual(self.memory.read_calls["reference"], 3)

    def test_status_reads_derive_status_instead_of_trusting_literature_status(self) -> None:
        literature = _literature(
            _ID_1,
            _metadata(),
            status=LiteratureStatus.CONTENT_READY,
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "literatures": (literature,),
                "facts": (
                    CurrentLiteratureFacts(
                        literature=literature,
                        metadata_revision=1,
                        metadata_sha256=metadata_sha256(literature.metadata),
                    ),
                ),
            }
        )
        status = self.api.read_status(literature.literature_id)
        self.assertEqual(status.status, LiteratureStatus.UNREVIEWED)
        self.assertEqual(self.memory.read_calls["current_facts"], 1)

    def test_scoped_fact_read_returns_ambiguity_instead_of_weakening_the_token(self) -> None:
        literature = _literature(_ID_1, _metadata())
        facts = _initial_facts(literature)
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={"literatures": (literature,), "facts": (facts, facts)}
        )
        with self.assertRaisesRegex(
            LiteratureInvariantError,
            "current facts are ambiguous",
        ):
            self.api.read_facts(literature.literature_id)
        self.assertEqual(self.memory.read_calls["current_facts"], 1)

    def test_delete_rejects_representative_or_referenced_member_and_allows_safe_member(
        self,
    ) -> None:
        representative = _literature(
            _ID_1, _metadata(title="Published"), meta_identifier=_ID_3, role=VersionRole.PUBLISHED
        )
        other = _literature(
            _ID_2, _metadata(title="Preprint"), meta_identifier=_ID_3, role=VersionRole.PREPRINT
        )
        meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID_3),
            representative_literature_id=representative.literature_id,
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "literatures": (representative, other),
                "meta_literatures": (meta,),
                "facts": (_initial_facts(representative), _initial_facts(other)),
            }
        )
        rejected = self.api.delete_literature(representative.literature_id)
        self.assertEqual(rejected.decision, "rejected")
        self.assertEqual(len(self.memory.snapshot.literatures), 2)
        deleted = self.api.delete_literature(other.literature_id)
        self.assertEqual(deleted.decision, "deleted")
        self.assertEqual(
            tuple(item.literature_id for item in self.memory.snapshot.literatures),
            (LiteratureId(_ID_1),),
        )
        self.assertEqual(self.memory.read_calls["deletion"], 2)

    def test_deleting_the_last_unreferenced_member_atomically_retires_its_meta(self) -> None:
        literature = _literature(_ID_1, _metadata(title="Only member"))
        meta = MetaLiterature(
            meta_literature_id=literature.meta_literature_id,
            representative_literature_id=literature.literature_id,
        )
        self.memory.snapshot = self.memory.snapshot.model_copy(
            update={
                "literatures": (literature,),
                "meta_literatures": (meta,),
                "facts": (_initial_facts(literature),),
            }
        )

        result = self.api.delete_literature(literature.literature_id)

        self.assertEqual(result.decision, "deleted")
        self.assertEqual(self.memory.snapshot.literatures, ())
        self.assertEqual(self.memory.snapshot.meta_literatures, ())
        command = self.memory.delete_commands[0]
        self.assertEqual(
            command.expected_meta_token.member_literature_ids,
            (literature.literature_id,),
        )
        self.assertIsNone(command.replacement_representative_id)
        self.assertEqual(self.memory.read_calls["deletion"], 1)

    def _content_facts(self) -> CurrentLiteratureFacts:
        literature = _literature(_ID_1, _metadata(title="Current"))
        return self._with_content_inputs(_initial_facts(literature))

    def _with_content_inputs(
        self,
        facts: CurrentLiteratureFacts,
    ) -> CurrentLiteratureFacts:
        literature = facts.literature
        asset = Asset(
            asset_id=AssetId(_ID_2),
            sha256=_HASH_B,
            size_bytes=10,
            media_type="application/pdf",
            path=RelativeArtifactPath("pdf/current.pdf"),
        )
        relation = LiteratureAsset(
            literature_asset_id=LiteratureAssetId(_ID_3),
            literature_id=literature.literature_id,
            asset_id=asset.asset_id,
            role=AssetRole.PRIMARY_PDF,
            provenance=_provenance(
                _ID_4,
                source_kind=SourceKind.ASSET_PROVIDER,
                source_name="asset",
                source_record_id=None,
                input_sha256=asset.sha256,
            ),
        )
        parser_provenance = ParserProvenance(
            provenance=_provenance(
                _ID_5,
                source_kind=SourceKind.PARSER,
                source_name="parser",
                source_record_id=None,
                input_sha256=asset.sha256,
                parameters_sha256=_HASH_C,
            ),
            parser_version="1",
        )
        parser_markdown = ParserArtifactRef(sha256=_HASH_C, media_type="text/markdown", byte_size=1)
        parser_hash = parser_result_sha256(
            source_asset_id=asset.asset_id,
            source_sha256=asset.sha256,
            page_count=1,
            markdown=parser_markdown,
            resources=(),
            provenance=parser_provenance,
        )
        parser = ParserResult(
            source_asset_id=asset.asset_id,
            source_sha256=asset.sha256,
            page_count=1,
            markdown=parser_markdown,
            result_sha256=parser_hash,
            provenance=parser_provenance,
        )
        return facts.model_copy(
            update={
                "current_primary_pdfs": (CurrentPrimaryPdf(asset=asset, relation=relation),),
                "current_parser_result": parser,
            }
        )

    def _content_proposal(
        self,
        facts: CurrentLiteratureFacts,
        *,
        title: str = "Final title",
        final_metadata: LiteratureMetadata | None = None,
    ) -> LiteratureContentProposal:
        if final_metadata is None:
            final_metadata = _metadata(title=title, abstract="Final abstract")
        sections = tuple(
            LiteratureSection(role=role, markdown="body")
            for role in (
                LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
                LiteratureSectionRole.METHODS,
                LiteratureSectionRole.DATA,
                LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
            )
        )
        final_hash = metadata_sha256(final_metadata)
        references = ("Target, 2025.",)
        content_hash = content_sha256(
            metadata_sha256=final_hash,
            sections=sections,
            references=references,
        )
        primary = facts.current_primary_pdfs[0]
        parser = facts.current_parser_result
        if parser is None:
            raise AssertionError("content proposal fixture requires a parser result")
        content_provenance = _provenance(
            _ID_6,
            source_kind=SourceKind.ANALYSIS,
            source_name="analysis",
            source_record_id=None,
            input_sha256=analysis_input_sha256(
                primary.asset.sha256,
                parser.result_sha256,
                final_hash,
            ),
            parameters_sha256=_HASH_C,
        )
        markdown = render_canonical_markdown(
            metadata=final_metadata,
            sections=sections,
            references=references,
        )
        return LiteratureContentProposal(
            literature_id=facts.literature.literature_id,
            primary_asset_id=primary.asset.asset_id,
            primary_pdf_sha256=primary.asset.sha256,
            parser_result_sha256=parser.result_sha256,
            input_metadata_revision=facts.metadata_revision,
            input_metadata_sha256=facts.metadata_sha256,
            final_metadata=final_metadata,
            metadata_sha256=final_hash,
            sections=sections,
            references=references,
            literature_content_sha256=content_hash,
            markdown=ArtifactRef(
                sha256=sha256_digest(markdown),
                media_type="text/markdown",
                byte_size=len(markdown),
            ),
            provenance=content_provenance,
        )


class _RecordingQueryPort:
    """A query-only fake whose opaque results expose accidental wrapping."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []
        self.search_result = LibrarySearchPage(items=(), total_count=0)
        self.detail_result = cast(LiteratureDetail, object())
        self.references_result = LiteratureReferencePage(items=(), total_count=0)
        self.reference_detail_result = cast(ReferenceDetail, object())
        self.meta_result = MetaLiteratureReadContext()
        self.provider_relations_result = ProviderRelationObservationReadContext()

    def search(self, request: LibrarySearchRequest) -> LibrarySearchPage:
        self.calls.append(("search", request))
        return self.search_result

    def read_detail(self, literature_id: LiteratureId) -> LiteratureDetail:
        self.calls.append(("read_detail", literature_id))
        return self.detail_result

    def read_references(
        self,
        request: LiteratureReferenceRequest,
    ) -> LiteratureReferencePage:
        self.calls.append(("read_references", request))
        return self.references_result

    def read_reference_detail(self, reference_id: ReferenceId) -> ReferenceDetail:
        self.calls.append(("read_reference_detail", reference_id))
        return self.reference_detail_result

    def read_meta_literatures(
        self,
        request: MetaLiteratureReadRequest,
    ) -> MetaLiteratureReadContext:
        self.calls.append(("read_meta_literatures", request))
        return self.meta_result

    def read_provider_relation_observations(
        self,
        request: ProviderRelationObservationReadRequest,
    ) -> ProviderRelationObservationReadContext:
        self.calls.append(("read_provider_relation_observations", request))
        return self.provider_relations_result


class LiteratureQueryApiTests(unittest.TestCase):
    def test_every_public_query_operation_is_one_exact_query_port_delegation(self) -> None:
        memory = _MemoryFacts()
        query_port = _RecordingQueryPort()
        api = LiteratureApi(
            LiteratureService(
                read_port=memory,
                identity_port=memory,
                content_port=memory,
                reference_port=memory,
                maintenance_port=memory,
                id_factory=_FakeIds(),
                query_port=query_port,
            )
        )
        search_request = LibrarySearchRequest(
            query=LibraryQuery(title="Graph retrieval"),
            sort="title-asc",
            limit=7,
        )
        literature_id = LiteratureId(_ID_1)
        references_request = LiteratureReferenceRequest(
            literature_id=literature_id,
            direction="cited-by",
            limit=11,
        )
        reference_id = ReferenceId(_ID_2)
        meta_request = MetaLiteratureReadRequest(
            meta_literature_ids=(MetaLiteratureId(_ID_3), MetaLiteratureId(_ID_4))
        )
        provider_request = ProviderRelationObservationReadRequest(
            observation_ids=(ObservationId(_ID_5), ObservationId(_ID_6))
        )
        cases: tuple[
            tuple[str, object, Callable[[], object], object],
            ...,
        ] = (
            (
                "search",
                search_request,
                lambda: api.search(search_request),
                query_port.search_result,
            ),
            (
                "read_detail",
                literature_id,
                lambda: api.read_detail(literature_id),
                query_port.detail_result,
            ),
            (
                "read_references",
                references_request,
                lambda: api.read_references(references_request),
                query_port.references_result,
            ),
            (
                "read_reference_detail",
                reference_id,
                lambda: api.read_reference_detail(reference_id),
                query_port.reference_detail_result,
            ),
            (
                "read_meta_literatures",
                meta_request,
                lambda: api.read_meta_literatures(meta_request),
                query_port.meta_result,
            ),
            (
                "read_provider_relation_observations",
                provider_request,
                lambda: api.read_provider_relation_observations(provider_request),
                query_port.provider_relations_result,
            ),
        )

        for method_name, argument, invoke, expected in cases:
            with self.subTest(method=method_name):
                query_port.calls.clear()
                self.assertIs(invoke(), expected)
                self.assertEqual(len(query_port.calls), 1)
                self.assertEqual(query_port.calls[0][0], method_name)
                self.assertIs(query_port.calls[0][1], argument)
                self.assertEqual(memory.read_calls, {})
                self.assertEqual(memory.identity_commands, [])
                self.assertEqual(memory.content_commands, [])
                self.assertEqual(memory.reference_commands, [])
                self.assertEqual(memory.support_commands, [])
                self.assertEqual(memory.delete_commands, [])

    def test_search_reaches_real_sqlite_query_port_through_api_and_service(self) -> None:
        with TemporaryDirectory(prefix="sciretriever-literature-api-query-") as temporary:
            temporary_path = Path(temporary)
            engine = CatalogEngine(temporary_path / "catalog.sqlite")
            writer = LiteratureWriter(engine)
            literature = _literature(
                _ID_1,
                _metadata(title="SQLite API integration"),
            )
            writer.publish_identity_and_observation(
                IdentityObservationPublicationCommand(
                    literatures=(literature,),
                    meta_literatures=(
                        MetaLiterature(
                            meta_literature_id=literature.meta_literature_id,
                            representative_literature_id=literature.literature_id,
                        ),
                    ),
                    observations=(),
                    facts=(_initial_facts(literature),),
                    expected_tokens=(),
                    expected_meta_tokens=(),
                )
            )
            query_port = LiteratureReader(
                engine,
                VerifiedReader(StorageRoot(temporary_path / "artifacts")),
            )
            memory = _MemoryFacts()
            api = LiteratureApi(
                LiteratureService(
                    read_port=memory,
                    identity_port=memory,
                    content_port=memory,
                    reference_port=memory,
                    maintenance_port=memory,
                    id_factory=_FakeIds(),
                    query_port=query_port,
                )
            )

            page = api.search(
                LibrarySearchRequest(
                    query=LibraryQuery(title="SQLite API integration"),
                )
            )

            self.assertEqual(page.total_count, 1)
            self.assertEqual(len(page.items), 1)
            self.assertEqual(page.items[0].literature, literature)
            self.assertEqual(memory.read_calls, {})


if __name__ == "__main__":
    unittest.main()
