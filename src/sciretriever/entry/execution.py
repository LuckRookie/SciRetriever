"""Process-local selector freezing and database-write start ordering."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TypeAlias, TypeVar, cast

from sciretriever.entry.ports import (
    DiscoveryRunRecoveryPort,
    ExecutionCurrentFacts,
    LiteratureSelectorSnapshot,
    MetaSelectorSnapshot,
    SelectorSnapshot,
    WriteAdmissionPort,
)
from sciretriever.literature.api import derive_status
from sciretriever.model.execution import (
    AllPendingSelector,
    BatchGoal,
    BatchRequest,
    DiscoveryRunSelector,
    ImportReportSelector,
    LiteratureSelector,
    MetaLiteratureSelector,
    QuerySelector,
)
from sciretriever.model.literature import LiteratureStatus, MetaLiterature, VersionRole
from sciretriever.model.primitives import DiscoveryRunId, LiteratureId, MetaLiteratureId
from sciretriever.model.report import (
    LiteratureCompletionTarget,
    MetaLiteratureCompletionTarget,
)

_PreparedT = TypeVar("_PreparedT")
_ResultT = TypeVar("_ResultT")

_VERSION_RANK = {
    VersionRole.PUBLISHED: 0,
    VersionRole.ACCEPTED_MANUSCRIPT: 1,
    VersionRole.PREPRINT: 2,
    VersionRole.OTHER: 3,
}


class ExecutionSnapshotError(RuntimeError):
    """A selector/current-facts snapshot cannot be consumed safely."""

    _MESSAGE = "entry execution snapshot is inconsistent"

    def __init__(self) -> None:
        super().__init__(self._MESSAGE)


@dataclass(frozen=True, slots=True)
class FrozenLiteratureCandidate:
    """One immutable candidate derived from a single consistent snapshot."""

    current: ExecutionCurrentFacts
    status: LiteratureStatus
    has_aligned_parser_result: bool
    has_current_primary_pdf: bool

    @property
    def literature_id(self) -> LiteratureId:
        return self.current.current.literature.literature_id


@dataclass(frozen=True, slots=True)
class TransientMetaExecution:
    """One process-local MetaLiterature target with ordered version candidates."""

    target: MetaLiteratureCompletionTarget
    candidates: tuple[FrozenLiteratureCandidate, ...]

    def __post_init__(self) -> None:
        if not self.candidates:
            raise ValueError("a transient MetaLiterature execution requires candidates")


@dataclass(frozen=True, slots=True)
class TransientLiteratureExecution:
    """One process-local explicit target containing exactly one concrete version."""

    target: LiteratureCompletionTarget
    candidate: FrozenLiteratureCandidate


TransientExecution: TypeAlias = TransientMetaExecution | TransientLiteratureExecution


def candidate_order_key(
    *,
    status: LiteratureStatus,
    has_aligned_parser_result: bool,
    has_current_primary_pdf: bool,
    version_role: VersionRole,
    literature_id: LiteratureId,
) -> tuple[int, int, str]:
    """Return the Accepted deterministic candidate priority."""

    _validate_candidate_order_inputs(
        status=status,
        has_aligned_parser_result=has_aligned_parser_result,
        has_current_primary_pdf=has_current_primary_pdf,
        version_role=version_role,
        literature_id=literature_id,
    )
    completion_rank = _completion_rank(
        status,
        has_aligned_parser_result=has_aligned_parser_result,
        has_current_primary_pdf=has_current_primary_pdf,
    )
    return (completion_rank, _VERSION_RANK[version_role], literature_id.root)


def _validate_candidate_order_inputs(
    *,
    status: object,
    has_aligned_parser_result: object,
    has_current_primary_pdf: object,
    version_role: object,
    literature_id: object,
) -> None:
    if not isinstance(status, LiteratureStatus):
        raise TypeError("status must be LiteratureStatus")
    if type(has_aligned_parser_result) is not bool:
        raise TypeError("has_aligned_parser_result must be bool")
    if type(has_current_primary_pdf) is not bool:
        raise TypeError("has_current_primary_pdf must be bool")
    if not isinstance(version_role, VersionRole):
        raise TypeError("version_role must be VersionRole")
    if not isinstance(literature_id, LiteratureId):
        raise TypeError("literature_id must be LiteratureId")
    if has_aligned_parser_result and not has_current_primary_pdf:
        raise ValueError("an aligned parser result requires a current primary PDF")
    if status is LiteratureStatus.UNREVIEWED and has_current_primary_pdf:
        raise ValueError("an unreviewed candidate cannot have a current primary PDF")
    if status in {LiteratureStatus.ASSET_READY, LiteratureStatus.CONTENT_READY} and not (
        has_current_primary_pdf
    ):
        raise ValueError("a ready candidate requires a current primary PDF")


def _completion_rank(
    status: LiteratureStatus,
    *,
    has_aligned_parser_result: bool,
    has_current_primary_pdf: bool,
) -> int:
    if status is LiteratureStatus.CONTENT_READY:
        return 0
    if has_aligned_parser_result:
        return 1
    if has_current_primary_pdf:
        return 2
    return 3


def order_execution_candidates(
    candidates: tuple[FrozenLiteratureCandidate, ...],
) -> tuple[FrozenLiteratureCandidate, ...]:
    """Freeze candidates in completion, version-role, and identity order."""

    if not isinstance(candidates, tuple) or any(
        not isinstance(candidate, FrozenLiteratureCandidate) for candidate in candidates
    ):
        raise TypeError("candidates must be a tuple of FrozenLiteratureCandidate values")
    return tuple(
        sorted(
            candidates,
            key=lambda candidate: candidate_order_key(
                status=candidate.status,
                has_aligned_parser_result=candidate.has_aligned_parser_result,
                has_current_primary_pdf=candidate.has_current_primary_pdf,
                version_role=candidate.current.current.literature.version_role,
                literature_id=candidate.literature_id,
            ),
        )
    )


def freeze_execution(
    request: BatchRequest,
    snapshot: SelectorSnapshot,
) -> tuple[TransientExecution, ...]:
    """Validate one selector snapshot and freeze its actual process-local targets."""

    if not isinstance(request, BatchRequest):
        raise TypeError("request must be BatchRequest")
    selector = request.selector
    if isinstance(selector, LiteratureSelector):
        if not isinstance(snapshot, LiteratureSelectorSnapshot):
            raise ExecutionSnapshotError()
        return _freeze_literature_scope(request, snapshot)
    if not isinstance(
        selector,
        (
            AllPendingSelector,
            DiscoveryRunSelector,
            ImportReportSelector,
            QuerySelector,
            MetaLiteratureSelector,
        ),
    ) or not isinstance(snapshot, MetaSelectorSnapshot):
        raise ExecutionSnapshotError()
    return _freeze_meta_scope(request, snapshot)


def execute_database_write(
    *,
    admission: WriteAdmissionPort,
    recovery: DiscoveryRunRecoveryPort,
    prepare: Callable[[], _PreparedT],
    execute: Callable[[_PreparedT], _ResultT],
) -> _ResultT:
    """Hold write admission while recovery, reads, and business execution run."""

    if not callable(prepare):
        raise TypeError("prepare must be callable")
    if not callable(execute):
        raise TypeError("execute must be callable")
    with admission.acquire_nowait():
        interrupted = recovery.interrupt_visible_running()
        if not isinstance(interrupted, tuple) or any(
            not isinstance(item, DiscoveryRunId) for item in interrupted
        ):
            raise TypeError("recovery must return a tuple of DiscoveryRunId values")
        prepared = prepare()
        return execute(prepared)


def _freeze_meta_scope(
    request: BatchRequest,
    snapshot: MetaSelectorSnapshot,
) -> tuple[TransientExecution, ...]:
    selector = request.selector
    scope = _deduplicate(snapshot.meta_literature_ids)
    if isinstance(selector, (ImportReportSelector, MetaLiteratureSelector)):
        if scope != selector.meta_literature_ids:
            raise ExecutionSnapshotError()

    meta_by_id = _index_meta_literatures(snapshot.meta_literatures)
    if set(meta_by_id) != set(scope):
        raise ExecutionSnapshotError()

    current_by_id = _unique_current_facts(snapshot.current_facts)
    candidates_by_meta = _group_meta_candidates(scope, tuple(current_by_id.values()))

    result: list[TransientExecution] = []
    for identity in scope:
        meta_literature = meta_by_id[identity]
        members = candidates_by_meta[identity]
        if not members or meta_literature.representative_literature_id not in {
            candidate.literature_id for candidate in members
        }:
            raise ExecutionSnapshotError()
        ordered = order_execution_candidates(tuple(members))
        if any(_reaches_goal(candidate.status, request.goal) for candidate in ordered):
            continue
        eligible = _eligible_candidates(selector, ordered)
        if not eligible:
            continue
        result.append(
            TransientMetaExecution(
                target=MetaLiteratureCompletionTarget(
                    kind="meta-literature",
                    meta_literature_id=identity,
                ),
                candidates=eligible,
            )
        )
    return tuple(result)


def _index_meta_literatures(
    values: tuple[MetaLiterature, ...],
) -> dict[MetaLiteratureId, MetaLiterature]:
    result: dict[MetaLiteratureId, MetaLiterature] = {}
    for meta_literature in values:
        identity = meta_literature.meta_literature_id
        if identity in result:
            raise ExecutionSnapshotError()
        result[identity] = meta_literature
    return result


def _eligible_candidates(
    selector: object,
    candidates: tuple[FrozenLiteratureCandidate, ...],
) -> tuple[FrozenLiteratureCandidate, ...]:
    if not isinstance(selector, AllPendingSelector):
        return candidates
    return tuple(
        candidate for candidate in candidates if candidate.current.automatic_pdf_exhaustion is None
    )


def _group_meta_candidates(
    scope: tuple[MetaLiteratureId, ...],
    values: tuple[ExecutionCurrentFacts, ...],
) -> dict[MetaLiteratureId, list[FrozenLiteratureCandidate]]:
    result: dict[MetaLiteratureId, list[FrozenLiteratureCandidate]] = {
        identity: [] for identity in scope
    }
    for current in values:
        meta_identity = current.current.literature.meta_literature_id
        if meta_identity not in result:
            raise ExecutionSnapshotError()
        result[meta_identity].append(_freeze_candidate(current))
    return result


def _freeze_literature_scope(
    request: BatchRequest,
    snapshot: LiteratureSelectorSnapshot,
) -> tuple[TransientExecution, ...]:
    selector = cast(LiteratureSelector, request.selector)
    scope = _deduplicate(snapshot.literature_ids)
    if scope != selector.literature_ids:
        raise ExecutionSnapshotError()
    current_by_id = _unique_current_facts(snapshot.current_facts)
    if set(current_by_id) != set(scope):
        raise ExecutionSnapshotError()

    result: list[TransientExecution] = []
    for identity in scope:
        candidate = _freeze_candidate(current_by_id[identity])
        if _reaches_goal(candidate.status, request.goal):
            continue
        result.append(
            TransientLiteratureExecution(
                target=LiteratureCompletionTarget(
                    kind="literature",
                    literature_id=identity,
                ),
                candidate=candidate,
            )
        )
    return tuple(result)


def _freeze_candidate(current: ExecutionCurrentFacts) -> FrozenLiteratureCandidate:
    facts = current.current
    literature_id = facts.literature.literature_id
    if len(facts.current_primary_pdfs) > 1:
        raise ExecutionSnapshotError()
    primary = facts.current_primary_pdfs[0] if facts.current_primary_pdfs else None
    if primary is not None and primary.relation.literature_id != literature_id:
        raise ExecutionSnapshotError()
    if primary is not None and current.automatic_pdf_exhaustion is not None:
        raise ExecutionSnapshotError()

    parser_result = facts.current_parser_result
    if parser_result is not None:
        if primary is None or (
            parser_result.source_asset_id != primary.asset.asset_id
            or parser_result.source_sha256 != primary.asset.sha256
        ):
            raise ExecutionSnapshotError()

    status = derive_status(facts)
    if facts.literature.status is not status:
        raise ExecutionSnapshotError()
    return FrozenLiteratureCandidate(
        current=current,
        status=status,
        has_aligned_parser_result=parser_result is not None,
        has_current_primary_pdf=primary is not None,
    )


def _unique_current_facts(
    values: tuple[ExecutionCurrentFacts, ...],
) -> dict[LiteratureId, ExecutionCurrentFacts]:
    result: dict[LiteratureId, ExecutionCurrentFacts] = {}
    for current in values:
        identity = current.current.literature.literature_id
        if identity in result:
            raise ExecutionSnapshotError()
        result[identity] = current
    return result


def _deduplicate(values: tuple[_PreparedT, ...]) -> tuple[_PreparedT, ...]:
    result: list[_PreparedT] = []
    for value in values:
        if value not in result:
            result.append(value)
    return tuple(result)


def _reaches_goal(status: LiteratureStatus, goal: BatchGoal) -> bool:
    if goal == "ASSET_READY":
        return status in {LiteratureStatus.ASSET_READY, LiteratureStatus.CONTENT_READY}
    return status is LiteratureStatus.CONTENT_READY


__all__ = (
    "ExecutionSnapshotError",
    "FrozenLiteratureCandidate",
    "TransientExecution",
    "TransientLiteratureExecution",
    "TransientMetaExecution",
    "candidate_order_key",
    "execute_database_write",
    "freeze_execution",
    "order_execution_candidates",
)
