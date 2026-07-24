"""Argument parsing and runtime assembly for metadata search."""

from __future__ import annotations

import argparse
import asyncio
import json
from pathlib import Path
import sys

from sqlalchemy.exc import SQLAlchemyError

from sciretriever.catalog import WorkRepository, canonical_json, open_catalog_engine
from sciretriever.cli import discover, download
from sciretriever.discovery import (
    DEFAULT_MAX_CONCURRENCY,
    DEFAULT_PROVIDER_TIMEOUT_SECONDS,
    DEFAULT_SEARCH_LIMIT,
    MetadataSearchOutput,
    MetadataSearchRequest,
    MetadataSearchService,
)
from sciretriever.errors import CatalogError, SearchError
from sciretriever.config import ACQUISITION_PROVIDERS
from sciretriever.acquisition.transport import MAX_RESPONSE_BYTES


DEFAULT_PROVIDERS = discover.DEFAULT_SOURCES
ALL_PROVIDERS = discover.ALL_SOURCES
_PUBLIC_IDENTIFIER_NAMESPACES = frozenset({"arxiv", "doi", "pmcid", "pmid"})


def configure_parser(parser: argparse.ArgumentParser) -> None:
    """Configure the implemented metadata-only ``search`` command."""
    parser.description = "Search metadata providers and persist canonical Works."
    parser.add_argument("query", type=discover._nonblank, metavar="QUERY")
    parser.add_argument("--catalog", required=True, type=Path, metavar="PATH")
    parser.add_argument("--level", choices=("metadata", "download"), default="metadata")
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
    parser.add_argument("--storage-root", type=Path)
    parser.add_argument("--download-provider", action="append", choices=tuple(sorted(ACQUISITION_PROVIDERS)))
    parser.add_argument("--download-timeout", type=discover._positive_float, default=30.0)
    parser.add_argument("--download-provider-concurrency", type=discover._positive_int, default=4)
    parser.add_argument("--host-concurrency", type=discover._positive_int, default=2)
    parser.add_argument("--host-min-interval", type=float, default=0.0)
    parser.add_argument("--max-asset-bytes", type=discover._positive_int, default=MAX_RESPONSE_BYTES)
    parser.add_argument("--forbidden-urls", type=Path)
    parser.add_argument("--xml", action=argparse.BooleanOptionalAction, default=False)
    parser.add_argument("--html", action=argparse.BooleanOptionalAction, default=False)


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
    if args.level == "download" and args.storage_root is None:
        parser.error("search --level download requires --storage-root")
    if args.host_min_interval < 0:
        parser.error("--host-min-interval must be nonnegative")
    download_providers = list(args.download_provider or download.DEFAULT_PROVIDERS)
    if len(download_providers) != len(set(download_providers)):
        parser.error("duplicate download provider")
    args.download_provider = download_providers
    sci_hub = getattr(args, "_config_sci_hub", None)
    if "sci-hub" in download_providers and (sci_hub is None or not sci_hub.enabled):
        parser.error("sci-hub requires an explicitly enabled [acquisition.sci_hub] config")


def _providers(args: argparse.Namespace):
    provider_args = argparse.Namespace(
        source=args.provider,
        timeout=args.provider_timeout,
        crossref_mailto=args.crossref_mailto,
        _config_credentials=getattr(args, "_config_credentials", None),
        _config_sci_hub=getattr(args, "_config_sci_hub", None),
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


def _execute(args: argparse.Namespace) -> MetadataSearchOutput:
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
    return output


def _download_args(args: argparse.Namespace) -> argparse.Namespace:
    return argparse.Namespace(
        catalog=args.catalog,
        storage_root=args.storage_root,
        provider=args.download_provider,
        timeout=args.download_timeout,
        provider_concurrency=args.download_provider_concurrency,
        host_concurrency=args.host_concurrency,
        host_min_interval=args.host_min_interval,
        max_asset_bytes=args.max_asset_bytes,
        forbidden_urls=args.forbidden_urls,
        xml=args.xml,
        html=args.html,
        _config_credentials=getattr(args, "_config_credentials", None),
        _config_sci_hub=getattr(args, "_config_sci_hub", None),
        _config_translator=getattr(args, "_config_translator", None),
        _config_browser=getattr(args, "_config_browser", None),
    )


def run(args: argparse.Namespace) -> int:
    """Run metadata search with stable, sanitized operational failures."""
    payload: str | None = None
    download_args: argparse.Namespace | None = None
    try:
        output = _execute(args)
        payload = _serialize(output)
        interrupted = False
        if args.level == "download":
            selected = tuple(item.work_version.id for item in output.results)
            download_args = _download_args(args)
            acquisition = asyncio.run(
                download.execute_work_versions(download_args, selected)
            )
            decoded = json.loads(payload)
            decoded["download"] = acquisition.to_dict()
            payload = canonical_json(decoded)
            interrupted = acquisition.interrupted > 0
    except KeyboardInterrupt:
        acquisition = download.interrupted_result(
            download_args if download_args is not None else argparse.Namespace()
        )
        decoded = (
            json.loads(payload)
            if payload is not None
            else {"counts": {"failures": 0, "results": 0}, "failures": [], "results": []}
        )
        decoded["download"] = acquisition.to_dict()
        print(canonical_json(decoded))
        return 130
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
    return 130 if interrupted else 0


__all__ = ("ALL_PROVIDERS", "DEFAULT_PROVIDERS", "configure_parser", "run", "validate_arguments")
