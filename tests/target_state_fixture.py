from __future__ import annotations

import sqlite3

from sciretriever.bibliography.api import (
    CompletionAnalysisFact,
    CompletionProvenance,
    CompletionSubmission,
    FinalMetadataFact,
    ReferenceSetFact,
    ReferenceSetId,
    TagSetFact,
    TagSetId,
    metadata_snapshot_sha256,
)
from sciretriever.bibliography.model import WorkFacts
from sciretriever.kernel import (
    CanonicalJsonObject,
    canonical_json_bytes,
)
from sciretriever.model.literature import VersionFacts
from sciretriever.model.primitives import (
    AnalysisArtifactId,
    AssetId,
    LightDocumentId,
    MetadataSnapshotId,
    RelativeArtifactPath,
    Sha256,
    WorkId,
    WorkVersionAssetId,
    WorkVersionId,
    sha256_digest,
)

WORK_ID = WorkId("10000000-0000-0000-0000-000000000001")
VERSION_ID = WorkVersionId("20000000-0000-0000-0000-000000000001")
PRIMARY_ID = WorkVersionAssetId("30000000-0000-0000-0000-000000000001")
LIGHT_ID = LightDocumentId("40000000-0000-0000-0000-000000000001")
ANALYSIS_ID = AnalysisArtifactId("50000000-0000-0000-0000-000000000001")
METADATA_ID = MetadataSnapshotId("60000000-0000-0000-0000-000000000001")
LIGHT_HASH = sha256_digest(b"{}")
METADATA_HASH = metadata_snapshot_sha256(1, CanonicalJsonObject(()), CanonicalJsonObject(()))


def facts() -> VersionFacts:
    return VersionFacts(
        work_id=WORK_ID,
        work_version_id=VERSION_ID,
        version_role="formal",
        metadata_snapshot_id=METADATA_ID,
        metadata_revision=1,
        metadata_sha256=METADATA_HASH,
        accepted_primary_id=PRIMARY_ID,
        current_light_document_id=LIGHT_ID,
        current_light_sha256=LIGHT_HASH,
        current_light_primary_id=PRIMARY_ID,
        current_light_complete=True,
        completion_light_document_id=LIGHT_ID,
        completion_analysis_artifact_id=ANALYSIS_ID,
        analysis_light_document_id=LIGHT_ID,
        analysis_input_sha256=LIGHT_HASH,
        analysis_nine_categories_complete=True,
        completion_metadata_snapshot_id=METADATA_ID,
        completion_reference_set_id="references",
        completion_reference_set_complete=True,
        completion_tag_set_id="tags",
        completion_tag_set_complete=True,
    )


def submission() -> CompletionSubmission:
    proposal = CanonicalJsonObject(
        (
            ("schema_version", "1"),
            ("final_bibliography", CanonicalJsonObject(())),
            ("classification", CanonicalJsonObject(())),
            ("content_overview", CanonicalJsonObject(())),
            ("research_objectives", ()),
            ("methods", ()),
            ("key_results", ()),
            ("conclusions_and_limitations", CanonicalJsonObject(())),
            ("keywords_and_tags", CanonicalJsonObject(())),
            ("references", ()),
        )
    )
    proposal_bytes = canonical_json_bytes(proposal)
    proposal_hash = sha256_digest(proposal_bytes)
    values = CanonicalJsonObject((("title", "final"),))
    provenance_value = CanonicalJsonObject(())
    return CompletionSubmission(
        VERSION_ID,
        LIGHT_ID,
        LIGHT_HASH,
        CompletionAnalysisFact(
            VERSION_ID,
            LIGHT_ID,
            LIGHT_HASH,
            ANALYSIS_ID,
            AssetId("50000000-0000-0000-0000-000000000002"),
            RelativeArtifactPath(f"analysis/{str(proposal_hash)[:2]}/{proposal_hash}"),
            proposal_hash,
            len(proposal_bytes),
            proposal,
        ),
        FinalMetadataFact(
            VERSION_ID,
            METADATA_ID,
            1,
            METADATA_HASH,
            MetadataSnapshotId("60000000-0000-0000-0000-000000000002"),
            2,
            metadata_snapshot_sha256(2, values, provenance_value),
            values,
            provenance_value,
        ),
        ReferenceSetFact(
            ReferenceSetId("70000000-0000-0000-0000-000000000001"),
            VERSION_ID,
            2,
            (),
        ),
        TagSetFact(
            TagSetId("80000000-0000-0000-0000-000000000001"),
            VERSION_ID,
            2,
            (),
        ),
        CompletionProvenance(
            "parser@1",
            "provider",
            "model@1",
            LIGHT_HASH,
            Sha256("4" * 64),
            provenance_value,
        ),
    )


