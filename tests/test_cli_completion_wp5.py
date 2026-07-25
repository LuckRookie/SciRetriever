from __future__ import annotations

import argparse
import contextlib
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

from sciretriever.catalog import CompletionStage
from sciretriever.cli import search
import sciretriever.cli.search_completion_runtime as search_completion_runtime
from sciretriever.completion import (
    BatchItemResult, BatchPolicy, BatchResult, CompletionStop, DoiTarget,
    OutcomeReason,
)


class RuntimeFake:
    def __init__(self) -> None:
        self.completion = SimpleNamespace(pipeline=object())
        self.closed = False
        self.search_calls = 0
        self.output: SimpleNamespace | None = None
        self.target_ids: tuple[str, ...] = ()
        self.failures: list[dict[str, str]] = []

    def search(self) -> object:
        self.search_calls += 1
        if self.output is None:
            raise AssertionError("DOI must bypass generic search")
        return self.output

    def close(self) -> None:
        self.closed = True

    def exact_failures(self) -> list[dict[str, str]]:
        return self.failures

    def targets(self, output: object) -> tuple[str, ...]:
        self.asserted_output = output
        return self.target_ids


def arguments(level: str) -> argparse.Namespace:
    return argparse.Namespace(
        query="https://doi.org/10.1234/Example", level=level,
        catalog=Path("catalog.sqlite"), storage_root=None,
        provider=["crossref"], precedence=["crossref"], limit=100,
        provider_timeout=30.0, max_concurrency=8, crossref_mailto=None,
        download_provider=["direct"], download_timeout=30.0,
        download_provider_concurrency=4, host_concurrency=2,
        host_min_interval=0.0, max_asset_bytes=1024, forbidden_urls=None,
        xml=False, html=False,
    )


