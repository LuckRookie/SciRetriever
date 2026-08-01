"""Expose citation expansion through the CLI composition runtime."""

from __future__ import annotations

import argparse
from contextlib import nullcontext
from pathlib import Path
import sys

from sciretriever.catalog import canonical_json
from sciretriever.errors import SciRetrieverError, StageAdmissionConflict
from sciretriever.integrations.graph import GraphDirection

from .expansion_runtime import build_expand_runtime
from .stage_admission import StageKind, admit_catalog_stages


GRAPH_PROVIDERS = ("openalex", "semantic-scholar")


def _nonnegative(value: str) -> int:
    parsed = int(value)
    if parsed < 0:
        raise argparse.ArgumentTypeError("depth must be nonnegative")
    return parsed


def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.description = "Expand references from one explicit Work, WorkVersion, or query seed."
    parser.add_argument("--catalog", required=True, type=Path)
    parser.add_argument("--storage-root", required=True, type=Path)
    seed = parser.add_mutually_exclusive_group(required=True)
    seed.add_argument("--work-id")
    seed.add_argument("--work-version-id")
    seed.add_argument("--query")
    parser.add_argument("--direction", choices=tuple(item.value for item in GraphDirection),
                        default=GraphDirection.REFERENCES.value)
    parser.add_argument("--depth", required=True, type=_nonnegative)
    parser.add_argument("--graph-provider", action="append", choices=GRAPH_PROVIDERS)
    parser.add_argument("--max-provider-calls", type=int, default=10)
    parser.add_argument("--provider-page-size", type=int, default=100)


def validate_arguments(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    if args.query is not None and not args.query.strip():
        parser.error("--query must be nonblank")
    if args.max_provider_calls < 1:
        parser.error("--max-provider-calls must be positive")
    if not 1 <= args.provider_page_size <= 200:
        parser.error("--provider-page-size must be between 1 and 200")
    providers = args.graph_provider or list(GRAPH_PROVIDERS)
    if len(providers) != len(set(providers)):
        parser.error("--graph-provider must not contain duplicates")
    args.graph_provider = providers


def run(args: argparse.Namespace) -> int:
    runtime = None
    try:
        admission = nullcontext() if args.depth == 0 else admit_catalog_stages(
            args.catalog, (StageKind.ACQUISITION, StageKind.ANALYSIS)
        )
        with admission:
            runtime = build_expand_runtime(args)
            result = runtime.execute(args)
    except KeyboardInterrupt:
        print(canonical_json({"interrupted": True, "layers": []}))
        return 130
    except StageAdmissionConflict as error:
        print(f"sciretriever: error: {error.stage.value} stage is already active", file=sys.stderr)
        return 1
    except (OSError, SciRetrieverError, TypeError, ValueError):
        print("sciretriever: error: expansion failed", file=sys.stderr)
        return 1
    finally:
        if runtime is not None:
            runtime.close()
    print(canonical_json(result.to_dict()))
    return 130 if result.interrupted else 0


__all__ = ("configure_parser", "run", "validate_arguments")
