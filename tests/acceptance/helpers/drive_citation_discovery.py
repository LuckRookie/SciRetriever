"""Exercise installed-wheel citation discovery over real local persistence.

The Metadata lookup/query ports and the unused reference-text analysis boundary
are test-owned.  Citation Entry orchestration, Metadata raw-item accounting,
Literature identity/Reference acceptance, SQLite reads/publication, and the
ArtifactStore binding are all imported from the freshly installed wheel.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from contextlib import AbstractContextManager, contextmanager
from pathlib import Path
from typing import BinaryIO, Iterator, NoReturn

import sciretriever.entry.citations as entry_citations_module
import sciretriever.literature.service as literature_service_module
import sciretriever.metadata.service as metadata_service_module
import sciretriever.storage.sqlite.discovery_repository as discovery_repository_module
from sciretriever.agents import AgentRequest, AgentStructuredResponse
from sciretriever.analysis.api import AnalysisApi
from sciretriever.analysis.content import ContentAnalysisLimits
from sciretriever.analysis.ports import (
    ContentInputIdentity,
    StagedContentMarkdown,
)
from sciretriever.analysis.references import ReferenceLookupStage
from sciretriever.analysis.service import AnalysisService
from sciretriever.entry.citations import CitationDiscoveryOperation
from sciretriever.literature.api import LiteratureApi
from sciretriever.literature.service import LiteratureService
from sciretriever.metadata.api import MetadataApi, MetadataPublication
from sciretriever.metadata.ports import RawItemDelivery, RawItemSession
from sciretriever.metadata.rules import (
    NeutralMetadataItem,
    ReferenceQueryContext,
)
from sciretriever.metadata.service import MetadataService
from sciretriever.model.analysis import ArtifactRef
from sciretriever.model.discovery import CitationDiscoveryInput, ProviderDiscoveryLimit
from sciretriever.model.library import (
    LibraryQuery,
    LibrarySearchRequest,
    LiteratureReferenceRequest,
)
from sciretriever.model.literature import Identifier, Literature
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.parsing import ParserArtifactRef
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
from sciretriever.storage.files.paths import StorageRoot
from sciretriever.storage.files.reader import VerifiedReader
from sciretriever.storage.files.store import ArtifactStore
from sciretriever.storage.literature_artifacts import LiteratureArtifactReader
from sciretriever.storage.locking import CatalogWriteLock
from sciretriever.storage.sqlite.content_publication import SqliteContentPublication
from sciretriever.storage.sqlite.discovery_repository import SqliteDiscoveryRepository
from sciretriever.storage.sqlite.engine import CatalogEngine
from sciretriever.storage.sqlite.entry_reader import SqliteEntryReader
from sciretriever.storage.sqlite.literature_preconditions import LiteraturePreconditionReader
from sciretriever.storage.sqlite.literature_reader import LiteratureReader
from sciretriever.storage.sqlite.literature_writer import LiteratureWriter
from sciretriever.storage.sqlite.metadata_publication import (
    SqliteProviderRelationObservationPublication,
)

_TIME = UtcTimestamp("2026-08-12T12:30:00Z")
_HASH = Sha256("b" * 64)
_PROVIDER = "citation-fixture"


def _uuid(index: int) -> str:
    return f"{index:08x}-0000-4000-8000-{index:012x}"


def _metadata(index: int) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=f"Citation acceptance {index}",
        publication_year=2020 + index,
        identifiers=(Identifier(namespace="doi", value=f"10.5555/citation-{index}"),),
    )


def _observation(index: int, record_id: str) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_uuid(10_000 + index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_uuid(20_000 + index)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=_PROVIDER,
            source_record_id=record_id,
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
        metadata=_metadata(index),
    )


def _relation(
    index: int,
    *,
    citing_record_id: str,
    cited_record_id: str,
) -> ProviderRelationObservation:
    return ProviderRelationObservation(
        observation_id=ObservationId(_uuid(30_000 + index)),
        provenance=Provenance(
            provenance_id=ProvenanceId(_uuid(40_000 + index)),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=_PROVIDER,
            source_record_id=f"relation-{index}",
            observed_at=_TIME,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
        citing=ProviderLiteratureKey(record_id=citing_record_id),
        cited=ProviderLiteratureKey(record_id=cited_record_id),
    )


class _Session(RawItemSession):
    def __init__(
        self,
        items: tuple[NeutralMetadataItem, ...],
        *,
        exhaust_after_last: bool,
    ) -> None:
        self._items = items
        self._exhaust_after_last = exhaust_after_last
        self.pulled = 0
        self.converted = 0

    def pull_raw_item(self) -> RawItemDelivery | None:
        if self.pulled == len(self._items):
            return None
        item = self._items[self.pulled]
        self.pulled += 1
        return RawItemDelivery(
            raw_item=item,
            source_exhausted_after=(self._exhaust_after_last and self.pulled == len(self._items)),
        )

    def convert_raw_item(self, raw_item: object) -> NeutralMetadataItem:
        self.converted += 1
        if not isinstance(raw_item, NeutralMetadataItem):
            raise TypeError("controlled raw item has an invalid type")
        return raw_item


class _ReferencePort:
    def __init__(self, session: _Session) -> None:
        self._session = session
        self.queries: list[ReferenceQueryContext] = []

    @property
    def provider_name(self) -> str:
        return _PROVIDER

    def open_reference_query(self, query: ReferenceQueryContext) -> RawItemSession:
        self.queries.append(query)
        return self._session


class _LookupPort:
    def __init__(self, session: _Session) -> None:
        self._session = session
        self.keys: list[ProviderLiteratureKey] = []

    @property
    def provider_name(self) -> str:
        return _PROVIDER

    def open_lookup(self, key: ProviderLiteratureKey) -> RawItemSession:
        self.keys.append(key)
        return self._session


def _unexpected_analysis_boundary(name: str) -> NoReturn:
    raise AssertionError(f"unused Analysis boundary was called: {name}")


class _UnusedAnalysisAgent:
    def __init__(self) -> None:
        self.calls = 0

    @property
    def provider_name(self) -> str:
        return "citation-acceptance-analysis"

    def complete(self, request: AgentRequest) -> AgentStructuredResponse:
        del request
        self.calls += 1
        _unexpected_analysis_boundary("llm.complete")


class _UnusedAnalysisArtifactReader:
    def open_artifact(
        self,
        reference: ParserArtifactRef,
    ) -> AbstractContextManager[BinaryIO]:
        del reference
        _unexpected_analysis_boundary("artifact_reader.open_artifact")


class _UnusedAnalysisCurrentInputs:
    def current_input_matches(self, identity: ContentInputIdentity) -> bool:
        del identity
        _unexpected_analysis_boundary("current_inputs.current_input_matches")


class _UnusedAnalysisArtifactPublisher:
    def publish_markdown(self, staged: StagedContentMarkdown) -> ArtifactRef:
        del staged
        _unexpected_analysis_boundary("artifact_publisher.publish_markdown")


class _Clock:
    def now(self) -> UtcTimestamp:
        return _TIME


class _Ids:
    def __init__(self) -> None:
        self._next_value = 90_000

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


def _accept(
    publication: MetadataPublication,
    observation: MetadataObservation,
) -> Literature:
    result = publication.publish_observation(observation)
    if result.decision != "created" or result.literature is None:
        raise RuntimeError("controlled Literature seed was not created")
    return result.literature


def _configuration(catalog: Path, artifacts: Path) -> str:
    return f"""
