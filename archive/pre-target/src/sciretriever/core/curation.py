from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import hashlib
import re
from typing import Final, NewType, NoReturn

from sciretriever.core.snapshots import SafeSnapshot, SnapshotBoundaryError, canonical_json_bytes, strict_json_object


_PUBLIC_ID: Final = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_SHA256: Final = re.compile(r"^[0-9a-f]{64}$")
CurationOperationId = NewType("CurationOperationId", str)


def assert_never(value: NoReturn) -> NoReturn:
    raise AssertionError(f"unhandled value: {value!r}")


def _string(value: str | int | bool | None | dict[str, str | int | bool | None]) -> str:
    match value:
        case str():
            return value
        case int() | bool() | None | dict():
            raise SnapshotBoundaryError("operation_types")
        case unreachable:
            assert_never(unreachable)


class CurationAction(str, Enum):
    RESOLVE_REVIEW = "resolve_review"
    MERGE_WORK = "merge_work"
    REGROUP_WORK_VERSION = "regroup_work_version"
    SET_PREFERRED = "set_preferred"
    CLEAR_PREFERRED = "clear_preferred"
    SET_METADATA = "set_metadata"
    CLEAR_METADATA = "clear_metadata"
    ADD_TAG = "add_tag"
    REMOVE_TAG = "remove_tag"
    MERGE_AUTHOR = "merge_author"
    UNDO = "undo"


class CurationSubjectKind(str, Enum):
    REVIEW = "review"
    WORK = "work"
    WORK_VERSION = "work_version"
    AUTHOR = "author"
    OPERATION = "operation"


class CurationResult(str, Enum):
    APPLIED = "applied"
    UNDONE = "undone"


class ReviewDecision(str, Enum):
    CONFIRMED = "confirmed"
    REJECTED = "rejected"
    DEFERRED = "deferred"
    NOT_REQUIRED = "not_required"


def _compatible_subject(action: CurationAction) -> CurationSubjectKind:
    match action:
        case CurationAction.RESOLVE_REVIEW:
            return CurationSubjectKind.REVIEW
        case CurationAction.MERGE_WORK | CurationAction.SET_PREFERRED | CurationAction.CLEAR_PREFERRED | CurationAction.ADD_TAG | CurationAction.REMOVE_TAG:
            return CurationSubjectKind.WORK
        case CurationAction.REGROUP_WORK_VERSION | CurationAction.SET_METADATA | CurationAction.CLEAR_METADATA:
            return CurationSubjectKind.WORK_VERSION
        case CurationAction.MERGE_AUTHOR:
            return CurationSubjectKind.AUTHOR
        case CurationAction.UNDO:
            return CurationSubjectKind.OPERATION
        case unreachable:
            assert_never(unreachable)


