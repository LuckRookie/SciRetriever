"""Argument parsing and runtime assembly for WorkVersion download backfill."""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path
import sys

from sciretriever.acquisition.backfill import DownloadBackfillResult, DownloadBackfillService
from sciretriever.acquisition.browser import (
    PlaywrightBrowserRunner, build_browser_resolvers, validate_browser_profile,
)
from sciretriever.acquisition.candidate_executor import CandidateExecutor
from sciretriever.acquisition.candidate_resolution import CandidateResolver
from sciretriever.acquisition.controls import HostBudget, HostBudgetManager
from sciretriever.acquisition.identity_validation import ContentIdentityValidator
from sciretriever.acquisition.providers import (
    ArxivResolver,
    CrossrefResolver,
    DirectHttpsResolver,
    EuropePmcResolver,
    OpenAlexResolver,
    SemanticScholarResolver,
    UnpaywallResolver,
)
from sciretriever.acquisition.providers_p5 import ElsevierResolver, SpringerResolver, WileyResolver
from sciretriever.acquisition.policy_files import read_policy_lines
from sciretriever.acquisition.service import WorkVersionAcquisitionService
from sciretriever.acquisition.sci_hub import SciHubResolver
from sciretriever.acquisition.transport import MAX_RESPONSE_BYTES, UrllibAcquisitionTransport
from sciretriever.acquisition.translator import build_translator_resolvers
from sciretriever.acquisition.url_policy import UrlPolicy
from sciretriever.catalog import (
    AssetRepository,
    LibraryFilters,
    WorkVersionDownloadRepository,
    canonical_json,
    open_catalog_engine,
)
from sciretriever.config import (
    ACQUISITION_PROVIDERS, BrowserConfig, CredentialsConfig, SciHubConfig, TranslatorConfig, get_credential,
)
from sciretriever.errors import SciRetrieverError
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


