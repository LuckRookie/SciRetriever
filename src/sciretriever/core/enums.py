from enum import Enum


class AssetRole(str, Enum):
    PRIMARY_PDF = "primary_pdf"
    SUPPLEMENTARY_PDF = "supplementary_pdf"
    XML = "xml"
    HTML = "html"


class AssetIntentState(str, Enum):
    PENDING = "pending"
    PUBLISHED = "published"
    FINALIZED = "finalized"
    ABANDONED = "abandoned"


class JobState(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    RETRYABLE = "retryable"
    PAUSED = "paused"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


NONTERMINAL_JOB_STATES = frozenset(
    {
        JobState.PENDING,
        JobState.ACTIVE,
    }
)


class AttemptOutcome(str, Enum):
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    RETRYABLE = "retryable"
    CANCELLED = "cancelled"


class ProcessingStage(str, Enum):
    RAW_ACCEPTANCE = "raw_acceptance"
    NORMALIZATION = "normalization"
    ENRICHMENT = "enrichment"
    PACKAGE_VALIDATION = "package_validation"
    PUBLICATION = "publication"


class ProcessingRunState(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"


class PackageQuality(str, Enum):
    PDF_BACKED = "pdf_backed"
    LIMITED_XML_HTML = "limited_xml_html"


class DomainRunStatus(str, Enum):
    PENDING = "pending"
    ACTIVE = "active"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELLED = "cancelled"
