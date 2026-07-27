"""Validation of atomic current-analysis promotion against catalog facts."""

from __future__ import annotations

from dataclasses import dataclass
import json

from sqlalchemy import select
from sqlalchemy.engine import Connection

from sciretriever.catalog.canonical_projection import CANONICAL_FIELDS
from sciretriever.catalog.text import normalize_title
from sciretriever.catalog.models import (
    generated_work_version_metadata,
    generated_work_version_tags,
    manual_metadata_overrides,
    normalized_artifacts,
    processing_runs,
    provider_canonical_projections,
    version_references,
)
from sciretriever.catalog.repository import canonical_json
from sciretriever.core.derivation import canonical_sha256


@dataclass(frozen=True, slots=True)
class PrimaryPdf:
    id: str
    sha256: str


def _json_object(value: str) -> dict[str, object] | None:
    try:
        decoded = json.loads(value)
    except (TypeError, ValueError):
        return None
    return decoded if isinstance(decoded, dict) else None


def _projected_values(connection: Connection, table, work_version_id: str) -> dict[str, object]:
    rows = connection.execute(select(table.c.field_name, table.c.value_json).where(
        table.c.work_version_id == work_version_id)).all()
    values: dict[str, object] = {}
    for field_name, value_json in rows:
        try:
            values[field_name] = json.loads(value_json)
        except (TypeError, ValueError):
            return {}
    return values


def _metadata_rows_align(connection: Connection, work_version_id: str, analysis_id: str,
                         items: list[object]) -> bool:
    expected: dict[str, str] = {}
    for item in items:
        if (not isinstance(item, dict) or not isinstance(item.get("field_name"), str)
                or item["field_name"] in expected or "value" not in item):
            return False
        expected[item["field_name"]] = canonical_json(item["value"])
    rows = connection.execute(select(
        generated_work_version_metadata.c.field_name,
        generated_work_version_metadata.c.value_json,
        generated_work_version_metadata.c.source_artifact_id,
    ).where(generated_work_version_metadata.c.work_version_id == work_version_id)).all()
    actual = {row.field_name: row.value_json for row in rows}
    return (len(rows) == len(expected)
            and all(row.source_artifact_id == analysis_id for row in rows)
            and actual == expected)


def _reference_rows_align(connection: Connection, work_version_id: str, analysis_id: str,
                          items: list[object]) -> bool:
    expected: dict[str, tuple[int, str]] = {}
    for item in items:
        if (not isinstance(item, dict) or not isinstance(item.get("reference_id"), str)
                or item["reference_id"] in expected or type(item.get("order")) is not int
                or not isinstance(item.get("raw_reference"), str)):
            return False
        expected[item["reference_id"]] = (item["order"], item["raw_reference"].strip())
    rows = connection.execute(select(
        version_references.c.id,
        version_references.c.reference_order,
        version_references.c.raw_reference,
        version_references.c.source_artifact_id,
    ).where(
        version_references.c.citing_work_version_id == work_version_id,
        version_references.c.source_artifact_id.is_not(None),
    )).all()
    actual = {row.id: (row.reference_order, row.raw_reference) for row in rows}
    return (len(rows) == len(expected)
            and all(row.source_artifact_id == analysis_id for row in rows)
            and actual == expected)


def _tag_rows_align(connection: Connection, work_version_id: str, analysis_id: str,
                    items: list[object]) -> bool:
    expected: set[str] = set()
    for item in items:
        if (not isinstance(item, dict) or not isinstance(item.get("tag_id"), str)
                or item["tag_id"] in expected):
            return False
        expected.add(item["tag_id"])
    rows = connection.execute(select(
        generated_work_version_tags.c.tag_id,
        generated_work_version_tags.c.source_artifact_id,
    ).where(generated_work_version_tags.c.work_version_id == work_version_id)).all()
    return (len(rows) == len(expected)
            and all(row.source_artifact_id == analysis_id for row in rows)
            and {row.tag_id for row in rows} == expected)


def _collections_align(connection: Connection, work_version_id: str, analysis_id: str,
                       content: dict[str, object]) -> bool:
    collections: dict[str, list[object]] = {}
    for name in ("sections", "canonical_fields", "references", "generated_tags", "evidence"):
        value = content.get(name)
        if not isinstance(value, list):
            return False
        collections[name] = value
    return (_metadata_rows_align(connection, work_version_id, analysis_id, collections["canonical_fields"])
            and _reference_rows_align(connection, work_version_id, analysis_id, collections["references"])
            and _tag_rows_align(connection, work_version_id, analysis_id, collections["generated_tags"]))


