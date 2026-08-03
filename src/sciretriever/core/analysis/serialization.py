from __future__ import annotations

import json

from sciretriever.model import analysis


def analysis_bytes(value: analysis.AnalysisProposalV1) -> bytes:
    return json.dumps(
        value.model_dump(mode="json"),
        ensure_ascii=True,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("ascii")


def analysis_json_schema() -> analysis.AnalysisJsonSchema:
    return analysis.AnalysisProposalV1.model_json_schema()


__all__ = ("analysis_bytes", "analysis_json_schema")
