"""Public identifier projection policy for user-facing library records."""

from __future__ import annotations

from sciretriever.core.contracts import Identifier


PUBLIC_IDENTIFIER_NAMESPACES = frozenset({"arxiv", "doi", "pmcid", "pmid"})
_PUBLIC_IDENTIFIER_PRECEDENCE = {
    "doi": 0,
    "pmid": 1,
    "pmcid": 2,
    "arxiv": 3,
}


def public_identifier_sort_key(identifier: Identifier) -> tuple[int, str, str]:
    return (
        _PUBLIC_IDENTIFIER_PRECEDENCE.get(
            identifier.namespace, len(_PUBLIC_IDENTIFIER_PRECEDENCE)
        ),
        identifier.namespace,
        identifier.value,
    )


__all__ = ("PUBLIC_IDENTIFIER_NAMESPACES", "public_identifier_sort_key")
