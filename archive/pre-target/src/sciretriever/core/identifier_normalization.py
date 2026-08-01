"""Identifier-specific boundary normalization."""

from __future__ import annotations

import re
from urllib.parse import urlsplit


ARXIV_PREFIX = re.compile(r"^arxiv:\s*", re.IGNORECASE)
ARXIV_HOSTS = frozenset({"arxiv.org", "www.arxiv.org", "export.arxiv.org"})


def normalize_arxiv(value: str) -> str:
    candidate = ARXIV_PREFIX.sub("", value).strip()
    try:
        parsed = urlsplit(candidate)
        hostname = (parsed.hostname or "").lower()
    except ValueError:
        return candidate.lower()
    if parsed.scheme.lower() in {"http", "https"} and hostname in ARXIV_HOSTS:
        route, separator, identifier = parsed.path.strip("/").partition("/")
        if separator and route.lower() in {"abs", "pdf"}:
            candidate = identifier
            if route.lower() == "pdf" and candidate.lower().endswith(".pdf"):
                candidate = candidate[:-4]
    return candidate.strip().lower()


__all__ = ("normalize_arxiv",)
