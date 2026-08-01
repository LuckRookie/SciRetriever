"""Argument parsing and runtime assembly for the discovery CLI."""

from __future__ import annotations

import argparse
from collections import defaultdict
import math
from pathlib import Path
import sys

from sqlalchemy.exc import SQLAlchemyError

from sciretriever.catalog.engine import open_read_only_catalog_engine
from sciretriever.catalog.repository import ReadOnlyCatalogView
from sciretriever.core.contracts import SearchSpec
from sciretriever.core.ids import new_uuid4, validate_uuid
from sciretriever.core.timestamps import parse_rfc3339, utc_now_rfc3339
from sciretriever.discovery import KeywordRuleLabeler, ProviderFailure, discover_to_jsonl
from sciretriever.discovery.search_contracts import DEFAULT_SEARCH_LIMIT
from sciretriever.discovery.providers import (
    DEFAULT_MAX_RESPONSE_BYTES,
    DiscoveryProvider,
    build_arxiv_provider,
    build_crossref_provider,
    build_europe_pmc_provider,
    build_elsevier_provider,
    build_openalex_provider,
    build_semantic_scholar_provider,
    build_springer_provider,
)
from sciretriever.network import SecureHttpsTransport, Transport
from sciretriever.config import CredentialsConfig, get_credential
from sciretriever.cli.year_filters import parse_year_filter, validate_year_filters
from sciretriever.errors import CatalogError, SearchError


DEFAULT_SOURCES = ("crossref", "europe-pmc", "arxiv")
ALL_SOURCES = DEFAULT_SOURCES + ("openalex", "semantic-scholar", "elsevier", "springer")
_CREDENTIALS = {
    "semantic-scholar": ("SCIRETRIEVER_SEMANTIC_SCHOLAR_API_KEY", "semantic_scholar_api_key"),
    "elsevier": ("SCIRETRIEVER_ELSEVIER_API_KEY", "elsevier_api_key"),
    "springer": ("SCIRETRIEVER_SPRINGER_API_KEY", "springer_api_key"),
}
def _nonblank(value: str) -> str:
    normalized = " ".join(value.split())
    if not normalized:
        raise argparse.ArgumentTypeError("value must not be blank")
    return normalized


def _positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive integer") from error
    if parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return parsed


