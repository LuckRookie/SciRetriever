"""Literature use-case orchestration over Literature-owned Ports.

Each use case requests one Literature-owned scoped read closure, invokes the
pure L1 through L4 decisions, and sends a closed publication command back to
Storage.  No operation reads a whole catalog or asks Storage to choose an
identity winner.
No command performs I/O itself.  Provider, Parser, LLM and Analysis Markdown
publication happen before this service is called; after acceptance, this
service serializes the final structured LiteratureContent into a path-free,
repeatably-openable capability for Storage to publish.
"""

from __future__ import annotations

from collections.abc import Iterable
from contextlib import AbstractContextManager, closing
from io import BytesIO
from typing import BinaryIO, Literal, Protocol, cast

from pydantic import BaseModel, ConfigDict, Field, model_validator

from sciretriever.literature.content import (
    ContentAcceptanceDecision,
    canonical_literature_content_json,
    decide_content_acceptance,
    literature_content_artifact,
    metadata_sha256,
)
from sciretriever.literature.identity import (
    VersionEvidence,
    fallback_identity_key,
    fallback_identity_sha256,
    resolve_literature_identity,
    resolve_meta_literature,
    stable_identifier_index,
)
from sciretriever.literature.metadata import (
    MetadataProjectionDecision,
    accept_observation,
    same_provider_observation,
    same_user_observation,
    user_observation_semantic_sha256,
)
from sciretriever.literature.ports import (
    ContentPublicationCommand,
    ContentPublicationPort,
    ContentReadContext,
    ContentReadRequest,
    ContentReferenceClosureToken,
    CurrentFactsReadContext,
    CurrentFactsReadRequest,
    DeletionReadContext,
    DeletionReadRequest,
    FallbackIdentityIndex,
    IdentityObservationPublicationCommand,
    IdentityObservationPublicationPort,
    IdentityReadContext,
    IdentityReadRequest,
    LiteratureArtifactReadError,
    LiteratureArtifactReadPort,
    LiteratureArtifactReference,
    LiteratureDeletionCommand,
    LiteratureIdentityToken,
    LiteratureMaintenancePort,
    LiteratureObservation,
    LiteratureQueryPort,
    LiteratureReadPort,
    MetaLiteratureIdentityToken,
    MetaLiteratureReadContext,
    MetaLiteratureReadRequest,
    ProviderRecordReadKey,
    ProviderRelationObservationReadContext,
    ProviderRelationObservationReadRequest,
    ReferencePublicationCommand,
    ReferencePublicationPort,
    ReferenceReadContext,
    ReferenceReadRequest,
    ReferenceSupportAppendCommand,
    StructuredContentArtifactContent,
    UserObservationIndex,
    VersionLinkReadKey,
    content_reference_closure_token,
)
from sciretriever.literature.references import (
    ContentReferenceEvidence,
    MetadataReferenceEvidence,
    ProviderRelationEvidence,
    ReferenceAcceptanceDecision,
    ReferenceCleanupDecision,
    decide_content_replacement_cleanup,
    decide_reference,
)
from sciretriever.literature.state import CurrentLiteratureFacts, derive_status
from sciretriever.model.analysis import LiteratureContentProposal
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
    LiteratureStatus,
    MetaLiterature,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ReferenceId,
    Sha256,
    SourceKind,
)


class IdFactory(Protocol):
    """The narrow ID-generation capability needed by Literature service."""

    def new_literature_id(self) -> LiteratureId: ...

    def new_meta_literature_id(self) -> MetaLiteratureId: ...

    def new_reference_id(self) -> ReferenceId: ...


class _CanonicalStructuredContent:
    """Private repeatable capability over accepted canonical JSON bytes."""

    __slots__ = ("_payload",)

    def __init__(self, payload: bytes) -> None:
        if type(payload) is not bytes or not payload:
            raise TypeError("payload must be non-empty bytes")
        self._payload = payload

    def open(self) -> AbstractContextManager[BinaryIO]:
        return closing(BytesIO(self._payload))


class LiteratureNotFoundError(LookupError):
    """The requested concrete Literature is not in the read snapshot."""


class LiteratureInvariantError(RuntimeError):
    """A Port snapshot violates an invariant required by a write operation."""


class _ServiceModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


class ObservationAcceptanceResult(_ServiceModel):
    """The accepted Literature and observation decision returned to callers."""

    decision: Literal["created", "enriched", "matched", "rejected"]
    meta_literature_created: bool = Field(default=False, strict=True)
    literature: Literature | None = None
    meta_literature: MetaLiterature | None = None
    observation: MetadataObservation | None = None
    projection: MetadataProjectionDecision | None = None
    metadata_revision: int | None = Field(default=None, strict=True, ge=1)
    deduplicated: bool = False
    reason: str | None = None

    @model_validator(mode="after")
    def validate_combination(self) -> "ObservationAcceptanceResult":
        if self.decision != "created" and self.meta_literature_created:
            raise ValueError("only a created Literature can create a MetaLiterature")
        if self.decision == "rejected":
            if (
                self.literature is not None
                or self.meta_literature is not None
                or self.observation is not None
                or self.projection is not None
                or self.metadata_revision is not None
                or self.deduplicated
            ):
                raise ValueError("rejected observation result cannot carry accepted facts")
            if self.reason is None:
                raise ValueError("rejected observation result requires a reason")
            return self
        if self.literature is None or self.meta_literature is None:
            raise ValueError("accepted observation result requires Literature identities")
        if self.observation is None or self.projection is None:
            raise ValueError("accepted observation result requires source and projection")
        if self.projection.outcome == "rejected":
            raise ValueError("accepted observation result cannot carry rejected projection")
        if self.metadata_revision is None:
            raise ValueError("accepted observation result requires metadata revision")
        return self


