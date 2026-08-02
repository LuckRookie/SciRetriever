from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol
from uuid import UUID, uuid4, uuid5

from sciretriever.bibliography.api import BibliographicObservation, InitialMetadata
from sciretriever.collection.citation import (
    CitationExecutionDependencies,
    CitationRunExecutor,
    CitationSource,
)
from sciretriever.collection.citation_input import CitationCollectionRequest
from sciretriever.collection.model import (
    CollectionDefinition,
    CollectionRunRecord,
    CreateCollectionDefinition,
    MembershipPageRequest,
    MetadataDiscoveryRequest,
    MetadataObservation,
    StartCollectionRun,
)
from sciretriever.collection.ports import (
    BibliographyIngestionPort,
    CollectionAcceptancePublisher,
    CollectionRepository,
    MetadataDiscoveryPort,
)
from sciretriever.collection.publisher_contracts import (
    CollectionAcceptance,
    CollectionCauseFact,
    CollectionCauseId,
    CollectionCauseKind,
    CollectionMembershipFact,
)
from sciretriever.collection.seed_resolution import resolve_citation_input
from sciretriever.collection.source_run import SourceRunExecutor
from sciretriever.collection.topic import TopicConditions
from sciretriever.kernel import (
    BoundaryError,
    CanonicalJsonObject,
    parse_canonical_json,
)
from sciretriever.model.primitives import (
    CollectionId,
    CollectionRunId,
    MembershipId,
    UtcTimestamp,
    WorkVersionState,
)

_COLLECTION_NAMESPACE = UUID("f4fc7f3d-633b-4cc3-8ae7-e32c83cc932d")


class CoreWriteGuard(Protocol):
    def __enter__(self) -> CoreWriteGuard: ...
    def __exit__(self, exc_type, exc_value, traceback) -> None: ...


class CoreWriteAcquirer(Protocol):
    def __call__(self) -> CoreWriteGuard: ...


class Clock(Protocol):
    def __call__(self) -> UtcTimestamp: ...


def _system_clock() -> UtcTimestamp:
    value = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    return UtcTimestamp(value)


@dataclass(frozen=True, slots=True)
class MetadataSource:
    name: str
    port: MetadataDiscoveryPort

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise BoundaryError.for_field("metadata source", "must have a nonblank name")


@dataclass(frozen=True, slots=True)
class CollectionServiceDependencies:
    repository: CollectionRepository
    bibliography: BibliographyIngestionPort
    publisher: CollectionAcceptancePublisher
    acquire_core_write: CoreWriteAcquirer
    metadata_sources: tuple[MetadataSource, ...]
    citation_sources: tuple[CitationSource, ...] = ()
    clock: Clock = _system_clock

    def __post_init__(self) -> None:
        names = tuple(item.name for item in self.metadata_sources)
        if not names or len(set(names)) != len(names):
            raise BoundaryError.for_field("metadata sources", "must be nonempty and unique")
        citation_names = tuple(item.name for item in self.citation_sources)
        if len(set(citation_names)) != len(citation_names):
            raise BoundaryError.for_field("citation sources", "must be unique")


