"""Schema-version-1 DocumentPackage boundary contracts."""

from __future__ import annotations

from dataclasses import dataclass, field, replace
import hashlib
import json
from typing import Any, ClassVar, Iterable, TypeVar

from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole, PackageQuality, ProcessingStage
from sciretriever.core.ids import validate_uuid
from sciretriever.core.timestamps import parse_rfc3339
from sciretriever.core.validation import (
    normalize_content_text,
    require_string,
    validate_media_type,
    validate_nonnegative_int,
    validate_sha256,
    validate_storage_path,
    validate_token,
)


DOCUMENT_PACKAGE_SCHEMA_VERSION = "1"
SOURCE_MAP_KIND = "source_map"
SOURCE_MAP_MEDIA_TYPE = "application/vnd.sciretriever.source-map.v1+json"
MISSING_PRIMARY_PDF = "missing_primary_pdf"

_T = TypeVar("_T")
_STAGE_ORDER = {stage: index for index, stage in enumerate(ProcessingStage)}


def _mapping(data: object, type_name: str) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise TypeError(f"{type_name} must be a dictionary")
    if not all(isinstance(key, str) for key in data):
        raise TypeError(f"{type_name} keys must be strings")
    return data


def _exact_fields(data: dict[str, Any], type_name: str, expected: frozenset[str]) -> None:
    unknown = data.keys() - expected
    missing = expected - data.keys()
    if unknown:
        raise ValueError(f"{type_name} has unknown fields: {', '.join(sorted(unknown))}")
    if missing:
        raise ValueError(f"{type_name} is missing fields: {', '.join(sorted(missing))}")


def _array(data: object, field_name: str) -> list[Any]:
    if not isinstance(data, list):
        raise TypeError(f"{field_name} must be an array")
    return data


def _tuple_of(value: tuple[_T, ...], expected: type[_T], field_name: str) -> tuple[_T, ...]:
    if not isinstance(value, tuple):
        raise TypeError(f"{field_name} must be a tuple")
    if not all(isinstance(item, expected) for item in value):
        raise TypeError(f"{field_name} contains an invalid value")
    return value


def _string_tuple(value: tuple[str, ...], field_name: str) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError(f"{field_name} must be a tuple")
    return tuple(require_string(item, f"{field_name} item") for item in value)


def _uuid_tuple(value: tuple[str, ...], field_name: str) -> tuple[str, ...]:
    if not isinstance(value, tuple):
        raise TypeError(f"{field_name} must be a tuple")
    result = tuple(sorted(validate_uuid(item, f"{field_name} item") for item in value))
    if len(result) != len(set(result)):
        raise ValueError(f"{field_name} must not contain duplicates")
    return result


def _unique_ids(items: Iterable[Any], field_name: str) -> None:
    values = [getattr(item, field_name) for item in items]
    if len(values) != len(set(values)):
        raise ValueError(f"duplicate {field_name}")


def _enum(value: object, enum_type: Any, field_name: str) -> Any:
    if isinstance(value, enum_type):
        return value
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string or {enum_type.__name__}")
    try:
        return enum_type(value)
    except ValueError as error:
        raise ValueError(f"unsupported {field_name}: {value!r}") from error


def _unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON object key: {key!r}")
        result[key] = value
    return result


def canonical_json(data: object) -> str:
    """Serialize JSON deterministically for package hashing and transport."""
    return json.dumps(
        data,
        allow_nan=False,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
    )


def _package_hash(data: dict[str, Any]) -> str:
    payload = dict(data)
    payload.pop("package_sha256", None)
    return hashlib.sha256(canonical_json(payload).encode("utf-8")).hexdigest()


@dataclass(frozen=True, slots=True)
class FileRecord:
    file_id: str
    role: AssetRole
    media_type: str
    storage_path: str
    sha256: str
    size_bytes: int

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"file_id", "role", "media_type", "storage_path", "sha256", "size_bytes"}
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "file_id", validate_uuid(self.file_id, "file_id"))
        object.__setattr__(self, "role", _enum(self.role, AssetRole, "role"))
        object.__setattr__(self, "media_type", validate_media_type(self.media_type))
        object.__setattr__(self, "storage_path", validate_storage_path(self.storage_path))
        object.__setattr__(self, "sha256", validate_sha256(self.sha256))
        validate_nonnegative_int(self.size_bytes, "size_bytes")
        if self.size_bytes == 0:
            raise ValueError("size_bytes must be greater than zero")

    def to_dict(self) -> dict[str, Any]:
        return {
            "file_id": self.file_id,
            "role": self.role.value,
            "media_type": self.media_type,
            "storage_path": self.storage_path,
            "sha256": self.sha256,
            "size_bytes": self.size_bytes,
        }

    @classmethod
    def from_dict(cls, data: object) -> FileRecord:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(**values)


