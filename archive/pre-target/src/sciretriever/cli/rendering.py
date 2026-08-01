"""Safe shared CLI serialization boundary."""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from typing import TextIO


def compact_json(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=True,
        allow_nan=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def render_records(
    records: Sequence[Mapping[str, object]],
    output_format: str,
    *,
    stream: TextIO,
) -> None:
    values = [dict(record) for record in records]
    if output_format == "json":
        print(compact_json(values), file=stream)
    elif output_format == "jsonl":
        for value in values:
            print(compact_json(value), file=stream)
    else:
        for value in values:
            print(" ".join(f"{key}={value[key]}" for key in sorted(value)), file=stream)


__all__ = ("compact_json", "render_records")
