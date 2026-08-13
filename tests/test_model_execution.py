from __future__ import annotations

import unittest

from pydantic import BaseModel, ValidationError

import sciretriever.model.execution as execution
from sciretriever.model.execution import (
    AllPendingSelector,
    BatchRequest,
    DiscoveryRunSelector,
    ImportReportSelector,
    LiteratureSelector,
    MetaLiteratureSelector,
    QuerySelector,
)
from sciretriever.model.library import LibraryQuery
from sciretriever.model.primitives import (
    DiscoveryRunId,
    LiteratureId,
    MetaLiteratureId,
)

_ID_1 = "123e4567-e89b-12d3-a456-426614174000"
_ID_2 = "223e4567-e89b-12d3-a456-426614174000"
_ID_3 = "323e4567-e89b-12d3-a456-426614174000"


class ExecutionModelTests(unittest.TestCase):
    def test_public_surface_is_only_the_process_local_contract(self) -> None:
        self.assertEqual(
            set(execution.__all__),
            {
                "AllPendingSelector",
                "BatchGoal",
                "BatchRequest",
                "BatchSelector",
                "DiscoveryRunSelector",
                "ImportReportSelector",
                "LiteratureSelector",
                "MetaLiteratureSelector",
                "QuerySelector",
            },
        )
        for old_name in (
            "CollectionSelector",
            "BatchRunId",
            "BatchRun",
            "BatchTarget",
            "BatchStatus",
            "TargetResult",
            "StateCounts",
            "selected_version_ids",
            "include_all_versions",
            "ImportRun",
        ):
            with self.subTest(old_name=old_name):
                self.assertFalse(hasattr(execution, old_name))

    def test_models_have_exact_fields_and_closed_strict_immutable_config(self) -> None:
        expected_fields = {
            AllPendingSelector: {"kind"},
            DiscoveryRunSelector: {"kind", "discovery_run_id"},
            ImportReportSelector: {"kind", "meta_literature_ids"},
            QuerySelector: {"kind", "query"},
            MetaLiteratureSelector: {"kind", "meta_literature_ids"},
            LiteratureSelector: {"kind", "literature_ids"},
            BatchRequest: {"selector", "goal"},
        }
        for model, fields in expected_fields.items():
            with self.subTest(model=model.__name__):
                self.assertTrue(issubclass(model, BaseModel))
                self.assertEqual(set(model.model_fields), fields)
                self.assertTrue(model.model_config.get("frozen"))
                self.assertTrue(model.model_config.get("strict"))
                self.assertEqual(model.model_config.get("extra"), "forbid")

    def test_all_selectors_form_batch_requests_and_round_trip(self) -> None:
        meta_one = MetaLiteratureId(_ID_1)
        meta_two = MetaLiteratureId(_ID_2)
        literature_one = LiteratureId(_ID_1)
        literature_two = LiteratureId(_ID_2)
        discovery_run_id = DiscoveryRunId(_ID_3)
        query = LibraryQuery(
            text="  methods ",
            keywords=("models", "methods"),
            discovery_run_ids=(discovery_run_id,),
        )
        selectors = (
            AllPendingSelector(kind="all-pending"),
            DiscoveryRunSelector(kind="discovery-run", discovery_run_id=discovery_run_id),
            ImportReportSelector(
                kind="import-report",
                meta_literature_ids=(meta_one, meta_two),
            ),
            QuerySelector(kind="query", query=query),
            MetaLiteratureSelector(
                kind="meta-literatures",
                meta_literature_ids=(meta_one, meta_two),
            ),
            LiteratureSelector(
                kind="literatures",
                literature_ids=(literature_one, literature_two),
            ),
        )

        for selector in selectors:
            with self.subTest(selector=type(selector).__name__):
                request = BatchRequest(selector=selector, goal="CONTENT_READY")
                self.assertEqual(set(request.model_dump()), {"selector", "goal"})
                encoded = request.model_dump_json()
                restored = BatchRequest.model_validate_json(encoded)
                self.assertEqual(restored, request)
                self.assertEqual(restored.model_dump_json(), encoded)

    def test_id_inputs_are_nonempty_deduplicated_and_keep_first_order(self) -> None:
        meta_one = MetaLiteratureId(_ID_1)
        meta_two = MetaLiteratureId(_ID_2)
        literature_one = LiteratureId(_ID_1)
        literature_two = LiteratureId(_ID_2)

        for selector_type, field_name, first, second in (
            (
                ImportReportSelector,
                "meta_literature_ids",
                meta_one,
                meta_two,
            ),
            (
                MetaLiteratureSelector,
                "meta_literature_ids",
                meta_one,
                meta_two,
            ),
            (
                LiteratureSelector,
                "literature_ids",
                literature_one,
                literature_two,
            ),
        ):
            with self.subTest(selector=selector_type.__name__):
                selector = selector_type.model_validate(
                    {
                        "kind": {
                            ImportReportSelector: "import-report",
                            MetaLiteratureSelector: "meta-literatures",
                            LiteratureSelector: "literatures",
                        }[selector_type],
                        field_name: [first, second, first, second],
                    }
                )
                self.assertEqual(getattr(selector, field_name), (first, second))

        for selector_type, field_name, kind in (
            (ImportReportSelector, "meta_literature_ids", "import-report"),
            (MetaLiteratureSelector, "meta_literature_ids", "meta-literatures"),
            (LiteratureSelector, "literature_ids", "literatures"),
        ):
            with self.subTest(empty_selector=selector_type.__name__):
                with self.assertRaises(ValidationError):
                    selector_type.model_validate({"kind": kind, field_name: ()})
                with self.assertRaises(ValidationError):
                    selector_type.model_validate({"kind": kind, field_name: []})

    def test_query_selector_requires_library_query_and_excludes_search_controls(self) -> None:
        query = LibraryQuery(text="methods")
        selector = QuerySelector(kind="query", query=query)
        self.assertIs(selector.query, query)

        # A Python mapping is not a QuerySelector contract.  JSON round-trip is
        # handled separately by Pydantic's JSON mode and still reconstructs the
        # closed LibraryQuery model.
        for value in (
            {"text": "methods"},
            {"sql": "select * from literature"},
            {"text": "methods", "sort": "relevance"},
            "select * from literature",
        ):
            with self.subTest(value=value), self.assertRaises(ValidationError):
                QuerySelector.model_validate({"kind": "query", "query": value})

        with self.assertRaises(ValidationError):
            QuerySelector.model_validate({"kind": "query", "query": query, "limit": 10})
        with self.assertRaises(ValidationError):
            QuerySelector.model_validate({"kind": "query", "query": query, "cursor": "opaque"})

    def test_each_selector_rejects_other_selector_fields_and_execution_options(self) -> None:
        selectors = (
            {"kind": "all-pending"},
            {
                "kind": "discovery-run",
                "discovery_run_id": DiscoveryRunId(_ID_1),
            },
            {
                "kind": "import-report",
                "meta_literature_ids": (MetaLiteratureId(_ID_1),),
            },
            {"kind": "query", "query": LibraryQuery(text="methods")},
            {
                "kind": "meta-literatures",
                "meta_literature_ids": (MetaLiteratureId(_ID_1),),
            },
            {
                "kind": "literatures",
                "literature_ids": (LiteratureId(_ID_1),),
            },
        )
        selector_types = (
            AllPendingSelector,
            DiscoveryRunSelector,
            ImportReportSelector,
            QuerySelector,
            MetaLiteratureSelector,
            LiteratureSelector,
        )
        for selector_type, values in zip(selector_types, selectors, strict=True):
            for extra_field, extra_value in (
                ("goal", "CONTENT_READY"),
                ("force", True),
                ("retry", True),
                ("provider", "crossref"),
                ("concurrency", 4),
                ("parser", "mineru"),
                ("llm", "model"),
                ("cursor", "opaque"),
                ("details", {}),
                ("include_all_versions", True),
                ("selected_version_ids", (LiteratureId(_ID_2),)),
            ):
                with self.subTest(selector=selector_type.__name__, extra_field=extra_field):
                    with self.assertRaises(ValidationError):
                        selector_type.model_validate({**values, extra_field: extra_value})

        with self.assertRaises(ValidationError):
            BatchRequest.model_validate(
                {
                    "selector": {"kind": "all-pending"},
                    "goal": "CONTENT_READY",
                    "details": {},
                }
            )
        with self.assertRaises(ValidationError):
            BatchRequest.model_validate(
                {
                    "selector": {"kind": "all-pending", "goal": "CONTENT_READY"},
                    "goal": "CONTENT_READY",
                }
            )

    def test_batch_request_and_selectors_are_immutable_and_goals_are_closed(self) -> None:
        request = BatchRequest(selector=AllPendingSelector(kind="all-pending"), goal="ASSET_READY")
        with self.assertRaises(ValidationError):
            request.goal = "CONTENT_READY"  # type: ignore[misc]
        with self.assertRaises(ValidationError):
            request.selector = AllPendingSelector(kind="all-pending")  # type: ignore[misc]
        with self.assertRaises(ValidationError):
            BatchRequest(
                selector=AllPendingSelector(kind="all-pending"),
                goal="asset-ready",  # type: ignore[arg-type]
            )
        with self.assertRaises(ValidationError):
            AllPendingSelector(kind="all-pending", unknown=True)  # type: ignore[call-arg]


if __name__ == "__main__":
    unittest.main()
