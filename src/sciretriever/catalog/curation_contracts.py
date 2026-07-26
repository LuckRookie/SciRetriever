from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Final, Protocol, runtime_checkable

from sqlalchemy.engine import Connection

from sciretriever.core.curation import CurationAction, CurationSubjectKind, ReviewDecision
from sciretriever.core.ids import validate_uuid
from sciretriever.core.snapshots import SafeSnapshot


MAX_FOOTPRINT_BYTES: Final = 65_536
CurationMutation = Callable[[Connection], None]
CurationFailpoint = Callable[[str], None]


@dataclass(frozen=True, slots=True)
class CurationCapture:
    snapshot: SafeSnapshot
    footprint: bytes

    def __post_init__(self) -> None:
        if not isinstance(self.snapshot, SafeSnapshot):
            raise CurationBoundaryError("capture_snapshot")
        if not isinstance(self.footprint, bytes) or not 0 < len(self.footprint) <= MAX_FOOTPRINT_BYTES:
            raise CurationBoundaryError("capture_footprint")


@dataclass(frozen=True, slots=True)
class CurationStep:
    family: str
    apply: CurationMutation
    compensate: CurationMutation

    def __post_init__(self) -> None:
        if not self.family.isidentifier() or len(self.family) > 64:
            raise CurationBoundaryError("step_family")


class CurationHandler(Protocol):
    @property
    def operation_id(self) -> str | None: ...

    @property
    def expected_before_sha256(self) -> str | None: ...

    @property
    def action(self) -> CurationAction: ...

    @property
    def subject_kind(self) -> CurationSubjectKind: ...

    @property
    def subject_id(self) -> str: ...

    def capture(self, connection: Connection) -> CurationCapture: ...

    def steps(self) -> tuple[CurationStep, ...]: ...


@runtime_checkable
class EvidenceBoundCurationHandler(Protocol):
    @property
    def evidence(self) -> SafeSnapshot: ...


@dataclass(frozen=True, slots=True)
class CurationRequest:
    handler: CurationHandler
    review_decision: ReviewDecision
    evidence: SafeSnapshot
    operation_id: str | None = None

    @property
    def expected_before_sha256(self) -> str | None:
        return self.handler.expected_before_sha256

    def __post_init__(self) -> None:
        if not isinstance(self.review_decision, ReviewDecision):
            raise CurationBoundaryError("review_decision")
        if not isinstance(self.evidence, SafeSnapshot):
            raise CurationBoundaryError("evidence")
        if self.operation_id is not None:
            validate_uuid(self.operation_id, "operation_id")
        expected_operation_id = self.handler.operation_id
        if expected_operation_id is not None and self.operation_id != expected_operation_id:
            raise CurationBoundaryError("operation_id_mismatch")
        if isinstance(self.handler, EvidenceBoundCurationHandler) and self.evidence != self.handler.evidence:
            raise CurationBoundaryError("evidence_mismatch")


class CurationBoundaryError(ValueError):
    __slots__ = ("code",)

    def __init__(self, code: str) -> None:
        self.code = code

    def __str__(self) -> str:
        return f"invalid curation request: {self.code}"


class CurationStaleError(Exception):
    __slots__ = ("operation_id",)

    def __init__(self, operation_id: str) -> None:
        self.operation_id = operation_id

    def __str__(self) -> str:
        return f"curation operation {self.operation_id} is stale"


class CurationAlreadyUndoneError(Exception):
    __slots__ = ("operation_id",)

    def __init__(self, operation_id: str) -> None:
        self.operation_id = operation_id

    def __str__(self) -> str:
        return f"curation operation {self.operation_id} is already undone"


class CurationBusyError(Exception):
    __slots__ = ()

    def __str__(self) -> str:
        return "catalog is busy"


class CurationAuditCorruptError(Exception):
    __slots__ = ("operation_id",)

    def __init__(self, operation_id: str) -> None:
        self.operation_id = operation_id

    def __str__(self) -> str:
        return f"curation audit {self.operation_id} is corrupt"


class CurationCompensationError(Exception):
    __slots__ = ("operation_id",)

    def __init__(self, operation_id: str) -> None:
        self.operation_id = operation_id

    def __str__(self) -> str:
        return f"curation compensation {self.operation_id} did not restore its before state"


class CurationNoChangeError(Exception):
    __slots__ = ("subject_id",)

    def __init__(self, subject_id: str) -> None:
        self.subject_id = subject_id

    def __str__(self) -> str:
        return f"curation subject {self.subject_id} has no complete-footprint change"


__all__ = (
    "CurationAlreadyUndoneError", "CurationAuditCorruptError", "CurationBoundaryError",
    "CurationBusyError", "CurationCapture", "CurationCompensationError", "CurationFailpoint", "CurationHandler",
    "CurationMutation", "CurationNoChangeError", "CurationRequest", "CurationStaleError", "CurationStep",
)
