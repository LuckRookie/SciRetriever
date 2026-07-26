from completion_facts_fixture import *


class CompletionFactsWP5Tests(CompletionFactsFixture):
    def test_provider_metadata_with_stable_identifier_is_asset_pending(self) -> None:
        version = WorkRepository(self.catalog).ingest_metadata_batch(
            title="Provider title",
            identifiers_to_persist=(Identifier("doi", "10.1234/wp5"),),
            observations=(MetadataIngestionObservation(
                "fixture",
                "record-1",
                (("title", "Provider title"),),
                (("provider", "fixture"),),
            ),),
            provider_precedence=("fixture",),
        )

        facts = self.repository.get(version.id)

        self.assertEqual(facts.stage, CompletionStage.ASSET_PENDING)
        self.assertTrue(facts.metadata_ready)
        self.assertFalse(facts.primary_pdf_ready)
        self.assertFalse(facts.analysis_ready)

    def test_provisional_provider_title_is_asset_pending(self) -> None:
        work_version_id = self.ingest(title="Provider-derived provisional", doi=None)
        self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.ASSET_PENDING)

    def test_stale_projection_with_unrelated_acquisition_observation_is_metadata_pending(self) -> None:
        work_version_id = self.ingest(title="Original provider title")
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "UPDATE provider_canonical_projections SET value_json = ? "
                "WHERE work_version_id = ? AND field_name = 'title'",
                (json.dumps("Stale projected title"), work_version_id),
            )
            connection.exec_driver_sql(
                "DELETE FROM metadata_observations WHERE work_version_id = ?", (work_version_id,)
            )
            connection.exec_driver_sql(
                "INSERT INTO metadata_observations "
                "(id, work_version_id, provider, provider_record_id, field_name, value_json, provenance_json) "
                "VALUES (?, ?, 'acquisition', 'unrelated', 'language', ?, '{}')",
                (str(uuid4()), work_version_id, json.dumps("en")),
            )
        self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.METADATA_PENDING)

    def test_identity_manual_and_projection_without_observation_are_metadata_pending(self) -> None:
        identity_only = IdentityResolver(self.catalog).create_or_reuse_work(
            {"doi": "10.1234/identity-only"}).work_version.id
        manual_only = IdentityResolver(self.catalog).create_or_reuse_work(
            {"doi": "10.1234/manual-only"}).work_version.id
        from manual_curation_fixture import set_manual_metadata
        set_manual_metadata(self.catalog, manual_only, "title", "Manual title")
        projection_only = IdentityResolver(self.catalog).create_or_reuse_work(
            {"doi": "10.1234/projection-only"}).work_version.id
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "DELETE FROM metadata_observations WHERE work_version_id = ?", (projection_only,)
            )
        for work_version_id in (identity_only, manual_only, projection_only):
            with self.subTest(work_version_id=work_version_id):
                self.assertEqual(
                    self.repository.get(work_version_id).stage,
                    CompletionStage.METADATA_PENDING,
                )

    def test_required_pdf_cardinality_ignores_supplementary_assets(self) -> None:
        work_version_id = self.ingest()
        self.attach(work_version_id, role="supplementary_pdf", media_type="application/xml", format_name="xml")
        self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.ASSET_PENDING)
        self.attach(work_version_id)
        self.attach(work_version_id, role="supplementary_pdf")
        self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.ANALYSIS_PENDING)

    def test_primary_relation_requires_pdf_media_type_and_format_and_exactly_one(self) -> None:
        work_version_id = self.ingest()
        self.attach(work_version_id, media_type="application/xml", format_name="xml")
        self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.ASSET_PENDING)
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "DELETE FROM work_version_assets WHERE work_version_id = ?", (work_version_id,)
            )
        self.attach(work_version_id)
        self.attach(work_version_id)
        self.assertEqual(self.repository.get(work_version_id).stage, CompletionStage.ASSET_PENDING)

    def test_aligned_promotion_with_empty_references_and_tags_is_complete(self) -> None:
        work_version_id, _, _ = self.complete()
        facts = self.repository.get(work_version_id)
        self.assertEqual(facts.stage, CompletionStage.COMPLETE)
        self.assertTrue(facts.analysis_ready)
        with self.catalog.connect() as connection:
            content = json.loads(connection.exec_driver_sql(
                "SELECT content_json FROM current_analyses WHERE work_version_id = ?",
                (work_version_id,),
            ).scalar_one())
        self.assertEqual((content["references"], content["generated_tags"]), ([], []))