DEFAULT_PROVIDERS = (
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


def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.description = "Download missing assets for existing WorkVersions."
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--storage-root", required=True, type=Path)
    exact = parser.add_mutually_exclusive_group()
    exact.add_argument("--work-version-id")
    exact.add_argument("--work-id")
    exact.add_argument("--all-missing", action="store_true")
    parser.add_argument("--query")
    parser.add_argument("--author")
    parser.add_argument("--year", type=int)
    parser.add_argument("--publisher")
    parser.add_argument("--venue")
    parser.add_argument("--tag")
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--provider", action="append", choices=tuple(sorted(ACQUISITION_PROVIDERS)))
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--provider-concurrency", type=int, default=4)
    parser.add_argument("--host-concurrency", type=int, default=2)
    parser.add_argument("--host-min-interval", type=float, default=0.0)
    parser.add_argument("--max-asset-bytes", type=int, default=MAX_RESPONSE_BYTES)
    parser.add_argument("--forbidden-urls", type=Path)
    parser.add_argument("--xml", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--html", action=argparse.BooleanOptionalAction, default=False)


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    filters = (args.query, args.author, args.year, args.publisher, args.venue, args.tag)
    exact = args.work_version_id is not None or args.work_id is not None or args.all_missing
    if exact and any(value is not None for value in filters):
        parser.error("exact and --all-missing selectors cannot be combined with query or filters")
    if not exact and not any(value is not None for value in filters):
        parser.error("download requires an exact ID, query/filter, or --all-missing")
    for name in ("limit", "provider_concurrency", "host_concurrency", "max_asset_bytes"):
        if getattr(args, name) <= 0:
            parser.error(f"--{name.replace('_', '-')} must be positive")
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    if args.host_min_interval < 0:
        parser.error("--host-min-interval must be nonnegative")
    providers = args.provider or list(DEFAULT_PROVIDERS)
    if len(providers) != len(set(providers)):
        parser.error("--provider must not contain duplicates")
    args.provider = providers
    sci_hub: SciHubConfig | None = getattr(args, "_config_sci_hub", None)
    if "sci-hub" in providers and (sci_hub is None or not sci_hub.enabled):
        parser.error("sci-hub requires an explicitly enabled [acquisition.sci_hub] config")


def _credential(args: argparse.Namespace, provider: str) -> str | None:
    env_name, field = _CREDENTIALS[provider]
    configured: CredentialsConfig | None = getattr(args, "_config_credentials", None)
    return get_credential(env_name) or (configured.get(field) if configured is not None else None)


def _forbidden(path: Path | None) -> tuple[str, ...]:
    if path is None:
        return ()
    return read_policy_lines(path)


def _resolvers(args: argparse.Namespace, transport) -> dict[str, CandidateResolver]:
    values: dict[str, CandidateResolver] = {}
    builders = {
        "direct": lambda: DirectHttpsResolver(),
        "arxiv": lambda: ArxivResolver(),
        "crossref": lambda: CrossrefResolver(transport),
        "europe-pmc": lambda: EuropePmcResolver(transport),
        "openalex": lambda: OpenAlexResolver(transport),
        "semantic-scholar": lambda: SemanticScholarResolver(transport, _credential(args, "semantic-scholar")),
        "unpaywall": lambda: UnpaywallResolver(transport, _credential(args, "unpaywall") or ""),
        "elsevier": lambda: ElsevierResolver(transport, _credential(args, "elsevier")),
        "wiley": lambda: WileyResolver(_credential(args, "wiley")),
        "springer": lambda: SpringerResolver(transport, _credential(args, "springer")),
        "sci-hub": lambda: SciHubResolver(transport, args._config_sci_hub),
    }
    for provider in args.provider:
        try:
            values[provider] = builders[provider]()
        except (SciRetrieverError, ValueError):
            continue
    return values


def _selection(repository: WorkVersionDownloadRepository, args: argparse.Namespace) -> tuple[str, ...]:
    if args.work_version_id is not None or args.work_id is not None:
        return repository.select_exact(
            work_version_id=args.work_version_id, work_id=args.work_id
        ).work_version_ids
    if args.all_missing:
        return repository.select_all_missing_primary_pdf().work_version_ids
    filters = LibraryFilters(
        author=args.author,
        publication_year=args.year,
        publisher=args.publisher,
        venue=args.venue,
        tag=args.tag,
    )
    return repository.select_library(args.query, filters=filters, limit=args.limit).work_version_ids


async def execute_work_versions(args: argparse.Namespace, selected: tuple[str, ...]):
    root = args.storage_root.expanduser()
    if not root.is_dir() or root.is_symlink():
        raise ValueError("storage root must be an existing real directory")
    browser = getattr(args, "_config_browser", BrowserConfig())
    validate_browser_profile(browser, root)
    engine = open_catalog_engine(args.catalog)
    try:
        repository = WorkVersionDownloadRepository(engine)
        policy = UrlPolicy(forbidden_urls=_forbidden(args.forbidden_urls))
        transport = UrllibAcquisitionTransport(policy, max_bytes=args.max_asset_bytes)
        budget = HostBudget(args.host_concurrency, args.host_min_interval)
        budgets = HostBudgetManager(budget)
        assets = AssetRepository(engine)
        browser_runner = PlaywrightBrowserRunner(
            browser, max_asset_bytes=args.max_asset_bytes,
        ) if browser.enabled else None
        acquisition = WorkVersionAcquisitionService(
            assets,
            AssetAcceptanceCoordinator(assets, RawAssetStore(root)),
            _resolvers(args, transport),
            CandidateExecutor(
                transport, budgets=budgets, browser_runner=browser_runner,
                identity_validator=ContentIdentityValidator(),
            ),
            translator_resolvers=build_translator_resolvers(
                transport,
                getattr(args, "_config_translator", TranslatorConfig()).rules,
            ),
            browser_resolvers=build_browser_resolvers(browser.rules),
            provider_concurrency=args.provider_concurrency,
            budgets=budgets,
        )
        service = DownloadBackfillService(
            repository,
            acquisition,
            tuple(args.provider),
            timeout=args.timeout,
            include_xml=args.xml,
            include_html=args.html,
        )
        args._download_backfill_service = service
        return await service.run(selected)
    finally:
        engine.dispose()


async def _execute(args: argparse.Namespace):
    engine = open_catalog_engine(args.catalog)
    try:
        selected = _selection(WorkVersionDownloadRepository(engine), args)
    finally:
        engine.dispose()
    return await execute_work_versions(args, selected)


def run(args: argparse.Namespace) -> int:
    try:
        result = asyncio.run(_execute(args))
    except KeyboardInterrupt:
        result = interrupted_result(args)
        print(canonical_json(result.to_dict()))
        return 130
    except (OSError, SciRetrieverError, TypeError, ValueError):
        print("sciretriever: error: download failed", file=sys.stderr)
        return 1
    print(canonical_json(result.to_dict()))
    return 130 if result.interrupted else 0


def interrupted_result(args: argparse.Namespace) -> DownloadBackfillResult:
    service: DownloadBackfillService | None = getattr(
        args, "_download_backfill_service", None
    )
    if service is None:
        return DownloadBackfillResult(0, 0, 0, 0, 0, ())
    result = service.last_result
    if result.interrupted:
        return result
    interrupted = max(0, result.selected - len(result.outcomes))
    return DownloadBackfillResult(
        result.selected,
        result.accepted,
        result.reused,
        result.missing,
        interrupted,
        result.outcomes,
    )


__all__ = (
    "configure_parser", "execute_work_versions", "interrupted_result", "run",
    "validate_arguments",
)
