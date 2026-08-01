"""Validated primary-PDF analysis, immutable publication, and replay."""

from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Any, Mapping

from sqlalchemy import select

from sciretriever.catalog import ArtifactRegistration, ArtifactRepository, AssetRepository, CurrentAnalysisRepository, NormalizedArtifactRecord, ProcessingRunRecord, ProcessingRunRepository
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import identifiers, publishers, raw_assets, tags, venues
from sciretriever.core.contracts import Identifier
from sciretriever.core.derivation import canonical_json_bytes, canonical_sha256, stable_derivation_id
from sciretriever.core.enums import AssetRole, ProcessingStage
from sciretriever.core.ids import validate_uuid
from sciretriever.errors import AnalysisError
from sciretriever.normalization import MinerUSourceMapResult, PdfEvidenceLocator
from sciretriever.storage import DerivedArtifactStore

from .contracts import AnalysisDocument, AnalysisProviderRequest, AnalysisReference, AnalysisSection, CanonicalFieldProposal, GeneratedTag, NewEntityProposal, NewTagProposal, SECTION_IDS
from .provider import AnalysisProvider


ANALYSIS_KIND = "analysis"
ANALYSIS_SCHEMA_VERSION = "1"
ANALYSIS_MEDIA_TYPE = "application/vnd.sciretriever.analysis.v1+json"
ANALYSIS_PRODUCER = "sciretriever.analysis"
ANALYSIS_PRODUCER_VERSION = "1"


@dataclass(frozen=True, slots=True)
class AnalysisResult:
    run: ProcessingRunRecord
    artifact: NormalizedArtifactRecord
    document: AnalysisDocument


def analysis_response_schema() -> dict[str, object]:
    evidence = {"type": "array", "items": {"type": "string", "format": "uuid"}, "uniqueItems": True}
    section = {"type": "object", "additionalProperties": False,
               "required": ["section_id", "heading", "content", "insufficient_evidence", "evidence_ids"],
               "properties": {"section_id": {"type": "string", "enum": list(SECTION_IDS)},
                              "heading": {"type": "string", "minLength": 1}, "content": {"type": "string", "minLength": 1},
                              "insufficient_evidence": {"type": "boolean"}, "evidence_ids": evidence}}
    return {"type": "object", "additionalProperties": False,
            "required": ["sections", "canonical_fields", "references", "generated_tags", "new_tag_proposals", "new_entity_proposals"],
            "properties": {
                "sections": {"type": "array", "minItems": 10, "maxItems": 10, "items": section},
                "canonical_fields": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                    "required": ["field_name", "value", "evidence_ids"], "properties": {
                        "field_name": {"type": "string"}, "value": {"anyOf": [{"type": "string"}, {"type": "integer"}]}, "evidence_ids": evidence}}},
                "references": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                    "required": ["order", "raw_reference", "resolved_work_id", "identifier_namespace", "identifier_value", "evidence_ids"],
                    "properties": {"order": {"type": "integer", "minimum": 0},
                        "raw_reference": {"type": "string", "minLength": 1}, "resolved_work_id": {"type": ["string", "null"]},
                        "identifier_namespace": {"type": ["string", "null"]}, "identifier_value": {"type": ["string", "null"]}, "evidence_ids": evidence}}},
                "generated_tags": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                    "required": ["tag_id", "evidence_ids"], "properties": {"tag_id": {"type": "string", "format": "uuid"}, "evidence_ids": evidence}}},
                "new_tag_proposals": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                    "required": ["canonical_name", "definition", "aliases"], "properties": {"canonical_name": {"type": "string"},
                        "definition": {"type": "string"}, "aliases": {"type": "array", "items": {"type": "string"}}}}},
                "new_entity_proposals": {"type": "array", "items": {"type": "object", "additionalProperties": False,
                    "required": ["entity_type", "canonical_name"], "properties": {"entity_type": {"type": "string", "enum": ["publisher", "venue"]},
                        "canonical_name": {"type": "string"}}}}}}


