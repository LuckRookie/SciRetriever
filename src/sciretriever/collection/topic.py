from __future__ import annotations

import sciretriever.model.collection as collection_models
from sciretriever.kernel import BoundaryError, CanonicalJsonObject, canonical_json_bytes
from sciretriever.kernel.json import parse_canonical_json
from sciretriever.model.primitives import sha256_digest


def validated_topic_conditions(
    value: collection_models.TopicConditions,
) -> collection_models.ValidatedTopicConditionSet:
    payload_value = CanonicalJsonObject(
        (
            ("limit", value.limit),
            ("query", value.query.strip()),
            ("year_from", value.year_from),
            ("year_to", value.year_to),
        )
    )
    payload = canonical_json_bytes(payload_value)
    return collection_models.ValidatedTopicConditionSet(
        canonical_json=payload.decode("ascii"), sha256=sha256_digest(payload)
    )


def validate_topic_condition_set(value: collection_models.ValidatedTopicConditionSet) -> None:
    payload = canonical_json_bytes(parse_canonical_json(value.canonical_json))
    if payload.decode("ascii") != value.canonical_json or sha256_digest(payload) != value.sha256:
        raise BoundaryError.for_field(
            "topic_conditions", "must be canonical JSON with matching hash"
        )


__all__ = ("validate_topic_condition_set", "validated_topic_conditions")
