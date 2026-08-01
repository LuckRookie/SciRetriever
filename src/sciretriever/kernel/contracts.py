from __future__ import annotations

from dataclasses import dataclass
import unicodedata
from sciretriever.kernel.enums import SourceKind
from sciretriever.kernel.errors import BoundaryError
from sciretriever.kernel.hashes import Sha256
from sciretriever.kernel.ids import AssetId, ProvenanceId
from sciretriever.kernel.json import (
    CanonicalJsonObject,
    CanonicalJsonValue,
    canonical_json_bytes,
    parse_canonical_json,
)
from sciretriever.kernel.time import UtcTimestamp


def _text(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BoundaryError.for_field(field, "must be a nonblank string")
    return unicodedata.normalize("NFC", value)


def _object(value: CanonicalJsonValue, name: str) -> CanonicalJsonObject:
    if not isinstance(value, CanonicalJsonObject):
        raise BoundaryError.for_field(name, "must be a JSON object")
    return value


def _fields(value: CanonicalJsonObject, expected: frozenset[str], name: str) -> dict[str, CanonicalJsonValue]:
    fields = dict(value.entries)
    if fields.keys() != expected:
        raise BoundaryError.for_field(name, "must contain exactly the required fields")
    return fields


def _string(value: CanonicalJsonValue, field: str) -> str:
    if not isinstance(value, str):
        raise BoundaryError.for_field(field, "must be a string")
    return value


def _integer(value: CanonicalJsonValue, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool):
        raise BoundaryError.for_field(field, "must be an integer")
    return value


@dataclass(frozen=True, slots=True)
class Identifier:
    namespace: str
    value: str

    def __post_init__(self) -> None:
        object.__setattr__(self, "namespace", _text(self.namespace, "namespace"))
        object.__setattr__(self, "value", _text(self.value, "value"))

    def to_json(self) -> str:
        value = CanonicalJsonObject((("namespace", self.namespace), ("value", self.value)))
        return canonical_json_bytes(value).decode("ascii")

    @classmethod
    def from_json(cls, payload: str) -> Identifier:
        fields = _fields(
            _object(parse_canonical_json(payload), "Identifier"),
            frozenset(("namespace", "value")),
            "Identifier",
        )
        return cls(_string(fields["namespace"], "namespace"), _string(fields["value"], "value"))


@dataclass(frozen=True, slots=True)
class Provenance:
    provenance_id: ProvenanceId
    source_kind: SourceKind
    source_name: str
    source_record_id: str | None
    observed_at: UtcTimestamp
    input_sha256: Sha256 | None
    parameters_sha256: Sha256 | None

    def __post_init__(self) -> None:
        if not isinstance(self.provenance_id, ProvenanceId):
            raise BoundaryError.for_field("provenance_id", "must be ProvenanceId")
        if not isinstance(self.source_kind, SourceKind):
            raise BoundaryError.for_field("source_kind", "must be SourceKind")
        if not isinstance(self.observed_at, UtcTimestamp):
            raise BoundaryError.for_field("observed_at", "must be UtcTimestamp")
        if self.source_record_id is not None and not isinstance(self.source_record_id, str):
            raise BoundaryError.for_field("source_record_id", "must be a string or None")
        if self.input_sha256 is not None and not isinstance(self.input_sha256, Sha256):
            raise BoundaryError.for_field("input_sha256", "must be Sha256 or None")
        if self.parameters_sha256 is not None and not isinstance(self.parameters_sha256, Sha256):
            raise BoundaryError.for_field("parameters_sha256", "must be Sha256 or None")
        object.__setattr__(self, "source_name", _text(self.source_name, "source_name"))
        if self.source_record_id is not None:
            object.__setattr__(
                self, "source_record_id", unicodedata.normalize("NFC", self.source_record_id)
            )

    def to_json(self) -> str:
        value = CanonicalJsonObject((
            ("input_sha256", None if self.input_sha256 is None else str(self.input_sha256)),
            ("observed_at", str(self.observed_at)),
            ("parameters_sha256", None if self.parameters_sha256 is None else str(self.parameters_sha256)),
            ("provenance_id", str(self.provenance_id)),
            ("source_kind", self.source_kind.value),
            ("source_name", self.source_name),
            ("source_record_id", self.source_record_id),
        ))
        return canonical_json_bytes(value).decode("ascii")

    @classmethod
    def from_json(cls, payload: str) -> Provenance:
        fields = _fields(_object(parse_canonical_json(payload), "Provenance"), frozenset((
            "input_sha256", "observed_at", "parameters_sha256", "provenance_id",
            "source_kind", "source_name", "source_record_id",
        )), "Provenance")
        source_record_id = fields["source_record_id"]
        input_hash = fields["input_sha256"]
        parameters_hash = fields["parameters_sha256"]
        return cls(
            ProvenanceId(_string(fields["provenance_id"], "provenance_id")),
            SourceKind(_string(fields["source_kind"], "source_kind")),
            _string(fields["source_name"], "source_name"),
            None if source_record_id is None else _string(source_record_id, "source_record_id"),
            UtcTimestamp(_string(fields["observed_at"], "observed_at")),
            None if input_hash is None else Sha256(_string(input_hash, "input_sha256")),
            None if parameters_hash is None else Sha256(_string(parameters_hash, "parameters_sha256")),
        )


@dataclass(frozen=True, slots=True)
class SourceLocator:
    asset_id: AssetId
    page_start: int
    page_end: int
    block_id: str
    char_start: int
    char_end: int

    def __post_init__(self) -> None:
        if not isinstance(self.asset_id, AssetId):
            raise BoundaryError.for_field("asset_id", "must be AssetId")
        if not isinstance(self.page_start, int) or isinstance(self.page_start, bool) or self.page_start < 1:
            raise BoundaryError.for_field("page_start", "must be an integer at least 1")
        if not isinstance(self.page_end, int) or isinstance(self.page_end, bool) or self.page_end < self.page_start:
            raise BoundaryError.for_field("page_end", "must be at least page_start")
        if not isinstance(self.char_start, int) or isinstance(self.char_start, bool) or self.char_start < 0:
            raise BoundaryError.for_field("char_start", "must be a nonnegative integer")
        if not isinstance(self.char_end, int) or isinstance(self.char_end, bool) or self.char_end < self.char_start:
            raise BoundaryError.for_field("char_end", "must be at least char_start")
        object.__setattr__(self, "block_id", _text(self.block_id, "block_id"))

    def _value(self) -> CanonicalJsonObject:
        return CanonicalJsonObject((
            ("asset_id", str(self.asset_id)), ("block_id", self.block_id),
            ("char_end", self.char_end), ("char_start", self.char_start),
            ("page_end", self.page_end), ("page_start", self.page_start),
        ))


@dataclass(frozen=True, slots=True)
class EvidenceText:
    text: str
    evidence: tuple[SourceLocator, ...]

    def __post_init__(self) -> None:
        object.__setattr__(self, "text", _text(self.text, "text"))
        if not isinstance(self.evidence, tuple) or not all(isinstance(item, SourceLocator) for item in self.evidence):
            raise BoundaryError.for_field("evidence", "must be a tuple of SourceLocator")

    def to_json(self) -> str:
        value = CanonicalJsonObject((("evidence", tuple(item._value() for item in self.evidence)), ("text", self.text)))
        return canonical_json_bytes(value).decode("ascii")

    @classmethod
    def from_json(cls, payload: str) -> EvidenceText:
        fields = _fields(_object(parse_canonical_json(payload), "EvidenceText"), frozenset(("evidence", "text")), "EvidenceText")
        raw_evidence = fields["evidence"]
        if not isinstance(raw_evidence, tuple):
            raise BoundaryError.for_field("evidence", "must be an array")
        locators: list[SourceLocator] = []
        for value in raw_evidence:
            locator = _fields(_object(value, "SourceLocator"), frozenset((
                "asset_id", "block_id", "char_end", "char_start", "page_end", "page_start",
            )), "SourceLocator")
            locators.append(SourceLocator(
                AssetId(_string(locator["asset_id"], "asset_id")),
                _integer(locator["page_start"], "page_start"),
                _integer(locator["page_end"], "page_end"),
                _string(locator["block_id"], "block_id"),
                _integer(locator["char_start"], "char_start"),
                _integer(locator["char_end"], "char_end"),
            ))
        return cls(_string(fields["text"], "text"), tuple(locators))