class CliCompletionWp5Tests(unittest.TestCase):
    def test_exact_doi_routes_directly_to_each_completion_ceiling(self) -> None:
        expected = {
            "metadata": CompletionStop.METADATA,
            "download": CompletionStop.ASSET,
            "analyze": CompletionStop.COMPLETE,
        }
        for level, stop in expected.items():
            runtime = RuntimeFake()
            target = DoiTarget("10.1234/example")
            result = BatchResult(BatchPolicy(), (
                BatchItemResult.exhausted(target),
            ))
            async def run_batch(pipeline, targets, requested):
                self.assertIs(pipeline, runtime.completion.pipeline)
                self.assertEqual(targets, (target,))
                self.assertIs(requested, stop)
                return result
            output = io.StringIO()
            with mock.patch.object(search, "build_search_completion_runtime", return_value=runtime), \
                    mock.patch.object(search, "run_completion_batch", side_effect=run_batch), \
                    contextlib.redirect_stdout(output):
                code = search.run(arguments(level))
            self.assertEqual(code, 1)
            self.assertTrue(runtime.closed)
            payload = json.loads(output.getvalue())
            self.assertEqual(payload["completion"]["items"][0]["target"],
                             {"kind": "doi", "doi": "10.1234/example"})

    def test_exact_exhaustion_reports_provider_failures_without_generic_search(self) -> None:
        runtime = RuntimeFake()
        runtime.failures = [{"category": "provider_error", "message": "provider search failed",
                             "provider": "crossref"}]
        result = BatchResult(BatchPolicy(), (BatchItemResult.exhausted(DoiTarget("10.1234/example")),))
        output = io.StringIO()
        with mock.patch.object(search, "build_search_completion_runtime", return_value=runtime), \
                mock.patch.object(search, "run_completion_batch", return_value=result), \
                contextlib.redirect_stdout(output):
            code = search.run(arguments("metadata"))
        payload = json.loads(output.getvalue())
        self.assertEqual(code, 1)
        self.assertEqual(runtime.search_calls, 0)
        self.assertEqual(payload["counts"], {"failures": 1, "results": 0})
        self.assertEqual(payload["failures"], runtime.failures)

    def test_ordinary_query_runs_search_once_and_completes_only_stable_returned_ids(self) -> None:
        first = "11111111-1111-4111-8111-111111111111"
        second = "22222222-2222-4222-8222-222222222222"
        runtime = RuntimeFake()
        runtime.output = SimpleNamespace(results=(), failures=())
        runtime.target_ids = (second, first)
        seen = None
        async def run_batch(_pipeline, targets, stop):
            nonlocal seen
            seen = (targets, stop)
            return BatchResult(BatchPolicy(), ())
        args = arguments("download")
        args.query = "ordinary query"
        output = io.StringIO()
        with mock.patch.object(search, "build_search_completion_runtime", return_value=runtime), \
                mock.patch.object(search, "run_completion_batch", side_effect=run_batch), \
                contextlib.redirect_stdout(output):
            code = search.run(args)
        self.assertEqual(code, 0)
        self.assertEqual(runtime.search_calls, 1)
        self.assertEqual(seen, ((search.WorkVersionTarget(second), search.WorkVersionTarget(first)),
                                CompletionStop.ASSET))

    def test_batch_partial_failure_and_interruption_preserve_sanitized_shape(self) -> None:
        first = search.WorkVersionTarget("11111111-1111-4111-8111-111111111111")
        second = search.WorkVersionTarget("22222222-2222-4222-8222-222222222222")
        runtime = RuntimeFake()
        runtime.output = SimpleNamespace(results=(), failures=())
        runtime.target_ids = (first.work_version_id, second.work_version_id)
        result = BatchResult(BatchPolicy(), (
            BatchItemResult.failed(first, OutcomeReason.UNEXPECTED_FAILURE),
            BatchItemResult.interrupted(second),
        ))
        args = arguments("metadata")
        args.query = "ordinary query"
        output = io.StringIO()
        with mock.patch.object(search, "build_search_completion_runtime", return_value=runtime), \
                mock.patch.object(search, "run_completion_batch", return_value=result), \
                contextlib.redirect_stdout(output):
            code = search.run(args)
        payload = json.loads(output.getvalue())
        self.assertEqual(code, 130)
        self.assertEqual(payload["completion"]["failed"], 1)
        self.assertTrue(payload["completion"]["interrupted"])
        self.assertNotIn("secret", output.getvalue().lower())

    def test_runtime_exception_is_redacted_and_runtime_closes_once(self) -> None:
        runtime = RuntimeFake()
        error = io.StringIO()
        with mock.patch.object(search, "build_search_completion_runtime", return_value=runtime), \
                mock.patch.object(search, "run_completion_batch",
                                  side_effect=RuntimeError("token=TOPSECRET")), \
                contextlib.redirect_stderr(error):
            code = search.run(arguments("metadata"))
        self.assertEqual(code, 1)
        self.assertEqual(error.getvalue(), "sciretriever: error: metadata search failed\n")
        self.assertTrue(runtime.closed)

    def test_hard_keyboard_interrupt_returns_exact_130_payload(self) -> None:
        runtime = RuntimeFake()
        output = io.StringIO()
        with mock.patch.object(search, "build_search_completion_runtime", return_value=runtime), \
                mock.patch.object(search, "run_completion_batch", side_effect=KeyboardInterrupt), \
                contextlib.redirect_stdout(output):
            code = search.run(arguments("metadata"))
        payload = json.loads(output.getvalue())
        self.assertEqual(code, 130)
        self.assertEqual(payload, {"completion": {
            "items": [], "succeeded": 0, "failed": 0, "duplicates": 0,
            "interrupted": True,
        }, "optional_assets": []})

    def test_optional_assets_run_only_for_successful_resolved_ids(self) -> None:
        version = "11111111-1111-4111-8111-111111111111"
        target = DoiTarget("10.1234/example")
        calls = []
        class Pipeline:
            async def acquire_optional(self, request):
                calls.append(request)
                return SimpleNamespace(to_dict=lambda: {
                    "kind": request.kind.value, "work_version_id": request.target.work_version_id,
                })
        runtime = RuntimeFake()
        runtime.completion = SimpleNamespace(pipeline=Pipeline())
        batch = BatchResult(BatchPolicy(), (
            BatchItemResult.succeeded(target, version, CompletionStage.ASSET_PENDING),
            BatchItemResult.exhausted(DoiTarget("10.1234/missing")),
        ))
        args = arguments("metadata")
        args.xml = True
        args.html = True
        output = io.StringIO()
        with mock.patch.object(search, "build_search_completion_runtime", return_value=runtime), \
                mock.patch.object(search, "run_completion_batch", return_value=batch), \
                contextlib.redirect_stdout(output):
            code = search.run(args)
        payload = json.loads(output.getvalue())
        self.assertEqual(code, 0)
        self.assertEqual([item.kind.value for item in calls], ["xml", "html"])
        self.assertEqual(payload["optional_assets"], [
            {"kind": "xml", "work_version_id": version},
            {"kind": "html", "work_version_id": version},
        ])

    def test_retired_search_chain_has_closed_deletion_manifest(self) -> None:
        root = Path(search.__file__).parent
        sources = {name: (root / name).read_text(encoding="utf-8") for name in (
            "search.py", "completion_runtime.py", "search_completion_runtime.py",
            "acquisition_runtime.py", "analysis_runtime.py",
        )}
        retired = ("_download_args", "_analysis_args", "_acquisition_args",
                   "execute_work_versions", "build_search_completion_runtime as build",
                   "typing import Any", "cast(", "__import__(", "cli.download",
                   "cli.discover", "._forbidden", "._resolvers")
        for name, source in sources.items():
            with self.subTest(module=name):
                for value in retired:
                    self.assertNotIn(value, source)
        self.assertIn("from .search_completion_runtime import (",
                      sources["search.py"])
        self.assertIs(search.build_search_completion_runtime,
                      search_completion_runtime.build_search_completion_runtime)


if __name__ == "__main__":
    unittest.main()
