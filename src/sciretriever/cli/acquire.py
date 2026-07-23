"""Argument parsing and runtime assembly for the acquisition CLI."""

from __future__ import annotations

import argparse
import asyncio
from collections.abc import Callable
import math
from pathlib import Path
import signal
import sys

from sqlalchemy.exc import SQLAlchemyError

from sciretriever.acquisition import (
    AcquisitionTarget,
    AdmissionResult,
    AdmissionService,
    ArxivProvider,
    CrossrefProvider,
    DirectHttpsProvider,
    EuropePmcProvider,
    UnpaywallProvider,
    UrllibAcquisitionTransport,
    read_manifest,
)
from sciretriever.acquisition.url_policy import UrlPolicy
from sciretriever.acquisition.models import AcquisitionProvider, AcquisitionResult, AcquisitionTransport
from sciretriever.acquisition.controls import HostBudget
from sciretriever.acquisition.plan import RoutingMode, SourceEntry, SourcePlan
from sciretriever.acquisition.providers_p5 import ElsevierProvider, OpenAlexProvider, SemanticScholarProvider, SpringerProvider, WileyProvider
from sciretriever.acquisition.profiles import PUBLISHER_PROFILES, PublisherProfile, profile_for_provider
from sciretriever.acquisition.orchestrator import AcquisitionRuntime
from sciretriever.catalog import AssetRepository, IdentityResolver, open_catalog_engine
from sciretriever.catalog.jobs import JobRepository
from sciretriever.config import CredentialsConfig, get_credential
from sciretriever.core.contracts import DownloadManifestEntry, Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.errors import AcquisitionError, SciRetrieverError, ValidationError
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


PROVIDERS = (
    "direct", "arxiv", "crossref", "unpaywall", "europe-pmc",
    "openalex", "semantic-scholar", "elsevier", "wiley", "springer",
)
UNPAYWALL_EMAIL_ENV = "SCIRETRIEVER_UNPAYWALL_EMAIL"
_CREDENTIAL_FIELDS = {
    UNPAYWALL_EMAIL_ENV: "unpaywall_email",
    "SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY": "semantic_scholar_api_key",
    "SCIRETRIEVER_ELSEVIER_API_KEY": "elsevier_api_key",
    "SCIRETRIEVER_WILEY_API_KEY": "wiley_api_key",
    "SCIRETRIEVER_SPRINGER_API_KEY": "springer_api_key",
}


def _positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive number") from error
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive number")
    return parsed


def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.description = "Acquire one role-specific asset per input through a bounded foreground source plan."
    intake = parser.add_mutually_exclusive_group()
    intake.add_argument("--manifest", type=Path, metavar="PATH")
    intake.add_argument("--doi", metavar="DOI")
    intake.add_argument("--url", metavar="HTTPS_URL")
    parser.add_argument("--catalog", required=True, type=Path, metavar="PATH")
    parser.add_argument("--storage-root", required=True, type=Path, metavar="PATH")
    sources = parser.add_mutually_exclusive_group()
    sources.add_argument("--provider", choices=PROVIDERS)
    sources.add_argument("--providers", action="append", choices=PROVIDERS, metavar="PROVIDER")
    sources.add_argument("--source-plan", type=Path, metavar="PATH")
    parser.add_argument("--asset-role", choices=tuple(role.value for role in AssetRole), default=AssetRole.PRIMARY_PDF.value)
    parser.add_argument("--routing", choices=tuple(mode.value for mode in RoutingMode), default=RoutingMode.SERIAL.value)
    parser.add_argument("--host-concurrency", type=int)
    parser.add_argument("--host-min-interval", type=float)
    parser.add_argument("--timeout", type=_positive_float, default=30.0)
    parser.add_argument("--forbidden-urls", type=Path, metavar="PATH")


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if args.manifest is None and args.doi is None and args.url is None:
        parser.error("one of --manifest, --doi, or --url is required")
    if args.provider is None and args.providers is None and args.source_plan is None:
        parser.error("one of --provider, --providers, or --source-plan is required")
    if args.url is not None and args.provider != "direct" and args.providers != ["direct"]:
        parser.error("--url requires --provider direct")
    if args.provider == "direct" and args.url is None:
        parser.error("--provider direct requires --url")
    credentials = getattr(args, "_config_credentials", None)
    if args.provider == "unpaywall" and _credential(UNPAYWALL_EMAIL_ENV, credentials) is None:
        parser.error(f"--provider unpaywall requires {UNPAYWALL_EMAIL_ENV}")
    if (args.host_concurrency is not None and args.host_concurrency <= 0) or (
        args.host_min_interval is not None and args.host_min_interval < 0
    ):
        parser.error("host budget values must be positive/nonnegative")


