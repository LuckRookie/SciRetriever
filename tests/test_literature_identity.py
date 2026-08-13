from __future__ import annotations

import json
import unittest
from typing import cast

from pydantic import ValidationError

from sciretriever.literature.identity import (
    IdentityDecision,
    MetaLiteratureDecision,
    VersionEvidence,
    fallback_identity_key,
    fallback_identity_sha256,
    normalize_identity_text,
    provider_key_matches_seed,
    resolve_literature_identity,
    resolve_meta_literature,
)
from sciretriever.model.literature import (
    Author,
    AuthorKind,
    Identifier,
    Literature,
    LiteratureStatus,
    VersionRole,
)
from sciretriever.model.metadata import (
    LiteratureMetadata,
    MetadataObservation,
    ProviderLiteratureKey,
)
from sciretriever.model.primitives import (
    LiteratureId,
    MetaLiteratureId,
    ObservationId,
    ProvenanceId,
    Sha256,
    SourceKind,
    UtcTimestamp,
    sha256_digest,
)
from sciretriever.model.provenance import Provenance

_ID_1 = "123e4567-e89b-12d3-a456-426614174000"
_ID_2 = "223e4567-e89b-12d3-a456-426614174000"
_ID_3 = "323e4567-e89b-12d3-a456-426614174000"
_ID_4 = "423e4567-e89b-12d3-a456-426614174000"
_HASH = Sha256("a" * 64)
_OBSERVED_AT = UtcTimestamp("2026-08-10T12:34:56Z")


def _metadata(
    *,
    title: str | None = "A study",
    authors: tuple[Author, ...] | list[Author] = (),
    year: int | None = 2026,
    document_type: str | None = "journal-article",
    identifiers: tuple[Identifier, ...] | list[Identifier] = (),
) -> LiteratureMetadata:
    return LiteratureMetadata(
        title=title,
        authors=tuple(authors),
        publication_year=year,
        document_type=document_type,
        identifiers=tuple(identifiers),
    )


def _literature(
    literature_id: str,
    metadata: LiteratureMetadata,
    *,
    meta_literature_id: str = _ID_1,
    role: VersionRole = VersionRole.OTHER,
) -> Literature:
    return Literature(
        literature_id=LiteratureId(literature_id),
        meta_literature_id=MetaLiteratureId(meta_literature_id),
        version_role=role,
        metadata=metadata,
        status=LiteratureStatus.UNREVIEWED,
    )


def _observation(
    observation_id: str,
    metadata: LiteratureMetadata,
    *,
    source_name: str = "fixture-provider",
    source_record_id: str = "record-1",
    version_links: tuple[ProviderLiteratureKey, ...] = (),
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(observation_id),
        provenance=Provenance(
            provenance_id=ProvenanceId(observation_id),
            source_kind=SourceKind.METADATA_PROVIDER,
            source_name=source_name,
            source_record_id=source_record_id,
            observed_at=_OBSERVED_AT,
            input_sha256=_HASH,
            parameters_sha256=None,
        ),
        metadata=metadata,
        version_links=version_links,
    )


def _user_observation(
    observation_id: str,
    metadata: LiteratureMetadata,
) -> MetadataObservation:
    return MetadataObservation(
        observation_id=ObservationId(observation_id),
        provenance=Provenance(
            provenance_id=ProvenanceId(observation_id),
            source_kind=SourceKind.USER,
            source_name="bibliographic-import",
            source_record_id=None,
            observed_at=_OBSERVED_AT,
            input_sha256=None,
            parameters_sha256=None,
        ),
        metadata=metadata,
    )


