from __future__ import annotations

import hashlib
import re
from datetime import datetime
from enum import Enum, unique
from pathlib import PurePosixPath
from urllib.parse import urlsplit

from pydantic import ConfigDict, RootModel, field_validator

_CANONICAL_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_RFC3339_UTC = re.compile(
    r"^(?P<date>\d{4}-\d{2}-\d{2})T(?P<time>\d{2}:\d{2}:\d{2})"
    r"(?P<fraction>\.\d+)?Z$"
)


class _StringRoot(RootModel[str]):
    model_config = ConfigDict(frozen=True, strict=True)

    def __hash__(self) -> int:
        return hash((type(self), self.root))

    def __str__(self) -> str:
        return self.root


class UuidValue(_StringRoot):
    __hash__ = _StringRoot.__hash__

    @field_validator("root")
    @classmethod
    def validate_uuid(cls, value: str) -> str:
        if _CANONICAL_UUID.fullmatch(value) is None:
            raise ValueError("must be a canonical lowercase UUID")
        return value


class WorkId(UuidValue):
    __hash__ = UuidValue.__hash__


class WorkVersionId(UuidValue):
    __hash__ = UuidValue.__hash__


class CollectionId(UuidValue):
    __hash__ = UuidValue.__hash__


class CollectionRunId(UuidValue):
    __hash__ = UuidValue.__hash__


class BatchRunId(UuidValue):
    __hash__ = UuidValue.__hash__


class AssetId(UuidValue):
    __hash__ = UuidValue.__hash__


class LightDocumentId(UuidValue):
    __hash__ = UuidValue.__hash__


class AnalysisArtifactId(UuidValue):
    __hash__ = UuidValue.__hash__


class MetadataSnapshotId(UuidValue):
    __hash__ = UuidValue.__hash__


class ProvenanceId(UuidValue):
    __hash__ = UuidValue.__hash__


class ExtensionRecordId(UuidValue):
    __hash__ = UuidValue.__hash__


class AdmissionBindingId(UuidValue):
    __hash__ = UuidValue.__hash__


class CurationPlanId(UuidValue):
    __hash__ = UuidValue.__hash__


class VersionRelationId(UuidValue):
    __hash__ = UuidValue.__hash__


class WorkVersionAssetId(UuidValue):
    __hash__ = UuidValue.__hash__


class ObservationId(UuidValue):
    __hash__ = UuidValue.__hash__


class StableIdentifierId(UuidValue):
    __hash__ = UuidValue.__hash__


class MembershipId(UuidValue):
    __hash__ = UuidValue.__hash__


class ReferenceFactId(UuidValue):
    __hash__ = UuidValue.__hash__


class ReferenceSetId(UuidValue):
    __hash__ = UuidValue.__hash__


class ReferenceMemberId(UuidValue):
    __hash__ = UuidValue.__hash__


class TagSetId(UuidValue):
    __hash__ = UuidValue.__hash__


class TagMemberId(UuidValue):
    __hash__ = UuidValue.__hash__


class CollectionCauseId(UuidValue):
    __hash__ = UuidValue.__hash__


class CollectionPathId(UuidValue):
    __hash__ = UuidValue.__hash__


class Sha256(_StringRoot):
    __hash__ = _StringRoot.__hash__

    @field_validator("root")
    @classmethod
    def validate_sha256(cls, value: str) -> str:
        if _SHA256.fullmatch(value) is None:
            raise ValueError("must be lowercase 64-hex SHA-256")
        return value


def sha256_digest(value: bytes) -> Sha256:
    if not isinstance(value, bytes):
        raise TypeError("value must be bytes")
    return Sha256(hashlib.sha256(value).hexdigest())


