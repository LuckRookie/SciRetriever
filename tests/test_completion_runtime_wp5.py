from __future__ import annotations

import unittest

from sciretriever.acquisition.models import AcquisitionResult
from sciretriever.acquisition.models import AcquisitionTarget
from sciretriever.catalog import CompletionFacts, CompletionStage
from sciretriever.catalog.download_selection import WorkVersionDownloadRecord
from sciretriever.cli.completion_runtime import (
    AcquisitionRuntimeConfig,
    RequiredPrimaryAdapter,
    WorkVersionIdentifierAdapter,
)
from sciretriever.cli.completion_unconfigured import AnalysisOnlyRequiredPrimary
from sciretriever.completion import OutcomeDisposition, OutcomeReason
from sciretriever.core.contracts import Identifier
from sciretriever.core.enums import AssetRole


VERSION = "11111111-1111-4111-8111-111111111111"
WORK = "22222222-2222-4222-8222-222222222222"


class DownloadRepositoryFake:
    def __init__(self) -> None:
        self.record = WorkVersionDownloadRecord(
            VERSION,
            WORK,
            (Identifier("pmid", "123"), Identifier("doi", " HTTPS://DOI.ORG/10.1/Example ")),
            "Title",
            (),
            None,
            None,
            None,
            None,
        )

    def get(self, work_version_id: str) -> WorkVersionDownloadRecord:
        if work_version_id != VERSION:
            raise AssertionError("unexpected WorkVersion")
        return self.record


class AcquisitionServiceFake:
    def __init__(self, status: str) -> None:
        self.status = status

    async def acquire(self, work_version_id: str, role: AssetRole,
                      target: AcquisitionTarget, providers: tuple[str, ...],
                      *, timeout: float) -> AcquisitionResult:
        return AcquisitionResult(work_version_id, self.status)


class FactsFake:
    def __init__(self) -> None:
        self.reads: list[str] = []

    def get(self, work_version_id: str) -> CompletionFacts:
        self.reads.append(work_version_id)
        return CompletionFacts(work_version_id, CompletionStage.ASSET_PENDING,
                               True, False, False, None, None, None, 0)


class CompletionRuntimeAdapterTests(unittest.IsolatedAsyncioTestCase):
    def test_identifier_adapter_returns_normalized_catalog_doi(self) -> None:
        owner = WorkVersionIdentifierAdapter(DownloadRepositoryFake())

        self.assertEqual(owner.doi_for(VERSION), "10.1/example")

    async def test_required_primary_adapter_maps_all_known_statuses(self) -> None:
        expected = {
            "succeeded": (OutcomeDisposition.ADVANCED, OutcomeReason.SUCCEEDED),
            "reused": (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.ALREADY_SATISFIED),
            "failed": (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.EXHAUSTED),
        }
        for status, pair in expected.items():
            with self.subTest(status=status):
                runtime = AcquisitionRuntimeConfig(
                    DownloadRepositoryFake(), AcquisitionServiceFake(status), FactsFake(),
                    ("fixture",), 5.0)
                owner = RequiredPrimaryAdapter(runtime)
                result = await owner.acquire(VERSION)
                self.assertEqual((result.disposition, result.reason), pair)

    async def test_analysis_only_primary_returns_typed_exhaustion(self) -> None:
        result = await AnalysisOnlyRequiredPrimary().acquire(VERSION)

        self.assertEqual(
            (result.work_version_id, result.disposition, result.reason),
            (VERSION, OutcomeDisposition.NOT_ADVANCED, OutcomeReason.EXHAUSTED),
        )

    async def test_required_primary_adapter_rejects_unknown_status(self) -> None:
        runtime = AcquisitionRuntimeConfig(
            DownloadRepositoryFake(), AcquisitionServiceFake("unknown"), FactsFake(),
            ("fixture",), 5.0)
        owner = RequiredPrimaryAdapter(runtime)

        with self.assertRaises(ValueError):
            await owner.acquire(VERSION)


if __name__ == "__main__":
    unittest.main()
