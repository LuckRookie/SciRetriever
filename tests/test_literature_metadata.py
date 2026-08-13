from __future__ import annotations

import unittest

from pydantic import ValidationError

from sciretriever.literature.metadata import (
    MetadataObservationAcceptanceDecision,
    MetadataProjectionDecision,
    accept_observation,
    project_metadata,
    same_user_observation,
    user_observation_semantic_sha256,
)
from sciretriever.model.literature import (
    Affiliation,
    Author,
    AuthorKind,
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import LiteratureMetadata, MetadataObservation
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
)
from sciretriever.model.provenance import Provenance

_ID_1 = "123e4567-e89b-12d3-a456-426614174000"
_ID_2 = "223e4567-e89b-12d3-a456-426614174000"
_ID_3 = "323e4567-e89b-12d3-a456-426614174000"
_ID_4 = "423e4567-e89b-12d3-a456-426614174000"
_HASH_1 = Sha256("a" * 64)
_HASH_2 = Sha256("b" * 64)
_OBSERVED_AT = UtcTimestamp("2026-08-10T12:34:56Z")


def _metadata(
    *,
    title: str | None = "A study",
    authors: tuple[Author, ...] | list[Author] = (),
    abstract: str | None = None,
    publication_date: str | None = None,
    year: int | None = 2026,
    document_type: str | None = "journal-article",
    language: str | None = None,
    venue: str | None = None,
    publisher: str | None = None,
    volume: str | None = None,
    issue: str | None = None,
    pages: str | None = None,
    identifiers: tuple[Identifier, ...] | list[Identifier] = (),
    keywords: tuple[str, ...] | list[str] = (),
) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=title,
        authors=tuple(authors),
        abstract=abstract,
        publication_date=publication_date,
        publication_year=year,
        document_type=document_type,
        language=language,
        venue=venue,
        publisher=publisher,
        volume=volume,
        issue=issue,
        pages=pages,
        identifiers=tuple(identifiers),
        keywords=tuple(keywords),
    )


def _provenance(
    observation_id: str,
    *,
    source_kind: SourceKind = SourceKind.METADATA_PROVIDER,
    source_name: str = "crossref",
    source_record_id: str | None = "record-1",
    input_sha256: Sha256 | None = _HASH_1,
    parameters_sha256: Sha256 | None = None,
    observed_at: UtcTimestamp = _OBSERVED_AT,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(observation_id),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=source_record_id,
        observed_at=observed_at,
        input_sha256=input_sha256,
        parameters_sha256=parameters_sha256,
    )


def _observation(
    observation_id: str,
    metadata: LiteratureMetadata,
    *,
    source_kind: SourceKind = SourceKind.METADATA_PROVIDER,
    source_name: str = "crossref",
    source_record_id: str | None = "record-1",
    input_sha256: Sha256 | None = _HASH_1,
    parameters_sha256: Sha256 | None = None,
    observed_at: UtcTimestamp = _OBSERVED_AT,
    version_role: VersionRole | None = None,
    declared_keywords: tuple[str, ...] = (),
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(observation_id),
        provenance=_provenance(
            observation_id,
            source_kind=source_kind,
            source_name=source_name,
            source_record_id=source_record_id,
            input_sha256=input_sha256,
            parameters_sha256=parameters_sha256,
            observed_at=observed_at,
        ),
        metadata=metadata,
        version_role=version_role,
        declared_keywords=declared_keywords,
    )


def _user_observation(
    observation_id: str,
    metadata: LiteratureMetadata,
    *,
    observed_at: UtcTimestamp = _OBSERVED_AT,
    declared_keywords: tuple[str, ...] = (),
) -> MetadataObservation:
    return _observation(
        observation_id,
        metadata,
        source_kind=SourceKind.USER,
        source_name="bibliographic-import",
        source_record_id=None,
        input_sha256=None,
        parameters_sha256=None,
        observed_at=observed_at,
        declared_keywords=declared_keywords,
    )


