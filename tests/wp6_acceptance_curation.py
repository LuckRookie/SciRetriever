from __future__ import annotations

import json

from sciretriever.catalog import CurationOperationOwner, TagRepository
from sciretriever.catalog.author_curation import AuthorMergeHandler
from sciretriever.catalog.curation import CurationRequest, CurationStaleError
from sciretriever.catalog.manual_metadata_curation import (
    ManualMetadataClearHandler, ManualMetadataSetHandler,
)
from sciretriever.catalog.manual_tag_curation import (
    ManualTagAddHandler, ManualTagRemoveHandler,
)
from sciretriever.catalog.preferred_curation import (
    PreferredClearHandler, PreferredSetHandler,
)
from sciretriever.catalog.review_curation import ReviewResolutionHandler
from sciretriever.catalog.work_curation import (
    WorkMergeHandler, WorkVersionRegroupHandler,
)
from sciretriever.core.curation import ReviewDecision
from sciretriever.core.ids import new_uuid4
from sciretriever.core.snapshots import SafeSnapshot

from wp6_acceptance_runtime import AcceptanceRuntime


def _request(handler, confirmed: bool = False) -> CurationRequest:
    decision = ReviewDecision.CONFIRMED if confirmed else ReviewDecision.NOT_REQUIRED
    evidence = (
        SafeSnapshot.from_pairs((("decision", "user_confirmed"),))
        if confirmed else SafeSnapshot(())
    )
    return CurationRequest(handler, decision, evidence, operation_id=handler.operation_id)


def exercise_curation(runtime: AcceptanceRuntime, work_id: str, version_id: str) -> tuple[str, str]:
    catalog = runtime.catalog
    owner = CurationOperationOwner(catalog)
    works = runtime.repository
    source = works.ingest_version(provider="fixture", provider_record_id="merge-source", title="Merge Source")
    target = works.ingest_version(provider="fixture", provider_record_id="merge-target", title="Merge Target")
    merge = WorkMergeHandler.load(catalog, source.work_id, target.work_id)
    owner.apply(_request(merge, True))
    owner.undo(merge.operation_id, merge)

    regroup_source = works.ingest_version(provider="fixture", provider_record_id="regroup-source", title="Regroup Source")
    regroup_target = works.ingest_version(provider="fixture", provider_record_id="regroup-target", title="Regroup Target")
    regroup = WorkVersionRegroupHandler.load(catalog, regroup_source.id, regroup_target.work_id)
    owner.apply(_request(regroup, True))
    owner.undo(regroup.operation_id, regroup)

    review_id = new_uuid4()
    with catalog.transaction() as connection:
        candidates = json.dumps(sorted((source.work_id, target.work_id)), separators=(",", ":"))
        connection.exec_driver_sql(
            "INSERT INTO identity_reviews (id,identifiers_json,candidate_work_ids_json,reason) "
            "VALUES (?,'[]',?,'identifier_conflict')", (review_id, candidates),
        )
    review = ReviewResolutionHandler.load(catalog, review_id, ReviewDecision.CONFIRMED)
    owner.apply(_request(review, True))

    alternate = works.ingest_version(
        provider="fixture", provider_record_id="alternate", title="Alternate",
        related_work_version_id=version_id, relation_evidence={"provider": "fixture"},
    )
    preferred = PreferredSetHandler.load(catalog, work_id, alternate.id)
    owner.apply(_request(preferred))
    clear_preferred = PreferredClearHandler.load(catalog, work_id)
    owner.apply(_request(clear_preferred))

    metadata = ManualMetadataSetHandler.load(catalog, version_id, "language", "fr")
    owner.apply(_request(metadata))
    cleared = ManualMetadataClearHandler.load(catalog, version_id, "language")
    owner.apply(_request(cleared))
    manual = ManualMetadataSetHandler.load(catalog, version_id, "language", "fr")
    owner.apply(_request(manual))

    tag = TagRepository(catalog).add("manual-wp6")
    added = ManualTagAddHandler.load(catalog, work_id, tag.id)
    owner.apply(_request(added))
    removed = ManualTagRemoveHandler.load(catalog, work_id, tag.id)
    owner.apply(_request(removed))
    owner.apply(_request(ManualTagAddHandler.load(catalog, work_id, tag.id)))

    first, second = new_uuid4(), new_uuid4()
    with catalog.transaction() as connection:
        connection.exec_driver_sql(
            "INSERT INTO authors (id,display_name,normalized_name,orcid) VALUES "
            "(?,'First','first','0000-0002-1825-0097'),(?,'Second','second',NULL)",
            (first, second),
        )
        connection.exec_driver_sql(
            "INSERT INTO authorships (id,work_version_id,author_id,position) VALUES (?,?,?,0)",
            (new_uuid4(), version_id, first),
        )
    author = AuthorMergeHandler.load(catalog, first, second, SafeSnapshot(()))
    owner.apply(CurationRequest(
        author, ReviewDecision.CONFIRMED, author.evidence, author.operation_id,
    ))

    stale = ManualMetadataSetHandler.load(catalog, alternate.id, "language", "de")
    stale_record = owner.apply(_request(stale))
    with catalog.transaction() as connection:
        connection.exec_driver_sql(
            "UPDATE work_versions SET language='it' WHERE id=?", (alternate.id,),
        )
    stale_rejected = False
    try:
        owner.undo(stale_record.id, stale)
    except CurationStaleError:
        stale_rejected = True
    if not stale_rejected:
        raise AssertionError("stale undo unexpectedly mutated catalog")
    return tag.id, alternate.id


__all__ = ("exercise_curation",)
