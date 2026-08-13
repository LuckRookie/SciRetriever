"""Exercise installed-wheel topic discovery with test-owned Metadata ports.

The process is launched by the fresh virtual environment and imports every
SciRetriever module from that environment's ``site-packages``.  Only the two
external Metadata capabilities and deterministic clock/identity inputs are
test-owned; Entry, Metadata, Literature, SQLite, and ArtifactStore are the
installed product implementations.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

import sciretriever.entry.discovery as entry_discovery_module
import sciretriever.literature.service as literature_service_module
import sciretriever.metadata.service as metadata_service_module
import sciretriever.storage.sqlite.discovery_repository as discovery_repository_module
from sciretriever.entry.discovery import TopicDiscoveryOperation
from sciretriever.literature.api import LiteratureApi
from sciretriever.literature.service import LiteratureService
from sciretriever.metadata.api import MetadataApi, MetadataPublication
from sciretriever.metadata.ports import (
    MetadataProviderFailure,
    RawItemDelivery,
    RawItemSession,
)
from sciretriever.metadata.rules import NeutralMetadataItem, TopicSearchQuery
from sciretriever.metadata.service import MetadataService
from sciretriever.model.discovery import ProviderDiscoveryLimit, TopicDiscoveryInput
from sciretriever.model.library import LibraryQuery, LibrarySearchRequest
from sciretriever.model.literature import Identifier
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance
from sciretriever.model.report import StableFailure
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactStore
from sciretriever.storage.literature_artifacts import LiteratureArtifactReader
from sciretriever.storage.locking import CatalogWriteLock
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.discovery_repository import SqliteDiscoveryRepository
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
from sciretriever.storage.sqlite.literature_reader import LiteratureReader
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.metadata_publication import (
    SqliteProviderRelationObservationPublication,
)

_TIME = UtcTimestamp("2026-08-12T12:00:00Z")
_HASH = Sha256("a" * 64)


def _uuid(index: int) -> str:
    return f"{index:08x}-0000-4000-8000-{index:012x}"


def _observation(index: int, provider: str, title: str) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_uuid(100 + index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_uuid(200 + index)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=provider,
            source_record_id=f"record-{index}",
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
        metadata=LiteratureMetadata(
            title=title,
            identifiers=(Identifier(namespace="doi", value="10.5555/shared-work"),),
        ),
    )


class _Session(RawItemSession):
    def __init__(
        self,
        items: tuple[NeutralMetadataItem, ...],
        *,
        fail_after_items: bool = False,
    ) -> None:
        self._items = items
        self._fail_after_items = fail_after_items
        self.pulled = 0
        self.converted = 0

    def pull_raw_item(self) -> RawItemDelivery | None:
        if self.pulled < len(self._items):
            item = self._items[self.pulled]
            self.pulled += 1
            return RawItemDelivery(raw_item=item, source_exhausted_after=False)
        if self._fail_after_items:
            raise MetadataProviderFailure(
                StableFailure(
                    code="offline-provider-failed",
                    reason="The controlled offline provider failed.",
                    action="Retry the controlled provider.",
                    retryable=True,
                )
            )
        return None

    def convert_raw_item(self, raw_item: object) -> NeutralMetadataItem:
        self.converted += 1
        if not isinstance(raw_item, NeutralMetadataItem):
            raise TypeError("controlled raw item has an invalid type")
        return raw_item


class _TopicPort:
    def __init__(self, provider_name: str, session: _Session) -> None:
        self._provider_name = provider_name
        self._session = session
        self.queries: list[TopicSearchQuery] = []

    @property
    def provider_name(self) -> str:
        return self._provider_name

    def open_topic_search(self, query: TopicSearchQuery) -> RawItemSession:
        self.queries.append(query)
        return self._session


class _Clock:
    def now(self) -> UtcTimestamp:
        return _TIME


class _Ids:
    def __init__(self) -> None:
        self._next_value = 80_000

    def _next(self) -> str:
        value = _uuid(self._next_value)
        self._next_value += 1
        return value

    def new_literature_id(self) -> LiteratureId:
        return LiteratureId(self._next())

    def new_meta_literature_id(self) -> MetaLiteratureId:
        return MetaLiteratureId(self._next())

    def new_reference_id(self) -> ReferenceId:
        return ReferenceId(self._next())


class _WriteAdmission:
    def __init__(self, catalog_path: Path) -> None:
        self._catalog_path = catalog_path

    @contextmanager
    def acquire_nowait(self) -> Iterator[None]:
        with CatalogWriteLock(self._catalog_path):
            yield None


def _configuration(catalog: Path, artifacts: Path) -> str:
    return f"""