@dataclass(frozen=True, slots=True)
class SourceProvenance:
    provenance_id: str
    file_id: str
    provider: str
    acquisition_method: str
    agent: str
    started_at: str
    completed_at: str
    source_uri: str | None = None

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "provenance_id", "file_id", "provider", "acquisition_method", "agent",
            "started_at", "completed_at", "source_uri",
        }
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "provenance_id", validate_uuid(self.provenance_id, "provenance_id"))
        object.__setattr__(self, "file_id", validate_uuid(self.file_id, "file_id"))
        object.__setattr__(self, "provider", require_string(self.provider, "provider"))
        object.__setattr__(self, "acquisition_method", require_string(self.acquisition_method, "acquisition_method"))
        object.__setattr__(self, "agent", require_string(self.agent, "agent"))
        started = parse_rfc3339(self.started_at)
        completed = parse_rfc3339(self.completed_at)
        if completed < started:
            raise ValueError("completed_at must not precede started_at")
        if self.source_uri is not None:
            object.__setattr__(self, "source_uri", require_string(self.source_uri, "source_uri"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "provenance_id": self.provenance_id,
            "file_id": self.file_id,
            "provider": self.provider,
            "acquisition_method": self.acquisition_method,
            "agent": self.agent,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "source_uri": self.source_uri,
        }

    @classmethod
    def from_dict(cls, data: object) -> SourceProvenance:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(**values)


@dataclass(frozen=True, slots=True)
class SectionRecord:
    section_id: str
    parent_section_id: str | None
    ordinal: int
    title: str | None
    text: str

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"section_id", "parent_section_id", "ordinal", "title", "text"}
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "section_id", validate_uuid(self.section_id, "section_id"))
        if self.parent_section_id is not None:
            object.__setattr__(self, "parent_section_id", validate_uuid(self.parent_section_id, "parent_section_id"))
        validate_nonnegative_int(self.ordinal, "ordinal")
        if self.title is not None:
            object.__setattr__(self, "title", normalize_content_text(self.title, "title"))
        object.__setattr__(self, "text", normalize_content_text(self.text, "text", allow_blank=True))

    def to_dict(self) -> dict[str, Any]:
        return {
            "section_id": self.section_id,
            "parent_section_id": self.parent_section_id,
            "ordinal": self.ordinal,
            "title": self.title,
            "text": self.text,
        }

    @classmethod
    def from_dict(cls, data: object) -> SectionRecord:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(**values)


@dataclass(frozen=True, slots=True)
class TableCell:
    row_index: int
    column_index: int
    text: str
    is_header: bool = False
    row_span: int = 1
    column_span: int = 1

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"row_index", "column_index", "text", "is_header", "row_span", "column_span"}
    )

    def __post_init__(self) -> None:
        validate_nonnegative_int(self.row_index, "row_index")
        validate_nonnegative_int(self.column_index, "column_index")
        validate_nonnegative_int(self.row_span, "row_span")
        validate_nonnegative_int(self.column_span, "column_span")
        if self.row_span == 0 or self.column_span == 0:
            raise ValueError("table cell spans must be greater than zero")
        if not isinstance(self.is_header, bool):
            raise TypeError("is_header must be a boolean")
        object.__setattr__(self, "text", normalize_content_text(self.text, "text", allow_blank=True))

    def to_dict(self) -> dict[str, Any]:
        return {
            "row_index": self.row_index,
            "column_index": self.column_index,
            "text": self.text,
            "is_header": self.is_header,
            "row_span": self.row_span,
            "column_span": self.column_span,
        }

    @classmethod
    def from_dict(cls, data: object) -> TableCell:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(**values)


@dataclass(frozen=True, slots=True)
class TableRecord:
    table_id: str
    ordinal: int
    caption: str | None
    cells: tuple[TableCell, ...]
    section_id: str | None = None
    notes: str | None = None

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"table_id", "ordinal", "caption", "cells", "section_id", "notes"}
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "table_id", validate_uuid(self.table_id, "table_id"))
        validate_nonnegative_int(self.ordinal, "ordinal")
        if self.caption is not None:
            object.__setattr__(self, "caption", normalize_content_text(self.caption, "caption"))
        if self.section_id is not None:
            object.__setattr__(self, "section_id", validate_uuid(self.section_id, "section_id"))
        if self.notes is not None:
            object.__setattr__(self, "notes", normalize_content_text(self.notes, "notes"))
        cells = _tuple_of(self.cells, TableCell, "cells")
        cells = tuple(sorted(cells, key=lambda cell: (cell.row_index, cell.column_index)))
        coordinates = [(cell.row_index, cell.column_index) for cell in cells]
        if len(coordinates) != len(set(coordinates)):
            raise ValueError("table cells must have unique coordinates")
        object.__setattr__(self, "cells", cells)

    def to_dict(self) -> dict[str, Any]:
        return {
            "table_id": self.table_id,
            "ordinal": self.ordinal,
            "caption": self.caption,
            "cells": [cell.to_dict() for cell in self.cells],
            "section_id": self.section_id,
            "notes": self.notes,
        }

    @classmethod
    def from_dict(cls, data: object) -> TableRecord:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(
            table_id=values["table_id"], ordinal=values["ordinal"], caption=values["caption"],
            cells=tuple(TableCell.from_dict(item) for item in _array(values["cells"], "cells")),
            section_id=values["section_id"], notes=values["notes"],
        )


