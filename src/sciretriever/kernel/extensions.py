from __future__ import annotations

import unicodedata
from dataclasses import dataclass
from typing import Protocol

from pydantic import ValidationError

from sciretriever.kernel.errors import BoundaryError
from sciretriever.kernel.json import (
    CanonicalJsonObject,
    CanonicalJsonValue,
    canonical_json_bytes,
    parse_canonical_json,
)
from sciretriever.model.primitives import ExtensionRecordId, Sha256, sha256_digest


def _text(value: str, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise BoundaryError.for_field(field, "must be a nonblank string")
    return unicodedata.normalize("NFC", value)


def _fields(value: CanonicalJsonValue) -> dict[str, CanonicalJsonValue]:
    if not isinstance(value, CanonicalJsonObject):
        raise BoundaryError.for_field("OpaqueExtensionRecord", "must be a JSON object")
    fields = dict(value.entries)
    expected = frozenset(("namespace", "payload", "payload_sha256", "record_id", "revision"))
    if fields.keys() != expected:
        raise BoundaryError.for_field(
            "OpaqueExtensionRecord", "must contain exactly the required fields"
        )
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
class OpaqueExtensionRecord:
    namespace: str
    record_id: ExtensionRecordId
    revision: int
    payload_sha256: Sha256
    payload: CanonicalJsonValue

    def __post_init__(self) -> None:
        object.__setattr__(self, "namespace", _text(self.namespace, "namespace"))
        if not isinstance(self.record_id, ExtensionRecordId):
            raise BoundaryError.for_field("record_id", "must be ExtensionRecordId")
        if (
            not isinstance(self.revision, int)
            or isinstance(self.revision, bool)
            or self.revision < 1
        ):
            raise BoundaryError.for_field("revision", "must be an integer at least 1")
        if not isinstance(self.payload_sha256, Sha256):
            raise BoundaryError.for_field("payload_sha256", "must be Sha256")
        if sha256_digest(canonical_json_bytes(self.payload)) != self.payload_sha256:
            raise BoundaryError.for_field(
                "payload_sha256", "does not match canonical payload bytes"
            )

    def to_json(self) -> str:
        value = CanonicalJsonObject(
            (
                ("namespace", self.namespace),
                ("payload", self.payload),
                ("payload_sha256", str(self.payload_sha256)),
                ("record_id", str(self.record_id)),
                ("revision", self.revision),
            )
        )
        return canonical_json_bytes(value).decode("ascii")

    @classmethod
    def from_json(cls, payload: str) -> OpaqueExtensionRecord:
        fields = _fields(parse_canonical_json(payload))
        try:
            return cls(
                _string(fields["namespace"], "namespace"),
                ExtensionRecordId(_string(fields["record_id"], "record_id")),
                _integer(fields["revision"], "revision"),
                Sha256(_string(fields["payload_sha256"], "payload_sha256")),
                fields["payload"],
            )
        except ValidationError as error:
            raise BoundaryError.for_field(
                "extension_record", "must contain valid primitive values"
            ) from error


def validate_page_request(
    *, after_record_id: ExtensionRecordId | None, limit: int
) -> tuple[ExtensionRecordId | None, int]:
    if after_record_id is not None and not isinstance(after_record_id, ExtensionRecordId):
        raise BoundaryError.for_field("after_record_id", "must be ExtensionRecordId or None")
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 1000:
        raise BoundaryError.for_field("limit", "must be an integer from 1 through 1000")
    return after_record_id, limit


class OpaqueExtensionRecordStorePort(Protocol):
    def get(self, namespace: str, record_id: ExtensionRecordId) -> OpaqueExtensionRecord | None: ...

    def list_namespace(
        self, namespace: str, after_record_id: ExtensionRecordId | None, limit: int
    ) -> tuple[OpaqueExtensionRecord, ...]: ...

    def compare_and_set(
        self,
        namespace: str,
        record_id: ExtensionRecordId,
        expected_revision: int | None,
        payload: CanonicalJsonValue,
    ) -> OpaqueExtensionRecord: ...

    def delete(
        self, namespace: str, record_id: ExtensionRecordId, expected_revision: int
    ) -> None: ...