@dataclass(frozen=True, slots=True)
class CurationOperation:
    action: CurationAction
    subject_kind: CurationSubjectKind
    subject_id: str
    before: SafeSnapshot
    after: SafeSnapshot
    review_decision: ReviewDecision
    result: CurationResult
    undo_of: CurationOperationId | None
    operation_sha256: str

    def __post_init__(self) -> None:
        if not isinstance(self.action, CurationAction) or not isinstance(self.subject_kind, CurationSubjectKind):
            raise SnapshotBoundaryError("operation_enum")
        if not isinstance(self.review_decision, ReviewDecision) or not isinstance(self.result, CurationResult):
            raise SnapshotBoundaryError("operation_enum")
        if not isinstance(self.before, SafeSnapshot) or not isinstance(self.after, SafeSnapshot):
            raise SnapshotBoundaryError("operation_snapshot")
        if self.subject_kind is not _compatible_subject(self.action):
            raise SnapshotBoundaryError("action_subject")
        if not isinstance(self.subject_id, str) or not _PUBLIC_ID.fullmatch(self.subject_id):
            raise SnapshotBoundaryError("subject_id")
        match self.action:
            case CurationAction.UNDO:
                if self.undo_of is None or self.subject_id != self.undo_of:
                    raise SnapshotBoundaryError("undo_target")
            case CurationAction.RESOLVE_REVIEW | CurationAction.MERGE_WORK | CurationAction.REGROUP_WORK_VERSION | CurationAction.SET_PREFERRED | CurationAction.CLEAR_PREFERRED | CurationAction.SET_METADATA | CurationAction.CLEAR_METADATA | CurationAction.ADD_TAG | CurationAction.REMOVE_TAG | CurationAction.MERGE_AUTHOR:
                if self.undo_of is not None:
                    raise SnapshotBoundaryError("undo_forbidden")
            case unreachable:
                assert_never(unreachable)
        if not isinstance(self.operation_sha256, str) or not _SHA256.fullmatch(self.operation_sha256):
            raise SnapshotBoundaryError("operation_hash")
        if self.operation_sha256 != self._expected_hash():
            raise SnapshotBoundaryError("operation_hash_mismatch")

    @classmethod
    def create(
        cls,
        *,
        action: CurationAction,
        subject_kind: CurationSubjectKind,
        subject_id: str,
        before: SafeSnapshot,
        after: SafeSnapshot,
        review_decision: ReviewDecision,
        result: CurationResult = CurationResult.APPLIED,
        undo_of: CurationOperationId | None = None,
    ) -> CurationOperation:
        identity = cls._identity(action, subject_kind, subject_id, before, after, review_decision, result, undo_of)
        digest = hashlib.sha256(canonical_json_bytes(identity)).hexdigest()
        return cls(action, subject_kind, subject_id, before, after, review_decision, result, undo_of, digest)

    @staticmethod
    def _identity(
        action: CurationAction,
        subject_kind: CurationSubjectKind,
        subject_id: str,
        before: SafeSnapshot,
        after: SafeSnapshot,
        review_decision: ReviewDecision,
        result: CurationResult,
        undo_of: CurationOperationId | None,
    ) -> dict[str, dict[str, str | int | bool | None] | str | int | bool | None]:
        return {
            "action": action.value, "after": after.to_dict(), "before": before.to_dict(),
            "result": result.value, "review_decision": review_decision.value,
            "subject_id": subject_id, "subject_kind": subject_kind.value, "undo_of": undo_of,
        }

    def _expected_hash(self) -> str:
        return hashlib.sha256(canonical_json_bytes(self._identity(
            self.action, self.subject_kind, self.subject_id, self.before, self.after,
            self.review_decision, self.result, self.undo_of,
        ))).hexdigest()

    def to_json_bytes(self) -> bytes:
        value = self._identity(
            self.action, self.subject_kind, self.subject_id, self.before, self.after,
            self.review_decision, self.result, self.undo_of,
        )
        value["operation_sha256"] = self.operation_sha256
        return canonical_json_bytes(value)

    @classmethod
    def from_json_bytes(cls, payload: bytes) -> CurationOperation:
        value = strict_json_object(payload)
        required = {
            "action", "after", "before", "operation_sha256", "result", "review_decision",
            "subject_id", "subject_kind", "undo_of",
        }
        if set(value) != required or not isinstance(value["before"], dict) or not isinstance(value["after"], dict):
            raise SnapshotBoundaryError("operation_fields")
        action = _string(value["action"])
        operation_sha256 = _string(value["operation_sha256"])
        result = _string(value["result"])
        review_decision = _string(value["review_decision"])
        subject_id = _string(value["subject_id"])
        subject_kind = _string(value["subject_kind"])
        undo_value = value["undo_of"]
        if undo_value is not None and not isinstance(undo_value, str):
            raise SnapshotBoundaryError("operation_types")
        undo_of = None if undo_value is None else CurationOperationId(undo_value)
        try:
            return cls(
                action=CurationAction(action), subject_kind=CurationSubjectKind(subject_kind),
                subject_id=subject_id, before=SafeSnapshot.from_dict(value["before"]),
                after=SafeSnapshot.from_dict(value["after"]), review_decision=ReviewDecision(review_decision),
                result=CurationResult(result), undo_of=undo_of, operation_sha256=operation_sha256,
            )
        except (TypeError, ValueError):
            raise SnapshotBoundaryError("operation_value") from None


__all__ = (
    "CurationAction", "CurationOperation", "CurationOperationId", "CurationResult",
    "CurationSubjectKind", "ReviewDecision",
)
