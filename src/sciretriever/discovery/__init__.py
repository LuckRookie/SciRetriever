"""Stable provider-neutral literature discovery API."""

from sciretriever.core.contracts import DownloadManifestEntry, SearchSpec
from sciretriever.errors import ProviderErrorCategory, ProviderSearchError

from .dedup import deduplicate_candidates, merge_candidates
from .labeling import (
    KeywordRuleLabeler,
    LabelInput,
    LabelResult,
    LabeledCandidate,
    Labeler,
    label_candidate,
    label_input_sha256,
)
from .manifest import discover_to_jsonl, write_manifest
from .models import Candidate, MergedCandidate, ProviderRecord
from .normalize import clean_text, identifier_sort_key, normalize_record, normalize_records
from .pipeline import discover
from .search import (
    DEFAULT_MAX_CONCURRENCY,
    DEFAULT_PROVIDER_TIMEOUT_SECONDS,
    DEFAULT_SEARCH_LIMIT,
    MetadataSearchFailure,
    MetadataSearchOutput,
    MetadataSearchRequest,
    MetadataSearchResult,
    MetadataSearchService,
)
from .providers import (
    DEFAULT_MAX_RESPONSE_BYTES,
    ArxivProvider,
    CrossrefProvider,
    DiscoveryProvider,
    EuropePMCProvider,
    ElsevierProvider,
    HttpResponse,
    Transport,
    UrllibTransport,
    OpenAlexProvider,
    SemanticScholarProvider,
    SpringerProvider,
    build_arxiv_provider,
    build_crossref_provider,
    build_europe_pmc_provider,
    build_elsevier_provider,
    build_openalex_provider,
    build_semantic_scholar_provider,
    build_springer_provider,
)


__all__ = (
    "DEFAULT_MAX_RESPONSE_BYTES",
    "DEFAULT_MAX_CONCURRENCY",
    "DEFAULT_PROVIDER_TIMEOUT_SECONDS",
    "DEFAULT_SEARCH_LIMIT",
    "ArxivProvider",
    "Candidate",
    "CrossrefProvider",
    "DiscoveryProvider",
    "DownloadManifestEntry",
    "EuropePMCProvider",
    "ElsevierProvider",
    "HttpResponse",
    "OpenAlexProvider",
    "SemanticScholarProvider",
    "SpringerProvider",
    "KeywordRuleLabeler",
    "LabelInput",
    "LabelResult",
    "LabeledCandidate",
    "Labeler",
    "MergedCandidate",
    "MetadataSearchFailure",
    "MetadataSearchOutput",
    "MetadataSearchRequest",
    "MetadataSearchResult",
    "MetadataSearchService",
    "ProviderErrorCategory",
    "ProviderRecord",
    "ProviderSearchError",
    "SearchSpec",
    "Transport",
    "UrllibTransport",
    "build_arxiv_provider",
    "build_crossref_provider",
    "build_europe_pmc_provider",
    "build_elsevier_provider",
    "build_openalex_provider",
    "build_semantic_scholar_provider",
    "build_springer_provider",
    "clean_text",
    "deduplicate_candidates",
    "discover",
    "discover_to_jsonl",
    "identifier_sort_key",
    "label_candidate",
    "label_input_sha256",
    "merge_candidates",
    "normalize_record",
    "normalize_records",
    "write_manifest",
)
