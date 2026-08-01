from __future__ import annotations

import os

from sciretriever.bibliography.api import (
    ArtifactRegistrationFact,
    CurationScope,
    CurationSnapshot,
    CurationTopology,
    IdentifierFact,
    IdentityCandidate,
    IdentityCandidateQuery,
    IdentityCandidateSet,
    IdentityRecord,
    MembershipFact,
    ObservationFact,
    ReferenceFact,
    RelationFact,
    StoredObservation,
    ValidatedVersionRelation,
    VersionFacts,
    WorkFacts,
    initial_metadata_from_json,
)
from sciretriever.kernel import (
    AnalysisArtifactId,
    AssetId,
    LightDocumentId,
    MetadataSnapshotId,
    ObservationId,
    Sha256,
    UtcTimestamp,
    WorkId,
    WorkVersionId,
)
from sciretriever.kernel.contracts import Identifier
from sciretriever.kernel.ids import (
    CollectionId,
    MembershipId,
    ReferenceFactId,
    StableIdentifierId,
    VersionRelationId,
    WorkVersionAssetId,
)
from sciretriever.literature_store.sqlite.curation_snapshot import snapshot_token
from sciretriever.literature_store.sqlite.engine import (
    create_or_open_catalog,
    open_read_only_snapshot,
)


def _work(connection, work_id: WorkId) -> WorkFacts | None:
    versions = connection.execute(
        "SELECT id FROM work_versions WHERE work_id=? ORDER BY id", (str(work_id),)
    ).fetchall()
    exists = connection.execute("SELECT 1 FROM works WHERE id=?", (str(work_id),)).fetchone()
    if exists is None:
        return None
    representative = connection.execute(
        "SELECT work_version_id FROM work_representative_versions WHERE work_id=?", (str(work_id),)
    ).fetchone()
    return WorkFacts(
        work_id,
        None if representative is None else WorkVersionId(representative[0]),
        tuple(WorkVersionId(row[0]) for row in versions),
    )


def _version(connection, version_id: WorkVersionId) -> VersionFacts | None:
    row = connection.execute(
        "SELECT v.work_id,v.version_role,m.metadata_snapshot_id,s.revision,s.sha256,"
        "p.work_version_asset_id,l.light_document_id,d.sha256,d.primary_asset_id,COALESCE("
        "d.complete,0),b.light_document_id,b.analysis_artifact_id,a.light_document_id,"
        "a.input_sha256,COALESCE(a.nine_categories_complete,0),b.metadata_snapshot_id,"
        "b.reference_set_id,COALESCE(rs.complete,0),b.tag_set_id,COALESCE(ts.complete,0) FROM "
        "work_versions v LEFT JOIN work_version_current_metadata m ON m.work_version_id=v.id "
        "LEFT JOIN metadata_snapshots s ON s.id=m.metadata_snapshot_id LEFT JOIN "
        "accepted_primary_assets p ON p.work_version_id=v.id LEFT JOIN "
        "work_version_current_light_document l ON l.work_version_id=v.id LEFT JOIN "
        "light_documents d ON d.id=l.light_document_id AND d.work_version_id=v.id LEFT JOIN "
        "completion_bundles b ON b.work_version_id=v.id LEFT JOIN analysis_artifacts a ON "
        "a.id=b.analysis_artifact_id AND a.work_version_id=v.id LEFT JOIN reference_sets rs ON "
        "rs.id=b.reference_set_id AND rs.work_version_id=v.id LEFT JOIN tag_sets ts ON "
        "ts.id=b.tag_set_id AND ts.work_version_id=v.id WHERE v.id=?",
        (str(version_id),),
    ).fetchone()
    if row is None:
        return None
    return VersionFacts(
        WorkId(row[0]),
        version_id,
        row[1],
        None if row[2] is None else MetadataSnapshotId(row[2]),
        row[3],
        None if row[4] is None else Sha256(row[4]),
        None if row[5] is None else WorkVersionAssetId(row[5]),
        None if row[6] is None else LightDocumentId(row[6]),
        None if row[7] is None else Sha256(row[7]),
        None if row[8] is None else WorkVersionAssetId(row[8]),
        bool(row[9]),
        None if row[10] is None else LightDocumentId(row[10]),
        None if row[11] is None else AnalysisArtifactId(row[11]),
        None if row[12] is None else LightDocumentId(row[12]),
        None if row[13] is None else Sha256(row[13]),
        bool(row[14]),
        None if row[15] is None else MetadataSnapshotId(row[15]),
        row[16],
        bool(row[17]),
        row[18],
        bool(row[19]),
    )


