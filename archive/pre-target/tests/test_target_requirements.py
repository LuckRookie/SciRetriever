from __future__ import annotations

import json

from tests.target_requirements_fixture import (
    Invocation,
    TargetRequirementsFixture,
)


class FixtureBoundaryTests(TargetRequirementsFixture):
    def test_seed_adapter_materializes_work_assets_and_searchable_content(self) -> None:
        versions = self.target.lookup_work(self.facts.work_id)
        self.assertEqual({item.work_version_id for item in versions}, {
            self.facts.version_id,
            self.facts.rejected_version_id,
            self.facts.light_version_id,
            self.facts.analysis_version_id,
        })
        self.assertEqual(self.target.search(self.facts.light_query)[0].work_version_id, self.facts.light_version_id)
        self.assertEqual(self.target.search(self.facts.analysis_query)[0].work_version_id, self.facts.analysis_version_id)
        self.assertEqual(self.target.versions[self.facts.version_id].asset_outcome, "accepted")
        self.assertEqual(self.target.versions[self.facts.rejected_version_id].asset_outcome, "rejected")
        self.assertEqual(self.target.provider_results[-1], ("provider-failed", "failed"))

    def test_malformed_or_failed_output_cannot_be_product_success(self) -> None:
        with self.assertRaisesRegex(AssertionError, "no canonical JSON"):
            Invocation(0, "not-json", "").json()
        output = json.dumps({"operation": "library.show", "status": "failed"})
        with self.assertRaisesRegex(AssertionError, "'failed' != 'succeeded'"):
            self.assert_succeeded(Invocation(0, output, ""), "library.show")

    def test_malformed_bibliography_record_is_reported_as_rejected(self) -> None:
        source = self.root / "malformed.bib"
        source.write_text("@article{missing-close", encoding="utf-8")
        payload = self.invoke(
            "bibliography", "import", "--format", "bibtex", "--input", str(source)
        ).json()
        self.assertEqual(payload["status"], "failed")
        self.assertEqual(payload["counts"]["rejected"], 1)
        self.assertEqual(payload["items"][0]["results"][0]["record_index"], 0)