def _positive_float(value: str) -> float:
    try:
        parsed = float(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a positive number") from error
    if not math.isfinite(parsed) or parsed <= 0:
        raise argparse.ArgumentTypeError("must be a positive number")
    return parsed


def _label_rule(value: str) -> tuple[str, str]:
    if value.count("=") != 1:
        raise argparse.ArgumentTypeError("label rule must use LABEL=TERM syntax")
    label, term = (part.strip() for part in value.split("=", 1))
    if not label or not term:
        raise argparse.ArgumentTypeError("label and term must not be blank")
    return label, term


def _uuid(value: str) -> str:
    try:
        return validate_uuid(value, "intake_run_id")
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError(str(error)) from error


def _rfc3339(value: str) -> str:
    try:
        parse_rfc3339(value)
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError(str(error)) from error
    return value


def configure_parser(parser: argparse.ArgumentParser) -> None:
    """Configure the implemented ``discover`` subcommand parser."""
    parser.description = (
        "Retrieve metadata candidates without catalog writes and publish an atomic JSONL manifest."
    )
    parser.add_argument("query", type=_nonblank, metavar="QUERY")
    parser.add_argument(
        "--source",
        action="append",
        choices=ALL_SOURCES,
        help=(
            "metadata source in effective precedence order; repeat to select multiple "
            "(default: crossref, europe-pmc, arxiv)"
        ),
    )
    parser.add_argument(
        "--limit", type=_positive_int, default=DEFAULT_SEARCH_LIMIT,
        help="maximum metadata results (default: 1000)",
    )
    parser.add_argument(
        "--filter",
        action="append",
        type=parse_year_filter,
        default=[],
        metavar="NAME=VALUE",
        help="year_from or year_to; each name may be supplied once",
    )
    parser.add_argument("--catalog", required=True, type=Path, metavar="PATH")
    parser.add_argument("--output", required=True, type=Path, metavar="PATH")
    parser.add_argument("--taxonomy", required=True, type=_nonblank, metavar="NAME")
    parser.add_argument(
        "--taxonomy-version", required=True, type=_nonblank, metavar="VERSION"
    )
    parser.add_argument(
        "--label-rule",
        action="append",
        type=_label_rule,
        default=[],
        metavar="LABEL=TERM",
        help="local keyword rule; repeat a label to add terms",
    )
    parser.add_argument("--timeout", type=_positive_float, default=30.0)
    parser.add_argument("--intake-run-id", type=_uuid)
    parser.add_argument("--retrieved-at", type=_rfc3339)
    parser.add_argument("--crossref-mailto", type=_nonblank, metavar="EMAIL")


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    """Apply validation that depends on repeated argument values."""
    args.source = list(args.source or DEFAULT_SOURCES)
    validate_year_filters(parser, args.filter)


def _providers(
    args: argparse.Namespace,
    transport: Transport,
) -> dict[str, DiscoveryProvider]:
    credentials: CredentialsConfig | None = getattr(args, "_config_credentials", None)

    def credential(source: str) -> str | None:
        env_name, field = _CREDENTIALS[source]
        return get_credential(env_name) or (credentials.get(field) if credentials is not None else None)

    builders = {
        "crossref": lambda: build_crossref_provider(
            transport,
            mailto=args.crossref_mailto,
            timeout=args.timeout,
        ),
        "europe-pmc": lambda: build_europe_pmc_provider(transport, timeout=args.timeout),
        "arxiv": lambda: build_arxiv_provider(transport, timeout=args.timeout),
        "openalex": lambda: build_openalex_provider(transport, timeout=args.timeout),
        "semantic-scholar": lambda: build_semantic_scholar_provider(
            transport, api_key=credential("semantic-scholar"), timeout=args.timeout
        ),
        "elsevier": lambda: build_elsevier_provider(
            transport, api_key=credential("elsevier"), timeout=args.timeout
        ),
        "springer": lambda: build_springer_provider(
            transport, api_key=credential("springer"), timeout=args.timeout
        ),
    }
    providers: dict[str, DiscoveryProvider] = {}
    for source in args.source:
        providers[source] = builders[source]()
    return providers


def _production_transport() -> SecureHttpsTransport:
    return SecureHttpsTransport(max_bytes=DEFAULT_MAX_RESPONSE_BYTES)


def _execute(args: argparse.Namespace) -> tuple[Path, int, tuple[ProviderFailure, ...]]:
    output = args.output.expanduser()
    if not output.parent.is_dir():
        raise FileNotFoundError(f"manifest parent directory does not exist: {output.parent}")

    spec = SearchSpec(
        query=args.query,
        sources=tuple(args.source),
        limit=args.limit,
        filters=tuple(args.filter),
    )
    rules: defaultdict[str, list[str]] = defaultdict(list)
    for label, term in args.label_rule:
        rules[label].append(term)
    labeler = KeywordRuleLabeler(args.taxonomy, args.taxonomy_version, rules)
    transport = _production_transport()
    providers = _providers(args, transport)
    intake_run_id = args.intake_run_id or new_uuid4()
    retrieved_at = args.retrieved_at or utc_now_rfc3339()

    engine = open_read_only_catalog_engine(args.catalog)
    try:
        entries = discover_to_jsonl(
            spec,
            output,
            providers=providers,
            catalog=ReadOnlyCatalogView(engine),
            labeler=labeler,
            intake_run_id=intake_run_id,
            retrieved_at=retrieved_at,
            provider_timeout_seconds=args.timeout,
        )
    finally:
        engine.dispose()
    return output, len(entries), entries.failures


def run(args: argparse.Namespace) -> int:
    """Run discovery and map expected operational failures to stable exit codes."""
    try:
        output, count, failures = _execute(args)
    except (SearchError, CatalogError, SQLAlchemyError, OSError) as error:
        detail = str(error).splitlines()[0] if str(error) else type(error).__name__
        print(f"sciretriever: error: {detail}", file=sys.stderr)
        return 1
    for failure in failures:
        print(
            f"sciretriever: warning: {failure.provider}: "
            f"{failure.category}: {failure.message}",
            file=sys.stderr,
        )
    print(f"Wrote {count} entries to {output}")
    return 0


__all__ = ("ALL_SOURCES", "DEFAULT_SOURCES", "configure_parser", "run", "validate_arguments")
