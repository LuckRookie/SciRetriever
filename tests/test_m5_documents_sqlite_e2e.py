from __future__ import annotations

import unittest
from typing import assert_never

from target_light_document_support import document_value, manifest_blocks, parsed_document
from target_publisher_support import ScenarioFactory

from sciretriever.core.documents import validate_light_document
from sciretriever.literature_store.filesystem import CoreArtifactStore
from sciretriever.literature_store.sqlite import (
    ContentAcceptancePublisher,
    create_or_open_catalog,
    open_read_only_snapshot,
)
from sciretriever.model.assets import PrimaryPdfAcceptance
from sciretriever.model.canonical_json import CanonicalJsonInput
from sciretriever.model.documents import LightDocumentBounds, LightPublicationTarget
from sciretriever.model.execution import ContentAcceptanceCommand, TargetProjection, TargetResult
from sciretriever.model.parsing import ParserProvenance, ParserRequest, ParserResult
from sciretriever.model.primitives import sha256_digest
from sciretriever.services.documents import DocumentServiceDependencies, LightDocumentService


class M5DocumentsSqliteE2ETests(unittest.TestCase):
    def test_document_service_publishes_real_file_and_sqlite_current_pointer(self) -> None:
        factory = ScenarioFactory()
        self.addCleanup(factory.cleanup)
        scenario = factory.primary()
        scenario.invoke()
        assert isinstance(scenario.command, ContentAcceptanceCommand)
        command = scenario.command
        acceptance = command.acceptance
        assert isinstance(acceptance, PrimaryPdfAcceptance)
        with create_or_open_catalog(scenario.path) as connection:
            connection.execute("UPDATE batch_targets SET result_json=NULL")
            connection.commit()
        pdf = b"%PDF-primary"

        class StaticParser:
            def parse(self, request: ParserRequest) -> ParserResult:
                value = document_value()

                def replace_asset(item: CanonicalJsonInput) -> None:
                    match item:
                        case dict():
                            for key, nested in item.items():
                                if key == "asset_id":
                                    item[key] = str(request.asset_id)
                                else:
                                    replace_asset(nested)
                        case list():
                            for nested in item:
                                replace_asset(nested)
                        case None | bool() | int() | float() | str():
                            return
                        case unreachable:
                            assert_never(unreachable)

                replace_asset(value)
                document = validate_light_document(
                    parsed_document(value),
                    request.asset_id,
                    1,
                    manifest_blocks(),
                    LightDocumentBounds(),
                )
                return ParserResult(
                    document=document,
                    pdf_pages=1,
                    block_manifest=manifest_blocks(),
                    provenance=ParserProvenance(
                        parser_name="fixture",
                        parser_version="1",
                        backend="fixture",
                        model="fixture",
                        parameters_sha256=sha256_digest(b"parameters"),
                        input_sha256=request.asset_sha256,
                    ),
                )

        projection = TargetProjection(
            batch_run_id=command.target.batch_run_id,
            work_version_id=acceptance.work_version_id,
            result=TargetResult(
                subject_type="work-version",
                subject_id=str(acceptance.work_version_id),
                outcome="partially-advanced",
                initial_state="asset-ready",
                target_state="light-text-ready",
                final_state="light-text-ready",
                stage="parsing",
                failure=None,
            ),
            details=command.target.details,
            failure_stages_to_clear=("parsing",),
        )
        service = LightDocumentService(
            DocumentServiceDependencies(
                StaticParser(),
                CoreArtifactStore(factory.root / "storage"),
                ContentAcceptancePublisher(scenario.path),
            )
        )

        result = service.accept(
            target=self._target(acceptance),
            request=ParserRequest(
                pdf=pdf,
                asset_id=acceptance.artifact_id,
                asset_sha256=sha256_digest(pdf),
                resume_task_id=None,
            ),
            projection=projection,
        )

        path = (
            factory.root / "storage" / "core" / "light-document" / str(result.artifact.sha256)[:2]
        )
        self.assertTrue((path / str(result.artifact.sha256)).is_file())
        with open_read_only_snapshot(scenario.path) as connection:
            row = connection.execute(
                "SELECT d.sha256,d.primary_asset_id,c.light_document_id "
                "FROM light_documents d JOIN work_version_current_light_document c "
                "ON c.light_document_id=d.id WHERE c.work_version_id=?",
                (str(acceptance.work_version_id),),
            ).fetchone()
        self.assertEqual(
            row,
            (str(result.artifact.sha256), str(acceptance.relation_id), str(result.document_id)),
        )

    @staticmethod
    def _target(acceptance: PrimaryPdfAcceptance) -> LightPublicationTarget:
        return LightPublicationTarget(
            work_version_id=acceptance.work_version_id,
            primary_relation_id=acceptance.relation_id,
            primary_asset_id=acceptance.artifact_id,
            primary_sha256=acceptance.artifact.sha256,
        )


if __name__ == "__main__":
    unittest.main()