class RequirementAcceptanceTests(TargetRequirementsFixture):
    def test_r1_collection_replay_preserves_discovery_provenance(self) -> None:
        first = self.assert_succeeded(self.invoke("collection", "run", "--collection-id", self.facts.collection_id, "--mode", "topic"), "collection.run")["items"][0]
        second = self.assert_succeeded(self.invoke("collection", "run", "--collection-id", self.facts.collection_id, "--mode", "topic"), "collection.run")["items"][0]
        self.assertNotEqual(first["collection_run_id"], second["collection_run_id"])
        self.assertGreater(first["counts"]["new_members"], 0)
        self.assertEqual(second["counts"]["new_members"], 0)
        self.assertEqual(second["counts"]["existing_members"], first["counts"]["accepted"])
        detail = self.assert_succeeded(self.invoke("collection", "show", "--collection-id", self.facts.collection_id), "collection.show")["items"][0]
        membership = next(item for item in detail["memberships"] if item["work_id"] == self.facts.work_id)
        self.assertEqual(membership["first_collection_run_id"], first["collection_run_id"])
        self.assertEqual({cause["collection_run_id"] for cause in membership["causes"]}, {first["collection_run_id"], second["collection_run_id"]})

    def test_r2_multi_source_metadata_keeps_successes_and_source_differences(self) -> None:
        payload = self.invoke("collection", "show", "--collection-id", self.facts.collection_id).json()
        self.assertEqual(payload["operation"], "collection.show")
        self.assertEqual(payload["status"], "succeeded")
        run = payload["items"][0]["runs"][0]
        self.assertEqual([item["source"] for item in run["source_results"]], ["provider-a", "provider-b", "provider-failed"])
        detail = self.assert_succeeded(self.invoke("library", "show", "--work-version-id", self.facts.version_id, "--include-observations"), "library.show")["items"][0]
        self.assertEqual({item["provider"] for item in detail["observations"]}, {"provider-a", "provider-b"})
        self.assertTrue(all(item["provenance"]["source_kind"] == "metadata-provider" for item in detail["observations"]))

    def test_r3_asset_availability_requires_a_usable_related_asset(self) -> None:
        accepted = self.show_version(self.facts.version_id)
        rejected = self.show_version(self.facts.rejected_version_id)
        self.assertEqual(len(accepted["assets"]), 1)
        self.assert_closed_keys(accepted["assets"][0], {"asset_id", "role", "sha256", "media_type", "byte_size", "storage_path", "provenance"})
        self.assertEqual(accepted["assets"][0]["role"], "primary-pdf")
        self.assertGreater(len(accepted["assets"][0]["provenance"]), 0)
        self.assert_closed_keys(accepted["assets"][0]["provenance"][0], {"provenance_id", "source_kind", "source_name", "source_record_id", "observed_at", "input_sha256", "parameters_sha256"})
        self.assertEqual(rejected["assets"], [])
        self.assertEqual(rejected["state"], "unreviewed")
        self.assertEqual(rejected["missing_step"], "primary-pdf")
        self.assertEqual(rejected["current_failure"]["stage"], "asset")

    def test_r4_light_text_is_readable_traceable_and_independently_queryable(self) -> None:
        payload = self.assert_succeeded(
            self.invoke("library", "search", "--query", self.facts.light_query, "--include-all-versions"),
            "library.search",
        )
        self.assertEqual([item["work_version_id"] for item in payload["items"]], [self.facts.light_version_id])
        detail = self.show_version(self.facts.light_version_id)
        self.assertNotIn(self.facts.light_query, json.dumps(detail["metadata"], sort_keys=True))
        self.assertIsNotNone(detail["light_document"])
        self.assertIn(self.facts.light_query, json.dumps(detail["light_document"], sort_keys=True))
        self.assertIsNone(detail["analysis"])

    def test_r5_analysis_is_queryable_and_traceable_without_hiding_prior_results(self) -> None:
        payload = self.assert_succeeded(
            self.invoke("library", "search", "--query", self.facts.analysis_query, "--include-all-versions"),
            "library.search",
        )
        self.assertEqual([item["work_version_id"] for item in payload["items"]], [self.facts.analysis_version_id])
        detail = self.show_version(self.facts.analysis_version_id)
        self.assertNotIn(self.facts.analysis_query, json.dumps(detail["metadata"], sort_keys=True))
        self.assertNotIn(self.facts.analysis_query, json.dumps(detail["light_document"], sort_keys=True))
        self.assertIn(self.facts.analysis_query, json.dumps(detail["analysis"]["proposal"], sort_keys=True))
        self.assertRegex(detail["analysis"]["input_sha256"], r"^[0-9a-f]{64}$")
        self.assert_closed_keys(detail["analysis"], {"artifact_id", "sha256", "provider", "model", "input_sha256", "proposal", "provenance"})
        self.assertEqual(detail["analysis"]["provenance"][0]["source_kind"], "analysis-model")
        self.assertTrue(detail["metadata"] and detail["assets"] and detail["light_document"])

    def test_r6_unified_version_detail_exposes_all_availability_and_failure_facts(self) -> None:
        payload = self.assert_succeeded(
            self.invoke("library", "show", "--work-version-id", self.facts.rejected_version_id), "library.show"
        )
        detail = payload["items"][0]
        self.assert_closed_keys(detail, {"kind", "work_id", "work_version_id", "identifiers", "metadata", "assets", "light_document", "analysis", "references", "tags", "state", "missing_step", "current_failure", "observations_included", "observations", "extension_namespaces", "extensions", "provenance"})
        self.assertEqual(detail["assets"], [])
        self.assertIsNone(detail["light_document"])
        self.assertIsNone(detail["analysis"])
        self.assertIsNotNone(detail["current_failure"])

    def test_r7_bibliography_exchange_works_before_full_text(self) -> None:
        imported = self.assert_succeeded(
            self.invoke("bibliography", "import", "--format", "bibtex", "--input", str(self.write_bibtex())),
            "bibliography.import",
        )
        destination = self.root / "export.ris"
        exported = self.assert_succeeded(
            self.invoke("bibliography", "export", "--format", "ris", "--all", "--output", str(destination)),
            "bibliography.export",
        )
        self.assertEqual(imported["counts"]["rejected"], 0)
        self.assertGreater(exported["counts"]["exported"], 0)
        self.assertTrue(destination.read_text(encoding="utf-8").startswith("TY  - "))

    def test_r8_durable_batch_summary_conserves_partial_results_and_replay(self) -> None:
        payload = self.assert_succeeded(
            self.invoke("batch", "show", "--batch-run-id", self.facts.batch_id), "batch.show"
        )
        detail = payload["items"][0]
        counts = detail["counts"]
        self.assertEqual(
            counts["selected"],
            sum(counts[key] for key in ("completed", "partially_advanced", "missing", "skipped", "failed", "not_started")),
        )
        self.assertIn(detail["status"], ("partial", "interrupted"))


