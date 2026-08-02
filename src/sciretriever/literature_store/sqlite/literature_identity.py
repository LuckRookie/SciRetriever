from __future__ import annotations

import os

from sciretriever.literature_store.sqlite.engine import open_read_only_snapshot
from sciretriever.model.literature import (
    Identifier,
    IdentityCandidate,
    IdentityCandidateQuery,
    IdentityCandidateSet,
    IdentityRecord,
    InitialMetadata,
    StoredObservation,
)
from sciretriever.model.primitives import (
    ObservationId,
    Sha256,
    UtcTimestamp,
    WorkId,
    WorkVersionId,
    sha256_digest,
)


def find_identity_candidates(
    catalog_path: str | os.PathLike[str], query: IdentityCandidateQuery
) -> IdentityCandidateSet:
    matches: dict[tuple[str, str], list[Identifier]] = {}
    with open_read_only_snapshot(catalog_path) as connection:
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
        IdentityCandidate(
            work_id=WorkId(key[0]),
            work_version_id=WorkVersionId(key[1]),
            matched_identifiers=tuple(values),
        )
        for key, values in sorted(matches.items())
    )
    return IdentityCandidateSet(candidates=candidates)


def list_identity_records(catalog_path: str | os.PathLike[str]) -> tuple[IdentityRecord, ...]:
    with open_read_only_snapshot(catalog_path) as connection:
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
                Identifier(namespace=namespace, value=value) for namespace, value in identifier_rows
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
                    work_id=WorkId(work_id),
                    work_version_id=WorkVersionId(version_id),
                    representative_version_id=None
                    if representative_id is None
                    else WorkVersionId(representative_id),
                    version_role=role,
                    identifiers=identifiers,
                    current_metadata=None
                    if values_json is None
                    else InitialMetadata.model_validate_json(values_json),
                    metadata_revision=revision,
                    completed=completed_id is not None,
                    identity_revision=sha256_digest(revision_payload.encode("utf-8")),
                )
            )
        return tuple(result)


def list_observations(
    catalog_path: str | os.PathLike[str], version_id: WorkVersionId
) -> tuple[StoredObservation, ...]:
    with open_read_only_snapshot(catalog_path) as connection:
        rows = connection.execute(
            "SELECT id,provider,provider_record_id,payload_sha256,payload_json,observed_at "
            "FROM metadata_observations WHERE work_version_id=? ORDER BY id",
            (str(version_id),),
        ).fetchall()
    return tuple(
        StoredObservation(
            observation_id=ObservationId(identifier),
            provider=provider,
            provider_record_id=provider_record_id,
            payload_sha256=Sha256(payload_sha256),
            payload_json=payload_json,
            observed_at=UtcTimestamp(observed_at),
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
