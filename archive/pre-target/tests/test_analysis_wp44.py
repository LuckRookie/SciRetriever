from __future__ import annotations

from io import BytesIO
import json
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
from uuid import uuid4

REPOSITORY = Path(__file__).resolve().parents[1]
SRC = REPOSITORY / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from sciretriever.analysis import AnalysisProviderRequest, AnalysisProviderResponse, AnalysisService, OpenAICompatibleAnalysisProvider, SECTION_IDS, analysis_response_schema
from sciretriever.catalog import IdentityResolver, LibraryReadRepository, MetadataIngestionObservation, RegistryRepository, TagRepository, WorkRepository, WorkVersionAnalysisRepository, create_catalog_engine, initialize_catalog
from sciretriever.catalog.manual_metadata_curation import ManualMetadataCurationConflictError, ManualMetadataSetHandler
from manual_curation_fixture import add_manual_tag, clear_manual_metadata, set_manual_metadata
from sciretriever.core.contracts import Identifier
from sciretriever.core.derivation import stable_derivation_id
from sciretriever.config import MinerUConfig
from sciretriever.errors import AnalysisError, CatalogError, PackagingError
from sciretriever.normalization import MinerUParsingService, MinerUSourceMapService
from sciretriever.packaging import PackagePipeline
from sciretriever.storage import DerivedArtifactStore, RawAssetStore

from test_mineru_wp43 import CompletedClient, archive_bytes, middle_value, pdf_bytes


class FixtureProvider:
    provider_name = "fixture"

    def __init__(self, model: str = "fixture-v1", *, mutate=None, response_provider: str | None = None,
                 response_model: str | None = None) -> None:
        self.model = model
        self.calls = 0
        self.mutate = mutate
        self.response_provider = response_provider
        self.response_model = response_model

    def analyze(self, request: AnalysisProviderRequest) -> AnalysisProviderResponse:
        self.calls += 1
        source = json.loads(request.input_json)
        evidence = source["source_units"][0]["evidence_id"]
        sections = [{"section_id": section_id, "heading": f"中文标题 {index}",
                     "content": "证据不足" if index == 9 else f"原文内容 {index}",
                     "insufficient_evidence": index == 9,
                     "evidence_ids": [evidence]}
                    for index, section_id in enumerate(SECTION_IDS)]
        value = {"sections": sections,
                 "canonical_fields": [{"field_name": "abstract", "value": "原文摘要", "evidence_ids": [evidence]}],
                 "references": [], "generated_tags": [], "new_tag_proposals": [], "new_entity_proposals": []}
        if self.mutate is not None:
            self.mutate(value, source)
        return AnalysisProviderResponse(json.dumps(value, ensure_ascii=False), self.response_provider or self.provider_name,
                                        self.response_model or self.model)


