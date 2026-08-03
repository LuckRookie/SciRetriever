from sciretriever.model.canonical_json import (
    CanonicalJsonObject,
    canonical_json_bytes,
    parse_canonical_json,
)
from sciretriever.model.execution import TargetResultEnvelope


def target_result_envelope_json(envelope: TargetResultEnvelope) -> str:
    result = parse_canonical_json(envelope.result.model_dump_json())
    return canonical_json_bytes(
        CanonicalJsonObject((("details", envelope.details), ("result", result)))
    ).decode("ascii")


__all__ = ("target_result_envelope_json",)
