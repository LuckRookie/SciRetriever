"""External parser attempts and single-current analysis ownership."""

from __future__ import annotations

import json
import re

from sqlalchemy import delete, func, insert, select, update

from sciretriever.catalog.canonical_projection import CANONICAL_FIELDS, recompute_canonical_projection
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import (
    current_analyses, external_parser_attempts, generated_work_version_metadata, generated_work_version_tags,
    identifiers, manual_metadata_overrides,
    normalized_artifacts, processing_runs, publishers, tags, venues,
    version_references, work_versions,
)
from sciretriever.catalog.records import CurrentAnalysisRecord, ExternalParserAttemptRecord
from sciretriever.catalog.repository import _required_text, canonical_json, catalog_operation
from sciretriever.core.contracts import Identifier
from sciretriever.core.derivation import canonical_sha256
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


class ExternalParserAttemptRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine) or catalog.read_only:
            raise CatalogError("ExternalParserAttemptRepository requires a writable catalog")
        self._catalog = catalog

    def create(self, processing_run_id: str, metadata: object, *, external_task_id: str | None = None) -> ExternalParserAttemptRecord:
        run_id = validate_uuid(processing_run_id, "processing_run_id")
        task_id = None if external_task_id is None else _required_text(external_task_id, "external_task_id")
        with catalog_operation("external parser attempt creation"):
            with self._catalog.critical_transaction() as connection:
                run = connection.execute(select(processing_runs.c.stage, processing_runs.c.state).where(processing_runs.c.id == run_id)).one_or_none()
                if run is None:
                    raise CatalogError(f"processing run does not exist: {run_id}")
                if run != ("parsing", "active"):
                    raise CatalogError("external parser attempts require an active parsing run")
                active_id = connection.execute(
                    select(external_parser_attempts.c.id).where(
                        external_parser_attempts.c.processing_run_id == run_id,
                        external_parser_attempts.c.state == "active",
                    )
                ).scalar_one_or_none()
                if active_id is not None:
                    raise CatalogError("processing run already has an active external parser attempt")
                sequence = connection.execute(select(func.coalesce(func.max(external_parser_attempts.c.sequence), 0) + 1).where(external_parser_attempts.c.processing_run_id == run_id)).scalar_one()
                now = utc_now_rfc3339()
                values = {"id": new_uuid4(), "processing_run_id": run_id, "sequence": sequence, "state": "active", "external_task_id": task_id, "metadata_json": canonical_json(metadata), "started_at": now, "finished_at": None}
                connection.execute(insert(external_parser_attempts).values(**values))
                return ExternalParserAttemptRecord.from_row(values)

    def finish(self, attempt_id: str, state: str) -> ExternalParserAttemptRecord:
        attempt_id = validate_uuid(attempt_id, "attempt_id")
        if state not in {"succeeded", "failed", "expired", "cancelled"}:
            raise ValueError("state must be a terminal parser attempt state")
        with catalog_operation("external parser attempt completion"):
            with self._catalog.critical_transaction() as connection:
                row = connection.execute(select(external_parser_attempts).where(external_parser_attempts.c.id == attempt_id)).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"external parser attempt does not exist: {attempt_id}")
                if row["state"] != "active":
                    if row["state"] != state:
                        raise CatalogError("external parser attempt terminal replay conflicts")
                    return ExternalParserAttemptRecord.from_row(row)
                now = utc_now_rfc3339()
                connection.execute(update(external_parser_attempts).where(external_parser_attempts.c.id == attempt_id).values(state=state, finished_at=now))
                return ExternalParserAttemptRecord.from_row({**dict(row), "state": state, "finished_at": now})

    def active_for_run(self, processing_run_id: str) -> ExternalParserAttemptRecord | None:
        run_id = validate_uuid(processing_run_id, "processing_run_id")
        with self._catalog.connect() as connection:
            row = connection.execute(select(external_parser_attempts).where(
                external_parser_attempts.c.processing_run_id == run_id,
                external_parser_attempts.c.state == "active",
            )).mappings().one_or_none()
        return None if row is None else ExternalParserAttemptRecord.from_row(row)

    def attach_task(self, attempt_id: str, external_task_id: str) -> ExternalParserAttemptRecord:
        attempt_id = validate_uuid(attempt_id, "attempt_id")
        task_id = validate_uuid(external_task_id, "external_task_id")
        with catalog_operation("external parser task attachment"):
            with self._catalog.critical_transaction() as connection:
                row = connection.execute(select(external_parser_attempts).where(
                    external_parser_attempts.c.id == attempt_id
                )).mappings().one_or_none()
                if row is None:
                    raise CatalogError(f"external parser attempt does not exist: {attempt_id}")
                if row["state"] != "active":
                    raise CatalogError("external parser task requires an active attempt")
                existing = row["external_task_id"]
                if existing is not None and existing != task_id:
                    raise CatalogError("external parser task attachment conflicts")
                if existing is None:
                    connection.execute(update(external_parser_attempts).where(
                        external_parser_attempts.c.id == attempt_id
                    ).values(external_task_id=task_id))
                return ExternalParserAttemptRecord.from_row({**dict(row), "external_task_id": task_id})

    def list_for_run(self, processing_run_id: str) -> tuple[ExternalParserAttemptRecord, ...]:
        run_id = validate_uuid(processing_run_id, "processing_run_id")
        with self._catalog.connect() as connection:
            rows = connection.execute(select(external_parser_attempts).where(external_parser_attempts.c.processing_run_id == run_id).order_by(external_parser_attempts.c.sequence)).mappings().all()
        return tuple(ExternalParserAttemptRecord.from_row(row) for row in rows)


class CurrentAnalysisRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine) or catalog.read_only:
            raise CatalogError("CurrentAnalysisRepository requires a writable catalog")
        self._catalog = catalog

    def get(self, work_version_id: str) -> CurrentAnalysisRecord | None:
        work_id = validate_uuid(work_version_id, "work_version_id")
        with self._catalog.connect() as connection:
            row = connection.execute(select(current_analyses).where(current_analyses.c.work_version_id == work_id)).mappings().one_or_none()
        return None if row is None else CurrentAnalysisRecord.from_row(row)

    def replace(self, work_version_id: str, processing_run_id: str, parser_artifact_id: str, analysis_artifact_id: str,
                content: object, provenance: object, *, projection: object | None = None,
                references: tuple[object, ...] = (), generated_tag_ids: tuple[str, ...] = (),
                expected_current_id: str | None, expected_revision: int) -> CurrentAnalysisRecord:
        work_id = validate_uuid(work_version_id, "work_version_id")
        run_id = validate_uuid(processing_run_id, "processing_run_id")
        parser_id = validate_uuid(parser_artifact_id, "parser_artifact_id")
        analysis_id = validate_uuid(analysis_artifact_id, "analysis_artifact_id")
        expected_id = None if expected_current_id is None else validate_uuid(expected_current_id, "expected_current_id")
        if not isinstance(expected_revision, int) or isinstance(expected_revision, bool) or expected_revision < 0:
            raise ValueError("expected_revision must be a nonnegative integer")
        with catalog_operation("current analysis replacement"):
            with self._catalog.critical_transaction() as connection:
                current = connection.execute(select(current_analyses).where(current_analyses.c.work_version_id == work_id)).mappings().one_or_none()
                actual = None if current is None else (current["id"], current["revision"])
                if actual != (expected_id, expected_revision) and not (actual is None and expected_id is None and expected_revision == 0):
                    raise CatalogError("current analysis replacement conflict")
                run = connection.execute(
                    select(
                        processing_runs.c.work_version_id,
                        processing_runs.c.stage,
                        processing_runs.c.state,
                        processing_runs.c.input_raw_asset_id,
                        processing_runs.c.input_artifact_id,
                        processing_runs.c.output_artifact_id,
                        processing_runs.c.details_json,
                    ).where(processing_runs.c.id == run_id)
                ).mappings().one_or_none()
                artifacts = connection.execute(
                    select(
                        normalized_artifacts.c.id,
                        normalized_artifacts.c.work_version_id,
                        normalized_artifacts.c.kind,
                        normalized_artifacts.c.schema_version,
                        normalized_artifacts.c.media_type,
                        normalized_artifacts.c.raw_asset_id,
                        normalized_artifacts.c.provenance_json,
                    ).where(normalized_artifacts.c.id.in_((parser_id, analysis_id)))
                ).mappings().all()
                if run is None or (run["work_version_id"], run["stage"], run["state"]) != (work_id, "analysis", "succeeded"):
                    raise CatalogError("current analysis requires a succeeded analysis run for the WorkVersion")
                artifact_contract = {
                    row["id"]: (row["work_version_id"], row["kind"], row["schema_version"], row["media_type"])
                    for row in artifacts
                }
                if artifact_contract != {
                    parser_id: (work_id, "mineru_parser", "1", "application/vnd.sciretriever.mineru-parser.v1+json"),
                    analysis_id: (work_id, "analysis", "1", "application/vnd.sciretriever.analysis.v1+json"),
                }:
                    raise CatalogError("current analysis requires MinerU parser and analysis artifacts for the WorkVersion")
                try:
                    run_details = json.loads(run["details_json"])
                except (TypeError, ValueError) as error:
                    raise CatalogError("analysis processing run has invalid artifact lineage") from error
                detail_fields = {"work_version_id", "stage", "producer", "producer_version", "parameters",
                                 "input_raw_asset_ids", "input_artifact_ids", "parameters_sha256", "output_artifact_ids"}
                parameter_fields = {"schema_version", "provider", "model", "schema_sha256", "provider_sha256",
                                    "model_sha256", "configuration_sha256", "input_sha256",
                                    "document_hash_algorithm", "max_completion_tokens", "target_revision"}
                if (set(run_details) != detail_fields
                    or run_details.get("work_version_id") != work_id or run_details.get("stage") != "analysis"
                    or run_details.get("producer") != "sciretriever.analysis" or run_details.get("producer_version") != "1"
                    or not isinstance(run_details.get("parameters"), dict) or set(run_details["parameters"]) != parameter_fields
                    or run_details["parameters"].get("schema_version") != "1"
                    or run_details["parameters"].get("document_hash_algorithm") != "canonical_sha256"
                    or run_details["parameters"].get("target_revision") != expected_revision + 1
                    or run_details.get("parameters_sha256") != canonical_sha256(run_details["parameters"])
                    or run_details.get("input_raw_asset_ids") != [next(row["raw_asset_id"] for row in artifacts if row["id"] == analysis_id)]
                    or not isinstance(run_details.get("input_artifact_ids"), list) or len(run_details["input_artifact_ids"]) != 1
                    or run_details.get("output_artifact_ids") != [analysis_id]
                ):
                    raise CatalogError("analysis processing run artifact lineage does not match current analysis artifacts")
                input_id = run_details["input_artifact_ids"][0]
                input_artifact = connection.execute(select(normalized_artifacts).where(normalized_artifacts.c.id == input_id)).mappings().one_or_none()
                if (input_artifact is None or input_artifact["work_version_id"] != work_id or input_artifact["kind"] != "mineru_source_map"
                        or input_artifact["schema_version"] != "1"
                        or input_artifact["media_type"] != "application/vnd.sciretriever.mineru-source-map.v1+json"
                        or (run["input_raw_asset_id"], run["input_artifact_id"], run["output_artifact_id"])
                           != (input_artifact["raw_asset_id"], input_id, analysis_id)):
                    raise CatalogError("analysis processing run requires validated MinerU artifact lineage")
                try:
                    input_provenance = json.loads(input_artifact["provenance_json"])
                except (TypeError, ValueError) as error:
                    raise CatalogError("source-map artifact has invalid parser lineage") from error
                if input_provenance.get("parser_artifact_id") != parser_id:
                    raise CatalogError("source-map artifact parser lineage does not match current analysis")
                parser_artifact = connection.execute(select(normalized_artifacts).where(
                    normalized_artifacts.c.id == parser_id)).mappings().one()
                if (input_provenance.get("input_raw_asset_id") != input_artifact["raw_asset_id"]
                        or input_provenance.get("input_raw_asset_sha256") is None
                        or input_provenance.get("parser_artifact_sha256") != parser_artifact["sha256"]
                        or input_provenance.get("source_map_artifact_sha256") != input_artifact["sha256"]):
                    raise CatalogError("source-map artifact PDF and parser hashes are invalid")

                analysis_artifact = next(row for row in artifacts if row["id"] == analysis_id)
                try:
                    registered_provenance = json.loads(analysis_artifact["provenance_json"])
                except (TypeError, ValueError) as error:
                    raise CatalogError("analysis artifact provenance is invalid") from error
                if (not isinstance(registered_provenance, dict)
                        or canonical_json(provenance) != analysis_artifact["provenance_json"]
                        or registered_provenance.get("document_sha256") != canonical_sha256(content)
                        or registered_provenance.get("analysis_run_id") != run_id
                        or registered_provenance.get("schema_version") != "1"
                        or registered_provenance.get("raw_asset_id") != input_artifact["raw_asset_id"]
                        or registered_provenance.get("parser_artifact_id") != parser_id
                        or registered_provenance.get("source_map_artifact_id") != input_id
                        or analysis_artifact["raw_asset_id"] != input_artifact["raw_asset_id"]
                        or parser_artifact["raw_asset_id"] != input_artifact["raw_asset_id"]):
                    raise CatalogError("current analysis content or provenance does not match the immutable analysis artifact")

                evidence = self._validate_content_evidence(content, input_id, parser_id, input_artifact["raw_asset_id"],
                                                           input_provenance["input_raw_asset_sha256"])
                projected = self._validate_projection(connection, projection)
                reference_rows = self._validate_references(connection, work_id, analysis_id, references, evidence)
                tag_ids = tuple(validate_uuid(value, "generated_tag_id") for value in generated_tag_ids)
                if len(tag_ids) != len(set(tag_ids)):
                    raise ValueError("generated_tag_ids contains duplicates")
                if tag_ids:
                    existing_tags = set(connection.execute(select(tags.c.id).where(tags.c.id.in_(tag_ids))).scalars())
                    if existing_tags != set(tag_ids):
                        raise CatalogError("generated analysis tag IDs must already exist")
                now = utc_now_rfc3339()
                revision = expected_revision + 1
                values = {"id": new_uuid4(), "work_version_id": work_id, "revision": revision, "processing_run_id": run_id, "parser_artifact_id": parser_id, "analysis_artifact_id": analysis_id, "content_json": canonical_json(content), "provenance_json": canonical_json(provenance), "created_at": now, "updated_at": now}
                if current is None:
                    connection.execute(insert(current_analyses).values(**values))
                else:
                    result = connection.execute(update(current_analyses).where(current_analyses.c.work_version_id == work_id, current_analyses.c.id == expected_id, current_analyses.c.revision == expected_revision).values(**values))
                    if result.rowcount != 1:
                        raise CatalogError("current analysis replacement conflict")
                prior_analysis_id = None if current is None else current["analysis_artifact_id"]
                self._replace_projections(connection, work_id, analysis_id, prior_analysis_id, projected, reference_rows, tag_ids, now)
                if current is not None and prior_analysis_id != analysis_id:
                    connection.execute(
                        delete(processing_runs).where(
                            processing_runs.c.id == current["processing_run_id"]
                        )
                    )
                    connection.execute(
                        delete(normalized_artifacts).where(
                            normalized_artifacts.c.id == prior_analysis_id
                        )
                    )
                return CurrentAnalysisRecord.from_row(values)

    @staticmethod
    def _validate_projection(connection, projection: object | None) -> dict[str, object]:
        allowed = {"title", "abstract", "language", "work_type", "publication_date", "publication_year",
                   "publisher_id", "venue_id", "volume", "issue", "pages", "article_number", "open_access_status"}
        if projection is None:
            return {}
        if not isinstance(projection, dict) or not set(projection).issubset(allowed):
            raise ValueError("analysis projection contains unsupported fields")
        values: dict[str, object] = {}
        for name, value in projection.items():
            values[name] = _validate_canonical_value(connection, name, value)
        return values

    @staticmethod
    def _validate_content_evidence(content: object, source_map_id: str, parser_id: str, raw_asset_id: str,
                                   raw_asset_sha256: str) -> dict[str, dict[str, object]]:
        if not isinstance(content, dict) or not isinstance(content.get("evidence"), list):
            raise ValueError("current analysis content requires complete PDF evidence")
        evidence: dict[str, dict[str, object]] = {}
        required = {"evidence_id", "raw_asset_id", "raw_asset_sha256", "parser_artifact_id", "source_map_artifact_id",
                    "source_unit_id", "page_index", "structural_span_path", "bbox", "source_start", "source_end",
                    "document_start", "document_end"}
        for value in content["evidence"]:
            if not isinstance(value, dict) or set(value) != required or not isinstance(value.get("evidence_id"), str):
                raise ValueError("current analysis contains an invalid PDF locator")
            evidence_id = value["evidence_id"]
            if (evidence_id in evidence or value.get("source_map_artifact_id") != source_map_id
                    or value.get("parser_artifact_id") != parser_id or value.get("raw_asset_id") != raw_asset_id
                    or value.get("raw_asset_sha256") != raw_asset_sha256):
                raise CatalogError("current analysis PDF locator lineage is invalid")
            evidence[evidence_id] = value
        for collection in ("sections", "canonical_fields", "references", "generated_tags"):
            values = content.get(collection)
            if not isinstance(values, list):
                raise ValueError("current analysis promoted collections are invalid")
            for item in values:
                if not isinstance(item, dict) or not isinstance(item.get("evidence_ids"), list) or not item["evidence_ids"]:
                    raise ValueError("current analysis promoted value requires PDF evidence")
                if item.get("locators") != [evidence.get(identifier) for identifier in item["evidence_ids"]]:
                    raise CatalogError("current analysis promoted locator identity is invalid")
        used = {identifier for collection in ("sections", "canonical_fields", "references", "generated_tags")
                for item in content[collection] for identifier in item["evidence_ids"]}
        if used != set(evidence):
            raise CatalogError("current analysis evidence does not exactly cover promoted values")
        return evidence

    @staticmethod
    def _validate_references(connection, work_version_id: str, artifact_id: str, references: tuple[object, ...],
                             evidence: dict[str, dict[str, object]]) -> tuple[dict[str, object], ...]:
        required = {"reference_id", "order", "raw_reference", "resolved_work_id", "identifier_namespace", "identifier_value", "evidence_ids", "locators"}
        rows: list[dict[str, object]] = []
        orders: set[int] = set()
        for value in references:
            if not isinstance(value, dict) or set(value) != required:
                raise ValueError("analysis reference projection is invalid")
            order = value["order"]
            if type(order) is not int or order < 0 or order in orders:
                raise ValueError("analysis reference order is invalid or duplicated")
            orders.add(order)
            raw = value["raw_reference"]
            evidence_ids = value["evidence_ids"]
            if (not isinstance(raw, str) or not raw.strip() or not isinstance(evidence_ids, list) or not evidence_ids
                    or value["locators"] != [evidence.get(identifier) for identifier in evidence_ids]):
                raise ValueError("analysis reference requires text and PDF evidence")
            cited_work_id = value["resolved_work_id"]
            namespace, identifier_value = value["identifier_namespace"], value["identifier_value"]
            if namespace is not None or identifier_value is not None:
                if not isinstance(namespace, str) or not isinstance(identifier_value, str):
                    raise ValueError("analysis reference identifier must be paired strings")
                normalized_identifier = Identifier(namespace, identifier_value)
                if (normalized_identifier.namespace, normalized_identifier.value) != (namespace, identifier_value):
                    raise ValueError("analysis reference identifier must use canonical normalization")
            if cited_work_id is not None:
                cited_work_id = validate_uuid(cited_work_id, "resolved_work_id")
                resolved = connection.execute(select(identifiers.c.work_id).where(identifiers.c.namespace == namespace, identifiers.c.value == identifier_value)).scalar_one_or_none()
                if resolved != cited_work_id:
                    raise CatalogError("resolved analysis reference identifier is not catalog-backed")
            rows.append({"id": validate_uuid(value["reference_id"], "reference_id"),
                         "citing_work_version_id": work_version_id, "cited_work_id": cited_work_id,
                         "reference_order": order, "raw_reference": raw.strip(), "cited_namespace": namespace,
                         "cited_value": identifier_value, "source_artifact_id": artifact_id,
                         "locator_json": canonical_json(value["locators"])})
        return tuple(rows)

    @staticmethod
    def _replace_projections(connection, work_version_id: str, artifact_id: str, prior_analysis_id: str | None,
                             projection: dict[str, object],
                             references: tuple[dict[str, object], ...], tag_ids: tuple[str, ...], now: str) -> None:
        connection.execute(delete(generated_work_version_metadata).where(
            generated_work_version_metadata.c.work_version_id == work_version_id))
        for field_name, value in projection.items():
            connection.execute(insert(generated_work_version_metadata).values(
                work_version_id=work_version_id, field_name=field_name, source_artifact_id=artifact_id,
                value_json=canonical_json(value), projected_at=now))
        recompute_canonical_projection(connection, work_version_id)
        if prior_analysis_id is not None:
            connection.execute(delete(version_references).where(
                version_references.c.citing_work_version_id == work_version_id,
                version_references.c.source_artifact_id == prior_analysis_id))
        for row in references:
            connection.execute(insert(version_references).values(**row, created_at=now))
        if prior_analysis_id is not None:
            connection.execute(delete(generated_work_version_tags).where(
                generated_work_version_tags.c.work_version_id == work_version_id,
                generated_work_version_tags.c.source_artifact_id == prior_analysis_id))
        for tag_id in tag_ids:
            connection.execute(insert(generated_work_version_tags).values(work_version_id=work_version_id, tag_id=tag_id,
                                                                           source_artifact_id=artifact_id, linked_at=now))


