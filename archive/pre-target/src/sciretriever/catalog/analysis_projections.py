"""Validation and persistence of analysis-derived catalog projections."""

from __future__ import annotations

from collections.abc import Callable

from sqlalchemy import delete, insert, select

from .canonical_projection import recompute_canonical_projection
from .models import (generated_work_version_metadata, generated_work_version_tags,
                     identifiers, version_references)
from .repository import canonical_json
from sciretriever.core.contracts import Identifier
from sciretriever.core.ids import validate_uuid
from sciretriever.errors import CatalogError


def validate_content_evidence(content: object, source_map_id: str, parser_id: str,
                              raw_asset_id: str, raw_asset_sha256: str) -> dict[str, dict[str, object]]:
    if not isinstance(content, dict) or not isinstance(content.get("evidence"), list):
        raise ValueError("current analysis content requires complete PDF evidence")
    evidence: dict[str, dict[str, object]] = {}
    required = {"evidence_id", "raw_asset_id", "raw_asset_sha256", "parser_artifact_id",
                "source_map_artifact_id", "source_unit_id", "page_index", "structural_span_path",
                "bbox", "source_start", "source_end", "document_start", "document_end"}
    for value in content["evidence"]:
        if not isinstance(value, dict) or set(value) != required or not isinstance(value.get("evidence_id"), str):
            raise ValueError("current analysis contains an invalid PDF locator")
        evidence_id = value["evidence_id"]
        if (evidence_id in evidence or value.get("source_map_artifact_id") != source_map_id
                or value.get("parser_artifact_id") != parser_id or value.get("raw_asset_id") != raw_asset_id
                or value.get("raw_asset_sha256") != raw_asset_sha256):
            raise CatalogError("current analysis PDF locator lineage is invalid")
        evidence[evidence_id] = value
    collections = ("sections", "canonical_fields", "references", "generated_tags")
    for collection in collections:
        values = content.get(collection)
        if not isinstance(values, list):
            raise ValueError("current analysis promoted collections are invalid")
        for item in values:
            if not isinstance(item, dict) or not isinstance(item.get("evidence_ids"), list) or not item["evidence_ids"]:
                raise ValueError("current analysis promoted value requires PDF evidence")
            if item.get("locators") != [evidence.get(identifier) for identifier in item["evidence_ids"]]:
                raise CatalogError("current analysis promoted locator identity is invalid")
    used = {identifier for collection in collections for item in content[collection]
            for identifier in item["evidence_ids"]}
    if used != set(evidence):
        raise CatalogError("current analysis evidence does not exactly cover promoted values")
    return evidence


def validate_references(connection, work_version_id: str, artifact_id: str,
                        references: tuple[object, ...], evidence: dict[str, dict[str, object]]) -> tuple[dict[str, object], ...]:
    required = {"reference_id", "order", "raw_reference", "resolved_work_id",
                "identifier_namespace", "identifier_value", "evidence_ids", "locators"}
    rows: list[dict[str, object]] = []
    orders: set[int] = set()
    for value in references:
        if not isinstance(value, dict) or set(value) != required:
            raise ValueError("analysis reference projection is invalid")
        order, raw, evidence_ids = value["order"], value["raw_reference"], value["evidence_ids"]
        if type(order) is not int or order < 0 or order in orders:
            raise ValueError("analysis reference order is invalid or duplicated")
        orders.add(order)
        if (not isinstance(raw, str) or not raw.strip() or not isinstance(evidence_ids, list)
                or not evidence_ids or value["locators"] != [evidence.get(item) for item in evidence_ids]):
            raise ValueError("analysis reference requires text and PDF evidence")
        cited_work_id = value["resolved_work_id"]
        namespace, identifier_value = value["identifier_namespace"], value["identifier_value"]
        if namespace is not None or identifier_value is not None:
            if not isinstance(namespace, str) or not isinstance(identifier_value, str):
                raise ValueError("analysis reference identifier must be paired strings")
            normalized = Identifier(namespace, identifier_value)
            if (normalized.namespace, normalized.value) != (namespace, identifier_value):
                raise ValueError("analysis reference identifier must use canonical normalization")
        if cited_work_id is not None:
            cited_work_id = validate_uuid(cited_work_id, "resolved_work_id")
            resolved = connection.execute(select(identifiers.c.work_id).where(
                identifiers.c.namespace == namespace, identifiers.c.value == identifier_value)).scalar_one_or_none()
            if resolved != cited_work_id:
                raise CatalogError("resolved analysis reference identifier is not catalog-backed")
        rows.append({"id": validate_uuid(value["reference_id"], "reference_id"),
                     "citing_work_version_id": work_version_id, "cited_work_id": cited_work_id,
                     "reference_order": order, "raw_reference": raw.strip(), "cited_namespace": namespace,
                     "cited_value": identifier_value, "source_artifact_id": artifact_id,
                     "locator_json": canonical_json(value["locators"])})
    return tuple(rows)


def replace_projections(connection, work_version_id: str, artifact_id: str,
                        prior_analysis_id: str | None, projection: dict[str, object],
                        references: tuple[dict[str, object], ...], tag_ids: tuple[str, ...],
                        now: str, before_write: Callable[[str], None]) -> None:
    before_write("before_generated_metadata_delete")
    connection.execute(delete(generated_work_version_metadata).where(
        generated_work_version_metadata.c.work_version_id == work_version_id))
    for field_name, value in projection.items():
        before_write("before_generated_metadata_insert")
        connection.execute(insert(generated_work_version_metadata).values(
            work_version_id=work_version_id, field_name=field_name, source_artifact_id=artifact_id,
            value_json=canonical_json(value), projected_at=now))
    before_write("before_canonical_projection_write")
    recompute_canonical_projection(connection, work_version_id)
    if prior_analysis_id is not None:
        before_write("before_reference_delete")
        connection.execute(delete(version_references).where(
            version_references.c.citing_work_version_id == work_version_id,
            version_references.c.source_artifact_id == prior_analysis_id))
    for row in references:
        before_write("before_reference_insert")
        connection.execute(insert(version_references).values(**row, created_at=now))
    if prior_analysis_id is not None:
        before_write("before_generated_tag_delete")
        connection.execute(delete(generated_work_version_tags).where(
            generated_work_version_tags.c.work_version_id == work_version_id,
            generated_work_version_tags.c.source_artifact_id == prior_analysis_id))
    for tag_id in tag_ids:
        before_write("before_generated_tag_insert")
        connection.execute(insert(generated_work_version_tags).values(
            work_version_id=work_version_id, tag_id=tag_id,
            source_artifact_id=artifact_id, linked_at=now))


__all__ = ("replace_projections", "validate_content_evidence", "validate_references")
