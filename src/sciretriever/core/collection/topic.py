from __future__ import annotations

import sciretriever.model.collection as collection_models
from sciretriever.model.canonical_json import (
    CanonicalJsonObject,
    canonical_json_bytes,
    parse_canonical_json,
)
from sciretriever.model.primitives import sha256_digest

from .errors import CollectionRuleError


def validated_topic_conditions(
    value: collection_models.TopicConditions,
) -> collection_models.ValidatedTopicConditionSet:
    """Create the canonical, hashed representation of topic conditions."""
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


def validate_topic_condition_set(
    value: collection_models.ValidatedTopicConditionSet,
) -> None:
    """Reject a topic condition payload whose canonical bytes or hash changed."""
    try:
        payload = canonical_json_bytes(parse_canonical_json(value.canonical_json))
    except (TypeError, ValueError) as error:
        raise CollectionRuleError.for_field(
            "topic_conditions", "must be canonical JSON with matching hash"
        ) from error
    if payload.decode("ascii") != value.canonical_json or sha256_digest(payload) != value.sha256:
        raise CollectionRuleError.for_field(
            "topic_conditions", "must be canonical JSON with matching hash"
        )


__all__ = ("validate_topic_condition_set", "validated_topic_conditions")