@dataclass(frozen=True, slots=True)
class ReferenceRecord:
    reference_id: str
    ordinal: int
    text: str
    identifiers: tuple[Identifier, ...] = ()

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"reference_id", "ordinal", "text", "identifiers"}
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "reference_id", validate_uuid(self.reference_id, "reference_id"))
        validate_nonnegative_int(self.ordinal, "ordinal")
        object.__setattr__(self, "text", normalize_content_text(self.text, "text"))
        identifiers = _tuple_of(self.identifiers, Identifier, "identifiers")
        identifiers = tuple(sorted(identifiers, key=lambda item: (item.namespace, item.value)))
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("identifiers must not contain duplicates")
        object.__setattr__(self, "identifiers", identifiers)

    def to_dict(self) -> dict[str, Any]:
        return {
            "reference_id": self.reference_id,
            "ordinal": self.ordinal,
            "text": self.text,
            "identifiers": [identifier.to_dict() for identifier in self.identifiers],
        }

    @classmethod
    def from_dict(cls, data: object) -> ReferenceRecord:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(
            reference_id=values["reference_id"], ordinal=values["ordinal"], text=values["text"],
            identifiers=tuple(Identifier.from_dict(item) for item in _array(values["identifiers"], "identifiers")),
        )


@dataclass(frozen=True, slots=True)
class NormalizedContent:
    artifact_id: str
    sections: tuple[SectionRecord, ...]
    tables: tuple[TableRecord, ...]
    references: tuple[ReferenceRecord, ...]

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"artifact_id", "sections", "tables", "references"}
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "artifact_id", validate_uuid(self.artifact_id, "artifact_id"))
        sections = tuple(sorted(_tuple_of(self.sections, SectionRecord, "sections"), key=lambda item: (item.ordinal, item.section_id)))
        tables = tuple(sorted(_tuple_of(self.tables, TableRecord, "tables"), key=lambda item: (item.ordinal, item.table_id)))
        references = tuple(sorted(_tuple_of(self.references, ReferenceRecord, "references"), key=lambda item: (item.ordinal, item.reference_id)))
        _unique_ids(sections, "section_id")
        _unique_ids(tables, "table_id")
        _unique_ids(references, "reference_id")
        self._validate_section_tree(sections)
        section_ids = {section.section_id for section in sections}
        if any(table.section_id is not None and table.section_id not in section_ids for table in tables):
            raise ValueError("table section_id must reference an existing section")
        object.__setattr__(self, "sections", sections)
        object.__setattr__(self, "tables", tables)
        object.__setattr__(self, "references", references)

    @staticmethod
    def _validate_section_tree(sections: tuple[SectionRecord, ...]) -> None:
        parents = {section.section_id: section.parent_section_id for section in sections}
        for section_id, parent_id in parents.items():
            if parent_id is not None and parent_id not in parents:
                raise ValueError("section parent must reference an existing section")
            seen: set[str] = set()
            current: str | None = section_id
            while current is not None:
                if current in seen:
                    raise ValueError("section parent relationships must be acyclic")
                seen.add(current)
                current = parents[current]

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id,
            "sections": [item.to_dict() for item in self.sections],
            "tables": [item.to_dict() for item in self.tables],
            "references": [item.to_dict() for item in self.references],
        }

    @classmethod
    def from_dict(cls, data: object) -> NormalizedContent:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(
            artifact_id=values["artifact_id"],
            sections=tuple(SectionRecord.from_dict(item) for item in _array(values["sections"], "sections")),
            tables=tuple(TableRecord.from_dict(item) for item in _array(values["tables"], "tables")),
            references=tuple(ReferenceRecord.from_dict(item) for item in _array(values["references"], "references")),
        )


@dataclass(frozen=True, slots=True)
class ArtifactRecord:
    artifact_id: str
    kind: str
    media_type: str
    storage_path: str
    sha256: str
    size_bytes: int

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"artifact_id", "kind", "media_type", "storage_path", "sha256", "size_bytes"}
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "artifact_id", validate_uuid(self.artifact_id, "artifact_id"))
        object.__setattr__(self, "kind", validate_token(self.kind, "kind"))
        object.__setattr__(self, "media_type", validate_media_type(self.media_type))
        object.__setattr__(self, "storage_path", validate_storage_path(self.storage_path))
        object.__setattr__(self, "sha256", validate_sha256(self.sha256))
        validate_nonnegative_int(self.size_bytes, "size_bytes")
        if self.size_bytes == 0:
            raise ValueError("size_bytes must be greater than zero")

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id, "kind": self.kind, "media_type": self.media_type,
            "storage_path": self.storage_path, "sha256": self.sha256, "size_bytes": self.size_bytes,
        }

    @classmethod
    def from_dict(cls, data: object) -> ArtifactRecord:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(**values)


