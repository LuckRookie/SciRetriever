from __future__ import annotations

import unittest

from sciretriever.model.assets import AcceptedContentReference, ContentTarget
from sciretriever.model.collection import TopicConditions
from sciretriever.model.documents import LightPublicationTarget
from sciretriever.model.execution import ImportResult
from sciretriever.model.literature import Identifier, InitialMetadata, UnifiedMetadataSnapshot
from sciretriever.model.primitives import (
    AssetId,
    MetadataSnapshotId,
    WorkId,
    WorkVersionAssetId,
    WorkVersionId,
    sha256_digest,
)
from sciretriever.model.record import (
    ImportIdentityResolution,
    ImportPreparationOutcome,
    ImportPreparationRequest,
)


class TargetM1ModelRoundTripTests(unittest.TestCase):
    def test_new_contract_families_round_trip_without_mutation(self) -> None:
        identifier = Identifier(namespace="doi", value="10.1000/example")
        snapshot = UnifiedMetadataSnapshot(
            snapshot_id=MetadataSnapshotId("00000000-0000-0000-0000-000000000001"),
            revision=1,
            title="Example",
            authors=("Ada Lovelace",),
            identifiers=(identifier,),
        )
        accepted = AcceptedContentReference(
            content_id=AssetId("00000000-0000-0000-0000-000000000002"),
            sha256=sha256_digest(b"pdf"),
            revision=1,
        )
        contracts = (
            TopicConditions(query="example"),
            snapshot,
            ContentTarget(
                work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000003"),
                current_metadata=snapshot,
                accepted_content=(accepted,),
                current_accepted_content=accepted,
                expected_metadata_revision=1,
                expected_accepted_content_sha256=accepted.sha256,
                expected_accepted_content_revision=1,
            ),
            LightPublicationTarget(
                work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000003"),
                primary_relation_id=WorkVersionAssetId("00000000-0000-0000-0000-000000000004"),
                primary_asset_id=AssetId("00000000-0000-0000-0000-000000000002"),
                primary_sha256=accepted.sha256,
            ),
            ImportPreparationRequest(
                metadata=InitialMetadata(title="Example"),
                identifiers=(identifier,),
                references=("Reference",),
                tags=("tag",),
            ),
            ImportIdentityResolution(
                work_id=WorkId("00000000-0000-0000-0000-000000000005"),
                work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000003"),
                result="created",
                completed=False,
                prepared=None,
            ),
            ImportPreparationOutcome(
                ordinal=0,
                result=ImportResult(
                    record_index=0,
                    work_id="00000000-0000-0000-0000-000000000005",
                    work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000003"),
                    outcome="created",
                    omissions=(),
                    failure=None,
                ),
                work_id=WorkId("00000000-0000-0000-0000-000000000005"),
                work_version_id=WorkVersionId("00000000-0000-0000-0000-000000000003"),
                prepared=None,
                references=("Reference",),
                tags=("tag",),
                failure=None,
            ),
        )
        for contract in contracts:
            self.assertEqual(
                type(contract).model_validate_json(contract.model_dump_json()), contract
            )


if __name__ == "__main__":
    unittest.main()
