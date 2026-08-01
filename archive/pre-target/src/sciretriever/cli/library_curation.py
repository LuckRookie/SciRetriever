from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

from sqlalchemy.exc import SQLAlchemyError

from sciretriever.catalog.author_curation import AuthorCurationConflictError, AuthorMergeHandler
from sciretriever.catalog.curation import (
    CurationAlreadyUndoneError,
    CurationAuditCorruptError,
    CurationBoundaryError,
    CurationBusyError,
    CurationCompensationError,
    CurationNoChangeError,
    CurationOperationOwner,
    CurationRequest,
    CurationStaleError,
)
from sciretriever.catalog.curation_audit import CurationAuditRepository, audit_json
from sciretriever.catalog.manual_metadata_curation import (
    ManualMetadataClearHandler,
    ManualMetadataCurationConflictError,
    ManualMetadataSetHandler,
)
from sciretriever.catalog.manual_tag_curation import (
    ManualTagAddHandler,
    ManualTagCurationConflictError,
    ManualTagRemoveHandler,
)
from sciretriever.catalog.preferred_curation import (
    PreferredClearHandler,
    PreferredCurationConflictError,
    PreferredSetHandler,
)
from sciretriever.catalog.review_curation import ReviewQuery, ReviewRepository, ReviewResolutionHandler
from sciretriever.catalog.work_curation import WorkCurationConflictError, WorkMergeHandler, WorkVersionRegroupHandler
from sciretriever.catalog.engine import open_catalog_engine
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.ids import validate_uuid
from sciretriever.core.snapshots import SafeSnapshot, SnapshotBoundaryError
from sciretriever.errors import CatalogError


CONFLICT_ERRORS = (
    AuthorCurationConflictError, CurationAlreadyUndoneError, CurationAuditCorruptError,
    CurationBusyError, CurationCompensationError, CurationNoChangeError, CurationStaleError,
    ManualMetadataCurationConflictError, ManualTagCurationConflictError,
    PreferredCurationConflictError, WorkCurationConflictError,
)


def _uuid(value: str) -> str:
    try:
        return validate_uuid(value, "id")
    except (TypeError, ValueError) as error:
        raise argparse.ArgumentTypeError("must be an exact UUID") from error


def _evidence(value: str) -> tuple[str, str]:
    name, separator, item = value.partition("=")
    if not separator:
        raise argparse.ArgumentTypeError("must be KEY=VALUE")
    try:
        SafeSnapshot.from_pairs(((name, item),))
    except SnapshotBoundaryError as error:
        raise argparse.ArgumentTypeError("must be bounded safe evidence") from error
    return name, item