def _credential(env_var: str, credentials: CredentialsConfig | None = None) -> str | None:
    environment_value = get_credential(env_var)
    if environment_value is not None:
        return environment_value
    if credentials is None:
        return None
    return credentials.get(_CREDENTIAL_FIELDS[env_var])


def _provider(
    name: str,
    transport: AcquisitionTransport,
    policy: UrlPolicy,
    *,
    credentials: CredentialsConfig | None = None,
) -> AcquisitionProvider:
    if name == "direct":
        return DirectHttpsProvider(transport, policy)
    if name == "arxiv":
        return ArxivProvider(transport, policy)
    if name == "crossref":
        return CrossrefProvider(transport, policy)
    if name == "europe-pmc":
        return EuropePmcProvider(transport, policy)
    if name == "openalex":
        return OpenAlexProvider(transport, policy)
    if name == "semantic-scholar":
        return SemanticScholarProvider(transport, _credential("SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY", credentials), policy)
    if name == "elsevier":
        profile = _publisher_profile(name)
        return ElsevierProvider(transport, _credential(_profile_credential_env(profile), credentials), policy, profile=profile)
    if name == "wiley":
        profile = _publisher_profile(name)
        return WileyProvider(transport, _credential(_profile_credential_env(profile), credentials), policy, profile=profile)
    if name == "springer":
        profile = _publisher_profile(name)
        return SpringerProvider(transport, _credential(_profile_credential_env(profile), credentials), policy, profile=profile)
    email = _credential(UNPAYWALL_EMAIL_ENV, credentials)
    if email is None:
        raise ValueError(f"{UNPAYWALL_EMAIL_ENV} is required")
    return UnpaywallProvider(transport, email, policy)


def _publisher_profile(name: str) -> PublisherProfile:
    profile = profile_for_provider(name)
    if profile is None:
        raise ValueError(f"publisher profile does not exist: {name}")
    return profile


def _profile_credential_env(profile: PublisherProfile) -> str:
    if profile.credential_env is None:
        raise ValueError(f"publisher profile has no credential reference: {profile.provider}")
    return profile.credential_env


def _load_source_plan(args: argparse.Namespace) -> SourcePlan | None:
    if args.source_plan is not None:
        return SourcePlan.from_json(Path(args.source_plan).read_text(encoding="utf-8"))
    if args.providers:
        role = AssetRole(args.asset_role)
        entries = tuple(
            SourceEntry(f"{provider.replace('-', '_')}_{index}", provider, index)
            for index, provider in enumerate(args.providers)
        )
        return SourcePlan(role, RoutingMode(args.routing), entries)
    return None


def provider_registry(
    names: tuple[str, ...],
    transport: AcquisitionTransport,
    policy: UrlPolicy,
    credentials: CredentialsConfig | None = None,
) -> dict[str, AcquisitionProvider]:
    providers: dict[str, AcquisitionProvider] = {}
    for name in names:
        providers[name] = _provider(name, transport, policy, credentials=credentials)
    return providers


def _inputs(args: argparse.Namespace):
    if args.manifest is not None:
        for entry in read_manifest(args.manifest):
            yield entry.identifiers, entry.metadata, None, entry.provenance.to_dict()
    elif args.doi is not None:
        yield (Identifier("doi", args.doi),), None, None, {"intake": "direct_identifier"}
    else:
        url = args.url
        yield (Identifier("url", url),), None, url, {"intake": "direct_url"}


def _batch_inputs(args: argparse.Namespace):
    if args.manifest is not None:
        source = Path(args.manifest)
        with source.open("r", encoding="utf-8", newline="") as stream:
            for line_number, line in enumerate(stream, 1):
                try:
                    entry = DownloadManifestEntry.from_json_line(line)
                    yield (entry.identifiers, entry.metadata, None, entry.provenance.to_dict()), None
                except (TypeError, ValueError) as error:
                    yield None, ValidationError(f"{source}: line {line_number}: {error}")
        return
    try:
        yield next(_inputs(args)), None
    except (TypeError, ValueError) as error:
        yield None, error


def read_forbidden_urls(path: Path | None) -> tuple[str, ...]:
    if path is None:
        return ()
    values: list[str] = []
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            value = line.strip()
            if value and not value.startswith("#"):
                values.append(value)
    return tuple(values)


