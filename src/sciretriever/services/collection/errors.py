from __future__ import annotations


class CollectionAcceptanceConflict(Exception):
    __slots__ = ()


class CollectionRunFinalizationError(Exception):
    __slots__ = ()

    def __str__(self) -> str:
        return "collection run finalization was already attempted"


__all__ = ("CollectionAcceptanceConflict", "CollectionRunFinalizationError")