class LiteratureStatusResult(_ServiceModel):
    """A status derived from current facts, never from ``Literature.status``."""

    literature_id: LiteratureId
    status: LiteratureStatus
    facts: CurrentLiteratureFacts


class LiteratureMaintenanceResult(_ServiceModel):
    """Result of a safe Literature deletion request."""

    decision: Literal["deleted", "rejected"]
    literature_id: LiteratureId
    reason: str | None = None

    @model_validator(mode="after")
    def validate_combination(self) -> "LiteratureMaintenanceResult":
        if self.decision == "deleted" and self.reason is not None:
            raise ValueError("deleted maintenance result cannot carry a reason")
        if self.decision == "rejected" and self.reason is None:
            raise ValueError("rejected maintenance result requires a reason")
        return self


class NoUsableContentCleanupPreparation(_ServiceModel):
    """Literature-owned Reference closure decision for removing current content."""

    cleanup: ReferenceCleanupDecision
    reference_closure_token: ContentReferenceClosureToken

    @model_validator(mode="after")
    def validate_binding(self) -> "NoUsableContentCleanupPreparation":
        if self.cleanup.decision == "rejected":
            raise ValueError("cleanup preparation cannot carry a rejected decision")
        if self.cleanup.source_literature_id != self.reference_closure_token.source_literature_id:
            raise ValueError("cleanup decision and Reference closure must identify one Literature")
        return self


class _IdentityPublication(_ServiceModel):
    """Internal identity transaction plan assembled from one read snapshot."""

    literature: Literature
    meta_literature: MetaLiterature
    meta_literature_created: bool = Field(strict=True)
    changed_literatures: tuple[Literature, ...]
    changed_meta_literatures: tuple[MetaLiterature, ...]
    facts: tuple[CurrentLiteratureFacts, ...]
    expected_tokens: tuple[LiteratureIdentityToken, ...]
    expected_meta_tokens: tuple[MetaLiteratureIdentityToken, ...]
    retired_meta_literature_ids: tuple[MetaLiteratureId, ...]


class _LiteratureContext(Protocol):
    literatures: tuple[Literature, ...]


class _FactsContext(Protocol):
    facts: tuple[CurrentLiteratureFacts, ...]


class _MetaContext(Protocol):
    literatures: tuple[Literature, ...]
    meta_literatures: tuple[MetaLiterature, ...]


