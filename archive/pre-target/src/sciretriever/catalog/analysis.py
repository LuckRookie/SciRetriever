"""External parser attempts and single-current analysis ownership."""

from __future__ import annotations

import json
from collections.abc import Callable

from sqlalchemy import delete, func, insert, select, update

from sciretriever.catalog.analysis_validation import validate_projection, validate_tag_ids
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import (
    current_analyses, generated_work_version_metadata, generated_work_version_tags,
    normalized_artifacts, processing_runs,
    version_references, work_versions,
)
from sciretriever.catalog.records import CurrentAnalysisRecord
from sciretriever.catalog.parser_attempts import ExternalParserAttemptRepository
from sciretriever.catalog.promotion_failpoints import PROMOTION_FAILPOINTS, PromotionFailpoint
from sciretriever.catalog.analysis_projections import (
    replace_projections, validate_content_evidence, validate_references,
)
from sciretriever.catalog.repository import canonical_json, catalog_operation
from sciretriever.core.derivation import canonical_sha256
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.errors import CatalogError


class CurrentAnalysisRepository:
    PROMOTION_FAILPOINTS = PROMOTION_FAILPOINTS

    def __init__(self, catalog: CatalogEngine, *,
                 test_failpoint: Callable[[str], None] | None = None) -> None:
        if not isinstance(catalog, CatalogEngine) or catalog.read_only:
            raise CatalogError("CurrentAnalysisRepository requires a writable catalog")
        self._catalog = catalog
        self._failpoint = PromotionFailpoint(test_failpoint)

    def _before_write(self, point: str) -> None:
        self._failpoint.before(point)

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

                evidence = validate_content_evidence(content, input_id, parser_id, input_artifact["raw_asset_id"],
                                                     input_provenance["input_raw_asset_sha256"])
                projected = validate_projection(connection, projection)
                reference_rows = validate_references(connection, work_id, analysis_id, references, evidence)
                tag_ids = validate_tag_ids(connection, generated_tag_ids)
                now = utc_now_rfc3339()
                revision = expected_revision + 1
                values = {"id": new_uuid4(), "work_version_id": work_id, "revision": revision, "processing_run_id": run_id, "parser_artifact_id": parser_id, "analysis_artifact_id": analysis_id, "content_json": canonical_json(content), "provenance_json": canonical_json(provenance), "created_at": now, "updated_at": now}
                self._before_write("before_current_analysis_write")
                if current is None:
                    connection.execute(insert(current_analyses).values(**values))
                else:
                    result = connection.execute(update(current_analyses).where(current_analyses.c.work_version_id == work_id, current_analyses.c.id == expected_id, current_analyses.c.revision == expected_revision).values(**values))
                    if result.rowcount != 1:
                        raise CatalogError("current analysis replacement conflict")
                prior_analysis_id = None if current is None else current["analysis_artifact_id"]
                replace_projections(connection, work_id, analysis_id, prior_analysis_id, projected,
                                    reference_rows, tag_ids, now, self._before_write)
                if current is not None and prior_analysis_id != analysis_id:
                    self._before_write("before_prior_run_delete")
                    connection.execute(
                        delete(processing_runs).where(
                            processing_runs.c.id == current["processing_run_id"]
                        )
                    )
                    self._before_write("before_prior_artifact_delete")
                    connection.execute(
                        delete(normalized_artifacts).where(
                            normalized_artifacts.c.id == prior_analysis_id
                        )
                    )
                return CurrentAnalysisRecord.from_row(values)

__all__ = ("CurrentAnalysisRepository", "ExternalParserAttemptRepository")
