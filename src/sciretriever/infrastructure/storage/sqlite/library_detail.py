from __future__ import annotations

import sqlite3

from sciretriever.infrastructure.storage.sqlite.library_parse import json_output, reference
from sciretriever.model.library_views import (
    ObservationView,
    ReferenceSetView,
    TagSetView,
    TagView,
)
from sciretriever.model.primitives import (
    ObservationId,
    ProvenanceId,
    SourceKind,
    UtcTimestamp,
    WorkVersionId,
)
from sciretriever.model.sources import Provenance


def detail_sets(
    connection: sqlite3.Connection, version_id: WorkVersionId
) -> tuple[ReferenceSetView, TagSetView]:
    reference_set = connection.execute(
        "SELECT id,complete FROM reference_sets WHERE work_version_id=? ORDER BY revision "
        "DESC LIMIT 1",
        (str(version_id),),
    ).fetchone()
    references = (
        ()
        if reference_set is None
        else tuple(
            reference(row[0])
            for row in connection.execute(
                "SELECT reference_json FROM (SELECT ordinal,reference_json FROM "
                "reference_members WHERE reference_set_id=? UNION ALL SELECT ordinal,"
                "reference_json FROM unresolved_references WHERE reference_set_id=?) ORDER "
                "BY ordinal",
                (reference_set[0], reference_set[0]),
            ).fetchall()
        )
    )
    tag_set = connection.execute(
        "SELECT id,complete FROM tag_sets WHERE work_version_id=? ORDER BY revision DESC LIMIT 1",
        (str(version_id),),
    ).fetchone()
    tags = (
        ()
        if tag_set is None
        else tuple(
            TagView(name=row[0], evidence=json_output(row[1]))
            for row in connection.execute(
                "SELECT name,evidence_json FROM tag_members WHERE tag_set_id=? ORDER BY "
                "lower(name),name",
                (tag_set[0],),
            ).fetchall()
        )
    )
    return ReferenceSetView(
        complete=reference_set is not None and bool(reference_set[1]),
        items=references,
    ), TagSetView(
        complete=tag_set is not None and bool(tag_set[1]),
        items=tags,
    )


def detail_observations(
    connection: sqlite3.Connection, version_id: WorkVersionId
) -> tuple[ObservationView, ...]:
    rows = connection.execute(
        "SELECT id,provider,provider_record_id,payload_json,observed_at FROM "
        "metadata_observations WHERE work_version_id=? ORDER BY observed_at,id",
        (str(version_id),),
    ).fetchall()
    return tuple(
        ObservationView(
            observation_id=ObservationId(row[0]),
            provider=row[1],
            field_name="metadata",
            value=json_output(row[3]),
            observed_at=UtcTimestamp(row[4]),
            provenance=Provenance(
                provenance_id=ProvenanceId(row[0]),
                source_kind=SourceKind.METADATA_PROVIDER,
                source_name=row[1],
                source_record_id=row[2],
                observed_at=UtcTimestamp(row[4]),
                input_sha256=None,
                parameters_sha256=None,
            ),
        )
        for row in rows
    )


__all__ = ("detail_observations", "detail_sets")
