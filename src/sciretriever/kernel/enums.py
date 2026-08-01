from enum import Enum, unique


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
    ENDNOTE_XML = "endnote-xml"