class RelativeArtifactPath(_StringRoot):
    __hash__ = _StringRoot.__hash__

    @field_validator("root")
    @classmethod
    def validate_path(cls, value: str) -> str:
        parsed = urlsplit(value)
        path = PurePosixPath(value)
        invalid = (
            not value
            or "\\" in value
            or bool(parsed.scheme or parsed.netloc or parsed.query or parsed.fragment)
            or path.is_absolute()
            or value != path.as_posix()
            or any(part in {"", ".", ".."} for part in value.split("/"))
        )
        if invalid:
            raise ValueError("must be a normalized relative POSIX path without traversal")
        return value


class UtcTimestamp(_StringRoot):
    __hash__ = _StringRoot.__hash__

    @field_validator("root")
    @classmethod
    def validate_timestamp(cls, value: str) -> str:
        if _RFC3339_UTC.fullmatch(value) is None:
            raise ValueError("must be RFC3339 UTC ending in Z")
        try:
            datetime.fromisoformat(value[:-1] + "+00:00")
        except ValueError as error:
            raise ValueError("must be a valid UTC date-time") from error
        return value


class _StrEnum(str, Enum):
    pass


@unique
class SourceKind(_StrEnum):
    METADATA_PROVIDER = "metadata-provider"
    ASSET_PROVIDER = "asset-provider"
    PARSER = "parser"
    ANALYSIS_MODEL = "analysis-model"
    USER = "user"


@unique
class AssetRole(_StrEnum):
    PRIMARY_PDF = "primary-pdf"
    SUPPLEMENTARY_PDF = "supplementary-pdf"
    XML = "xml"
    HTML = "html"
    SUPPLEMENTARY = "supplementary"


@unique
class WorkVersionState(_StrEnum):
    UNREVIEWED = "unreviewed"
    ASSET_READY = "asset-ready"
    LIGHT_TEXT_READY = "light-text-ready"
    COMPLETED = "completed"


@unique
class CollectionMode(_StrEnum):
    TOPIC = "topic"
    CITATION = "citation"


@unique
class CollectionRunStatus(_StrEnum):
    CREATED = "created"
    RUNNING = "running"
    NO_TARGET = "no-target"
    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


@unique
class CollectionCauseKind(_StrEnum):
    TOPIC_MATCH = "topic-match"
    SEED = "seed"
    REFERENCE = "reference"
    CITED_BY = "cited-by"


@unique
class CurationDecision(_StrEnum):
    SAME_VERSION = "same-version"
    RELATED_VERSIONS = "related-versions"
    DISTINCT = "distinct"
    DELETE_VERSION = "delete-version"
    DELETE_WORK = "delete-work"


@unique
class DiscoveryRelation(_StrEnum):
    MEMBER = "member"
    SEED = "seed"
    REFERENCE = "reference"
    CITED_BY = "cited-by"


@unique
class CitationDirection(_StrEnum):
    REFERENCES = "references"
    CITED_BY = "cited-by"
    BOTH = "both"


@unique
class MissingStep(_StrEnum):
    PRIMARY_PDF = "primary-pdf"
    LIGHT_DOCUMENT = "light-document"
    COMPLETION = "completion"


@unique
class VersionRole(_StrEnum):
    FORMAL = "formal"
    ACCEPTED_MANUSCRIPT = "accepted-manuscript"
    PREPRINT = "preprint"
    OTHER = "other"


@unique
class BatchType(_StrEnum):
    PROCESS = "process"
    BIBLIOGRAPHY_IMPORT = "bibliography-import"
    BIBLIOGRAPHY_EXPORT = "bibliography-export"


@unique
class BatchStatus(_StrEnum):
    CREATED = "created"
    RUNNING = "running"
    NO_TARGET = "no-target"
    COMPLETED = "completed"
    PARTIAL = "partial"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


@unique
class PublicationPhase(_StrEnum):
    NONE = "none"
    PREPARED = "prepared"
    PUBLISHED = "published"


@unique
class BibliographyFormat(_StrEnum):
    BIBTEX = "bibtex"
    RIS = "ris"
    CSL_JSON = "csl-json"