def _canonical_aligns(connection: Connection, version) -> bool:
    provider = _projected_values(connection, provider_canonical_projections, version.id)
    generated = _projected_values(connection, generated_work_version_metadata, version.id)
    manual = _projected_values(connection, manual_metadata_overrides, version.id)
    expected = {**provider, **generated, **manual}
    if any(getattr(version, field_name) != expected.get(field_name) for field_name in CANONICAL_FIELDS):
        return False
    title = expected.get("title")
    return isinstance(title, str) and version.normalized_title == normalize_title(title)


def current_promotion_aligns(connection: Connection, version, primary: PrimaryPdf, current) -> bool:
    run = connection.execute(select(processing_runs).where(
        processing_runs.c.id == current.processing_run_id)).mappings().one_or_none()
    artifacts = connection.execute(select(normalized_artifacts).where(
        normalized_artifacts.c.id.in_((current.parser_artifact_id, current.analysis_artifact_id))
    )).mappings().all()
    by_id = {row["id"]: row for row in artifacts}
    parser, analysis = by_id.get(current.parser_artifact_id), by_id.get(current.analysis_artifact_id)
    if (run is None or parser is None or analysis is None
            or (run["work_version_id"], run["stage"], run["state"]) != (version.id, "analysis", "succeeded")
            or (run["input_raw_asset_id"], run["output_artifact_id"]) != (primary.id, analysis["id"])
            or (parser["work_version_id"], parser["raw_asset_id"], parser["kind"], parser["schema_version"], parser["media_type"])
            != (version.id, primary.id, "mineru_parser", "1", "application/vnd.sciretriever.mineru-parser.v1+json")
            or (analysis["work_version_id"], analysis["raw_asset_id"], analysis["kind"], analysis["schema_version"], analysis["media_type"])
            != (version.id, primary.id, "analysis", "1", "application/vnd.sciretriever.analysis.v1+json")):
        return False
    source = connection.execute(select(normalized_artifacts).where(
        normalized_artifacts.c.id == run["input_artifact_id"])).mappings().one_or_none()
    if (source is None or (source["work_version_id"], source["raw_asset_id"], source["kind"], source["schema_version"], source["media_type"])
            != (version.id, primary.id, "mineru_source_map", "1", "application/vnd.sciretriever.mineru-source-map.v1+json")):
        return False
    source_provenance = _json_object(source["provenance_json"])
    analysis_provenance = _json_object(analysis["provenance_json"])
    current_provenance = _json_object(current.provenance_json)
    content, run_details = _json_object(current.content_json), _json_object(run["details_json"])
    if any(value is None for value in (source_provenance, analysis_provenance, current_provenance, content, run_details)):
        return False
    assert source_provenance is not None and analysis_provenance is not None
    assert current_provenance is not None and content is not None and run_details is not None
    if (run_details.get("work_version_id") != version.id or run_details.get("stage") != "analysis"
            or run_details.get("input_raw_asset_ids") != [primary.id]
            or run_details.get("input_artifact_ids") != [source["id"]]
            or run_details.get("output_artifact_ids") != [analysis["id"]]
            or source_provenance.get("parser_artifact_id") != parser["id"]
            or source_provenance.get("parser_artifact_sha256") != parser["sha256"]
            or source_provenance.get("source_map_artifact_sha256") != source["sha256"]
            or source_provenance.get("input_raw_asset_id") != primary.id
            or source_provenance.get("input_raw_asset_sha256") != primary.sha256
            or analysis_provenance != current_provenance
            or analysis_provenance.get("document_sha256") != canonical_sha256(content)
            or analysis_provenance.get("analysis_run_id") != run["id"]
            or analysis_provenance.get("raw_asset_id") != primary.id
            or analysis_provenance.get("parser_artifact_id") != parser["id"]
            or analysis_provenance.get("source_map_artifact_id") != source["id"]):
        return False
    evidence = content.get("evidence")
    if not isinstance(evidence, list) or any(not isinstance(item, dict)
            or item.get("raw_asset_id") != primary.id or item.get("raw_asset_sha256") != primary.sha256
            or item.get("parser_artifact_id") != parser["id"] or item.get("source_map_artifact_id") != source["id"]
            for item in evidence):
        return False
    return (_collections_align(connection, version.id, analysis["id"], content)
            and _canonical_aligns(connection, version))


__all__ = ("PrimaryPdf", "current_promotion_aligns")