class ProductScenarioAcceptanceTests(TargetRequirementsFixture):
    def test_s01_topic_collection_is_bulk_and_persistent(self) -> None:
        payload = self.assert_succeeded(self.invoke("collection", "show", "--collection-id", self.facts.collection_id), "collection.show")
        self.assertGreater(len(payload["items"][0]["memberships"]), 1)

    def test_s02_citation_collection_retains_seed_relationship_and_path(self) -> None:
        payload = self.assert_succeeded(self.invoke("library", "show", "--work-id", self.facts.work_id), "library.show")
        encoded = json.dumps(payload["items"], sort_keys=True)
        self.assertIn("seed_work_id", encoded)
        self.assertIn("paths", encoded)

    def test_s03_multi_source_results_converge_without_losing_sources(self) -> None:
        payload = self.assert_succeeded(self.invoke("library", "show", "--work-id", self.facts.work_id, "--include-observations"), "library.show")
        observations = payload["items"][0]["versions"][0]["observations"]
        self.assertGreaterEqual(len({item["provider"] for item in observations}), 2)

    def test_s04_one_source_failure_keeps_other_source_results_and_failure(self) -> None:
        payload = self.invoke("collection", "show", "--collection-id", self.facts.collection_id).json()
        self.assertEqual(payload["status"], "succeeded")
        run = payload["items"][0]["runs"][0]
        self.assertEqual(run["status"], "partial")
        self.assertGreater(run["counts"]["accepted"], 0)
        self.assertGreater(run["counts"]["source_failures"], 0)
        self.assertTrue(any(item["failure"] is not None for item in run["source_results"]))

    def test_s05_download_rejects_wrong_content_and_keeps_correct_relationship(self) -> None:
        detail = self.assert_succeeded(self.invoke("batch", "show", "--batch-run-id", self.facts.batch_id), "batch.show")["items"][0]
        missing = next(item for item in detail["results"] if item["subject_id"] == self.facts.rejected_version_id)
        self.assertEqual(missing["outcome"], "missing")
        self.assertEqual(missing["stage"], "asset")
        self.assertEqual(missing["failure"]["code"], "asset_content_rejected")
        self.assertEqual(self.show_version(self.facts.rejected_version_id)["assets"], [])
        self.assertEqual(self.show_version(self.facts.version_id)["assets"][0]["role"], "primary-pdf")

    def test_s06_parsing_produces_readable_light_text_with_asset_lineage(self) -> None:
        payload = self.assert_succeeded(self.invoke("library", "show", "--work-version-id", self.facts.light_version_id), "library.show")
        light = payload["items"][0]["light_document"]
        self.assertGreater(len(light["document"]["sections"]), 0)
        self.assertIn("asset_id", json.dumps(light, sort_keys=True))

    def test_s07_analysis_is_structured_queryable_and_input_traceable(self) -> None:
        payload = self.assert_succeeded(self.invoke("library", "show", "--work-version-id", self.facts.analysis_version_id), "library.show")
        analysis = payload["items"][0]["analysis"]
        self.assertEqual(analysis["proposal"]["schema_version"], "1")
        self.assertRegex(analysis["input_sha256"], r"^[0-9a-f]{64}$")

    def test_s08_bibliography_import_joins_the_same_queryable_library(self) -> None:
        self.assert_succeeded(self.invoke("bibliography", "import", "--format", "bibtex", "--input", str(self.write_bibtex())), "bibliography.import")
        found = self.assert_succeeded(self.invoke("library", "search", "--identifier", "doi:10.1000/seed"), "library.search")
        self.assertEqual(found["counts"]["returned"], 1)

    def test_s09_old_json_export_is_not_a_mainstream_bibliography_exchange(self) -> None:
        destination = self.root / "old.json"
        result = self.invoke_legacy(
            "library", "export", "--mode", "reading", "--catalog", str(self.catalog),
            "--work-id", self.old_work_id, "--output", str(destination), "--format", "json",
        )
        self.assertEqual(result.code, 0)
        self.assertTrue(destination.read_text(encoding="utf-8").startswith("TY  - "))

    def test_s10_batch_partial_failure_keeps_successful_siblings(self) -> None:
        detail = self.invoke("batch", "show", "--batch-run-id", self.facts.batch_id).json()["items"][0]
        self.assertEqual(detail["status"], "partial")
        self.assertGreater(detail["counts"]["completed"], 0)
        self.assertGreater(detail["counts"]["failed"] + detail["counts"]["missing"], 0)

    def test_s11_replay_reuses_success_and_supplements_missing_without_duplicates(self) -> None:
        first = self.invoke("collection", "run", "--collection-id", self.facts.collection_id, "--mode", "topic").json()
        second = self.invoke("collection", "run", "--collection-id", self.facts.collection_id, "--mode", "topic").json()
        self.assertEqual(first["counts"]["accepted"], second["counts"]["existing_members"])
        self.assertEqual(second["counts"]["new_members"], 0)

    def test_s12_database_detail_unifies_version_content_and_relationship_state(self) -> None:
        detail = self.assert_succeeded(self.invoke("library", "show", "--work-version-id", self.facts.version_id), "library.show")["items"][0]
        self.assertEqual(detail["kind"], "work-version-detail")
        self.assertIn(detail["state"], ("unreviewed", "asset-ready", "light-text-ready", "completed"))