class LiteratureIdentityTests(unittest.TestCase):
    def test_decision_contracts_reject_invalid_field_combinations(self) -> None:
        existing = _literature(_ID_2, _metadata())
        with self.assertRaises(ValidationError):
            IdentityDecision(decision="matched")
        with self.assertRaises(ValidationError):
            IdentityDecision(decision="created", literature=existing)
        with self.assertRaises(ValidationError):
            MetaLiteratureDecision(decision="linked")
        with self.assertRaises(ValidationError):
            MetaLiteratureDecision(
                decision="independent",
                meta_literature_id=existing.meta_literature_id,
            )
        with self.assertRaises(ValidationError):
            IdentityDecision(decision="created", extra="forbidden")  # type: ignore[call-arg]

    def test_consumes_canonical_known_and_unknown_identifier_models(self) -> None:
        existing = _literature(
            _ID_2,
            _metadata(
                identifiers=[
                    Identifier(namespace="doi", value="10.1000/example"),
                    Identifier(namespace="arxiv", value="2401.01234v1"),
                    Identifier(namespace="pmid", value="12345"),
                    Identifier(namespace="pmcid", value="pmc12345"),
                    Identifier(namespace="OpenAlex", value=" W123,ABC. "),
                ]
            ),
        )
        incoming = _metadata(
            title="unrelated source title",
            identifiers=[
                Identifier(namespace="doi", value="DOI:10.1000/EXAMPLE"),
                Identifier(namespace="arXiv", value="2401.01234v9"),
                Identifier(namespace="PMID", value="12345"),
                Identifier(namespace="PMCID", value="PMC12345"),
                Identifier(namespace="openalex", value="W123,ABC."),
            ],
        )

        decision = resolve_literature_identity(incoming, (existing,))

        self.assertIsInstance(decision, IdentityDecision)
        self.assertEqual(decision.decision, "matched")
        self.assertIs(decision.literature, existing)

        unknown_only = _metadata(
            title="unrelated source title",
            identifiers=[Identifier(namespace="openalex", value="W123,ABC.")],
        )
        self.assertEqual(
            resolve_literature_identity(unknown_only, (existing,)).decision,
            "created",
        )

    def test_provider_key_record_match_is_exact_and_provider_scoped(self) -> None:
        seed = _observation(
            _ID_1,
            _metadata(identifiers=(Identifier(namespace="openalex", value="W123"),)),
            source_name="openalex",
            source_record_id="W123",
        )
        key = ProviderLiteratureKey(record_id="W123")

        self.assertTrue(
            provider_key_matches_seed(
                provider_name="openalex",
                key=key,
                seed_observations=(seed,),
            )
        )
        self.assertFalse(
            provider_key_matches_seed(
                provider_name="semantic-scholar",
                key=key,
                seed_observations=(seed,),
            )
        )
        self.assertFalse(
            provider_key_matches_seed(
                provider_name="openalex",
                key=ProviderLiteratureKey(record_id="w123"),
                seed_observations=(seed,),
            )
        )

    def test_provider_key_uses_canonical_supported_identifier_namespaces(self) -> None:
        cases = (
            (
                "doi",
                Identifier(namespace="doi", value="https://doi.org/10.1000/Canonical"),
                Identifier(namespace="DOI", value="doi:10.1000/canonical"),
            ),
            (
                "arxiv",
                Identifier(namespace="arxiv", value="https://arxiv.org/abs/2401.01234v1"),
                Identifier(namespace="ARXIV", value="arXiv:2401.01234v9"),
            ),
            (
                "pmid",
                Identifier(namespace="pmid", value="123456"),
                Identifier(namespace="PMID", value=" 123456 "),
            ),
            (
                "pmcid",
                Identifier(namespace="pmcid", value="pmc654321"),
                Identifier(namespace="PMCID", value="PMC654321"),
            ),
        )

        for namespace, seed_identifier, key_identifier in cases:
            with self.subTest(namespace=namespace):
                seed = _observation(
                    _ID_1,
                    _metadata(identifiers=(seed_identifier,)),
                    source_name="fixture-provider",
                    source_record_id=f"{namespace}-record",
                )
                self.assertTrue(
                    provider_key_matches_seed(
                        provider_name="fixture-provider",
                        key=ProviderLiteratureKey(identifiers=(key_identifier,)),
                        seed_observations=(seed,),
                    )
                )

    def test_provider_key_ignores_unknown_identifiers_and_requires_all_stable_values(self) -> None:
        seed = _observation(
            _ID_1,
            _metadata(
                identifiers=(
                    Identifier(namespace="doi", value="10.1000/supported"),
                    Identifier(namespace="openalex", value="W123"),
                )
            ),
        )

        self.assertFalse(
            provider_key_matches_seed(
                provider_name="fixture-provider",
                key=ProviderLiteratureKey(
                    identifiers=(Identifier(namespace="openalex", value="W123"),)
                ),
                seed_observations=(seed,),
            )
        )
        self.assertFalse(
            provider_key_matches_seed(
                provider_name="fixture-provider",
                key=ProviderLiteratureKey(
                    identifiers=(
                        Identifier(namespace="doi", value="10.1000/supported"),
                        Identifier(namespace="pmid", value="123456"),
                    )
                ),
                seed_observations=(seed,),
            )
        )

    def test_provider_key_combines_record_and_stable_identifiers_across_seed_closure(self) -> None:
        record_observation = _observation(
            _ID_1,
            _metadata(identifiers=(Identifier(namespace="pmid", value="111"),)),
            source_name="crossref",
            source_record_id="provider-record",
        )
        user_identifier_observation = _user_observation(
            _ID_2,
            _metadata(identifiers=(Identifier(namespace="doi", value="10.1000/seed"),)),
        )
        key = ProviderLiteratureKey(
            record_id="provider-record",
            identifiers=(Identifier(namespace="doi", value="doi:10.1000/SEED"),),
        )

        self.assertTrue(
            provider_key_matches_seed(
                provider_name="crossref",
                key=key,
                seed_observations=(record_observation, user_identifier_observation),
            )
        )
        self.assertFalse(
            provider_key_matches_seed(
                provider_name="crossref",
                key=key,
                seed_observations=(user_identifier_observation,),
            )
        )
        self.assertFalse(
            provider_key_matches_seed(
                provider_name="crossref",
                key=key,
                seed_observations=(record_observation,),
            )
        )

    def test_provider_key_conflicting_values_in_one_stable_namespace_fail_closed(self) -> None:
        seed = _observation(
            _ID_1,
            _metadata(
                identifiers=(
                    Identifier(namespace="doi", value="10.1000/first"),
                    Identifier(namespace="doi", value="10.1000/second"),
                )
            ),
            source_record_id="provider-record",
        )
        conflicting = ProviderLiteratureKey(
            record_id="provider-record",
            identifiers=(
                Identifier(namespace="doi", value="10.1000/first"),
                Identifier(namespace="doi", value="10.1000/second"),
            ),
        )

        self.assertFalse(
            provider_key_matches_seed(
                provider_name="fixture-provider",
                key=conflicting,
                seed_observations=(seed,),
            )
        )

    def test_provider_key_matcher_rejects_invalid_arguments(self) -> None:
        key = ProviderLiteratureKey(record_id="record-1")
        seed = _observation(_ID_1, _metadata())

        with self.assertRaises(TypeError):
            provider_key_matches_seed(
                provider_name=cast(str, 1),
                key=key,
                seed_observations=(seed,),
            )
        for provider_name in ("", "   "):
            with self.subTest(provider_name=provider_name), self.assertRaises(ValueError):
                provider_key_matches_seed(
                    provider_name=provider_name,
                    key=key,
                    seed_observations=(seed,),
                )
        with self.assertRaises(TypeError):
            provider_key_matches_seed(
                provider_name="fixture-provider",
                key=cast(ProviderLiteratureKey, object()),
                seed_observations=(seed,),
            )
        with self.assertRaises(TypeError):
            provider_key_matches_seed(
                provider_name="fixture-provider",
                key=key,
                seed_observations=cast(tuple[MetadataObservation, ...], [seed]),
            )
        with self.assertRaises(TypeError):
            provider_key_matches_seed(
                provider_name="fixture-provider",
                key=key,
                seed_observations=cast(tuple[MetadataObservation, ...], (object(),)),
            )

    def test_title_and_author_keys_are_nfc_whitespace_and_casefold_only(self) -> None:
        self.assertEqual(normalize_identity_text("  École\u2003  STUDY  "), "école study")
        author = Author(kind=AuthorKind.PERSON, display_name="  Émile\u2003 Zola  ")
        existing = _literature(
            _ID_2,
            _metadata(title="E\u0301cole study", authors=(author,)),
        )
        incoming = _metadata(
            title=" école\tSTUDY ",
            authors=(Author(kind=AuthorKind.PERSON, display_name="Émile Zola"),),
        )

        self.assertEqual(
            resolve_literature_identity(incoming, (existing,)).decision,
            "matched",
        )

        punctuation_change = _metadata(title="Ecole-study", authors=(author,))
        self.assertEqual(
            resolve_literature_identity(punctuation_change, (existing,)).decision,
            "created",
        )

    def test_stable_identifier_match_conflict_and_distinct_values_are_conservative(self) -> None:
        existing = _literature(
            _ID_2,
            _metadata(
                identifiers=[
                    Identifier(namespace="doi", value="10.1000/same"),
                    Identifier(namespace="pmid", value="100"),
                ]
            ),
        )
        same_doi_different_description = _metadata(
            title="different title",
            identifiers=[Identifier(namespace="doi", value="10.1000/SAME")],
        )
        self.assertEqual(
            resolve_literature_identity(same_doi_different_description, (existing,)).decision,
            "matched",
        )

        conflict = _metadata(
            identifiers=[
                Identifier(namespace="doi", value="10.1000/same"),
                Identifier(namespace="pmid", value="999"),
            ]
        )
        conflict_decision = resolve_literature_identity(conflict, (existing,))
        self.assertEqual(conflict_decision.decision, "identity-conflict")
        self.assertIsNone(conflict_decision.literature)

        distinct_doi = _metadata(
            title="A study",
            identifiers=[Identifier(namespace="doi", value="10.1000/different")],
        )
        self.assertEqual(
            resolve_literature_identity(distinct_doi, (existing,)).decision,
            "created",
        )

    def test_fallback_requires_title_complete_author_order_year_and_document_type(self) -> None:
        authors = (
            Author(kind=AuthorKind.PERSON, display_name="Ada Lovelace"),
            Author(kind=AuthorKind.PERSON, display_name="Grace Hopper"),
        )
        existing = _literature(_ID_2, _metadata(authors=authors))
        exact = _metadata(
            title=" a   STUDY ",
            authors=[
                Author(kind=AuthorKind.PERSON, display_name="Ada  Lovelace"),
                Author(kind=AuthorKind.PERSON, display_name="Grace Hopper"),
            ],
        )
        self.assertEqual(
            resolve_literature_identity(exact, (existing,)).decision,
            "matched",
        )
        self.assertEqual(
            resolve_literature_identity(
                _metadata(
                    authors=authors,
                    document_type="Journal-Article",
                ),
                (existing,),
            ).decision,
            "created",
        )

        for field, value in (
            ("title", None),
            ("authors", ()),
            ("year", None),
            ("document_type", None),
        ):
            with self.subTest(field=field):
                candidate = _metadata(
                    title=None if field == "title" else "A study",
                    authors=() if field == "authors" else authors,
                    year=None if field == "year" else 2026,
                    document_type=None if field == "document_type" else "journal-article",
                )
                self.assertEqual(
                    resolve_literature_identity(candidate, (existing,)).decision,
                    "created",
                )

    def test_fallback_hash_has_one_domain_tag_and_full_key_remains_authoritative(self) -> None:
        authors = (Author(kind=AuthorKind.PERSON, display_name="Ada Lovelace"),)
        first_key = fallback_identity_key(_metadata(title="First", authors=authors))
        second_key = fallback_identity_key(_metadata(title="Second", authors=authors))
        assert first_key is not None
        assert second_key is not None
        expected = sha256_digest(
            json.dumps(
                {
                    "schema": "sciretriever-literature-fallback-identity-v1",
                    "value": first_key,
                },
                ensure_ascii=False,
                separators=(",", ":"),
                sort_keys=True,
            ).encode("utf-8")
        )
        self.assertEqual(fallback_identity_sha256(first_key), expected)
        self.assertNotEqual(
            fallback_identity_sha256(first_key),
            fallback_identity_sha256(second_key),
        )

    def test_arxiv_revisions_share_one_concrete_literature(self) -> None:
        existing = _literature(
            _ID_2,
            _metadata(identifiers=[Identifier(namespace="arxiv", value="2401.01234v1")]),
            role=VersionRole.PREPRINT,
        )
        incoming = _metadata(
            identifiers=[Identifier(namespace="arxiv", value="https://arxiv.org/abs/2401.01234v2")]
        )
        decision = resolve_literature_identity(incoming, (existing,))
        self.assertEqual(decision.decision, "matched")
        self.assertIs(decision.literature, existing)

    def test_meta_aggregation_requires_explicit_version_link_evidence(self) -> None:
        published = _literature(
            _ID_2,
            _metadata(identifiers=[Identifier(namespace="doi", value="10.1000/published")]),
            role=VersionRole.PUBLISHED,
        )
        preprint = _literature(
            _ID_3,
            _metadata(identifiers=[Identifier(namespace="arxiv", value="2401.01234")]),
            meta_literature_id=_ID_4,
            role=VersionRole.PREPRINT,
        )
        target_observation = _observation(
            _ID_4,
            preprint.metadata,
            source_record_id="preprint-record",
        )
        linked_observation = _observation(
            _ID_1,
            published.metadata,
            source_record_id="published-record",
            version_links=(
                ProviderLiteratureKey(
                    record_id="preprint-record",
                    identifiers=(Identifier(namespace="arxiv", value="2401.01234v2"),),
                ),
            ),
        )

        linked = resolve_meta_literature(
            published,
            linked_observation,
            (
                VersionEvidence(
                    literature=preprint,
                    observations=(target_observation,),
                ),
            ),
        )
        self.assertIsInstance(linked, MetaLiteratureDecision)
        self.assertEqual(linked.decision, "linked")
        self.assertEqual(linked.meta_literature_id, published.meta_literature_id)
        self.assertEqual(
            linked.linked_literature_ids,
            (published.literature_id, preprint.literature_id),
        )

        no_link = resolve_meta_literature(
            published,
            _observation(_ID_1, published.metadata, source_record_id="published-record"),
            (
                VersionEvidence(
                    literature=preprint,
                    observations=(target_observation,),
                ),
            ),
        )
        self.assertEqual(no_link.decision, "independent")

    def test_provider_record_id_is_not_a_literature_identifier_and_ambiguous_links_fail_closed(
        self,
    ) -> None:
        current = _literature(
            _ID_2,
            _metadata(identifiers=[Identifier(namespace="doi", value="10.1000/current")]),
            role=VersionRole.PUBLISHED,
        )
        target = _literature(
            _ID_3,
            _metadata(identifiers=[Identifier(namespace="arxiv", value="2401.01234")]),
            meta_literature_id=_ID_4,
            role=VersionRole.PREPRINT,
        )
        provider_record = "same-provider-record"
        target_observation = _observation(_ID_4, target.metadata, source_record_id=provider_record)
        explicit = _observation(
            _ID_1,
            current.metadata,
            version_links=(ProviderLiteratureKey(record_id=provider_record),),
        )
        decision = resolve_meta_literature(
            current,
            explicit,
            (
                VersionEvidence(
                    literature=target,
                    observations=(target_observation,),
                ),
            ),
        )
        self.assertEqual(decision.decision, "linked")

        not_a_link = resolve_meta_literature(
            current,
            _observation(_ID_1, current.metadata),
            (
                VersionEvidence(
                    literature=target,
                    observations=(target_observation,),
                ),
            ),
        )
        self.assertEqual(not_a_link.decision, "independent")

        second = _literature(
            "523e4567-e89b-12d3-a456-426614174000",
            target.metadata,
            meta_literature_id="623e4567-e89b-12d3-a456-426614174000",
            role=VersionRole.PREPRINT,
        )
        ambiguous = resolve_meta_literature(
            current,
            explicit,
            (
                VersionEvidence(
                    literature=target,
                    observations=(target_observation,),
                ),
                VersionEvidence(
                    literature=second,
                    observations=(target_observation,),
                ),
            ),
        )
        self.assertEqual(ambiguous.decision, "identity-conflict")
        self.assertIsNone(ambiguous.meta_literature_id)

        dual_target = _literature(
            "723e4567-e89b-12d3-a456-426614174000",
            _metadata(
                identifiers=[
                    Identifier(namespace="doi", value="10.1000/dual-a"),
                    Identifier(namespace="doi", value="10.1000/dual-b"),
                ]
            ),
            meta_literature_id="823e4567-e89b-12d3-a456-426614174000",
            role=VersionRole.PREPRINT,
        )
        dual_observation = _observation(
            "823e4567-e89b-12d3-a456-426614174000",
            dual_target.metadata,
            source_record_id=provider_record,
        )
        contradictory_key = _observation(
            _ID_1,
            current.metadata,
            version_links=(
                ProviderLiteratureKey(
                    record_id=provider_record,
                    identifiers=(
                        Identifier(namespace="doi", value="10.1000/dual-a"),
                        Identifier(namespace="doi", value="10.1000/dual-b"),
                    ),
                ),
            ),
        )
        contradictory = resolve_meta_literature(
            current,
            contradictory_key,
            (
                VersionEvidence(
                    literature=dual_target,
                    observations=(dual_observation,),
                ),
            ),
        )
        self.assertEqual(contradictory.decision, "independent")

    def test_version_link_conditions_cannot_be_combined_across_target_observations(self) -> None:
        current = _literature(
            _ID_2,
            _metadata(identifiers=(Identifier(namespace="doi", value="10.1000/current"),)),
            role=VersionRole.PUBLISHED,
        )
        target_identifier = Identifier(namespace="arxiv", value="2401.01234")
        target = _literature(
            _ID_3,
            _metadata(identifiers=(target_identifier,)),
            meta_literature_id=_ID_4,
            role=VersionRole.PREPRINT,
        )
        record_only = _observation(
            _ID_3,
            _metadata(identifiers=(Identifier(namespace="arxiv", value="2401.99999"),)),
            source_record_id="target-record",
        )
        identifier_only = _observation(
            _ID_4,
            target.metadata,
            source_record_id="different-record",
        )
        incoming = _observation(
            _ID_1,
            current.metadata,
            version_links=(
                ProviderLiteratureKey(
                    record_id="target-record",
                    identifiers=(target_identifier,),
                ),
            ),
        )

        decision = resolve_meta_literature(
            current,
            incoming,
            (
                VersionEvidence(
                    literature=target,
                    observations=(record_only, identifier_only),
                ),
            ),
        )

        self.assertEqual(decision.decision, "independent")


if __name__ == "__main__":
    unittest.main()
