"""Read-only acquisition catalog reporting CLI."""

from __future__ import annotations

import argparse
import sys

from sqlalchemy.exc import SQLAlchemyError

from sciretriever.catalog.engine import open_read_only_catalog_engine
from sciretriever.catalog.reporting import CatalogReportingRepository, DEFAULT_REPORT_LIMIT, MAX_REPORT_LIMIT
from sciretriever.diagnostics.projection import JobProjection
from sciretriever.errors import CatalogError
from sciretriever.cli.rendering import render_records


def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.description = "Report acquisition status and failures from a read-only catalog."
    parser.add_argument("--catalog", required=True, metavar="PATH", help="existing catalog SQLite file")
    parser.add_argument("--job-id", metavar="UUID", help="report one acquisition job")
    parser.add_argument("--work-id", metavar="UUID", help="filter by work")
    parser.add_argument("--state", choices=("pending", "active", "succeeded", "failed", "cancelled"))
    retryability = parser.add_mutually_exclusive_group()
    retryability.add_argument("--retryable", action="store_true", default=None, help="jobs with retryable failures")
    retryability.add_argument("--not-retryable", dest="retryable", action="store_false", help="jobs with non-retryable failures")
    parser.add_argument("--category", help="filter by exact failure category")
    parser.add_argument("--limit", type=int, default=DEFAULT_REPORT_LIMIT, metavar=f"1..{MAX_REPORT_LIMIT}")
    parser.add_argument("--format", choices=("terminal", "json", "jsonl"), default="terminal")


def run(args: argparse.Namespace) -> int:
    catalog = None
    try:
        catalog = open_read_only_catalog_engine(args.catalog)
        repository = CatalogReportingRepository(catalog)
        if args.job_id is not None:
            projection = repository.get_job(args.job_id)
            projections = () if projection is None else (projection,)
        else:
            projections = repository.list_jobs(
                work_id=args.work_id,
                state=args.state,
                retryable=args.retryable,
                category=args.category,
                limit=args.limit,
            )
        _render(projections, args.format)
        return 0 if projections or args.job_id is None else 1
    except (TypeError, ValueError) as error:
        print(f"sciretriever: error: {error}", file=sys.stderr)
        return 2
    except (FileNotFoundError, OSError, CatalogError, SQLAlchemyError):
        print("sciretriever: error: catalog report is unavailable", file=sys.stderr)
        return 2
    finally:
        if catalog is not None:
            catalog.dispose()


def _render(projections: tuple[JobProjection, ...], output_format: str) -> None:
    values = [projection.to_dict() for projection in projections]
    if output_format == "json":
        render_records(values, output_format, stream=sys.stdout)
        return
    if output_format == "jsonl":
        render_records(values, output_format, stream=sys.stdout)
        return
    for projection in projections:
        print(
            f"job={projection.job_id} work={projection.work_id} role={projection.asset_role} "
            f"state={projection.state}"
        )
        print(f"  attempts={len(projection.attempts)} failures={len(projection.failures)} events={projection.event_count}")
        for failure in projection.failures:
            diagnostic = failure.diagnostic
            print(
                f"  failure={failure.id} category={failure.category} reason={diagnostic.reason_code.value} "
                f"action={diagnostic.action_code.value} retryable={str(diagnostic.retryable).lower()} "
                f"diagnostic={diagnostic.diagnostic_id} summary={diagnostic.summary}"
            )


__all__ = ("configure_parser", "run")
