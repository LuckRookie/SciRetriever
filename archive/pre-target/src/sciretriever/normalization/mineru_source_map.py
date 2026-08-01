"""Validated MinerU PDF geometry to immutable neutral source-map artifacts."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
import hashlib
import json
from typing import Any

from PyPDF2 import PdfReader

from sciretriever.catalog import ArtifactRegistration, ArtifactRepository, AssetRepository, NormalizedArtifactRecord, PackageSourceRepository, ProcessingRunRecord, ProcessingRunRepository
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.core.derivation import canonical_json_bytes, canonical_sha256, stable_derivation_id
from sciretriever.core.enums import AssetRole
from sciretriever.core.ids import validate_uuid
from sciretriever.core.validation import validate_sha256
from sciretriever.errors import NormalizationError
from sciretriever.storage import DerivedArtifactStore, RawAssetStore

from .contracts import PdfBoundingBox, PdfEvidenceLocator, PdfPageGeometry, PdfSourceUnit
from .mineru_service import MinerUParsingResult


MINERU_SOURCE_MAP_KIND = "mineru_source_map"
MINERU_SOURCE_MAP_SCHEMA_VERSION = "1"
MINERU_SOURCE_MAP_MEDIA_TYPE = "application/vnd.sciretriever.mineru-source-map.v1+json"
MINERU_SOURCE_MAP_PRODUCER = "sciretriever.mineru_source_map"
MINERU_SOURCE_MAP_PRODUCER_VERSION = "1"
PAGE_SIZE_TOLERANCE = 0.5  # PDF points; permits harmless serializer rounding only.


@dataclass(frozen=True, slots=True)
class MinerUSourceMap:
    artifact_id: str
    raw_asset_id: str
    raw_asset_sha256: str
    parser_artifact_id: str
    parser_artifact_sha256: str
    parsing_run_id: str
    page_geometry: tuple[PdfPageGeometry, ...]
    source_units: tuple[PdfSourceUnit, ...]
    evidence: tuple[PdfEvidenceLocator, ...]

    def __post_init__(self) -> None:
        for value, name in ((self.artifact_id, "artifact_id"), (self.raw_asset_id, "raw_asset_id"), (self.parser_artifact_id, "parser_artifact_id"), (self.parsing_run_id, "parsing_run_id")):
            validate_uuid(value, name)
        validate_sha256(self.raw_asset_sha256)
        validate_sha256(self.parser_artifact_sha256)
        if not isinstance(self.page_geometry, tuple) or not all(isinstance(page, PdfPageGeometry) for page in self.page_geometry) or not self.page_geometry:
            raise TypeError("page_geometry must be a non-empty tuple of PdfPageGeometry values")
        if not isinstance(self.source_units, tuple) or not all(isinstance(unit, PdfSourceUnit) for unit in self.source_units):
            raise TypeError("source_units must be a tuple of PdfSourceUnit values")
        if not isinstance(self.evidence, tuple) or not all(isinstance(locator, PdfEvidenceLocator) for locator in self.evidence):
            raise TypeError("evidence must be a tuple of PdfEvidenceLocator values")
        if tuple(page.page_index for page in self.page_geometry) != tuple(range(len(self.page_geometry))):
            raise ValueError("page geometry must use contiguous zero-based indexes")
        if tuple(unit.ordinal for unit in self.source_units) != tuple(range(len(self.source_units))):
            raise ValueError("PDF source units must use contiguous ordinals")
        unit_ids = {unit.unit_id for unit in self.source_units}
        if len(unit_ids) != len(self.source_units) or len(self.evidence) != len(self.source_units):
            raise ValueError("PDF source units and evidence must be one-to-one")
        expected_document_start = 0
        for unit, locator in zip(self.source_units, self.evidence, strict=True):
            page = self.page_geometry[unit.page_index] if unit.page_index < len(self.page_geometry) else None
            if (
                page is None
                or unit.bbox.right > page.width
                or unit.bbox.bottom > page.height
                or unit.document_start != expected_document_start
                or unit.raw_asset_id != self.raw_asset_id
                or locator.source_unit_id != unit.unit_id
                or locator.raw_asset_id != self.raw_asset_id
                or locator.raw_asset_sha256 != self.raw_asset_sha256
                or locator.parser_artifact_id != self.parser_artifact_id
                or locator.source_map_artifact_id != self.artifact_id
                or locator.page_index != unit.page_index
                or locator.structural_span_path != unit.structural_span_path
                or locator.bbox != unit.bbox
                or (locator.source_start, locator.source_end, locator.document_start, locator.document_end)
                != (unit.source_start, unit.source_end, unit.document_start, unit.document_end)
            ):
                raise ValueError("PDF evidence does not match its source unit lineage")
            expected_document_start = unit.document_end

    def to_dict(self) -> dict[str, object]:
        return {
            "schema_version": MINERU_SOURCE_MAP_SCHEMA_VERSION, "kind": MINERU_SOURCE_MAP_KIND,
            "artifact_id": self.artifact_id, "raw_asset_id": self.raw_asset_id,
            "raw_asset_sha256": self.raw_asset_sha256, "parser_artifact_id": self.parser_artifact_id,
            "parser_artifact_sha256": self.parser_artifact_sha256, "parsing_run_id": self.parsing_run_id,
            "page_geometry": [value.to_dict() for value in self.page_geometry],
            "source_units": [value.to_dict() for value in self.source_units],
            "evidence": [value.to_dict() for value in self.evidence],
        }


@dataclass(frozen=True, slots=True)
class MinerUSourceMapResult:
    run: ProcessingRunRecord
    artifact: NormalizedArtifactRecord
    source_map: MinerUSourceMap


@dataclass(frozen=True, slots=True)
class _VerifiedInputs:
    pdf: bytes
    middle: dict[str, Any]
    parser: NormalizedArtifactRecord
    parsing_run: ProcessingRunRecord
    parsing_details: dict[str, Any]


def _bbox(value: object, page: PdfPageGeometry) -> PdfBoundingBox:
    if not isinstance(value, list) or len(value) != 4:
        raise NormalizationError("MinerU span has an invalid bbox")
    try:
        box = PdfBoundingBox(*(float(item) for item in value))
    except (TypeError, ValueError) as error:
        raise NormalizationError("MinerU span has an invalid bbox") from error
    if box.right > page.width or box.bottom > page.height:
        raise NormalizationError("MinerU span bbox is outside the accepted PDF page")
    return box


def _text(span: dict[str, object]) -> str | None:
    for key in ("content", "html"):
        value = span.get(key)
        if isinstance(value, str) and value:
            return value
        if value is not None and not isinstance(value, str):
            raise NormalizationError(f"MinerU span {key} must be text")
    return None


def _span_items(blocks: object, prefix: str) -> list[tuple[str, dict[str, object]]]:
    if not isinstance(blocks, list):
        raise NormalizationError("MinerU para_blocks must be a list")
    found: list[tuple[str, dict[str, object]]] = []
    for block_index, block_value in enumerate(blocks):
        if not isinstance(block_value, dict):
            raise NormalizationError("MinerU para_blocks contain an invalid block")
        block: dict[str, object] = block_value
        block_path = f"{prefix}/{block_index}"
        nested = block.get("blocks", [])
        lines = block.get("lines", [])
        if not isinstance(nested, list) or not isinstance(lines, list):
            raise NormalizationError("MinerU block children are invalid")
        found.extend(_span_items(nested, f"{block_path}/blocks"))
        for line_index, line_value in enumerate(lines):
            if not isinstance(line_value, dict) or not isinstance(line_value.get("spans"), list):
                raise NormalizationError("MinerU line spans are invalid")
            for span_index, span_value in enumerate(line_value["spans"]):
                if not isinstance(span_value, dict):
                    raise NormalizationError("MinerU line contains an invalid span")
                found.append((f"{block_path}/lines/{line_index}/spans/{span_index}", span_value))
    return found


def _pdf_geometry(pdf: bytes) -> tuple[PdfPageGeometry, ...]:
    try:
        reader = PdfReader(BytesIO(pdf), strict=True)
        result = []
        for index, page in enumerate(reader.pages):
            width = float(page.mediabox.width)
            height = float(page.mediabox.height)
            rotation = int(page.get("/Rotate", 0)) % 360
            if rotation not in {0, 90, 180, 270}:
                raise NormalizationError("accepted PDF has unsupported page rotation")
            if rotation in {90, 270}:
                width, height = height, width
            result.append(PdfPageGeometry(index, width, height))
        if not result:
            raise NormalizationError("accepted PDF has no pages")
        return tuple(result)
    except NormalizationError:
        raise
    except Exception as error:
        raise NormalizationError("accepted primary PDF cannot be parsed in strict mode") from error


class MinerUSourceMapService:
    def __init__(self, catalog: CatalogEngine, raw_store: RawAssetStore, derived_store: DerivedArtifactStore) -> None:
        self.assets = AssetRepository(catalog)
        self.sources = PackageSourceRepository(catalog)
        self.artifacts = ArtifactRepository(catalog)
        self.runs = ProcessingRunRepository(catalog)
        self.raw_store = raw_store
        self.derived_store = derived_store

    def _validate_inputs(self, work_version_id: str, parsed: MinerUParsingResult) -> _VerifiedInputs:
        try:
            parser = self.artifacts.get(parsed.parser_artifact.id)
            parsing_run = self.runs.get(parsed.run.id)
            links = self.assets.get_work_version_assets(work_version_id)
            primary_ids = [link.raw_asset_id for link in links if link.asset_role is AssetRole.PRIMARY_PDF]
            if len(primary_ids) != 1:
                raise NormalizationError("work version must have exactly one primary PDF")
            raw_id = primary_ids[0]
            raw_record = next((record for link, record in self.sources.list_files(work_version_id) if link.raw_asset_id == raw_id), None)
            if raw_record is None or raw_record.media_type != "application/pdf":
                raise NormalizationError("primary PDF link is invalid")
            if parser is None or parser != parsed.parser_artifact or parser.kind != "mineru_parser" or parser.work_version_id != work_version_id or parser.raw_asset_id != raw_id:
                raise NormalizationError("parser artifact does not match the accepted primary PDF")
            if parsing_run is None or parsing_run != parsed.run or parsing_run.state.value != "succeeded" or parsing_run.stage.value != "parsing" or parsing_run.work_version_id != work_version_id:
                raise NormalizationError("MinerU parsing run is not a succeeded run for this work version")
            run_details = json.loads(parsing_run.details_json or "{}")
            if not isinstance(run_details, dict):
                raise NormalizationError("MinerU parsing run lineage is invalid")
            parser_parameters = run_details.get("parameters")
            if (
                run_details.get("producer") != "mineru"
                or run_details.get("producer_version") != "3.4.4"
                or not isinstance(parser_parameters, dict)
                or parser_parameters.get("service_version") != "3.4.4"
                or parser_parameters.get("api_protocol") != 2
                or parser_parameters.get("backend") != "vlm-engine"
                or not isinstance(parser_parameters.get("model"), str)
                or run_details.get("parameters_sha256") != canonical_sha256(parser_parameters)
                or run_details.get("input_raw_asset_ids") != [raw_id]
                or run_details.get("input_artifact_ids") != []
            ):
                raise NormalizationError("MinerU parsing run lineage is invalid")
            pdf = self.raw_store.read_verified(raw_record.storage_path, raw_record.sha256, raw_record.byte_size, raw_record.byte_size)
            parser_publication = self.derived_store.find_published(parser.kind, parser.id)
            if parser_publication is None or (parser_publication.storage_path, parser_publication.sha256, parser_publication.byte_size) != (parser.storage_path, parser.sha256, parser.byte_size):
                raise NormalizationError("MinerU parser artifact storage is inconsistent")
            manifest_value = json.loads(self.derived_store.read_verified(parser_publication))
            if not isinstance(manifest_value, dict) or set(manifest_value) != {"schema_version", "kind", "processing_run_id", "input_raw_asset_id", "entries", "primary"}:
                raise NormalizationError("MinerU parser manifest is invalid")
            manifest: dict[str, Any] = manifest_value
            if manifest.get("schema_version") != 1 or manifest.get("kind") != "mineru_parser" or manifest.get("processing_run_id") != parsing_run.id or manifest.get("input_raw_asset_id") != raw_id:
                raise NormalizationError("MinerU parser manifest lineage is invalid")
            entries = manifest.get("entries")
            primary = manifest.get("primary")
            if not isinstance(entries, list) or not isinstance(primary, dict) or set(primary) != {"middle", "model", "content_list"} or not all(isinstance(value, str) for value in primary.values()):
                raise NormalizationError("MinerU parser manifest primary entries are invalid")
            paths = tuple(primary.values())
            if len(set(paths)) != 3 or not primary["middle"].lower().endswith("_middle.json") or not primary["model"].lower().endswith("_model.json") or not primary["content_list"].lower().endswith("_content_list.json"):
                raise NormalizationError("MinerU parser manifest primary entries are invalid")
            passed = {record.id: record for record in parsed.supporting_artifacts}
            if len(passed) != len(parsed.supporting_artifacts):
                raise NormalizationError("MinerU supporting artifacts contain duplicate identities")
            stored_payloads: dict[str, bytes] = {}
            manifest_ids: set[str] = set()
            manifest_paths: set[str] = set()
            for item_value in entries:
                if not isinstance(item_value, dict) or set(item_value) != {"artifact_id", "path", "media_type", "sha256", "byte_size"}:
                    raise NormalizationError("MinerU parser manifest entries are invalid")
                item: dict[str, Any] = item_value
                artifact_id, path = item["artifact_id"], item["path"]
                if not isinstance(artifact_id, str) or not isinstance(path, str) or artifact_id in manifest_ids or path in manifest_paths:
                    raise NormalizationError("MinerU parser manifest entries are invalid")
                manifest_ids.add(artifact_id)
                manifest_paths.add(path)
                passed_record = passed.get(artifact_id)
                catalog_record = self.artifacts.get(artifact_id)
                if passed_record is None or catalog_record is None or catalog_record != passed_record:
                    raise NormalizationError("MinerU supporting artifact does not match the catalog")
                if catalog_record.kind != "mineru_parser_entry" or catalog_record.work_version_id != work_version_id or catalog_record.raw_asset_id != raw_id:
                    raise NormalizationError("MinerU supporting artifact lineage is invalid")
                if (item.get("media_type"), item.get("sha256"), item.get("byte_size")) != (catalog_record.media_type, catalog_record.sha256, catalog_record.byte_size):
                    raise NormalizationError("MinerU parser manifest entry metadata is inconsistent")
                publication = self.derived_store.find_published(catalog_record.kind, catalog_record.id)
                if publication is None or (publication.storage_path, publication.sha256, publication.byte_size) != (catalog_record.storage_path, catalog_record.sha256, catalog_record.byte_size):
                    raise NormalizationError("MinerU parser entry storage is inconsistent")
                payload = self.derived_store.read_verified(publication)
                if hashlib.sha256(payload).hexdigest() != catalog_record.sha256 or len(payload) != catalog_record.byte_size:
                    raise NormalizationError("MinerU parser entry bytes are inconsistent")
                stored_payloads[path] = payload
            required_paths = {
                "middle": {path for path in manifest_paths if path.lower().endswith("_middle.json")},
                "model": {path for path in manifest_paths if path.lower().endswith("_model.json")},
                "content_list": {path for path in manifest_paths if path.lower().endswith("_content_list.json")},
            }
            if (
                manifest_ids != set(passed)
                or any(required_paths[key] != {primary[key]} for key in required_paths)
            ):
                raise NormalizationError("MinerU parser manifest entries are incomplete")
            output_ids = run_details.get("output_artifact_ids")
            if not isinstance(output_ids, list) or len(output_ids) != len(set(output_ids)) or set(output_ids) != {parser.id, *manifest_ids}:
                raise NormalizationError("MinerU parsing run outputs are incomplete")
            middle_value = json.loads(stored_payloads[primary["middle"]])
            if not isinstance(middle_value, dict) or middle_value.get("_backend") != "vlm":
                raise NormalizationError("MinerU middle JSON is not a VLM result")
            middle: dict[str, Any] = middle_value
            return _VerifiedInputs(pdf, middle, parser, parsing_run, run_details)
        except NormalizationError:
            raise
        except Exception as error:
            raise NormalizationError("MinerU parser artifact state is invalid") from error

    def _build(self, verified: _VerifiedInputs) -> MinerUSourceMap:
        geometry = _pdf_geometry(verified.pdf)
        middle = verified.middle
        pages = middle.get("pdf_info")
        if not isinstance(pages, list) or len(pages) != len(geometry):
            raise NormalizationError("MinerU page count does not match the accepted PDF")
        parser = verified.parser
        source_key = {"raw_asset_id": parser.raw_asset_id, "raw_asset_sha256": hashlib.sha256(verified.pdf).hexdigest(), "parser_artifact_id": parser.id, "parser_artifact_sha256": parser.sha256, "schema_version": MINERU_SOURCE_MAP_SCHEMA_VERSION}
        artifact_id = stable_derivation_id(MINERU_SOURCE_MAP_KIND, source_key)
        units: list[PdfSourceUnit] = []
        evidence: list[PdfEvidenceLocator] = []
        document_offset = 0
        for index, page_value in enumerate(pages):
            if not isinstance(page_value, dict) or page_value.get("page_idx") != index:
                raise NormalizationError("MinerU page index does not match the accepted PDF")
            size = page_value.get("page_size")
            if not isinstance(size, list) or len(size) != 2 or any(not isinstance(value, (int, float)) or isinstance(value, bool) for value in size):
                raise NormalizationError("MinerU page size is invalid")
            page = geometry[index]
            if abs(float(size[0]) - page.width) > PAGE_SIZE_TOLERANCE or abs(float(size[1]) - page.height) > PAGE_SIZE_TOLERANCE:
                raise NormalizationError("MinerU page size does not match the accepted PDF")
            for path, span in _span_items(page_value.get("para_blocks"), f"/pdf_info/{index}/para_blocks"):
                text = _text(span)
                if text is None or text == "":
                    continue
                box = _bbox(span.get("bbox"), page)
                ordinal = len(units)
                unit_id = stable_derivation_id("mineru_pdf_source_unit", {**source_key, "path": path, "text": text, "bbox": box.to_list()})
                unit = PdfSourceUnit(unit_id, parser.raw_asset_id, ordinal, index, path, box, text, 0, len(text), document_offset, document_offset + len(text), "mineru_vlm")
                evidence_id = stable_derivation_id("mineru_pdf_evidence", {"source_map_artifact_id": artifact_id, "source_unit_id": unit_id})
                locator = PdfEvidenceLocator(evidence_id, unit.raw_asset_id, source_key["raw_asset_sha256"], parser.id, artifact_id, unit_id, index, path, box, 0, len(text), document_offset, document_offset + len(text))
                units.append(unit)
                evidence.append(locator)
                document_offset += len(text)
        if not units:
            raise NormalizationError("MinerU source map contains no textual source units")
        return MinerUSourceMap(artifact_id, parser.raw_asset_id, source_key["raw_asset_sha256"], parser.id, parser.sha256, verified.parsing_run.id, geometry, tuple(units), tuple(evidence))

    def _load_success(self, run: ProcessingRunRecord) -> MinerUSourceMapResult:
        try:
            details_value = json.loads(run.details_json or "{}")
            if not isinstance(details_value, dict):
                raise NormalizationError("successful MinerU source-map run has invalid details")
            details: dict[str, Any] = details_value
            parameters = details.get("parameters")
            expected_parameter_keys = {"schema_version", "geometry_tolerance", "parser_configuration_sha256"}
            if (
                run.state.value != "succeeded"
                or run.stage.value != "normalization"
                or details.get("work_version_id") != run.work_version_id
                or details.get("stage") != "normalization"
                or details.get("producer") != MINERU_SOURCE_MAP_PRODUCER
                or details.get("producer_version") != MINERU_SOURCE_MAP_PRODUCER_VERSION
                or not isinstance(parameters, dict)
                or set(parameters) != expected_parameter_keys
                or parameters.get("schema_version") != MINERU_SOURCE_MAP_SCHEMA_VERSION
                or parameters.get("geometry_tolerance") != PAGE_SIZE_TOLERANCE
                or not isinstance(parameters.get("parser_configuration_sha256"), str)
                or details.get("parameters_sha256") != canonical_sha256(parameters)
            ):
                raise NormalizationError("successful MinerU source-map run lineage is invalid")
            ids = details.get("output_artifact_ids")
            input_raw_ids = details.get("input_raw_asset_ids")
            input_artifact_ids = details.get("input_artifact_ids")
            if not isinstance(ids, list) or len(ids) != 1 or not isinstance(input_raw_ids, list) or len(input_raw_ids) != 1 or not isinstance(input_artifact_ids, list) or len(input_artifact_ids) != 1:
                raise NormalizationError("successful MinerU source-map run has invalid inputs or outputs")
            if (run.input_raw_asset_id, run.input_artifact_id, run.output_artifact_id) != (input_raw_ids[0], input_artifact_ids[0], ids[0]):
                raise NormalizationError("successful MinerU source-map run record is inconsistent")
            record = self.artifacts.get(ids[0])
            parser = self.artifacts.get(input_artifact_ids[0])
            if (
                record is None or parser is None
                or record.kind != MINERU_SOURCE_MAP_KIND
                or record.schema_version != MINERU_SOURCE_MAP_SCHEMA_VERSION
                or record.media_type != MINERU_SOURCE_MAP_MEDIA_TYPE
                or record.work_version_id != run.work_version_id
                or record.raw_asset_id != input_raw_ids[0]
                or parser.kind != "mineru_parser"
                or parser.work_version_id != run.work_version_id
                or parser.raw_asset_id != record.raw_asset_id
            ):
                raise NormalizationError("successful MinerU source-map artifact lineage is invalid")
            publication = self.derived_store.find_published(record.kind, record.id)
            if publication is None or (publication.storage_path, publication.sha256, publication.byte_size) != (record.storage_path, record.sha256, record.byte_size):
                raise NormalizationError("MinerU source-map catalog and storage conflict")
            source_map = _source_map_from_dict(json.loads(self.derived_store.read_verified(publication)))
            provenance_value = json.loads(record.provenance_json)
            if not isinstance(provenance_value, dict):
                raise NormalizationError("MinerU source-map provenance is invalid")
            provenance: dict[str, Any] = provenance_value
            parser_configuration = provenance.get("parser_configuration")
            parsing_run = self.runs.get(source_map.parsing_run_id)
            parser_provenance_value = json.loads(parser.provenance_json)
            parsing_details_value = None if parsing_run is None else json.loads(parsing_run.details_json or "{}")
            if (
                provenance.get("normalization_run_id") != run.id
                or provenance.get("input_raw_asset_id") != record.raw_asset_id
                or provenance.get("input_raw_asset_sha256") != source_map.raw_asset_sha256
                or provenance.get("parser_artifact_id") != parser.id
                or provenance.get("parser_artifact_sha256") != parser.sha256
                or provenance.get("parsing_run_id") != source_map.parsing_run_id
                or provenance.get("source_map_schema_version") != MINERU_SOURCE_MAP_SCHEMA_VERSION
                or provenance.get("source_map_artifact_sha256") != record.sha256
                or provenance.get("parser_configuration_sha256") != parameters["parser_configuration_sha256"]
                or provenance.get("service_version") != "3.4.4"
                or provenance.get("api_protocol") != 2
                or provenance.get("backend") != "vlm-engine"
                or provenance.get("model_identity") != "operator_attested"
                or not isinstance(parser_configuration, dict)
                or canonical_sha256(parser_configuration) != provenance.get("parser_configuration_sha256")
                or provenance.get("model") != parser_configuration.get("model")
                or parsing_run is None
                or parsing_run.state.value != "succeeded"
                or parsing_run.stage.value != "parsing"
                or parsing_run.work_version_id != run.work_version_id
                or not isinstance(parser_provenance_value, dict)
                or parser_provenance_value.get("processing_run_id") != parsing_run.id
                or parser_provenance_value.get("input_raw_asset_id") != record.raw_asset_id
                or not isinstance(parsing_details_value, dict)
                or parser.id not in parsing_details_value.get("output_artifact_ids", [])
            ):
                raise NormalizationError("MinerU source-map provenance lineage is invalid")
            if (
                source_map.artifact_id != record.id
                or source_map.raw_asset_id != record.raw_asset_id
                or source_map.parser_artifact_id != parser.id
                or source_map.parser_artifact_sha256 != parser.sha256
            ):
                raise NormalizationError("MinerU source-map identity is invalid")
            return MinerUSourceMapResult(run, record, source_map)
        except NormalizationError:
            raise
        except Exception as error:
            raise NormalizationError("successful MinerU source-map replay state is invalid") from error

    def run(self, work_version_id: str, parsed: MinerUParsingResult) -> MinerUSourceMapResult:
        verified = self._validate_inputs(work_version_id, parsed)
        parameters = {"schema_version": MINERU_SOURCE_MAP_SCHEMA_VERSION, "geometry_tolerance": PAGE_SIZE_TOLERANCE, "parser_configuration_sha256": verified.parsing_details["parameters_sha256"]}
        run = self.runs.claim_or_resume(work_version_id, "normalization", MINERU_SOURCE_MAP_PRODUCER, MINERU_SOURCE_MAP_PRODUCER_VERSION, parameters, input_raw_asset_ids=(verified.parser.raw_asset_id,), input_artifact_ids=(verified.parser.id,))
        with self.derived_store.run_lock(run.id):
            current = self.runs.get(run.id)
            if current is None:
                raise NormalizationError("MinerU source-map run is missing")
            if current.state.value == "succeeded":
                return self._load_success(current)
            try:
                source_map = self._build(verified)
                payload = canonical_json_bytes(source_map.to_dict())
                publication = self.derived_store.publish_bytes(MINERU_SOURCE_MAP_KIND, source_map.artifact_id, payload)
                parser_parameters = verified.parsing_details.get("parameters")
                provenance = {"service_version": "3.4.4", "api_protocol": 2, "backend": "vlm-engine", "model": parser_parameters.get("model") if isinstance(parser_parameters, dict) else None, "model_identity": "operator_attested", "parser_configuration": parser_parameters, "parser_configuration_sha256": canonical_sha256(parser_parameters), "input_raw_asset_id": source_map.raw_asset_id, "input_raw_asset_sha256": source_map.raw_asset_sha256, "parser_artifact_id": source_map.parser_artifact_id, "parser_artifact_sha256": source_map.parser_artifact_sha256, "parsing_run_id": source_map.parsing_run_id, "normalization_run_id": current.id, "source_map_schema_version": MINERU_SOURCE_MAP_SCHEMA_VERSION, "source_map_artifact_sha256": publication.sha256}
                registered = self.artifacts.register_pair_after_publication(work_version_id, source_map.raw_asset_id, (ArtifactRegistration(source_map.artifact_id, MINERU_SOURCE_MAP_KIND, MINERU_SOURCE_MAP_SCHEMA_VERSION, publication.storage_path, publication.sha256, MINERU_SOURCE_MAP_MEDIA_TYPE, publication.byte_size, provenance),))[0]
                succeeded = self.runs.succeed(current.id, output_artifact_ids=(registered.id,))
                return MinerUSourceMapResult(succeeded, registered, source_map)
            except Exception as error:
                latest = self.runs.get(current.id)
                if latest is not None and latest.state.value == "active":
                    self.runs.fail(current.id, "mineru_source_map_failed", str(error))
                raise


def _source_map_from_dict(value: object) -> MinerUSourceMap:
    top_fields = {"schema_version", "kind", "artifact_id", "raw_asset_id", "raw_asset_sha256", "parser_artifact_id", "parser_artifact_sha256", "parsing_run_id", "page_geometry", "source_units", "evidence"}
    page_fields = {"page_index", "width", "height"}
    unit_fields = {"unit_id", "raw_asset_id", "ordinal", "page_index", "structural_span_path", "bbox", "text", "source_start", "source_end", "document_start", "document_end", "extraction_method"}
    evidence_fields = {"evidence_id", "raw_asset_id", "raw_asset_sha256", "parser_artifact_id", "source_map_artifact_id", "source_unit_id", "page_index", "structural_span_path", "bbox", "source_start", "source_end", "document_start", "document_end"}
    if not isinstance(value, dict) or set(value) != top_fields or value.get("schema_version") != MINERU_SOURCE_MAP_SCHEMA_VERSION or value.get("kind") != MINERU_SOURCE_MAP_KIND:
        raise NormalizationError("MinerU source-map payload is invalid")
    try:
        page_values, unit_values, evidence_values = value["page_geometry"], value["source_units"], value["evidence"]
        if not isinstance(page_values, list) or not isinstance(unit_values, list) or not isinstance(evidence_values, list):
            raise ValueError("source-map collections must be lists")
        if not all(isinstance(item, dict) and set(item) == page_fields for item in page_values):
            raise ValueError("invalid page geometry entry")
        if not all(isinstance(item, dict) and set(item) == unit_fields and isinstance(item.get("bbox"), list) and len(item["bbox"]) == 4 for item in unit_values):
            raise ValueError("invalid source unit entry")
        if not all(isinstance(item, dict) and set(item) == evidence_fields and isinstance(item.get("bbox"), list) and len(item["bbox"]) == 4 for item in evidence_values):
            raise ValueError("invalid evidence entry")
        pages = tuple(PdfPageGeometry(**item) for item in page_values)
        units = tuple(PdfSourceUnit(**{**item, "bbox": PdfBoundingBox(*item["bbox"])}) for item in unit_values)
        evidence = tuple(PdfEvidenceLocator(**{**item, "bbox": PdfBoundingBox(*item["bbox"])}) for item in evidence_values)
        return MinerUSourceMap(value["artifact_id"], value["raw_asset_id"], value["raw_asset_sha256"], value["parser_artifact_id"], value["parser_artifact_sha256"], value["parsing_run_id"], pages, units, evidence)
    except Exception as error:
        raise NormalizationError("MinerU source-map payload is invalid") from error


__all__ = ("MINERU_SOURCE_MAP_KIND", "MINERU_SOURCE_MAP_MEDIA_TYPE", "MinerUSourceMap", "MinerUSourceMapResult", "MinerUSourceMapService")