@dataclass(frozen=True, slots=True)
class EvidenceLocator:
    evidence_id: str
    file_id: str
    source_artifact_id: str
    source_unit_id: str
    source_start: int
    source_end: int
    normalized_path: str
    normalized_start: int
    normalized_end: int

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "evidence_id", "file_id", "source_artifact_id", "source_unit_id",
            "source_start", "source_end", "normalized_path", "normalized_start",
            "normalized_end",
        }
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "evidence_id", validate_uuid(self.evidence_id, "evidence_id"))
        object.__setattr__(self, "file_id", validate_uuid(self.file_id, "file_id"))
        object.__setattr__(self, "source_artifact_id", validate_uuid(self.source_artifact_id, "source_artifact_id"))
        object.__setattr__(self, "source_unit_id", require_string(self.source_unit_id, "source_unit_id"))
        pointer = require_string(self.normalized_path, "normalized_path")
        if not pointer.startswith("/") or _invalid_json_pointer(pointer):
            raise ValueError("normalized_path must be an RFC6901 pointer rooted at NormalizedContent")
        for value, name in (
            (self.source_start, "source_start"),
            (self.source_end, "source_end"),
            (self.normalized_start, "normalized_start"),
            (self.normalized_end, "normalized_end"),
        ):
            validate_nonnegative_int(value, name)
        if self.source_end <= self.source_start:
            raise ValueError("source span must satisfy start < end")
        if self.normalized_end <= self.normalized_start:
            raise ValueError("normalized span must satisfy start < end")

    def to_dict(self) -> dict[str, Any]:
        return {
            "evidence_id": self.evidence_id, "file_id": self.file_id,
            "source_artifact_id": self.source_artifact_id,
            "source_unit_id": self.source_unit_id,
            "source_start": self.source_start,
            "source_end": self.source_end,
            "normalized_path": self.normalized_path,
            "normalized_start": self.normalized_start,
            "normalized_end": self.normalized_end,
        }

    @classmethod
    def from_dict(cls, data: object) -> EvidenceLocator:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(**values)


def _invalid_json_pointer(pointer: str) -> bool:
    index = 0
    while index < len(pointer):
        if pointer[index] == "~":
            if index + 1 >= len(pointer) or pointer[index + 1] not in "01":
                return True
            index += 1
        index += 1
    return False


