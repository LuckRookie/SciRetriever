import asyncio
from io import BytesIO
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import threading
import time
from unittest import TestCase

from PyPDF2 import PdfWriter

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.acquisition.browser import BrowserRuleResolver
from sciretriever.acquisition.candidate_executor import CandidateExecutor
from sciretriever.acquisition.identity_validation import ContentIdentityValidator
from sciretriever.acquisition.candidates import RuntimeDownloadCandidate, make_download_candidate_id
from sciretriever.acquisition.models import AcquisitionTarget, ProviderContent
from sciretriever.acquisition.service import WorkVersionAcquisitionService
from sciretriever.acquisition.sci_hub import SciHubResolver
from sciretriever.acquisition.translator import TranslatorRuleResolver
from sciretriever.acquisition.providers_p5 import SpringerResolver
from sciretriever.catalog import (
    AssetRepository,
    AuthorRepository,
    LibraryFilters,
    RegistryRepository,
    TagRepository,
    WorkRepository,
    WorkVersionDownloadRepository,
    create_catalog_engine,
    initialize_catalog,
)
from sciretriever.core.enums import AssetRole
from sciretriever.config import BrowserRuleConfig, SciHubConfig, TranslatorRuleConfig
from sciretriever.network import HttpResponse
from sciretriever.storage import AssetAcceptanceCoordinator, RawAssetStore


def pdf_bytes(label: str = "wp3") -> bytes:
    stream = BytesIO()
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    writer.add_blank_page(width=72, height=72)
    writer.add_metadata({
        "/Title": "Catalysis Alpha accepted",
        "/Subject": label * 200,
    })
    writer.write(stream)
    return stream.getvalue()


class Transport:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []
        self.lock = threading.Lock()

    def get(self, url, *, params=None, headers=None, timeout=None):
        del params, timeout
        with self.lock:
            self.calls.append((url, dict(headers or {})))
        delay, status, media_type, body = self.responses[url]
        time.sleep(delay)
        return HttpResponse(status, url, {"content-type": media_type}, body)

    def resolve_host(self, hostname):
        del hostname
        return ("192.0.2.1",)


class Resolver:
    def __init__(self, provider, urls_by_role, *, duplicate=False, secret=None):
        self.provider = provider
        self.resolver_id = provider
        self.urls_by_role = urls_by_role
        self.duplicate = duplicate
        self.secret = secret

    def resolve(self, target, role, *, timeout):
        del target, timeout
        candidates = []
        for index, url in enumerate(self.urls_by_role.get(role, ())):
            cursor = f"rc1:item-{index}"
            candidates.append(RuntimeDownloadCandidate(
                make_download_candidate_id(self.provider, self.resolver_id, role, cursor),
                self.provider, self.resolver_id, self.provider, cursor, url, role, index,
                "https", "resolver", f"host:{self.provider}-{index}.test",
                {"provider": self.provider},
                request_headers={} if self.secret is None else {"Authorization": self.secret},
                media_type_hint={
                    AssetRole.PRIMARY_PDF: "application/pdf",
                    AssetRole.XML: "application/xml",
                    AssetRole.HTML: "text/html",
                }[role],
            ))
        if self.duplicate and candidates:
            candidates.insert(1, candidates[0])
        return tuple(candidates)


class DownloadWp3Fixture(TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.engine = create_catalog_engine(self.root / "catalog.sqlite")
        initialize_catalog(self.engine)
        self.addCleanup(self.engine.dispose)
        self.works = WorkRepository(self.engine)
        publisher = RegistryRepository(self.engine).add("publisher", "Example Press")
        venue = RegistryRepository(self.engine).add("venue", "Journal of Tests")
        self.first = self.works.ingest_version(
            provider="fixture", provider_record_id="one", title="Catalysis Alpha",
            doi="10.1000/alpha", publication_date="2024-01-02",
            publisher_id=publisher.id, venue_id=venue.id,
            metadata={"publication_year": 2024, "direct_url": "https://direct.test/alpha.pdf"},
        )
        self.second = self.works.ingest_version(
            provider="fixture", provider_record_id="two", title="Catalysis Alpha accepted",
            version_class="accepted_manuscript", publication_date="2023-01-02",
            publisher_id=publisher.id, venue_id=venue.id,
            related_work_version_id=self.first.id,
            relation_evidence={"provider": "fixture"},
        )
        self.works.set_preferred(self.first.work_id, self.second.id)
        AuthorRepository(self.engine).add_authorship(self.second.id, "Ada Lovelace", 0)
        tag = TagRepository(self.engine).add("kinetics")
        TagRepository(self.engine).add_manual(self.first.work_id, tag.id)
        self.repository = WorkVersionDownloadRepository(self.engine)
        self.assets = AssetRepository(self.engine)
        asset_root = self.root / "assets"
        asset_root.mkdir()
        self.coordinator = AssetAcceptanceCoordinator(self.assets, RawAssetStore(asset_root))

    def service(self, transport, resolvers, *, concurrency=4, translators=(), browsers=(), browser_runner=None):
        return WorkVersionAcquisitionService(
            self.assets, self.coordinator, resolvers, CandidateExecutor(
                transport, browser_runner=browser_runner,
                identity_validator=ContentIdentityValidator(),
            ),
            translator_resolvers=translators,
            browser_resolvers=browsers,
            provider_concurrency=concurrency,
        )

    def target(self, work_version_id, role=AssetRole.PRIMARY_PDF):
        record = self.repository.get(work_version_id)
        return AcquisitionTarget(record.identifiers, role=role, title=record.title)

    @staticmethod
    def translator(transport, name, host):
        return TranslatorRuleResolver(transport, TranslatorRuleConfig(
            name, f"https://{host}/article/{{doi}}", (), (),
        ))