class CollectionService:
    def __init__(self, dependencies: CollectionServiceDependencies) -> None:
        self._dependencies = dependencies

    def create(
        self,
        name: str,
        description: str | None,
        topic_conditions: TopicConditions | None,
    ) -> CollectionDefinition:
        if not isinstance(name, str) or not name.strip():
            raise BoundaryError.for_field("name", "must be nonblank text")
        if description is not None and (
            not isinstance(description, str) or not description.strip()
        ):
            raise BoundaryError.for_field("description", "must be nonblank text when present")
        definition = CollectionDefinition(
            CollectionId(str(uuid4())),
            name.strip(),
            None if description is None else description.strip(),
            None if topic_conditions is None else topic_conditions.validated(),
            self._dependencies.clock(),
        )
        return self._dependencies.repository.create_definition(
            CreateCollectionDefinition(definition)
        )

    def get(self, collection_id: CollectionId) -> CollectionDefinition | None:
        return self._dependencies.repository.get_definition(collection_id)

    def run_topic(
        self,
        collection_id: CollectionId,
        requested_advance_to: WorkVersionState,
    ) -> CollectionRunRecord:
        definition = self._dependencies.repository.get_definition(collection_id)
        if definition is None:
            raise BoundaryError.for_field("collection_id", "must identify a collection")
        if definition.topic_conditions is None:
            raise BoundaryError.for_field("topic conditions", "must be saved before a topic run")
        request = self._request(definition.topic_conditions.canonical_json)
        with self._dependencies.acquire_core_write():
            existing = self._existing_members(collection_id)
            run_id = CollectionRunId(str(uuid4()))
            self._dependencies.repository.start_run(
                StartCollectionRun(
                    run_id,
                    collection_id,
                    "topic",
                    definition.topic_conditions,
                    None,
                    requested_advance_to.value,
                )
            )
            return self._execute_sources(
                run_id,
                collection_id,
                request,
                str(definition.topic_conditions.sha256),
                existing,
            )

    def run_citation(
        self,
        collection_id: CollectionId,
        request: CitationCollectionRequest,
        requested_advance_to: WorkVersionState,
    ) -> CollectionRunRecord:
        pending: BoundaryError | None = None
        with self._dependencies.acquire_core_write():
            try:
                if self._dependencies.repository.get_definition(collection_id) is None:
                    raise BoundaryError.for_field("collection_id", "must identify a collection")
                configured = tuple(item.name for item in self._dependencies.citation_sources)
                if any(item not in configured for item in request.providers):
                    raise BoundaryError.for_field(
                        "providers", "must name configured citation sources"
                    )
                value = resolve_citation_input(
                    request,
                    self._dependencies.bibliography,
                    self._dependencies.repository,
                )
                existing = self._existing_members(collection_id)
                run_id = CollectionRunId(str(uuid4()))
                self._dependencies.repository.start_run(
                    StartCollectionRun(
                        run_id,
                        collection_id,
                        "citation",
                        None,
                        value.validated(),
                        requested_advance_to.value,
                    )
                )
                return CitationRunExecutor(
                    CitationExecutionDependencies(
                        self._dependencies.repository,
                        self._dependencies.bibliography,
                        self._dependencies.publisher,
                        self._dependencies.citation_sources,
                        self._dependencies.clock,
                    )
                ).execute(run_id, collection_id, value, existing)
            except BoundaryError as error:
                pending = error
        assert pending is not None
        raise pending

    def _existing_members(self, collection_id: CollectionId) -> set[str]:
        members: set[str] = set()
        after = None
        while True:
            page = self._dependencies.repository.list_memberships(
                MembershipPageRequest(collection_id, after, 1000),
            )
            members.update(str(item.work_id) for item in page.members)
            after = page.next_after_work_id
            if after is None:
                return members

    @staticmethod
    def _request(payload: str) -> MetadataDiscoveryRequest:
        value = parse_canonical_json(payload)
        if not isinstance(value, CanonicalJsonObject):
            raise BoundaryError.for_field("topic conditions", "must be an object")
        fields = dict(value.entries)
        if fields.keys() != {"query", "year_from", "year_to", "limit"}:
            raise BoundaryError.for_field("topic conditions", "must contain the approved fields")
        query, year_from = fields["query"], fields["year_from"]
        year_to, limit = fields["year_to"], fields["limit"]
        if not isinstance(query, str) or not isinstance(limit, int) or isinstance(limit, bool):
            raise BoundaryError.for_field("topic conditions", "has invalid query or limit")
        if year_from is not None and (
            not isinstance(year_from, int) or isinstance(year_from, bool)
        ):
            raise BoundaryError.for_field("year_from", "must be an integer or null")
        if year_to is not None and (not isinstance(year_to, int) or isinstance(year_to, bool)):
            raise BoundaryError.for_field("year_to", "must be an integer or null")
        return MetadataDiscoveryRequest(query, year_from, year_to, limit)

    def _execute_sources(
        self,
        run_id: CollectionRunId,
        collection_id: CollectionId,
        request: MetadataDiscoveryRequest,
        condition_hash: str,
        existing: set[str],
    ) -> CollectionRunRecord:
        executor = SourceRunExecutor(
            self._dependencies.repository,
            self._dependencies.metadata_sources,
            lambda observation, ordinal: self._publish(
                observation,
                ordinal,
                run_id,
                collection_id,
                condition_hash,
            ),
        )
        return executor.execute(run_id, request, existing)

    def _publish(
        self,
        observation: MetadataObservation,
        ordinal: int,
        run_id: CollectionRunId,
        collection_id: CollectionId,
        condition_hash: str,
    ) -> str:
        prepared = self._dependencies.bibliography.prepare_discovery(
            BibliographicObservation(
                observation.provider,
                observation.provider_record_id,
                ordinal,
                self._dependencies.clock(),
                observation.identifiers,
                InitialMetadata(
                    observation.title,
                    observation.authors,
                    observation.publication_year,
                    "other",
                    observation.abstract,
                ),
                "formal",
            )
        )
        membership_id = MembershipId(
            str(
                uuid5(
                    _COLLECTION_NAMESPACE,
                    f"membership:{collection_id}:{prepared.work_id}",
                )
            )
        )
        cause_id = CollectionCauseId(
            str(
                uuid5(
                    _COLLECTION_NAMESPACE,
                    f"cause:{run_id}:{observation.provider}:{observation.provider_record_id}",
                )
            )
        )
        membership = CollectionMembershipFact(
            membership_id,
            collection_id,
            prepared.work_id,
            run_id,
        )
        cause = CollectionCauseFact(
            cause_id,
            membership_id,
            run_id,
            CollectionCauseKind.TOPIC_MATCH,
            CanonicalJsonObject(
                (
                    ("condition_sha256", condition_hash),
                    ("provider", observation.provider),
                    ("provider_record_id", observation.provider_record_id),
                )
            ),
            None,
        )
        self._dependencies.publisher.publish(
            CollectionAcceptance(
                prepared,
                membership,
                (cause,),
                (),
            )
        )
        return str(prepared.work_id)


__all__ = (
    "CitationSource",
    "CollectionService",
    "CollectionServiceDependencies",
    "MetadataSource",
)