@dataclass(frozen=True, slots=True)
class LightStructure:
    summary: str | None = None
    tags: tuple[str, ...] = ()
    citation_document_ids: tuple[str, ...] = ()
    artifact_id: str | None = None

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {"artifact_id", "summary", "tags", "citation_document_ids"}
    )

    def __post_init__(self) -> None:
        if self.artifact_id is not None:
            object.__setattr__(self, "artifact_id", validate_uuid(self.artifact_id, "artifact_id"))
        if self.summary is not None:
            object.__setattr__(self, "summary", normalize_content_text(self.summary, "summary"))
        tags = tuple(sorted(_string_tuple(self.tags, "tags")))
        if len(tags) != len(set(tags)):
            raise ValueError("tags must not contain duplicates")
        object.__setattr__(self, "tags", tags)
        object.__setattr__(self, "citation_document_ids", _uuid_tuple(self.citation_document_ids, "citation_document_ids"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "artifact_id": self.artifact_id, "summary": self.summary, "tags": list(self.tags),
            "citation_document_ids": list(self.citation_document_ids),
        }

    @classmethod
    def from_dict(cls, data: object) -> LightStructure:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(
            artifact_id=values["artifact_id"], summary=values["summary"],
            tags=tuple(_array(values["tags"], "tags")),
            citation_document_ids=tuple(_array(values["citation_document_ids"], "citation_document_ids")),
        )


@dataclass(frozen=True, slots=True)
class Lineage:
    lineage_id: str
    run_id: str
    stage: ProcessingStage
    producer: str
    producer_version: str
    started_at: str
    completed_at: str
    input_file_ids: tuple[str, ...]
    input_artifact_ids: tuple[str, ...]
    output_file_ids: tuple[str, ...]
    output_artifact_ids: tuple[str, ...]
    parameters_sha256: str

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "lineage_id", "run_id", "stage", "producer", "producer_version",
            "started_at", "completed_at", "input_file_ids", "input_artifact_ids",
            "output_file_ids", "output_artifact_ids", "parameters_sha256",
        }
    )

    def __post_init__(self) -> None:
        object.__setattr__(self, "lineage_id", validate_uuid(self.lineage_id, "lineage_id"))
        object.__setattr__(self, "run_id", validate_uuid(self.run_id, "run_id"))
        object.__setattr__(self, "stage", _enum(self.stage, ProcessingStage, "stage"))
        object.__setattr__(self, "producer", require_string(self.producer, "producer"))
        object.__setattr__(self, "producer_version", require_string(self.producer_version, "producer_version"))
        started = parse_rfc3339(self.started_at)
        completed = parse_rfc3339(self.completed_at)
        if completed < started:
            raise ValueError("completed_at must not precede started_at")
        object.__setattr__(self, "input_file_ids", _uuid_tuple(self.input_file_ids, "input_file_ids"))
        object.__setattr__(self, "input_artifact_ids", _uuid_tuple(self.input_artifact_ids, "input_artifact_ids"))
        object.__setattr__(self, "output_file_ids", _uuid_tuple(self.output_file_ids, "output_file_ids"))
        object.__setattr__(self, "output_artifact_ids", _uuid_tuple(self.output_artifact_ids, "output_artifact_ids"))
        object.__setattr__(self, "parameters_sha256", validate_sha256(self.parameters_sha256, "parameters_sha256"))

    def to_dict(self) -> dict[str, Any]:
        return {
            "lineage_id": self.lineage_id, "run_id": self.run_id,
            "stage": self.stage.value, "producer": self.producer,
            "producer_version": self.producer_version,
            "started_at": self.started_at, "completed_at": self.completed_at,
            "input_file_ids": list(self.input_file_ids),
            "input_artifact_ids": list(self.input_artifact_ids),
            "output_file_ids": list(self.output_file_ids),
            "output_artifact_ids": list(self.output_artifact_ids),
            "parameters_sha256": self.parameters_sha256,
        }

    @classmethod
    def from_dict(cls, data: object) -> Lineage:
        values = _mapping(data, cls.__name__)
        _exact_fields(values, cls.__name__, cls._FIELDS)
        return cls(
            lineage_id=values["lineage_id"], run_id=values["run_id"],
            stage=values["stage"], producer=values["producer"],
            producer_version=values["producer_version"],
            started_at=values["started_at"], completed_at=values["completed_at"],
            input_file_ids=tuple(_array(values["input_file_ids"], "input_file_ids")),
            input_artifact_ids=tuple(_array(values["input_artifact_ids"], "input_artifact_ids")),
            output_file_ids=tuple(_array(values["output_file_ids"], "output_file_ids")),
            output_artifact_ids=tuple(_array(values["output_artifact_ids"], "output_artifact_ids")),
            parameters_sha256=values["parameters_sha256"],
        )