[paths]
catalog_path = {json.dumps(os.fspath(catalog))}
artifact_root = {json.dumps(os.fspath(artifacts))}
"""


root = Path(os.environ["SCIRETRIEVER_ACCEPTANCE_ROOT"]) / "topic-discovery"
root.mkdir(mode=0o700)
catalog = root / "catalog.sqlite3"
artifacts = root / "artifacts"
engine = CatalogEngine(catalog)
storage_root = StorageRoot(artifacts)
artifact_store = ArtifactStore(storage_root)
verified_reader = VerifiedReader(storage_root)
writer = LiteratureWriter(engine)
literature = LiteratureApi(
    LiteratureService(
        read_port=LiteraturePreconditionReader(engine, verified_reader),
        identity_port=writer,
        content_port=SqliteContentPublication(engine, artifact_store, verified_reader),
        reference_port=writer,
        maintenance_port=writer,
        id_factory=_Ids(),
        query_port=LiteratureReader(engine, verified_reader),
        artifact_read_port=LiteratureArtifactReader(engine, verified_reader),
    )
)

alpha_session = _Session(
    (
        NeutralMetadataItem(),
        NeutralMetadataItem(observations=(_observation(1, "alpha", "Shared work from alpha"),)),
        NeutralMetadataItem(
            observations=(_observation(2, "alpha", "Must remain beyond scan limit"),)
        ),
    )
)
beta_session = _Session(
    (NeutralMetadataItem(observations=(_observation(3, "beta", "Shared work from beta"),)),),
    fail_after_items=True,
)
alpha = _TopicPort("alpha", alpha_session)
beta = _TopicPort("beta", beta_session)
metadata = MetadataApi(MetadataService(topic_search_ports=(alpha, beta)))
repository = SqliteDiscoveryRepository(engine)
operation = TopicDiscoveryOperation(
    metadata=metadata,
    metadata_publication=MetadataPublication(
        literature,
        SqliteProviderRelationObservationPublication(writer),
    ),
    repository=repository,
    publication=repository,
    clock=_Clock(),
    write_admission=_WriteAdmission(catalog),
    recovery=repository,
    run_id_factory=lambda: DiscoveryRunId(_uuid(1)),
)
request = TopicDiscoveryInput(
    kind="topic",
    query="controlled offline discovery",
    providers=(
        ProviderDiscoveryLimit(provider_name="alpha", scan_limit=2),
        ProviderDiscoveryLimit(provider_name="beta", scan_limit=5),
    ),
)
report = operation(request)
snapshot = repository.read(report.discovery_run_id)
page = literature.search(
    LibrarySearchRequest(
        query=LibraryQuery(discovery_run_ids=(report.discovery_run_id,)),
        limit=10,
    )
)
if len(page.items) != 1:
    raise RuntimeError("topic discovery did not produce one concrete Literature")
detail = literature.read_detail(page.items[0].literature.literature_id)

configuration = root / "config.toml"
configuration.write_text(_configuration(catalog, artifacts), encoding="utf-8")
environment = dict(os.environ)
environment["SCIRETRIEVER_CONFIG"] = os.fspath(configuration)
console = Path(sys.executable).with_name("sciretriever")
completed = subprocess.run(
    (
        os.fspath(console),
        "literature",
        "search",
        "--discovery-run-id",
        report.discovery_run_id.root,
        "--json",
    ),
    cwd=root,
    env=environment,
    check=False,
    capture_output=True,
    text=True,
    timeout=30,
)

payload = {
    "console": {
        "returncode": completed.returncode,
        "stderr": completed.stderr,
        "stdout": completed.stdout,
    },
    "detail": {
        "literature_id": detail.literature.literature_id.root,
        "meta_literature_id": detail.literature.meta_literature_id.root,
        "observation_ids": [item.observation_id.root for item in detail.metadata_observations],
        "observation_sources": [
            item.provenance.source_name for item in detail.metadata_observations
        ],
    },
    "fake_boundary": {
        "alpha_converted": alpha_session.converted,
        "alpha_pulled": alpha_session.pulled,
        "beta_converted": beta_session.converted,
        "beta_pulled": beta_session.pulled,
        "queries": [item.model_dump(mode="json") for item in (*alpha.queries, *beta.queries)],
    },
    "local_page": page.model_dump(mode="json"),
    "product_module_files": {
        "entry": entry_discovery_module.__file__,
        "literature": literature_service_module.__file__,
        "metadata": metadata_service_module.__file__,
        "storage": discovery_repository_module.__file__,
    },
    "report": report.model_dump(mode="json"),
    "snapshot": {
        "causes": [item.model_dump(mode="json") for item in snapshot.causes],
        "results": [item.model_dump(mode="json") for item in snapshot.results],
        "run": snapshot.run.model_dump(mode="json"),
        "source_results": [item.model_dump(mode="json") for item in snapshot.source_results],
    },
}
print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
