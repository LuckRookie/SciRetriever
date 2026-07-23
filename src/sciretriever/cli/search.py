"""Argument parsing and runtime assembly for metadata search."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from sqlalchemy.exc import SQLAlchemyError

from sciretriever.catalog import WorkRepository, canonical_json, open_catalog_engine
from sciretriever.cli import discover
from sciretriever.discovery import (
    DEFAULT_MAX_CONCURRENCY,
    DEFAULT_PROVIDER_TIMEOUT_SECONDS,
    DEFAULT_SEARCH_LIMIT,
    MetadataSearchOutput,
    MetadataSearchRequest,
    MetadataSearchService,
)
from sciretriever.errors import CatalogError, SearchError


DEFAULT_PROVIDERS = discover.DEFAULT_SOURCES
ALL_PROVIDERS = discover.ALL_SOURCES
_PUBLIC_IDENTIFIER_NAMESPACES = frozenset({"arxiv", "doi", "pmcid", "pmid"})


def configure_parser(parser: argparse.ArgumentParser) -> None:
    """Configure the implemented metadata-only ``search`` command."""
    parser.description = "Search metadata providers and persist canonical Works."
    parser.add_argument("query", type=discover._nonblank, metavar="QUERY")
    parser.add_argument("--catalog", required=True, type=Path, metavar="PATH")
    parser.add_argument("--level", choices=("metadata",), default="metadata")
    parser.add_argument("--provider", action="append", choices=ALL_PROVIDERS)
    parser.add_argument("--precedence", action="append", choices=ALL_PROVIDERS)
    parser.add_argument("--limit", type=discover._positive_int, default=DEFAULT_SEARCH_LIMIT)
    parser.add_argument(
        "--provider-timeout",
        type=discover._positive_float,
        default=DEFAULT_PROVIDER_TIMEOUT_SECONDS,
    )
    parser.add_argument(
        "--max-concurrency", type=discover._positive_int, default=DEFAULT_MAX_CONCURRENCY
    )
    parser.add_argument("--crossref-mailto", type=discover._nonblank, metavar="EMAIL")


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    """Validate repeated provider selections and establish deterministic defaults."""
    providers = list(args.provider or DEFAULT_PROVIDERS)
    precedence = list(args.precedence or providers)
    duplicate_providers = sorted({name for name in providers if providers.count(name) > 1})
    duplicate_precedence = sorted({name for name in precedence if precedence.count(name) > 1})
    if duplicate_providers:
        parser.error(f"duplicate provider: {', '.join(duplicate_providers)}")
    if duplicate_precedence:
        parser.error(f"duplicate precedence: {', '.join(duplicate_precedence)}")
    if len(precedence) != len(providers) or set(precedence) != set(providers):
        parser.error("precedence must contain every selected provider exactly once")
    args.provider = providers
    args.precedence = precedence


def _providers(args: argparse.Namespace):
    provider_args = argparse.Namespace(
        source=args.provider,
        timeout=args.provider_timeout,
        crossref_mailto=args.crossref_mailto,
        _config_credentials=getattr(args, "_config_credentials", None),
    )
    return discover._providers(provider_args, discover._production_transport())


def _serialize(output: MetadataSearchOutput) -> str:
    results = []
    for result in output.results:
        metadata = result.metadata
        results.append({
            "identifiers": [
                {"namespace": identifier.namespace, "value": identifier.value}
                for identifier in result.identifiers
                if identifier.namespace in _PUBLIC_IDENTIFIER_NAMESPACES
            ],
            "metadata": {
                "abstract": metadata.abstract,
                "authors": list(metadata.authors),
                "open_access_status": result.work_version.open_access_status,
                "publication_date": result.work_version.publication_date,
                "title": metadata.title,
                "venue": metadata.venue,
                "year": metadata.year,
            },
            "providers": list(result.providers),
            "work_id": result.work_version.work_id,
            "work_version_id": result.work_version.id,
        })
    failures = [
        {"category": item.category, "message": item.message, "provider": item.provider}
        for item in output.failures
    ]
    return canonical_json({
        "counts": {"failures": len(failures), "results": len(results)},
        "failures": failures,
        "results": results,
    })


def _execute(args: argparse.Namespace) -> str:
    engine = open_catalog_engine(args.catalog)
    try:
        service = MetadataSearchService(_providers(args), WorkRepository(engine))
        output = service.search(MetadataSearchRequest(
            query=args.query,
            providers=tuple(args.provider),
            precedence=tuple(args.precedence),
            limit=args.limit,
            provider_timeout_seconds=args.provider_timeout,
            max_concurrency=args.max_concurrency,
        ))
    finally:
        engine.dispose()
    return _serialize(output)


def run(args: argparse.Namespace) -> int:
    """Run metadata search with stable, sanitized operational failures."""
    try:
        payload = _execute(args)
    except (SearchError, CatalogError, SQLAlchemyError, OSError, ValueError) as error:
        if isinstance(error, SearchError) and str(error).startswith("all metadata search providers failed:"):
            detail = "all metadata search providers failed"
        else:
            detail = "metadata search failed"
        print(f"sciretriever: error: {detail}", file=sys.stderr)
        return 1
    except Exception:
        print("sciretriever: error: metadata search failed", file=sys.stderr)
        return 1
    print(payload)
    return 0


__all__ = ("ALL_PROVIDERS", "DEFAULT_PROVIDERS", "configure_parser", "run", "validate_arguments")
