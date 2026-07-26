from __future__ import annotations

import argparse
from pathlib import Path
import re
import sys

from sciretriever.catalog import CatalogDiagnosticService, canonical_json, open_read_only_catalog_engine
from sciretriever.diagnostics import DiagnosticQuery
from sciretriever.diagnostics.product import (
    DiagnosticSubjectKind,
    ProductFailureAction,
    ProductFailureReason,
    ProductFailureStage,
)
from sciretriever.errors import CatalogError
from sciretriever.core.ids import validate_uuid


_INPUT_FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")


def _fingerprint(value: str) -> str:
    if _INPUT_FINGERPRINT.fullmatch(value) is None:
        raise argparse.ArgumentTypeError("input fingerprint must be sha256 followed by 64 lowercase hex characters")
    return value


def _uuid(value: str) -> str:
    try:
        return validate_uuid(value, "diagnostic subject")
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError("diagnostic subject must be a UUID") from error


def configure_parser(parser: argparse.ArgumentParser) -> None:
    parser.description = "Query redacted product failure history."
    parser.add_argument("--catalog", required=True, type=Path)
    subject = parser.add_mutually_exclusive_group()
    subject.add_argument("--input-fingerprint", type=_fingerprint)
    subject.add_argument("--work-id", type=_uuid)
    subject.add_argument("--work-version-id", type=_uuid)
    subject.add_argument("--processing-run-id", type=_uuid)
    subject.add_argument("--expansion-id", type=_uuid)
    parser.add_argument("--stage", choices=tuple(item.value for item in ProductFailureStage))
    parser.add_argument("--role")
    parser.add_argument("--source")
    parser.add_argument("--reason", choices=tuple(item.value for item in ProductFailureReason))
    parser.add_argument("--action", choices=tuple(item.value for item in ProductFailureAction))
    parser.add_argument("--retryable", action=argparse.BooleanOptionalAction, default=None)
    parser.add_argument("--outcome")
    history = parser.add_mutually_exclusive_group()
    history.add_argument("--latest", dest="latest", action="store_true")
    history.add_argument("--all", dest="latest", action="store_false")
    parser.set_defaults(latest=True)
    parser.add_argument("--details", action="store_true")


def _subject(args: argparse.Namespace) -> tuple[DiagnosticSubjectKind | None, str | None]:
    values = (
        (DiagnosticSubjectKind.INPUT, args.input_fingerprint),
        (DiagnosticSubjectKind.WORK, args.work_id),
        (DiagnosticSubjectKind.WORK_VERSION, args.work_version_id),
        (DiagnosticSubjectKind.PROCESSING_RUN, args.processing_run_id),
        (DiagnosticSubjectKind.EXPANSION, args.expansion_id),
    )
    return next(((kind, value) for kind, value in values if value is not None), (None, None))


def _query(args: argparse.Namespace) -> DiagnosticQuery:
    subject_kind, subject_id = _subject(args)
    return DiagnosticQuery(
        subject_kind=subject_kind,
        subject_id=subject_id,
        stage=None if args.stage is None else ProductFailureStage(args.stage),
        reason=None if args.reason is None else ProductFailureReason(args.reason),
        action=None if args.action is None else ProductFailureAction(args.action),
        retryable=args.retryable,
        role=args.role,
        source=args.source,
        outcome=args.outcome,
        latest=args.latest,
    )


def run(args: argparse.Namespace) -> int:
    catalog = None
    try:
        catalog = open_read_only_catalog_engine(args.catalog)
        rows = CatalogDiagnosticService(catalog).query(_query(args))
        failures = []
        for row in rows:
            value = {
                "action": row.failure.action.value,
                "corrupted": row.corrupted,
                "id": row.id,
                "occurred_at": row.occurred_at,
                "reason": row.failure.reason.value,
                "rerun": row.failure.rerun.value,
                "retryable": row.retryable,
                "stage": row.failure.stage.value,
                "subject_id": row.failure.subject_id,
                "subject_kind": row.failure.subject_kind.value,
            }
            if args.details and row.failure.stage is ProductFailureStage.ACQUISITION:
                value["details"] = dict(row.details)
            failures.append(value)
        print(canonical_json({"count": len(failures), "failures": failures}))
        return 0
    except (CatalogError, OSError, TypeError, ValueError):
        print("sciretriever: error: failure query failed", file=sys.stderr)
        return 1
    finally:
        if catalog is not None:
            catalog.dispose()


__all__ = ("configure_parser", "run")
