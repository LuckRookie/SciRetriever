from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import re
from typing import Final

from sciretriever.core.snapshots import SnapshotBoundaryError, canonical_json_bytes, strict_json_object


_UUID: Final = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
_INPUT_FINGERPRINT: Final = re.compile(r"^sha256:[0-9a-f]{64}$")


def _string(value: str | int | bool | None | dict[str, str | int | bool | None]) -> str:
    match value:
        case str():
            return value
        case _:
            raise ProductFailureBoundaryError("types")


class ProductFailureStage(str, Enum):
    METADATA = "metadata"
    ACQUISITION = "acquisition"
    ANALYSIS = "analysis"
    EXPANSION = "expansion"


class ProductFailureReason(str, Enum):
    CONFIGURATION = "configuration"
    PROVIDER = "provider"
    IDENTITY = "identity"
    CONTENT = "content"
    STORAGE = "storage"
    CATALOG = "catalog"
    INTERRUPTED = "interrupted"


class ProductFailureAction(str, Enum):
    CHECK_CONFIGURATION = "check_configuration"
    CHECK_CREDENTIALS = "check_credentials"
    RETRY = "retry"
    TRY_ANOTHER_SOURCE = "try_another_source"
    REVIEW = "review"
    REPAIR_STORAGE = "repair_storage"
    NONE = "none"


class DiagnosticSubjectKind(str, Enum):
    INPUT = "input"
    WORK = "work"
    WORK_VERSION = "work_version"
    PROCESSING_RUN = "processing_run"
    EXPANSION = "expansion"


class RerunGuidance(str, Enum):
    RETRY = "retry"
    AFTER_CONFIGURATION_CHANGE = "after_configuration_change"
    AFTER_CREDENTIAL_CHANGE = "after_credential_change"
    AFTER_SOURCE_CHANGE = "after_source_change"
    AFTER_REVIEW = "after_review"
    NOT_APPLICABLE = "not_applicable"


@dataclass(frozen=True, slots=True)
class ProductFailureBoundaryError(ValueError):
    code: str

    def __str__(self) -> str:
        return f"invalid product failure: {self.code}"


@dataclass(frozen=True, slots=True)
class ProductFailure:
    stage: ProductFailureStage
    subject_kind: DiagnosticSubjectKind
    subject_id: str
    reason: ProductFailureReason
    action: ProductFailureAction
    rerun: RerunGuidance

    def __post_init__(self) -> None:
        if not isinstance(self.stage, ProductFailureStage) or not isinstance(self.subject_kind, DiagnosticSubjectKind):
            raise ProductFailureBoundaryError("enum")
        if not isinstance(self.reason, ProductFailureReason) or not isinstance(self.action, ProductFailureAction):
            raise ProductFailureBoundaryError("enum")
        if not isinstance(self.rerun, RerunGuidance):
            raise ProductFailureBoundaryError("enum")
        if not isinstance(self.subject_id, str):
            raise ProductFailureBoundaryError("subject_id")
        match self.subject_kind:
            case DiagnosticSubjectKind.INPUT:
                valid = _INPUT_FINGERPRINT.fullmatch(self.subject_id) is not None
            case DiagnosticSubjectKind.WORK | DiagnosticSubjectKind.WORK_VERSION | DiagnosticSubjectKind.PROCESSING_RUN | DiagnosticSubjectKind.EXPANSION:
                valid = _UUID.fullmatch(self.subject_id) is not None
        if not valid:
            raise ProductFailureBoundaryError("subject_id")

    def to_json_bytes(self) -> bytes:
        return canonical_json_bytes({
            "action": self.action.value, "reason": self.reason.value, "rerun": self.rerun.value,
            "stage": self.stage.value, "subject_id": self.subject_id, "subject_kind": self.subject_kind.value,
        })

    @classmethod
    def from_json_bytes(cls, payload: bytes) -> ProductFailure:
        try:
            value = strict_json_object(payload)
            if set(value) != {"action", "reason", "rerun", "stage", "subject_id", "subject_kind"}:
                raise ProductFailureBoundaryError("fields")
            action = _string(value["action"])
            reason = _string(value["reason"])
            rerun = _string(value["rerun"])
            stage = _string(value["stage"])
            subject_id = _string(value["subject_id"])
            subject_kind = _string(value["subject_kind"])
            return cls(
                stage=ProductFailureStage(stage), subject_kind=DiagnosticSubjectKind(subject_kind),
                subject_id=subject_id, reason=ProductFailureReason(reason),
                action=ProductFailureAction(action), rerun=RerunGuidance(rerun),
            )
        except (SnapshotBoundaryError, TypeError, ValueError):
            raise ProductFailureBoundaryError("payload") from None


__all__ = (
    "DiagnosticSubjectKind", "ProductFailure", "ProductFailureAction", "ProductFailureBoundaryError",
    "ProductFailureReason", "ProductFailureStage", "RerunGuidance",
)
