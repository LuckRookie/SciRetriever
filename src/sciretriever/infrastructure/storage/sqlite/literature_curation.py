from __future__ import annotations

import os

from sciretriever.infrastructure.storage.sqlite.curation_snapshot import snapshot_token
from sciretriever.infrastructure.storage.sqlite.engine import open_read_only_snapshot
from sciretriever.infrastructure.storage.sqlite.literature_facts import (
    _read_version_facts,
    _read_work_facts,
)
from sciretriever.model.library import (
    ArtifactRegistrationFact,
    CurationScope,
    CurationSnapshot,
    CurationTopology,
    IdentifierFact,
    MembershipFact,
    ObservationFact,
    ReferenceFact,
    RelationFact,
)
from sciretriever.model.literature import Identifier, VersionFacts, WorkFacts
from sciretriever.model.primitives import (
    AssetId,
    CollectionId,
    MembershipId,
    ObservationId,
    ReferenceFactId,
    StableIdentifierId,
    VersionRelationId,
    WorkId,
    WorkVersionId,
)


def load_curation_snapshot(
    catalog_path: str | os.PathLike[str], scope: CurationScope
) -> CurationSnapshot:
    with open_read_only_snapshot(catalog_path) as connection:
        work_values: list[WorkFacts] = []
        for identifier in scope.work_ids:
            value = _read_work_facts(connection, identifier)
            if value is not None:
                work_values.append(value)
        version_values: list[VersionFacts] = []
        for identifier in scope.work_version_ids:
            version = _read_version_facts(connection, identifier)
            if version is not None:
                version_values.append(version)
        works = tuple(work_values)
        versions = tuple(version_values)
        return CurationSnapshot(
            scope=scope,
            token=snapshot_token(connection, scope),
            works=works,
            versions=versions,
        )


def load_curation_topology(
    catalog_path: str | os.PathLike[str],
) -> CurationTopology:
    with open_read_only_snapshot(catalog_path) as connection:
        work_ids = tuple(
            WorkId(row[0]) for row in connection.execute("SELECT id FROM works ORDER BY id")
        )
        version_ids = tuple(
            WorkVersionId(row[0])
            for row in connection.execute("SELECT id FROM work_versions ORDER BY id")
        )
        scope = CurationScope(work_ids=work_ids, work_version_ids=version_ids)
        work_values: list[WorkFacts] = []
        for identifier in work_ids:
            work_value = _read_work_facts(connection, identifier)
            if work_value is not None:
                work_values.append(work_value)
        version_values: list[VersionFacts] = []
        for identifier in version_ids:
            version_value = _read_version_facts(connection, identifier)
            if version_value is not None:
                version_values.append(version_value)
        works = tuple(work_values)
        versions = tuple(version_values)
        identifiers = tuple(
            IdentifierFact(
                identifier_id=StableIdentifierId(row[0]),
                version_id=WorkVersionId(row[1]),
                value=Identifier(namespace=row[2], value=row[3]),
            )
            for row in connection.execute(
                "SELECT id,work_version_id,namespace,value FROM stable_identifiers ORDER BY id"
            )
        )
        observations = tuple(
            ObservationFact(
                observation_id=ObservationId(row[0]),
                version_id=WorkVersionId(row[1]),
            )
            for row in connection.execute(
                "SELECT id,work_version_id FROM metadata_observations ORDER BY id"
            )
        )
        memberships = tuple(
            MembershipFact(
                membership_id=MembershipId(row[0]),
                collection_id=CollectionId(row[1]),
                work_id=WorkId(row[2]),
            )
            for row in connection.execute(
                "SELECT id,collection_id,work_id FROM collection_memberships ORDER BY id"
            )
        )
        references = tuple(
            ReferenceFact(
                reference_id=ReferenceFactId(row[0]),
                source_version_id=WorkVersionId(row[1]),
                target_work_id=None if row[2] is None else WorkId(row[2]),
                target_version_id=None if row[3] is None else WorkVersionId(row[3]),
                raw_text=row[4],
                reference_json=row[5],
            )
            for row in connection.execute(
                "SELECT m.id,s.work_version_id,m.target_work_id,m.target_work_version_id,"
                "COALESCE(json_extract(m.reference_json,'$.raw_text'),m.reference_json),"
                "m.reference_json "
                "FROM reference_members m JOIN reference_sets s ON s.id=m.reference_set_id "
                "ORDER BY m.id"
            )
        )
        relations = tuple(
            RelationFact(
                relation_id=VersionRelationId(row[0]),
                left_version_id=WorkVersionId(row[1]),
                right_version_id=WorkVersionId(row[2]),
                relation=row[3],
            )
            for row in connection.execute(
                "SELECT id,left_version_id,right_version_id,relation FROM "
                "work_version_relations ORDER BY id"
            )
        )
        registrations = tuple(
            ArtifactRegistrationFact(
                artifact_id=AssetId(row[0]),
                version_id=WorkVersionId(row[1]),
            )
            for row in connection.execute(
                "SELECT artifact_id,work_version_id FROM work_version_assets UNION "
                "SELECT artifact_id,work_version_id FROM light_documents UNION "
                "SELECT artifact_id,work_version_id FROM analysis_artifacts ORDER BY 1,2"
            )
        )
        snapshot = CurationSnapshot(
            scope=scope,
            token=snapshot_token(connection, scope),
            works=works,
            versions=versions,
        )
        return CurationTopology(
            snapshot=snapshot,
            identifiers=identifiers,
            observations=observations,
            memberships=memberships,
            references=references,
            relations=relations,
            artifact_registrations=registrations,
        )
