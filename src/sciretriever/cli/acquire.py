"""Argument parsing and runtime assembly for the acquisition CLI."""

from __future__ import annotations

import argparse
import asyncio
import math
from pathlib import Path
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
from sciretriever.acquisition.models import AcquisitionProvider, AcquisitionTransport
from sciretriever.acquisition.controls import HostBudget
from sciretriever.acquisition.plan import RoutingMode, SourceEntry, SourcePlan
from sciretriever.acquisition.providers_p5 import ElsevierProvider, OpenAlexProvider, SemanticScholarProvider, SpringerProvider, WileyProvider
from sciretriever.acquisition.profiles import PUBLISHER_PROFILES, PublisherProfile, profile_for_provider
from sciretriever.acquisition.orchestrator import AcquisitionRuntime
from sciretriever.catalog import AssetRepository, IdentityResolver, JobRepository, open_catalog_engine
from sciretriever.config import CredentialsConfig, get_credential
from sciretriever.core.contracts import DownloadManifestEntry, Identifier
from sciretriever.core.enums import AssetRole
from sciretriever.core.timestamps import utc_now_rfc3339
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
    parser.description = "Acquire one role-specific asset per input through a single provider or durable source plan."
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
    resume = parser.add_mutually_exclusive_group()
    resume.add_argument("--resume-job", metavar="UUID")
    resume.add_argument("--due-jobs", action="store_true")
    parser.add_argument("--asset-role", choices=tuple(role.value for role in AssetRole), default=AssetRole.PRIMARY_PDF.value)
    parser.add_argument("--routing", choices=tuple(mode.value for mode in RoutingMode), default=RoutingMode.SERIAL.value)
    parser.add_argument("--host-concurrency", type=int)
    parser.add_argument("--host-min-interval", type=float)
    parser.add_argument("--timeout", type=_positive_float, default=30.0)
    parser.add_argument("--forbidden-urls", type=Path, metavar="PATH")


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if args.resume_job is None and not args.due_jobs and args.manifest is None and args.doi is None and args.url is None:
        parser.error("one intake or --resume-job/--due-jobs is required")
    if (args.resume_job is not None or args.due_jobs) and any(value is not None for value in (args.manifest, args.doi, args.url)):
        parser.error("resume controls cannot be combined with new intake")
    if args.resume_job is None and not args.due_jobs and args.provider is None and args.providers is None and args.source_plan is None:
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


def _provider_registry(
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


def _read_forbidden_urls(path: Path | None) -> tuple[str, ...]:
    if path is None:
        return ()
    values: list[str] = []
    with path.open("r", encoding="utf-8") as stream:
        for line in stream:
            value = line.strip()
            if value and not value.startswith("#"):
                values.append(value)
    return tuple(values)


async def _execute_async(args: argparse.Namespace) -> tuple[int, int]:
    policy = UrlPolicy(forbidden_urls=_read_forbidden_urls(args.forbidden_urls))
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
            lambda names: _provider_registry(
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
        if args.resume_job is not None or args.due_jobs:
            resume_jobs = (
                (jobs.get_job(args.resume_job),)
                if args.resume_job is not None
                else jobs.list_due_retryable_jobs(utc_now_rfc3339())
            )
            for job in resume_jobs:
                if job is None:
                    failed += 1
                    continue
                try:
                    durable_plan = SourcePlan.from_json(job.source_plan_json)
                    identifiers = IdentityResolver(engine).list_identifiers(job.work_id)
                    multi = runtime.multi(tuple(entry.provider for entry in durable_plan.entries))
                    result = await multi.acquire(
                        AdmissionResult(job.work_id, job.id, f"resume:{job.id}", "multi-source", job.asset_role),
                        AcquisitionTarget(identifiers, role=job.asset_role),
                        durable_plan,
                        timeout=args.timeout,
                        resume_paused=args.resume_job is not None,
                    )
                except (AcquisitionError, ValidationError, TypeError, ValueError):
                    failed += 1
                    continue
                if result.status in {"succeeded", "reused"}:
                    succeeded += 1
                else:
                    failed += 1
            return succeeded, failed

        for item, input_error in _batch_inputs(args):
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
            else:
                failed += 1
        return succeeded, failed
    finally:
        engine.dispose()


def run(args: argparse.Namespace) -> int:
    try:
        succeeded, failed = asyncio.run(_execute_async(args))
    except (SciRetrieverError, SQLAlchemyError, OSError, ValueError) as error:
        detail = str(error).splitlines()[0] if str(error) else type(error).__name__
        print(f"sciretriever: error: {detail}", file=sys.stderr)
        return 1
    print(f"Acquisition complete: {succeeded} succeeded, {failed} failed")
    return 0 if failed == 0 else 1


__all__ = ("PROVIDERS", "UNPAYWALL_EMAIL_ENV", "configure_parser", "run", "validate_arguments")
