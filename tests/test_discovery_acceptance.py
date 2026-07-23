import json
import sqlite3
import sys
from collections import deque
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any
from unittest import TestCase


REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.catalog import (
    CatalogRepository,
    IdentityResolver,
    ReadOnlyCatalogView, initialize_catalog, create_catalog_engine,
open_read_only_catalog_engine,
)
from sciretriever.core.contracts import (
    CandidateMetadata,
    DownloadManifestEntry,
    Identifier,
    SearchSpec,
)
from sciretriever.discovery.labeling import (
    KeywordRuleLabeler,
    LabelInput,
    LabelResult,
    label_input_sha256,
)
from sciretriever.discovery.manifest import discover_to_jsonl
from sciretriever.discovery.providers import ArxivProvider, CrossrefProvider, EuropePMCProvider
from sciretriever.discovery.providers.arxiv import ARXIV_QUERY_URL
from sciretriever.discovery.providers.base import DiscoveryProvider
from sciretriever.discovery.providers.crossref import CROSSREF_WORKS_URL
from sciretriever.discovery.providers.europe_pmc import EUROPE_PMC_SEARCH_URL
from sciretriever.discovery.providers.http import HttpResponse
from sciretriever.errors import ProviderSearchError


RUN_ID = "00000000-0000-4000-8000-000000000001"
RETRIEVED_AT = "2026-07-20T12:00:00Z"


class RoutingTransport:
    def __init__(self, routes: dict[str, list[bytes | BaseException]]) -> None:
        self.routes = {url: deque(outcomes) for url, outcomes in routes.items()}
        self.calls: list[str] = []

    def get(
        self,
        url: str,
        *,
        params: Any = None,
        headers: Any = None,
        timeout: float | None = None,
    ) -> HttpResponse:
        del params, headers, timeout
        self.calls.append(url)
        if url not in self.routes or not self.routes[url]:
            raise AssertionError(f"unexpected transport request: {url}")
        outcome = self.routes[url].popleft()
        if isinstance(outcome, BaseException):
            raise outcome
        return HttpResponse(200, (), outcome, url)


class SpyKeywordLabeler:
    def __init__(self) -> None:
        self._labeler = KeywordRuleLabeler(
            "topic",
            "v1",
            {"Discovery": ("shared", "safe", "missing", "cached")},
        )
        self.taxonomy = self._labeler.taxonomy
        self.taxonomy_version = self._labeler.taxonomy_version
        self.calls: list[LabelInput] = []

    def label(self, label_input: LabelInput) -> LabelResult:
        self.calls.append(label_input)
        return self._labeler.label(label_input)


def _json_bytes(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), sort_keys=True).encode("utf-8")


def _crossref_body() -> bytes:
    items = [
        {
            "DOI": "10.1000/shared",
            "title": ["Crossref Shared Study"],
            "abstract": "<p>Crossref abstract</p>",
            "author": [{"given": "Ada", "family": "Lovelace"}],
            "published": {"date-parts": [[2024]]},
            "container-title": ["Crossref Journal"],
            "subject": ["Crossref keyword"],
        },
        {
            "DOI": "10.1000/title-merge",
            "title": ["Safe: Title Merge"],
            "abstract": "Crossref safe abstract",
            "author": [{"given": "Safe", "family": "Author"}],
            "published": {"date-parts": [[2024]]},
            "subject": ["Crossref safe"],
        },
        {
            "DOI": "10.1000/cached",
            "title": ["Cached Study"],
            "abstract": "Cached abstract",
            "published": {"date-parts": [[2025]]},
        },
        {"DOI": " ", "title": [" \t "], "abstract": "must never reach labeling"},
        {
            "DOI": "10.1000/missing",
            "title": ["Missing Abstract Study"],
            "published": {"date-parts": [[2023]]},
        },
    ]
    return _json_bytes({"message": {"items": items}})