class LiteratureService:
    """Coordinate Literature decisions and atomic publication Ports."""

    def __init__(
        self,
        *,
        read_port: LiteratureReadPort,
        identity_port: IdentityObservationPublicationPort,
        content_port: ContentPublicationPort,
        reference_port: ReferencePublicationPort,
        maintenance_port: LiteratureMaintenancePort,
        id_factory: IdFactory,
        query_port: LiteratureQueryPort | None = None,
        artifact_read_port: LiteratureArtifactReadPort | None = None,
    ) -> None:
        self._read_port = read_port
        self._identity_port = identity_port
        self._content_port = content_port
        self._reference_port = reference_port
        self._maintenance_port = maintenance_port
        self._id_factory = id_factory
        self._query_port = query_port
        self._artifact_read_port = artifact_read_port

    def accept_observation(  # noqa: C901
        self,
        observation: MetadataObservation,
        *,
        provider_precedence: Iterable[str] = (),
    ) -> ObservationAcceptanceResult:
        stable_keys = stable_identifier_index(observation.metadata)
        fallback_key = fallback_identity_key(observation.metadata) if not stable_keys else None
        context = self._read_identity(
            IdentityReadRequest(
                observation_id=observation.observation_id,
                provider_record_key=_provider_record_read_key(observation),
                stable_identifier_keys=stable_keys,
                fallback_identity_sha256=(
                    fallback_identity_sha256(fallback_key) if fallback_key is not None else None
                ),
                user_observation_semantic_sha256=(
                    user_observation_semantic_sha256(observation)
                    if observation.provenance.source_kind is SourceKind.USER
                    else None
                ),
                version_link_keys=_version_link_read_keys(observation),
            )
        )
        try:
            existing_owner = _observation_owner(context, observation)
        except LiteratureInvariantError as error:
            return _rejected_observation(str(error))
        current = existing_owner
        identity = resolve_literature_identity(
            observation.metadata,
            context.literatures,
        )
        if identity.decision == "identity-conflict":
            return _rejected_observation(identity.reason or "identity-conflict")
        if (
            existing_owner is not None
            and identity.literature is not None
            and identity.literature.literature_id != existing_owner.literature_id
        ):
            return _rejected_observation("observation-owner-identity-conflict")

        if current is None:
            current = identity.literature
        current_observations = (
            tuple(
                link.observation
                for link in context.observations
                if link.literature_id == current.literature_id
            )
            if current is not None
            else ()
        )
        facts = self._facts_for(context, current.literature_id) if current is not None else None
        revision = facts.metadata_revision if facts is not None else 1
        content_ready = facts is not None and derive_status(facts) is LiteratureStatus.CONTENT_READY
        metadata = current.metadata if current is not None else None
        decision = accept_observation(
            observation,
            existing_literature=context.literatures,
            existing_observations=current_observations,
            provider_precedence=provider_precedence,
            current_metadata=metadata,
            metadata_revision=revision,
            content_ready=content_ready,
        )
        if decision.outcome == "rejected":
            return _rejected_observation(decision.reason or "observation-rejected")
        projection = decision.projection
        if projection is None or projection.metadata is None:
            raise LiteratureInvariantError("accepted observation lacks projected metadata")
        accepted_observation = decision.observation
        if accepted_observation is None:
            raise LiteratureInvariantError("accepted observation lacks its source fact")

        try:
            if current is None:
                publication = self._new_identity(
                    context,
                    accepted_observation,
                    projection.metadata,
                )
            else:
                assert facts is not None
                publication = self._existing_identity(
                    context,
                    current,
                    facts,
                    accepted_observation,
                    projection,
                )
        except LiteratureInvariantError as error:
            return _rejected_observation(str(error))

        new_links = (
            ()
            if decision.deduplicated
            else (
                LiteratureObservation(
                    literature_id=publication.literature.literature_id,
                    observation=accepted_observation,
                ),
            )
        )
        command = IdentityObservationPublicationCommand(
            literatures=publication.changed_literatures,
            meta_literatures=publication.changed_meta_literatures,
            observations=new_links,
            facts=publication.facts,
            expected_tokens=publication.expected_tokens,
            expected_meta_tokens=publication.expected_meta_tokens,
            fallback_identity_indexes=tuple(
                index
                for item in publication.changed_literatures
                if (index := _fallback_index_for(item.literature_id, item.metadata)) is not None
            ),
            user_observation_indexes=tuple(
                index
                for link in new_links
                if (index := _user_observation_index(link.observation)) is not None
            ),
            retired_meta_literature_ids=publication.retired_meta_literature_ids,
            clear_automatic_pdf_exhaustion_for=(
                (publication.literature.literature_id,) if not decision.deduplicated else ()
            ),
        )
        if (
            publication.changed_literatures
            or publication.changed_meta_literatures
            or publication.facts
            or new_links
            or command.clear_automatic_pdf_exhaustion_for
        ):
            self._identity_port.publish_identity_and_observation(command)

        outcome: Literal["created", "enriched", "matched"]
        if current is None:
            outcome = "created"
        elif projection.observations_projection_changed and not decision.deduplicated:
            outcome = "enriched"
        else:
            outcome = "matched"
        return ObservationAcceptanceResult(
            decision=outcome,
            meta_literature_created=publication.meta_literature_created,
            literature=publication.literature,
            meta_literature=publication.meta_literature,
            observation=accepted_observation,
            projection=projection,
            metadata_revision=projection.metadata_revision,
            deduplicated=decision.deduplicated,
            reason=None,
        )

    def accept_content(self, proposal: LiteratureContentProposal) -> ContentAcceptanceDecision:
        context = self._read_content(ContentReadRequest(literature_id=proposal.literature_id))
        facts = self._facts_for(context, proposal.literature_id)
        assert facts is not None
        decision = decide_content_acceptance(facts, proposal)
        if decision.decision == "rejected":
            return decision
        replacement = decision.replacement
        if replacement is None:
            raise LiteratureInvariantError("accepted content lacks replacement")
        structured_bytes = canonical_literature_content_json(replacement.content)
        structured_content: StructuredContentArtifactContent = _CanonicalStructuredContent(
            structured_bytes
        )
        cleanup = None
        expected_reference_closure_token = None
        if decision.old_content_sha256_to_cleanup is not None:
            stored_reference_closure_token = context.reference_closure_token
            if (
                stored_reference_closure_token.source_literature_id != proposal.literature_id
                or stored_reference_closure_token.reference_count != len(context.references)
                or stored_reference_closure_token.support_count != len(context.supports)
            ):
                raise LiteratureInvariantError(
                    "content Reference cleanup closure is incomplete or ambiguous"
                )
            try:
                expected_reference_closure_token = content_reference_closure_token(
                    proposal.literature_id,
                    context.references,
                    context.supports,
                )
            except (TypeError, ValueError) as error:
                raise LiteratureInvariantError(
                    "content Reference cleanup closure is invalid"
                ) from error
            if expected_reference_closure_token != stored_reference_closure_token:
                raise LiteratureInvariantError(
                    "content Reference cleanup closure is incomplete or ambiguous"
                )
            cleanup = decide_content_replacement_cleanup(
                source_literature_id=proposal.literature_id,
                old_content_sha256=decision.old_content_sha256_to_cleanup,
                references=context.references,
                supports=context.supports,
            )
            if cleanup.decision == "rejected":
                raise LiteratureInvariantError(cleanup.reason or "content support cleanup rejected")
        self._content_port.publish_content(
            ContentPublicationCommand(
                expected_token=_token(facts.literature, facts),
                expected_primary_asset_id=proposal.primary_asset_id,
                expected_primary_pdf_sha256=proposal.primary_pdf_sha256,
                expected_parser_result_sha256=proposal.parser_result_sha256,
                replacement=replacement,
                structured_artifact=literature_content_artifact(replacement.content),
                structured_content=structured_content,
                fallback_identity_index=_fallback_index_for(
                    replacement.literature_id,
                    replacement.metadata,
                ),
                cleanup=cleanup,
                expected_reference_closure_token=expected_reference_closure_token,
            )
        )
        return decision

    def prepare_no_usable_content_cleanup(
        self,
        literature_id: LiteratureId,
        old_content_sha256: Sha256,
    ) -> NoUsableContentCleanupPreparation:
        """Form the complete Reference cleanup decision for current content removal."""

        if not isinstance(literature_id, LiteratureId):
            raise TypeError("literature_id must be a LiteratureId")
        if not isinstance(old_content_sha256, Sha256):
            raise TypeError("old_content_sha256 must be a Sha256")
        context = self._read_content(ContentReadRequest(literature_id=literature_id))
        facts = self._facts_for(context, literature_id)
        assert facts is not None
        current_content = facts.current_content
        if (
            current_content is None
            or current_content.literature_content_sha256 != old_content_sha256
        ):
            raise LiteratureInvariantError("current LiteratureContent changed before cleanup")
        stored_token = context.reference_closure_token
        if (
            stored_token.source_literature_id != literature_id
            or stored_token.reference_count != len(context.references)
            or stored_token.support_count != len(context.supports)
        ):
            raise LiteratureInvariantError(
                "content Reference cleanup closure is incomplete or ambiguous"
            )
        try:
            expected_token = content_reference_closure_token(
                literature_id,
                context.references,
                context.supports,
            )
        except (TypeError, ValueError) as error:
            raise LiteratureInvariantError(
                "content Reference cleanup closure is invalid"
            ) from error
        if expected_token != stored_token:
            raise LiteratureInvariantError(
                "content Reference cleanup closure is incomplete or ambiguous"
            )
        cleanup = decide_content_replacement_cleanup(
            source_literature_id=literature_id,
            old_content_sha256=old_content_sha256,
            references=context.references,
            supports=context.supports,
        )
        if cleanup.decision == "rejected":
            raise LiteratureInvariantError(cleanup.reason or "content support cleanup rejected")
        return NoUsableContentCleanupPreparation(
            cleanup=cleanup,
            reference_closure_token=expected_token,
        )

    def publish_reference(
        self,
        *,
        source: Literature,
        target: Literature,
        provider_relations: Iterable[ProviderRelationEvidence] = (),
        metadata_references: Iterable[MetadataReferenceEvidence] = (),
        content_references: Iterable[ContentReferenceEvidence] = (),
        reference_id: ReferenceId | None = None,
    ) -> ReferenceAcceptanceDecision:
        provider_relations = tuple(provider_relations)
        metadata_references = tuple(metadata_references)
        content_references = tuple(content_references)
        context = self._read_reference(
            ReferenceReadRequest(
                source_literature_id=source.literature_id,
                target_literature_id=target.literature_id,
                provider_relation_observation_ids=tuple(
                    item.observation.observation_id for item in provider_relations
                ),
                metadata_reference_keys=tuple(
                    (item.observation.observation_id, item.reference_index)
                    for item in metadata_references
                ),
                content_reference_keys=tuple(
                    (item.content.literature_content_sha256, item.reference_index)
                    for item in content_references
                ),
            )
        )
        current_source = self._current_literature(context, source.literature_id)
        current_target = self._current_literature(context, target.literature_id)
        evidence_reason = _reference_evidence_reason(
            context,
            current_source=current_source,
            current_target=current_target,
            provider_relations=provider_relations,
            metadata_references=metadata_references,
            content_references=content_references,
        )
        if evidence_reason is not None:
            return ReferenceAcceptanceDecision(decision="rejected", reason=evidence_reason)
        existing_edge = any(
            item.source_literature_id == current_source.literature_id
            and item.target_literature_id == current_target.literature_id
            for item in context.references
        )
        selected_reference_id = reference_id
        if selected_reference_id is None and not existing_edge:
            selected_reference_id = self._id_factory.new_reference_id()
        decision = decide_reference(
            source=current_source,
            target=current_target,
            accepted_literatures=context.literatures,
            provider_relations=provider_relations,
            metadata_references=metadata_references,
            content_references=content_references,
            reference_id=selected_reference_id,
            existing_references=context.references,
            existing_supports=context.supports,
        )
        if decision.decision == "rejected":
            return decision
        reference = decision.reference
        if reference is None:
            raise LiteratureInvariantError("accepted reference lacks Reference")
        existing_supports = tuple(context.supports)
        new_supports = tuple(item for item in decision.supports if item not in existing_supports)
        source_facts = self._facts_for(context, current_source.literature_id)
        target_facts = self._facts_for(context, current_target.literature_id)
        assert source_facts is not None
        assert target_facts is not None
        source_token = _token(current_source, source_facts)
        target_token = _token(current_target, target_facts)
        if decision.decision == "created":
            self._reference_port.publish_reference(
                ReferencePublicationCommand(
                    source_token=source_token,
                    target_token=target_token,
                    reference=reference,
                    supports=new_supports,
                )
            )
        elif new_supports:
            self._reference_port.append_reference_support(
                ReferenceSupportAppendCommand(
                    source_token=source_token,
                    target_token=target_token,
                    reference=reference,
                    supports=new_supports,
                )
            )
        return decision

    def search(self, request: LibrarySearchRequest) -> LibrarySearchPage:
        return self._query().search(request)

    def open_artifact(
        self,
        reference: LiteratureArtifactReference,
    ) -> AbstractContextManager[BinaryIO]:
        if self._artifact_read_port is None:
            raise LiteratureArtifactReadError()
        return self._artifact_read_port.open_artifact(reference)

    def read_detail(self, literature_id: LiteratureId) -> LiteratureDetail:
        return self._query().read_detail(literature_id)

    def read_references(
        self,
        request: LiteratureReferenceRequest,
    ) -> LiteratureReferencePage:
        return self._query().read_references(request)

    def read_reference_detail(self, reference_id: ReferenceId) -> ReferenceDetail:
        return self._query().read_reference_detail(reference_id)

    def read_meta_literatures(
        self,
        request: MetaLiteratureReadRequest,
    ) -> MetaLiteratureReadContext:
        return self._query().read_meta_literatures(request)

    def read_provider_relation_observations(
        self,
        request: ProviderRelationObservationReadRequest,
    ) -> ProviderRelationObservationReadContext:
        return self._query().read_provider_relation_observations(request)

    def read_status(self, literature_id: LiteratureId) -> LiteratureStatusResult:
        context = self._read_current_facts(CurrentFactsReadRequest(literature_id=literature_id))
        facts = self._facts_for(context, literature_id)
        assert facts is not None
        return LiteratureStatusResult(
            literature_id=literature_id,
            status=derive_status(facts),
            facts=facts,
        )

    def read_facts(self, literature_id: LiteratureId) -> CurrentLiteratureFacts:
        context = self._read_current_facts(CurrentFactsReadRequest(literature_id=literature_id))
        facts = self._facts_for(context, literature_id)
        assert facts is not None
        return facts

    def delete_literature(
        self,
        literature_id: LiteratureId,
        *,
        replacement_representative_id: LiteratureId | None = None,
    ) -> LiteratureMaintenanceResult:
        context = self._read_deletion(DeletionReadRequest(literature_id=literature_id))
        current = self._current_literature(context, literature_id)
        facts = self._facts_for(context, literature_id)
        assert facts is not None
        meta = next(
            (
                item
                for item in context.meta_literatures
                if item.meta_literature_id == current.meta_literature_id
            ),
            None,
        )
        members = tuple(
            item
            for item in context.literatures
            if item.meta_literature_id == current.meta_literature_id
        )
        if meta is None or current not in members:
            return _rejected_delete(literature_id, "meta-membership-invariant")
        if any(
            reference.source_literature_id == literature_id
            or reference.target_literature_id == literature_id
            for reference in context.references
        ):
            return _rejected_delete(literature_id, "references-exist")
        if len(members) == 1:
            if replacement_representative_id is not None:
                return _rejected_delete(literature_id, "invalid-representative")
        elif meta.representative_literature_id == literature_id:
            if replacement_representative_id is None:
                return _rejected_delete(literature_id, "representative-required")
            if replacement_representative_id not in {
                item.literature_id for item in members if item.literature_id != literature_id
            }:
                return _rejected_delete(literature_id, "invalid-representative")
        elif replacement_representative_id is not None:
            return _rejected_delete(literature_id, "invalid-representative")
        try:
            expected_meta_token = _meta_token(context, meta)
        except LiteratureInvariantError as error:
            return _rejected_delete(literature_id, str(error))
        self._maintenance_port.delete_literature(
            LiteratureDeletionCommand(
                expected_token=_token(current, facts),
                expected_meta_token=expected_meta_token,
                literature_id=literature_id,
                replacement_representative_id=replacement_representative_id,
            )
        )
        return LiteratureMaintenanceResult(decision="deleted", literature_id=literature_id)

    def _new_identity(
        self,
        context: IdentityReadContext,
        observation: MetadataObservation,
        metadata: LiteratureMetadata,
    ) -> _IdentityPublication:
        new_literature_id = self._id_factory.new_literature_id()
        new_meta_id = self._id_factory.new_meta_literature_id()
        role = observation.version_role or VersionRole.OTHER
        provisional = Literature(
            literature_id=new_literature_id,
            meta_literature_id=new_meta_id,
            version_role=role,
            metadata=metadata,
            status=LiteratureStatus.UNREVIEWED,
        )
        target = self._version_link_target(context, provisional, observation)
        if target is None:
            meta = MetaLiterature(
                meta_literature_id=new_meta_id,
                representative_literature_id=new_literature_id,
            )
            return _IdentityPublication(
                literature=provisional,
                meta_literature=meta,
                meta_literature_created=True,
                changed_literatures=(provisional,),
                changed_meta_literatures=(meta,),
                facts=(_initial_facts(provisional, metadata),),
                expected_tokens=(),
                expected_meta_tokens=(),
                retired_meta_literature_ids=(),
            )
        linked = provisional.model_copy(update={"meta_literature_id": target.meta_literature_id})
        target_meta = self._meta_for(context, target.meta_literature_id)
        members = _meta_members(context, target_meta.meta_literature_id) + (linked,)
        meta = MetaLiterature(
            meta_literature_id=target.meta_literature_id,
            representative_literature_id=_representative(members).literature_id,
        )
        return _IdentityPublication(
            literature=linked,
            meta_literature=meta,
            meta_literature_created=False,
            changed_literatures=(linked,),
            changed_meta_literatures=(meta,),
            facts=(_initial_facts(linked, metadata),),
            expected_tokens=(),
            expected_meta_tokens=(_meta_token(context, target_meta),),
            retired_meta_literature_ids=(),
        )

    def _existing_identity(  # noqa: C901
        self,
        context: IdentityReadContext,
        current: Literature,
        current_facts: CurrentLiteratureFacts,
        observation: MetadataObservation,
        projection: MetadataProjectionDecision,
    ) -> _IdentityPublication:
        updated = current.model_copy(update={"metadata": projection.metadata})
        target = self._version_link_target(context, current, observation)
        if target is None or target.meta_literature_id == current.meta_literature_id:
            meta = self._meta_for(context, current.meta_literature_id)
            changed_literatures = (updated,) if updated != current else ()
            single_changed_facts: tuple[CurrentLiteratureFacts, ...] = (
                _updated_facts(current_facts, updated, projection) if changed_literatures else ()
            )
            # A newly attached immutable observation and exhaustion cleanup
            # still depend on the owner identity/current metadata even when
            # the deterministic projection itself is unchanged.  The caller
            # may skip the command entirely for a pure replay, but every
            # actual publication carries this complete CAS token.
            single_expected_tokens = (_token(current, current_facts),)
            return _IdentityPublication(
                literature=updated,
                meta_literature=meta,
                meta_literature_created=False,
                changed_literatures=changed_literatures,
                changed_meta_literatures=(),
                facts=single_changed_facts,
                expected_tokens=single_expected_tokens,
                expected_meta_tokens=(),
                retired_meta_literature_ids=(),
            )

        current_meta = self._meta_for(context, current.meta_literature_id)
        target_meta = self._meta_for(context, target.meta_literature_id)
        current_members = _meta_members(context, current_meta.meta_literature_id)
        target_members = _meta_members(context, target_meta.meta_literature_id)
        all_members = current_members + target_members
        if len({item.literature_id for item in all_members}) != len(all_members):
            raise LiteratureInvariantError("MetaLiterature members are duplicated")

        changed_by_id: dict[LiteratureId, Literature] = {}
        for item in all_members:
            replacement = item.model_copy(
                update={"meta_literature_id": target_meta.meta_literature_id}
            )
            if item.literature_id == current.literature_id:
                replacement = replacement.model_copy(update={"metadata": projection.metadata})
            if replacement != item:
                changed_by_id[item.literature_id] = replacement

        changed_literatures = tuple(
            changed_by_id[item.literature_id]
            for item in all_members
            if item.literature_id in changed_by_id
        )
        if not changed_literatures:
            raise LiteratureInvariantError("version-link merge did not change membership")

        facts_by_id = _facts_by_id(context)
        changed_facts: list[CurrentLiteratureFacts] = []
        expected_tokens: list[LiteratureIdentityToken] = []
        for item in all_members:
            changed = changed_by_id.get(item.literature_id)
            if changed is None:
                continue
            facts = facts_by_id.get(item.literature_id)
            if facts is None:
                raise LiteratureInvariantError("Literature member facts are incomplete")
            expected_tokens.append(_token(item, facts))
            if item.literature_id == current.literature_id:
                changed_facts.extend(_updated_facts(facts, changed, projection))
            else:
                changed_facts.append(facts.model_copy(update={"literature": changed}))

        survivor = MetaLiterature(
            meta_literature_id=target_meta.meta_literature_id,
            representative_literature_id=_representative(
                tuple(changed_by_id.get(item.literature_id, item) for item in all_members)
            ).literature_id,
        )
        expected_meta_tokens = tuple(
            sorted(
                (
                    _meta_token(context, current_meta),
                    _meta_token(context, target_meta),
                ),
                key=lambda item: str(item.meta_literature_id),
            )
        )
        published_current = changed_by_id.get(current.literature_id)
        if published_current is None:
            raise LiteratureInvariantError("merged current Literature was not rewritten")
        return _IdentityPublication(
            literature=published_current,
            meta_literature=survivor,
            meta_literature_created=False,
            changed_literatures=changed_literatures,
            changed_meta_literatures=(survivor,),
            facts=tuple(changed_facts),
            expected_tokens=tuple(expected_tokens),
            expected_meta_tokens=expected_meta_tokens,
            retired_meta_literature_ids=(current_meta.meta_literature_id,),
        )

    def _version_link_target(
        self,
        context: IdentityReadContext,
        current: Literature,
        observation: MetadataObservation,
    ) -> Literature | None:
        evidence = tuple(
            VersionEvidence(
                literature=item,
                observations=tuple(
                    link.observation
                    for link in context.observations
                    if link.literature_id == item.literature_id
                ),
            )
            for item in context.literatures
        )
        decision = resolve_meta_literature(current, observation, evidence)
        if decision.decision != "linked":
            return None
        for literature_id in decision.linked_literature_ids:
            if literature_id != current.literature_id:
                return self._current_literature(context, literature_id)
        return None

    def _query(self) -> LiteratureQueryPort:
        if self._query_port is None:
            raise LiteratureInvariantError("Literature query port is not configured")
        return self._query_port

    def _read_identity(self, request: IdentityReadRequest) -> IdentityReadContext:
        context = cast(object, self._read_port.read_identity(request))
        if not isinstance(context, IdentityReadContext):
            raise TypeError("read_identity must return IdentityReadContext")
        return context

    def _read_content(self, request: ContentReadRequest) -> ContentReadContext:
        context = cast(object, self._read_port.read_content(request))
        if not isinstance(context, ContentReadContext):
            raise TypeError("read_content must return ContentReadContext")
        return context

    def _read_reference(self, request: ReferenceReadRequest) -> ReferenceReadContext:
        context = cast(object, self._read_port.read_reference(request))
        if not isinstance(context, ReferenceReadContext):
            raise TypeError("read_reference must return ReferenceReadContext")
        return context

    def _read_deletion(self, request: DeletionReadRequest) -> DeletionReadContext:
        context = cast(object, self._read_port.read_deletion(request))
        if not isinstance(context, DeletionReadContext):
            raise TypeError("read_deletion must return DeletionReadContext")
        return context

    def _read_current_facts(self, request: CurrentFactsReadRequest) -> CurrentFactsReadContext:
        context = cast(object, self._read_port.read_current_facts(request))
        if not isinstance(context, CurrentFactsReadContext):
            raise TypeError("read_current_facts must return CurrentFactsReadContext")
        return context

    @staticmethod
    def _current_literature(context: _LiteratureContext, literature_id: LiteratureId) -> Literature:
        matches = tuple(item for item in context.literatures if item.literature_id == literature_id)
        if not matches:
            raise LiteratureNotFoundError(str(literature_id))
        if len(matches) != 1:
            raise LiteratureInvariantError("Literature identity is ambiguous")
        return matches[0]

    @staticmethod
    def _facts_for(
        context: _FactsContext,
        literature_id: LiteratureId,
        *,
        required: bool = True,
    ) -> CurrentLiteratureFacts | None:
        matches = tuple(
            item for item in context.facts if item.literature.literature_id == literature_id
        )
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            raise LiteratureInvariantError("Literature current facts are ambiguous")
        if required:
            raise LiteratureNotFoundError(str(literature_id))
        return None

    @staticmethod
    def _meta_for(context: _MetaContext, meta_id: MetaLiteratureId) -> MetaLiterature:
        matches = tuple(
            item for item in context.meta_literatures if item.meta_literature_id == meta_id
        )
        if not matches:
            raise LiteratureInvariantError("Literature meta membership is incomplete")
        if len(matches) != 1:
            raise LiteratureInvariantError("Literature meta membership is ambiguous")
        return matches[0]


