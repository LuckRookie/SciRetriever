from completion_pipeline_fixture import *


class BatchAndOperationTests(unittest.IsolatedAsyncioTestCase):
    async def test_batch_deduplicates_resolved_identity_and_redacts_failure(self) -> None:
        value, _, owners = pipeline(CompletionStage.COMPLETE)
        owners[0].version = VERSION_A
        bad = WorkVersionTarget(VERSION_B)
        result = await run_completion_batch(value, (DoiTarget("10.1234/a"),
            WorkVersionTarget(VERSION_A), bad), CompletionStop.COMPLETE)
        self.assertEqual(tuple(item.status for item in result.items),
                         (BatchItemStatus.SUCCEEDED, BatchItemStatus.DUPLICATE, BatchItemStatus.FAILED))
        self.assertNotIn("provider secret", str(result.to_dict()))

    async def test_keyboard_interrupt_marks_current_and_suffix(self) -> None:
        value, _, owners = pipeline(CompletionStage.ASSET_PENDING)
        owners[1].interrupt = True
        targets = (WorkVersionTarget(VERSION_A), WorkVersionTarget(VERSION_B))
        result = await run_completion_batch(value, targets, CompletionStop.ASSET)
        self.assertEqual(tuple(item.status for item in result.items),
                         (BatchItemStatus.INTERRUPTED, BatchItemStatus.INTERRUPTED))

    async def test_batch_reraises_invariant_but_sanitizes_owner_runtime_failure(self) -> None:
        value, _, owners = pipeline(CompletionStage.ASSET_PENDING)
        owners[1].on_call = lambda: None
        with self.assertRaises(CompletionInvariantError):
            await run_completion_batch(value, (WorkVersionTarget(VERSION_A),),
                                       CompletionStop.ASSET)
        value, store, owners = pipeline(CompletionStage.ANALYSIS_PENDING)
        store.values[VERSION_B] = facts(VERSION_B, CompletionStage.COMPLETE,
                                       revision=1, current=ANALYSIS_A)
        owners[2].fail = True
        result = await run_completion_batch(value, (WorkVersionTarget(VERSION_A),
            WorkVersionTarget(VERSION_B)), CompletionStop.COMPLETE)
        self.assertEqual(tuple(item.status for item in result.items),
                         (BatchItemStatus.FAILED, BatchItemStatus.SUCCEEDED))
        self.assertNotIn("provider secret", str(result.to_dict()))

    async def test_batch_reraises_programming_invariant_defects(self) -> None:
        value, _, owners = pipeline(CompletionStage.ASSET_PENDING)

        async def invalid_owner_call(work_version_id: str) -> RequiredPrimaryResult:
            raise TypeError(f"invalid owner contract for {work_version_id}")

        owners[1].acquire = invalid_owner_call
        with self.assertRaises(TypeError):
            await run_completion_batch(value, (WorkVersionTarget(VERSION_A),),
                                       CompletionStop.ASSET)

    def test_required_primary_result_rejects_invalid_disposition_reason_pairs(self) -> None:
        invalid = (
            (OutcomeDisposition.ADVANCED, OutcomeReason.EXHAUSTED),
            (OutcomeDisposition.ADVANCED, OutcomeReason.ALREADY_SATISFIED),
            (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.SUCCEEDED),
            (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.INTERRUPTED),
        )
        for disposition, reason in invalid:
            with self.subTest(disposition=disposition, reason=reason):
                with self.assertRaises(ValueError):
                    RequiredPrimaryResult(VERSION_A, disposition, reason)

    async def test_primary_adapter_maps_only_explicit_owner_statuses(self) -> None:
        expected = {
            "succeeded": (OutcomeDisposition.ADVANCED, OutcomeReason.SUCCEEDED),
            "failed": (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.EXHAUSTED),
            "reused": (OutcomeDisposition.NOT_ADVANCED, OutcomeReason.ALREADY_SATISFIED),
        }
        for status, pair in expected.items():
            with self.subTest(status=status):
                store = FactStore({VERSION_A: facts(VERSION_A, CompletionStage.ASSET_PENDING)})
                runtime = AcquisitionRuntimeConfig(
                    cast(WorkVersionDownloadRepository, DownloadRepositoryFake((Identifier("doi", "10.1234/a"),))),
                    cast(WorkVersionAcquisitionService, AcquisitionServiceFake(status, store)),
                    cast(CompletionFactsRepository, store), ("fixture",), 1.0)
                result = await RequiredPrimaryAdapter(runtime).acquire(VERSION_A)
                self.assertEqual((result.disposition, result.reason), pair)
        store = FactStore({VERSION_A: facts(VERSION_A, CompletionStage.ASSET_PENDING)})
        runtime = AcquisitionRuntimeConfig(
            cast(WorkVersionDownloadRepository, DownloadRepositoryFake(())),
            cast(WorkVersionAcquisitionService, AcquisitionServiceFake("reused", store, progress=True)),
            cast(CompletionFactsRepository, store), ("fixture",), 1.0)
        progressed = await RequiredPrimaryAdapter(runtime).acquire(VERSION_A)
        self.assertEqual(progressed.disposition, OutcomeDisposition.ADVANCED)
        runtime = AcquisitionRuntimeConfig(
            cast(WorkVersionDownloadRepository, DownloadRepositoryFake(())),
            cast(WorkVersionAcquisitionService, AcquisitionServiceFake("mystery", store)),
            cast(CompletionFactsRepository, store), ("fixture",), 1.0)
        with self.assertRaises(ValueError):
            await RequiredPrimaryAdapter(runtime).acquire(VERSION_A)

    def test_identifier_adapter_reads_only_normalized_doi(self) -> None:
        repository = cast(WorkVersionDownloadRepository, DownloadRepositoryFake((
            Identifier("pmid", "123"), Identifier("doi", "HTTPS://DOI.ORG/10.1234/Example"))))
        self.assertEqual(WorkVersionIdentifierAdapter(repository).doi_for(VERSION_A),
                         "10.1234/example")

    async def test_force_replaces_exactly_one_complete_revision_and_failure_preserves_current(self) -> None:
        value, store, owners = pipeline(CompletionStage.COMPLETE)
        result = value.force_analysis(ForceAnalysisRequest(WorkVersionTarget(VERSION_A), 1))
        self.assertEqual((result.previous_revision, result.current_revision), (1, 2))
        old = store.values[VERSION_A]
        owners[2].fail = True
        with self.assertRaises(RuntimeError):
            value.force_analysis(ForceAnalysisRequest(WorkVersionTarget(VERSION_A), 2))
        self.assertEqual(store.values[VERSION_A], old)

    async def test_optional_operation_rereads_and_requires_stage_invariance(self) -> None:
        value, store, owners = pipeline(CompletionStage.COMPLETE)
        request = OptionalAssetRequest(WorkVersionTarget(VERSION_A), OptionalAssetKind.XML)
        result = await value.acquire_optional(request)
        self.assertEqual(result.stage_before, result.stage_after)
        self.assertEqual(len(store.reads), 2)


if __name__ == "__main__":
    unittest.main()