@dataclass(frozen=True, slots=True)
class DocumentPackageVersion:
    schema_version: str
    document_id: str
    package_version: int
    package_sha256: str
    published_at: str
    quality: PackageQuality
    limitations: tuple[str, ...]
    identifiers: tuple[Identifier, ...]
    source_provenance: tuple[SourceProvenance, ...]
    files: tuple[FileRecord, ...]
    normalized_content: NormalizedContent
    evidence: tuple[EvidenceLocator, ...]
    light_structure: LightStructure
    artifacts: tuple[ArtifactRecord, ...]
    lineage: tuple[Lineage, ...]
    _unknown_top_level: tuple[tuple[str, str], ...] = field(default=(), repr=False)

    _FIELDS: ClassVar[frozenset[str]] = frozenset(
        {
            "schema_version", "document_id", "package_version", "package_sha256", "published_at",
            "quality", "limitations", "identifiers", "source_provenance", "files",
            "normalized_content", "evidence", "light_structure", "artifacts", "lineage",
        }
    )

    def __post_init__(self) -> None:
        if self.schema_version != DOCUMENT_PACKAGE_SCHEMA_VERSION:
            raise ValueError(f"unsupported document package schema version: {self.schema_version!r}")
        object.__setattr__(self, "document_id", validate_uuid(self.document_id, "document_id"))
        validate_nonnegative_int(self.package_version, "package_version")
        if self.package_version == 0:
            raise ValueError("package_version must be at least 1")
        object.__setattr__(self, "package_sha256", validate_sha256(self.package_sha256, "package_sha256"))
        published = parse_rfc3339(self.published_at)
        object.__setattr__(self, "quality", _enum(self.quality, PackageQuality, "quality"))
        limitations = tuple(sorted(validate_token(item, "limitation") for item in _string_tuple(self.limitations, "limitations")))
        if len(limitations) != len(set(limitations)):
            raise ValueError("limitations must not contain duplicates")
        object.__setattr__(self, "limitations", limitations)
        identifiers = tuple(sorted(_tuple_of(self.identifiers, Identifier, "identifiers"), key=lambda item: (item.namespace, item.value)))
        if len(identifiers) != len(set(identifiers)):
            raise ValueError("identifiers must not contain duplicates")
        object.__setattr__(self, "identifiers", identifiers)
        provenance = tuple(sorted(_tuple_of(self.source_provenance, SourceProvenance, "source_provenance"), key=lambda item: item.provenance_id))
        files = tuple(sorted(_tuple_of(self.files, FileRecord, "files"), key=lambda item: item.file_id))
        evidence = tuple(sorted(_tuple_of(self.evidence, EvidenceLocator, "evidence"), key=lambda item: item.evidence_id))
        artifacts = tuple(sorted(_tuple_of(self.artifacts, ArtifactRecord, "artifacts"), key=lambda item: item.artifact_id))
        lineage = tuple(sorted(_tuple_of(self.lineage, Lineage, "lineage"), key=lambda item: (_STAGE_ORDER[item.stage], item.lineage_id)))
        if not isinstance(self.normalized_content, NormalizedContent):
            raise TypeError("normalized_content must be NormalizedContent")
        if not isinstance(self.light_structure, LightStructure):
            raise TypeError("light_structure must be LightStructure")
        for values, id_name in ((provenance, "provenance_id"), (files, "file_id"), (evidence, "evidence_id"), (artifacts, "artifact_id"), (lineage, "lineage_id")):
            _unique_ids(values, id_name)
        object.__setattr__(self, "source_provenance", provenance)
        object.__setattr__(self, "files", files)
        object.__setattr__(self, "evidence", evidence)
        object.__setattr__(self, "artifacts", artifacts)
        object.__setattr__(self, "lineage", lineage)
        unknown_top_level = self._validate_unknown_top_level(self._unknown_top_level)
        object.__setattr__(self, "_unknown_top_level", unknown_top_level)
        completed_times = [parse_rfc3339(item.completed_at) for item in provenance]
        completed_times.extend(parse_rfc3339(item.completed_at) for item in lineage)
        if any(completed > published for completed in completed_times):
            raise ValueError("published_at must not precede provenance or lineage completion")
        self._validate_references()
        self._validate_quality()
        self._validate_lineage()

    @classmethod
    def _validate_unknown_top_level(
        cls, value: tuple[tuple[str, str], ...]
    ) -> tuple[tuple[str, str], ...]:
        if not isinstance(value, tuple):
            raise TypeError("private unknown top-level representation must be a tuple")
        result: list[tuple[str, str]] = []
        for item in value:
            if not isinstance(item, tuple) or len(item) != 2:
                raise TypeError("private unknown top-level entries must be pairs")
            key, encoded = item
            if not isinstance(key, str) or not isinstance(encoded, str):
                raise TypeError("private unknown top-level entries must contain strings")
            if key in cls._FIELDS:
                raise ValueError("private unknown top-level fields must not replace schema fields")
            decoded = json.loads(encoded, object_pairs_hook=_unique_json_object)
            canonical = canonical_json(decoded)
            if canonical != encoded:
                raise ValueError("private unknown top-level values must be canonical JSON")
            result.append((key, encoded))
        result.sort()
        if len(result) != len({key for key, _ in result}):
            raise ValueError("duplicate private unknown top-level field")
        return tuple(result)

    def _validate_references(self) -> None:
        file_ids = {item.file_id for item in self.files}
        artifact_by_id = {item.artifact_id: item for item in self.artifacts}
        for item in self.source_provenance:
            if item.file_id not in file_ids:
                raise ValueError("source provenance references an unknown file_id")
        if file_ids - {item.file_id for item in self.source_provenance}:
            raise ValueError("every file must have source provenance")
        normalized_artifact = artifact_by_id.get(self.normalized_content.artifact_id)
        if normalized_artifact is None or normalized_artifact.kind != "normalized_content":
            raise ValueError("NormalizedContent artifact_id must reference a normalized_content artifact")
        has_light_data = (
            self.light_structure.summary is not None
            or bool(self.light_structure.tags)
            or bool(self.light_structure.citation_document_ids)
        )
        if has_light_data and self.light_structure.artifact_id is None:
            raise ValueError("light data requires a LightStructure artifact_id")
        if self.light_structure.artifact_id is not None:
            light_artifact = artifact_by_id.get(self.light_structure.artifact_id)
            if light_artifact is None or light_artifact.kind != "light_structure":
                raise ValueError("LightStructure artifact_id must reference a light_structure artifact")
        content_dict = self.normalized_content.to_dict()
        text_targets = _normalized_text_targets(self.normalized_content)
        coverage: dict[str, list[tuple[int, int]]] = {path: [] for path in text_targets}
        for item in self.evidence:
            if item.file_id not in file_ids:
                raise ValueError("evidence references an unknown file_id")
            artifact = artifact_by_id.get(item.source_artifact_id)
            if artifact is None:
                raise ValueError("evidence references an unknown source-map artifact")
            if artifact.kind != SOURCE_MAP_KIND or artifact.media_type != SOURCE_MAP_MEDIA_TYPE:
                raise ValueError("evidence must reference a schema-v1 source_map artifact")
            if item.normalized_path not in text_targets:
                raise ValueError("evidence normalized_path must reference normalized text")
            target = _resolve_json_pointer(content_dict, item.normalized_path)
            if not isinstance(target, str):
                raise ValueError("evidence normalized_path must resolve to text")
            if item.normalized_end > len(target):
                raise ValueError("evidence normalized span exceeds the referenced text")
            coverage[item.normalized_path].append((item.normalized_start, item.normalized_end))
        for path, text in text_targets.items():
            if not text:
                continue
            cursor = 0
            for start, end in sorted(coverage[path]):
                if start > cursor:
                    raise ValueError(f"normalized text has an evidence gap at {path}")
                cursor = max(cursor, end)
            if cursor < len(text):
                raise ValueError(f"normalized text has an evidence gap at {path}")

    def _validate_quality(self) -> None:
        roles = {item.role for item in self.files}
        has_primary_pdf = AssetRole.PRIMARY_PDF in roles
        if self.quality is PackageQuality.PDF_BACKED:
            if not has_primary_pdf:
                raise ValueError("pdf_backed quality requires a primary PDF")
        elif self.quality is PackageQuality.LIMITED_XML_HTML:
            if has_primary_pdf:
                raise ValueError("limited_xml_html quality forbids a primary PDF")
            if not roles.intersection({AssetRole.XML, AssetRole.HTML}):
                raise ValueError("limited_xml_html quality requires an XML or HTML file")
            if MISSING_PRIMARY_PDF not in self.limitations:
                raise ValueError("limited_xml_html quality requires missing_primary_pdf")

    def _validate_lineage(self) -> None:
        file_ids = {item.file_id for item in self.files}
        artifact_ids = {item.artifact_id for item in self.artifacts}
        stages = {item.stage for item in self.lineage}
        required = {
            ProcessingStage.RAW_ACCEPTANCE,
            ProcessingStage.NORMALIZATION,
            ProcessingStage.PACKAGE_VALIDATION,
            ProcessingStage.PUBLICATION,
        }
        if self.light_structure.summary is not None or self.light_structure.tags or self.light_structure.citation_document_ids:
            required.add(ProcessingStage.ENRICHMENT)
        if not required.issubset(stages):
            missing = sorted(stage.value for stage in required - stages)
            raise ValueError(f"lineage is missing required stages: {', '.join(missing)}")
        for item in self.lineage:
            if not set(item.input_file_ids + item.output_file_ids).issubset(file_ids):
                raise ValueError("lineage references an unknown file_id")
            if not set(item.input_artifact_ids + item.output_artifact_ids).issubset(artifact_ids):
                raise ValueError("lineage references an unknown artifact_id")
            if item.stage is ProcessingStage.RAW_ACCEPTANCE and not item.output_file_ids:
                raise ValueError("raw_acceptance lineage requires output_file_ids")
            if item.stage is ProcessingStage.NORMALIZATION and (not item.input_file_ids or not item.output_artifact_ids):
                raise ValueError("normalization lineage requires input files and output artifacts")
            if item.stage in {ProcessingStage.PACKAGE_VALIDATION, ProcessingStage.PUBLICATION} and not item.input_artifact_ids:
                raise ValueError(f"{item.stage.value} lineage requires input artifacts")
            if item.stage is ProcessingStage.ENRICHMENT and (not item.input_artifact_ids or not item.output_artifact_ids):
                raise ValueError("enrichment lineage requires input and output artifacts")

    def to_dict(self) -> dict[str, Any]:
        data = {
            "schema_version": self.schema_version,
            "document_id": self.document_id,
            "package_version": self.package_version,
            "package_sha256": self.package_sha256,
            "published_at": self.published_at,
            "quality": self.quality.value,
            "limitations": list(self.limitations),
            "identifiers": [item.to_dict() for item in self.identifiers],
            "source_provenance": [item.to_dict() for item in self.source_provenance],
            "files": [item.to_dict() for item in self.files],
            "normalized_content": self.normalized_content.to_dict(),
            "evidence": [item.to_dict() for item in self.evidence],
            "light_structure": self.light_structure.to_dict(),
            "artifacts": [item.to_dict() for item in self.artifacts],
            "lineage": [item.to_dict() for item in self.lineage],
        }
        for key, encoded in self._unknown_top_level:
            data[key] = json.loads(encoded, object_pairs_hook=_unique_json_object)
        return data

    def validate_hash(self) -> None:
        expected = _package_hash(self.to_dict())
        if self.package_sha256 != expected:
            raise ValueError("package_sha256 does not match canonical package content")

    def to_json(self) -> str:
        self.validate_hash()
        return canonical_json(self.to_dict())

    @classmethod
    def create(
        cls,
        *,
        document_id: str,
        package_version: int,
        published_at: str,
        quality: PackageQuality,
        limitations: tuple[str, ...],
        identifiers: tuple[Identifier, ...],
        source_provenance: tuple[SourceProvenance, ...],
        files: tuple[FileRecord, ...],
        normalized_content: NormalizedContent,
        evidence: tuple[EvidenceLocator, ...],
        light_structure: LightStructure,
        artifacts: tuple[ArtifactRecord, ...],
        lineage: tuple[Lineage, ...],
        schema_version: str = DOCUMENT_PACKAGE_SCHEMA_VERSION,
    ) -> DocumentPackageVersion:
        package = cls(
            schema_version=schema_version,
            document_id=document_id,
            package_version=package_version,
            package_sha256="0" * 64,
            published_at=published_at,
            quality=quality,
            limitations=limitations,
            identifiers=identifiers,
            source_provenance=source_provenance,
            files=files,
            normalized_content=normalized_content,
            evidence=evidence,
            light_structure=light_structure,
            artifacts=artifacts,
            lineage=lineage,
        )
        return replace(package, package_sha256=_package_hash(package.to_dict()))

    @classmethod
    def from_dict(cls, data: object) -> DocumentPackageVersion:
        values = _mapping(data, cls.__name__)
        missing = cls._FIELDS - values.keys()
        if missing:
            raise ValueError(f"{cls.__name__} is missing fields: {', '.join(sorted(missing))}")
        supplied_hash = validate_sha256(values["package_sha256"], "package_sha256")
        if supplied_hash != _package_hash(values):
            raise ValueError("package_sha256 does not match canonical package content")
        package = cls(
            schema_version=values["schema_version"], document_id=values["document_id"],
            package_version=values["package_version"], package_sha256=supplied_hash,
            published_at=values["published_at"], quality=values["quality"],
            limitations=tuple(_array(values["limitations"], "limitations")),
            identifiers=tuple(Identifier.from_dict(item) for item in _array(values["identifiers"], "identifiers")),
            source_provenance=tuple(SourceProvenance.from_dict(item) for item in _array(values["source_provenance"], "source_provenance")),
            files=tuple(FileRecord.from_dict(item) for item in _array(values["files"], "files")),
            normalized_content=NormalizedContent.from_dict(values["normalized_content"]),
            evidence=tuple(EvidenceLocator.from_dict(item) for item in _array(values["evidence"], "evidence")),
            light_structure=LightStructure.from_dict(values["light_structure"]),
            artifacts=tuple(ArtifactRecord.from_dict(item) for item in _array(values["artifacts"], "artifacts")),
            lineage=tuple(Lineage.from_dict(item) for item in _array(values["lineage"], "lineage")),
            _unknown_top_level=tuple(
                sorted(
                    (key, canonical_json(value))
                    for key, value in values.items()
                    if key not in cls._FIELDS
                )
            ),
        )
        package.validate_hash()
        return package

    @classmethod
    def from_json(cls, payload: str) -> DocumentPackageVersion:
        if not isinstance(payload, str):
            raise TypeError("package JSON must be a string")
        try:
            data = json.loads(payload, object_pairs_hook=_unique_json_object)
        except json.JSONDecodeError as error:
            raise ValueError(f"invalid JSON: {error.msg}") from error
        return cls.from_dict(data)