def _meta_members(
    context: _MetaContext,
    meta_id: MetaLiteratureId,
) -> tuple[Literature, ...]:
    members = tuple(item for item in context.literatures if item.meta_literature_id == meta_id)
    if not members:
        raise LiteratureInvariantError("MetaLiterature cannot be empty")
    if len({item.literature_id for item in members}) != len(members):
        raise LiteratureInvariantError("MetaLiterature members are duplicated")
    return members


def _facts_by_id(context: _FactsContext) -> dict[LiteratureId, CurrentLiteratureFacts]:
    result: dict[LiteratureId, CurrentLiteratureFacts] = {}
    for facts in context.facts:
        literature_id = facts.literature.literature_id
        if literature_id in result:
            raise LiteratureInvariantError("Literature facts are duplicated")
        result[literature_id] = facts
    return result


def _meta_token(
    context: _MetaContext,
    meta: MetaLiterature,
) -> MetaLiteratureIdentityToken:
    members = _meta_members(context, meta.meta_literature_id)
    member_ids = tuple(sorted((item.literature_id for item in members), key=str))
    if meta.representative_literature_id not in member_ids:
        raise LiteratureInvariantError("MetaLiterature representative is not a member")
    return MetaLiteratureIdentityToken(
        meta_literature_id=meta.meta_literature_id,
        representative_literature_id=meta.representative_literature_id,
        member_literature_ids=member_ids,
    )