class AnalysisWP44Tests(TestCase):
    def setUp(self) -> None:
        self.temporary = TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        root = Path(self.temporary.name)
        self.catalog = create_catalog_engine(root / "catalog.sqlite")
        self.addCleanup(self.catalog.dispose)
        initialize_catalog(self.catalog)
        self.work_version_id = IdentityResolver(self.catalog).create_or_reuse_work({"doi": "10.1/wp44"}).work_version.id
        storage = root / "storage"
        storage.mkdir()
        self.raw_store = RawAssetStore(storage)
        self.derived_store = DerivedArtifactStore(storage)
        self.pdf = pdf_bytes()
        staged = self.raw_store.stage(BytesIO(self.pdf), intent_id=str(uuid4()))
        published = self.raw_store.publish(staged)
        self.raw_store.remove_staged(staged)
        self.raw_id = str(uuid4())
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql(
                "INSERT INTO raw_assets (id, sha256, storage_path, media_type, format, byte_size, provenance_json) VALUES (?, ?, ?, ?, ?, ?, '{}')",
                (self.raw_id, published.sha256, published.storage_path, "application/pdf", "pdf", published.byte_size),
            )
            connection.exec_driver_sql(
                "INSERT INTO work_version_assets (work_version_id, raw_asset_id, asset_role) VALUES (?, ?, 'primary_pdf')",
                (self.work_version_id, self.raw_id),
            )
        parsed = MinerUParsingService(
            self.catalog, self.derived_store, MinerUConfig(model="operator/model@fixture", poll_interval=0.01),
            CompletedClient(archive_bytes(middle_value())), sleep=lambda _: None,
        ).run(self.work_version_id, self.raw_id, self.pdf)
        self.source = MinerUSourceMapService(self.catalog, self.raw_store, self.derived_store).run(self.work_version_id, parsed)

    def service(self, provider: FixtureProvider) -> AnalysisService:
        return AnalysisService(self.catalog, self.derived_store, provider, configuration={"profile": provider.model})

    def ingest_provider(self, *, language: str, abstract: str = "Provider abstract", record_id: str = "provider-record") -> None:
        WorkRepository(self.catalog).ingest_metadata_batch(
            title="Untitled",
            identifiers_to_persist=(Identifier("doi", "10.1/wp44"),),
            observations=(MetadataIngestionObservation("fixture", record_id,
                (("title", "Provider title"), ("language", language), ("abstract", abstract)), (("provider", "fixture"),)),),
            provider_precedence=("fixture",),
        )

    def projection_state(self) -> tuple[object, ...]:
        with self.catalog.connect() as connection:
            canonical = connection.exec_driver_sql("SELECT abstract, language FROM work_versions WHERE id = ?", (self.work_version_id,)).one()
            references = tuple(connection.exec_driver_sql(
                "SELECT raw_reference, locator_json, source_artifact_id FROM version_references WHERE citing_work_version_id = ? ORDER BY reference_order",
                (self.work_version_id,)).all())
            generated = tuple(connection.exec_driver_sql(
                "SELECT tag_id, source_artifact_id FROM generated_work_version_tags WHERE work_version_id = ? ORDER BY tag_id",
                (self.work_version_id,)).all())
            current = connection.exec_driver_sql(
                "SELECT id, revision, content_json FROM current_analyses WHERE work_version_id = ?", (self.work_version_id,)).one_or_none()
        return canonical, references, generated, current

    def test_pdf_only_success_exact_sections_language_and_immutable_replay(self) -> None:
        provider = FixtureProvider()
        service = self.service(provider)
        first = service.run(self.work_version_id, self.source)
        self.assertEqual(tuple(item.section_id for item in first.document.sections), SECTION_IDS)
        self.assertTrue(all(item.heading.startswith("中文标题") for item in first.document.sections))
        self.assertEqual(first.document.sections[-1].evidence_ids, first.document.sections[0].evidence_ids)
        self.assertTrue(first.document.evidence)
        current = service.current.get(self.work_version_id)
        self.assertIsNotNone(current)
        if current is None:
            self.fail("current analysis is missing")
        current_content = json.loads(current.content_json)
        self.assertEqual(current_content["sections"][0]["locators"], current_content["evidence"])
        self.assertEqual(current_content["evidence"][0], self.source.source_map.evidence[0].to_dict())
        with patch.object(provider, "analyze", side_effect=AssertionError("provider invoked during replay")):
            replay = service.run(self.work_version_id, self.source, expected_current_id=current.id, expected_revision=current.revision)
        self.assertEqual((first.artifact.id, replay.artifact.id, provider.calls), (first.artifact.id, first.artifact.id, 1))
        self.assertEqual(service.current.get(self.work_version_id), current)

    def test_openai_adapter_uses_strict_bounded_chat_completions_and_redacts_errors(self) -> None:
        request = AnalysisProviderRequest("system", "{}", {"type": "object"}, 123)
        with patch("sciretriever.analysis.provider.import_module") as importer:
            constructor = importer.return_value.OpenAI
            client = constructor.return_value
            client.chat.completions.create.return_value.choices = [type("Choice", (), {"message": type("Message", (), {"content": "{}"})()})()]
            client.chat.completions.create.return_value.model = "model"
            provider = OpenAICompatibleAnalysisProvider(api_key="secret-value", base_url="https://llm.invalid/v1", model="model", timeout=9)
            response = provider.analyze(request)
        constructor.assert_called_once_with(api_key="secret-value", base_url="https://llm.invalid/v1", timeout=9.0, max_retries=0)
        call = client.chat.completions.create.call_args.kwargs
        self.assertEqual((call["temperature"], call["max_completion_tokens"]), (0, 123))
        self.assertTrue(call["response_format"]["json_schema"]["strict"])
        self.assertEqual(response.content, "{}")

        with patch("sciretriever.analysis.provider.import_module") as importer:
            client = importer.return_value.OpenAI.return_value
            client.chat.completions.create.return_value.choices = [type(
                "Choice",
                (),
                {"message": type("Message", (), {"content": "x" * 1969})()},
            )()]
            client.chat.completions.create.return_value.model = "model"
            bounded = OpenAICompatibleAnalysisProvider(
                api_key="secret-value",
                base_url="https://llm.invalid/v1",
                model="model",
                timeout=9,
            )
            with self.assertRaisesRegex(AnalysisError, "character bound"):
                bounded.analyze(request)

        with patch("sciretriever.analysis.provider.import_module") as importer:
            constructor = importer.return_value.OpenAI
            constructor.return_value.chat.completions.create.side_effect = RuntimeError("secret-value Authorization")
            provider = OpenAICompatibleAnalysisProvider(api_key="secret-value", base_url="https://llm.invalid/v1", model="model", timeout=9)
            with self.assertRaises(AnalysisError) as captured:
                provider.analyze(request)
        self.assertNotIn("secret-value", str(captured.exception))
        self.assertNotIn("Authorization", str(captured.exception))

    def test_analysis_rejects_evidence_omitted_from_bounded_prompt(self) -> None:
        excluded = self.source.source_map.evidence[1].evidence_id

        def cite_excluded(value, source):
            self.assertEqual(len(source["source_units"]), 1)
            for section in value["sections"]:
                section["evidence_ids"] = [excluded]
            value["canonical_fields"][0]["evidence_ids"] = [excluded]

        service = AnalysisService(
            self.catalog,
            self.derived_store,
            FixtureProvider(mutate=cite_excluded),
            max_source_units=1,
        )
        with self.assertRaisesRegex(AnalysisError, "outside the validated primary PDF"):
            service.run(self.work_version_id, self.source)

    def test_library_search_indexes_only_promoted_section_content(self) -> None:
        def add_reference(value, source):
            evidence = source["source_units"][0]["evidence_id"]
            value["references"] = [{
                "order": 0,
                "raw_reference": "backend-only-needle",
                "resolved_work_id": None,
                "identifier_namespace": None,
                "identifier_value": None,
                "evidence_ids": [evidence],
            }]

        self.service(FixtureProvider(mutate=add_reference)).run(
            self.work_version_id, self.source
        )
        library = LibraryReadRepository(self.catalog)
        self.assertEqual(len(library.search("原文内容").items), 1)
        self.assertEqual(library.search("backend-only-needle").items, ())

    def test_xml_html_only_is_blocked(self) -> None:
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE work_version_assets SET asset_role = 'xml' WHERE work_version_id = ?", (self.work_version_id,))
        with self.assertRaisesRegex(AnalysisError, "primary-PDF"):
            self.service(FixtureProvider()).run(self.work_version_id, self.source)

    def test_unknown_fields_malformed_and_tampered_evidence_are_rejected_and_run_failed(self) -> None:
        def unknown(value, source):
            value["unknown"] = True
        with self.assertRaisesRegex(AnalysisError, "unknown fields"):
            self.service(FixtureProvider(mutate=unknown)).run(self.work_version_id, self.source)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT state FROM processing_runs WHERE stage = 'analysis'").scalar_one(), "failed")
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM current_analyses").scalar_one(), 0)

        def tampered(value, source):
            value["sections"][0]["evidence_ids"] = [str(uuid4())]
        with self.assertRaisesRegex(AnalysisError, "outside the validated primary PDF"):
            self.service(FixtureProvider("fixture-v2", mutate=tampered)).run(self.work_version_id, self.source)

    def test_registry_constraints_and_resolved_identifier_validation(self) -> None:
        tag = TagRepository(self.catalog).add("chemistry")
        publisher = RegistryRepository(self.catalog).add("publisher", "Publisher")
        venue = RegistryRepository(self.catalog).add("venue", "Venue")

        def accepted(value, source):
            evidence = source["source_units"][0]["evidence_id"]
            value["generated_tags"] = [{"tag_id": tag.id, "evidence_ids": [evidence]}]
            value["canonical_fields"].extend([
                {"field_name": "publisher_id", "value": publisher.id, "evidence_ids": [evidence]},
                {"field_name": "venue_id", "value": venue.id, "evidence_ids": [evidence]},
            ])
        result = self.service(FixtureProvider(mutate=accepted)).run(self.work_version_id, self.source)
        self.assertEqual(result.document.generated_tags[0].tag_id, tag.id)

        def unknown_tag(value, source):
            evidence = source["source_units"][0]["evidence_id"]
            value["generated_tags"] = [{"tag_id": str(uuid4()), "evidence_ids": [evidence]}]
        with self.assertRaisesRegex(AnalysisError, "unknown tag"):
            current = self.service(FixtureProvider()).current.get(self.work_version_id)
            self.assertIsNotNone(current)
            if current is None:
                self.fail("current analysis is missing")
            self.service(FixtureProvider("fixture-v2", mutate=unknown_tag)).run(self.work_version_id, self.source,
                expected_current_id=current.id, expected_revision=current.revision, force=True)

    def test_reference_id_is_internal_deterministic_and_identifier_is_normalized(self) -> None:
        def reference(value, source):
            evidence = source["source_units"][0]["evidence_id"]
            value["references"] = [{"order": 2, "raw_reference": "  Example   reference  ",
                "resolved_work_id": None, "identifier_namespace": "DOI",
                "identifier_value": "https://doi.org/10.1234/ABC", "evidence_ids": [evidence]}]
        result = self.service(FixtureProvider(mutate=reference)).run(self.work_version_id, self.source)
        parsed = result.document.references[0]
        expected = stable_derivation_id("analysis_reference", {"source_map_artifact_id": self.source.artifact.id,
            "order": 2, "raw_reference": "Example reference", "identifier": {"namespace": "doi", "value": "10.1234/abc"},
            "evidence_ids": sorted(parsed.evidence_ids)})
        self.assertEqual((parsed.reference_id, parsed.identifier_namespace, parsed.identifier_value),
                         (expected, "doi", "10.1234/abc"))
        schema = analysis_response_schema()
        properties = schema["properties"]
        if not isinstance(properties, dict) or not isinstance(properties.get("references"), dict):
            self.fail("analysis schema references are missing")
        references_schema = properties["references"]
        items_schema = references_schema.get("items")
        if not isinstance(items_schema, dict) or not isinstance(items_schema.get("properties"), dict):
            self.fail("analysis reference schema properties are missing")
        reference_properties = items_schema["properties"]
        self.assertNotIn("reference_id", reference_properties)
        with self.catalog.connect() as connection:
            stored = connection.exec_driver_sql("SELECT id, cited_namespace, cited_value FROM version_references").one()
        self.assertEqual(stored, (expected, "doi", "10.1234/abc"))
        current = self.service(FixtureProvider()).current.get(self.work_version_id)
        self.assertIsNotNone(current)
        if current is None:
            self.fail("current analysis is missing")
        provider = FixtureProvider(mutate=reference)
        with patch.object(provider, "analyze", side_effect=AssertionError("provider invoked during reference replay")):
            replay = self.service(provider).run(self.work_version_id, self.source,
                expected_current_id=current.id, expected_revision=current.revision)
        self.assertEqual(replay.document.references[0].reference_id, expected)

    def test_malformed_unresolved_reference_identifier_is_rejected(self) -> None:
        def malformed(value, source):
            evidence = source["source_units"][0]["evidence_id"]
            value["references"] = [{"order": 0, "raw_reference": "Malformed DOI", "resolved_work_id": None,
                "identifier_namespace": "doi", "identifier_value": "not-a-doi", "evidence_ids": [evidence]}]
        with self.assertRaisesRegex(AnalysisError, "malformed doi"):
            self.service(FixtureProvider(mutate=malformed)).run(self.work_version_id, self.source)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM current_analyses").scalar_one(), 0)

    def test_provider_response_identity_must_match_configuration(self) -> None:
        for index, provider in enumerate((FixtureProvider(response_provider="other"), FixtureProvider("fixture-v2", response_model="other"))):
            with self.subTest(case=index), self.assertRaisesRegex(AnalysisError, "identity"):
                self.service(provider).run(self.work_version_id, self.source)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM current_analyses").scalar_one(), 0)

    def test_second_analysis_replaces_generated_state_and_preserves_manual_provider_and_raw_state(self) -> None:
        self.ingest_provider(language="en")
        tag_one = TagRepository(self.catalog).add("one")
        tag_two = TagRepository(self.catalog).add("two")
        manual_tag = TagRepository(self.catalog).add("manual")
        with self.catalog.connect() as connection:
            work_id = connection.exec_driver_sql("SELECT work_id FROM work_versions WHERE id = ?", (self.work_version_id,)).scalar_one()
        add_manual_tag(self.catalog, work_id, manual_tag.id)
        def first_output(value, source):
            evidence = source["source_units"][0]["evidence_id"]
            value["generated_tags"] = [{"tag_id": tag_one.id, "evidence_ids": [evidence]}]
            value["canonical_fields"].append({"field_name": "language", "value": "zh", "evidence_ids": [evidence]})
            value["references"] = [{"order": 0, "raw_reference": "Unresolved A",
                                    "resolved_work_id": None, "identifier_namespace": None, "identifier_value": None,
                                    "evidence_ids": [evidence]}]
        first_service = self.service(FixtureProvider(mutate=first_output))
        first_service.run(self.work_version_id, self.source)
        current = first_service.current.get(self.work_version_id)
        self.assertIsNotNone(current)
        if current is None:
            self.fail("current analysis is missing")
        set_manual_metadata(self.catalog, self.work_version_id, "abstract", "人工摘要")
        with self.catalog.connect() as connection:
            observation_count = connection.exec_driver_sql("SELECT count(*) FROM metadata_observations").scalar_one()
        def second_output(value, source):
            evidence = source["source_units"][0]["evidence_id"]
            value["canonical_fields"] = []
            value["generated_tags"] = [{"tag_id": tag_two.id, "evidence_ids": [evidence]}]
        second_service = self.service(FixtureProvider("fixture-v2", mutate=second_output))
        second_service.run(self.work_version_id, self.source, expected_current_id=current.id, expected_revision=current.revision, force=True)
        with self.catalog.connect() as connection:
            row = connection.exec_driver_sql("SELECT abstract, language FROM work_versions WHERE id = ?", (self.work_version_id,)).one()
            generated = connection.exec_driver_sql("SELECT tag_id FROM generated_work_version_tags WHERE work_version_id = ?", (self.work_version_id,)).scalars().all()
            references = connection.exec_driver_sql("SELECT count(*) FROM version_references WHERE citing_work_version_id = ?", (self.work_version_id,)).scalar_one()
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM current_analyses WHERE work_version_id = ?", (self.work_version_id,)).scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql(
                "SELECT count(*) FROM normalized_artifacts WHERE kind = 'analysis'"
            ).scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql(
                "SELECT count(*) FROM processing_runs WHERE stage = 'analysis' AND state = 'succeeded'"
            ).scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM raw_assets").scalar_one(), 1)
            self.assertGreater(connection.exec_driver_sql("SELECT count(*) FROM normalized_artifacts WHERE kind LIKE 'mineru%'").scalar_one(), 1)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM metadata_observations").scalar_one(), observation_count)
            self.assertEqual(connection.exec_driver_sql("SELECT count(*) FROM manual_work_tags WHERE work_id = ? AND tag_id = ?", (work_id, manual_tag.id)).scalar_one(), 1)
        self.assertEqual(row, ("人工摘要", "en"))
        self.assertEqual(generated, [tag_two.id])
        self.assertEqual(references, 0)

    def test_metadata_ingestion_after_analysis_does_not_clobber_generated_or_manual_fields(self) -> None:
        self.ingest_provider(language="en", abstract="Provider one")
        service = self.service(FixtureProvider())
        service.run(self.work_version_id, self.source)
        set_manual_metadata(self.catalog, self.work_version_id, "language", "fr")
        self.ingest_provider(language="de", abstract="Provider two", record_id="later-record")
        with self.catalog.connect() as connection:
            row = connection.exec_driver_sql("SELECT abstract, language FROM work_versions WHERE id = ?", (self.work_version_id,)).one()
        self.assertEqual(row, ("原文摘要", "fr"))
        clear_manual_metadata(self.catalog, self.work_version_id, "language")
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("SELECT language FROM work_versions WHERE id = ?", (self.work_version_id,)).scalar_one(), "de")

    def test_failed_reanalysis_preserves_complete_old_current_and_projections(self) -> None:
        tag = TagRepository(self.catalog).add("kept")
        manual_tag = TagRepository(self.catalog).add("manual-kept")
        with self.catalog.connect() as connection:
            work_id = connection.exec_driver_sql("SELECT work_id FROM work_versions WHERE id = ?", (self.work_version_id,)).scalar_one()
        add_manual_tag(self.catalog, work_id, manual_tag.id)
        def first_output(value, source):
            evidence = source["source_units"][0]["evidence_id"]
            value["generated_tags"] = [{"tag_id": tag.id, "evidence_ids": [evidence]}]
            value["references"] = [{"order": 0, "raw_reference": "Kept reference",
                "resolved_work_id": None, "identifier_namespace": None, "identifier_value": None, "evidence_ids": [evidence]}]
        service = self.service(FixtureProvider(mutate=first_output))
        service.run(self.work_version_id, self.source)
        before = self.projection_state()
        with self.catalog.connect() as connection:
            locator_json = connection.exec_driver_sql(
                "SELECT locator_json FROM version_references WHERE citing_work_version_id = ?", (self.work_version_id,)).scalar_one()
        locator_list = json.loads(locator_json)
        self.assertEqual(locator_list[0], self.source.source_map.evidence[0].to_dict())
        current = service.current.get(self.work_version_id)
        self.assertIsNotNone(current)
        if current is None:
            self.fail("current analysis is missing")
        def malformed(value, source):
            value["sections"][0]["evidence_ids"] = []
        with self.assertRaises(AnalysisError):
            self.service(FixtureProvider("fixture-v2", mutate=malformed)).run(
                self.work_version_id, self.source, expected_current_id=current.id, expected_revision=current.revision, force=True)
        self.assertEqual(self.projection_state(), before)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql(
                "SELECT count(*) FROM manual_work_tags WHERE work_id = ? AND tag_id = ?", (work_id, manual_tag.id)).scalar_one(), 1)

    def test_failed_force_retry_converges_on_one_next_revision_identity(self) -> None:
        service = self.service(FixtureProvider())
        service.run(self.work_version_id, self.source)
        current = service.current.get(self.work_version_id)
        self.assertIsNotNone(current)
        if current is None:
            self.fail("current analysis is missing")
        def malformed(value, source):
            value["sections"][0]["evidence_ids"] = []
        failed = self.service(FixtureProvider("fixture-v2", mutate=malformed))
        with self.assertRaises(AnalysisError):
            failed.run(self.work_version_id, self.source, expected_current_id=current.id,
                       expected_revision=current.revision, force=True)
        with self.catalog.connect() as connection:
            failed_run = connection.exec_driver_sql(
                "SELECT id FROM processing_runs WHERE stage = 'analysis' AND state = 'failed'").scalar_one()
        recovered = self.service(FixtureProvider("fixture-v2"))
        result = recovered.run(self.work_version_id, self.source, expected_current_id=current.id,
                               expected_revision=current.revision, force=True)
        self.assertEqual(result.run.id, failed_run)
        replacement = recovered.current.get(self.work_version_id)
        self.assertIsNotNone(replacement)
        if replacement is None:
            self.fail("replacement current analysis is missing")
        self.assertEqual(replacement.revision, 2)

    def test_replay_tampering_fails_closed_without_provider_or_current_mutation(self) -> None:
        provider = FixtureProvider()
        service = self.service(provider)
        result = service.run(self.work_version_id, self.source)
        current = service.current.get(self.work_version_id)
        self.assertIsNotNone(current)
        if current is None:
            self.fail("current analysis is missing")
        before = self.projection_state()

        with self.catalog.connect() as connection:
            run_row = connection.exec_driver_sql("SELECT input_artifact_id, details_json FROM processing_runs WHERE id = ?", (result.run.id,)).one()
            provenance_json = connection.exec_driver_sql("SELECT provenance_json FROM normalized_artifacts WHERE id = ?", (result.artifact.id,)).scalar_one()
            content_json = connection.exec_driver_sql("SELECT content_json FROM current_analyses WHERE id = ?", (current.id,)).scalar_one()

        def replay_fails(expected_state=None) -> None:
            with patch.object(provider, "analyze", side_effect=AssertionError("provider invoked during replay")):
                with self.assertRaises((AnalysisError, CatalogError)):
                    service.run(self.work_version_id, self.source, expected_current_id=current.id, expected_revision=current.revision)
            self.assertEqual(self.projection_state(), before if expected_state is None else expected_state)

        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE processing_runs SET input_artifact_id = ? WHERE id = ?", (self.source.source_map.parser_artifact_id, result.run.id))
        replay_fails()
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE processing_runs SET input_artifact_id = ? WHERE id = ?", (run_row.input_artifact_id, result.run.id))

        details = json.loads(run_row.details_json)
        details["parameters"]["model_sha256"] = "0" * 64
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE processing_runs SET details_json = ? WHERE id = ?", (json.dumps(details, separators=(",", ":"), sort_keys=True), result.run.id))
        replay_fails()
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE processing_runs SET details_json = ? WHERE id = ?", (run_row.details_json, result.run.id))

        provenance = json.loads(provenance_json)
        provenance["input_sha256"] = "0" * 64
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE normalized_artifacts SET provenance_json = ? WHERE id = ?", (json.dumps(provenance, separators=(",", ":"), sort_keys=True), result.artifact.id))
        replay_fails()
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE normalized_artifacts SET provenance_json = ? WHERE id = ?", (provenance_json, result.artifact.id))

        publication = self.derived_store.find_published(result.artifact.kind, result.artifact.id)
        self.assertIsNotNone(publication)
        if publication is None:
            self.fail("analysis publication is missing")
        original_read = self.derived_store.read_verified
        payload = json.loads(original_read(publication))
        payload["document"]["sections"][0]["locators"][0]["page_index"] = 99
        corrupt = json.dumps(payload, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()
        def read(publication_value):
            return corrupt if publication_value.kind == "analysis" else original_read(publication_value)
        with patch.object(self.derived_store, "read_verified", side_effect=read):
            replay_fails()

        content = json.loads(content_json)
        content["evidence"][0]["source_start"] += 1
        with self.catalog.transaction() as connection:
            connection.exec_driver_sql("UPDATE current_analyses SET content_json = ? WHERE id = ?", (json.dumps(content, ensure_ascii=False, separators=(",", ":"), sort_keys=True), current.id))
        replay_fails(self.projection_state())

    def test_optimistic_conflict_rolls_back_all_current_projections(self) -> None:
        tag = TagRepository(self.catalog).add("rollback")
        def first_output(value, source):
            evidence = source["source_units"][0]["evidence_id"]
            value["generated_tags"] = [{"tag_id": tag.id, "evidence_ids": [evidence]}]
            value["references"] = [{"order": 0, "raw_reference": "Rollback reference",
                "resolved_work_id": None, "identifier_namespace": None, "identifier_value": None, "evidence_ids": [evidence]}]
        first_service = self.service(FixtureProvider(mutate=first_output))
        first_service.run(self.work_version_id, self.source)
        current = first_service.current.get(self.work_version_id)
        self.assertIsNotNone(current)
        if current is None:
            self.fail("current analysis is missing")
        before = self.projection_state()
        with self.assertRaisesRegex(CatalogError, "conflict"):
            self.service(FixtureProvider("fixture-v2")).run(self.work_version_id, self.source,
                expected_current_id=str(uuid4()), expected_revision=current.revision, force=True)
        self.assertEqual(self.projection_state(), before)

    def test_current_content_and_provenance_hash_mismatch_roll_back(self) -> None:
        service = self.service(FixtureProvider())
        result = service.run(self.work_version_id, self.source)
        current = service.current.get(self.work_version_id)
        self.assertIsNotNone(current)
        if current is None:
            self.fail("current analysis is missing")
        before = self.projection_state()
        content = json.loads(current.content_json)
        provenance = json.loads(current.provenance_json)
        content["sections"][0]["heading"] = "tampered"
        with self.assertRaisesRegex(CatalogError, "does not match"):
            service.current.replace(self.work_version_id, result.run.id, self.source.source_map.parser_artifact_id,
                result.artifact.id, content, provenance, expected_current_id=current.id, expected_revision=current.revision)
        bad_provenance = {**provenance, "model": "tampered"}
        with self.assertRaisesRegex(CatalogError, "does not match"):
            service.current.replace(self.work_version_id, result.run.id, self.source.source_map.parser_artifact_id,
                result.artifact.id, json.loads(current.content_json), bad_provenance,
                expected_current_id=current.id, expected_revision=current.revision)
        self.assertEqual(self.projection_state(), before)

    def test_invalid_manual_registry_and_canonical_values_are_rejected(self) -> None:
        invalid = (("publisher_id", str(uuid4())), ("venue_id", "not-a-uuid"),
                   ("publication_date", "2024/01/01"), ("publication_year", "2024"))
        for field_name, value in invalid:
            with self.assertRaises((CatalogError, ManualMetadataCurationConflictError)):
                ManualMetadataSetHandler.load(self.catalog, self.work_version_id, field_name, value)
        with self.catalog.connect() as connection:
            self.assertEqual(connection.exec_driver_sql(
                "SELECT count(*) FROM manual_metadata_overrides WHERE work_version_id = ?", (self.work_version_id,)).scalar_one(), 0)

    def test_current_analysis_publishes_immutable_package_snapshots(self) -> None:
        service = self.service(FixtureProvider())
        first_analysis = service.run(self.work_version_id, self.source)
        pipeline = PackagePipeline(self.catalog, self.raw_store, self.derived_store)
        first = pipeline.run(work_version_id=self.work_version_id)
        snapshot = first.package.current_analysis
        self.assertIsNotNone(snapshot)
        if snapshot is None:
            self.fail("package current analysis snapshot is missing")
        current = service.current.get(self.work_version_id)
        self.assertIsNotNone(current)
        if current is None:
            self.fail("current analysis is missing")
        self.assertEqual((snapshot.current_id, snapshot.revision, snapshot.analysis_artifact_id),
                         (current.id, 1, first_analysis.artifact.id))
        self.assertFalse(hasattr(snapshot, "content"))
        self.assertEqual(tuple(item.section_id for item in snapshot.sections), SECTION_IDS)
        self.assertEqual(snapshot.sections[0].locators[0].raw_asset_id, self.raw_id)
        selection = WorkVersionAnalysisRepository(self.catalog)
        self.assertEqual(selection.select_exact(work_version_id=self.work_version_id).work_version_ids, ())
        self.assertEqual(selection.select_exact(work_version_id=self.work_version_id, force=True).work_version_ids,
                         (self.work_version_id,))
        self.assertEqual(selection.select_all_current(limit=10, force=True).work_version_ids,
                         (self.work_version_id,))
        with self.assertRaisesRegex(ValueError, "requires force"):
            selection.select_all_current(limit=10, force=False)
        self.assertEqual({"mineru_parser", "mineru_source_map", "analysis"}.issubset(
            {item.kind for item in first.package.artifacts}), True)
        replay = pipeline.run(work_version_id=self.work_version_id)
        self.assertFalse(replay.created)
        self.assertEqual(replay.package, first.package)

        replacement = self.service(FixtureProvider("fixture-v2"))
        replacement.run(self.work_version_id, self.source, expected_current_id=current.id,
                        expected_revision=current.revision, force=True)
        replacement_current = replacement.current.get(self.work_version_id)
        with patch.object(pipeline.publisher.versions, "register_published",
                          side_effect=RuntimeError("injected package publication failure")), \
             self.assertRaises(RuntimeError):
            pipeline.run(work_version_id=self.work_version_id)
        self.assertEqual(replacement.current.get(self.work_version_id), replacement_current)
        second = pipeline.run(work_version_id=self.work_version_id)
        self.assertTrue(second.created)
        self.assertEqual((first.package.package_version, second.package.package_version), (1, 2))
        self.assertNotEqual(first.package.package_sha256, second.package.package_sha256)
        loaded_old = pipeline.publisher.load_by_document_hash(
            self.work_version_id, first.package.package_sha256)
        self.assertEqual(loaded_old, first.package)

    def test_package_rejects_corrupt_current_analysis_artifact(self) -> None:
        analysis = self.service(FixtureProvider()).run(
            self.work_version_id, self.source
        )
        publication = self.derived_store.find_published(
            analysis.artifact.kind, analysis.artifact.id
        )
        self.assertIsNotNone(publication)
        if publication is None:
            self.fail("analysis artifact publication is missing")
        artifact_path = self.derived_store.root / publication.storage_path
        artifact_path.chmod(0o600)
        artifact_path.write_bytes(b"corrupt")
        pipeline = PackagePipeline(self.catalog, self.raw_store, self.derived_store)
        with self.assertRaisesRegex(PackagingError, "integrity"):
            pipeline.run(work_version_id=self.work_version_id)
        with self.catalog.connect() as connection:
            self.assertEqual(
                connection.exec_driver_sql(
                    "SELECT count(*) FROM package_versions"
                ).scalar_one(),
                0,
            )


if __name__ == "__main__":
    import unittest
    unittest.main()
