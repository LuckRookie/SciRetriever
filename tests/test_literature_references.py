from __future__ import annotations

import unittest

from pydantic import ValidationError

from sciretriever.literature.references import (
    ContentReferenceEvidence,
    MetadataReferenceEvidence,
    ProviderRelationEvidence,
    ReferenceAcceptanceDecision,
    ReferenceCleanupDecision,
    decide_content_replacement_cleanup,
    decide_reference,
)
from sciretriever.model.analysis import (
    ArtifactRef,
    LiteratureContent,
    LiteratureSection,
    LiteratureSectionRole,
    content_sha256,
)
from sciretriever.model.literature import (
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
    ProviderRelationObservation,
)
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    ReferenceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance

_SOURCE_ID = "123e4567-e89b-12d3-a456-426614174000"
_TARGET_ID = "223e4567-e89b-12d3-a456-426614174000"
_REVERSE_ID = "323e4567-e89b-12d3-a456-426614174000"
_RELATION_OBSERVATION_ID = "423e4567-e89b-12d3-a456-426614174000"
_METADATA_OBSERVATION_ID = "523e4567-e89b-12d3-a456-426614174000"
_CONTENT_PROVENANCE_ID = "623e4567-e89b-12d3-a456-426614174000"
_REFERENCE_ID = "723e4567-e89b-12d3-a456-426614174000"
_REVERSE_REFERENCE_ID = "823e4567-e89b-12d3-a456-426614174000"
_TIMESTAMP = UtcTimestamp("2026-08-10T12:34:56Z")
_INPUT_HASH = Sha256("a" * 64)
_PARAMETERS_HASH = Sha256("b" * 64)


def _provenance(
    identifier: str,
    *,
    source_kind: SourceKind = SourceKind.METADATA_PROVIDER,
    source_name: str = "fixture-provider",
    source_record_id: str | None = "record",
    input_sha256: Sha256 | None = _INPUT_HASH,
    parameters_sha256: Sha256 | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(identifier),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=source_record_id,
        observed_at=_TIMESTAMP,
        input_sha256=input_sha256,
        parameters_sha256=parameters_sha256,
    )


def _literature(identifier: str, *, meta_identifier: str | None = None) -> Literature:
    return Literature(
        literature_id=LiteratureId(identifier),
        meta_literature_id=MetaLiteratureId(meta_identifier or identifier),
        version_role=VersionRole.PUBLISHED,
        metadata=LiteratureMetadata(title="A literature"),
        status=LiteratureStatus.UNREVIEWED,
    )


def _provider_observation() -> ProviderRelationObservation:
    return ProviderRelationObservation(
        observation_id=ObservationId(_RELATION_OBSERVATION_ID),
        provenance=_provenance(_RELATION_OBSERVATION_ID),
        citing=ProviderLiteratureKey(record_id="source-record"),
        cited=ProviderLiteratureKey(record_id="target-record"),
    )


def _metadata_observation() -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(_METADATA_OBSERVATION_ID),
        provenance=_provenance(_METADATA_OBSERVATION_ID),
        metadata=LiteratureMetadata(title="Source metadata"),
        reference_texts=("Target paper, 2020.", "Another target."),
    )


def _content(
    identifier: str = "c" * 64,
    references: tuple[str, ...] = ("Target paper, 2020.",),
) -> LiteratureContent:
    sections = tuple(
        LiteratureSection(role=role, markdown="body")
        for role in (
            LiteratureSectionRole.BACKGROUND_AND_OBJECTIVES,
            LiteratureSectionRole.METHODS,
            LiteratureSectionRole.DATA,
            LiteratureSectionRole.CONCLUSIONS_AND_LIMITATIONS,
        )
    )
    content_hash = content_sha256(
        metadata_sha256=_INPUT_HASH,
        sections=sections,
        references=references,
    )
    return LiteratureContent(
        literature_content_sha256=content_hash if identifier == "c" * 64 else Sha256(identifier),
        metadata_revision=1,
        metadata_sha256=_INPUT_HASH,
        sections=sections,
        references=references,
        markdown=ArtifactRef(
            sha256=Sha256("d" * 64),
            media_type="text/markdown",
            byte_size=1,
        ),
        provenance=_provenance(
            _CONTENT_PROVENANCE_ID,
            source_kind=SourceKind.ANALYSIS,
            source_name="fixture-analysis",
            source_record_id=None,
            input_sha256=_INPUT_HASH,
            parameters_sha256=_PARAMETERS_HASH,
        ),
    )


class LiteratureReferenceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.source = _literature(_SOURCE_ID)
        self.target = _literature(_TARGET_ID)
        self.accepted = (self.source, self.target)

    def test_decision_models_are_strict_frozen_and_closed(self) -> None:
        with self.assertRaises(ValidationError):
            ReferenceAcceptanceDecision(
                decision="rejected",
                reason="self-reference",
                unexpected="forbidden",  # type: ignore[call-arg]
            )
        with self.assertRaises(ValidationError):
            ReferenceCleanupDecision(
                decision="unchanged",
                source_literature_id=self.source.literature_id,
                old_content_sha256=_INPUT_HASH,
                unexpected="forbidden",  # type: ignore[call-arg]
            )

    def test_provider_observation_is_independent_until_both_endpoints_and_support_are_present(
        self,
    ) -> None:
        observation = _provider_observation()
        pending = decide_reference(
            source=self.source,
            target=None,
            accepted_literatures=(self.source,),
            provider_relations=(
                ProviderRelationEvidence(
                    observation=observation,
                    source=self.source,
                    target=self.target,
                ),
            ),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        self.assertEqual(pending.decision, "rejected")
        self.assertEqual(pending.reason, "target-not-accepted")
        self.assertIsNone(pending.reference)
        self.assertEqual(pending.supports, ())

    def test_provider_and_content_support_create_one_reference_with_canonical_direction(
        self,
    ) -> None:
        provider = ProviderRelationEvidence(
            observation=_provider_observation(),
            source=self.source,
            target=self.target,
        )
        content = _content()
        content_evidence = ContentReferenceEvidence(
            literature=self.source,
            content=content,
            reference_index=0,
        )
        decision = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            provider_relations=(provider,),
            content_references=(content_evidence,),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        self.assertEqual(decision.decision, "created")
        self.assertIsNotNone(decision.reference)
        assert decision.reference is not None
        self.assertEqual(decision.reference.source_literature_id, self.source.literature_id)
        self.assertEqual(decision.reference.target_literature_id, self.target.literature_id)
        self.assertEqual(len(decision.supports), 2)
        self.assertEqual(
            {support.source.kind for support in decision.supports},
            {"provider_relation", "content_reference_text"},
        )

    def test_metadata_text_support_requires_source_ownership_and_index_range(self) -> None:
        evidence = MetadataReferenceEvidence(
            literature=self.source,
            observation=_metadata_observation(),
            reference_index=1,
        )
        decision = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            metadata_references=(evidence,),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        self.assertEqual(decision.decision, "created")
        self.assertEqual(decision.supports[0].source.kind, "metadata_reference_text")

        out_of_range = evidence.model_copy(update={"reference_index": 2})
        rejected = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            metadata_references=(out_of_range,),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        self.assertEqual(rejected.decision, "rejected")
        self.assertEqual(rejected.reason, "metadata-reference-index-out-of-range")
        self.assertIsNone(rejected.reference)

        wrong_owner = evidence.model_copy(update={"literature": self.target})
        rejected = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            metadata_references=(wrong_owner,),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        self.assertEqual(rejected.reason, "metadata-support-source-mismatch")

    def test_duplicate_edge_merges_supports_and_is_idempotent_while_reverse_edge_is_independent(
        self,
    ) -> None:
        first = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            provider_relations=(
                ProviderRelationEvidence(
                    observation=_provider_observation(),
                    source=self.source,
                    target=self.target,
                ),
            ),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        self.assertEqual(first.decision, "created")
        assert first.reference is not None
        second = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            existing_references=(first.reference,),
            existing_supports=first.supports,
            metadata_references=(
                MetadataReferenceEvidence(
                    literature=self.source,
                    observation=_metadata_observation(),
                    reference_index=0,
                ),
            ),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        self.assertEqual(second.decision, "matched")
        self.assertEqual(second.reference, first.reference)
        self.assertEqual(len(second.supports), 2)

        repeated = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            existing_references=(first.reference,),
            existing_supports=second.supports,
            provider_relations=(
                ProviderRelationEvidence(
                    observation=_provider_observation(),
                    source=self.source,
                    target=self.target,
                ),
            ),
            metadata_references=(
                MetadataReferenceEvidence(
                    literature=self.source,
                    observation=_metadata_observation(),
                    reference_index=0,
                ),
            ),
            reference_id=ReferenceId(_REVERSE_REFERENCE_ID),
        )
        self.assertEqual(repeated.decision, "matched")
        self.assertEqual(repeated.reference, first.reference)
        self.assertEqual(len(repeated.supports), 2)

        reverse = decide_reference(
            source=self.target,
            target=self.source,
            accepted_literatures=self.accepted,
            provider_relations=(
                ProviderRelationEvidence(
                    observation=_provider_observation(),
                    source=self.target,
                    target=self.source,
                ),
            ),
            reference_id=ReferenceId(_REVERSE_REFERENCE_ID),
        )
        self.assertEqual(reverse.decision, "created")
        assert reverse.reference is not None
        self.assertNotEqual(reverse.reference, first.reference)
        self.assertEqual(reverse.reference.source_literature_id, self.target.literature_id)

    def test_self_reference_meta_endpoint_ambiguity_and_missing_support_fail_closed(self) -> None:
        self_reference = decide_reference(
            source=self.source,
            target=self.source,
            accepted_literatures=(self.source,),
            provider_relations=(
                ProviderRelationEvidence(
                    observation=_provider_observation(),
                    source=self.source,
                    target=self.source,
                ),
            ),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        self.assertEqual(self_reference.reason, "self-reference")
        self.assertIsNone(self_reference.reference)

        ambiguous = decide_reference(
            source=self.source,
            target=None,
            accepted_literatures=(self.source, self.target),
            target_candidates=(self.source, self.target),
            provider_relations=(),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        self.assertEqual(ambiguous.reason, "ambiguous-target")

        no_support = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        self.assertEqual(no_support.reason, "support-missing")

    def test_old_content_support_cleanup_deletes_only_supportless_references(self) -> None:
        provider = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            provider_relations=(
                ProviderRelationEvidence(
                    observation=_provider_observation(),
                    source=self.source,
                    target=self.target,
                ),
            ),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        assert provider.reference is not None
        content = _content()
        content_only = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            content_references=(
                ContentReferenceEvidence(
                    literature=self.source,
                    content=content,
                    reference_index=0,
                ),
            ),
            reference_id=ReferenceId(_REVERSE_REFERENCE_ID),
        )
        assert content_only.reference is not None
        cleanup = decide_content_replacement_cleanup(
            source_literature_id=self.source.literature_id,
            old_content_sha256=content.literature_content_sha256,
            references=(provider.reference, content_only.reference),
            supports=provider.supports + content_only.supports,
        )
        self.assertEqual(cleanup.decision, "cleaned")
        self.assertEqual(cleanup.deleted_reference_ids, (content_only.reference.reference_id,))
        self.assertEqual(cleanup.removed_supports, content_only.supports)

    def test_cleanup_preserves_metadata_support_and_is_idempotent(self) -> None:
        content = _content()
        metadata = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            metadata_references=(
                MetadataReferenceEvidence(
                    literature=self.source,
                    observation=_metadata_observation(),
                    reference_index=0,
                ),
            ),
            content_references=(
                ContentReferenceEvidence(
                    literature=self.source,
                    content=content,
                    reference_index=0,
                ),
            ),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        assert metadata.reference is not None
        cleanup = decide_content_replacement_cleanup(
            source_literature_id=self.source.literature_id,
            old_content_sha256=content.literature_content_sha256,
            references=(metadata.reference,),
            supports=metadata.supports,
        )
        self.assertEqual(cleanup.decision, "cleaned")
        self.assertEqual(cleanup.deleted_reference_ids, ())
        self.assertEqual(len(cleanup.removed_supports), 1)
        self.assertEqual(cleanup.removed_supports[0].source.kind, "content_reference_text")

        repeated = decide_content_replacement_cleanup(
            source_literature_id=self.source.literature_id,
            old_content_sha256=content.literature_content_sha256,
            references=(metadata.reference,),
            supports=tuple(
                support for support in metadata.supports if support not in cleanup.removed_supports
            ),
        )
        self.assertEqual(repeated.decision, "unchanged")

    def test_cleanup_rejects_duplicate_support_instead_of_silently_reconciling(self) -> None:
        content = _content()
        accepted = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            content_references=(
                ContentReferenceEvidence(
                    literature=self.source,
                    content=content,
                    reference_index=0,
                ),
            ),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        assert accepted.reference is not None
        rejected = decide_content_replacement_cleanup(
            source_literature_id=self.source.literature_id,
            old_content_sha256=content.literature_content_sha256,
            references=(accepted.reference,),
            supports=accepted.supports + accepted.supports,
        )
        self.assertEqual(rejected.decision, "rejected")
        self.assertEqual(rejected.reason, "duplicate-support")

    def test_cleanup_is_scoped_to_the_citing_literature_even_when_content_hash_is_shared(
        self,
    ) -> None:
        content = _content()
        source_edge = decide_reference(
            source=self.source,
            target=self.target,
            accepted_literatures=self.accepted,
            content_references=(
                ContentReferenceEvidence(
                    literature=self.source,
                    content=content,
                    reference_index=0,
                ),
            ),
            reference_id=ReferenceId(_REFERENCE_ID),
        )
        reverse_edge = decide_reference(
            source=self.target,
            target=self.source,
            accepted_literatures=self.accepted,
            content_references=(
                ContentReferenceEvidence(
                    literature=self.target,
                    content=content,
                    reference_index=0,
                ),
            ),
            reference_id=ReferenceId(_REVERSE_REFERENCE_ID),
        )
        assert source_edge.reference is not None
        assert reverse_edge.reference is not None
        cleanup = decide_content_replacement_cleanup(
            source_literature_id=self.source.literature_id,
            old_content_sha256=content.literature_content_sha256,
            references=(source_edge.reference, reverse_edge.reference),
            supports=source_edge.supports + reverse_edge.supports,
        )
        self.assertEqual(cleanup.removed_supports, source_edge.supports)
        self.assertEqual(
            cleanup.deleted_reference_ids,
            (source_edge.reference.reference_id,),
        )


if __name__ == "__main__":
    unittest.main()