def _representative(members: tuple[Literature, ...]) -> Literature:
    order = {
        VersionRole.PUBLISHED: 0,
        VersionRole.ACCEPTED_MANUSCRIPT: 1,
        VersionRole.PREPRINT: 2,
        VersionRole.OTHER: 3,
    }
    if not members:
        raise LiteratureInvariantError("MetaLiterature cannot be empty")
    return min(members, key=lambda item: (order[item.version_role], str(item.literature_id)))


def _token(
    literature: Literature,
    facts: CurrentLiteratureFacts,
) -> LiteratureIdentityToken:
    return LiteratureIdentityToken(
        literature_id=literature.literature_id,
        meta_literature_id=literature.meta_literature_id,
        metadata_revision=facts.metadata_revision,
        metadata_sha256=facts.metadata_sha256,
    )


def _initial_facts(
    literature: Literature,
    metadata: LiteratureMetadata,
) -> CurrentLiteratureFacts:
    return CurrentLiteratureFacts(
        literature=literature,
        metadata_revision=1,
        metadata_sha256=metadata_sha256(metadata),
    )


def _updated_facts(
    facts: CurrentLiteratureFacts | None,
    literature: Literature,
    projection: MetadataProjectionDecision,
) -> tuple[CurrentLiteratureFacts, ...]:
    if facts is None:
        projected_metadata = projection.metadata
        if projected_metadata is None:
            raise LiteratureInvariantError("projection lacks metadata")
        return (_initial_facts(literature, projected_metadata),)
    if projection.metadata is None:
        raise LiteratureInvariantError("projection lacks metadata")
    return (
        facts.model_copy(
            update={
                "literature": literature,
                "metadata_revision": projection.metadata_revision,
                "metadata_sha256": metadata_sha256(projection.metadata),
            }
        ),
    )