[paths]
catalog_path = {json.dumps(os.fspath(catalog))}
artifact_root = {json.dumps(os.fspath(artifacts))}
"""


root = Path(os.environ["SCIRETRIEVER_ACCEPTANCE_ROOT"]) / "citation-discovery"
root.mkdir(mode=0o700)
catalog = root / "catalog.sqlite3"
artifacts = root / "artifacts"
engine = CatalogEngine(catalog)
storage_root = StorageRoot(artifacts)
verified_reader = VerifiedReader(storage_root)
store = ArtifactStore(storage_root)
writer = LiteratureWriter(engine)
literature = LiteratureApi(
    LiteratureService(
        read_port=LiteraturePreconditionReader(engine, verified_reader),
        identity_port=writer,
        content_port=SqliteContentPublication(engine, store, verified_reader),
        reference_port=writer,
        maintenance_port=writer,
        id_factory=_Ids(),
        query_port=LiteratureReader(engine, verified_reader),
        artifact_read_port=LiteratureArtifactReader(engine, verified_reader),
    )
)
publication = MetadataPublication(
    literature,
    SqliteProviderRelationObservationPublication(writer),
)

# Pre-existing Literature and provider relations used at depth two.  The first
# target itself is deliberately absent until the bounded provider lookup.
seed = _accept(publication, _observation(1, "seed"))
depth_two = _accept(publication, _observation(3, "depth-two"))
over_limit = _accept(publication, _observation(4, "over-limit"))
depth_two_relation = _relation(
    1,
    citing_record_id="target",
    cited_record_id="depth-two",
)
over_limit_relation = _relation(
    2,
    citing_record_id="target",
    cited_record_id="over-limit",
)
publication.publish_relation_observations((depth_two_relation, over_limit_relation))

first_relation = _relation(3, citing_record_id="seed", cited_record_id="target")
target_observation = _observation(2, "target")
reference_session = _Session(
    (
        NeutralMetadataItem(),
        NeutralMetadataItem(relations=(first_relation,)),
    ),
    exhaust_after_last=True,
)
lookup_session = _Session(
    (
        NeutralMetadataItem(),
        NeutralMetadataItem(),
        NeutralMetadataItem(observations=(target_observation,)),
        NeutralMetadataItem(),  # must remain unpulled after the run-wide limit
    ),
    exhaust_after_last=False,
)
reference_port = _ReferencePort(reference_session)
lookup_port = _LookupPort(lookup_session)
metadata = MetadataApi(
    MetadataService(
        lookup_ports=(lookup_port,),
        reference_query_ports=(reference_port,),
    )
)
repository = SqliteDiscoveryRepository(engine)
analysis_llm = _UnusedAnalysisAgent()
analysis = AnalysisApi(
    content_service=AnalysisService(
        agents=analysis_llm,
        artifact_reader=_UnusedAnalysisArtifactReader(),
        current_inputs=_UnusedAnalysisCurrentInputs(),
        artifact_publisher=_UnusedAnalysisArtifactPublisher(),
        model="citation-acceptance-analysis",
        metadata_max_output_tokens=1,
        content_max_output_tokens=1,
        limits=ContentAnalysisLimits(
            max_input_bytes=1,
            max_chunk_bytes=1,
            max_chunk_count=1,
            max_total_llm_requests=2,
            max_total_output_tokens=2,
        ),
    ),
    reference_lookup_stage=ReferenceLookupStage(
        agents=analysis_llm,
        model="citation-acceptance-analysis",
        max_output_tokens=1,
    ),
)
run_ids = iter((DiscoveryRunId(_uuid(1)), DiscoveryRunId(_uuid(2))))


def _operation() -> CitationDiscoveryOperation:
    return CitationDiscoveryOperation(
        metadata=metadata,
        relation_publication=publication,
        literature=literature,
        analysis=analysis,
        candidate_reader=SqliteEntryReader(engine, verified_reader),
        run_repository=repository,
        discovery_publication=repository,
        write_admission=_WriteAdmission(catalog),
        recovery=repository,
        clock=_Clock(),
        run_id_factory=lambda: next(run_ids),
    )


forward_report = _operation()(
    CitationDiscoveryInput(
        kind="citation",
        seed_literature_ids=(seed.literature_id,),
        direction="references",
        max_depth=2,
        result_limit=2,
        providers=(ProviderDiscoveryLimit(provider_name=_PROVIDER, scan_limit=5),),
    )
)
forward_snapshot = repository.read(forward_report.discovery_run_id)
forward_page = literature.search(
    LibrarySearchRequest(
        query=LibraryQuery(discovery_run_ids=(forward_report.discovery_run_id,)),
        limit=10,
    )
)
seed_references = literature.read_references(
    LiteratureReferenceRequest(
        literature_id=seed.literature_id,
        direction="references",
        limit=10,
    )
)
depth_two_cited_by = literature.read_references(
    LiteratureReferenceRequest(
        literature_id=depth_two.literature_id,
        direction="cited-by",
        limit=10,
    )
)

# A separate reverse-direction run begins at the cited endpoint.  It uses a
# persisted relation and must keep the authoritative edge in citing->cited
# order even though the discovered Literature is the citing endpoint.
reverse_citing = _accept(publication, _observation(5, "reverse-citing"))
reverse_cited = _accept(publication, _observation(6, "reverse-cited"))
reverse_relation = _relation(
    4,
    citing_record_id="reverse-citing",
    cited_record_id="reverse-cited",
)
publication.publish_relation_observations((reverse_relation,))
reverse_report = _operation()(
    CitationDiscoveryInput(
        kind="citation",
        seed_literature_ids=(reverse_cited.literature_id,),
        direction="cited-by",
        max_depth=1,
        result_limit=1,
        providers=(ProviderDiscoveryLimit(provider_name=_PROVIDER, scan_limit=5),),
    )
)
reverse_snapshot = repository.read(reverse_report.discovery_run_id)
reverse_page = literature.read_references(
    LiteratureReferenceRequest(
        literature_id=reverse_cited.literature_id,
        direction="cited-by",
        limit=10,
    )
)

with engine.read_snapshot() as connection:
    database_counts = {
        "discovery_results": connection.execute(
            "SELECT count(*) FROM discovery_results"
        ).fetchone()[0],
        "literature_references": connection.execute(
            "SELECT count(*) FROM literature_references"
        ).fetchone()[0],
        "provider_relation_observations": connection.execute(
            "SELECT count(*) FROM provider_relation_observations"
        ).fetchone()[0],
        "provider_relation_reference_supports": connection.execute(
            "SELECT count(*) FROM provider_relation_reference_supports"
        ).fetchone()[0],
    }
    over_limit_edges = connection.execute(
        "SELECT count(*) FROM literature_references "
        "WHERE source_literature_id=? OR target_literature_id=?",
        (over_limit.literature_id.root, over_limit.literature_id.root),
    ).fetchone()[0]

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
        forward_report.discovery_run_id.root,
        "--json",
    ),
    cwd=root,
    env=environment,
    check=False,
    capture_output=True,
    text=True,
    timeout=30,
)
console_reads = {}
for name, arguments in {
    "references": (
        "literature",
        "references",
        seed.literature_id.root,
        "--json",
    ),
    "cited_by": (
        "literature",
        "cited-by",
        depth_two.literature_id.root,
        "--json",
    ),
    "reference_detail": (
        "literature",
        "references",
        "--reference-id",
        seed_references.items[0].reference.reference_id.root,
        "--json",
    ),
}.items():
    result = subprocess.run(
        (os.fspath(console), *arguments),
        cwd=root,
        env=environment,
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    console_reads[name] = {
        "returncode": result.returncode,
        "stderr": result.stderr,
        "stdout": result.stdout,
    }

payload = {
    "analysis_calls": analysis_llm.calls,
    "budget": {
        "lookup_converted": lookup_session.converted,
        "lookup_keys": [item.model_dump(mode="json") for item in lookup_port.keys],
        "lookup_pulled": lookup_session.pulled,
        "query_converted": reference_session.converted,
        "query_contexts": [item.model_dump(mode="json") for item in reference_port.queries],
        "query_pulled": reference_session.pulled,
    },
    "console": {
        "returncode": completed.returncode,
        "stderr": completed.stderr,
        "stdout": completed.stdout,
    },
    "console_reads": console_reads,
    "database": {
        "counts": database_counts,
        "over_limit_edges": over_limit_edges,
    },
    "forward": {
        "depth_two_cited_by": depth_two_cited_by.model_dump(mode="json"),
        "page": forward_page.model_dump(mode="json"),
        "report": forward_report.model_dump(mode="json"),
        "seed_references": seed_references.model_dump(mode="json"),
        "snapshot": {
            "causes": [item.model_dump(mode="json") for item in forward_snapshot.causes],
            "results": [item.model_dump(mode="json") for item in forward_snapshot.results],
            "run": forward_snapshot.run.model_dump(mode="json"),
            "source_results": [
                item.model_dump(mode="json") for item in forward_snapshot.source_results
            ],
        },
    },
    "identities": {
        "depth_two": depth_two.literature_id.root,
        "over_limit": over_limit.literature_id.root,
        "reverse_cited": reverse_cited.literature_id.root,
        "reverse_citing": reverse_citing.literature_id.root,
        "seed": seed.literature_id.root,
        "target": seed_references.items[0].reference.target_literature_id.root,
    },
    "product_module_files": {
        "entry": entry_citations_module.__file__,
        "literature": literature_service_module.__file__,
        "metadata": metadata_service_module.__file__,
        "storage": discovery_repository_module.__file__,
    },
    "reverse": {
        "page": reverse_page.model_dump(mode="json"),
        "report": reverse_report.model_dump(mode="json"),
        "snapshot": {
            "causes": [item.model_dump(mode="json") for item in reverse_snapshot.causes],
            "results": [item.model_dump(mode="json") for item in reverse_snapshot.results],
            "run": reverse_snapshot.run.model_dump(mode="json"),
            "source_results": [
                item.model_dump(mode="json") for item in reverse_snapshot.source_results
            ],
        },
    },
}
print(json.dumps(payload, sort_keys=True, separators=(",", ":")))
