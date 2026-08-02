from __future__ import annotations

import unittest
from collections.abc import Callable
from typing import TypeVar

import sciretriever.model.canonical_json as cj
import sciretriever.model.collection as cm
import sciretriever.model.literature as lm
import sciretriever.model.primitives as pm
from sciretriever.core.collection import citation_input as ci
from sciretriever.core.collection import publisher_contracts as pc
from sciretriever.core.collection import topic
from sciretriever.core.collection.errors import CollectionRuleError

UUIDS = tuple(f"10000000-0000-4000-8000-{value:012d}" for value in range(1, 16))
ValueT = TypeVar("ValueT")


def _prepared() -> lm.PreparedBibliographyAcceptance:
    version = pm.WorkVersionId(UUIDS[1])
    return lm.PreparedBibliographyAcceptance(
        work_id=pm.WorkId(UUIDS[0]),
        work_version_id=version,
        version_role="formal",
        representative_version_id=version,
        identifiers=(),
        observations=(),
        metadata_snapshot=None,
        version_relations=(),
        review_relations=(),
        expected_revisions=(),
        superseded_identities=(),
        role_update=None,
    )


def _membership(
    work_id: pm.WorkId | None = None,
    run_id: pm.CollectionRunId | None = None,
) -> cm.CollectionMembershipFact:
    return cm.CollectionMembershipFact(
        membership_id=pm.MembershipId(UUIDS[4]),
        collection_id=pm.CollectionId(UUIDS[2]),
        work_id=pm.WorkId(UUIDS[0]) if work_id is None else work_id,
        first_run_id=pm.CollectionRunId(UUIDS[3]) if run_id is None else run_id,
    )


def _acceptances() -> tuple[cm.CollectionAcceptance, cm.ExistingCollectionAcceptance]:
    membership = _membership()
    run_id = membership.first_run_id
    cause = cm.CollectionCauseFact(
        cause_id=pm.CollectionCauseId(UUIDS[5]),
        membership_id=membership.membership_id,
        run_id=run_id,
        kind=pm.CollectionCauseKind.TOPIC_MATCH,
        evidence="evidence",
        seed_work_id=None,
    )
    path = cm.CollectionPathFact(
        path_id=pm.CollectionPathId(UUIDS[6]),
        membership_id=membership.membership_id,
        run_id=run_id,
        direction=None,
        depth=0,
        work_ids=(),
    )
    return (
        cm.CollectionAcceptance(
            bibliography=_prepared(), membership=membership, causes=(cause,), paths=(path,)
        ),
        cm.ExistingCollectionAcceptance(membership=membership, causes=(cause,), paths=()),
    )


