"""WP6 closure control-transition validation."""

from __future__ import annotations

import json

from scripts.wp6_common import JsonValue


def is_boulder_transition(pre: bytes, post: bytes) -> bool:
    try:
        before = json.loads(pre)
        after = json.loads(post)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False

    changes: list[tuple[tuple[str, ...], JsonValue, JsonValue]] = []

    def compare(
        left: JsonValue,
        right: JsonValue,
        path: tuple[str, ...] = (),
    ) -> bool:
        if isinstance(left, dict) and isinstance(right, dict):
            return set(left) == set(right) and all(
                compare(left[name], right[name], (*path, name)) for name in left
            )
        if isinstance(left, list) and isinstance(right, list):
            return len(left) == len(right) and all(
                compare(old, new, (*path, str(index)))
                for index, (old, new) in enumerate(zip(left, right, strict=True))
            )
        if left != right:
            changes.append((path, left, right))
        return True

    if not compare(before, after):
        return False
    required = (
        ("works", "wp6-product-closeout", "status"),
        "active",
        "completed",
    )
    allowed = (
        required,
        (("active_work_id",), "wp6-product-closeout", None),
    )
    return required in changes and all(change in allowed for change in changes)


__all__ = ("is_boulder_transition",)
