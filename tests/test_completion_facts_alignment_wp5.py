from completion_facts_fixture import *


class CompletionFactsAlignmentTests(CompletionFactsFixture):
    def test_duplicate_reference_identity_is_analysis_pending(self) -> None:
        work_version_id, _, _ = self.complete()
        with self.catalog.connect() as connection:
            content = json.loads(connection.exec_driver_sql(
                "SELECT content_json FROM current_analyses WHERE work_version_id = ?", (work_version_id,)
            ).scalar_one())
        reference_id = str(uuid4())
        reference = {
            "reference_id": reference_id,
            "order": 0,
            "raw_reference": "Duplicate reference",
            "resolved_work_id": None,
            "identifier_namespace": None,
            "identifier_value": None,
            "evidence_ids": [],
            "locators": [],
        }
        content["references"] = [reference, dict(reference)]
        analysis_id = self.replace_current_content(work_version_id, content)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO version_references "
                "(id, citing_work_version_id, reference_order, raw_reference, source_artifact_id, locator_json) "
                "VALUES (?, ?, 0, 'Duplicate reference', ?, '[]')",
                (reference_id, work_version_id, analysis_id),
            )
        self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.ANALYSIS_PENDING)

    def test_duplicate_generated_tag_identity_is_analysis_pending(self) -> None:
        work_version_id, _, _ = self.complete()
        tag_id = TagRepository(self.catalog).add("duplicate-tag").id
        with self.catalog.connect() as connection:
            content = json.loads(connection.exec_driver_sql(
                "SELECT content_json FROM current_analyses WHERE work_version_id = ?", (work_version_id,)
            ).scalar_one())
        tag = {"tag_id": tag_id, "evidence_ids": [], "locators": []}
        content["generated_tags"] = [tag, dict(tag)]
        analysis_id = self.replace_current_content(work_version_id, content)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO generated_work_version_tags (work_version_id, tag_id, source_artifact_id) "
                "VALUES (?, ?, ?)",
                (work_version_id, tag_id, analysis_id),
            )
        self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.ANALYSIS_PENDING)

    def test_stale_pdf_and_artifact_lineage_are_analysis_pending(self) -> None:
        for mutation in ("pdf_hash", "analysis_raw_asset"):
            with self.subTest(mutation=mutation):
                work_version_id, raw_id, _ = self.complete()
                other_id = self.attach(work_version_id, role="supplementary_pdf") if mutation == "analysis_raw_asset" else None
                with self.catalog.transaction() as connection:
                    if mutation == "pdf_hash":
                        source_id = connection.exec_driver_sql(
                            "SELECT input_artifact_id FROM processing_runs WHERE work_version_id = ? AND stage = 'analysis'",
                            (work_version_id,),
                        ).scalar_one()
                        provenance = json.loads(connection.exec_driver_sql(
                            "SELECT provenance_json FROM normalized_artifacts WHERE id = ?", (source_id,)
                        ).scalar_one())
                        provenance["input_raw_asset_sha256"] = "f" * 64
                        connection.exec_driver_sql(
                            "UPDATE normalized_artifacts SET provenance_json = ? WHERE id = ?",
                            (json.dumps(provenance, sort_keys=True, separators=(",", ":")), source_id),
                        )
                    else:
                        connection.exec_driver_sql(
                            "UPDATE normalized_artifacts SET raw_asset_id = ? "
                            "WHERE id = (SELECT analysis_artifact_id FROM current_analyses WHERE work_version_id = ?)",
                            (other_id, work_version_id),
                        )
                self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.ANALYSIS_PENDING)

    def test_stale_generated_source_payload_and_canonical_projection_are_analysis_pending(self) -> None:
        for mutation in ("generated_source", "payload", "canonical"):
            with self.subTest(mutation=mutation):
                work_version_id, _, _ = self.complete()
                with self.catalog.transaction() as connection:
                    if mutation == "generated_source":
                        parser_id = connection.exec_driver_sql(
                            "SELECT parser_artifact_id FROM current_analyses WHERE work_version_id = ?",
                            (work_version_id,),
                        ).scalar_one()
                        connection.exec_driver_sql(
                            "UPDATE generated_work_version_metadata SET source_artifact_id = ? WHERE work_version_id = ?",
                            (parser_id, work_version_id),
                        )
                    elif mutation == "payload":
                        content = json.loads(connection.exec_driver_sql(
                            "SELECT content_json FROM current_analyses WHERE work_version_id = ?",
                            (work_version_id,),
                        ).scalar_one())
                        content["canonical_fields"] = []
                        connection.exec_driver_sql(
                            "UPDATE current_analyses SET content_json = ? WHERE work_version_id = ?",
                            (json.dumps(content, sort_keys=True, separators=(",", ":")), work_version_id),
                        )
                    else:
                        connection.exec_driver_sql(
                            "UPDATE work_versions SET language = 'fr' WHERE id = ?", (work_version_id,)
                        )
                self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.ANALYSIS_PENDING)

    def test_manual_override_and_provider_fallback_follow_canonical_precedence(self) -> None:
        work_version_id, _, _ = self.complete()
        from manual_curation_fixture import clear_manual_metadata, set_manual_metadata
        set_manual_metadata(self.catalog, work_version_id, "language", "fr")
        facts = self.repository.get(work_version_id)
        self.assertEqual(facts.stage, CompletionStage.COMPLETE)
        clear_manual_metadata(self.catalog, work_version_id, "language")
        self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.COMPLETE)


if __name__ == "__main__":
    import unittest
    unittest.main()