class SqliteBibliographyRepository:
    def __init__(self, catalog_path: str | os.PathLike[str]) -> None:
        self._catalog_path = catalog_path

    def find_identity_candidates(self, query: IdentityCandidateQuery) -> IdentityCandidateSet:
        matches: dict[tuple[str, str], list[Identifier]] = {}
        with open_read_only_snapshot(self._catalog_path) as connection:
            for identifier in query.identifiers:
                rows = connection.execute(
                    "SELECT v.work_id,i.work_version_id FROM stable_identifiers i JOIN "
                    "work_versions v ON v.id=i.work_version_id WHERE i.namespace=? AND "
                    "i.value=?",
                    (identifier.namespace, identifier.value),
                ).fetchall()
                for work_id, version_id in rows:
                    matches.setdefault((work_id, version_id), []).append(identifier)
        candidates = tuple(
            IdentityCandidate(WorkId(key[0]), WorkVersionId(key[1]), tuple(values))
            for key, values in sorted(matches.items())
        )
        return IdentityCandidateSet(candidates)

    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None:
        with open_read_only_snapshot(self._catalog_path) as connection:
            return _work(connection, work_id)

    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None:
        with open_read_only_snapshot(self._catalog_path) as connection:
            return _version(connection, version_id)

    def load_curation_snapshot(self, scope: CurationScope) -> CurationSnapshot:
        with open_read_only_snapshot(self._catalog_path) as connection:
            work_values: list[WorkFacts] = []
            for identifier in scope.work_ids:
                value = _work(connection, identifier)
                if value is not None:
                    work_values.append(value)
            version_values: list[VersionFacts] = []
            for identifier in scope.work_version_ids:
                version = _version(connection, identifier)
                if version is not None:
                    version_values.append(version)
            works = tuple(work_values)
            versions = tuple(version_values)
            return CurationSnapshot(scope, snapshot_token(connection, scope), works, versions)

    def load_curation_topology(self) -> CurationTopology:
        with open_read_only_snapshot(self._catalog_path) as connection:
            work_ids = tuple(
                WorkId(row[0]) for row in connection.execute("SELECT id FROM works ORDER BY id")
            )
            version_ids = tuple(
                WorkVersionId(row[0])
                for row in connection.execute("SELECT id FROM work_versions ORDER BY id")
            )
            scope = CurationScope(work_ids, version_ids)
            work_values: list[WorkFacts] = []
            for identifier in work_ids:
                work_value = _work(connection, identifier)
                if work_value is not None:
                    work_values.append(work_value)
            version_values: list[VersionFacts] = []
            for identifier in version_ids:
                version_value = _version(connection, identifier)
                if version_value is not None:
                    version_values.append(version_value)
            works = tuple(work_values)
            versions = tuple(version_values)
            identifiers = tuple(
                IdentifierFact(
                    StableIdentifierId(row[0]), WorkVersionId(row[1]), Identifier(row[2], row[3])
                )
                for row in connection.execute(
                    "SELECT id,work_version_id,namespace,value FROM stable_identifiers ORDER BY id"
                )
            )
            observations = tuple(
                ObservationFact(ObservationId(row[0]), WorkVersionId(row[1]))
                for row in connection.execute(
                    "SELECT id,work_version_id FROM metadata_observations ORDER BY id"
                )
            )
            memberships = tuple(
                MembershipFact(MembershipId(row[0]), CollectionId(row[1]), WorkId(row[2]))
                for row in connection.execute(
                    "SELECT id,collection_id,work_id FROM collection_memberships ORDER BY id"
                )
            )
            references = tuple(
                ReferenceFact(
                    ReferenceFactId(row[0]),
                    WorkVersionId(row[1]),
                    None if row[2] is None else WorkId(row[2]),
                    None if row[3] is None else WorkVersionId(row[3]),
                    row[4],
                    row[5],
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
                    VersionRelationId(row[0]), WorkVersionId(row[1]), WorkVersionId(row[2]), row[3]
                )
                for row in connection.execute(
                    "SELECT id,left_version_id,right_version_id,relation FROM "
                    "work_version_relations ORDER BY id"
                )
            )
            registrations = tuple(
                ArtifactRegistrationFact(AssetId(row[0]), WorkVersionId(row[1]))
                for row in connection.execute(
                    "SELECT artifact_id,work_version_id FROM work_version_assets UNION "
                    "SELECT artifact_id,work_version_id FROM light_documents UNION "
                    "SELECT artifact_id,work_version_id FROM analysis_artifacts ORDER BY 1,2"
                )
            )
            snapshot = CurationSnapshot(scope, snapshot_token(connection, scope), works, versions)
            return CurationTopology(
                snapshot,
                identifiers,
                observations,
                memberships,
                references,
                relations,
                registrations,
            )

    def add_version_relation(self, relation: ValidatedVersionRelation) -> None:
        with create_or_open_catalog(self._catalog_path) as connection:
            connection.execute(
                "INSERT INTO work_version_relations(id,left_version_id,right_version_id,"
                "relation) VALUES(?,?,?,?)",
                (
                    str(relation.relation_id),
                    str(relation.left_version_id),
                    str(relation.right_version_id),
                    relation.relation,
                ),
            )
            connection.commit()

    def list_identity_records(self) -> tuple[IdentityRecord, ...]:
        with open_read_only_snapshot(self._catalog_path) as connection:
            rows = connection.execute(
                "SELECT v.work_id,v.id,v.version_role,r.work_version_id,s.values_json,"
                "s.revision,b.work_version_id "
                "FROM work_versions v "
                "LEFT JOIN work_representative_versions r ON r.work_id=v.work_id "
                "LEFT JOIN work_version_current_metadata c ON c.work_version_id=v.id "
                "LEFT JOIN metadata_snapshots s ON s.id=c.metadata_snapshot_id "
                "LEFT JOIN completion_bundles b ON b.work_version_id=v.id ORDER BY v.id"
            ).fetchall()
            result: list[IdentityRecord] = []
            for (
                work_id,
                version_id,
                role,
                representative_id,
                values_json,
                revision,
                completed_id,
            ) in rows:
                identifier_rows = connection.execute(
                    "SELECT namespace,value FROM stable_identifiers WHERE work_version_id=? "
                    "ORDER BY namespace,value",
                    (version_id,),
                ).fetchall()
                identifiers = tuple(
                    Identifier(namespace, value) for namespace, value in identifier_rows
                )
                revision_payload = "|".join(
                    (
                        work_id,
                        version_id,
                        role,
                        *(f"{item.namespace}:{item.value}" for item in identifiers),
                        values_json or "",
                    )
                )
                result.append(
                    IdentityRecord(
                        WorkId(work_id),
                        WorkVersionId(version_id),
                        None if representative_id is None else WorkVersionId(representative_id),
                        role,
                        identifiers,
                        None if values_json is None else initial_metadata_from_json(values_json),
                        revision,
                        completed_id is not None,
                        Sha256.from_bytes(revision_payload.encode("utf-8")),
                    )
                )
            return tuple(result)

    def list_observations(self, version_id: WorkVersionId) -> tuple[StoredObservation, ...]:
        with open_read_only_snapshot(self._catalog_path) as connection:
            rows = connection.execute(
                "SELECT id,provider,provider_record_id,payload_sha256,payload_json,observed_at "
                "FROM metadata_observations WHERE work_version_id=? ORDER BY id",
                (str(version_id),),
            ).fetchall()
        return tuple(
            StoredObservation(
                ObservationId(identifier),
                provider,
                provider_record_id,
                Sha256(payload_sha256),
                payload_json,
                UtcTimestamp(observed_at),
            )
            for (
                identifier,
                provider,
                provider_record_id,
                payload_sha256,
                payload_json,
                observed_at,
            ) in rows
        )
