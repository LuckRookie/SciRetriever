"""Neutral literature identity and authoritative-reference models.

This module deliberately contains only the representation of literature facts.
Identity matching, metadata precedence, status derivation, and reference
publication belong to the Literature feature module, not to these models.
"""

from __future__ import annotations

import re
import unicodedata
from enum import Enum, unique
from typing import TYPE_CHECKING, Annotated, Literal, TypeAlias
from urllib.parse import urlsplit

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    ValidationInfo,
    field_validator,
    model_validator,
)
from pydantic.errors import PydanticUndefinedAnnotation

from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ReferenceId,
    Sha256,
)

if TYPE_CHECKING:
    from sciretriever.model.metadata import LiteratureMetadata


class _LiteratureModel(BaseModel):
    """Frozen, closed, strict base for neutral Model contracts."""

    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        hide_input_in_errors=True,
        strict=True,
    )


def _nonblank_text(value: object, *, field_name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{field_name} must be a string")
    normalized = unicodedata.normalize("NFC", value.strip())
    if not normalized:
        raise ValueError(f"{field_name} must be nonblank")
    return normalized


def _optional_text(value: object, *, field_name: str) -> str | None:
    if value is None:
        return None
    return _nonblank_text(value, field_name=field_name)


def _as_tuple(value: object, *, field_name: str) -> tuple[object, ...]:
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    raise TypeError(f"{field_name} must be a list or tuple")


def _enum_value(enum_type: type[Enum], value: object, *, field_name: str) -> Enum:
    if isinstance(value, enum_type):
        return value
    if isinstance(value, str):
        try:
            return enum_type(value)
        except ValueError as error:
            raise ValueError(f"{field_name} must be a supported value") from error
    raise TypeError(f"{field_name} must be a supported value")


_ORCID = re.compile(r"^\d{4}-\d{4}-\d{4}-[0-9X]{4}$")
_ROR = re.compile(r"^0[0-9a-z]{8}$")
_DOI = re.compile(r"^10\.\d{4,9}/\S+$", re.IGNORECASE)
_ARXIV_NEW = re.compile(r"^\d{4}\.\d{4,5}$")
_ARXIV_OLD = re.compile(r"^[A-Za-z][A-Za-z0-9-]*(?:\.[A-Za-z]{2})?/\d{7}$")
_ARXIV_REVISION = re.compile(r"v\d+$", re.IGNORECASE)
_PMID = re.compile(r"^\d+$")
_PMCID = re.compile(r"^PMC\d+$", re.IGNORECASE)


class Identifier(_LiteratureModel):
    """A canonical, namespaced identifier for a concrete Literature."""

    namespace: str
    value: str

    @field_validator("namespace", mode="before")
    @classmethod
    def validate_namespace(cls, value: object) -> str:
        normalized = _nonblank_text(value, field_name="namespace").lower()
        return normalized

    @field_validator("value", mode="before")
    @classmethod
    def validate_value(cls, value: object, info: ValidationInfo[object]) -> str:
        normalized = _nonblank_text(value, field_name="value")
        namespace = info.data.get("namespace")
        if not isinstance(namespace, str):
            raise ValueError("namespace must be validated before value")
        if namespace == "doi":
            return cls._canonical_doi(normalized)
        if namespace == "arxiv":
            return cls._canonical_arxiv(normalized)
        if namespace == "pmid":
            if _PMID.fullmatch(normalized) is None:
                raise ValueError("pmid must be a sequence of digits")
            return normalized
        if namespace == "pmcid":
            if _PMCID.fullmatch(normalized) is None:
                raise ValueError("pmcid must be PMC followed by digits")
            return "PMC" + normalized[3:]
        return normalized

    @staticmethod
    def _canonical_doi(value: str) -> str:
        candidate = value
        if candidate.lower().startswith("doi:"):
            candidate = candidate[4:].strip()
        elif candidate.lower().startswith(("http://", "https://")):
            parsed = urlsplit(candidate)
            hostname = parsed.hostname.lower() if parsed.hostname is not None else None
            if (
                parsed.scheme.lower() not in {"http", "https"}
                or hostname not in {"doi.org", "dx.doi.org"}
                or parsed.username is not None
                or parsed.password is not None
                or parsed.port is not None
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("doi URL must use a supported resolver")
            candidate = parsed.path.lstrip("/")
        if _DOI.fullmatch(candidate) is None or any(character.isspace() for character in candidate):
            raise ValueError("doi must be a valid DOI")
        return candidate.lower()

    @staticmethod
    def _canonical_arxiv(value: str) -> str:
        candidate = value
        if candidate.lower().startswith("arxiv:"):
            candidate = candidate[6:].strip()
        elif candidate.lower().startswith(("http://", "https://")):
            parsed = urlsplit(candidate)
            hostname = parsed.hostname.lower() if parsed.hostname is not None else None
            if (
                parsed.scheme.lower() not in {"http", "https"}
                or hostname != "arxiv.org"
                or parsed.username is not None
                or parsed.password is not None
                or parsed.port is not None
                or parsed.query
                or parsed.fragment
            ):
                raise ValueError("arxiv URL must use the official host")
            path = parsed.path.lstrip("/")
            if path.startswith("abs/"):
                candidate = path[4:]
            elif path.startswith("pdf/"):
                candidate = path[4:]
            else:
                raise ValueError("arxiv URL must use /abs/ or /pdf/")
        if candidate.lower().endswith(".pdf"):
            candidate = candidate[:-4]
        candidate = _ARXIV_REVISION.sub("", candidate)
        if _ARXIV_NEW.fullmatch(candidate) is None and _ARXIV_OLD.fullmatch(candidate) is None:
            raise ValueError("arxiv must be an official new-style or old-style identifier")
        return candidate


@unique
class AuthorKind(str, Enum):
    PERSON = "person"
    ORGANIZATION = "organization"
    UNKNOWN = "unknown"


class Affiliation(_LiteratureModel):
    """A source-explicit affiliation attached to one literature author."""

    name: str
    ror: str | None = None

    @field_validator("name", mode="before")
    @classmethod
    def validate_name(cls, value: object) -> str:
        return _nonblank_text(value, field_name="name")

    @field_validator("ror", mode="before")
    @classmethod
    def validate_ror(cls, value: object) -> str | None:
        if value is None:
            return None
        normalized = _nonblank_text(value, field_name="ror").lower()
        if _ROR.fullmatch(normalized) is None:
            raise ValueError("ror must be a bare ROR identifier")
        return normalized


class Author(_LiteratureModel):
    """One structured author signature in one concrete Literature."""

    kind: AuthorKind
    display_name: str
    given_name: str | None = None
    family_name: str | None = None
    orcid: str | None = None
    affiliations: tuple[Affiliation, ...] = ()

    @field_validator("kind", mode="before")
    @classmethod
    def validate_kind(cls, value: object) -> AuthorKind:
        return _enum_value(AuthorKind, value, field_name="kind")  # type: ignore[return-value]

    @field_validator("display_name", mode="before")
    @classmethod
    def validate_display_name(cls, value: object) -> str:
        return _nonblank_text(value, field_name="display_name")

    @field_validator("given_name", "family_name", mode="before")
    @classmethod
    def validate_name_parts(cls, value: object) -> str | None:
        return _optional_text(value, field_name="name")

    @field_validator("orcid", mode="before")
    @classmethod
    def validate_orcid(cls, value: object) -> str | None:
        if value is None:
            return None
        normalized = _nonblank_text(value, field_name="orcid").upper()
        if _ORCID.fullmatch(normalized) is None:
            raise ValueError("orcid must be a bare hyphenated ORCID")

        digits = normalized.replace("-", "")
        total = 0
        for digit in digits[:-1]:
            total = (total + int(digit)) * 2
        remainder = total % 11
        check = (12 - remainder) % 11
        expected = "X" if check == 10 else str(check)
        if digits[-1] != expected:
            raise ValueError("orcid has an invalid check digit")
        return normalized

    @field_validator("affiliations", mode="before")
    @classmethod
    def normalize_affiliations(cls, value: object) -> tuple[object, ...]:
        return _as_tuple(value, field_name="affiliations")


@unique
class VersionRole(str, Enum):
    PUBLISHED = "published"
    ACCEPTED_MANUSCRIPT = "accepted-manuscript"
    PREPRINT = "preprint"
    OTHER = "other"


@unique
class LiteratureStatus(str, Enum):
    UNREVIEWED = "UNREVIEWED"
    ASSET_READY = "ASSET_READY"
    CONTENT_READY = "CONTENT_READY"


class MetaLiterature(_LiteratureModel):
    """Stable aggregate identity for explicitly connected versions."""

    meta_literature_id: MetaLiteratureId
    representative_literature_id: LiteratureId


class Literature(_LiteratureModel):
    """One concrete Literature version and its current read projection."""

    literature_id: LiteratureId
    meta_literature_id: MetaLiteratureId
    version_role: VersionRole
    metadata: "LiteratureMetadata"
    status: LiteratureStatus

    @field_validator("version_role", mode="before")
    @classmethod
    def validate_version_role(cls, value: object) -> VersionRole:
        return _enum_value(VersionRole, value, field_name="version_role")  # type: ignore[return-value]

    @field_validator("status", mode="before")
    @classmethod
    def validate_status(cls, value: object) -> LiteratureStatus:
        return _enum_value(LiteratureStatus, value, field_name="status")  # type: ignore[return-value]


class Reference(_LiteratureModel):
    """One authoritative directed relation between two concrete Literature IDs."""

    reference_id: ReferenceId
    source_literature_id: LiteratureId
    target_literature_id: LiteratureId

    @model_validator(mode="after")
    def reject_self_reference(self) -> "Reference":
        if self.source_literature_id == self.target_literature_id:
            raise ValueError("reference source and target must differ")
        return self


class ProviderRelationSupport(_LiteratureModel):
    kind: Literal["provider_relation"]
    observation_id: ObservationId


class MetadataReferenceTextSupport(_LiteratureModel):
    kind: Literal["metadata_reference_text"]
    metadata_observation_id: ObservationId
    reference_index: int = Field(strict=True, ge=0)


class ContentReferenceTextSupport(_LiteratureModel):
    kind: Literal["content_reference_text"]
    literature_content_sha256: "Sha256"
    reference_index: int = Field(strict=True, ge=0)


ReferenceSupportSource: TypeAlias = Annotated[
    ProviderRelationSupport | MetadataReferenceTextSupport | ContentReferenceTextSupport,
    Field(discriminator="kind"),
]


class ReferenceSupport(_LiteratureModel):
    """A precise locator supporting one authoritative Reference."""

    reference_id: ReferenceId
    source: ReferenceSupportSource


__all__ = (
    "Affiliation",
    "Author",
    "AuthorKind",
    "ContentReferenceTextSupport",
    "Identifier",
    "Literature",
    "LiteratureStatus",
    "MetadataReferenceTextSupport",
    "MetaLiterature",
    "ProviderRelationSupport",
    "Reference",
    "ReferenceSupport",
    "ReferenceSupportSource",
    "VersionRole",
)


def _finish_literature_model_rebuild() -> None:
    """Resolve the cross-file metadata annotation after either import order."""

    try:
        from sciretriever.model.metadata import LiteratureMetadata
    except (ImportError, AttributeError):
        return
    try:
        Literature.model_rebuild(_types_namespace={"LiteratureMetadata": LiteratureMetadata})
    except PydanticUndefinedAnnotation:
        # ``metadata`` may still be defining its nested Author/Identifier
        # contracts when it imports this module.  The metadata module retries
        # the rebuild after all of its fields have been defined.
        return


_finish_literature_model_rebuild()