def _europe_pmc_body() -> bytes:
    items = [
        {
            "doi": "10.1000/shared",
            "pmid": "111",
            "title": "Europe Shared Study",
            "abstractText": "Europe <b>shared abstract</b>",
            "authorList": {"author": [{"fullName": "Grace Hopper"}]},
            "pubYear": "2024",
            "journalInfo": {"journal": {"title": "Europe Journal"}},
            "keywordList": {"keyword": ["Europe keyword"]},
        },
        {
            "pmid": "222",
            "title": "Safe Title Merge",
            "abstractText": "Europe safe abstract",
            "authorList": {"author": [{"fullName": "Safe Author"}]},
            "pubYear": "2024",
            "keywordList": {"keyword": ["Europe safe"]},
        },
    ]
    return _json_bytes({"resultList": {"result": items}})


def _arxiv_body() -> bytes:
    return b"""<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>https://arxiv.org/abs/2401.00001v2</id>
    <title>arXiv Shared Study</title>
    <summary>arXiv shared abstract</summary>
    <published>2024-01-01T00:00:00Z</published>
    <author><name>Alan Turing</name></author>
    <category term="cs.IR"/>
    <arxiv:doi>10.1000/shared</arxiv:doi>
  </entry>
  <entry>
    <id>https://arxiv.org/abs/2402.00002</id>
    <title>Safe--Title Merge</title>
    <summary>arXiv safe abstract</summary>
    <published>2024-02-01T00:00:00Z</published>
    <author><name>Safe Author</name></author>
    <category term="cs.DL"/>
  </entry>
</feed>"""


def _permutation_bodies(reverse: bool) -> dict[str, bytes]:
    crossref = [
        {
            "DOI": "10.2000/deterministic",
            "title": ["Deterministic Study"],
            "author": [{"given": "Deterministic", "family": "Author"}],
        },
        {
            "DOI": "10.2000/deterministic",
            "title": ["Deterministic Study"],
            "author": [{"given": "Deterministic", "family": "Author"}],
        },
    ]
    europe_pmc = [
        {
            "pmid": "900",
            "title": "Deterministic Study",
            "authorList": {"author": [{"fullName": "Deterministic Author"}]},
            "pubYear": "2024",
        },
        {
            "pmid": "900",
            "pmcid": "PMC900",
            "title": "Deterministic Study",
            "authorList": {"author": [{"fullName": "Deterministic Author"}]},
            "pubYear": "2024",
        },
    ]
    arxiv = [
        ("2501.00001", ""),
        ("2501.00001", "<arxiv:doi>10.2000/deterministic</arxiv:doi>"),
    ]
    if reverse:
        crossref.reverse()
        europe_pmc.reverse()
        arxiv.reverse()
    entries = "".join(
        "<entry><id>https://arxiv.org/abs/{}</id><title>Deterministic Study</title>"
        "<published>2024-01-01T00:00:00Z</published>"
        "<author><name>Deterministic Author</name></author>{}</entry>".format(identifier, doi)
        for identifier, doi in arxiv
    )
    atom = (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<feed xmlns="http://www.w3.org/2005/Atom" '
        'xmlns:arxiv="http://arxiv.org/schemas/atom">'
        f"{entries}</feed>"
    ).encode("utf-8")
    return {
        CROSSREF_WORKS_URL: _json_bytes({"message": {"items": crossref}}),
        EUROPE_PMC_SEARCH_URL: _json_bytes({"resultList": {"result": europe_pmc}}),
        ARXIV_QUERY_URL: atom,
    }


