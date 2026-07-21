"""Pure deterministic P5 routing and durable resume reconstruction."""

from __future__ import annotations

from dataclasses import dataclass

from sciretriever.acquisition.attempt_details import decode_candidate_attempt
from sciretriever.acquisition.plan import SourceEntry, SourcePlan
from sciretriever.catalog.records import AttemptRecord
from sciretriever.core.enums import AttemptOutcome


_OUTCOME_PRECEDENCE = {
    AttemptOutcome.RETRYABLE: 0,
    AttemptOutcome.CANCELLED: 1,
    AttemptOutcome.FAILED: 2,
    AttemptOutcome.SUCCEEDED: 3,
}


@dataclass(frozen=True, slots=True)
class ResumeDecision:
    runnable: tuple[SourceEntry, ...]
    skipped: tuple[SourceEntry, ...]
    waiting_for_retry: bool = False


def _attempt_identity(attempt: AttemptRecord) -> tuple[str, int | None] | None:
    details = decode_candidate_attempt(attempt.details_json)
    if details is None:
        return None
    return details.candidate_id, details.attempt_sequence


def next_attempt_sequence(attempts: tuple[AttemptRecord, ...]) -> int:
    maximum = 0
    for attempt in attempts:
        identity = _attempt_identity(attempt)
        if identity is not None and identity[1] is not None:
            maximum = max(maximum, identity[1])
    return max(maximum, len(attempts)) + 1


def resume_candidates(
    plan: SourcePlan,
    attempts: tuple[AttemptRecord, ...],
    *,
    retry_due: bool = True,
) -> ResumeDecision:
    outcomes: dict[str, tuple[int | None, AttemptOutcome]] = {}
    for attempt in attempts:
        identity = _attempt_identity(attempt)
        if identity is None or attempt.outcome is None:
            continue
        candidate_id, sequence = identity
        existing = outcomes.get(candidate_id)
        if existing is None:
            outcomes[candidate_id] = (sequence, attempt.outcome)
            continue
        existing_sequence, existing_outcome = existing
        if sequence is not None and (existing_sequence is None or sequence > existing_sequence):
            outcomes[candidate_id] = (sequence, attempt.outcome)
        elif sequence == existing_sequence and _OUTCOME_PRECEDENCE[attempt.outcome] > _OUTCOME_PRECEDENCE[existing_outcome]:
            outcomes[candidate_id] = (sequence, attempt.outcome)
    runnable: list[SourceEntry] = []
    skipped: list[SourceEntry] = []
    waiting = False
    for entry in plan.entries:
        state = outcomes.get(entry.candidate_id)
        outcome = None if state is None else state[1]
        if outcome in {AttemptOutcome.SUCCEEDED, AttemptOutcome.CANCELLED, AttemptOutcome.FAILED}:
            skipped.append(entry)
        elif outcome is AttemptOutcome.RETRYABLE and not retry_due:
            skipped.append(entry)
            waiting = True
        else:
            runnable.append(entry)
    return ResumeDecision(tuple(runnable), tuple(skipped), waiting)


def tiers(entries: tuple[SourceEntry, ...]) -> tuple[tuple[SourceEntry, ...], ...]:
    values: list[tuple[SourceEntry, ...]] = []
    for tier in sorted({entry.tier for entry in entries}):
        values.append(tuple(entry for entry in entries if entry.tier == tier))
    return tuple(values)


__all__ = ("ResumeDecision", "next_attempt_sequence", "resume_candidates", "tiers")