def _literature(
    literature_id: str,
    metadata: LiteratureMetadata,
    *,
    status: LiteratureStatus = LiteratureStatus.UNREVIEWED,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(literature_id),
        meta_literature_id=MetaLiteratureId(_ID_1),
        version_role=VersionRole.OTHER,
        metadata=metadata,
        status=status,
    )


class MetadataDecisionContractTests(unittest.TestCase):
    def test_decisions_are_frozen_closed_pydantic_models(self) -> None:
        with self.assertRaises(ValidationError):
            MetadataProjectionDecision(
                outcome="projected",
                metadata=_metadata(),
                metadata_revision=1,
                unexpected="nope",  # type: ignore[call-arg]
            )
        with self.assertRaises(ValidationError):
            MetadataObservationAcceptanceDecision(outcome="created")

    def test_minimum_acceptance_requires_title_or_doi_and_is_fail_closed(self) -> None:
        arxiv_only = _observation(
            _ID_2,
            _metadata(title=None, identifiers=[Identifier(namespace="arxiv", value="2501.01234")]),
        )
        pmid_only_user = _user_observation(
            _ID_3,
            _metadata(title=None, identifiers=[Identifier(namespace="pmid", value="12345")]),
        )
        for observation in (arxiv_only, pmid_only_user):
            with self.subTest(observation=observation):
                decision = accept_observation(observation)
                self.assertEqual(decision.outcome, "rejected")
                self.assertEqual(decision.reason, "missing-title-or-doi")
                self.assertEqual(decision.observations, ())

        doi_only = _observation(
            _ID_4,
            _metadata(title=None, identifiers=[Identifier(namespace="doi", value="10.1000/ok")]),
        )
        self.assertEqual(accept_observation(doi_only).outcome, "created")

    def test_stable_identifier_conflict_rejects_whole_observation(self) -> None:
        existing_metadata = _metadata(
            identifiers=[
                Identifier(namespace="doi", value="10.1000/same"),
                Identifier(namespace="pmid", value="100"),
            ]
        )
        incoming = _observation(
            _ID_3,
            _metadata(
                identifiers=[
                    Identifier(namespace="doi", value="10.1000/same"),
                    Identifier(namespace="pmid", value="999"),
                ]
            ),
        )
        decision = accept_observation(
            incoming,
            existing_literature=(_literature(_ID_2, existing_metadata),),
        )
        self.assertEqual(decision.outcome, "rejected")
        self.assertEqual(decision.reason, "stable-identifier-conflict")
        self.assertEqual(decision.observations, ())

    def test_first_user_observation_is_kept_even_when_provider_metadata_matches(self) -> None:
        metadata = _metadata(
            title="Same description",
            identifiers=[Identifier(namespace="doi", value="10.1000/same")],
        )
        provider = _observation(_ID_2, metadata, source_name="crossref", source_record_id="r1")
        user = _user_observation(_ID_3, metadata)
        first = accept_observation(provider)
        second = accept_observation(
            user,
            existing_literature=(_literature(_ID_4, metadata),),
            existing_observations=(provider,),
        )
        self.assertEqual(first.outcome, "created")
        self.assertEqual(second.outcome, "matched")
        self.assertFalse(second.deduplicated)
        self.assertEqual(second.observations, (provider, user))
        assert second.projection is not None
        self.assertFalse(second.projection.observations_projection_changed)

    def test_normalized_duplicate_user_observation_is_matched_without_second_fact(self) -> None:
        metadata = _metadata(title="  Same title  ", abstract="  Abstract  ")
        first = _user_observation(_ID_2, metadata)
        duplicate = _user_observation(
            _ID_3,
            metadata,
            observed_at=UtcTimestamp("2026-08-11T12:34:56Z"),
        )
        decision = accept_observation(duplicate, existing_observations=(first,))
        self.assertEqual(decision.outcome, "matched")
        self.assertTrue(decision.deduplicated)
        self.assertEqual(decision.reason, "duplicate-observation")
        self.assertEqual(decision.observations, (first,))
        assert decision.projection is not None
        self.assertFalse(decision.projection.observations_projection_changed)

    def test_user_semantic_hash_and_complete_equality_share_one_replay_semantics(self) -> None:
        metadata = _metadata(title="Imported", abstract="Abstract")
        first = _user_observation(_ID_2, metadata)
        replay = _user_observation(
            _ID_3,
            metadata,
            observed_at=UtcTimestamp("2026-08-11T12:34:56Z"),
        )
        changed = _user_observation(
            _ID_4,
            metadata,
            declared_keywords=("different-source-field",),
        )

        self.assertTrue(same_user_observation(first, replay))
        self.assertEqual(
            user_observation_semantic_sha256(first),
            user_observation_semantic_sha256(replay),
        )
        self.assertFalse(same_user_observation(first, changed))
        self.assertNotEqual(
            user_observation_semantic_sha256(first),
            user_observation_semantic_sha256(changed),
        )

    def test_projection_prefers_user_values_and_provider_precedence_only_fills_blanks(self) -> None:
        user = _user_observation(
            _ID_2,
            _metadata(title="User title", abstract=None, venue="User venue", keywords=["ignored"]),
            declared_keywords=("provider-declared",),
        )
        low = _observation(
            _ID_3,
            _metadata(title="Low title", abstract="Low abstract", venue="Low venue"),
            source_name="low-provider",
            source_record_id="low-1",
        )
        high = _observation(
            _ID_4,
            _metadata(title="High title", abstract="High abstract", venue="High venue"),
            source_name="high-provider",
            source_record_id="high-1",
        )
        decision = project_metadata(
            (low, user, high),
            provider_precedence=("high-provider", "low-provider"),
        )
        self.assertEqual(decision.outcome, "projected")
        self.assertIsNotNone(decision.metadata)
        assert decision.metadata is not None
        self.assertEqual(decision.metadata.title, "User title")
        self.assertEqual(decision.metadata.abstract, "High abstract")
        self.assertEqual(decision.metadata.venue, "User venue")
        self.assertEqual(decision.metadata.keywords, ("ignored",))
        self.assertEqual(decision.metadata_revision, 1)

    def test_projection_keeps_import_keywords_and_declared_provider_keywords_separate(
        self,
    ) -> None:
        imported = _user_observation(
            _ID_4,
            _metadata(title="Imported", keywords=("machine learning", "DFT")),
        )
        provider_a = _observation(
            _ID_2,
            _metadata(title="A", abstract=None),
            source_name="a-provider",
            source_record_id="a-1",
            declared_keywords=("a",),
        )
        provider_b = _observation(
            _ID_3,
            _metadata(title="B", abstract="B abstract"),
            source_name="b-provider",
            source_record_id="b-1",
            declared_keywords=("b",),
        )
        first = project_metadata(
            (provider_a, imported, provider_b),
            provider_precedence=("b-provider", "a-provider"),
        )
        second = project_metadata(
            (provider_a, imported, provider_b),
            provider_precedence=("b-provider", "a-provider"),
        )
        self.assertEqual(first, second)
        self.assertEqual(
            first.metadata.keywords if first.metadata else None,
            ("machine learning", "DFT"),
        )

    def test_distinct_provider_observations_are_retained_but_exact_id_replay_is_idempotent(
        self,
    ) -> None:
        metadata = _metadata(identifiers=(Identifier(namespace="doi", value="10.1000/replay"),))
        first = _observation(_ID_2, metadata, source_record_id="same-record")
        later = _observation(
            _ID_3,
            metadata,
            source_record_id="same-record",
            observed_at=UtcTimestamp("2026-08-11T12:34:56Z"),
        )
        retained = accept_observation(later, existing_observations=(first,))
        self.assertFalse(retained.deduplicated)
        self.assertEqual(retained.observations, (first, later))

        latest = _observation(
            _ID_4,
            metadata,
            source_record_id="same-record",
            observed_at=UtcTimestamp("2026-08-12T12:34:56Z"),
        )
        retained_again = accept_observation(
            latest,
            existing_observations=(first, later),
        )
        self.assertFalse(retained_again.deduplicated)
        self.assertEqual(retained_again.observations, (first, later, latest))

        replay = accept_observation(
            later,
            existing_observations=(first, later, latest),
        )
        self.assertTrue(replay.deduplicated)
        self.assertEqual(replay.observation, later)
        self.assertEqual(replay.observations, (first, later, latest))

        conflicting_id = _observation(
            _ID_2,
            _metadata(
                title="Different",
                identifiers=(Identifier(namespace="doi", value="10.1000/replay"),),
            ),
            source_record_id="same-record",
        )
        rejected = accept_observation(conflicting_id, existing_observations=(first,))
        self.assertEqual(rejected.outcome, "rejected")
        self.assertEqual(rejected.reason, "observation-id-conflict")

    def test_authors_align_only_by_exact_ordered_names_or_single_orcid_and_keep_affiliations_order(
        self,
    ) -> None:
        base_author = Author(
            kind=AuthorKind.PERSON,
            display_name="Ada Lovelace",
            given_name="Ada",
            affiliations=(Affiliation(name="First Unit"),),
        )
        provider_author = Author(
            kind=AuthorKind.PERSON,
            display_name=" Ada  Lovelace ",
            family_name="Lovelace",
            affiliations=(
                Affiliation(name="First Unit"),
                Affiliation(name="Second Unit"),
            ),
        )
        user = _user_observation(_ID_2, _metadata(authors=(base_author,)))
        provider = _observation(
            _ID_3,
            _metadata(authors=(provider_author,)),
            source_name="crossref",
            source_record_id="r2",
        )
        decision = project_metadata((provider, user), provider_precedence=("crossref",))
        assert decision.metadata is not None
        self.assertEqual(decision.metadata.authors[0].display_name, "Ada Lovelace")
        self.assertEqual(decision.metadata.authors[0].given_name, "Ada")
        self.assertEqual(decision.metadata.authors[0].family_name, "Lovelace")
        self.assertEqual(
            tuple(item.name for item in decision.metadata.authors[0].affiliations),
            ("First Unit", "Second Unit"),
        )

        unrelated = _observation(
            _ID_4,
            _metadata(authors=(Author(kind=AuthorKind.PERSON, display_name="Grace Hopper"),)),
            source_name="other-provider",
            source_record_id="r3",
        )
        rejected_merge = project_metadata(
            (user, unrelated), provider_precedence=("other-provider",)
        )
        assert rejected_merge.metadata is not None
        self.assertEqual(
            tuple(a.display_name for a in rejected_merge.metadata.authors), ("Ada Lovelace",)
        )

    def test_identifiers_are_deduplicated_but_same_namespace_conflict_rejects_projection(
        self,
    ) -> None:
        doi = Identifier(namespace="doi", value="10.1000/example")
        user = _user_observation(_ID_2, _metadata(identifiers=[doi]))
        provider = _observation(
            _ID_3,
            _metadata(identifiers=[doi, Identifier(namespace="pmid", value="123")]),
            source_name="crossref",
            source_record_id="r2",
        )
        projected = project_metadata((user, provider), provider_precedence=("crossref",))
        assert projected.metadata is not None
        self.assertEqual(
            projected.metadata.identifiers, (doi, Identifier(namespace="pmid", value="123"))
        )

        conflict = _observation(
            _ID_4,
            _metadata(identifiers=[Identifier(namespace="doi", value="10.1000/other")]),
            source_name="other-provider",
            source_record_id="r3",
        )
        rejected = project_metadata((user, conflict), provider_precedence=("other-provider",))
        self.assertEqual(rejected.outcome, "rejected")
        self.assertEqual(rejected.reason, "stable-identifier-conflict")

    def test_revision_advances_only_when_projection_changes_and_precondition_is_checked(
        self,
    ) -> None:
        user = _user_observation(_ID_2, _metadata(title="Current", abstract=None))
        current = _metadata(title="Current")
        unchanged = project_metadata(
            (user,),
            current_metadata=current,
            metadata_revision=3,
            expected_metadata_revision=3,
        )
        self.assertEqual(unchanged.outcome, "unchanged")
        self.assertFalse(unchanged.changed)
        self.assertEqual(unchanged.metadata_revision, 3)

        provider = _observation(
            _ID_3,
            _metadata(title="Current", abstract="New abstract"),
            source_name="crossref",
            source_record_id="r2",
        )
        changed = project_metadata(
            (user, provider),
            provider_precedence=("crossref",),
            current_metadata=current,
            metadata_revision=3,
            expected_metadata_revision=3,
        )
        self.assertEqual(changed.outcome, "projected")
        self.assertTrue(changed.changed)
        self.assertEqual(changed.metadata_revision, 4)

        stale = project_metadata(
            (user,),
            current_metadata=current,
            metadata_revision=3,
            expected_metadata_revision=2,
        )
        self.assertEqual(stale.outcome, "rejected")
        self.assertEqual(stale.reason, "metadata-revision-stale")

    def test_content_ready_keeps_current_content_aligned_projection_but_accepts_observation(
        self,
    ) -> None:
        current = _metadata(title="Current", abstract="Content-aligned")
        user = _user_observation(_ID_2, _metadata(title="New user title", abstract="New abstract"))
        projection = project_metadata(
            (user,),
            current_metadata=current,
            metadata_revision=5,
            content_ready=True,
        )
        self.assertEqual(projection.outcome, "preserved")
        self.assertTrue(projection.projection_preserved)
        self.assertFalse(projection.changed)
        self.assertEqual(projection.metadata, current)
        self.assertEqual(projection.metadata_revision, 5)

        accepted = accept_observation(
            user,
            existing_observations=(),
            current_metadata=current,
            metadata_revision=5,
            content_ready=True,
        )
        self.assertEqual(accepted.outcome, "created")
        self.assertIsNotNone(accepted.projection)
        assert accepted.projection is not None
        self.assertTrue(accepted.projection.projection_preserved)
        self.assertTrue(accepted.projection.observations_projection_changed)
        self.assertEqual(accepted.observations, (user,))

    def test_observations_only_projection_change_reuses_precedence_for_existing_and_merged_sets(
        self,
    ) -> None:
        provider = _observation(
            _ID_2,
            _metadata(title="Provider title", abstract="Provider abstract"),
        )
        first_user = _user_observation(
            _ID_3,
            _metadata(title="First user title", abstract=None),
        )
        later_user = _user_observation(
            _ID_4,
            _metadata(title="Later user title", abstract=None),
        )

        enriched = accept_observation(
            first_user,
            existing_observations=(provider,),
            current_metadata=provider.metadata,
        )
        assert enriched.projection is not None
        self.assertTrue(enriched.projection.observations_projection_changed)

        matched = accept_observation(
            later_user,
            existing_observations=(provider, first_user),
            current_metadata=_metadata(
                title="First user title",
                abstract="Provider abstract",
            ),
        )
        assert matched.projection is not None
        self.assertFalse(matched.projection.observations_projection_changed)

    def test_projection_change_marker_is_strict_closed_and_not_a_persisted_fact(self) -> None:
        fields = set(MetadataProjectionDecision.model_fields)
        self.assertIn("observations_projection_changed", fields)
        self.assertNotIn("observation_projection_revision", fields)
        with self.assertRaises(ValidationError):
            MetadataProjectionDecision(
                outcome="projected",
                metadata=_metadata(),
                metadata_revision=1,
                changed=True,
                observations_projection_changed=1,  # type: ignore[arg-type]
            )

    def test_acceptance_has_no_persistence_or_external_identity_fields(self) -> None:
        fields = set(MetadataObservationAcceptanceDecision.model_fields)
        self.assertNotIn("path", fields)
        self.assertNotIn("file", fields)
        self.assertNotIn("import_run", fields)
        self.assertNotIn("vendor_payload", fields)
        self.assertNotIn("external_record_id", fields)
        accepted = accept_observation(_user_observation(_ID_2, _metadata()))
        self.assertEqual(accepted.outcome, "created")


if __name__ == "__main__":
    unittest.main()