def _fallback_index_for(
    literature_id: LiteratureId,
    metadata: LiteratureMetadata,
) -> FallbackIdentityIndex | None:
    # Fallback identity is legal only when neither side has a stable
    # Literature identifier.  Omitting this row instructs Storage to remove a
    # previous fallback index when final/current metadata gains a stable ID or
    # loses one of the four required bibliographic fields.
    if stable_identifier_index(metadata):
        return None
    key = fallback_identity_key(metadata)
    if key is None:
        return None
    return FallbackIdentityIndex(
        literature_id=literature_id,
        fallback_identity_sha256=fallback_identity_sha256(key),
    )


def _user_observation_index(observation: MetadataObservation) -> UserObservationIndex | None:
    if observation.provenance.source_kind is not SourceKind.USER:
        return None
    return UserObservationIndex(
        observation_id=observation.observation_id,
        semantic_sha256=user_observation_semantic_sha256(observation),
    )


def _version_link_read_keys(
    observation: MetadataObservation,
) -> tuple[VersionLinkReadKey, ...]:
    if observation.provenance.source_kind is not SourceKind.METADATA_PROVIDER:
        return ()
    source_name = observation.provenance.source_name
    return tuple(
        VersionLinkReadKey(
            source_name=source_name,
            record_id=link.record_id,
            stable_identifier_keys=stable_identifier_index(
                LiteratureMetadata(identifiers=link.identifiers)
            ),
        )
        for link in observation.version_links
    )


