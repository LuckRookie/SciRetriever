"""Read-only Work library command-line surface."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import sys
import tempfile
from typing import Any

from sqlalchemy.exc import SQLAlchemyError

from sciretriever.catalog import (
    LibraryFilters,
    LibraryReadRepository,
    open_read_only_catalog_engine,
)
from sciretriever.cli import discover
from sciretriever.errors import CatalogError


def _nonnegative_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as error:
        raise argparse.ArgumentTypeError("must be a nonnegative integer") from error
    if parsed < 0:
        raise argparse.ArgumentTypeError("must be a nonnegative integer")
    return parsed


def _common(parser: argparse.ArgumentParser, *, format_option: bool = True) -> None:
    parser.add_argument("--catalog", required=True, type=Path, metavar="PATH")
    parser.add_argument("--limit", type=discover._positive_int, default=100)
    parser.add_argument("--include-light-content", action="store_true")
    if format_option:
        parser.add_argument("--format", choices=("json", "jsonl"), default="json")


def _selector(parser: argparse.ArgumentParser, *, include_doi_title: bool) -> None:
    group = parser.add_mutually_exclusive_group(required=True)
    if include_doi_title:
        group.add_argument("--doi", type=discover._nonblank)
        group.add_argument("--title", type=discover._nonblank)
    group.add_argument("--work-id", type=discover._nonblank)
    group.add_argument("--work-version-id", type=discover._nonblank)


def configure_parser(parser: argparse.ArgumentParser) -> None:
    """Configure read-only library subcommands."""
    parser.description = "Read canonical Work library projections."
    subparsers = parser.add_subparsers(dest="library_command", required=True, metavar="COMMAND")

    show = subparsers.add_parser("show", help="show an exact canonical Work projection")
    _common(show)
    _selector(show, include_doi_title=True)

    search = subparsers.add_parser("search", help="search canonical library metadata")
    _common(search)
    search.add_argument("keyword", nargs="?", type=discover._nonblank, metavar="KEYWORD")
    search.add_argument("--author", type=discover._nonblank)
    search.add_argument("--year", type=_nonnegative_int)
    search.add_argument("--publisher", type=discover._nonblank)
    search.add_argument("--venue", type=discover._nonblank)
    search.add_argument("--tag", type=discover._nonblank)

    references = subparsers.add_parser("references", help="show one-hop references")
    _common(references)
    _selector(references, include_doi_title=False)

    cited_by = subparsers.add_parser("cited-by", help="show Works citing a Work")
    _common(cited_by)
    cited_by.add_argument("--work-id", required=True, type=discover._nonblank)

    export = subparsers.add_parser("export", help="atomically export an exact projection")
    _common(export)
    _selector(export, include_doi_title=True)
    export.add_argument("--output", required=True, type=Path, metavar="PATH")


def _render(result: Any, output_format: str) -> str:
    return result.to_json() + "\n" if output_format == "json" else result.to_jsonl()


def _fsync_directory(directory: Path) -> None:
    try:
        descriptor = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        try:
            os.fsync(descriptor)
        except OSError:
            pass
    finally:
        os.close(descriptor)


def _reject_catalog_destination(destination: Path, catalog_path: Path) -> None:
    catalog = catalog_path.expanduser().resolve(strict=False)
    protected = (
        catalog,
        Path(f"{catalog}-wal"),
        Path(f"{catalog}-shm"),
        Path(f"{catalog}-journal"),
    )
    candidate = destination.expanduser().resolve(strict=False)
    for path in protected:
        if candidate == path:
            raise ValueError("export destination conflicts with catalog storage")
        try:
            if destination.exists() and path.exists() and os.path.samefile(destination, path):
                raise ValueError("export destination conflicts with catalog storage")
        except OSError as error:
            raise ValueError("export destination could not be validated safely") from error


def _atomic_write(destination: Path, content: str, catalog_path: Path) -> None:
    destination = destination.expanduser()
    parent = destination.parent
    if not parent.is_dir():
        raise FileNotFoundError(f"export parent directory does not exist: {parent}")
    _reject_catalog_destination(destination, catalog_path)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{destination.name}.", suffix=".tmp", dir=parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        _reject_catalog_destination(destination, catalog_path)
        os.replace(temporary, destination)
        _fsync_directory(parent)
    except BaseException:
        try:
            temporary.unlink()
        except FileNotFoundError:
            pass
        raise


def _query(repository: Any, args: argparse.Namespace) -> Any:
    common = {"include_light_content": args.include_light_content, "limit": args.limit}
    if args.library_command in {"show", "export"}:
        return repository.exact_lookup(
            doi=args.doi,
            title=args.title,
            work_id=args.work_id,
            work_version_id=args.work_version_id,
            **common,
        )
    if args.library_command == "search":
        return repository.search(
            args.keyword,
            filters=LibraryFilters(
                author=args.author,
                publication_year=args.year,
                publisher=args.publisher,
                venue=args.venue,
                tag=args.tag,
            ),
            **common,
        )
    if args.library_command == "references":
        return repository.references(
            work_id=args.work_id, work_version_id=args.work_version_id, **common
        )
    return repository.cited_by(args.work_id, **common)


def _execute(args: argparse.Namespace) -> tuple[Any, Path | None]:
    engine = open_read_only_catalog_engine(args.catalog)
    try:
        result = _query(LibraryReadRepository(engine), args)
        destination = args.output if args.library_command == "export" else None
        if destination is not None:
            _atomic_write(destination, _render(result, args.format), engine.path)
    finally:
        engine.dispose()
    return result, destination


def run(args: argparse.Namespace) -> int:
    """Run a read-only library command with stable operational errors."""
    try:
        result, destination = _execute(args)
    except (CatalogError, SQLAlchemyError, OSError, TypeError, ValueError):
        print("sciretriever: error: library operation failed", file=sys.stderr)
        return 1
    if destination is not None:
        print(f"Exported {len(result.items)} entries to {destination.expanduser()}")
    else:
        print(_render(result, args.format), end="")
    return 0


__all__ = ("configure_parser", "run")
