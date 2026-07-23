"""Catalog persistence for generic light structure and citation links."""

from __future__ import annotations

from sqlalchemy import insert, select

from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.models import identifiers, light_structures, version_references
from sciretriever.catalog.records import LightStructureRecord, VersionReferenceRecord
from sciretriever.catalog.repository import _required_text, canonical_json, catalog_operation
from sciretriever.core.contracts import Identifier
from sciretriever.core.derivation import stable_derivation_id
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import utc_now_rfc3339
from sciretriever.core.validation import validate_sha256, validate_token
from sciretriever.errors import CatalogError


class EnrichmentRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        if catalog.read_only:
            raise CatalogError("EnrichmentRepository requires a writable catalog")
        self._catalog = catalog

    def register_result(
        self,
        work_version_id: str,
        normalized_artifact_id: str,
        kind: str,
        schema_version: str,
        input_sha256: str,
        content: object,
    ) -> LightStructureRecord:
        work_version_id = validate_uuid(work_version_id, "work_version_id")
        normalized_artifact_id = validate_uuid(normalized_artifact_id, "normalized_artifact_id")
        kind = validate_token(kind, "kind")
        if kind not in {"summary", "tags"}:
            raise ValueError("light structure kind must be summary or tags")
        schema_version = _required_text(schema_version, "schema_version")
        input_sha256 = validate_sha256(input_sha256, "input_sha256")
        content_json = canonical_json(content)
        key = {"work_version_id": work_version_id, "kind": kind, "schema_version": schema_version, "input_sha256": input_sha256}
        record_id = stable_derivation_id("light_structure_row", key)
        with catalog_operation("light structure registration"):
            with self._catalog.critical_transaction() as connection:
                row = connection.execute(select(light_structures).where(light_structures.c.id == record_id)).mappings().one_or_none()
                if row is not None:
                    if row["normalized_artifact_id"] != normalized_artifact_id or row["content_json"] != content_json:
                        raise CatalogError("light structure replay metadata conflicts")
                    return LightStructureRecord.from_row(row)
                values = {"id": record_id, **key, "normalized_artifact_id": normalized_artifact_id, "content_json": content_json, "created_at": utc_now_rfc3339()}
                connection.execute(insert(light_structures).values(**values))
                return LightStructureRecord.from_row(values)


class CitationRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        if not isinstance(catalog, CatalogEngine):
            raise TypeError("catalog must be a CatalogEngine")
        if catalog.read_only:
            raise CatalogError("CitationRepository requires a writable catalog")
        self._catalog = catalog

    def register_identifier_links(
        self,
        citing_work_version_id: str,
        source_artifact_id: str,
        identifier_values: tuple[Identifier, ...],
    ) -> tuple[VersionReferenceRecord, ...]:
        citing_work_version_id = validate_uuid(citing_work_version_id, "citing_work_version_id")
        source_artifact_id = validate_uuid(source_artifact_id, "source_artifact_id")
        normalized = tuple(sorted(set(Identifier(item.namespace, item.value) for item in identifier_values), key=lambda item: (item.namespace, item.value)))
        with catalog_operation("citation registration"):
            with self._catalog.critical_transaction() as connection:
                result = []
                for reference_order, identifier in enumerate(normalized):
                    matched = connection.execute(select(identifiers.c.work_id).where(identifiers.c.namespace == identifier.namespace, identifiers.c.value == identifier.value)).scalar_one_or_none()
                    key = {"citing_work_version_id": citing_work_version_id, "source_artifact_id": source_artifact_id, "namespace": identifier.namespace, "value": identifier.value}
                    record_id = stable_derivation_id("citation", key)
                    row = connection.execute(select(version_references).where(version_references.c.id == record_id)).mappings().one_or_none()
                    if row is None:
                        values = {
                            "id": record_id, "citing_work_version_id": citing_work_version_id,
                            "cited_work_id": matched, "cited_namespace": identifier.namespace,
                            "cited_value": identifier.value, "source_artifact_id": source_artifact_id,
                            "reference_order": reference_order,
                            "raw_reference": f"{identifier.namespace}:{identifier.value}",
                            "locator_json": None, "created_at": utc_now_rfc3339(),
                        }
                        connection.execute(insert(version_references).values(**values))
                        row = values
                    result.append(VersionReferenceRecord(**{field: row[field] for field in VersionReferenceRecord.__dataclass_fields__}))
                return tuple(result)


__all__ = ("CitationRepository", "EnrichmentRepository")