def _provider_record_read_key(
    observation: MetadataObservation,
) -> ProviderRecordReadKey | None:
    provenance = observation.provenance
    if (
        provenance.source_kind is not SourceKind.METADATA_PROVIDER
        or provenance.source_record_id is None
    ):
        return None
    return ProviderRecordReadKey(
        source_name=provenance.source_name,
        source_record_id=provenance.source_record_id,
    )


def _reference_evidence_reason(  # noqa: C901
    context: ReferenceReadContext,
    *,
    current_source: Literature,
    current_target: Literature,
    provider_relations: tuple[ProviderRelationEvidence, ...],
    metadata_references: tuple[MetadataReferenceEvidence, ...],
    content_references: tuple[ContentReferenceEvidence, ...],
) -> str | None:
    """Validate evidence against the returned scoped closure.

    The adapter only performs equality lookups.  These checks intentionally
    remain in Literature so missing, duplicated, stale, or mis-owned evidence
    cannot be hidden by a Storage-side canonicalization or foreign key.
    """

    for evidence in provider_relations:
        matches = tuple(
            item
            for item in context.provider_relations
            if item.observation_id == evidence.observation.observation_id
        )
        if len(matches) != 1:
            return "provider-relation-observation-missing-or-ambiguous"
        if matches[0] != evidence.observation:
            return "provider-relation-observation-mismatch"
        if evidence.source != current_source or evidence.target != current_target:
            return "provider-relation-endpoint-stale"

    for evidence in metadata_references:
        matches = tuple(
            link
            for link in context.observations
            if link.observation.observation_id == evidence.observation.observation_id
        )
        if len(matches) != 1:
            return "metadata-observation-missing-or-ambiguous"
        link = matches[0]
        if link.observation != evidence.observation:
            return "metadata-observation-mismatch"
        if link.literature_id != current_source.literature_id:
            return "metadata-support-source-mismatch"
        if evidence.literature != current_source:
            return "metadata-support-source-stale"

    for evidence in content_references:
        if evidence.literature != current_source:
            return "content-support-source-stale"
        matches = tuple(
            facts
            for facts in context.facts
            if facts.literature.literature_id == current_source.literature_id
        )
        if len(matches) != 1:
            return "content-facts-missing-or-ambiguous"
        current_content = matches[0].current_content
        if current_content is None:
            return "content-not-current"
        if current_content != evidence.content:
            return "content-support-stale"

    return None


