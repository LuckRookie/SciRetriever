"""Pure deterministic source-plan tier routing."""

from __future__ import annotations

from sciretriever.acquisition.plan import SourceEntry


def tiers(entries: tuple[SourceEntry, ...]) -> tuple[tuple[SourceEntry, ...], ...]:
    values: list[tuple[SourceEntry, ...]] = []
    for tier in sorted({entry.tier for entry in entries}):
        values.append(tuple(entry for entry in entries if entry.tier == tier))
    return tuple(values)


__all__ = ("tiers",)