def _resolve_json_pointer(document: object, pointer: str) -> object:
    current = document
    for raw_part in pointer.split("/")[1:]:
        part = raw_part.replace("~1", "/").replace("~0", "~")
        if isinstance(current, dict):
            if part not in current:
                raise ValueError("evidence json_pointer does not resolve")
            current = current[part]
        elif isinstance(current, list):
            if not part.isdigit() or (len(part) > 1 and part.startswith("0")):
                raise ValueError("evidence json_pointer has an invalid array index")
            index = int(part)
            if index >= len(current):
                raise ValueError("evidence json_pointer does not resolve")
            current = current[index]
        else:
            raise ValueError("evidence json_pointer does not resolve")
    return current


def _normalized_text_targets(content: NormalizedContent) -> dict[str, str]:
    targets: dict[str, str] = {}
    for section_index, section in enumerate(content.sections):
        if section.title is not None:
            targets[f"/sections/{section_index}/title"] = section.title
        targets[f"/sections/{section_index}/text"] = section.text
    for table_index, table in enumerate(content.tables):
        if table.caption is not None:
            targets[f"/tables/{table_index}/caption"] = table.caption
        if table.notes is not None:
            targets[f"/tables/{table_index}/notes"] = table.notes
        for cell_index, cell in enumerate(table.cells):
            targets[f"/tables/{table_index}/cells/{cell_index}/text"] = cell.text
    for reference_index, reference in enumerate(content.references):
        targets[f"/references/{reference_index}/text"] = reference.text
    return targets
