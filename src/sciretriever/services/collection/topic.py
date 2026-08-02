from __future__ import annotations

from typing import Final
from uuid import UUID, uuid4, uuid5

from sciretriever.core.collection import (
    CollectionRuleError,
    validate_collection_acceptance,
    validate_topic_condition_set,
)
from sciretriever.model.canonical_json import (
    CanonicalJsonObject,
    canonical_json_bytes,
    parse_canonical_json,
)
from sciretriever.model.collection import (
    CollectionAcceptance,
    CollectionCauseFact,
    CollectionMembershipFact,
    CollectionRunRecord,
    StartCollectionRun,
)
from sciretriever.model.literature import BibliographicObservation, InitialMetadata
from sciretriever.model.primitives import (
    CollectionCauseId,
    CollectionCauseKind,
    CollectionId,
    CollectionRunId,
    MembershipId,
    WorkVersionState,
)
from sciretriever.model.sources import MetadataDiscoveryRequest, MetadataObservation

from .membership import existing_work_ids
from .ports import CollectionUseCaseDependencies
from .source_run import SourceRunExecutor

_COLLECTION_NAMESPACE: Final = UUID("f4fc7f3d-633b-4cc3-8ae7-e32c83cc932d")


class TopicCollectionUseCase:
    def __init__(self, dependencies: CollectionUseCaseDependencies) -> None:
        self._dependencies = dependencies

    def execute(
        self,
        collection_id: CollectionId,
        requested_advance_to: WorkVersionState,
    ) -> CollectionRunRecord:
        definition = self._dependencies.repository.get_definition(collection_id)
        if definition is None:
            raise CollectionRuleError.for_field("collection_id", "must identify a collection")
        conditions = definition.topic_conditions
        if conditions is None:
            raise CollectionRuleError.for_field(
                "topic conditions", "must be saved before a topic run"
            )
        validate_topic_condition_set(conditions)
        request = _metadata_request(conditions.canonical_json)
        with self._dependencies.acquire_core_write():
            existing = existing_work_ids(self._dependencies.repository, collection_id)
            run_id = CollectionRunId(str(uuid4()))
            self._dependencies.repository.start_run(
                StartCollectionRun(
                    run_id=run_id,
                    collection_id=collection_id,
                    mode="topic",
                    topic_conditions=conditions,
                    citation_input=None,
                    requested_advance_to=requested_advance_to.value,
                )
            )
            return SourceRunExecutor(
                self._dependencies.repository,
                self._dependencies.metadata_sources,
                lambda observation, ordinal: self._publish(
                    observation, ordinal, run_id, collection_id, str(conditions.sha256)
                ),
            ).execute(run_id, request, existing)

    def _publish(
        self,
        observation: MetadataObservation,
        ordinal: int,
        run_id: CollectionRunId,
        collection_id: CollectionId,
        condition_hash: str,
    ) -> str:
        prepared = self._dependencies.literature.prepare_discovery(
            BibliographicObservation(
                provider=observation.provider,
                provider_record_id=observation.provider_record_id,
                source_priority=ordinal,
                observed_at=self._dependencies.clock(),
                identifiers=observation.identifiers,
                metadata=InitialMetadata(
                    title=observation.title,
                    authors=observation.authors,
                    year=observation.publication_year,
                    item_type="other",
                    abstract=observation.abstract,
                ),
                version_role="formal",
            )
        )
        membership_id = MembershipId(
            str(uuid5(_COLLECTION_NAMESPACE, f"membership:{collection_id}:{prepared.work_id}"))
        )
        cause = CollectionCauseFact(
            cause_id=CollectionCauseId(
                str(
                    uuid5(
                        _COLLECTION_NAMESPACE,
                        f"cause:{run_id}:{observation.provider}:{observation.provider_record_id}",
                    )
                )
            ),
            membership_id=membership_id,
            run_id=run_id,
            kind=CollectionCauseKind.TOPIC_MATCH,
            evidence=canonical_json_bytes(
                CanonicalJsonObject(
                    (
                        ("condition_sha256", condition_hash),
                        ("provider", observation.provider),
                        ("provider_record_id", observation.provider_record_id),
                    )
                )
            ).decode("ascii"),
            seed_work_id=None,
        )
        acceptance = CollectionAcceptance(
            bibliography=prepared,
            membership=CollectionMembershipFact(
                membership_id=membership_id,
                collection_id=collection_id,
                work_id=prepared.work_id,
                first_run_id=run_id,
            ),
            causes=(cause,),
            paths=(),
        )
        validate_collection_acceptance(acceptance)
        self._dependencies.publisher.publish(acceptance)
        return str(prepared.work_id)


def _metadata_request(payload: str) -> MetadataDiscoveryRequest:
    try:
        value = parse_canonical_json(payload)
    except (TypeError, ValueError) as error:
        raise CollectionRuleError.for_field("topic conditions", "must be canonical JSON") from error
    if not isinstance(value, CanonicalJsonObject):
        raise CollectionRuleError.for_field("topic conditions", "must be an object")
    fields = dict(value.entries)
    if fields.keys() != {"query", "year_from", "year_to", "limit"}:
        raise CollectionRuleError.for_field("topic conditions", "must contain the approved fields")
    query = fields["query"]
    year_from = fields["year_from"]
    year_to = fields["year_to"]
    limit = fields["limit"]
    if not isinstance(query, str) or not isinstance(limit, int) or isinstance(limit, bool):
        raise CollectionRuleError.for_field("topic conditions", "has invalid query or limit")
    if year_from is not None and (not isinstance(year_from, int) or isinstance(year_from, bool)):
        raise CollectionRuleError.for_field("year_from", "must be an integer or null")
    if year_to is not None and (not isinstance(year_to, int) or isinstance(year_to, bool)):
        raise CollectionRuleError.for_field("year_to", "must be an integer or null")
    return MetadataDiscoveryRequest(
        query=query,
        year_from=year_from,
        year_to=year_to,
        limit=limit,
    )


__all__ = ("TopicCollectionUseCase",)
