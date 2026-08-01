from completion_pipeline_fixture import *


class CompletionPipelineTests(unittest.IsolatedAsyncioTestCase):
    async def test_doi_enters_at_metadata_and_obeys_all_action_ceilings(self) -> None:
        for stop, expected_stage, expected_calls in (
            (CompletionStop.METADATA, CompletionStage.ASSET_PENDING, (1, 0, 0)),
            (CompletionStop.ASSET, CompletionStage.ANALYSIS_PENDING, (1, 1, 0)),
            (CompletionStop.COMPLETE, CompletionStage.COMPLETE, (1, 1, 1)),
        ):
            value, store, owners = pipeline(CompletionStage.ASSET_PENDING)
            result = completed(await value.ensure_complete(DoiTarget("10.1234/example"), stop))
            self.assertEqual(result.final_stage, expected_stage)
            self.assertEqual(tuple(len(owner.calls) for owner in owners[:3]), expected_calls)
            self.assertGreaterEqual(len(store.reads), 1 + expected_calls[1] + expected_calls[2])

    async def test_each_existing_entry_stage_calls_only_missing_suffix(self) -> None:
        cases = (
            (CompletionStage.ASSET_PENDING, (1, 1), CompletionStage.COMPLETE),
            (CompletionStage.ANALYSIS_PENDING, (0, 1), CompletionStage.COMPLETE),
            (CompletionStage.COMPLETE, (0, 0), CompletionStage.COMPLETE),
        )
        for stage, calls, final in cases:
            value, _, owners = pipeline(stage)
            result = completed(await value.ensure_complete(WorkVersionTarget(VERSION_A), CompletionStop.COMPLETE))
            self.assertEqual(result.final_stage, final)
            self.assertEqual((len(owners[1].calls), len(owners[2].calls)), calls)

    async def test_existing_metadata_pending_resolves_its_doi_and_replays(self) -> None:
        value, store, owners = pipeline(CompletionStage.METADATA_PENDING)
        owners[0].version = VERSION_A
        original_resolve = owners[0].resolve

        def resolve(request):
            store.values[VERSION_A] = facts(VERSION_A, CompletionStage.ASSET_PENDING)
            return original_resolve(request)

        owners[0].resolve = resolve
        result = completed(await value.ensure_complete(
            WorkVersionTarget(VERSION_A), CompletionStop.METADATA))
        self.assertEqual(result.final_stage, CompletionStage.ASSET_PENDING)
        self.assertEqual(owners[0].calls, ["10.1234/existing"])
        replay = completed(await value.ensure_complete(
            WorkVersionTarget(VERSION_A), CompletionStop.METADATA))
        self.assertEqual(replay.outcomes, ())
        self.assertEqual(owners[0].calls, ["10.1234/existing"])

    async def test_existing_metadata_without_doi_exhausts_without_owner_call(self) -> None:
        value, _, owners = pipeline(CompletionStage.METADATA_PENDING)
        owners[4].doi = None
        result = completed(await value.ensure_complete(
            WorkVersionTarget(VERSION_A), CompletionStop.METADATA))
        self.assertEqual(result.final_stage, CompletionStage.METADATA_PENDING)
        self.assertEqual(result.outcomes[-1].reason, OutcomeReason.EXHAUSTED)
        self.assertEqual(owners[0].calls, [])

    async def test_existing_metadata_resolution_mismatch_is_invariant(self) -> None:
        value, _, owners = pipeline(CompletionStage.METADATA_PENDING)
        owners[0].version = VERSION_B
        with self.assertRaises(CompletionInvariantError):
            await value.ensure_complete(WorkVersionTarget(VERSION_A), CompletionStop.METADATA)

    async def test_no_exact_metadata_has_typed_no_version_result(self) -> None:
        value, store, owners = pipeline(CompletionStage.ASSET_PENDING)
        owners[0].version = None
        result = await value.ensure_complete(DoiTarget("10.1234/missing"), CompletionStop.COMPLETE)
        self.assertIsInstance(result, MetadataUnavailableResult)
        self.assertEqual(store.reads, [])
        self.assertEqual((len(owners[1].calls), len(owners[2].calls)), (0, 0))

    async def test_not_advanced_terminates_and_false_advanced_raises(self) -> None:
        value, _, owners = pipeline(CompletionStage.ASSET_PENDING)
        owners[1].disposition = OutcomeDisposition.NOT_ADVANCED
        result = completed(await value.ensure_complete(WorkVersionTarget(VERSION_A), CompletionStop.COMPLETE))
        self.assertEqual(result.final_stage, CompletionStage.ASSET_PENDING)
        value, _, owners = pipeline(CompletionStage.ASSET_PENDING)
        owners[1].on_call = lambda: None
        with self.assertRaises(CompletionInvariantError):
            await value.ensure_complete(WorkVersionTarget(VERSION_A), CompletionStop.COMPLETE)

    async def test_restart_runs_only_suffix_and_concurrent_progress_is_accepted(self) -> None:
        value, store, owners = pipeline(CompletionStage.ASSET_PENDING)
        owners[2].fail = True
        with self.assertRaises(RuntimeError):
            await value.ensure_complete(WorkVersionTarget(VERSION_A), CompletionStop.COMPLETE)
        owners[2].fail = False
        result = completed(await value.ensure_complete(WorkVersionTarget(VERSION_A), CompletionStop.COMPLETE))
        self.assertEqual(result.final_stage, CompletionStage.COMPLETE)
        self.assertEqual(len(owners[1].calls), 1)
        value, store, owners = pipeline(CompletionStage.ASSET_PENDING)
        owners[1].on_call = lambda: store.values.__setitem__(
            VERSION_A, facts(VERSION_A, CompletionStage.COMPLETE,
                             revision=1, current=ANALYSIS_A))
        self.assertEqual(completed(await value.ensure_complete(
            WorkVersionTarget(VERSION_A), CompletionStop.ASSET)).final_stage,
            CompletionStage.COMPLETE)
        value, store, owners = pipeline(CompletionStage.ANALYSIS_PENDING)
        owners[2].on_call = lambda: store.values.__setitem__(
            VERSION_A, facts(VERSION_A, CompletionStage.COMPLETE,
                             revision=1, current=ANALYSIS_A))
        self.assertEqual(completed(await value.ensure_complete(
            WorkVersionTarget(VERSION_A), CompletionStop.COMPLETE)).final_stage,
            CompletionStage.COMPLETE)

