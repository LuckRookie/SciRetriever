"""Typed, path-safe contracts for reading and package exports."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
import json
from pathlib import Path
from typing import Final, TypeAlias, TypeVar, assert_never

from sciretriever.core.export_destination import ExportDestination
from sciretriever.core.export_errors import ExportContractError
from sciretriever.core.ids import validate_uuid
from sciretriever.core.validation import validate_sha256


JsonValue: TypeAlias = str | int | float | bool | None | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]
_EnumT = TypeVar("_EnumT", bound=Enum)


class ExportMode(str, Enum):
    READING = "reading"
    PACKAGE = "package"


class ExportFormat(str, Enum):
    JSON = "json"
    JSONL = "jsonl"


class ReadingExportReferences(str, Enum):
    OMIT = "omit"
    INCLUDE = "include"


class PackageReferencePolicy(str, Enum):
    ALWAYS_INCLUDE = "always_include"


class PackageExportDisposition(str, Enum):
    REPLAYED = "replayed"
    NEW_VERSION = "new_version"


_READING_FIELDS: Final = frozenset({"mode", "format", "references", "selector"})
_PACKAGE_FIELDS: Final = frozenset({"mode", "format", "reference_policy", "selector"})


def _strict_object(pairs: list[tuple[str, JsonValue]]) -> JsonObject:
    result: JsonObject = {}
    for key, value in pairs:
        if key in result:
            raise ExportContractError("export request contains a duplicate field")
        result[key] = value
    return result


def _decode(payload: bytes) -> JsonObject:
    if not isinstance(payload, bytes):
        raise ExportContractError("export request payload must be bytes")
    try:
        value = json.loads(payload.decode("utf-8"), object_pairs_hook=_strict_object)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ExportContractError("export request must be valid UTF-8 JSON") from error
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ExportContractError("export request must be a JSON object")
    return value


def _fields(value: JsonObject, expected: frozenset[str], name: str) -> None:
    unknown = value.keys() - expected
    missing = expected - value.keys()
    if unknown:
        raise ExportContractError(f"{name} has unknown fields")
    if missing:
        raise ExportContractError(f"{name} is missing fields: {', '.join(sorted(missing))}")


def _object(value: JsonValue, name: str) -> JsonObject:
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ExportContractError(f"{name} must be a JSON object")
    return value


def _text(value: JsonValue, name: str) -> str:
    if not isinstance(value, str):
        raise ExportContractError(f"{name} must be a string")
    return value


def _enum_value(enum_type: type[_EnumT], value: JsonValue, name: str) -> _EnumT:
    text = _text(value, name)
    try:
        return enum_type(text)
    except ValueError:
        raise ExportContractError(f"unsupported export {name}") from None


def _canonical_bytes(value: JsonObject) -> bytes:
    return json.dumps(
        value, allow_nan=False, ensure_ascii=True, separators=(",", ":"), sort_keys=True
    ).encode("ascii")


@dataclass(frozen=True, slots=True)
class ReadingExportSelector:
    work_id: str | None = None
    work_version_id: str | None = None

    def __post_init__(self) -> None:
        if (self.work_id is None) == (self.work_version_id is None):
            raise ExportContractError("reading export requires exactly one Work or WorkVersion selector")
        if self.work_id is not None:
            object.__setattr__(self, "work_id", validate_uuid(self.work_id, "work_id"))
        if self.work_version_id is not None:
            object.__setattr__(self, "work_version_id", validate_uuid(self.work_version_id, "work_version_id"))

    def to_dict(self) -> JsonObject:
        return {"work_id": self.work_id} if self.work_id is not None else {"work_version_id": self.work_version_id}


@dataclass(frozen=True, slots=True)
class PackageExportSelector:
    work_version_id: str
    package_version: int | None = None
    package_sha256: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "work_version_id", validate_uuid(self.work_version_id, "work_version_id"))
        package_version = self.package_version
        package_sha256 = self.package_sha256
        if package_version is None and package_sha256 is None:
            return
        if package_version is None or package_sha256 is None:
            raise ExportContractError("exact package version and hash selectors must be supplied together")
        if type(package_version) is not int or package_version < 1:
            raise ExportContractError("package_version must be a positive integer")
        object.__setattr__(self, "package_sha256", validate_sha256(package_sha256, "package_sha256"))

    def to_dict(self) -> JsonObject:
        value: JsonObject = {"work_version_id": self.work_version_id}
        if self.package_version is not None:
            value.update(package_version=self.package_version, package_sha256=self.package_sha256)
        return value


@dataclass(frozen=True, slots=True)
class ReadingExportRequest:
    selector: ReadingExportSelector
    references: ReadingExportReferences
    output_format: ExportFormat
    destination: ExportDestination = field(repr=False, compare=False)
    mode: ExportMode = field(init=False, default=ExportMode.READING)

    def to_json_bytes(self) -> bytes:
        return _canonical_bytes({"format": self.output_format.value, "mode": self.mode.value,
            "references": self.references.value, "selector": self.selector.to_dict()})


@dataclass(frozen=True, slots=True)
class PackageExportRequest:
    selector: PackageExportSelector
    destination: ExportDestination = field(repr=False, compare=False)
    output_format: ExportFormat = ExportFormat.JSON
    reference_policy: PackageReferencePolicy = PackageReferencePolicy.ALWAYS_INCLUDE
    mode: ExportMode = field(init=False, default=ExportMode.PACKAGE)

    def __post_init__(self) -> None:
        if self.output_format is not ExportFormat.JSON:
            raise ExportContractError("package export format must be JSON")
        if self.reference_policy is not PackageReferencePolicy.ALWAYS_INCLUDE:
            raise ExportContractError("package exports always include intrinsic references")

    def to_json_bytes(self) -> bytes:
        return _canonical_bytes({"format": self.output_format.value, "mode": self.mode.value,
            "reference_policy": self.reference_policy.value, "selector": self.selector.to_dict()})


ExportRequest: TypeAlias = ReadingExportRequest | PackageExportRequest


def parse_export_request(payload: bytes, destination: Path, catalog_path: Path) -> ExportRequest:
    value = _decode(payload)
    mode = _enum_value(ExportMode, value.get("mode"), "mode")
    admitted_destination = ExportDestination.parse(destination, catalog_path)
    match mode:
        case ExportMode.READING:
            _fields(value, _READING_FIELDS, "reading export request")
            selector = _object(value["selector"], "reading selector")
            _fields(selector, frozenset({"work_id"}) if "work_id" in selector else frozenset({"work_version_id"}), "reading selector")
            return ReadingExportRequest(
                ReadingExportSelector(
                    work_id=_text(selector["work_id"], "work_id") if "work_id" in selector else None,
                    work_version_id=_text(selector["work_version_id"], "work_version_id") if "work_version_id" in selector else None,
                ),
                _enum_value(ReadingExportReferences, value["references"], "references"),
                _enum_value(ExportFormat, value["format"], "format"),
                admitted_destination,
            )
        case ExportMode.PACKAGE:
            _fields(value, _PACKAGE_FIELDS, "package export request")
            selector = _object(value["selector"], "package selector")
            allowed = frozenset({"work_version_id", "package_version", "package_sha256"})
            if selector.keys() - allowed or "work_version_id" not in selector:
                _fields(selector, allowed, "package selector")
            version = selector.get("package_version")
            if version is not None and type(version) is not int:
                raise ExportContractError("package_version must be a positive integer")
            return PackageExportRequest(
                PackageExportSelector(
                    _text(selector["work_version_id"], "work_version_id"),
                    version,
                    _text(selector["package_sha256"], "package_sha256") if "package_sha256" in selector else None,
                ),
                admitted_destination,
                _enum_value(ExportFormat, value["format"], "format"),
                _enum_value(PackageReferencePolicy, value["reference_policy"], "reference_policy"),
            )
        case unreachable:
            assert_never(unreachable)


__all__ = (
    "ExportDestination", "ExportFormat", "ExportMode", "ExportRequest",
    "PackageExportDisposition", "PackageExportRequest", "PackageExportSelector",
    "PackageReferencePolicy", "ReadingExportReferences", "ReadingExportRequest",
    "ReadingExportSelector", "parse_export_request",
)