def _base(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--catalog", required=True, type=Path, metavar="PATH")


def _nested(parent: argparse.ArgumentParser, names: tuple[str, ...]) -> dict[str, argparse.ArgumentParser]:
    parsers = parent.add_subparsers(dest=f"{parent.prog.rsplit(' ', 1)[-1]}_command", required=True)
    return {name: parsers.add_parser(name, help=f"{name} explicit curation") for name in names}


def configure_parser(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    review = subparsers.add_parser("review", help="query or resolve explicit review items")
    _base(review)
    review.add_argument("--review-id", type=_uuid)
    review.add_argument("--decision", choices=("confirmed", "rejected", "deferred"))
    review.add_argument("--state", choices=("pending", "resolved"), default="pending")
    review.add_argument("--limit", type=int, default=100)
    review.add_argument("--evidence", action="append", type=_evidence, default=[])

    merge = subparsers.add_parser("merge-work", help="merge one exact Work into another")
    _base(merge)
    merge.add_argument("--source-work-id", required=True, type=_uuid)
    merge.add_argument("--target-work-id", required=True, type=_uuid)
    merge.add_argument("--evidence", required=True, action="append", type=_evidence)

    regroup = subparsers.add_parser("regroup-version", help="move one exact WorkVersion")
    _base(regroup)
    regroup.add_argument("--work-version-id", required=True, type=_uuid)
    regroup.add_argument("--target-work-id", required=True, type=_uuid)
    regroup.add_argument("--evidence", required=True, action="append", type=_evidence)

    preferred = subparsers.add_parser("preferred", help="set or clear an explicit preferred version")
    preferred_commands = _nested(preferred, ("set", "clear"))
    for command in preferred_commands.values():
        _base(command)
        command.add_argument("--work-id", required=True, type=_uuid)
    preferred_commands["set"].add_argument("--work-version-id", required=True, type=_uuid)

    metadata = subparsers.add_parser("metadata", help="set or clear exact manual metadata")
    metadata_commands = _nested(metadata, ("set", "clear"))
    for command in metadata_commands.values():
        _base(command)
        command.add_argument("--work-version-id", required=True, type=_uuid)
        command.add_argument("--field", required=True)
    metadata_commands["set"].add_argument("--value", required=True)

    tag = subparsers.add_parser("tag", help="add or remove an exact manual tag")
    tag_commands = _nested(tag, ("add", "remove"))
    for command in tag_commands.values():
        _base(command)
        command.add_argument("--work-id", required=True, type=_uuid)
        command.add_argument("--tag-id", required=True, type=_uuid)

    author = subparsers.add_parser("author", help="curate exact Author identities")
    author_merge = _nested(author, ("merge",))["merge"]
    _base(author_merge)
    author_merge.add_argument("--source-author-id", required=True, type=_uuid)
    author_merge.add_argument("--target-author-id", required=True, type=_uuid)
    author_merge.add_argument("--evidence", action="append", type=_evidence, default=[])

    audit = subparsers.add_parser("audit", help="read safe curation audit records")
    _base(audit)
    audit.add_argument("--operation-id", type=_uuid)
    audit.add_argument("--limit", type=int, default=100)
    undo = subparsers.add_parser("undo", help="undo one exact curation operation")
    _base(undo)
    undo.add_argument("--operation-id", required=True, type=_uuid)


def _snapshot(pairs: list[tuple[str, str]]) -> SafeSnapshot:
    if len(pairs) > 16:
        raise CurationBoundaryError("evidence_count")
    return SafeSnapshot.from_pairs(tuple(pairs))


def _handler(args: argparse.Namespace, catalog):
    command = args.library_command
    match command:
        case "review":
            if args.review_id is None or args.decision is None:
                raise CurationBoundaryError("review_selector")
            return ReviewResolutionHandler.load(catalog, args.review_id, ReviewDecision(args.decision))
        case "merge-work":
            return WorkMergeHandler.load(catalog, args.source_work_id, args.target_work_id)
        case "regroup-version":
            return WorkVersionRegroupHandler.load(catalog, args.work_version_id, args.target_work_id)
        case "preferred":
            return (PreferredSetHandler.load(catalog, args.work_id, args.work_version_id)
                    if args.preferred_command == "set" else PreferredClearHandler.load(catalog, args.work_id))
        case "metadata":
            if args.metadata_command == "set":
                value: str | int = int(args.value) if args.field == "publication_year" else args.value
                return ManualMetadataSetHandler.load(catalog, args.work_version_id, args.field, value)
            return ManualMetadataClearHandler.load(catalog, args.work_version_id, args.field)
        case "tag":
            return (ManualTagAddHandler.load(catalog, args.work_id, args.tag_id)
                    if args.tag_command == "add" else ManualTagRemoveHandler.load(catalog, args.work_id, args.tag_id))
        case "author":
            return AuthorMergeHandler.load(catalog, args.source_author_id, args.target_author_id,
                                           _snapshot(args.evidence))
        case _:
            raise CurationBoundaryError("command")


def _review_query(args: argparse.Namespace, catalog) -> int | None:
    if args.library_command != "review" or args.review_id is not None or args.decision is not None:
        return None
    items = ReviewRepository(catalog).query(ReviewQuery(args.state, args.limit))
    values = [
        {"decision": item.decision, "id": item.id, "kind": item.kind,
         "reason": item.reason, "state": item.state}
        for item in items
    ]
    print(json.dumps(values, ensure_ascii=True, separators=(",", ":"), sort_keys=True))
    return 0


def _execute(args: argparse.Namespace) -> int:
    catalog = open_catalog_engine(args.catalog, allow_repository_write=True)
    try:
        queried = _review_query(args, catalog)
        if queried is not None:
            return queried
        if args.library_command == "audit":
            repository = CurationAuditRepository(catalog)
            if args.operation_id is not None:
                record = repository.get(args.operation_id)
                if record is None:
                    raise CurationAuditCorruptError(args.operation_id)
                print(audit_json(record))
            else:
                print("[" + ",".join(audit_json(record) for record in repository.recent(args.limit)) + "]")
            return 0
        owner = CurationOperationOwner(catalog)
        if args.library_command == "undo":
            record = owner.undo(args.operation_id)
        else:
            handler = _handler(args, catalog)
            evidence = handler.evidence if isinstance(handler, AuthorMergeHandler) else _snapshot(args.evidence if hasattr(args, "evidence") else [])
            decision = ReviewDecision(args.decision) if args.library_command == "review" else ReviewDecision.NOT_REQUIRED
            record = owner.apply(CurationRequest(handler, decision, evidence, handler.operation_id))
        print(audit_json(record))
        return 0
    finally:
        catalog.dispose()


def run(args: argparse.Namespace) -> int:
    try:
        return _execute(args)
    except CONFLICT_ERRORS:
        print('{"error":"operation_conflict"}', file=sys.stderr)
        return 3
    except (CurationBoundaryError, SnapshotBoundaryError, TypeError, ValueError):
        print('{"error":"invalid_input"}', file=sys.stderr)
        return 2
    except (CatalogError, OSError, SQLAlchemyError):
        print('{"error":"operation_failed"}', file=sys.stderr)
        return 1


__all__ = ("configure_parser", "run")