def _exact(value: object, fields: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != fields:
        raise AnalysisError(f"{name} has invalid or unknown fields")
    return value


def _tuple_strings(value: object, name: str) -> tuple[str, ...]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise AnalysisError(f"{name} must be a string array")
    return tuple(value)


def _reference_identifier(namespace: object, value: object) -> Identifier | None:
    if namespace is None and value is None:
        return None
    if not isinstance(namespace, str) or not isinstance(value, str):
        raise ValueError("reference identifier namespace and value must be paired strings")
    identifier = Identifier(namespace, value)
    if identifier.namespace not in {"doi", "arxiv", "pmid", "pmcid", "isbn", "issn"}:
        raise ValueError("unsupported reference identifier namespace")
    validators = {
        "doi": r"10\.\d{1,9}/\S+", "arxiv": r"(?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?",
        "pmid": r"\d+", "pmcid": r"PMC\d+", "isbn": r"(?:\d[ -]?){9,12}[\dXx]", "issn": r"\d{4}-?\d{3}[\dXx]",
    }
    flags = re.IGNORECASE if identifier.namespace in {"arxiv", "pmcid"} else 0
    if re.fullmatch(validators[identifier.namespace], identifier.value, flags) is None:
        raise ValueError(f"malformed {identifier.namespace} identifier")
    return identifier


def parse_analysis_response(content: str, *, source_map_artifact_id: str,
                            evidence_locators: Mapping[str, PdfEvidenceLocator], tag_ids: frozenset[str],
                            publisher_ids: frozenset[str], venue_ids: frozenset[str],
                            resolved_identifiers: Mapping[tuple[str, str], str]) -> AnalysisDocument:
    try:
        root = _exact(json.loads(content), {"sections", "canonical_fields", "references", "generated_tags", "new_tag_proposals", "new_entity_proposals"}, "analysis response")
        if not all(isinstance(root[name], list) for name in root):
            raise AnalysisError("analysis response collections must be arrays")
        sections = tuple(AnalysisSection(
            section_id=item["section_id"], heading=item["heading"], content=item["content"],
            insufficient_evidence=item["insufficient_evidence"], evidence_ids=_tuple_strings(item["evidence_ids"], "section evidence_ids"),
        ) for value in root["sections"] for item in [_exact(value, {"section_id", "heading", "content", "insufficient_evidence", "evidence_ids"}, "section")])
        fields = tuple(CanonicalFieldProposal(item["field_name"], item["value"], _tuple_strings(item["evidence_ids"], "field evidence_ids"))
                       for value in root["canonical_fields"] for item in [_exact(value, {"field_name", "value", "evidence_ids"}, "canonical field")])
        references_list: list[AnalysisReference] = []
        for value in root["references"]:
            item = _exact(value, {"order", "raw_reference", "resolved_work_id", "identifier_namespace", "identifier_value", "evidence_ids"}, "reference")
            evidence_ids = _tuple_strings(item["evidence_ids"], "reference evidence_ids")
            identifier = _reference_identifier(item["identifier_namespace"], item["identifier_value"])
            raw_reference = " ".join(item["raw_reference"].split()) if isinstance(item["raw_reference"], str) else item["raw_reference"]
            reference_id = stable_derivation_id("analysis_reference", {"source_map_artifact_id": source_map_artifact_id,
                "order": item["order"], "raw_reference": raw_reference,
                "identifier": None if identifier is None else identifier.to_dict(), "evidence_ids": sorted(evidence_ids)})
            references_list.append(AnalysisReference(reference_id, item["order"], raw_reference, item["resolved_work_id"],
                None if identifier is None else identifier.namespace, None if identifier is None else identifier.value, evidence_ids))
        references = tuple(references_list)
        generated = tuple(GeneratedTag(item["tag_id"], _tuple_strings(item["evidence_ids"], "generated tag evidence_ids"))
                          for value in root["generated_tags"] for item in [_exact(value, {"tag_id", "evidence_ids"}, "generated tag")])
        new_tags = tuple(NewTagProposal(item["canonical_name"], item["definition"], _tuple_strings(item["aliases"], "aliases"))
                         for value in root["new_tag_proposals"] for item in [_exact(value, {"canonical_name", "definition", "aliases"}, "new tag proposal")])
        new_entities = tuple(NewEntityProposal(item["entity_type"], item["canonical_name"])
                             for value in root["new_entity_proposals"] for item in [_exact(value, {"entity_type", "canonical_name"}, "new entity proposal")])
        used = {evidence for section in sections for evidence in section.evidence_ids}
        used.update(evidence for field in fields for evidence in field.evidence_ids)
        used.update(evidence for reference in references for evidence in reference.evidence_ids)
        used.update(evidence for tag in generated for evidence in tag.evidence_ids)
        if not used.issubset(evidence_locators):
            raise AnalysisError("analysis response contains evidence outside the validated primary PDF")
        locators = tuple(locator for evidence_id, locator in evidence_locators.items() if evidence_id in used)
        document = AnalysisDocument(sections, fields, references, generated, new_tags, new_entities, locators)
    except AnalysisError:
        raise
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise AnalysisError(f"analysis response validation failed: {error}") from None
    if not {item.tag_id for item in document.generated_tags}.issubset(tag_ids):
        raise AnalysisError("analysis response contains an unknown tag ID")
    for field in document.canonical_fields:
        if field.field_name == "publisher_id" and field.value not in publisher_ids:
            raise AnalysisError("analysis response contains an unknown publisher ID")
        if field.field_name == "venue_id" and field.value not in venue_ids:
            raise AnalysisError("analysis response contains an unknown venue ID")
    for reference in document.references:
        if reference.resolved_work_id is not None:
            if reference.identifier_namespace is None or resolved_identifiers.get((reference.identifier_namespace, reference.identifier_value or "")) != reference.resolved_work_id:
                raise AnalysisError("resolved reference is not supported by a catalog identifier")
    return document


class AnalysisService:
    def __init__(self, catalog: CatalogEngine, derived_store: DerivedArtifactStore, provider: AnalysisProvider,
                 *, max_input_characters: int = 200_000, max_source_units: int = 5_000, max_completion_tokens: int = 8_000,
                 configuration: Mapping[str, object] | None = None) -> None:
        if any(type(value) is not int or value <= 0 for value in (max_input_characters, max_source_units, max_completion_tokens)):
            raise ValueError("analysis bounds must be positive integers")
        self.catalog = catalog
        self.store = derived_store
        self.provider = provider
        self.artifacts = ArtifactRepository(catalog)
        self.assets = AssetRepository(catalog)
        self.runs = ProcessingRunRepository(catalog)
        self.current = CurrentAnalysisRepository(catalog)
        self.max_input_characters = max_input_characters
        self.max_source_units = max_source_units
        self.max_completion_tokens = max_completion_tokens
        self.configuration = dict(configuration or {})
        if not isinstance(provider.provider_name, str) or not provider.provider_name.strip() or not isinstance(provider.model, str) or not provider.model.strip():
            raise ValueError("analysis provider name and model must be non-blank")

    def _validated_input(
        self, work_version_id: str, source: MinerUSourceMapResult
    ) -> tuple[str, dict[str, object], frozenset[str]]:
        validate_uuid(work_version_id, "work_version_id")
        source_map = source.source_map
        artifact = self.artifacts.get(source.artifact.id)
        parser_artifact = self.artifacts.get(source_map.parser_artifact_id)
        stored_run = self.runs.get(source.run.id)
        links = self.assets.get_work_version_assets(work_version_id)
        primary = [item.raw_asset_id for item in links if item.asset_role is AssetRole.PRIMARY_PDF]
        publication = self.store.find_published(source.artifact.kind, source.artifact.id)
        parser_publication = self.store.find_published("mineru_parser", source_map.parser_artifact_id)
        with self.catalog.connect() as connection:
            raw_record = connection.execute(select(raw_assets).where(raw_assets.c.id == source_map.raw_asset_id)).mappings().one_or_none()
        expected_payload = canonical_json_bytes(source_map.to_dict())
        try:
            run_details = json.loads(source.run.details_json or "{}")
            artifact_provenance = json.loads(source.artifact.provenance_json)
        except (TypeError, ValueError) as error:
            raise AnalysisError("source-map lineage metadata is invalid") from error
        run_fields = {"work_version_id", "stage", "producer", "producer_version", "parameters", "input_raw_asset_ids",
                      "input_artifact_ids", "parameters_sha256", "output_artifact_ids"}
        parameters = run_details.get("parameters") if isinstance(run_details, dict) else None
        source_parameter_fields = {"schema_version", "geometry_tolerance", "parser_configuration_sha256"}
        source_provenance_fields = {"service_version", "api_protocol", "backend", "model", "model_identity",
            "parser_configuration", "parser_configuration_sha256", "input_raw_asset_id", "input_raw_asset_sha256",
            "parser_artifact_id", "parser_artifact_sha256", "parsing_run_id", "normalization_run_id",
            "source_map_schema_version", "source_map_artifact_sha256"}
        if (len(primary) != 1 or primary[0] != source_map.raw_asset_id or artifact != source.artifact or stored_run != source.run
                or source.artifact.kind != "mineru_source_map" or source.artifact.work_version_id != work_version_id
                or source.artifact.schema_version != "1" or source.artifact.media_type != "application/vnd.sciretriever.mineru-source-map.v1+json"
                or source.run.state.value != "succeeded" or source.run.stage.value != "normalization"
                or not isinstance(run_details, dict) or set(run_details) != run_fields
                or run_details.get("work_version_id") != work_version_id or run_details.get("stage") != "normalization"
                or run_details.get("producer") != "sciretriever.mineru_source_map" or run_details.get("producer_version") != "1"
                or not isinstance(parameters, dict) or set(parameters) != source_parameter_fields
                or parameters.get("schema_version") != "1" or run_details.get("parameters_sha256") != canonical_sha256(parameters)
                or run_details.get("input_raw_asset_ids") != [source_map.raw_asset_id]
                or run_details.get("input_artifact_ids") != [source_map.parser_artifact_id]
                or run_details.get("output_artifact_ids") != [source.artifact.id]
                or (source.run.input_raw_asset_id, source.run.input_artifact_id, source.run.output_artifact_id)
                    != (source_map.raw_asset_id, source_map.parser_artifact_id, source.artifact.id)
                or not isinstance(artifact_provenance, dict) or set(artifact_provenance) != source_provenance_fields
                or artifact_provenance.get("input_raw_asset_id") != source_map.raw_asset_id
                or artifact_provenance.get("input_raw_asset_sha256") != source_map.raw_asset_sha256
                or artifact_provenance.get("parser_artifact_id") != source_map.parser_artifact_id
                or artifact_provenance.get("parser_artifact_sha256") != source_map.parser_artifact_sha256
                or artifact_provenance.get("source_map_artifact_sha256") != source.artifact.sha256
                or artifact_provenance.get("normalization_run_id") != source.run.id
                or artifact_provenance.get("source_map_schema_version") != "1"
                or parser_artifact is None or parser_artifact.kind != "mineru_parser"
                or parser_artifact.work_version_id != work_version_id or parser_artifact.raw_asset_id != source_map.raw_asset_id
                or parser_artifact.sha256 != source_map.parser_artifact_sha256
                or parser_publication is None
                or (parser_publication.storage_path, parser_publication.sha256, parser_publication.byte_size)
                    != (parser_artifact.storage_path, parser_artifact.sha256, parser_artifact.byte_size)
                or raw_record is None or raw_record["media_type"] != "application/pdf"
                or raw_record["sha256"] != source_map.raw_asset_sha256
                or publication is None or (publication.sha256, publication.byte_size, publication.storage_path) != (artifact.sha256, artifact.byte_size, artifact.storage_path)
                or self.store.read_verified(publication) != expected_payload):
            raise AnalysisError("analysis requires a validated immutable primary-PDF MinerU source map")
        units = source_map.source_units[:self.max_source_units]
        input_units: list[dict[str, object]] = []
        characters = 0
        evidence_by_unit = {item.source_unit_id: item for item in source_map.evidence}
        for unit in units:
            if characters + len(unit.text) > self.max_input_characters:
                break
            locator = evidence_by_unit[unit.unit_id]
            input_units.append({"evidence_id": locator.evidence_id, "source_unit_id": unit.unit_id,
                                "page_index": unit.page_index, "structural_span_path": unit.structural_span_path,
                                "bbox": unit.bbox.to_list(), "text": unit.text})
            characters += len(unit.text)
        if not input_units:
            raise AnalysisError("validated primary PDF has no source units within analysis bounds")
        registry = self._registry()
        prompt_input = {"schema_version": ANALYSIS_SCHEMA_VERSION, "source_map_artifact_id": source.artifact.id,
                        "raw_asset_id": source_map.raw_asset_id, "raw_asset_sha256": source_map.raw_asset_sha256,
                        "required_section_ids": list(SECTION_IDS), "source_units": input_units,
                        "allowed_tags": registry["tags"], "allowed_publishers": registry["publishers"], "allowed_venues": registry["venues"]}
        return (
            json.dumps(
                prompt_input,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            ),
            registry,
            frozenset(str(item["evidence_id"]) for item in input_units),
        )

    def _registry(self) -> dict[str, Any]:
        with self.catalog.connect() as connection:
            return {"tags": [dict(row._mapping) for row in connection.execute(select(tags.c.id, tags.c.canonical_name).order_by(tags.c.id))],
                    "publishers": [dict(row._mapping) for row in connection.execute(select(publishers.c.id, publishers.c.canonical_name).order_by(publishers.c.id))],
                    "venues": [dict(row._mapping) for row in connection.execute(select(venues.c.id, venues.c.canonical_name).order_by(venues.c.id))],
                    "resolved": {(row.namespace, row.value): row.work_id for row in connection.execute(select(identifiers.c.namespace, identifiers.c.value, identifiers.c.work_id))}}

    @staticmethod
    def _system_prompt() -> str:
        return ("Analyze only the supplied primary-PDF source units. Preserve the document language in headings and content. "
                "Use Markdown where useful. Never invent facts. For insufficient evidence, set insufficient_evidence true and say so explicitly. "
                "Every promoted section, canonical field, and reference must cite supplied evidence IDs. Select only supplied registry IDs; "
                "put unknown tags, publishers, or venues in proposal arrays.")

    def _parse(
        self,
        content: str,
        source: MinerUSourceMapResult,
        registry: dict[str, Any],
        allowed_evidence_ids: frozenset[str],
    ) -> AnalysisDocument:
        return parse_analysis_response(content,
            source_map_artifact_id=source.artifact.id,
            evidence_locators={
                item.evidence_id: item
                for item in source.source_map.evidence
                if item.evidence_id in allowed_evidence_ids
            },
            tag_ids=frozenset(item["id"] for item in registry["tags"]),
            publisher_ids=frozenset(item["id"] for item in registry["publishers"]),
            venue_ids=frozenset(item["id"] for item in registry["venues"]), resolved_identifiers=registry["resolved"])

    def _parse_stored_document(
        self,
        value: object,
        source: MinerUSourceMapResult,
        registry: dict[str, Any],
        allowed_evidence_ids: frozenset[str],
    ) -> AnalysisDocument:
        document = _exact(value, {"sections", "canonical_fields", "references", "generated_tags", "new_tag_proposals", "new_entity_proposals", "evidence"}, "stored analysis document")
        evidence_value = document["evidence"]
        if not isinstance(evidence_value, list):
            raise AnalysisError("stored analysis evidence must be an array")
        expected = {item.evidence_id: item.to_dict() for item in source.source_map.evidence}
        seen: set[str] = set()
        for locator in evidence_value:
            if not isinstance(locator, dict) or not isinstance(locator.get("evidence_id"), str):
                raise AnalysisError("stored analysis evidence locator is invalid")
            evidence_id = locator["evidence_id"]
            if evidence_id in seen or expected.get(evidence_id) != locator:
                raise AnalysisError("stored analysis evidence does not exactly match the immutable source map")
            seen.add(evidence_id)
        stripped: dict[str, object] = {}
        for collection in ("sections", "canonical_fields", "references", "generated_tags"):
            values = document[collection]
            if not isinstance(values, list):
                raise AnalysisError("stored analysis collections must be arrays")
            clean_items: list[dict[str, object]] = []
            for item in values:
                if not isinstance(item, dict) or "locators" not in item:
                    raise AnalysisError("stored promoted analysis value lacks locators")
                evidence_ids = item.get("evidence_ids")
                if not isinstance(evidence_ids, list) or item["locators"] != [expected.get(identifier) for identifier in evidence_ids]:
                    raise AnalysisError("stored promoted locators do not match evidence IDs")
                internal_fields = {"locators", "reference_id"} if collection == "references" else {"locators"}
                clean_items.append({key: item[key] for key in item if key not in internal_fields})
            stripped[collection] = clean_items
        stripped["new_tag_proposals"] = document["new_tag_proposals"]
        stripped["new_entity_proposals"] = document["new_entity_proposals"]
        parsed = self._parse(
            json.dumps(
                stripped,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
                sort_keys=True,
            ),
            source,
            registry,
            allowed_evidence_ids,
        )
        if parsed.to_dict() != document:
            raise AnalysisError("stored analysis document is not the canonical validated representation")
        return parsed

    def _load_success(
        self,
        run: ProcessingRunRecord,
        source: MinerUSourceMapResult,
        registry: dict[str, Any],
        parameters: dict[str, object],
        allowed_evidence_ids: frozenset[str],
    ) -> AnalysisResult:
        try:
            details = json.loads(run.details_json or "{}")
            output_ids = details.get("output_artifact_ids")
            detail_fields = {"work_version_id", "stage", "producer", "producer_version", "parameters", "input_raw_asset_ids",
                             "input_artifact_ids", "parameters_sha256", "output_artifact_ids"}
            if (run.state.value != "succeeded" or run.stage.value != "analysis" or run.work_version_id != source.run.work_version_id
                    or not isinstance(details, dict) or set(details) != detail_fields
                    or details.get("work_version_id") != run.work_version_id or details.get("stage") != "analysis"
                    or details.get("producer") != ANALYSIS_PRODUCER or details.get("producer_version") != ANALYSIS_PRODUCER_VERSION
                    or details.get("parameters") != parameters or details.get("parameters_sha256") != canonical_sha256(parameters)
                    or details.get("input_raw_asset_ids") != [source.source_map.raw_asset_id]
                    or details.get("input_artifact_ids") != [source.artifact.id]
                    or not isinstance(output_ids, list) or len(output_ids) != 1
                    or (run.input_raw_asset_id, run.input_artifact_id, run.output_artifact_id)
                       != (source.source_map.raw_asset_id, source.artifact.id, output_ids[0])):
                raise AnalysisError("successful analysis run lineage is invalid")
            artifact = self.artifacts.get(output_ids[0])
            if (artifact is None or artifact.kind != ANALYSIS_KIND or artifact.schema_version != ANALYSIS_SCHEMA_VERSION
                    or artifact.media_type != ANALYSIS_MEDIA_TYPE or artifact.work_version_id != run.work_version_id
                    or artifact.raw_asset_id != source.source_map.raw_asset_id):
                raise AnalysisError("successful analysis artifact lineage is invalid")
            publication = self.store.find_published(artifact.kind, artifact.id)
            if publication is None or (publication.storage_path, publication.sha256, publication.byte_size) != (artifact.storage_path, artifact.sha256, artifact.byte_size):
                raise AnalysisError("analysis artifact catalog and storage conflict")
            value = _exact(json.loads(self.store.read_verified(publication)), {"schema_version", "kind", "metadata", "document"}, "analysis artifact")
            if value["schema_version"] != ANALYSIS_SCHEMA_VERSION or value["kind"] != ANALYSIS_KIND:
                raise AnalysisError("analysis artifact schema is invalid")
            metadata = _exact(value["metadata"], {"provider", "provider_sha256", "model", "model_sha256",
                                                         "schema_sha256", "configuration_sha256", "input_sha256", "document_sha256"}, "analysis metadata")
            stored_parameters = details.get("parameters")
            parameter_metadata = {name: parameters[name] for name in ("provider", "provider_sha256", "model", "model_sha256",
                "schema_sha256", "configuration_sha256", "input_sha256")}
            if (not isinstance(stored_parameters, dict) or stored_parameters != parameters
                    or {name: metadata[name] for name in parameter_metadata} != parameter_metadata):
                raise AnalysisError("analysis artifact metadata does not match its processing run")
            document = self._parse_stored_document(
                value["document"], source, registry, allowed_evidence_ids
            )
            document_sha256 = canonical_sha256(document.to_dict())
            if metadata["document_sha256"] != document_sha256 or parameters.get("document_hash_algorithm") != "canonical_sha256":
                raise AnalysisError("analysis artifact document hash is invalid")
            expected_artifact_id = stable_derivation_id(ANALYSIS_KIND, {"parameters": parameters,
                "source_map_artifact_id": source.artifact.id, "document_sha256": document_sha256})
            if artifact.id != expected_artifact_id:
                raise AnalysisError("analysis artifact deterministic identity is invalid")
            provenance = json.loads(artifact.provenance_json)
            expected_provenance = {"analysis_run_id": run.id, "provider": parameters["provider"], "model": parameters["model"],
                "schema_version": ANALYSIS_SCHEMA_VERSION, "schema_sha256": parameters["schema_sha256"],
                "provider_sha256": parameters["provider_sha256"], "model_sha256": parameters["model_sha256"],
                "configuration_sha256": parameters["configuration_sha256"], "input_sha256": parameters["input_sha256"],
                "raw_asset_id": source.source_map.raw_asset_id, "raw_asset_sha256": source.source_map.raw_asset_sha256,
                "parser_artifact_id": source.source_map.parser_artifact_id, "parser_artifact_sha256": source.source_map.parser_artifact_sha256,
                "source_map_artifact_id": source.artifact.id, "source_map_artifact_sha256": source.artifact.sha256,
                "document_sha256": document_sha256, "analysis_artifact_sha256": artifact.sha256}
            if provenance != expected_provenance:
                raise AnalysisError("analysis artifact provenance lineage is invalid")
            return AnalysisResult(run, artifact, document)
        except AnalysisError:
            raise
        except Exception as error:
            raise AnalysisError(f"successful analysis replay is invalid: {type(error).__name__}") from None

    def run(self, work_version_id: str, source: MinerUSourceMapResult, *, expected_current_id: str | None = None,
            expected_revision: int = 0, force: bool = False) -> AnalysisResult:
        input_json, registry, allowed_evidence_ids = self._validated_input(
            work_version_id, source
        )
        current_at_start = self.current.get(work_version_id)
        if current_at_start is not None and expected_current_id is None and expected_revision == 0:
            expected_current_id = current_at_start.id
            expected_revision = current_at_start.revision
        parameters: dict[str, object] = {"schema_version": ANALYSIS_SCHEMA_VERSION, "provider": self.provider.provider_name, "model": self.provider.model,
                      "schema_sha256": canonical_sha256(analysis_response_schema()),
                      "provider_sha256": canonical_sha256(self.provider.provider_name),
                      "model_sha256": canonical_sha256(self.provider.model),
                      "configuration_sha256": canonical_sha256(self.configuration), "input_sha256": canonical_sha256(json.loads(input_json)),
                      "document_hash_algorithm": "canonical_sha256",
                      "max_completion_tokens": self.max_completion_tokens}
        matching_current = False
        if current_at_start is not None and not force:
            current_run = self.runs.get(current_at_start.processing_run_id)
            try:
                current_parameters = json.loads(current_run.details_json or "{}").get("parameters") if current_run is not None else None
            except (TypeError, ValueError):
                current_parameters = None
            matching_current = isinstance(current_parameters, dict) and {
                key: value for key, value in current_parameters.items() if key != "target_revision"
            } == parameters
            if not matching_current:
                raise AnalysisError("current analysis reprocessing requires force")
        target_revision = expected_revision if matching_current else expected_revision + 1
        parameters["target_revision"] = target_revision
        run = self.runs.claim_or_resume(work_version_id, ProcessingStage.ANALYSIS, ANALYSIS_PRODUCER, ANALYSIS_PRODUCER_VERSION,
                                        parameters, input_raw_asset_ids=(source.source_map.raw_asset_id,), input_artifact_ids=(source.artifact.id,))
        with self.store.run_lock(run.id):
            current_run = self.runs.get(run.id)
            if current_run is None:
                raise AnalysisError("analysis run is missing")
            if current_run.state.value == "succeeded":
                result = self._load_success(
                    current_run,
                    source,
                    registry,
                    parameters,
                    allowed_evidence_ids,
                )
            else:
                try:
                    response = self.provider.analyze(AnalysisProviderRequest(self._system_prompt(), input_json, analysis_response_schema(), self.max_completion_tokens))
                    if response.provider != self.provider.provider_name or response.model != self.provider.model:
                        raise AnalysisError("analysis provider response identity does not match configuration")
                    document = self._parse(
                        response.content, source, registry, allowed_evidence_ids
                    )
                    document_sha256 = canonical_sha256(document.to_dict())
                    artifact_metadata = {name: parameters[name] for name in ("provider", "provider_sha256", "model", "model_sha256",
                                                                               "schema_sha256", "configuration_sha256", "input_sha256")}
                    artifact_metadata["document_sha256"] = document_sha256
                    payload = canonical_json_bytes({"schema_version": ANALYSIS_SCHEMA_VERSION, "kind": ANALYSIS_KIND,
                                                    "metadata": artifact_metadata, "document": document.to_dict()})
                    artifact_id = stable_derivation_id(ANALYSIS_KIND, {"parameters": parameters, "source_map_artifact_id": source.artifact.id,
                                                                      "document_sha256": document_sha256})
                    publication = self.store.publish_bytes(ANALYSIS_KIND, artifact_id, payload)
                    provenance = {"analysis_run_id": current_run.id, "provider": response.provider, "model": response.model,
                                  "schema_version": ANALYSIS_SCHEMA_VERSION, "schema_sha256": parameters["schema_sha256"],
                                  "provider_sha256": parameters["provider_sha256"], "model_sha256": parameters["model_sha256"],
                                  "configuration_sha256": parameters["configuration_sha256"],
                                  "input_sha256": parameters["input_sha256"], "raw_asset_id": source.source_map.raw_asset_id,
                                  "raw_asset_sha256": source.source_map.raw_asset_sha256, "parser_artifact_id": source.source_map.parser_artifact_id,
                                   "parser_artifact_sha256": source.source_map.parser_artifact_sha256, "source_map_artifact_id": source.artifact.id,
                                   "source_map_artifact_sha256": source.artifact.sha256, "document_sha256": document_sha256,
                                   "analysis_artifact_sha256": publication.sha256}
                    artifact = self.artifacts.register_pair_after_publication(work_version_id, source.source_map.raw_asset_id,
                        (ArtifactRegistration(artifact_id, ANALYSIS_KIND, ANALYSIS_SCHEMA_VERSION, publication.storage_path, publication.sha256,
                                              ANALYSIS_MEDIA_TYPE, publication.byte_size, provenance),))[0]
                    succeeded = self.runs.succeed(current_run.id, output_artifact_ids=(artifact.id,))
                    result = AnalysisResult(succeeded, artifact, document)
                except Exception as error:
                    latest = self.runs.get(current_run.id)
                    if latest is not None and latest.state.value == "active":
                        self.runs.fail(current_run.id, "analysis_failed", str(error))
                    raise
            existing_current = self.current.get(work_version_id)
            if existing_current is not None and existing_current.analysis_artifact_id == result.artifact.id:
                if (existing_current.processing_run_id != result.run.id
                        or existing_current.parser_artifact_id != source.source_map.parser_artifact_id
                        or json.loads(existing_current.content_json) != result.document.to_dict()
                        or json.loads(existing_current.provenance_json) != json.loads(result.artifact.provenance_json)):
                    raise AnalysisError("current analysis content or lineage is inconsistent with replayed artifact")
                return result
            document_value = result.document.to_dict()
            reference_values = document_value["references"]
            if not isinstance(reference_values, list):
                raise AnalysisError("validated analysis references are invalid")
            self.current.replace(work_version_id, result.run.id, source.source_map.parser_artifact_id, result.artifact.id,
                                 document_value, json.loads(result.artifact.provenance_json),
                                 projection={item.field_name: item.value for item in result.document.canonical_fields},
                                 references=tuple(item for item in reference_values if isinstance(item, dict)),
                                 generated_tag_ids=tuple(item.tag_id for item in result.document.generated_tags),
                                 expected_current_id=expected_current_id, expected_revision=expected_revision)
            return result


__all__ = ("ANALYSIS_KIND", "ANALYSIS_MEDIA_TYPE", "ANALYSIS_SCHEMA_VERSION", "AnalysisResult", "AnalysisService",
           "analysis_response_schema", "parse_analysis_response")
