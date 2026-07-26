from __future__ import annotations

from dataclasses import dataclass
from typing import Literal
from uuid import uuid4

from sqlalchemy.engine import Connection

from sciretriever.catalog.curation_contracts import CurationCapture, CurationStep
from sciretriever.catalog.curation_records import footprint_sha256
from sciretriever.catalog.engine import CatalogEngine
from sciretriever.catalog.work_curation import WorkCurationConflictError
from sciretriever.core.curation import CurationAction, CurationSubjectKind, ReviewDecision
from sciretriever.core.ids import validate_uuid
from sciretriever.core.snapshots import SafeSnapshot


ReviewState = Literal["pending", "resolved"]


@dataclass(frozen=True, slots=True)
class ReviewQuery:
    state: ReviewState = "pending"
    limit: int = 100

    def __post_init__(self) -> None:
        if self.state not in ("pending", "resolved") or not 1 <= self.limit <= 1000:
            raise WorkCurationConflictError("review_query")


@dataclass(frozen=True, slots=True)
class ReviewItem:
    id: str
    kind: str
    state: ReviewState
    reason: str
    decision: str | None


class ReviewRepository:
    def __init__(self, catalog: CatalogEngine) -> None:
        self._catalog = catalog

    def query(self, query: ReviewQuery) -> tuple[ReviewItem, ...]:
        with self._catalog.connect() as connection:
            rows = connection.exec_driver_sql(
                "SELECT id,state,reason,decision FROM identity_reviews WHERE state=? "
                "ORDER BY created_at,id LIMIT ?", (query.state, query.limit),
            ).all()
            items = [ReviewItem(str(row[0]), "identifier", row[1], str(row[2]), row[3]) for row in rows]
            if query.state == "pending" and len(items) < query.limit:
                work_rows = connection.exec_driver_sql(
                    "SELECT id,review_reason FROM works WHERE needs_review=1 ORDER BY created_at,id LIMIT ?",
                    (query.limit - len(items),),
                ).all()
                items.extend(ReviewItem(str(row[0]), "work", "pending", str(row[1]), None) for row in work_rows)
        return tuple(items)


@dataclass(frozen=True, slots=True)
class ReviewResolutionHandler:
    catalog: CatalogEngine
    review_id: str
    decision: ReviewDecision
    operation_id: str
    expected_before_sha256: str
    before_state: str
    before_decision: str | None
    before_updated_at: str
    before_resolved_at: str | None

    action = CurationAction.RESOLVE_REVIEW
    subject_kind = CurationSubjectKind.REVIEW

    @property
    def subject_id(self) -> str:
        return self.review_id

    @classmethod
    def load(cls, catalog: CatalogEngine, review_id: str, decision: ReviewDecision) -> ReviewResolutionHandler:
        review = validate_uuid(review_id, "review_id")
        if decision is ReviewDecision.NOT_REQUIRED:
            raise WorkCurationConflictError("review_decision")
        with catalog.connect() as connection:
            row = connection.exec_driver_sql(
                "SELECT state,decision,updated_at,resolved_at FROM identity_reviews WHERE id=?", (review,)
            ).one_or_none()
        if row is None:
            raise WorkCurationConflictError("unknown_review")
        if row[0] != "pending":
            raise WorkCurationConflictError("resolved_review")
        footprint = repr(tuple(row)).encode("ascii")
        return cls(
            catalog, review, decision, str(uuid4()), footprint_sha256(footprint),
            str(row[0]), row[1], str(row[2]), row[3],
        )

    def capture(self, connection: Connection) -> CurationCapture:
        row = connection.exec_driver_sql("SELECT state,decision,updated_at,resolved_at FROM identity_reviews WHERE id=?", (self.review_id,)).one()
        footprint = repr(tuple(row)).encode("ascii")
        return CurationCapture(SafeSnapshot.from_pairs((("decision", row[1] or "pending"), ("review_id", self.review_id), ("value", str(row[0])))), footprint)

    def steps(self) -> tuple[CurationStep, ...]:
        return (CurationStep("identity_reviews", self._apply, self._undo),)

    def _apply(self, connection: Connection) -> None:
        connection.exec_driver_sql(
            "UPDATE identity_reviews SET state='resolved',decision=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
            (self.decision.value, self.review_id),
        )

    def _undo(self, connection: Connection) -> None:
        connection.exec_driver_sql(
            "UPDATE identity_reviews SET state=?,decision=?,updated_at=?,resolved_at=? WHERE id=?",
            (self.before_state, self.before_decision, self.before_updated_at, self.before_resolved_at, self.review_id),
        )


__all__ = ("ReviewItem", "ReviewQuery", "ReviewRepository", "ReviewResolutionHandler")