def _rejected_observation(reason: str) -> ObservationAcceptanceResult:
    return ObservationAcceptanceResult(decision="rejected", reason=reason)


def _rejected_delete(literature_id: LiteratureId, reason: str) -> LiteratureMaintenanceResult:
    return LiteratureMaintenanceResult(
        decision="rejected",
        literature_id=literature_id,
        reason=reason,
    )


def _observation_owner(
    context: IdentityReadContext,
    observation: MetadataObservation,
) -> Literature | None:
    """Find an existing source owner before attempting metadata identity.

    Observation identity and provider-scoped record ownership are separate
    idempotency boundaries from Literature identity.  In particular, a replay
    or a new immutable snapshot of one provider record can legitimately carry
    incomplete fallback metadata and therefore must not create a second
    Literature just because L1 cannot match its bibliographic key.
    """

    same_id = tuple(
        link
        for link in context.observations
        if link.observation.observation_id == observation.observation_id
    )
    exact_owner: Literature | None = None
    if same_id:
        if len(same_id) != 1 or not _same_observation_replay(
            same_id[0].observation,
            observation,
        ):
            raise LiteratureInvariantError(
                "observation ID is already bound to different source data"
            )
        exact_owner = _owner_for_link(context, same_id[0])
    provenance = observation.provenance
    if exact_owner is not None and (
        provenance.source_kind is not SourceKind.METADATA_PROVIDER
        or provenance.source_record_id is None
    ):
        return exact_owner
    if provenance.source_kind is SourceKind.USER:
        matching_user_links = tuple(
            link
            for link in context.observations
            if link.observation.provenance.source_kind is SourceKind.USER
            and same_user_observation(link.observation, observation)
        )
        if matching_user_links:
            if len(matching_user_links) != 1:
                raise LiteratureInvariantError("user observation has multiple owners")
            return _owner_for_link(context, matching_user_links[0])
        return None
    if (
        provenance.source_kind is not SourceKind.METADATA_PROVIDER
        or provenance.source_record_id is None
    ):
        return None
    provider_owner = _provider_record_owner(context, observation)
    if exact_owner is not None and provider_owner is None:
        raise LiteratureInvariantError("observation owner is missing or ambiguous")
    if (
        exact_owner is not None
        and provider_owner is not None
        and provider_owner.literature_id != exact_owner.literature_id
    ):
        raise LiteratureInvariantError("observation-owner-identity-conflict")
    return provider_owner


def _same_observation_replay(
    existing: MetadataObservation,
    incoming: MetadataObservation,
) -> bool:
    kind = incoming.provenance.source_kind
    if existing.provenance.source_kind is not kind:
        return False
    if kind is SourceKind.USER:
        return same_user_observation(existing, incoming)
    if kind is SourceKind.METADATA_PROVIDER:
        return same_provider_observation(existing, incoming)
    return False


def _provider_record_owner(
    context: IdentityReadContext,
    observation: MetadataObservation,
) -> Literature | None:
    provenance = observation.provenance
    matching_provider_links = tuple(
        link
        for link in context.observations
        if link.observation.provenance.source_kind is SourceKind.METADATA_PROVIDER
        and link.observation.provenance.source_name == provenance.source_name
        and link.observation.provenance.source_record_id == provenance.source_record_id
    )
    owners = {
        owner.literature_id: owner
        for link in matching_provider_links
        for owner in (_owner_for_link(context, link),)
    }
    if len(owners) > 1:
        raise LiteratureInvariantError("provider record has multiple owners")
    if owners:
        return next(iter(owners.values()))
    return None


def _owner_for_link(
    context: IdentityReadContext,
    link: LiteratureObservation,
) -> Literature:
    owners = tuple(item for item in context.literatures if item.literature_id == link.literature_id)
    if len(owners) != 1:
        raise LiteratureInvariantError("observation owner is missing or ambiguous")
    return owners[0]


__all__ = (
    "IdFactory",
    "LiteratureInvariantError",
    "LiteratureMaintenanceResult",
    "LiteratureNotFoundError",
    "LiteratureService",
    "LiteratureStatusResult",
    "NoUsableContentCleanupPreparation",
    "ObservationAcceptanceResult",
)
