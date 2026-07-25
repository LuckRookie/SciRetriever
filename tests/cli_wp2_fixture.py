import contextlib
import io
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase, mock


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    ReferenceRepository,
    WorkRepository,
    create_catalog_engine,
    initialize_catalog,
    open_catalog_engine,
)
from sciretriever.cli import library as library_cli
from sciretriever.cli import search as search_cli
from sciretriever.cli import metadata_runtime
from sciretriever.cli.main import main
from sciretriever.core.contracts import Identifier
from sciretriever.discovery import ProviderRecord


class FakeProvider:
    def __init__(self, name, records=(), error=None):
        self.name = name
        self.records = tuple(records)
        self.error = error

    def search(self, _spec):
        if self.error is not None:
            raise self.error
        return self.records


def provider_record(
    provider, rank, title, doi, *, keywords=(), open_access_status=None,
    provider_record_id=None, extra_identifiers=(), publication_date=None,
):
    return ProviderRecord(
        provider=provider,
        rank=rank,
        raw_identifiers=(("doi", doi), *tuple(extra_identifiers)),
        title=title,
        abstract="Canonical abstract",
        authors=("Ada Lovelace",),
        year=2026,
        venue="Canonical Venue",
        keywords=tuple(keywords),
        open_access_status=open_access_status,
        provider_record_id=provider_record_id,
        publication_date=publication_date,
    )


class CliWp2Fixture(TestCase):
    def setUp(self):
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.catalog = self.base / "catalog.sqlite"
        engine = create_catalog_engine(self.catalog)
        initialize_catalog(engine)
        engine.dispose()

    def invoke(self, argv):
        output = io.StringIO()
        error = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            code = main(["--no-config", *argv])
        return code, output.getvalue(), error.getvalue()

    def parse_error(self, argv):
        error = io.StringIO()
        with contextlib.redirect_stderr(error), self.assertRaises(SystemExit) as raised:
            main(["--no-config", *argv])
        self.assertEqual(raised.exception.code, 2)
        self.assertNotIn("Traceback", error.getvalue())
        return error.getvalue()

    def counts(self):
        names = ("works", "work_versions", "metadata_observations", "version_references")
        import sqlite3
        with sqlite3.connect(self.catalog) as connection:
            return tuple(connection.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0] for name in names)
