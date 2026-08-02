from __future__ import annotations

import unittest

from sciretriever.core.literature import (
    prepare_identity_acceptance,
    resolve_identity,
)
from sciretriever.model.canonical_json import CanonicalJsonObject, canonical_json_bytes
from sciretriever.model.literature import (
    BibliographicObservation,
    Identifier,
    IdentityRecord,
    InitialMetadata,
    VersionRelationEvidence,
)
from sciretriever.model.primitives import (
    UtcTimestamp,
    WorkId,
    WorkVersionId,
    sha256_digest,
)


def _uuid(number: int) -> str:
    return f"00000000-0000-0000-0000-{number:012d}"


def _observation(
    provider: str,
    record: str,
    identifiers: tuple[Identifier, ...],
    *,
    priority: int = 0,
    title: str | None = "Exact Identity",
    authors: tuple[str, ...] = ("Ada Lovelace", "Grace Hopper"),
    year: int | None = 2026,
    item_type: str | None = "journal-article",
    abstract: str | None = None,
    role: str = "formal",
    relation: VersionRelationEvidence | None = None,
) -> BibliographicObservation:
    return BibliographicObservation(
        provider=provider,
        provider_record_id=record,
        source_priority=priority,
        observed_at=UtcTimestamp("2026-07-31T00:00:00Z"),
        identifiers=identifiers,
        metadata=InitialMetadata(
            title=title,
            authors=authors,
            year=year,
            item_type=item_type,
            abstract=abstract,
        ),
        version_role=role,
        version_relation=relation,
    )


def _record(
    number: int,
    *,
    work_number: int | None = None,
    role: str = "formal",
    identifiers: tuple[Identifier, ...] = (),
    metadata: InitialMetadata | None = None,
    representative_number: int | None = None,
) -> IdentityRecord:
    return IdentityRecord(
        work_id=WorkId(_uuid(work_number or number)),
        work_version_id=WorkVersionId(_uuid(number)),
        representative_version_id=(
            None if representative_number is None else WorkVersionId(_uuid(representative_number))
        ),
        version_role=role,
        identifiers=identifiers,
        current_metadata=metadata,
        metadata_revision=1 if metadata is not None else None,
        completed=False,
        identity_revision=sha256_digest(f"identity-{number}".encode("ascii")),
    )


class CoreLiteratureIdentityTests(unittest.TestCase):
    def test_metadata_precedence_and_missing_field_fill_are_pure(self) -> None:
        identifier = Identifier(namespace="doi", value="10.1000/example")
        preferred = _observation(
            "preferred",
            "p",
            (identifier,),
            priority=0,
            title="Preferred title",
        )
        fallback = _observation(
            "fallback",
            "f",
            (identifier,),
            priority=1,
            title="Fallback title",
            abstract="filled abstract",
        )

        resolution = resolve_identity((), (fallback, preferred))
        prepared = prepare_identity_acceptance(resolution, (), ())

        self.assertEqual(prepared.version_role, "formal")
        self.assertIsNotNone(prepared.metadata_snapshot)
        assert prepared.metadata_snapshot is not None
        expected_values = CanonicalJsonObject(
            (
                ("abstract", "filled abstract"),
                ("authors", ("Ada Lovelace", "Grace Hopper")),
                ("item_type", "journal-article"),
                ("keywords", ()),
                ("language", None),
                ("title", "Preferred title"),
                ("venue", None),
                ("year", 2026),
            )
        )
        self.assertEqual(
            prepared.metadata_snapshot.values_json,
            canonical_json_bytes(expected_values).decode("ascii"),
        )
        self.assertEqual(len(prepared.observations), 2)

    def test_conflicting_exact_match_stays_separate_and_is_reviewable(self) -> None:
        identifier = Identifier(namespace="doi", value="10.1000/conflict")
        existing = _record(
            1,
            identifiers=(identifier,),
            metadata=InitialMetadata(
                title="Different title",
                authors=("Different author",),
                year=2026,
                item_type="journal-article",
            ),
        )
        observation = _observation("incoming", "1", (identifier,))

        resolution = resolve_identity((existing,), (observation,))
        prepared = prepare_identity_acceptance(resolution, (), ())

        self.assertNotEqual(resolution.work_version_id, existing.work_version_id)
        self.assertEqual(prepared.identifiers, ())
        self.assertEqual(prepared.review_relations[0].relation, "identity-conflict")
        self.assertEqual(
            prepared.expected_revisions[0].work_version_id,
            existing.work_version_id,
        )

    def test_explicit_version_relation_shares_work_but_keeps_version(self) -> None:
        preprint_identifier = Identifier(namespace="arxiv", value="2601.00001")
        preprint = _record(
            1,
            work_number=7,
            role="preprint",
            identifiers=(preprint_identifier,),
            representative_number=1,
        )
        formal = _observation(
            "crossref",
            "formal",
            (Identifier(namespace="doi", value="10.1000/formal"),),
            role="formal",
            relation=VersionRelationEvidence(
                target_identifier=preprint_identifier,
                relation="published-version-of",
            ),
        )

        resolution = resolve_identity((preprint,), (formal,))
        prepared = prepare_identity_acceptance(resolution, (), ())

        self.assertEqual(resolution.work_id, preprint.work_id)
        self.assertNotEqual(resolution.work_version_id, preprint.work_version_id)
        self.assertEqual(prepared.representative_version_id, resolution.work_version_id)
        self.assertEqual(
            prepared.version_relations[0].right_version_id,
            preprint.work_version_id,
        )


if __name__ == "__main__":
    unittest.main()