class TargetCoreCollectionTests(unittest.TestCase):
    def _reject(self, function: Callable[[ValueT], None], value: ValueT) -> None:
        with self.assertRaises(CollectionRuleError):
            function(value)

    def test_topic_conditions_are_trimmed_and_hashes_are_revalidated(self) -> None:
        value = topic.validated_topic_conditions(
            cm.TopicConditions(query=" catalysis ", year_from=2020, year_to=2026, limit=25)
        )
        self.assertEqual(
            value.canonical_json,
            '{"limit":25,"query":"catalysis","year_from":2020,"year_to":2026}',
        )
        self.assertEqual(value.sha256, pm.sha256_digest(value.canonical_json.encode("ascii")))
        topic.validate_topic_condition_set(value)
        bad = (
            cm.ValidatedTopicConditionSet(
                canonical_json="not-json", sha256=pm.sha256_digest(b"not-json")
            ),
            cm.ValidatedTopicConditionSet(
                canonical_json='{"query":"catalysis"}', sha256=pm.sha256_digest(b"different")
            ),
        )
        for item in bad:
            with self.subTest(item=item):
                self._reject(topic.validate_topic_condition_set, item)

    def test_citation_request_and_input_round_trip_cover_all_seed_kinds(self) -> None:
        request = cm.CitationCollectionRequest(
            seed_selectors=(cm.WorkSeed(work_id=pm.WorkId(UUIDS[0])),),
            providers=("alpha", "beta"),
            direction=pm.CitationDirection.REFERENCES,
            depth=1,
            max_new=2,
        )
        ci.validate_citation_collection_request(request)
        for update in (
            {"seed_selectors": ()},
            {"providers": ()},
            {"providers": ("alpha", "alpha")},
        ):
            with self.subTest(update=update):
                self._reject(
                    ci.validate_citation_collection_request, request.model_copy(update=update)
                )
        value = cm.CitationRunInput(
            original_selectors=(
                cm.WorkSeed(work_id=pm.WorkId(UUIDS[0])),
                cm.WorkVersionSeed(work_version_id=pm.WorkVersionId(UUIDS[1])),
                cm.IdentifierSeed(identifier=lm.Identifier(namespace="doi", value="10.1/a")),
                cm.CollectionSeed(collection_id=pm.CollectionId(UUIDS[2])),
            ),
            resolved_work_ids=(pm.WorkId(UUIDS[0]), pm.WorkId(UUIDS[7])),
            providers=("alpha", "beta"),
            direction=pm.CitationDirection.BOTH,
            depth=2,
            max_new=9,
        )
        validated = ci.validated_citation_run_input(value)
        ci.validate_validated_citation_input(validated)
        self.assertEqual(ci.citation_run_input_from_validated(validated), value)

    def test_citation_input_rejects_malformed_persisted_shapes(self) -> None:
        payload = cj.CanonicalJsonObject(
            (
                ("depth", 1),
                ("direction", "unknown"),
                ("max_new", 1),
                ("providers", ("alpha",)),
                ("resolved_work_ids", (UUIDS[0],)),
                ("seed_selectors", (cj.CanonicalJsonObject((("value", UUIDS[0]),)),)),
            )
        )
        encoded = cj.canonical_json_bytes(payload)
        value = cm.ValidatedCitationInput(
            canonical_json=encoded.decode("ascii"), sha256=pm.sha256_digest(encoded)
        )
        with self.assertRaises(CollectionRuleError):
            ci.citation_run_input_from_validated(value)
        tampered = value.model_copy(update={"sha256": pm.sha256_digest(b"different")})
        self._reject(ci.validate_validated_citation_input, tampered)

    def test_collection_rule_error_preserves_field_expectation_and_text(self) -> None:
        request = cm.CitationCollectionRequest(
            seed_selectors=(),
            providers=("alpha",),
            direction=pm.CitationDirection.REFERENCES,
            depth=0,
            max_new=1,
        )
        with self.assertRaises(CollectionRuleError) as raised:
            ci.validate_citation_collection_request(request)
        self.assertEqual(raised.exception.field, "seed_selectors")
        self.assertEqual(raised.exception.expectation, "must be nonempty")
        self.assertEqual(str(raised.exception), "seed_selectors must be nonempty")

    def test_acceptance_requires_work_and_evidence_identity(self) -> None:
        accepted, existing = _acceptances()
        pc.validate_collection_acceptance(accepted)
        pc.validate_existing_collection_acceptance(existing)
        invalid_work = accepted.model_copy(
            update={
                "membership": accepted.membership.model_copy(
                    update={"work_id": pm.WorkId(UUIDS[7])}
                )
            }
        )
        invalid_membership = accepted.model_copy(
            update={
                "causes": (
                    accepted.causes[0].model_copy(
                        update={"membership_id": pm.MembershipId(UUIDS[8])}
                    ),
                )
            }
        )
        invalid_run = existing.model_copy(
            update={
                "causes": (
                    existing.causes[0].model_copy(update={"run_id": pm.CollectionRunId(UUIDS[9])}),
                )
            }
        )
        self._reject(pc.validate_collection_acceptance, invalid_work)
        self._reject(pc.validate_collection_acceptance, invalid_membership)
        self._reject(pc.validate_existing_collection_acceptance, invalid_run)
        self.assertTrue(issubclass(pc.CollectionAcceptanceConflict, Exception))


if __name__ == "__main__":
    unittest.main()
