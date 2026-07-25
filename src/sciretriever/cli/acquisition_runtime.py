from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from sciretriever.acquisition.browser import (
    PlaywrightBrowserRunner, build_browser_resolvers, validate_browser_profile,
)
from sciretriever.acquisition.candidate_executor import CandidateExecutor
from sciretriever.acquisition.candidate_resolution import CandidateResolver
from sciretriever.acquisition.controls import HostBudget, HostBudgetManager
from sciretriever.acquisition.identity_validation import ContentIdentityValidator
from sciretriever.acquisition.policy_files import read_policy_lines
from sciretriever.acquisition.providers import (
    ArxivResolver, CrossrefResolver, DirectHttpsResolver, EuropePmcResolver,
    OpenAlexResolver, SemanticScholarResolver, UnpaywallResolver,
)
from sciretriever.acquisition.providers_p5 import ElsevierResolver, SpringerResolver, WileyResolver
from sciretriever.acquisition.sci_hub import SciHubResolver
from sciretriever.acquisition.service import WorkVersionAcquisitionService
from sciretriever.acquisition.transport import MAX_RESPONSE_BYTES, UrllibAcquisitionTransport
from sciretriever.acquisition.translator import build_translator_resolvers
from sciretriever.acquisition.url_policy import UrlPolicy
from sciretriever.catalog import AssetRepository
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.config import (
    BrowserConfig, CredentialsConfig, SciHubConfig, TranslatorConfig, get_credential,
)
from sciretriever.errors import SciRetrieverError
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


DEFAULT_ACQUISITION_PROVIDERS = (
    "direct", "arxiv", "crossref", "unpaywall", "europe-pmc", "openalex",
    "semantic-scholar", "elsevier", "wiley", "springer",
)
_CREDENTIALS = {
    "unpaywall": ("SCIRETRIEVER_UNPAYWALL_EMAIL", "unpaywall_email"),
    "semantic-scholar": ("SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY", "semantic_scholar_api_key"),
    "elsevier": ("SCIRETRIEVER_ELSEVIER_API_KEY", "elsevier_api_key"),
    "wiley": ("SCIRETRIEVER_WILEY_API_KEY", "wiley_api_key"),
    "springer": ("SCIRETRIEVER_SPRINGER_API_KEY", "springer_api_key"),
}


@dataclass(frozen=True, slots=True)
class AcquisitionCliConfig:
    providers: tuple[str, ...]
    provider_concurrency: int
    host_concurrency: int
    host_min_interval: float
    max_asset_bytes: int = MAX_RESPONSE_BYTES
    forbidden_urls: Path | None = None
    credentials: CredentialsConfig = CredentialsConfig()
    sci_hub: SciHubConfig = SciHubConfig()
    translator: TranslatorConfig = TranslatorConfig()
    browser: BrowserConfig = BrowserConfig()


def _credential(config: AcquisitionCliConfig, provider: str) -> str | None:
    env_name, field = _CREDENTIALS[provider]
    return get_credential(env_name) or config.credentials.get(field)


def _resolvers(
    config: AcquisitionCliConfig, transport: UrllibAcquisitionTransport,
) -> dict[str, CandidateResolver]:
    builders = {
        "direct": lambda: DirectHttpsResolver(),
        "arxiv": lambda: ArxivResolver(),
        "crossref": lambda: CrossrefResolver(transport),
        "europe-pmc": lambda: EuropePmcResolver(transport),
        "openalex": lambda: OpenAlexResolver(transport),
        "semantic-scholar": lambda: SemanticScholarResolver(
            transport, _credential(config, "semantic-scholar")),
        "unpaywall": lambda: UnpaywallResolver(
            transport, _credential(config, "unpaywall") or ""),
        "elsevier": lambda: ElsevierResolver(transport, _credential(config, "elsevier")),
        "wiley": lambda: WileyResolver(_credential(config, "wiley")),
        "springer": lambda: SpringerResolver(transport, _credential(config, "springer")),
        "sci-hub": lambda: SciHubResolver(transport, config.sci_hub),
    }
    values: dict[str, CandidateResolver] = {}
    for provider in config.providers:
        try:
            values[provider] = builders[provider]()
        except (SciRetrieverError, ValueError):
            continue
    return values


def build_acquisition_service(
    config: AcquisitionCliConfig, engine: CatalogEngine, root: Path,
) -> WorkVersionAcquisitionService:
    validate_browser_profile(config.browser, root)
    forbidden = () if config.forbidden_urls is None else read_policy_lines(config.forbidden_urls)
    transport = UrllibAcquisitionTransport(
        UrlPolicy(forbidden_urls=forbidden), max_bytes=config.max_asset_bytes)
    budgets = HostBudgetManager(HostBudget(config.host_concurrency, config.host_min_interval))
    assets = AssetRepository(engine)
    runner = (PlaywrightBrowserRunner(config.browser, max_asset_bytes=config.max_asset_bytes)
              if config.browser.enabled else None)
    return WorkVersionAcquisitionService(
        assets,
        AssetAcceptanceCoordinator(assets, RawAssetStore(root)),
        _resolvers(config, transport),
        CandidateExecutor(transport, budgets=budgets, browser_runner=runner,
                          identity_validator=ContentIdentityValidator()),
        translator_resolvers=build_translator_resolvers(transport, config.translator.rules),
        browser_resolvers=build_browser_resolvers(config.browser.rules),
        provider_concurrency=config.provider_concurrency,
        budgets=budgets,
    )


__all__ = (
    "AcquisitionCliConfig", "DEFAULT_ACQUISITION_PROVIDERS", "MAX_RESPONSE_BYTES",
    "build_acquisition_service",
)