async def _execute_async(
    args: argparse.Namespace,
    *,
    on_success: Callable[[AcquisitionResult], None] | None = None,
) -> tuple[int, int]:
    policy = UrlPolicy(forbidden_urls=read_forbidden_urls(args.forbidden_urls))
    engine = open_catalog_engine(args.catalog)
    try:
        assets = AssetRepository(engine)
        jobs = JobRepository(engine)
        admission_service = AdmissionService(IdentityResolver(engine), jobs, assets)
        coordinator = AssetAcceptanceCoordinator(assets, RawAssetStore(args.storage_root))
        transport = UrllibAcquisitionTransport(policy)
        plan = _load_source_plan(args)
        default_budget = HostBudget(
            2 if args.host_concurrency is None else args.host_concurrency,
            0.0 if args.host_min_interval is None else args.host_min_interval,
        )
        budget_overrides = {
            host: HostBudget(
                profile.budget.concurrency if args.host_concurrency is None else args.host_concurrency,
                profile.budget.min_interval if args.host_min_interval is None else args.host_min_interval,
            )
            for profile in PUBLISHER_PROFILES
            for host in profile.hosts
        }
        runtime = AcquisitionRuntime(
            jobs,
            coordinator,
            lambda names: provider_registry(
                names,
                transport,
                policy,
                getattr(args, "_config_credentials", None),
            ),
            default_budget=default_budget,
            budget_overrides=budget_overrides,
        )
        orchestrator = runtime.single()
        provider = None if args.provider is None else runtime.provider(args.provider)
        planned_multi = (
            None
            if plan is None
            else runtime.multi(tuple(entry.provider for entry in plan.entries))
        )
        succeeded = 0
        failed = 0
        for item, input_error in _batch_inputs(args):
            if getattr(args, "_stop_requested", False) is True:
                break
            if input_error is not None:
                failed += 1
                continue
            if item is None:
                failed += 1
                continue
            identifiers, metadata, direct_url, provenance = item
            try:
                role = AssetRole(args.asset_role)
                if plan is None:
                    if provider is None:
                        raise AcquisitionError("single-provider acquisition requires a provider")
                    admission = admission_service.admit(
                        identifiers, metadata, provider=provider.name, asset_role=role,
                        direct_url=direct_url, provenance=provenance,
                    )
                    result = await orchestrator.acquire(
                        admission, AcquisitionTarget(identifiers, direct_url, role), provider, timeout=args.timeout,
                    )
                else:
                    if planned_multi is None:
                        raise AcquisitionError("multi-source acquisition requires a provider registry")
                    admission = admission_service.admit(
                        identifiers, metadata, provider="multi-source", asset_role=role,
                        source_plan=plan, direct_url=direct_url, provenance=provenance,
                    )
                    result = await planned_multi.acquire(
                        admission, AcquisitionTarget(identifiers, direct_url, role), plan, timeout=args.timeout,
                    )
            except (AcquisitionError, ValidationError, ValueError):
                failed += 1
                continue
            if result.status in {"succeeded", "reused"}:
                succeeded += 1
                if on_success is not None:
                    on_success(result)
            else:
                failed += 1
        return succeeded, failed
    finally:
        engine.dispose()


def _print_success(result: AcquisitionResult) -> None:
    raw_asset_id = result.raw_asset_id or "-"
    print(
        f"status={result.status} work_id={result.work_id} "
        f"raw_asset_id={raw_asset_id}"
    )


def run(args: argparse.Namespace) -> int:
    def request_stop(_signum: int, _frame: object) -> None:
        args._stop_requested = True

    previous_sigint = signal.getsignal(signal.SIGINT)
    previous_sigterm = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    try:
        succeeded, failed = asyncio.run(_execute_async(args, on_success=_print_success))
    except (SciRetrieverError, SQLAlchemyError, OSError, ValueError) as error:
        detail = str(error).splitlines()[0] if str(error) else type(error).__name__
        print(f"sciretriever: error: {detail}", file=sys.stderr)
        return 1
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        signal.signal(signal.SIGTERM, previous_sigterm)
    print(f"Acquisition complete: {succeeded} succeeded, {failed} failed")
    return 0 if failed == 0 else 1


__all__ = (
    "PROVIDERS", "UNPAYWALL_EMAIL_ENV", "configure_parser", "provider_registry",
    "read_forbidden_urls", "run", "validate_arguments",
)