class DiscoveryAcceptanceTests(TestCase):
    def setUp(self) -> None:
        self.temporary_directory = TemporaryDirectory()
        self.addCleanup(self.temporary_directory.cleanup)
        self.directory = Path(self.temporary_directory.name)
        self.catalog_path = self.directory / "catalog.sqlite"

        writable = create_catalog_engine(self.catalog_path)
        initialize_catalog(writable)
        repository = CatalogRepository(writable)
        resolution = IdentityResolver(repository).create_or_reuse_work(
            (Identifier("doi", "10.1000/cached"),)
        )
        cached_metadata = CandidateMetadata("Cached Study", "Cached abstract")
        repository.add_metadata_label(
            resolution.work_version.id,
            "topic",
            "v1",
            label_input_sha256(cached_metadata),
            "Catalog cached",
        )
        writable.dispose()

        self.read_only_engine = open_read_only_catalog_engine(self.catalog_path)
        self.addCleanup(self.read_only_engine.dispose)
        self.catalog = ReadOnlyCatalogView(self.read_only_engine)

    def _providers(
        self,
        bodies: dict[str, bytes] | None = None,
        *,
        route_order: tuple[str, ...] = (
            CROSSREF_WORKS_URL,
            EUROPE_PMC_SEARCH_URL,
            ARXIV_QUERY_URL,
        ),
    ) -> tuple[dict[str, DiscoveryProvider], RoutingTransport, list[float]]:
        bodies = bodies or {
            CROSSREF_WORKS_URL: _crossref_body(),
            EUROPE_PMC_SEARCH_URL: _europe_pmc_body(),
            ARXIV_QUERY_URL: _arxiv_body(),
        }
        transport = RoutingTransport({url: [bodies[url]] for url in route_order})
        sleeps: list[float] = []
        return (
            {
                "crossref": CrossrefProvider(transport, timeout=None),
                "europe-pmc": EuropePMCProvider(transport, timeout=None),
                "arxiv": ArxivProvider(transport, sleeper=sleeps.append, timeout=None),
            },
            transport,
            sleeps,
        )

    def _all_table_counts(self) -> dict[str, int]:
        with sqlite3.connect(self.catalog_path) as connection:
            tables = tuple(
                row[0]
                for row in connection.execute(
                    "SELECT name FROM sqlite_master "
                    "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
                )
            )
            return {
                table: connection.execute(
                    f'SELECT count(*) FROM "{table.replace(chr(34), chr(34) * 2)}"'
                ).fetchone()[0]
                for table in tables
            }

    def test_ac1_through_ac4_complete_offline_discovery(self) -> None:
        providers, transport, sleeps = self._providers()
        labeler = SpyKeywordLabeler()
        output = self.directory / "manifest.jsonl"
        before_counts = self._all_table_counts()

        entries = discover_to_jsonl(
            SearchSpec(
                "offline discovery",
                ("arxiv", "crossref", "europe-pmc"),
                10,
                (("year_to", "2026"), ("year_from", "2020")),
            ),
            output,
            providers=providers,
            catalog=self.catalog,
            labeler=labeler,
            intake_run_id=RUN_ID,
            retrieved_at=RETRIEVED_AT,
        )

        raw = output.read_bytes()
        parsed = tuple(
            DownloadManifestEntry.from_json_line(line)
            for line in raw.decode("utf-8").splitlines()
        )
        self.assertEqual(parsed, entries)
        self.assertEqual(len(entries), 4)
        self.assertTrue(raw.endswith(b"\n"))
        self.assertEqual(
            transport.calls,
            [CROSSREF_WORKS_URL, EUROPE_PMC_SEARCH_URL, ARXIV_QUERY_URL],
        )
        self.assertEqual(sleeps, [])

        by_doi = {
            identifier.value: entry
            for entry in entries
            for identifier in entry.identifiers
            if identifier.namespace == "doi"
        }
        shared = by_doi["10.1000/shared"]
        self.assertEqual(
            tuple((item.namespace, item.value) for item in shared.identifiers),
            (("doi", "10.1000/shared"), ("pmid", "111"), ("arxiv", "2401.00001v2")),
        )
        self.assertEqual(shared.metadata.title, "Crossref Shared Study")
        self.assertEqual(shared.metadata.abstract, "Europe shared abstract")
        self.assertEqual(shared.metadata.authors, ("Ada Lovelace",))
        self.assertEqual(
            shared.metadata.keywords,
            ("Crossref keyword", "cs.IR", "Europe keyword"),
        )
        self.assertEqual(shared.provenance.providers, ("arxiv", "crossref", "europe-pmc"))

        title_merged = by_doi["10.1000/title-merge"]
        self.assertEqual(
            tuple((item.namespace, item.value) for item in title_merged.identifiers),
            (("doi", "10.1000/title-merge"), ("pmid", "222"), ("arxiv", "2402.00002")),
        )
        self.assertEqual(
            title_merged.provenance.providers,
            ("arxiv", "crossref", "europe-pmc"),
        )

        cached = by_doi["10.1000/cached"]
        self.assertEqual(cached.labels, ("Catalog cached",))
        self.assertEqual(len(labeler.calls), 3)
        self.assertEqual(
            {call.title for call in labeler.calls},
            {"Crossref Shared Study", "Safe: Title Merge", "Missing Abstract Study"},
        )
        self.assertNotIn("must never reach labeling", {call.abstract for call in labeler.calls})

        missing = by_doi["10.1000/missing"]
        self.assertIsNone(missing.metadata.abstract)
        self.assertTrue(missing.missing_abstract)
        self.assertTrue(missing.needs_review)
        self.assertEqual(missing.review_reason, "missing_abstract")
        self.assertEqual(self._all_table_counts(), before_counts)

    def test_fixed_run_and_provider_input_permutations_are_byte_identical(self) -> None:
        outputs: list[bytes] = []
        endpoint_orders = (
            (CROSSREF_WORKS_URL, EUROPE_PMC_SEARCH_URL, ARXIV_QUERY_URL),
            (ARXIV_QUERY_URL, EUROPE_PMC_SEARCH_URL, CROSSREF_WORKS_URL),
        )
        source_orders = (
            ("crossref", "europe-pmc", "arxiv"),
            ("arxiv", "europe-pmc", "crossref"),
        )
        for index, (reverse, endpoint_order, source_order) in enumerate(
            zip((False, True), endpoint_orders, source_orders)
        ):
            providers, _, sleeps = self._providers(
                _permutation_bodies(reverse), route_order=endpoint_order
            )
            providers = {name: providers[name] for name in reversed(tuple(providers))}
            output = self.directory / f"manifest-{index}.jsonl"
            discover_to_jsonl(
                SearchSpec("determinism", source_order, 10),
                output,
                providers=providers,
                catalog=self.catalog,
                labeler=SpyKeywordLabeler(),
                intake_run_id=RUN_ID,
                retrieved_at=RETRIEVED_AT,
            )
            self.assertEqual(sleeps, [])
            outputs.append(output.read_bytes())

        self.assertEqual(outputs[0], outputs[1])
        self.assertEqual(len(outputs[0].splitlines()), 1)

    def test_provider_failure_preserves_preexisting_manifest_atomically(self) -> None:
        original = b'{"preexisting":true}\n'
        output = self.directory / "manifest.jsonl"
        output.write_bytes(original)
        transport = RoutingTransport(
            {
                CROSSREF_WORKS_URL: [_crossref_body()],
                EUROPE_PMC_SEARCH_URL: [OSError("offline")],
                ARXIV_QUERY_URL: [_arxiv_body()],
            }
        )
        providers = {
            "arxiv": ArxivProvider(transport, sleeper=lambda _: None, timeout=None),
            "europe-pmc": EuropePMCProvider(transport, timeout=None),
            "crossref": CrossrefProvider(transport, timeout=None),
        }

        with self.assertRaises(ProviderSearchError):
            discover_to_jsonl(
                SearchSpec("failure", ("arxiv", "europe-pmc", "crossref"), 10),
                output,
                providers=providers,
                catalog=self.catalog,
                labeler=SpyKeywordLabeler(),
                intake_run_id=RUN_ID,
                retrieved_at=RETRIEVED_AT,
            )

        self.assertEqual(output.read_bytes(), original)
        self.assertEqual(transport.calls, [CROSSREF_WORKS_URL, EUROPE_PMC_SEARCH_URL])


if __name__ == "__main__":
    import unittest

    unittest.main()
