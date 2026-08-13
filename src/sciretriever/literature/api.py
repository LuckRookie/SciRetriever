"""Public Literature operations used by Entry and other feature modules.

This module is intentionally a thin, explicit boundary.  It exposes pure
neutral-Model decisions directly and delegates stateful operations to an
injected :class:`LiteratureService`; it does not construct Storage, Provider,
Parser, LLM, SQL, filesystem or singleton objects.
"""

from __future__ import annotations

from collections.abc import Iterable
from contextlib import AbstractContextManager
from typing import BinaryIO, cast

from sciretriever.literature.content import ContentAcceptanceDecision
from sciretriever.literature.exchange import (
    observation_from_bibliographic_record,
    select_export_literatures,
)
from sciretriever.literature.identity import provider_key_matches_seed
from sciretriever.literature.ports import (
    ContentReferenceClosureToken,
    LiteratureArtifactReadError,
    LiteratureArtifactReference,
    MetaLiteratureReadContext,
    MetaLiteratureReadRequest,
    ProviderRelationObservationReadContext,
    ProviderRelationObservationReadRequest,
    StalePreconditionError,
)
from sciretriever.literature.references import (
    ContentReferenceEvidence,
    MetadataReferenceEvidence,
    ProviderRelationEvidence,
    ReferenceAcceptanceDecision,
    ReferenceCleanupDecision,
)
from sciretriever.literature.service import (
    LiteratureMaintenanceResult,
    LiteratureService,
    LiteratureStatusResult,
    NoUsableContentCleanupPreparation,
    ObservationAcceptanceResult,
)
from sciretriever.literature.state import (
    CurrentContentLineage,
    CurrentLiteratureFacts,
    derive_status,
)
from sciretriever.model.analysis import LiteratureContentProposal
from sciretriever.model.library import (
    LibrarySearchPage,
    LibrarySearchRequest,
    LiteratureDetail,
    LiteratureReferencePage,
    LiteratureReferenceRequest,
    ReferenceDetail,
)
from sciretriever.model.literature import Literature, MetaLiterature
from sciretriever.model.metadata import MetadataObservation
from sciretriever.model.primitives import LiteratureId, ObservationId, ReferenceId, Sha256
from sciretriever.model.provenance import Provenance
from sciretriever.model.record import BibliographicRecord


class LiteratureApi:
    """Explicit public operations over one injected Literature service."""

    def __init__(self, service: LiteratureService) -> None:
        service_value = cast(object, service)
        if not isinstance(service_value, LiteratureService):
            raise TypeError("service must be a LiteratureService")
        self._service = service_value

    def accept_observation(
        self,
        observation: MetadataObservation,
        *,
        provider_precedence: Iterable[str] = (),
    ) -> ObservationAcceptanceResult:
        return self._service.accept_observation(
            observation,
            provider_precedence=provider_precedence,
        )

    def accept_bibliographic_record(
        self,
        record: BibliographicRecord,
        *,
        observation_id: ObservationId,
        provenance: Provenance,
        provider_precedence: Iterable[str] = (),
    ) -> ObservationAcceptanceResult:
        observation = observation_from_bibliographic_record(
            record,
            observation_id=observation_id,
            provenance=provenance,
        )
        return self.accept_observation(
            observation,
            provider_precedence=provider_precedence,
        )

    def select_export_literatures(
        self,
        meta_literature: MetaLiterature,
        members: Iterable[Literature],
        *,
        all_versions: bool = False,
    ) -> tuple[Literature, ...]:
        return select_export_literatures(
            meta_literature,
            members,
            all_versions=all_versions,
        )

    def accept_content(self, proposal: LiteratureContentProposal) -> ContentAcceptanceDecision:
        return self._service.accept_content(proposal)

    def prepare_no_usable_content_cleanup(
        self,
        literature_id: LiteratureId,
        old_content_sha256: Sha256,
    ) -> NoUsableContentCleanupPreparation:
        return self._service.prepare_no_usable_content_cleanup(
            literature_id,
            old_content_sha256,
        )

    def search(self, request: LibrarySearchRequest) -> LibrarySearchPage:
        return self._service.search(request)

    def open_artifact(
        self,
        reference: LiteratureArtifactReference,
    ) -> AbstractContextManager[BinaryIO]:
        return self._service.open_artifact(reference)

    def read_detail(self, literature_id: LiteratureId) -> LiteratureDetail:
        return self._service.read_detail(literature_id)

    def read_references(
        self,
        request: LiteratureReferenceRequest,
    ) -> LiteratureReferencePage:
        return self._service.read_references(request)

    def read_reference_detail(self, reference_id: ReferenceId) -> ReferenceDetail:
        return self._service.read_reference_detail(reference_id)

    def read_meta_literatures(
        self,
        request: MetaLiteratureReadRequest,
    ) -> MetaLiteratureReadContext:
        return self._service.read_meta_literatures(request)

    def read_provider_relation_observations(
        self,
        request: ProviderRelationObservationReadRequest,
    ) -> ProviderRelationObservationReadContext:
        return self._service.read_provider_relation_observations(request)

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
        return self._service.publish_reference(
            source=source,
            target=target,
            provider_relations=provider_relations,
            metadata_references=metadata_references,
            content_references=content_references,
            reference_id=reference_id,
        )

    def read_status(self, literature_id: LiteratureId) -> LiteratureStatusResult:
        return self._service.read_status(literature_id)

    def read_facts(self, literature_id: LiteratureId) -> CurrentLiteratureFacts:
        return self._service.read_facts(literature_id)

    def delete_literature(
        self,
        literature_id: LiteratureId,
        *,
        replacement_representative_id: LiteratureId | None = None,
    ) -> LiteratureMaintenanceResult:
        return self._service.delete_literature(
            literature_id,
            replacement_representative_id=replacement_representative_id,
        )


__all__ = (
    "ContentAcceptanceDecision",
    "ContentReferenceClosureToken",
    "CurrentContentLineage",
    "CurrentLiteratureFacts",
    "LiteratureApi",
    "LiteratureArtifactReadError",
    "LiteratureArtifactReference",
    "ObservationAcceptanceResult",
    "NoUsableContentCleanupPreparation",
    "ReferenceCleanupDecision",
    "StalePreconditionError",
    "derive_status",
    "provider_key_matches_seed",
)
