from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path


class ConfigCheckMode(str, Enum):
    OFFLINE = "offline"
    RUNTIME = "runtime"


@dataclass(frozen=True, slots=True)
class PathsConfig:
    catalog: Path | None = None
    storage_root: Path | None = None


@dataclass(frozen=True, slots=True)
class CredentialsConfig:
    unpaywall_email: str | None = field(default=None, repr=False)
    semantic_scholar_api_key: str | None = field(default=None, repr=False)
    elsevier_api_key: str | None = field(default=None, repr=False)
    wiley_api_key: str | None = field(default=None, repr=False)
    springer_api_key: str | None = field(default=None, repr=False)

    def get(self, name: str) -> str | None:
        value = getattr(self, name, None)
        if value is None and name not in {
            "unpaywall_email", "semantic_scholar_api_key", "elsevier_api_key",
            "wiley_api_key", "springer_api_key",
        }:
            raise KeyError(name)
        return value


@dataclass(frozen=True, slots=True)
class DiscoveryConfig:
    sources: tuple[str, ...] | None = None
    limit: int | None = None
    timeout: float | None = None
    taxonomy: str | None = None
    taxonomy_version: str | None = None
    crossref_mailto: str | None = None
    filters: tuple[tuple[str, str], ...] = ()
    label_rules: tuple[tuple[str, tuple[str, ...]], ...] = ()


@dataclass(frozen=True, slots=True)
class SearchConfig:
    level: str | None = None
    limit: int | None = None
    providers: tuple[str, ...] | None = None
    precedence: tuple[str, ...] | None = None
    provider_timeout: float | None = None
    max_concurrency: int | None = None
    crossref_mailto: str | None = None


@dataclass(frozen=True, slots=True)
class PreflightConfig:
    min_free_bytes: int = 1024 * 1024 * 1024
    max_asset_bytes: int = 100 * 1024 * 1024
    readiness: str = "none"
    timeout: float = 10.0


@dataclass(frozen=True, slots=True)
class SciHubConfig:
    enabled: bool = False
    base_url: str | None = None
    allowed_pdf_hosts: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class TranslatorRuleConfig:
    name: str
    landing_url_template: str
    allowed_landing_hosts: tuple[str, ...] = ()
    allowed_pdf_hosts: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class TranslatorConfig:
    enabled: bool = False
    rules: tuple[TranslatorRuleConfig, ...] = ()


@dataclass(frozen=True, slots=True)
class BrowserRuleConfig:
    name: str
    landing_url_template: str
    allowed_landing_hosts: tuple[str, ...]
    allowed_pdf_hosts: tuple[str, ...]
    allowed_network_hosts: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class BrowserConfig:
    enabled: bool = False
    profile_dir: Path | None = field(default=None, repr=False)
    max_profile_bytes: int = 512 * 1024 * 1024
    max_profile_files: int = 20_000
    rules: tuple[BrowserRuleConfig, ...] = ()
    profile_reference: Path | None = field(default=None, repr=False, compare=False)


@dataclass(frozen=True, slots=True)
class AcquisitionConfig:
    providers: tuple[str, ...] | None = None
    timeout: float | None = None
    provider_concurrency: int | None = None
    host_concurrency: int | None = None
    host_min_interval: float | None = None
    max_asset_bytes: int | None = None
    forbidden_urls: Path | None = None
    include_xml: bool | None = None
    include_html: bool | None = None
    preflight: PreflightConfig = PreflightConfig()
    sci_hub: SciHubConfig = SciHubConfig()
    translator: TranslatorConfig = TranslatorConfig()
    browser: BrowserConfig = BrowserConfig()


@dataclass(frozen=True, slots=True)
class PackageConfig:
    max_input_bytes: int | None = None
    max_pages: int | None = None
    max_structural_units: int | None = None
    max_depth: int | None = None
    max_elements: int | None = None
    max_text_characters: int | None = None


@dataclass(frozen=True, slots=True)
class MinerUConfig:
    mode: str = "disabled"
    endpoint: str | None = None
    auth_env: str | None = field(default=None, repr=False)
    remote_upload: bool = False
    service_version: str = "3.4.4"
    api_protocol: int = 2
    backend: str = "vlm-engine"
    model: str | None = None
    overall_deadline: float = 900.0
    poll_interval: float = 2.0
    max_archive_bytes: int = 512 * 1024 * 1024
    max_json_bytes: int = 128 * 1024 * 1024
    max_pages: int = 2000
    max_blocks: int = 500_000
    max_spans: int = 2_000_000
    max_text_characters: int = 100_000_000
    max_image_bytes: int = 64 * 1024 * 1024
    max_archive_files: int = 10_000
    max_extracted_bytes: int = 1024 * 1024 * 1024
    max_file_bytes: int = 256 * 1024 * 1024
    max_compression_ratio: int = 200
    max_images: int = 5000
    max_json_depth: int = 100
    max_json_elements: int = 2_000_000
    max_json_string_characters: int = 100_000_000
    max_upload_bytes: int = 100 * 1024 * 1024
    max_attempts: int = 3


@dataclass(frozen=True, slots=True)
class LLMConfig:
    endpoint: str | None = None
    model: str | None = None
    credential_env: str | None = field(default=None, repr=False)
    timeout: float = 120.0
    max_output_tokens: int = 16_384
    max_input_characters: int = 200_000
    max_source_units: int = 5_000


@dataclass(frozen=True, slots=True)
class AnalysisConfig:
    mineru: MinerUConfig = MinerUConfig()
    llm: LLMConfig = LLMConfig()


@dataclass(frozen=True, slots=True)
class ExpansionConfig:
    direction: str = "references"
    depth: int = 0
    providers: tuple[str, ...] = ("openalex", "semantic-scholar")
    max_provider_calls: int = 10
    page_size: int = 100


@dataclass(frozen=True, slots=True)
class CurationConfig:
    output_format: str = "json"


@dataclass(frozen=True, slots=True)
class ExportConfig:
    output_format: str = "jsonl"
    include_references: bool = False


@dataclass(frozen=True, slots=True)
class SciRetrieverConfig:
    schema_version: int
    paths: PathsConfig = PathsConfig()
    credentials: CredentialsConfig = field(default_factory=CredentialsConfig, repr=False)
    discovery: DiscoveryConfig = DiscoveryConfig()
    search: SearchConfig = SearchConfig()
    acquisition: AcquisitionConfig = AcquisitionConfig()
    analysis: AnalysisConfig = AnalysisConfig()
    package: PackageConfig = PackageConfig()
    expansion: ExpansionConfig = ExpansionConfig()
    curation: CurationConfig = CurationConfig()
    export: ExportConfig = ExportConfig()
    document_start_interval_seconds: float = 30.0


__all__ = (
    "AcquisitionConfig", "AnalysisConfig", "BrowserConfig", "BrowserRuleConfig",
    "ConfigCheckMode", "CredentialsConfig", "CurationConfig", "DiscoveryConfig",
    "ExpansionConfig", "ExportConfig", "LLMConfig", "MinerUConfig", "PackageConfig",
    "PathsConfig", "PreflightConfig", "SciHubConfig", "SciRetrieverConfig", "SearchConfig",
    "TranslatorConfig", "TranslatorRuleConfig",
)
