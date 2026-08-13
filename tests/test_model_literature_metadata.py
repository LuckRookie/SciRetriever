from __future__ import annotations

import unittest

from pydantic import ValidationError

from sciretriever.model.acquisition import AssetHint
from sciretriever.model.literature import (
    Affiliation,
    Author,
    AuthorKind,
    Identifier,
    Literature,
    LiteratureStatus,
    MetadataReferenceTextSupport,
    MetaLiterature,
    ProviderRelationSupport,
    Reference,
    ReferenceSupport,
    ReferenceSupportSource,
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

_ID = "123e4567-e89b-12d3-a456-426614174000"
_ID_2 = "223e4567-e89b-12d3-a456-426614174000"
_ID_3 = "323e4567-e89b-12d3-a456-426614174000"
_HASH = "a" * 64
_TIMESTAMP = UtcTimestamp("2026-08-10T12:34:56.123Z")


def _provenance(
    *,
    source_kind: SourceKind = SourceKind.METADATA_PROVIDER,
    source_name: str = "crossref",
    source_record_id: str | None = "record-123",
    input_sha256: Sha256 | None = Sha256(_HASH),
    parameters_sha256: Sha256 | None = None,
) -> Provenance:
    return Provenance(
        provenance_id=ProvenanceId(_ID),
        source_kind=source_kind,
        source_name=source_name,
        source_record_id=source_record_id,
        observed_at=_TIMESTAMP,
        input_sha256=input_sha256,
        parameters_sha256=parameters_sha256,
    )


def _metadata(**overrides: object) -> LiteratureMetadata:
    values: dict[str, object] = {
        "title": "A study",
        "authors": (
            Author(
                kind=AuthorKind.PERSON,
                display_name="Ada Lovelace",
                given_name="Ada",
                family_name="Lovelace",
                orcid="0000-0002-1825-0097",
                affiliations=(Affiliation(name="Analytical Engine Lab", ror="03yrm5c26"),),
            ),
        ),
        "abstract": "A useful abstract.",
        "publication_date": "2026-08-10",
        "publication_year": 2026,
        "document_type": "journal-article",
        "language": "en",
        "venue": "Journal of Examples",
        "publisher": "Example Press",
        "volume": "12",
        "issue": "3",
        "pages": "54-58",
        "identifiers": (Identifier(namespace="doi", value="10.1000/example"),),
        "keywords": ("literature", "models"),
    }
    values.update(overrides)
    return LiteratureMetadata.model_validate(values)


def _observation(**overrides: object) -> MetadataObservation:
    values: dict[str, object] = {
        "observation_id": ObservationId(_ID),
        "provenance": _provenance(),
        "metadata": _metadata(),
        "version_role": VersionRole.PUBLISHED,
        "version_links": (),
        "declared_keywords": ("declared",),
        "reference_texts": ("A. Author, A paper (2025).",),
        "reference_count": 1,
        "cited_by_count": 2,
        "asset_hints": (),
    }
    values.update(overrides)
    return MetadataObservation.model_validate(values)


class IdentifierTests(unittest.TestCase):
    def test_known_identifiers_have_official_canonical_forms(self) -> None:
        dois = (
            "10.1000/EXAMPLE",
            "doi:10.1000/EXAMPLE",
            " https://doi.org/10.1000/EXAMPLE ",
            "http://dx.doi.org/10.1000/EXAMPLE",
        )
        for value in dois:
            with self.subTest(value=value):
                self.assertEqual(
                    Identifier(namespace=" DOI ", value=value).value, "10.1000/example"
                )

        arxiv = (
            "2501.01234",
            "arXiv:2501.01234v2",
            "https://arxiv.org/abs/2501.01234v9",
            "https://arxiv.org/pdf/2501.01234v3.pdf",
        )
        for value in arxiv:
            with self.subTest(value=value):
                self.assertEqual(Identifier(namespace="arXiv", value=value).value, "2501.01234")

        self.assertEqual(
            Identifier(namespace="arxiv", value="hep-th/9901001v1").value, "hep-th/9901001"
        )
        self.assertEqual(Identifier(namespace="pmid", value=" 123456 ").value, "123456")
        self.assertEqual(Identifier(namespace="pmcid", value="pmc1234567").value, "PMC1234567")

    def test_unknown_namespace_only_trims_and_does_not_global_normalize(self) -> None:
        identifier = Identifier(namespace="  OpenAlex  ", value=" W123,ABC. ")
        self.assertEqual(identifier.namespace, "openalex")
        self.assertEqual(identifier.value, "W123,ABC.")

    def test_identifiers_reject_malformed_known_values_and_wrappers(self) -> None:
        invalid = (
            ("doi", "https://example.test/10.1000/example"),
            ("doi", "doi:10.1000"),
            ("doi", "10.1000/example extra"),
            ("arxiv", "https://arxiv.org/abs/"),
            ("arxiv", "10.1000/example"),
            ("pmid", "pmid:123"),
            ("pmid", "12 3"),
            ("pmcid", "PMC"),
            ("pmcid", "https://pmc.ncbi.nlm.nih.gov/articles/PMC123"),
            ("doi", ""),
        )
        for namespace, value in invalid:
            with self.subTest(namespace=namespace, value=value):
                with self.assertRaises(ValidationError):
                    Identifier(namespace=namespace, value=value)

        with self.assertRaises(ValidationError):
            Identifier.model_validate(
                {
                    "namespace": "doi",
                    "value": "10.1000/example",
                    "url": "https://doi.org/10.1000/example",
                }
            )

    def test_canonicalization_is_idempotent_and_identifiers_are_immutable(self) -> None:
        identifier = Identifier(namespace=" DOI ", value="doi:10.1000/Example")
        self.assertEqual(Identifier.model_validate(identifier), identifier)
        with self.assertRaises(ValidationError):
            identifier.value = "10.1000/changed"  # type: ignore[misc]


class AuthorAndMetadataTests(unittest.TestCase):
    def test_author_keeps_kind_order_and_nested_affiliations(self) -> None:
        organization = Author.model_validate(
            {
                "kind": "organization",
                "display_name": "  WHO  ",
                "given_name": None,
                "family_name": None,
                "affiliations": [
                    {"name": "World Health Organization", "ror": "01ggx4157"},
                    {"name": "Second Unit", "ror": None},
                ],
            }
        )
        self.assertEqual(organization.kind, AuthorKind.ORGANIZATION)
        self.assertEqual(organization.display_name, "WHO")
        self.assertEqual(
            tuple(item.name for item in organization.affiliations),
            ("World Health Organization", "Second Unit"),
        )
        self.assertEqual(organization.affiliations[0].ror, "01ggx4157")

        unknown = Author.model_validate({"kind": "unknown", "display_name": "合作组"})
        self.assertIsNone(unknown.given_name)
        self.assertEqual(unknown.affiliations, ())

    def test_author_and_affiliation_reject_guesses_or_malformed_identity_values(self) -> None:
        with self.assertRaises(ValidationError):
            Author.model_validate(
                {
                    "kind": "person",
                    "display_name": "Ada",
                    "orcid": "https://orcid.org/0000-0002-1825-0097",
                }
            )
        with self.assertRaises(ValidationError):
            Author.model_validate(
                {"kind": "person", "display_name": "Ada", "orcid": "0000-0002-1825-0098"}
            )
        with self.assertRaises(ValidationError):
            Affiliation(name="Lab", ror="https://ror.org/03yrm5c26")
        with self.assertRaises(ValidationError):
            Author.model_validate({"kind": "person", "display_name": " "})
        with self.assertRaises(ValidationError):
            Author.model_validate(
                {"kind": "person", "display_name": "Ada", "affiliations": [{"name": " "}]}
            )

    def test_literature_metadata_has_exact_open_contract(self) -> None:
        self.assertEqual(
            set(LiteratureMetadata.model_fields),
            {
                "title",
                "authors",
                "abstract",
                "publication_date",
                "publication_year",
                "document_type",
                "language",
                "venue",
                "publisher",
                "volume",
                "issue",
                "pages",
                "identifiers",
                "keywords",
            },
        )
        metadata = _metadata(authors=[], identifiers=[], keywords=[])
        self.assertEqual(metadata.authors, ())
        self.assertEqual(metadata.identifiers, ())
        self.assertEqual(metadata.keywords, ())
        self.assertIsNone(LiteratureMetadata().title)

        with self.assertRaises(ValidationError):
            LiteratureMetadata.model_validate({"title": "A", "unknown": "value"})
        with self.assertRaises(ValidationError):
            LiteratureMetadata.model_validate({"publication_year": "2026"})

    def test_metadata_round_trip_is_deterministic(self) -> None:
        metadata = _metadata()
        encoded = metadata.model_dump_json()
        self.assertEqual(LiteratureMetadata.model_validate_json(encoded), metadata)
        self.assertEqual(LiteratureMetadata.model_validate_json(encoded).model_dump_json(), encoded)


class MetadataObservationTests(unittest.TestCase):
    def test_provider_observation_keeps_source_fields_separate(self) -> None:
        observation = _observation()
        self.assertEqual(
            MetadataObservation.model_fields["asset_hints"].annotation,
            tuple[AssetHint, ...],
        )
        self.assertEqual(
            set(MetadataObservation.model_fields),
            {
                "observation_id",
                "provenance",
                "metadata",
                "version_role",
                "version_links",
                "declared_keywords",
                "reference_texts",
                "reference_count",
                "cited_by_count",
                "asset_hints",
            },
        )
        self.assertEqual(observation.reference_count, 1)
        self.assertEqual(observation.cited_by_count, 2)
        self.assertEqual(observation.reference_texts, ("A. Author, A paper (2025).",))
        self.assertEqual(observation.version_links, ())
        self.assertNotIn("literature_id", MetadataObservation.model_fields)
        self.assertNotIn("meta_literature_id", MetadataObservation.model_fields)

    def test_provider_and_user_provenance_have_closed_boundaries(self) -> None:
        with self.assertRaises(ValidationError):
            _observation(provenance=_provenance(source_kind=SourceKind.USER, source_name="other"))
        with self.assertRaises(ValidationError):
            _observation(
                provenance=_provenance(
                    source_kind=SourceKind.METADATA_PROVIDER, source_record_id=None
                )
            )
        with self.assertRaises(ValidationError):
            _observation(
                provenance=_provenance(source_kind=SourceKind.METADATA_PROVIDER, input_sha256=None)
            )
        user = _observation(
            provenance=_provenance(
                source_kind=SourceKind.USER,
                source_name="bibliographic-import",
                source_record_id=None,
                input_sha256=None,
                parameters_sha256=None,
            )
        )
        self.assertEqual(user.provenance.source_kind, SourceKind.USER)

    def test_observation_counts_and_texts_are_nonnegative_and_nonblank(self) -> None:
        with self.assertRaises(ValidationError):
            _observation(reference_count=-1)
        with self.assertRaises(ValidationError):
            _observation(cited_by_count=-1)
        with self.assertRaises(ValidationError):
            _observation(reference_texts=["", "valid"])
        with self.assertRaises(ValidationError):
            _observation(declared_keywords=[" "])

    def test_version_links_require_stable_provider_positioning(self) -> None:
        key = ProviderLiteratureKey(record_id="provider-2", identifiers=())
        observation = _observation(version_links=[key])
        self.assertEqual(observation.version_links, (key,))
        with self.assertRaises(ValidationError):
            ProviderLiteratureKey(record_id=None, identifiers=())
        with self.assertRaises(ValidationError):
            ProviderLiteratureKey(record_id=" ", identifiers=())


class LiteratureAndReferenceTests(unittest.TestCase):
    def test_literature_and_meta_literature_have_only_current_contract_fields(self) -> None:
        self.assertEqual(
            set(MetaLiterature.model_fields), {"meta_literature_id", "representative_literature_id"}
        )
        self.assertEqual(
            set(Literature.model_fields),
            {"literature_id", "meta_literature_id", "version_role", "metadata", "status"},
        )
        self.assertEqual(
            {item.value for item in VersionRole},
            {"published", "accepted-manuscript", "preprint", "other"},
        )
        self.assertEqual(
            {item.value for item in LiteratureStatus},
            {"UNREVIEWED", "ASSET_READY", "CONTENT_READY"},
        )
        meta = MetaLiterature(
            meta_literature_id=MetaLiteratureId(_ID),
            representative_literature_id=LiteratureId(_ID_2),
        )
        literature = Literature.model_validate(
            {
                "literature_id": LiteratureId(_ID_2),
                "meta_literature_id": MetaLiteratureId(_ID),
                "version_role": "published",
                "metadata": _metadata(),
                "status": "UNREVIEWED",
            }
        )
        self.assertEqual(meta.representative_literature_id, literature.literature_id)
        self.assertEqual(literature.version_role, VersionRole.PUBLISHED)
        with self.assertRaises(ValidationError):
            Literature.model_validate(
                {
                    "literature_id": LiteratureId(_ID_2),
                    "meta_literature_id": MetaLiteratureId(_ID),
                    "version_role": "formal",
                    "metadata": _metadata(),
                    "status": "UNREVIEWED",
                }
            )

    def test_provider_relation_is_one_distinct_directed_edge(self) -> None:
        citing = ProviderLiteratureKey(record_id="A", identifiers=())
        cited = ProviderLiteratureKey(record_id="B", identifiers=())
        relation = ProviderRelationObservation(
            observation_id=ObservationId(_ID),
            provenance=_provenance(),
            citing=citing,
            cited=cited,
        )
        self.assertEqual(relation.citing, citing)
        with self.assertRaises(ValidationError):
            ProviderRelationObservation(
                observation_id=ObservationId(_ID),
                provenance=_provenance(),
                citing=citing,
                cited=citing,
            )

    def test_reference_support_sources_are_discriminated_and_indexed(self) -> None:
        reference = Reference(
            reference_id=ReferenceId(_ID),
            source_literature_id=LiteratureId(_ID_2),
            target_literature_id=LiteratureId(_ID_3),
        )
        support = ReferenceSupport(
            reference_id=reference.reference_id,
            source=MetadataReferenceTextSupport(
                kind="metadata_reference_text",
                metadata_observation_id=ObservationId(_ID_2),
                reference_index=0,
            ),
        )
        self.assertIsInstance(support.source, MetadataReferenceTextSupport)
        if isinstance(support.source, MetadataReferenceTextSupport):
            self.assertEqual(support.source.reference_index, 0)
        provider_source: ReferenceSupportSource = ProviderRelationSupport(
            kind="provider_relation", observation_id=ObservationId(_ID)
        )
        self.assertEqual(provider_source.kind, "provider_relation")
        with self.assertRaises(ValidationError):
            Reference(
                reference_id=ReferenceId(_ID),
                source_literature_id=LiteratureId(_ID_2),
                target_literature_id=LiteratureId(_ID_2),
            )
        with self.assertRaises(ValidationError):
            ReferenceSupport.model_validate(
                {
                    "reference_id": ReferenceId(_ID),
                    "source": {
                        "kind": "metadata_reference_text",
                        "metadata_observation_id": ObservationId(_ID_2),
                        "reference_index": -1,
                    },
                }
            )
        with self.assertRaises(ValidationError):
            ReferenceSupport.model_validate(
                {
                    "reference_id": ReferenceId(_ID),
                    "source": {
                        "kind": "metadata_reference_text",
                        "metadata_observation_id": ObservationId(_ID_2),
                        "reference_index": 0,
                        "provenance": "forbidden",
                    },
                }
            )

    def test_models_are_immutable_and_do_not_accept_old_contract_fields(self) -> None:
        literature = Literature(
            literature_id=LiteratureId(_ID_2),
            meta_literature_id=MetaLiteratureId(_ID),
            version_role=VersionRole.OTHER,
            metadata=_metadata(),
            status=LiteratureStatus.UNREVIEWED,
        )
        with self.assertRaises(ValidationError):
            literature.status = LiteratureStatus.CONTENT_READY  # type: ignore[misc]
        with self.assertRaises(ValidationError):
            Literature.model_validate({**literature.model_dump(), "work_id": _ID})
        with self.assertRaises(ValidationError):
            MetaLiterature(
                meta_literature_id=MetaLiteratureId(_ID),
                representative_literature_id=LiteratureId(_ID_2),
                literature_ids=(),  # type: ignore[call-arg]
            )


if __name__ == "__main__":
    unittest.main()