class ManualMetadataRepository:
    """Explicit manual canonical-field overrides, independent of generated state."""

    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine) or catalog.read_only:
            raise CatalogError("ManualMetadataRepository requires a writable catalog")
        self._catalog = catalog

    def set(self, work_version_id: str, field_name: str, value: object) -> None:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        field_name = _required_text(field_name, "field_name")
        with self._catalog.critical_transaction() as connection:
            value = _validate_canonical_value(connection, field_name, value)
            connection.execute(insert(manual_metadata_overrides).prefix_with("OR REPLACE").values(
                work_version_id=work_version_id, field_name=field_name, value_json=canonical_json(value), updated_at=utc_now_rfc3339()))
            recompute_canonical_projection(connection, work_version_id, frozenset({field_name}))

    def remove(self, work_version_id: str, field_name: str) -> None:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        field_name = _required_text(field_name, "field_name")
        with self._catalog.critical_transaction() as connection:
            connection.execute(delete(manual_metadata_overrides).where(
                manual_metadata_overrides.c.work_version_id == work_version_id,
                manual_metadata_overrides.c.field_name == field_name))
            recompute_canonical_projection(connection, work_version_id, frozenset({field_name}))


def _validate_canonical_value(connection, field_name: str, value: object) -> object:
    if field_name not in CANONICAL_FIELDS:
        raise ValueError("unsupported canonical metadata field")
    if field_name == "publication_year":
        if type(value) is not int or value < 0:
            raise ValueError("publication_year must be a nonnegative integer")
        return value
    if not isinstance(value, str) or not value.strip():
        raise ValueError("canonical metadata strings must be non-blank")
    normalized = value.strip()
    if field_name == "publication_date" and re.fullmatch(r"\d{4}(?:-\d{2}-\d{2})?", normalized) is None:
        raise ValueError("publication_date must be YYYY or YYYY-MM-DD")
    if field_name in {"publisher_id", "venue_id"}:
        normalized = validate_uuid(normalized, field_name)
        table = publishers if field_name == "publisher_id" else venues
        if connection.execute(select(table.c.id).where(table.c.id == normalized)).scalar_one_or_none() is None:
            raise CatalogError(f"{field_name} must already exist in its registry")
    return normalized

__all__ = ("CurrentAnalysisRepository", "ExternalParserAttemptRepository", "ManualMetadataRepository")
