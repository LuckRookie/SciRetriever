from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

from typing_extensions import assert_never

from sciretriever.infrastructure.storage.sqlite import (
    CollectionAcceptancePublisher,
    CompletionPublisher,
    ContentAcceptancePublisher,
    ImportAcceptancePublisher,
    SqliteLiteratureRepository,
    create_or_open_catalog,
)
from sciretriever.kernel import CanonicalJsonObject
from sciretriever.model.assets import (
    ArtifactKind,
    PrimaryPdfAcceptance,
    PublishedArtifact,
    SupplementaryAssetAcceptance,
)
from sciretriever.model.collection import CollectionAcceptance, CollectionMembershipFact
from sciretriever.model.documents import LightDocumentAcceptance
from sciretriever.model.execution import (
    ContentAcceptanceCommand,
    ImportAcceptanceCommand,
    ImportRecordProjection,
    ImportResult,
    TargetProjection,
)
from sciretriever.model.literature import (
    BibliographicObservation,
    CompletionSubmission,
    Identifier,
    InitialMetadata,
    ReferenceSetFact,
    TagSetFact,
)
from sciretriever.model.primitives import (
    BatchRunId,
    CollectionId,
    CollectionRunId,
    MembershipId,
    ReferenceSetId,
    RelativeArtifactPath,
    TagSetId,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.services.assets import accept_content
from sciretriever.services.documents import accept_document
from sciretriever.services.library import accept_import
from sciretriever.services.literature.api import accept_completion, prepare_initial_ingest
from tests import target_publisher_content_scenarios

EMPTY = CanonicalJsonObject(())


@dataclass(frozen=True, slots=True)
class Scenario:
    path: Path
    publisher: (
        CollectionAcceptancePublisher
        | ImportAcceptancePublisher
        | ContentAcceptancePublisher
        | CompletionPublisher
    )
    command: (
        CollectionAcceptance
        | ImportAcceptanceCommand
        | ContentAcceptanceCommand
        | CompletionSubmission
    )
    authority_table: str
    target: TargetProjection | None = None

    def invoke(self) -> None:
        match self.publisher:
            case CompletionPublisher():
                assert isinstance(self.command, CompletionSubmission)
                assert self.target is not None
                accept_completion(
                    SqliteLiteratureRepository(self.path),
                    self.publisher,
                    self.command,
                    self.target,
                )
            case ImportAcceptancePublisher():
                assert isinstance(self.command, ImportAcceptanceCommand)
                accept_import(self.publisher, self.command)
            case ContentAcceptancePublisher():
                assert isinstance(self.command, ContentAcceptanceCommand)
                match self.command.acceptance:
                    case LightDocumentAcceptance():
                        accept_document(
                            self.publisher, self.command.acceptance, self.command.target
                        )
                    case PrimaryPdfAcceptance() | SupplementaryAssetAcceptance():
                        accept_content(self.publisher, self.command.acceptance, self.command.target)
                    case unreachable:
                        assert_never(unreachable)
            case CollectionAcceptancePublisher():
                assert isinstance(self.command, CollectionAcceptance)
                self.publisher.publish(self.command)
            case unreachable:
                assert_never(unreachable)


class ScenarioFactory:
    def __init__(self) -> None:
        self.temporary = TemporaryDirectory(prefix="sciretriever-task9-repair-")
        self.root = Path(self.temporary.name)
        os.chmod(self.root, 0o700)
        self.index = 0

    def cleanup(self) -> None:
        self.temporary.cleanup()

    def catalog(self) -> Path:
        self.index += 1
        path = self.root / f"scenario-{self.index}.sqlite"
        with create_or_open_catalog(path):
            pass
        return path

    @staticmethod
    def prepared(path: Path, suffix: str = "a"):
        observation = BibliographicObservation(
            provider="crossref",
            provider_record_id=f"record-{suffix}",
            source_priority=0,
            observed_at=UtcTimestamp("2026-07-31T00:00:00Z"),
            identifiers=(Identifier(namespace="doi", value=f"10.1000/publisher-{suffix}"),),
            metadata=InitialMetadata(
                title=f"Atomic publication {suffix}",
                authors=("Ada",),
                year=2026,
                item_type="article",
            ),
            version_role="formal",
        )
        return prepare_initial_ingest(SqliteLiteratureRepository(path), (observation,))

    @staticmethod
    def artifact(kind: ArtifactKind, content: bytes) -> PublishedArtifact:
        digest = sha256_digest(content)
        directories = {
            ArtifactKind.PRIMARY_PDF: "raw",
            ArtifactKind.SUPPLEMENTARY: "raw",
            ArtifactKind.LIGHT_DOCUMENT: "light-document",
            ArtifactKind.ANALYSIS: "analysis",
        }
        path = RelativeArtifactPath(f"{directories[kind]}/{str(digest)[:2]}/{digest}")
        return PublishedArtifact(kind=kind, path=path, sha256=digest, size=len(content))

    @staticmethod
    def batch(path: Path, batch_id: BatchRunId, version_id, kind: str = "work-version") -> None:
        batch_type = "bibliography-import" if kind == "import-record" else "process"
        with create_or_open_catalog(path) as connection:
            connection.execute(
                "INSERT INTO batch_runs(id,batch_type,status,scope_json,counts_json) "
                "VALUES(?,?, 'running','{}','{}')",
                (str(batch_id), batch_type),
            )
            connection.execute(
                "INSERT INTO batch_targets(id,batch_run_id,target_kind,target_id,input_ordinal) "
                "VALUES(?,?,?,?,?)",
                (
                    str(uuid4()),
                    str(batch_id),
                    kind,
                    str(version_id),
                    0 if kind == "import-record" else None,
                ),
            )
            connection.commit()

    def collection(self, callback=None) -> Scenario:
        path, prepared = self.catalog(), None
        prepared = self.prepared(path)
        collection_id, run_id = CollectionId(str(uuid4())), CollectionRunId(str(uuid4()))
        with create_or_open_catalog(path) as connection:
            connection.execute(
                "INSERT INTO collections(id,name) VALUES(?,'target')", (str(collection_id),)
            )
            connection.execute(
                "INSERT INTO collection_runs(id,collection_id,mode,topic_conditions_json,"
                "requested_advance_to,status) VALUES(?,?,'topic','{}','completed','running')",
                (str(run_id), str(collection_id)),
            )
            connection.commit()
        command = CollectionAcceptance(
            bibliography=prepared,
            membership=CollectionMembershipFact(
                membership_id=MembershipId(str(uuid4())),
                collection_id=collection_id,
                work_id=prepared.work_id,
                first_run_id=run_id,
            ),
            causes=(),
            paths=(),
        )
        return Scenario(
            path,
            CollectionAcceptancePublisher(path, failpoint=callback),
            command,
            "collection_memberships",
        )

    def imported(self, callback=None) -> Scenario:
        path = self.catalog()
        prepared = self.prepared(path)
        batch_id = BatchRunId(str(uuid4()))
        self.batch(path, batch_id, prepared.work_version_id, "import-record")
        references = ReferenceSetFact(
            set_id=ReferenceSetId(str(uuid4())),
            work_version_id=prepared.work_version_id,
            revision=1,
            members=(),
        )
        tags = TagSetFact(
            set_id=TagSetId(str(uuid4())),
            work_version_id=prepared.work_version_id,
            revision=1,
            members=(),
        )
        record = ImportRecordProjection(
            batch_run_id=batch_id,
            work_version_id=prepared.work_version_id,
            input_ordinal=0,
            result=ImportResult(
                record_index=0,
                work_id=str(prepared.work_id),
                work_version_id=prepared.work_version_id,
                outcome="created",
                omissions=(),
                failure=None,
            ),
            details=CanonicalJsonObject((("reason", "accepted"),)),
        )
        return Scenario(
            path,
            ImportAcceptancePublisher(path, failpoint=callback),
            ImportAcceptanceCommand(
                bibliography=prepared,
                references=references,
                tags=tags,
                record=record,
            ),
            "reference_sets",
        )

    def primary(self, callback=None) -> Scenario:
        return target_publisher_content_scenarios.build_primary(self, callback)

    def light(self, callback=None) -> Scenario:
        return target_publisher_content_scenarios.build_light(self, callback)

    def completion(self, callback=None) -> Scenario:
        return target_publisher_content_scenarios.build_completion(self, callback)
