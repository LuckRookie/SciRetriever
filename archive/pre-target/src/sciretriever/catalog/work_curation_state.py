from __future__ import annotations

import json
from typing import Final

from sqlalchemy.engine import Connection

from sciretriever.catalog.curation_contracts import CurationCapture
from sciretriever.core.ids import validate_uuid
from sciretriever.core.snapshots import SafeSnapshot


_FOOTPRINT_QUERIES: Final = (
    ("works", "SELECT * FROM works WHERE id IN (?,?) ORDER BY id"),
    ("versions", "SELECT * FROM work_versions WHERE work_id IN (?,?) ORDER BY id"),
    ("identifiers", "SELECT * FROM identifiers WHERE work_id IN (?,?) ORDER BY id"),
    ("tags", "SELECT * FROM manual_work_tags WHERE work_id IN (?,?) ORDER BY work_id,tag_id"),
    ("references", "SELECT * FROM version_references WHERE cited_work_id IN (?,?) ORDER BY id"),
    ("reviews", "SELECT * FROM identity_reviews ORDER BY id"),
    ("observations", "SELECT mo.* FROM metadata_observations mo JOIN work_versions wv ON wv.id=mo.work_version_id WHERE wv.work_id IN (?,?) ORDER BY mo.id"),
    ("assets", "SELECT wa.* FROM work_version_assets wa JOIN work_versions wv ON wv.id=wa.work_version_id WHERE wv.work_id IN (?,?) ORDER BY wa.work_version_id,wa.raw_asset_id,wa.asset_role"),
    ("current", "SELECT ca.* FROM current_analyses ca JOIN work_versions wv ON wv.id=ca.work_version_id WHERE wv.work_id IN (?,?) ORDER BY ca.work_version_id"),
    ("packages", "SELECT * FROM package_versions WHERE work_version_id IN (SELECT id FROM work_versions WHERE work_id IN (?,?)) ORDER BY id"),
)


class CandidateWorkIdsError(ValueError):
    __slots__ = ()

    def __str__(self) -> str:
        return "invalid identity review candidate Work IDs"


def topology_bytes(connection: Connection, source_id: str, target_id: str) -> bytes:
    values: list[tuple[str, list[list[str | int | None]]]] = []
    for name, query in _FOOTPRINT_QUERIES:
        count = query.count("?")
        parameters = tuple((source_id, target_id) * (count // 2))
        rows = connection.exec_driver_sql(query, parameters).all()
        values.append((name, [[value for value in row] for row in rows]))
    return json.dumps(values, ensure_ascii=True, separators=(",", ":"), sort_keys=True).encode("ascii")


def topology_capture(
    connection: Connection,
    source_id: str,
    target_id: str,
    snapshot: SafeSnapshot,
) -> CurationCapture:
    return CurationCapture(snapshot=snapshot, footprint=topology_bytes(connection, source_id, target_id))


def parse_candidate_work_ids(payload: str) -> tuple[str, ...]:
    if not isinstance(payload, str) or not 2 <= len(payload) <= 16_384:
        raise CandidateWorkIdsError
    try:
        decoded = json.loads(payload)
    except json.JSONDecodeError:
        raise CandidateWorkIdsError from None
    if not isinstance(decoded, list) or len(decoded) > 256:
        raise CandidateWorkIdsError
    candidates: list[str] = []
    for value in decoded:
        if not isinstance(value, str):
            raise CandidateWorkIdsError
        candidates.append(validate_uuid(value, "candidate_work_id"))
    result = tuple(candidates)
    canonical = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
    if len(result) != len(set(result)) or result != tuple(sorted(result)) or canonical != payload:
        raise CandidateWorkIdsError
    return result


def preferred(connection: Connection, work_id: str) -> str | None:
    return connection.exec_driver_sql(
        "SELECT preferred_work_version_id FROM works WHERE id=?", (work_id,)
    ).scalar_one()


def recompute_preferred(connection: Connection, work_id: str) -> None:
    manual = connection.exec_driver_sql(
        "SELECT preferred_version_is_manual FROM works WHERE id=?", (work_id,)
    ).scalar_one()
    if manual:
        return
    selected = connection.exec_driver_sql(
        "SELECT wv.id FROM work_versions wv WHERE wv.work_id=? ORDER BY "
        "CASE wv.version_class WHEN 'formal_publication' THEN 0 WHEN 'accepted_manuscript' THEN 1 "
        "WHEN 'preprint' THEN 2 ELSE 3 END,"
        "EXISTS(SELECT 1 FROM work_version_identifiers i WHERE i.work_version_id=wv.id AND i.namespace='doi') DESC,"
        "wv.publication_date DESC NULLS LAST,wv.provider_precedence ASC NULLS LAST,wv.stable_version_key,wv.id LIMIT 1",
        (work_id,),
    ).scalar_one_or_none()
    connection.exec_driver_sql(
        "UPDATE works SET preferred_work_version_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
        (selected, work_id),
    )


__all__ = (
    "parse_candidate_work_ids", "preferred", "recompute_preferred",
    "topology_bytes", "topology_capture",
)
