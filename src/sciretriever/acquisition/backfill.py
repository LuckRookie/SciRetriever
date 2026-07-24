"""Foreground download backfill over selected existing WorkVersions."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Mapping

from sciretriever.acquisition.models import AcquisitionResult, AcquisitionTarget
from sciretriever.acquisition.service import WorkVersionAcquisitionService
from sciretriever.catalog.download_selection import WorkVersionDownloadRecord, WorkVersionDownloadRepository
from sciretriever.core.enums import AssetRole


@dataclass(frozen=True, slots=True)
class WorkVersionDownloadOutcome:
    work_version_id: str
    overall: str
    roles: tuple[tuple[str, str], ...]
    failures: tuple[Mapping[str, object], ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "failures": [dict(item) for item in self.failures],
            "overall": self.overall,
            "roles": {role: status for role, status in self.roles},
            "work_version_id": self.work_version_id,
        }


@dataclass(frozen=True, slots=True)
class DownloadBackfillResult:
    selected: int
    accepted: int
    reused: int
    missing: int
    interrupted: int
    outcomes: tuple[WorkVersionDownloadOutcome, ...]

    def to_dict(self) -> dict[str, object]:
        return {
            "counts": {
                "accepted": self.accepted,
                "interrupted": self.interrupted,
                "missing": self.missing,
                "reused": self.reused,
                "selected": self.selected,
            },
            "work_versions": [item.to_dict() for item in self.outcomes],
        }


class DownloadBackfillService:
    def __init__(
        self,
        repository: WorkVersionDownloadRepository,
        acquisition: WorkVersionAcquisitionService,
        providers: tuple[str, ...],
        *,
        timeout: float,
        include_xml: bool = False,
        include_html: bool = False,
    ) -> None:
        self.repository = repository
        self.acquisition = acquisition
        self.providers = providers
        self.timeout = timeout
        self.roles = (AssetRole.PRIMARY_PDF,) + (
            (AssetRole.XML,) if include_xml else ()
        ) + ((AssetRole.HTML,) if include_html else ())
        self.last_result = DownloadBackfillResult(0, 0, 0, 0, 0, ())

    @staticmethod
    def _target(record: WorkVersionDownloadRecord, role: AssetRole) -> AcquisitionTarget:
        return AcquisitionTarget(
            record.identifiers,
            record.direct_url,
            role,
            record.title,
            record.authors,
            record.publication_year,
            record.publisher,
            record.venue,
        )

    async def run(self, work_version_ids: tuple[str, ...]) -> DownloadBackfillResult:
        outcomes: list[WorkVersionDownloadOutcome] = []
        accepted = reused = missing = 0
        selected = len(work_version_ids)
        self.last_result = DownloadBackfillResult(selected, 0, 0, 0, 0, ())
        try:
            for work_version_id in work_version_ids:
                record = self.repository.get(work_version_id)
                role_results: list[tuple[AssetRole, AcquisitionResult]] = []
                primary = await self.acquisition.acquire(
                    work_version_id,
                    AssetRole.PRIMARY_PDF,
                    self._target(record, AssetRole.PRIMARY_PDF),
                    self.providers,
                    timeout=self.timeout,
                )
                role_results.append((AssetRole.PRIMARY_PDF, primary))
                if primary.status == "succeeded":
                    accepted += 1
                elif primary.status == "reused":
                    reused += 1
                else:
                    missing += 1
                if primary.status != "failed":
                    for role in self.roles[1:]:
                        role_results.append((role, await self.acquisition.acquire(
                            work_version_id,
                            role,
                            self._target(record, role),
                            self.providers,
                            timeout=self.timeout,
                        )))
                failures = tuple(
                    {
                        "role": role.value,
                        "sources": [dict(item) for item in result.source_failures],
                        "summary": result.error or "optional role unavailable",
                    }
                    for role, result in role_results
                    if result.status == "failed"
                )
                overall = "missing" if primary.status == "failed" else primary.status
                outcomes.append(WorkVersionDownloadOutcome(
                    work_version_id,
                    overall,
                    tuple((role.value, result.status) for role, result in role_results),
                    failures,
                ))
                self.last_result = DownloadBackfillResult(
                    selected, accepted, reused, missing, 0, tuple(outcomes)
                )
        except asyncio.CancelledError:
            interrupted = selected - len(outcomes)
            self.last_result = DownloadBackfillResult(
                selected, accepted, reused, missing, interrupted, tuple(outcomes)
            )
            return self.last_result
        return self.last_result


__all__ = (
    "DownloadBackfillResult",
    "DownloadBackfillService",
    "WorkVersionDownloadOutcome",
)
