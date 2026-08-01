"""Neutral identifier extraction from bibliography text."""

from __future__ import annotations

import re

from sciretriever.core.contracts import Identifier


_PATTERNS = (
    ("doi", re.compile(r"\b10\.\d{4,9}/[-._;()/:a-z0-9]+", re.IGNORECASE)),
    ("pmcid", re.compile(r"\bPMC\d+\b", re.IGNORECASE)),
    ("pmid", re.compile(r"\bPMID\s*:?\s*(\d+)\b", re.IGNORECASE)),
    ("arxiv", re.compile(r"\barXiv\s*:?\s*([a-z-]+/\d{7}|\d{4}\.\d{4,5}(?:v\d+)?)\b", re.IGNORECASE)),
)


def extract_identifiers(text: str) -> tuple[Identifier, ...]:
    found = set()
    for namespace, pattern in _PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(1) if match.lastindex else match.group(0)
            if namespace == "doi":
                value = value.rstrip(".,;)")
            found.add(Identifier(namespace, value))
    return tuple(sorted(found, key=lambda item: (item.namespace, item.value)))


__all__ = ("extract_identifiers",)