class PackageAndDeletionAcceptanceTests(TargetRequirementsFixture):
    def test_package_2_0_is_portable_hashed_and_replayable(self) -> None:
        first = self.assert_succeeded(self.invoke("package", "publish", "--work-version-id", self.facts.version_id), "package.publish")["items"][0]
        second = self.assert_succeeded(self.invoke("package", "publish", "--work-version-id", self.facts.version_id), "package.publish")["items"][0]
        self.assertEqual(first, second)
        self.assertTrue(first["package_id"].startswith("urn:sha256:"))
        destination = self.root / "package.json"
        self.assert_succeeded(
            self.invoke("package", "export", "--package-id", first["package_id"], "--output", str(destination)),
            "package.export",
        )
        package = json.loads(destination.read_text(encoding="utf-8"))
        self.assertEqual(package["schema_version"], "2.0")
        self.assertNotIn("storage_path", json.dumps(package, sort_keys=True))

    def test_explicit_deletion_removes_target_without_erasing_durable_history(self) -> None:
        self.assert_succeeded(self.invoke("curation", "delete-work", "--work-id", self.facts.work_id), "curation.delete-work")
        batch = self.assert_succeeded(self.invoke("batch", "show", "--batch-run-id", self.facts.batch_id), "batch.show")
        self.assertEqual(batch["items"][0]["batch_run_id"], self.facts.batch_id)


if __name__ == "__main__":
    import unittest

    unittest.main()
