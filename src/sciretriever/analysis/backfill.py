"""Foreground analysis backfill over explicitly selected WorkVersions."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from sciretriever.catalog.analysis_selection import WorkVersionAnalysisRecord, WorkVersionAnalysisRepository


@dataclass(frozen=True, slots=True)
class WorkVersionAnalysisOutcome:
    work_version_id: str
    status: str
    reason: str
    action: str

    def to_dict(self) -> dict[str, str]:
        return {"action": self.action, "reason": self.reason, "status": self.status,
                "work_version_id": self.work_version_id}


@dataclass(frozen=True, slots=True)
class AnalysisBackfillResult:
    selected: int
    analyzed: int
    reused: int
    blocked: int
    failed: int
    interrupted: int
    outcomes: tuple[WorkVersionAnalysisOutcome, ...]

    def to_dict(self) -> dict[str, object]:
        return {"counts": {name: getattr(self, name) for name in
            ("selected", "analyzed", "reused", "blocked", "failed", "interrupted")},
            "work_versions": [item.to_dict() for item in self.outcomes]}


AnalyzeOne = Callable[[WorkVersionAnalysisRecord, bool], str]


class AnalysisBackfillService:
    def __init__(self, repository: WorkVersionAnalysisRepository, analyze_one: AnalyzeOne) -> None:
        self.repository = repository
        self.analyze_one = analyze_one
        self.last_result = AnalysisBackfillResult(0, 0, 0, 0, 0, 0, ())

    def run(self, work_version_ids: tuple[str, ...], *, force: bool = False) -> AnalysisBackfillResult:
        outcomes: list[WorkVersionAnalysisOutcome] = []
        counts = {"analyzed": 0, "reused": 0, "blocked": 0, "failed": 0}
        selected = len(work_version_ids)
        try:
            for version_id in work_version_ids:
                try:
                    record = self.repository.get(version_id)
                    if record.eligibility_reason is not None:
                        outcome = WorkVersionAnalysisOutcome(version_id, "blocked", record.eligibility_reason,
                            "download_primary_pdf")
                    else:
                        status = self.analyze_one(record, force)
                        if status not in {"analyzed", "reused"}:
                            raise ValueError("analysis callback returned an invalid status")
                        outcome = WorkVersionAnalysisOutcome(version_id, status, "analysis_completed",
                            "none")
                except KeyboardInterrupt:
                    raise
                except Exception:
                    outcome = WorkVersionAnalysisOutcome(version_id, "failed", "analysis_failed",
                        "retry_analysis")
                counts[outcome.status] += 1
                outcomes.append(outcome)
                self.last_result = AnalysisBackfillResult(selected, counts["analyzed"], counts["reused"],
                    counts["blocked"], counts["failed"], 0, tuple(outcomes))
        except KeyboardInterrupt:
            self.last_result = AnalysisBackfillResult(selected, counts["analyzed"], counts["reused"],
                counts["blocked"], counts["failed"], selected - len(outcomes), tuple(outcomes))
            raise
        return self.last_result


__all__ = ("AnalysisBackfillResult", "AnalysisBackfillService", "WorkVersionAnalysisOutcome")