def light_ready_facts() -> VersionFacts:
    return facts().model_copy(
        update={
            "completion_light_document_id": None,
            "completion_analysis_artifact_id": None,
            "analysis_light_document_id": None,
            "analysis_input_sha256": None,
            "analysis_nine_categories_complete": False,
            "completion_metadata_snapshot_id": None,
            "completion_reference_set_id": None,
            "completion_reference_set_complete": False,
            "completion_tag_set_id": None,
            "completion_tag_set_complete": False,
        }
    )


class FakeRepository:
    def __init__(self, current: VersionFacts) -> None:
        self.current = current

    def get_version_facts(self, version_id: WorkVersionId) -> VersionFacts | None:
        return self.current if version_id == self.current.work_version_id else None

    def get_work_facts(self, work_id: WorkId) -> WorkFacts | None:
        if work_id != self.current.work_id:
            return None
        return WorkFacts(work_id, self.current.work_version_id, (self.current.work_version_id,))


class RecordingPublisher:
    def __init__(self) -> None:
        self.calls: list[tuple[CompletionSubmission, str]] = []

    def publish_completion(
        self, validated_submission: CompletionSubmission, target_projection: str
    ) -> str:
        self.calls.append((validated_submission, target_projection))
        return "published"


def insert_completed(connection: sqlite3.Connection) -> None:
    connection.execute("INSERT INTO works(id) VALUES (?)", (str(WORK_ID),))
    connection.execute(
        "INSERT INTO work_versions(id,work_id,version_role) VALUES (?,?, 'formal')",
        (str(VERSION_ID), str(WORK_ID)),
    )
    connection.execute(
        "INSERT INTO metadata_snapshots VALUES (?,?,1,?,'{}','{}')",
        (str(METADATA_ID), str(VERSION_ID), str(METADATA_HASH)),
    )
    connection.execute(
        "INSERT INTO work_version_current_metadata VALUES (?,?)",
        (str(VERSION_ID), str(METADATA_ID)),
    )
    connection.execute(
        "INSERT INTO artifacts VALUES ('raw','raw',?,'raw/value',1,NULL)", ("0" * 64,)
    )
    connection.execute("INSERT INTO raw_assets VALUES ('raw','primary-pdf','{}')")
    connection.execute(
        "INSERT INTO work_version_assets VALUES (?,?, 'raw','primary-pdf')",
        (str(PRIMARY_ID), str(VERSION_ID)),
    )
    connection.execute(
        "INSERT INTO accepted_primary_assets VALUES (?,?)", (str(VERSION_ID), str(PRIMARY_ID))
    )
    connection.execute(
        "INSERT INTO artifacts VALUES ('light-artifact','light-document',?,'light/value',2,NULL)",
        (str(LIGHT_HASH),),
    )
    connection.execute(
        "INSERT INTO light_documents VALUES (?,?,?,?,?,'{}','{}',1)",
        (str(LIGHT_ID), str(VERSION_ID), str(PRIMARY_ID), "light-artifact", str(LIGHT_HASH)),
    )
    connection.execute(
        "INSERT INTO work_version_current_light_document VALUES (?,?)",
        (str(VERSION_ID), str(LIGHT_ID)),
    )
    analysis_hash = sha256_digest(b"{}")
    connection.execute(
        "INSERT INTO artifacts VALUES ('analysis-file','analysis',?,'analysis/value',2,NULL)",
        (str(analysis_hash),),
    )
    connection.execute(
        "INSERT INTO analysis_artifacts VALUES (?,?,?,?,?,?, '{}','{}',1)",
        (
            str(ANALYSIS_ID),
            str(VERSION_ID),
            str(LIGHT_ID),
            "analysis-file",
            str(analysis_hash),
            str(LIGHT_HASH),
        ),
    )
    connection.execute("INSERT INTO reference_sets VALUES ('references',?,1,1)", (str(VERSION_ID),))
    connection.execute("INSERT INTO tag_sets VALUES ('tags',?,1,1)", (str(VERSION_ID),))
    connection.execute(
        "INSERT INTO completion_bundles(work_version_id,light_document_id,"
        "analysis_artifact_id,metadata_snapshot_id,reference_set_id,tag_set_id,identity_sha256) "
        "VALUES (?,?,?,?, 'references','tags',?)",
        (str(VERSION_ID), str(LIGHT_ID), str(ANALYSIS_ID), str(METADATA_ID), "a" * 64),
    )
    connection.commit()
